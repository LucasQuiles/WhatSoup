#!/usr/bin/env python3
"""Drain the local BOT ERRORS outbox into the configured WhatSoup line.

The dispatcher is intentionally file based. Producers only need to land a
0600 JSON event in the local outbox; this process owns network delivery,
retry metadata, poison quarantine, and state reporting.
"""

from __future__ import annotations

import argparse
import calendar
import fcntl
import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.bot_errors_redaction import redact_bot_errors_text


BOT_ERRORS_JID = os.environ.get("BOT_ERRORS_JID", "").strip()
BOT_ERRORS_EXPECTED_JID = os.environ.get("BOT_ERRORS_EXPECTED_JID", "").strip()
DEFAULT_SOCKET = os.environ.get(
    "BOT_ERRORS_SOCKET_PATH",
    "",
).strip()
EMAIL_FALLBACK = os.environ.get(
    "BOT_ERRORS_EMAIL_FALLBACK",
    str(Path.home() / ".claude/scripts/email-alert-fallback.sh"),
)
MAX_MESSAGE_CHARS = int(os.environ.get("BOT_ERRORS_MAX_MESSAGE_CHARS", "5500"))
RECOVERY_DUPLICATE_SUPPRESSION_REASON = (
    "duplicate recovery/info event retained as audit-only; "
    "earliest matching event in the dedupe window remains dispatchable"
)
TEST_PROVENANCE_SUPPRESSION_REASON = "test-provenance event refused by dispatcher"
TERMINAL_AUTH_FAILURE_CLASSES = {"pairing_required", "serverside_logout_irreversible"}
LOGGED_OUT_REASON_KEY = "loggedout"


def normalized_signal_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.strip().lower())


def evidence_has_terminal_auth_failure_class(evidence: str) -> bool:
    lower = evidence.lower()
    return any(f"auth_failure_class={auth_class}" in lower for auth_class in TERMINAL_AUTH_FAILURE_CLASSES)


def evidence_has_logged_out_reason(evidence: str) -> bool:
    for match in re.finditer(r"\blast_disconnect_reason=([^\s]+)", evidence, re.IGNORECASE):
        if normalized_signal_key(match.group(1)) == LOGGED_OUT_REASON_KEY:
            return True
    return "loggedout" in normalized_signal_key(evidence)


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


BOT_ERRORS_REQUIRE_EXPECTED = env_flag("BOT_ERRORS_REQUIRE_EXPECTED", True)


def positive_env_int(name: str, default: int) -> int:
    value = int(os.environ.get(name, str(default)))
    if value <= 0:
        raise ValueError(f"{name} must be > 0")
    return value


INCIDENT_COOLDOWN_SECONDS = positive_env_int("BOT_ERRORS_INCIDENT_COOLDOWN_SECONDS", 3600)
BOT_ERRORS_DELIVERY_MAX_ATTEMPTS = positive_env_int("BOT_ERRORS_DELIVERY_MAX_ATTEMPTS", 10)
DEAD_LETTER_META_ALERT_THROTTLE_SECONDS = 3600  # at most one meta-alert per hour
CLOCK_SKEW_TOLERANCE_SECONDS = 60  # tolerate up to 60s clock skew on clear events
INCIDENT_RENOTIFY_SECONDS = positive_env_int("BOT_ERRORS_INCIDENT_RENOTIFY_SECONDS", 6 * 60 * 60)
INCIDENT_ESCALATE_SECONDS = positive_env_int("BOT_ERRORS_INCIDENT_ESCALATE_SECONDS", 24 * 60 * 60)
INCIDENT_ESCALATE_SUPPRESSED = positive_env_int("BOT_ERRORS_INCIDENT_ESCALATE_SUPPRESSED", 72)
INCIDENT_STALE_SECONDS = positive_env_int("BOT_ERRORS_INCIDENT_STALE_SECONDS", INCIDENT_ESCALATE_SECONDS)
INCIDENT_STALE_RENOTIFY_SECONDS = positive_env_int("BOT_ERRORS_INCIDENT_STALE_RENOTIFY_SECONDS", 24 * 60 * 60)
INCIDENT_STALE_FAILURE_RETRY_SECONDS = positive_env_int("BOT_ERRORS_INCIDENT_STALE_FAILURE_RETRY_SECONDS", 15 * 60)
INCIDENT_STALE_SWEEP_MAX_EVENTS = positive_env_int("BOT_ERRORS_INCIDENT_STALE_SWEEP_MAX_EVENTS", 3)
AWAITING_PHYSICAL_CONFIRMATIONS = positive_env_int("BOT_ERRORS_AWAITING_PHYSICAL_CONFIRMATIONS", 2)
AWAITING_PHYSICAL_RENOTIFY_SECONDS = positive_env_int(
    "BOT_ERRORS_AWAITING_PHYSICAL_RENOTIFY_SECONDS",
    24 * 60 * 60,
)
INTERNAL_FORCE_NOTIFY_SOURCES = {"heartbeat-watchdog", "storm-collapse", "daily-health-fail"}
DAILY_HEALTH_WHATSAPP_RECOVERY_SOURCES = {
    "whatsapp_device_bond_lost",
    "whatsapp_auth_bond_local_failure",
    "instance_logged_out",
    "health_body_degraded",
    "health_probe_auth_failed",
    "instance_unreachable",
    "instance_never_reachable",
    "instance_degraded",
}
DAILY_HEALTH_REQUIRES_OUTBOUND_PROOF_SOURCES = {
    "whatsapp_device_bond_lost",
    "instance_logged_out",
}
# Pattern C — inhibition table (root cause suppresses symptom).
#
# Direction: root source -> set of downstream SYMPTOM sources it suppresses
# while the root incident is OPEN for the same scope (machine|instance). This is
# the same map consulted by stronger_open_incident_for(); Pattern C extends the
# seed edges so a single root-cause alert (bond loss, logout, host unreachable)
# collapses the per-instance health symptoms that fan out from it.
#
# Source-string convention matches incident_source() output: bare sources
# (e.g. "whatsapp_device_bond_lost", "instance_logged_out") and qualified
# per-instance health symptoms emitted by the watchdog as "local_health:<name>".
# The bare token "local_health" is listed in symptom sets and matched against
# any "local_health:<instance>" source via prefix-aware membership (see
# symptom_source_matches); scope already pins machine|instance, so the
# <instance> suffix is redundant for scoping but is part of the literal source.
SUPERSEDED_SOURCES_BY_ALERT_SOURCE = {
    "instance_logged_out": {
        "health_body_degraded",
        "health_probe_auth_failed",
        "outbound_quarantined",
        "outbound_send_failed",
        "instance_unreachable",
        "instance_never_reachable",
        "instance_degraded",
        # Pattern C: a logged-out instance cannot pass its local health probe.
        "local_health",
    },
    "instance_unreachable": {
        "instance_never_reachable",
        "instance_degraded",
        # Pattern C: an unreachable host's per-instance health probe will fail.
        "local_health",
    },
    "instance_degraded": {
        "instance_never_reachable",
    },
    "whatsapp_device_bond_lost": {
        "health_body_degraded",
        "health_probe_auth_failed",
        "instance_logged_out",
        "instance_unreachable",
        "instance_never_reachable",
        "instance_degraded",
        "outbound_quarantined",
        "outbound_send_failed",
        # Pattern C: bond loss takes the instance offline; its health probe and
        # downstream logout symptom are collapsed into the single bond alert.
        "local_health",
    },
}

# Pattern C env gate. Default-on; "0/false/no/off" turns the inhibition lookup
# into a no-op so prior (non-inhibited) behavior is restored. FAIL-OPEN: when
# the gate is off, or on any ambiguity, symptoms are NOT suppressed.
INHIBITION_ENABLED = env_flag("BOT_ERRORS_INHIBITION_ENABLED", True)

# Pattern B (Part 2) env gate. Default-on; "0/false/no/off" disables the
# maintenance-window suppression gate, restoring prior (always-alert) behavior.
# FAIL-OPEN: when the gate is off, or on any ambiguity, alerts are NOT silenced.
MAINTENANCE_ENABLED = env_flag("BOT_ERRORS_MAINTENANCE_WINDOWS", True)


def _load_inhibition_map() -> dict[str, set[str]]:
    """Seed inhibition map, optionally merged with BOT_ERRORS_INHIBITION_MAP.

    The override is JSON mapping root_source -> list/array of symptom sources.
    Each listed symptom set is UNION-merged over the seed (additive; never
    removes seed edges). Malformed JSON or wrong shape logs to stderr and falls
    back to the pure seed — it never crashes the dispatcher.
    """
    seed: dict[str, set[str]] = {
        root: set(symptoms) for root, symptoms in SUPERSEDED_SOURCES_BY_ALERT_SOURCE.items()
    }
    raw = os.environ.get("BOT_ERRORS_INHIBITION_MAP", "").strip()
    if not raw:
        return seed
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("BOT_ERRORS_INHIBITION_MAP must be a JSON object")
        for root, symptoms in parsed.items():
            if not isinstance(root, str) or not isinstance(symptoms, (list, tuple, set)):
                raise ValueError(f"invalid inhibition edge for root={root!r}")
            bucket = seed.setdefault(str(root), set())
            for symptom in symptoms:
                if not isinstance(symptom, str):
                    raise ValueError(f"non-string symptom for root={root!r}")
                bucket.add(symptom)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        print(
            f"[bot-errors-dispatcher] BOT_ERRORS_INHIBITION_MAP ignored "
            f"(malformed; falling back to seed): {exc}",
            file=sys.stderr,
        )
        return {root: set(symptoms) for root, symptoms in SUPERSEDED_SOURCES_BY_ALERT_SOURCE.items()}
    return seed


# Effective root->symptom inhibition map (seed merged with env override).
INHIBITION_MAP = _load_inhibition_map()


def symptom_source_matches(source: str, symptom_sources: set[str]) -> bool:
    """True if ``source`` is a member of ``symptom_sources``.

    Exact match, plus prefix-aware match for the per-instance health symptom:
    a source like "local_health:sample" matches the bare token "local_health".
    """
    if source in symptom_sources:
        return True
    if "local_health" in symptom_sources and source.startswith("local_health:"):
        return True
    return False
GROUP_JID_RE = re.compile(r"^\d+@g\.us$")
TEST_FIXTURE_AUTH_BOND = re.compile(r"(?:^|\s)(?:authDir|auth|creds):\s*/tmp/wa-test-auth(?:/|\s|$)", re.I)

# ---------------------------------------------------------------------------
# Test-leak defense-in-depth (B2)
# ---------------------------------------------------------------------------
# Default patterns compiled once at module load.  Extra patterns may be
# appended via BOT_ERRORS_TEST_LEAK_PATH_PATTERNS (comma- or newline-separated
# regex strings).
# NOTE: /tmp/wa-test- has no trailing boundary BY DESIGN — the plan scopes
# "wa-test-auth and siblings", so every /tmp/wa-test-* fixture dir is dropped.
# Production state never lives under /tmp/wa-test-* (real paths use whatsoup/,
# bot-errors/, ~/.local/state/...), so the false-drop-of-a-real-alert risk is
# nil; the win is catching test siblings beyond the original auth-only literal.
_TEST_LEAK_DEFAULT_PATTERNS: list[str] = [
    r"/tmp/wa-test-",                          # /tmp/wa-test-auth and siblings
    # macOS user temp dirs (vitest/jest mkdtemp roots). The negative lookahead
    # exempts the dispatcher's OWN TMPDIR writefail fallback directory: real
    # macOS daily-health events embed that path in their writefail inventory
    # line, and matching it silently dropped legitimate host alerts as "test
    # leaks" (the exact silent-loss class this defense exists to prevent).
    r"/var/folders/[^/]+/[^/]+/T/(?!bot-errors-writefail(?:[/,\s]|$))",
    r"/tmp/whatsoup-vitest-bot-errors/",       # vitest redirect outbox root
]

def _build_test_leak_patterns() -> list[re.Pattern[str]]:
    patterns = list(_TEST_LEAK_DEFAULT_PATTERNS)
    extra_raw = os.environ.get("BOT_ERRORS_TEST_LEAK_PATH_PATTERNS", "").strip()
    if extra_raw:
        for part in re.split(r"[,\n]+", extra_raw):
            part = part.strip()
            if part:
                patterns.append(part)
    return [re.compile(p, re.I) for p in patterns]


# Compiled at module load; tests that set env vars must reload the module to
# pick up env-driven additions.
TEST_LEAK_PATTERNS: list[re.Pattern[str]] = _build_test_leak_patterns()


_MAX_EVENT_WALK_DEPTH = 50


def _extract_event_text_values(obj: Any, parts: list[str], depth: int = 0) -> None:
    """Recursively walk obj and append all str leaves into parts.

    Depth is bounded (`_MAX_EVENT_WALK_DEPTH`): JSON cannot encode cycles, but a
    pathologically deep event from a buggy emitter must not blow the Python
    stack — beyond the limit we simply stop descending (the dispatcher must
    never crash on a malformed event).
    """
    if depth > _MAX_EVENT_WALK_DEPTH:
        return
    if isinstance(obj, str):
        parts.append(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            _extract_event_text_values(v, parts, depth + 1)
    elif isinstance(obj, (list, tuple)):
        for item in obj:
            _extract_event_text_values(item, parts, depth + 1)


def matched_test_leak_pattern(event: dict[str, Any]) -> str | None:
    """Return the first test-fixture pattern that matches anywhere in the event.

    Walks evidence, summary, and ALL nested string values (payload, diagnostics,
    asset, or any other dict/list field) so a path buried in a nested field is
    both detected AND correctly attributed.  Returns the matching pattern string,
    or None if the event is not a test leak.  Case-insensitive.  This generalized
    detector is a strict superset of the legacy TEST_FIXTURE_AUTH_BOND check.
    """
    parts: list[str] = []
    _extract_event_text_values(event, parts)
    joined = " ".join(parts)
    for pattern in TEST_LEAK_PATTERNS:
        if pattern.search(joined):
            return pattern.pattern
    return None


def event_is_test_leak(event: dict[str, Any]) -> bool:
    """True if any text field in event matches a test-fixture path pattern."""
    return matched_test_leak_pattern(event) is not None


def record_test_leak_daily_marker(
    state: dict[str, Any],
    today: str,
    count: int,
) -> bool:
    """Update the testLeakDaily entry for today and return True if this is the
    first emission for that date (i.e. the caller should write the info marker).

    The function is intentionally pure-ish: it mutates state in place and
    returns a boolean so callers can decide what I/O to perform.  This makes
    it directly unit-testable without filesystem setup.
    """
    daily = state.setdefault("testLeakDaily", {})
    record = daily.get(today)
    if isinstance(record, dict) and record.get("emitted"):
        # Already emitted for this date — accumulate the running count.
        record["count"] = int(record.get("count") or 0) + count
        return False
    # First emission for this date (or missing record).
    daily[today] = {"count": count, "emitted": True}
    return True


COMMA_TOKEN_LIST = re.compile(r"\b[A-Za-z0-9_.:-]+(?:\s*,\s*[A-Za-z0-9_.:-]+)+\b")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def state_root() -> Path:
    return Path(os.environ.get("BOT_ERRORS_STATE_DIR", Path.home() / ".local/state/bot-errors"))


def state_paths() -> dict[str, Path]:
    root = state_root()
    return {
        "root": root,
        "outbox": Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", root / "outbox")),
        "processing": root / "processing",
        "sent": root / "sent",
        "storm_collapsed": root / "storm-collapsed",
        "storm_manifests": root / "storm-manifests",
        "suppressed": root / "suppressed",
        "quarantine": root / "quarantine",
        "testleak": root / "testleak",
        "writefail_recovered": root / "writefail-recovered",
        "writefail_quarantine": root / "writefail-quarantine",
        "locks": root / "locks",
        "logs": root / "logs",
        "dead_letter": root / "dead-letter",
        "state": root / "dispatcher-state.json",
        "incident_state": root / "incident-state.json",
        "meta_state": root / "dispatcher-meta-state.json",
    }


def ensure_private_dir(path: Path) -> None:
    try:
        path.lstat()
    except FileNotFoundError:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    else:
        if path.is_symlink():
            raise RuntimeError(f"refusing to use private directory through symlink: {path}")
        if not os.path.isdir(path):
            raise RuntimeError(f"refusing to use private directory over non-directory path: {path}")
    try:
        path.chmod(0o700)
    except OSError:
        pass


def fsync_parent(path: Path) -> None:
    try:
        fd = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def setup_dirs() -> dict[str, Path]:
    paths = state_paths()
    for key in (
        "root",
        "outbox",
        "processing",
        "sent",
        "storm_collapsed",
        "storm_manifests",
        "suppressed",
        "quarantine",
        "testleak",
        "writefail_recovered",
        "writefail_quarantine",
        "locks",
        "logs",
        "dead_letter",
    ):
        ensure_private_dir(paths[key])
    return paths


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    data = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    fd = os.open(
        tmp,
        os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass
        fsync_parent(path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def assert_regular_or_missing(path: Path) -> None:
    try:
        st = path.lstat()
    except FileNotFoundError:
        return
    if os.path.islink(path):
        raise RuntimeError(f"refusing to append through symlink: {path}")
    if not os.path.isfile(path):
        raise RuntimeError(f"refusing to append non-regular file: {path}")


def append_private_jsonl(path: Path, record: dict[str, Any]) -> None:
    ensure_private_dir(path.parent)
    assert_regular_or_missing(path)
    data = (json.dumps(record, sort_keys=True) + "\n").encode("utf-8")
    fd = os.open(
        path,
        os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    with os.fdopen(fd, "ab") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        path.chmod(0o600)
    except OSError:
        pass
    fsync_parent(path)


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def append_dispatch_log(paths: dict[str, Path], payload: dict[str, Any]) -> None:
    log_path = paths["logs"] / "dispatch.jsonl"
    record = {"time": now_iso(), "pid": os.getpid(), **payload}
    append_private_jsonl(log_path, record)


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("event JSON root must be an object")
    return data


def load_incident_state(paths: dict[str, Path]) -> dict[str, Any]:
    path = paths["incident_state"]
    if not path.exists():
        return {"version": 1, "openIncidents": {}, "lastSentAt": {}}
    try:
        loaded = read_json(path)
    except Exception as exc:  # noqa: BLE001 - dispatcher must recover from corrupt state.
        backup = path.with_suffix(f".corrupt.{int(time.time())}.{os.getpid()}.json")
        try:
            path.replace(backup)
        except Exception:
            pass
        append_dispatch_log(paths, {"type": "incident_state_corrupt", "path": str(path), "error": str(exc)})
        return {"version": 1, "openIncidents": {}, "lastSentAt": {}}
    state = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
    if isinstance(loaded.get("openIncidents"), dict):
        state["openIncidents"] = loaded["openIncidents"]
    if isinstance(loaded.get("lastSentAt"), dict):
        state["lastSentAt"] = loaded["lastSentAt"]
    # Persist the per-UTC-date test-leak daily marker across runs; without this the
    # whitelist would drop it and the once-per-day summary would re-fire every run.
    if isinstance(loaded.get("testLeakDaily"), dict):
        state["testLeakDaily"] = loaded["testLeakDaily"]
    return state


def save_incident_state(paths: dict[str, Path], state: dict[str, Any]) -> None:
    state["updatedAt"] = now_iso()
    atomic_write_json(paths["incident_state"], state)


def incident_source(event: dict[str, Any]) -> str:
    source = str(event.get("source") or "unknown")
    alert_source = str(event.get("alertSource") or "").strip()
    if source in {"heartbeat-watchdog", "daily-health", "daily-health-fail"} and alert_source:
        return f"{source}:{alert_source}"
    diagnostics = event.get("diagnostics")
    remote = diagnostics.get("remote") if isinstance(diagnostics, dict) else None
    if str(event.get("instance") or "") == "bot-errors-collector" and isinstance(remote, str) and remote.strip():
        return f"{source}:{remote.strip()}"
    return source


def incident_key(event: dict[str, Any]) -> str:
    return "|".join([
        safe_segment(str(event.get("machine") or "unknown")),
        safe_segment(str(event.get("instance") or "unknown")),
        safe_segment(incident_source(event)),
    ])


def legacy_unqualified_incident_key(event: dict[str, Any]) -> str | None:
    source = str(event.get("source") or "unknown")
    qualified_source = incident_source(event)
    if qualified_source == source:
        return None
    return "|".join([
        safe_segment(str(event.get("machine") or "unknown")),
        safe_segment(str(event.get("instance") or "unknown")),
        safe_segment(source),
    ])


def legacy_record_matches_alert_source(event: dict[str, Any], record: dict[str, Any] | None) -> bool:
    alert_source = str(event.get("alertSource") or "").strip()
    if alert_source != "source_update":
        return True
    if not isinstance(record, dict):
        return False
    if str(record.get("failureCode") or "") == "SOURCE_UPDATE_BLOCKED":
        return True
    evidence = " ".join([
        str(record.get("lastEvidence") or ""),
        str(record.get("lastSummary") or ""),
    ]).lower()
    return "source_update" in evidence and (
        "source_update_blocked" in evidence
        or "git_remote_auth_failed" in evidence
        or "git_remote reachable" in evidence
    )


def migrate_legacy_unqualified_incident(event: dict[str, Any], incident_state: dict[str, Any]) -> None:
    if str(event.get("source") or "") not in {"daily-health", "heartbeat-watchdog"}:
        return
    legacy_key = legacy_unqualified_incident_key(event)
    key = incident_key(event)
    if not legacy_key or legacy_key == key:
        return
    open_incidents = incident_state.setdefault("openIncidents", {})
    legacy_record = open_incidents.get(legacy_key)
    if not legacy_record_matches_alert_source(event, legacy_record if isinstance(legacy_record, dict) else None):
        return
    if isinstance(legacy_record, dict) and key not in open_incidents:
        open_incidents[key] = legacy_record
    open_incidents.pop(legacy_key, None)
    last_sent = incident_state.setdefault("lastSentAt", {})
    legacy_last_sent = last_sent.get(legacy_key)
    if legacy_last_sent is not None and key not in last_sent:
        last_sent[key] = legacy_last_sent
    last_sent.pop(legacy_key, None)


def incident_scope(event: dict[str, Any]) -> str:
    return "|".join([
        safe_segment(str(event.get("machine") or "unknown")),
        safe_segment(str(event.get("instance") or "unknown")),
    ])


def is_incident_alert(event: dict[str, Any]) -> bool:
    severity = str(event.get("severity") or "").lower()
    return str(event.get("eventType") or "alert") == "alert" and severity in {"critical", "error", "warning"}


def is_incident_clear(event: dict[str, Any]) -> bool:
    return str(event.get("eventType") or "") == "clear"


def is_daily_health_clear(event: dict[str, Any]) -> bool:
    return is_incident_clear(event) and str(event.get("source") or "") == "daily-health"


def maintenance_state_path() -> Path:
    """Path to the maintenance-window state file.

    MUST match ``bot-errors-maintenance.py``'s resolution so the CLI and the
    dispatcher agree on a single file (``BOT_ERRORS_STATE_DIR`` honored).
    """
    return state_root() / "maintenance.json"


def _load_maintenance_windows() -> dict[str, dict[str, Any]]:
    """Read active maintenance windows keyed by ``machine|instance``.

    FAIL-OPEN: missing / corrupt / non-dict file -> ``{}``. Expired entries are
    dropped at read time so a stale window never silences alerts.
    """
    path = maintenance_state_path()
    try:
        raw = path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    current = int(time.time())
    out: dict[str, dict[str, Any]] = {}
    for key, win in parsed.items():
        if not isinstance(win, dict):
            continue
        expires = win.get("expiresAt")
        try:
            if expires is not None and int(expires) > current:
                out[str(key)] = win
        except (TypeError, ValueError):
            continue
    return out


def active_maintenance_window(event: dict[str, Any]) -> str | None:
    """Reason string if an active maintenance window covers the event's scope.

    Scope is derived via ``incident_scope`` (``machine|instance``) — the same
    derivation incidents use — so the CLI and dispatcher key on identical
    scopes. Returns None when no active window covers the scope.
    """
    scope = incident_scope(event)
    windows = _load_maintenance_windows()
    win = windows.get(scope)
    if not isinstance(win, dict):
        return None
    reason = win.get("reason")
    if isinstance(reason, str) and reason.strip():
        return f"planned maintenance for {scope}: {reason.strip()}"
    return f"planned maintenance for {scope}"


def evidence_field(text: str, key: str) -> str | None:
    match = re.search(rf"(?:^|\s){re.escape(key)}=([^\s]+)", text)
    return match.group(1) if match else None


def evidence_epoch(text: str, key: str) -> int | None:
    raw = evidence_field(text, key)
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return int(parsed.timestamp())


def is_verified_whatsapp_health_recovery(probe: str, *, require_outbound_proof: bool = False) -> bool:
    if not probe.startswith("200 "):
        return False
    if "FAIL " in probe or "WARN " in probe:
        return False
    if "physical_intervention_required" in probe or "auth_bond_at_risk" in probe:
        return False
    required = {
        "status": "healthy",
        "wa_connected": "true",
        "state": "connected",
        "auth_bond_status": "present",
        "auth_bond_creds_exists": "true",
    }
    for key, expected in required.items():
        if evidence_field(probe, key) != expected:
            return False
    auth_failure_class = evidence_field(probe, "auth_failure_class")
    if auth_failure_class is not None and auth_failure_class != "none":
        return False
    try:
        creds_size = int(evidence_field(probe, "auth_bond_creds_size") or "0")
    except ValueError:
        return False
    if creds_size <= 0:
        return False
    if not require_outbound_proof:
        return True
    if evidence_field(probe, "outbound_success_transport_present") != "true":
        return False
    return evidence_epoch(probe, "outbound_success_at") is not None


def daily_health_recovered_incident_keys(
    event: dict[str, Any],
    incident_state: dict[str, Any],
) -> list[str]:
    if str(event.get("source") or "") != "daily-health":
        return []
    machine = safe_segment(str(event.get("machine") or "unknown"))
    open_incidents = incident_state.setdefault("openIncidents", {})
    created = event_created_epoch(event)
    recovered: list[str] = []
    seen: set[str] = set()
    for raw_line in str(event.get("evidence") or "").splitlines():
        line = raw_line.strip()
        match = re.match(r"^health\s+([^:\s]+):\s+(.+)$", line)
        if not match:
            continue
        instance = safe_segment(match.group(1))
        probe = match.group(2).strip()
        scope = f"{machine}|{instance}"
        if is_verified_whatsapp_health_recovery(probe):
            daily_health_fail_prefix = f"{scope}|daily-health-fail:"
            for key, record in open_incidents.items():
                if not str(key).startswith(daily_health_fail_prefix):
                    continue
                if not isinstance(record, dict):
                    continue
                status = str(record.get("status") or "open")
                if status in {"closed", "resolved"}:
                    continue
                opened = int_field(record, "eventCreatedAtEpoch", int_field(record, "openedAt"))
                if created is None or opened <= 0 or created <= opened:
                    continue
                if key not in seen:
                    seen.add(key)
                    recovered.append(key)
        for source in DAILY_HEALTH_WHATSAPP_RECOVERY_SOURCES:
            for key in [f"{scope}|{source}", f"{scope}|daily-health:{source}"]:
                record = open_incidents.get(key)
                if not isinstance(record, dict):
                    continue
                status = str(record.get("status") or "open")
                if status in {"closed", "resolved"}:
                    continue
                opened = int_field(record, "eventCreatedAtEpoch")
                if opened > 0 and created is not None and created < opened - CLOCK_SKEW_TOLERANCE_SECONDS:
                    continue
                require_outbound_proof = source in DAILY_HEALTH_REQUIRES_OUTBOUND_PROOF_SOURCES
                if not is_verified_whatsapp_health_recovery(probe, require_outbound_proof=require_outbound_proof):
                    continue
                if require_outbound_proof:
                    outbound_epoch = evidence_epoch(probe, "outbound_success_at")
                    if outbound_epoch is None:
                        continue
                    opened_at = int_field(record, "openedAt", opened)
                    required_after = max(opened, opened_at)
                    if required_after > 0 and outbound_epoch <= required_after:
                        continue
                if key not in seen:
                    seen.add(key)
                    recovered.append(key)
    return recovered


def close_recovered_daily_health_incidents(event: dict[str, Any], incident_state: dict[str, Any]) -> list[str]:
    recovered = daily_health_recovered_incident_keys(event, incident_state)
    if not recovered:
        return []
    open_incidents = incident_state.setdefault("openIncidents", {})
    last_sent = incident_state.setdefault("lastSentAt", {})
    for recovered_key in recovered:
        open_incidents.pop(recovered_key, None)
        last_sent.pop(recovered_key, None)
    return recovered


def critical_asset(event: dict[str, Any]) -> dict[str, Any]:
    asset = event.get("criticalAsset")
    return asset if isinstance(asset, dict) else {}


def critical_asset_failure(event: dict[str, Any]) -> dict[str, Any]:
    failure = critical_asset(event).get("failure")
    return failure if isinstance(failure, dict) else {}


def critical_asset_asset(event: dict[str, Any]) -> dict[str, Any]:
    asset = critical_asset(event).get("asset")
    return asset if isinstance(asset, dict) else {}


def critical_failure_code(event: dict[str, Any]) -> str:
    return str(critical_asset_failure(event).get("code") or "").strip()


def critical_recoverability(event: dict[str, Any]) -> str:
    return str(critical_asset_failure(event).get("recoverability") or "").strip()


def critical_operator_action(event: dict[str, Any]) -> str:
    return str(critical_asset_failure(event).get("operatorAction") or "").strip()


def critical_clear_requirement(event: dict[str, Any]) -> str:
    return str(critical_asset_failure(event).get("clearRequirement") or "").strip()


def critical_confidence(event: dict[str, Any]) -> str:
    return str(critical_asset_failure(event).get("confidence") or "").strip()


def force_notify_level(event: dict[str, Any]) -> str | None:
    diagnostics = event.get("diagnostics")
    source = str(event.get("source") or "")
    if source not in INTERNAL_FORCE_NOTIFY_SOURCES:
        return None
    if not isinstance(diagnostics, dict) or diagnostics.get("forceNotify") is not True:
        return None
    return safe_segment(str(diagnostics.get("forceNotifyLevel") or "default"))


def int_field(record: dict[str, Any], key: str, fallback: int = 0) -> int:
    try:
        return int(record.get(key) or fallback)
    except (TypeError, ValueError):
        return fallback


def event_created_epoch(event: dict[str, Any]) -> int | None:
    created = event.get("createdAt")
    if not isinstance(created, str) or not created.strip():
        return None
    try:
        parsed = datetime.fromisoformat(created.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return int(parsed.timestamp())


def is_logged_out_physical_signal(event: dict[str, Any]) -> bool:
    if critical_failure_code(event) == "WA_AUTH_BOND_SERVER_REVOKED":
        return True
    source = str(event.get("source") or "")
    evidence = str(event.get("evidence") or "").lower()
    return source == "instance_logged_out" and (
        evidence_has_terminal_auth_failure_class(evidence) or (
            "last_status_code=401" in evidence and evidence_has_logged_out_reason(evidence)
        )
    )


def is_verified_device_bond_lost_signal(event: dict[str, Any]) -> bool:
    if critical_failure_code(event) == "WA_AUTH_BOND_SERVER_REVOKED":
        return True
    if critical_recoverability(event) == "manual_relink_required":
        kind = str(critical_asset_asset(event).get("kind") or "")
        if kind in {"whatsapp_linked_device", "account_linkage"}:
            return True
    source = str(event.get("source") or "")
    evidence = str(event.get("evidence") or "").lower()
    return (
        source == "whatsapp_device_bond_lost"
        and "classification: physical_intervention_required" in evidence
        and "linked-device bond lost" in evidence
    )


def is_physical_intervention_signal(event: dict[str, Any]) -> bool:
    return is_logged_out_physical_signal(event) or is_verified_device_bond_lost_signal(event)


def physical_confirmation_threshold(event: dict[str, Any]) -> int:
    return 1 if is_verified_device_bond_lost_signal(event) else AWAITING_PHYSICAL_CONFIRMATIONS


def event_has_awaiting_physical_context(event: dict[str, Any]) -> bool:
    if critical_recoverability(event) == "manual_relink_required":
        return True
    evidence = str(event.get("evidence") or "").lower()
    return "incident_status=awaiting_physical" in evidence or "status=awaiting_physical" in evidence


def update_awaiting_physical_tracking(event: dict[str, Any], record: dict[str, Any], current: int) -> bool:
    if not is_physical_intervention_signal(event):
        return False

    event_id = str(event.get("id") or "")
    if event_id and record.get("physicalCandidateLastEventId") == event_id:
        return False

    previous_status = str(record.get("status") or "open")
    count = int_field(record, "physicalCandidateCount") + 1
    now = now_iso()
    if not record.get("physicalCandidateFirstAt"):
        record["physicalCandidateFirstAt"] = current
        record["physicalCandidateFirstIso"] = now
    record["physicalCandidateCount"] = count
    record["physicalCandidateLastAt"] = current
    record["physicalCandidateLastIso"] = now
    record["physicalCandidateLastEventId"] = event_id
    record["physicalCandidateLastEvidence"] = str(event.get("evidence") or "")[-1000:]

    if previous_status != "awaiting_physical" and count >= physical_confirmation_threshold(event):
        record["status"] = "awaiting_physical"
        record["awaitingPhysicalAt"] = current
        record["awaitingPhysicalIso"] = now
        return True
    return False


def physical_action_text() -> str:
    return (
        "Lucas physical relink or decommission required; Q should preserve the auth bond, "
        "avoid unsafe credential replay, monitor for reconnect/decommission clear, and report disposition."
    )


def physical_candidate_action_text() -> str:
    return (
        "Q verify whether 401/loggedOut repeats; do not replay WhatsApp credentials. "
        "If sustained, treat as Lucas physical relink or decommission."
    )


def stale_action_text() -> str:
    return (
        "Q verify whether the source recovered without a clear or disappeared; keep the incident "
        "de-escalated unless fresh alerts resume."
    )


def event_has_stale_context(event: dict[str, Any]) -> bool:
    evidence = str(event.get("evidence") or "").lower()
    return "incident_stale=true" in evidence or "incident_status=stale" in evidence


def append_still_open_context(
    event: dict[str, Any],
    open_record: dict[str, Any],
    key: str,
    current: int,
    suppressed: int,
    escalated: bool,
    *,
    digest: bool = True,
) -> None:
    opened = int_field(open_record, "openedAt", current)
    last_notified = int_field(open_record, "lastNotifiedAt", int_field(open_record, "lastSentAt", opened))
    status = str(open_record.get("status") or "open")
    awaiting_physical = status == "awaiting_physical"
    action = physical_action_text() if awaiting_physical else (
        "Q investigate persistent incident; duplicate suppression threshold exceeded."
    )
    additions = [
        "incident_still_open=true",
        f"incident_key={key}",
        f"incident_status={status}",
        f"opened={open_record.get('openedIso') or opened}",
        f"age_seconds={max(0, current - opened)}",
        f"suppressed_duplicates={suppressed}",
        f"last_notified={open_record.get('lastNotifiedIso') or open_record.get('lastSentIso') or last_notified}",
        f"escalated={str(escalated).lower()}",
        f"requested_action={action}",
    ]
    if digest:
        additions.insert(0, "still_open_digest=true")
    if awaiting_physical:
        additions.extend([
            f"physical_candidate_count={int_field(open_record, 'physicalCandidateCount')}",
            f"physical_action={physical_action_text()}",
            f"renotify_cadence_seconds={AWAITING_PHYSICAL_RENOTIFY_SECONDS}",
        ])
    evidence = str(event.get("evidence") or "").strip()
    event["evidence"] = "\n".join(part for part in [evidence, *additions] if part)
    if awaiting_physical and digest:
        event["severity"] = "info"
        if "still-open digest" not in str(event.get("summary") or "").lower():
            event["summary"] = f"Still-open digest, awaiting physical action: {event.get('summary') or key}"
    elif awaiting_physical:
        event["severity"] = "critical"
        if "awaiting physical" not in str(event.get("summary") or "").lower():
            event["summary"] = f"Awaiting physical action: {event.get('summary') or key}"
    elif escalated:
        event["severity"] = "critical"
        if "escalated" not in str(event.get("summary") or "").lower():
            event["summary"] = f"ESCALATED still open: {event.get('summary') or key}"
    elif digest:
        event["severity"] = "info"
        if "still-open digest" not in str(event.get("summary") or "").lower():
            event["summary"] = f"Still-open digest: {event.get('summary') or key}"
    elif "still open" not in str(event.get("summary") or "").lower():
        event["summary"] = f"Still open: {event.get('summary') or key}"


def truncate(value: Any, limit: int) -> str:
    text = "" if value is None else str(value)
    if len(text) <= limit:
        return text
    return text[: limit - 32] + f"\n[truncated {len(text) - limit + 32} chars]"


def safe_segment(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    return (cleaned or "unknown")[:80]


def safe_filename(value: str, max_length: int = 180) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    cleaned = cleaned or "unknown"
    if len(cleaned) <= max_length:
        return cleaned
    for suffix in (".writefail", ".processing", ".suppressed", ".collapsed", ".recovered", ".duplicate", ".poison", ".sent", ".json"):
        if cleaned.endswith(suffix) and len(suffix) < max_length:
            stem = cleaned[: max_length - len(suffix)].rstrip("._-:")
            return f"{stem or 'unknown'}{suffix}"
    return cleaned[:max_length]


def safe_child_path(directory: Path, name: str, max_length: int = 180) -> Path:
    ensure_private_dir(directory)
    directory_resolved = directory.resolve()
    first = directory / safe_filename(name, max_length)
    candidates = [first]
    if first.exists():
        stem = safe_filename(name, min(140, max_length))
        prefix = f"{int(time.time())}.{os.getpid()}"
        candidates = [directory / f"{prefix}.{counter}.{stem}" for counter in range(1000)]
    for target in candidates:
        if target.resolve().parent != directory_resolved:
            raise RuntimeError(f"unsafe child path escaped {directory}: {name}")
        if not target.exists():
            return target
    raise RuntimeError(f"no available child path in {directory}: {name}")


def redact(value: Any) -> str:
    return redact_bot_errors_text(value, credential_path_marker="[REDACTED CREDENTIAL PATH]")


def redacted_state_text(value: Any, limit: int, *, tail: bool = False) -> str:
    text = redact(value)
    if tail:
        return text[-limit:]
    return truncate(text, limit)


def json_rpc_call(socket_path: str, method: str, params: dict[str, Any], timeout: float = 15.0) -> dict[str, Any]:
    if not socket_path:
        raise RuntimeError("socket path missing")
    if not os.path.exists(socket_path):
        raise RuntimeError(f"socket missing: {socket_path}")

    init_id = int(time.time() * 1000)
    call_id = init_id + 1
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(socket_path)
        reader = sock.makefile("r", encoding="utf-8", newline="\n")
        writer = sock.makefile("w", encoding="utf-8", newline="\n")

        writer.write(json.dumps({
            "jsonrpc": "2.0",
            "id": init_id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "bot-errors-dispatcher", "version": "1.0.0"},
            },
        }) + "\n")
        writer.flush()
        wait_for_response(reader, init_id, timeout)

        writer.write(json.dumps({
            "jsonrpc": "2.0",
            "id": call_id,
            "method": method,
            "params": params,
        }) + "\n")
        writer.flush()
        return wait_for_response(reader, call_id, timeout)


def wait_for_response(reader: Any, expected_id: int, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = reader.readline()
        if not line:
            raise RuntimeError("socket closed before response")
        msg = json.loads(line)
        if msg.get("id") != expected_id:
            continue
        if "error" in msg:
            raise RuntimeError(f"rpc error: {msg['error']}")
        result = msg.get("result", {})
        if isinstance(result, dict) and result.get("isError") is True:
            raise RuntimeError(f"tool error: {result}")
        return result if isinstance(result, dict) else {"result": result}
    raise RuntimeError("timeout waiting for JSON-RPC response")


def validate_bot_errors_target() -> None:
    if not BOT_ERRORS_JID:
        raise RuntimeError("BOT_ERRORS_JID is required for live dispatch")
    if not GROUP_JID_RE.match(BOT_ERRORS_JID):
        raise RuntimeError("BOT_ERRORS_JID must be a WhatsApp group JID for live dispatch")
    if BOT_ERRORS_REQUIRE_EXPECTED and not BOT_ERRORS_EXPECTED_JID:
        raise RuntimeError("BOT_ERRORS_EXPECTED_JID is required for live dispatch")
    if BOT_ERRORS_EXPECTED_JID and BOT_ERRORS_JID != BOT_ERRORS_EXPECTED_JID:
        raise RuntimeError("BOT_ERRORS_JID does not match BOT_ERRORS_EXPECTED_JID for live dispatch")


def send_whatsapp(text: str, socket_path: str = DEFAULT_SOCKET) -> None:
    dry_capture = os.environ.get("BOT_ERRORS_DRY_SEND_CAPTURE")
    if dry_capture:
        capture_path = Path(dry_capture)
        append_private_jsonl(capture_path, {"time": now_iso(), "pid": os.getpid(), "text": redact(text)})
        return

    validate_bot_errors_target()
    if not socket_path:
        raise RuntimeError("BOT_ERRORS_SOCKET_PATH is required for live dispatch")

    result = json_rpc_call(
        socket_path,
        "tools/call",
        {"name": "send_message", "arguments": {"chatJid": BOT_ERRORS_JID, "text": text}},
    )
    if result.get("isError") is True:
        raise RuntimeError(f"send_message returned error: {result}")


def email_fallback(subject: str, body: str) -> bool:
    fallback = Path(EMAIL_FALLBACK)
    if not fallback.exists() or not os.access(fallback, os.X_OK):
        return False
    try:
        proc = subprocess.run(
            [str(fallback), "--subject", subject, "--body", body],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=20,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return False
    return proc.returncode == 0


def event_line(label: str, value: Any, limit: int = 700) -> str | None:
    if value is None or value == "":
        return None
    rendered = redact(value).replace("@", " at ")
    return f"  > {label}: {truncate(rendered, limit)}"


def format_event(event: dict[str, Any]) -> str:
    event_type = str(event.get("eventType") or "alert")
    severity = str(event.get("severity") or "").lower()
    if event_type == "clear":
        title = "BOT RECOVERY"
    elif severity == "info":
        title = "BOT INFO"
    elif severity == "warning":
        title = "BOT WARNING"
    else:
        title = "BOT ERROR"
    summary = truncate(redact(event.get("summary") or "unspecified bot error").replace("@", " at "), 220)
    process_info = event.get("process") if isinstance(event.get("process"), dict) else {}
    diagnostics = event.get("diagnostics") if isinstance(event.get("diagnostics"), dict) else {}
    delivery = event.get("delivery") if isinstance(event.get("delivery"), dict) else {}
    failure = critical_asset_failure(event)
    asset = critical_asset_asset(event)
    storm = event.get("storm") if isinstance(event.get("storm"), dict) else {}
    log_hints = diagnostics.get("logHints") if isinstance(diagnostics.get("logHints"), list) else []
    writefail_recovery = (
        diagnostics.get("writefailRecovery")
        if isinstance(diagnostics.get("writefailRecovery"), dict)
        else None
    )
    writefail_harvest = (
        writefail_recovery.get("harvest")
        if isinstance(writefail_recovery, dict) and isinstance(writefail_recovery.get("harvest"), dict)
        else None
    )

    lines = [
        f"{title} - {summary}",
        event_line("severity", event.get("severity")),
        event_line("machine", event.get("machine")),
        event_line("instance", event.get("instance")),
        event_line("source", event.get("source")),
        event_line("alert_source", event.get("alertSource")),
        event_line("incident_key", incident_key(event)),
        event_line("asset_kind", asset.get("kind")),
        event_line("failure_code", failure.get("code")),
        event_line("failure_domain", failure.get("domain")),
        event_line("recoverability", failure.get("recoverability")),
        event_line("confidence", failure.get("confidence")),
        event_line("event", event.get("id")),
        event_line("created", event.get("createdAt")),
        event_line(
            "writefail_recovered",
            (
                f"origin={event.get('machine') or event.get('machineName') or 'unknown'} "
                f"harvested_from={writefail_harvest.get('fromHost') if writefail_harvest else 'local'} "
                f"recorded={writefail_recovery.get('recordedAt')} "
                f"failed_target={writefail_recovery.get('failedTarget')} "
                f"breadcrumb={writefail_recovery.get('breadcrumb')}"
            )
            if writefail_recovery
            else None,
            900,
        ),
        event_line("dispatcher_attempts", delivery.get("attempts")),
        event_line("platform", event.get("platform")),
        event_line("pid", process_info.get("pid")),
        event_line("cwd", process_info.get("cwd")),
        event_line("affected_hosts", storm.get("affectedHosts")),
        event_line(
            "affected_host_list",
            ", ".join(str(host) for host in storm.get("hosts", []))
            if isinstance(storm.get("hosts"), list)
            else None,
            1800,
        ),
        event_line("storm_manifest", storm.get("manifest"), 900),
    ]
    for idx, hint in enumerate(log_hints[:5], start=1):
        lines.append(event_line(f"log_{idx}", hint, 900))
    operator_action = critical_operator_action(event)
    clear_requirement = critical_clear_requirement(event)
    if severity == "info":
        requested_action = "  > requested_action: none — informational event; no Q remediation required."
    elif operator_action:
        requested_action = f"  > requested_action: {redact(operator_action).replace('@', ' at ')}"
    elif event_has_awaiting_physical_context(event) or is_verified_device_bond_lost_signal(event):
        requested_action = f"  > requested_action: {physical_action_text()}"
    elif is_physical_intervention_signal(event):
        requested_action = f"  > requested_action: {physical_candidate_action_text()}"
    elif event_has_stale_context(event):
        requested_action = f"  > requested_action: {stale_action_text()}"
    else:
        requested_action = "  > requested_action: Q investigate, remediate, and report disposition in BOT ERRORS."
    lines.extend([
        event_line("queue", diagnostics.get("queue")),
        event_line("dispatch_log", diagnostics.get("dispatchLog")),
        event_line("clear_requirement", clear_requirement, 900),
        event_line("evidence", event.get("evidence"), 1800),
        requested_action,
    ])
    text = "\n".join(line for line in lines if line)
    return truncate(text, MAX_MESSAGE_CHARS)


def next_backoff(attempts: int) -> int | None:
    if attempts >= BOT_ERRORS_DELIVERY_MAX_ATTEMPTS:
        return None
    if attempts <= 1:
        return 60
    if attempts == 2:
        return 300
    return 900


def mark_failure(event: dict[str, Any], error: str) -> dict[str, Any]:
    delivery = event.setdefault("delivery", {})
    if not isinstance(delivery, dict):
        delivery = {}
        event["delivery"] = delivery
    attempts = max(int(delivery.get("attempts") or 0), 1)
    delivery["status"] = "queued"
    delivery["lastError"] = truncate(redact(error), 500)
    backoff = next_backoff(attempts)
    delivery["nextAttemptAtEpoch"] = int(time.time()) + backoff if backoff is not None else 0
    return event


def mark_attempt(event: dict[str, Any]) -> dict[str, Any]:
    delivery = event.setdefault("delivery", {})
    if not isinstance(delivery, dict):
        delivery = {}
        event["delivery"] = delivery
    delivery["attempts"] = int(delivery.get("attempts") or 0) + 1
    delivery["status"] = "sending"
    delivery["lastAttemptAt"] = now_iso()
    delivery["nextAttemptAtEpoch"] = 0
    return event


def mark_sent(event: dict[str, Any]) -> dict[str, Any]:
    delivery = event.setdefault("delivery", {})
    if isinstance(delivery, dict):
        delivery["status"] = "sent"
        delivery["sentAt"] = now_iso()
        delivery["lastError"] = None
    return event


def mark_suppressed(event: dict[str, Any], reason: str) -> dict[str, Any]:
    delivery = event.setdefault("delivery", {})
    if isinstance(delivery, dict):
        delivery["status"] = "suppressed"
        delivery["suppressedAt"] = now_iso()
        delivery["suppressedReason"] = reason
        delivery["lastError"] = None
    return event


def reset_delivery(event: dict[str, Any]) -> None:
    event["delivery"] = {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None}


def move_to_dead_letter(
    claimed: Path,
    paths: dict[str, Path],
    event: dict[str, Any],
    original_name: str,
) -> Path:
    """Move an event that exhausted all delivery attempts into dead-letter/."""
    delivery = event.setdefault("delivery", {})
    if isinstance(delivery, dict):
        delivery["status"] = "dead_letter"
        delivery["terminatedAt"] = now_iso()
    terminated_at = now_iso()
    record = {
        "event": event,
        "delivery": delivery if isinstance(delivery, dict) else {"status": "dead_letter"},
        "terminated_at": terminated_at,
    }
    dest = safe_child_path(
        paths["dead_letter"],
        f"{original_name}.{int(time.time())}.dead_letter.json",
    )
    atomic_write_json(dest, record)
    try:
        claimed.unlink()
    except FileNotFoundError:
        pass
    fsync_parent(dest)
    return dest


def dead_letter_meta_event(paths: dict[str, Path], count: int, oldest_summary: str) -> dict[str, Any]:
    now = int(time.time())
    return {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "critical",
        "id": f"dispatcher-dead-letter-meta-{now}",
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": sys.platform,
        "instance": "bot-errors-dispatcher",
        "source": "meta_alert_dead_letter",
        "summary": f"BOT ERRORS dead-letter: {count} event(s) exhausted all delivery attempts",
        # NOTE: the absolute dead-letter dir path is deliberately NOT in evidence.
        # matched_test_leak_pattern() walks every string field, and a state root
        # under a test sandbox (/var/folders/.../T/, /tmp/whatsoup-vitest-bot-errors/)
        # would make this meta-alert self-match the test-leak filter and be silently
        # dropped in integration tests. The path is a fixed, known location; it is
        # recorded in the dispatch log instead (queue_dead_letter_meta_alert).
        "evidence": "\n".join([
            f"dead_letter_count={count}",
            f"oldest_summary={redacted_state_text(oldest_summary, 200)}",
        ]),
        "process": {"pid": os.getpid()},
        "diagnostics": {"omitDispatchLogInMessage": True},
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }


def queue_dead_letter_meta_alert(paths: dict[str, Path], now: int) -> int:
    """Emit at most one meta-alert per hour when dead-letter dir is non-empty."""
    dl_dir = paths["dead_letter"]
    if not dl_dir.exists():
        return 0
    dl_files = [f for f in dl_dir.glob("*.json") if f.is_file()]
    if not dl_files:
        return 0

    state = read_meta_state(paths)
    last = int(state.get("deadLetterMetaAlertAtEpoch") or 0)
    if last and now - last < DEAD_LETTER_META_ALERT_THROTTLE_SECONDS:
        append_dispatch_log(paths, {
            "type": "dead_letter_meta_debounced",
            "count": len(dl_files),
            "throttleSeconds": DEAD_LETTER_META_ALERT_THROTTLE_SECONDS,
        })
        return 0

    oldest_summary = ""
    try:
        oldest_file = min(dl_files, key=lambda f: f.stat().st_mtime)
        crumb = json.loads(oldest_file.read_text(encoding="utf-8"))
        oldest_summary = str(crumb.get("event", {}).get("summary") or "")
    except Exception:  # noqa: BLE001
        oldest_summary = ""

    event = dead_letter_meta_event(paths, len(dl_files), oldest_summary)
    path = outbox_path_for_event(event, paths)
    atomic_write_json(path, event)
    state["deadLetterMetaAlertAtEpoch"] = now
    state["deadLetterMetaAlertEventId"] = event["id"]
    write_meta_state(paths, state)
    append_dispatch_log(paths, {
        "type": "dead_letter_meta_queued",
        "eventId": event["id"],
        "count": len(dl_files),
        "deadLetterDir": str(paths["dead_letter"]),
    })
    return 1



def archive_path(directory: Path, original_name: str, status: str, event: dict[str, Any]) -> Path:
    _event_id = str(event.get("id") or "")
    return safe_child_path(directory, f"{original_name}.{int(time.time())}.{status}")


def should_suppress_send(event: dict[str, Any], incident_state: dict[str, Any]) -> str | None:
    if os.environ.get("BOT_ERRORS_SEND_DAILY_HEALTH_INFO", "").strip().lower() in {"1", "true", "yes", "on"}:
        return None
    source = str(event.get("source") or "")
    severity = str(event.get("severity") or "").lower()
    if (
        is_incident_alert(event)
        and source == "whatsapp_auth_bond_local_failure"
        and TEST_FIXTURE_AUTH_BOND.search(str(event.get("evidence") or ""))
    ):
        return "test fixture auth-bond event suppressed from live BOT ERRORS"
    if source == "daily-health" and severity == "info" and not is_incident_clear(event):
        return "daily-health info events are retained for heartbeat freshness but not posted to BOT ERRORS"
    # Pattern B (Part 2) — silence incident ALERTS for a scope under a planned
    # maintenance window. CLEAR events are never gated here: a recovery during
    # maintenance must still close the incident. FAIL-OPEN: gate off, or any
    # ambiguity in the window file, sends as before.
    if (
        MAINTENANCE_ENABLED
        and is_incident_alert(event)
        and not is_incident_clear(event)
    ):
        maintenance_reason = active_maintenance_window(event)
        if maintenance_reason is not None:
            event.setdefault("diagnostics", {})["maintenanceSilenced"] = True
            return f"maintenance_silenced: {maintenance_reason}"
    migrate_legacy_unqualified_incident(event, incident_state)
    key = incident_key(event)
    current = int(time.time())
    open_incidents = incident_state.setdefault("openIncidents", {})
    stronger = stronger_open_incident_for(event, incident_state)
    if stronger is not None:
        stronger_key, stronger_record = stronger
        mark_suppressed_by_stronger(event, stronger_key, stronger_record, current)
        root_source = stronger_key.rsplit("|", 1)[-1]
        if is_incident_clear(event):
            return f"clear for {key} suppressed because stronger incident {stronger_key} remains open"
        return (
            f"symptom incident {key} suppressed because stronger incident "
            f"{stronger_key} remains open (inhibited_by:{root_source})"
        )
    if is_incident_alert(event):
        open_record = open_incidents.get(key)
        if isinstance(open_record, dict):
            if str(open_record.get("status") or "") == "stale":
                open_record["status"] = "open"
                open_record["unstaleAt"] = current
                open_record["unstaleIso"] = now_iso()
            open_record["lastSeenAt"] = current
            open_record["lastSeenIso"] = now_iso()
            open_record["lastEventId"] = event.get("id")
            open_record["lastSummary"] = redacted_state_text(event.get("summary"), 500)
            open_record["lastEvidence"] = redacted_state_text(event.get("evidence"), 1000, tail=True)
            suppressed = int_field(open_record, "suppressedCount") + 1
            open_record["suppressedCount"] = suppressed
            became_awaiting_physical = update_awaiting_physical_tracking(event, open_record, current)
            if became_awaiting_physical:
                append_still_open_context(event, open_record, key, current, suppressed, escalated=False, digest=False)
                open_record["lastNotifiedAt"] = current
                open_record["lastNotifiedIso"] = now_iso()
                return None
            level = force_notify_level(event)
            if level:
                levels = open_record.setdefault("forceNotifyLevels", {})
                last_level_sent = int(levels.get(level) or 0) if isinstance(levels, dict) else 0
                if last_level_sent and current - last_level_sent < INCIDENT_RENOTIFY_SECONDS:
                    return f"forceNotify cooldown active for {key} level={level}; last sent {current - last_level_sent}s ago"
                if isinstance(levels, dict):
                    levels[level] = current
                open_record["lastNotifiedAt"] = current
                open_record["lastNotifiedIso"] = now_iso()
                return None
            opened = int_field(open_record, "openedAt", current)
            last_notified = int_field(open_record, "lastNotifiedAt", int_field(open_record, "lastSentAt", opened))
            age_seconds = max(0, current - opened)
            since_notified = max(0, current - last_notified)
            awaiting_physical = str(open_record.get("status") or "") == "awaiting_physical"
            renotify_seconds = AWAITING_PHYSICAL_RENOTIFY_SECONDS if awaiting_physical else INCIDENT_RENOTIFY_SECONDS
            escalated = (
                False
                if awaiting_physical
                else age_seconds >= INCIDENT_ESCALATE_SECONDS or suppressed >= INCIDENT_ESCALATE_SUPPRESSED
            )
            if since_notified >= renotify_seconds:
                open_record["lastNotifiedAt"] = current
                open_record["lastNotifiedIso"] = now_iso()
                open_record["renotifyCount"] = int_field(open_record, "renotifyCount") + 1
                append_still_open_context(event, open_record, key, current, suppressed, escalated)
                return None
            return f"incident already open for {key}; duplicate suppressed"
        last_sent = int(incident_state.setdefault("lastSentAt", {}).get(key) or 0)
        if last_sent and current - last_sent < INCIDENT_COOLDOWN_SECONDS:
            if force_notify_level(event):
                return None
            return f"incident cooldown active for {key}; last sent {current - last_sent}s ago"
    if is_incident_clear(event):
        open_record = open_incidents.get(key)
        if not isinstance(open_record, dict):
            recovered_keys = daily_health_recovered_incident_keys(event, incident_state)
            if recovered_keys or is_recovery_dedupe_candidate(event):
                return None
            return f"clear has no open incident for {key}; stale recovery suppressed"
        opened = int_field(open_record, "eventCreatedAtEpoch")
        created = event_created_epoch(event)
        if opened > 0 and created is not None and created < opened - CLOCK_SKEW_TOLERANCE_SECONDS:
            return f"clear predates open incident for {key}; stale recovery suppressed"
    return None


def is_test_provenance_event(event: dict[str, Any]) -> bool:
    runtime = event.get("runtime") if isinstance(event.get("runtime"), dict) else {}
    provenance = runtime.get("provenance") if isinstance(runtime.get("provenance"), dict) else {}
    return provenance.get("test") is True


def omit_dispatch_log_in_message(event: dict[str, Any]) -> bool:
    diagnostics = event.get("diagnostics") if isinstance(event.get("diagnostics"), dict) else {}
    return diagnostics.get("omitDispatchLogInMessage") is True


def _clear_satisfies_requirement(event: dict[str, Any], requirement: str) -> bool:
    """Advisory check: does the clear event's source satisfy the stored clearRequirement?

    Uses simple substring/containment matching: if the requirement string appears
    in the clear source (or vice versa), the requirement is considered satisfied.
    This is intentionally permissive — the advisory note is informational only.
    """
    if not requirement:
        return True
    source = incident_source(event).lower()
    req = requirement.lower()
    return req in source or source in req


def append_clear_context(event: dict[str, Any], incident_state: dict[str, Any]) -> None:
    if not is_incident_clear(event):
        return
    recovered_keys = daily_health_recovered_incident_keys(event, incident_state)
    open_record = incident_state.setdefault("openIncidents", {}).get(incident_key(event))
    if not isinstance(open_record, dict) and not recovered_keys:
        return
    additions: list[str] = []
    if isinstance(open_record, dict):
        suppressed = int(open_record.get("suppressedCount") or 0)
        additions.extend([
            f"opened={open_record.get('openedIso') or open_record.get('openedAt')}",
            f"prior_event={open_record.get('eventId')}",
            f"suppressed_duplicates={suppressed}",
            f"last_seen={open_record.get('lastSeenIso') or open_record.get('lastSeenAt')}",
        ])
        # F8: clearRequirement advisory — informational only; any clear still closes the incident.
        stored_requirement = str(open_record.get("clearRequirement") or "").strip()
        if stored_requirement and not _clear_satisfies_requirement(event, stored_requirement):
            additions.append(
                f"clearRequirement_mismatch=true"
                f" clearRequirement={redacted_state_text(stored_requirement, 200)}"
                f" clear_source={safe_segment(incident_source(event))}"
                f" note=advisory_only_incident_still_closed"
            )
    if recovered_keys:
        additions.append("recovered_incidents=" + ",".join(recovered_keys))
    evidence = str(event.get("evidence") or "").strip()
    event["evidence"] = "\n".join(part for part in [evidence, *additions] if part)


def mark_incident_sent(event: dict[str, Any], incident_state: dict[str, Any]) -> None:
    key = incident_key(event)
    current = int(time.time())
    if is_incident_alert(event):
        close_superseded_incidents(event, incident_state)
        incident_state.setdefault("lastSentAt", {})[key] = current
        existing = incident_state.setdefault("openIncidents", {}).get(key)
        existing_record = existing if isinstance(existing, dict) else {}
        opened_at = int_field(existing_record, "openedAt", current)
        opened_iso = existing_record.get("openedIso") or now_iso()
        event_created_at_epoch = event_created_epoch(event) or current
        suppressed = int_field(existing_record, "suppressedCount")
        renotify_count = int_field(existing_record, "renotifyCount") + (1 if existing_record else 0)
        force_levels = existing_record.get("forceNotifyLevels") if isinstance(existing_record.get("forceNotifyLevels"), dict) else {}
        level = force_notify_level(event)
        if level:
            force_levels[level] = current
        updated_record = {
            **existing_record,
            "status": str(existing_record.get("status") or "open"),
            "eventId": event.get("id"),
            "eventCreatedAt": event.get("createdAt"),
            "eventCreatedAtEpoch": event_created_at_epoch,
            "openedAt": opened_at,
            "openedIso": opened_iso,
            "lastSeenAt": current,
            "lastSeenIso": now_iso(),
            "lastSentAt": current,
            "lastSentIso": now_iso(),
            "lastNotifiedAt": current,
            "lastNotifiedIso": now_iso(),
            "lastSummary": redacted_state_text(event.get("summary"), 500),
            "lastEvidence": redacted_state_text(event.get("evidence"), 1000, tail=True),
            "suppressedCount": suppressed,
            "renotifyCount": renotify_count,
            "forceNotifyLevels": force_levels,
        }
        code = critical_failure_code(event)
        if code:
            updated_record["failureCode"] = code
        recoverability = critical_recoverability(event)
        if recoverability:
            updated_record["recoverability"] = recoverability
        clear_requirement = critical_clear_requirement(event)
        if clear_requirement:
            updated_record["clearRequirement"] = clear_requirement
        asset_kind = str(critical_asset_asset(event).get("kind") or "").strip()
        if asset_kind:
            updated_record["assetKind"] = asset_kind
        asset_instance = str(critical_asset_asset(event).get("instance") or "").strip()
        if asset_instance:
            updated_record["assetInstance"] = asset_instance
        update_awaiting_physical_tracking(event, updated_record, current)
        incident_state.setdefault("openIncidents", {})[key] = updated_record
        legacy_key = legacy_unqualified_incident_key(event)
        if legacy_key and legacy_key != key:
            legacy_record = incident_state.setdefault("openIncidents", {}).get(legacy_key)
            if legacy_record_matches_alert_source(event, legacy_record if isinstance(legacy_record, dict) else None):
                incident_state.setdefault("openIncidents", {}).pop(legacy_key, None)
                incident_state.setdefault("lastSentAt", {}).pop(legacy_key, None)
    elif is_incident_clear(event):
        incident_state.setdefault("openIncidents", {}).pop(key, None)
        incident_state.setdefault("lastSentAt", {}).pop(key, None)
        close_recovered_daily_health_incidents(event, incident_state)


def close_superseded_incidents(event: dict[str, Any], incident_state: dict[str, Any]) -> None:
    source = safe_segment(str(event.get("source") or "unknown"))
    superseded_sources = SUPERSEDED_SOURCES_BY_ALERT_SOURCE.get(source)
    if not superseded_sources:
        return
    scope = incident_scope(event)
    open_incidents = incident_state.setdefault("openIncidents", {})
    last_sent = incident_state.setdefault("lastSentAt", {})
    for old_source in superseded_sources:
        old_key = f"{scope}|{old_source}"
        open_incidents.pop(old_key, None)
        last_sent.pop(old_key, None)
    # Prefix-aware close for per-instance health symptoms. Stored health
    # incidents use the QUALIFIED key form "{scope}|local_health:<instance>"
    # (incident_source() qualifies them), so the exact-key pop above is a no-op
    # for them. When a bare "local_health" token is in the symptom set, also
    # close any open incident in the SAME scope whose stored source matches via
    # symptom_source_matches (i.e. "{scope}|local_health:*"). Reuses the same
    # prefix logic as the inhibition path; exact-match behavior for all other
    # sources is unchanged. Collect keys first to avoid mutating while iterating.
    if "local_health" in superseded_sources:
        scope_prefix = f"{scope}|"
        prefixed_keys = [
            key
            for key in open_incidents
            if key.startswith(scope_prefix)
            and symptom_source_matches(key[len(scope_prefix):], superseded_sources)
        ]
        for key in prefixed_keys:
            open_incidents.pop(key, None)
            last_sent.pop(key, None)


def stronger_open_incident_for(
    event: dict[str, Any],
    incident_state: dict[str, Any],
) -> tuple[str, dict[str, Any]] | None:
    # Pattern C gate — FAIL-OPEN. When inhibition is disabled, never suppress.
    if not INHIBITION_ENABLED:
        return None
    source = incident_source(event)
    scope = incident_scope(event)
    open_incidents = incident_state.setdefault("openIncidents", {})
    for stronger_source, superseded_sources in INHIBITION_MAP.items():
        if not symptom_source_matches(source, superseded_sources):
            continue
        # A root incident must never suppress itself.
        if source == stronger_source:
            continue
        stronger_key = f"{scope}|{stronger_source}"
        record = open_incidents.get(stronger_key)
        if not isinstance(record, dict):
            continue
        status = str(record.get("status") or "open")
        if status in {"closed", "resolved", "stale"}:
            continue
        return stronger_key, record
    return None


def mark_suppressed_by_stronger(
    event: dict[str, Any],
    stronger_key: str,
    stronger_record: dict[str, Any],
    current: int,
) -> None:
    if is_incident_clear(event):
        stronger_record["suppressedClearCount"] = int_field(stronger_record, "suppressedClearCount") + 1
        stronger_record["lastSuppressedClearAt"] = current
        stronger_record["lastSuppressedClearIso"] = now_iso()
        stronger_record["lastSuppressedClearSource"] = incident_source(event)
        stronger_record["lastSuppressedClearSummary"] = redacted_state_text(event.get("summary"), 500)
        stronger_record["lastSuppressedClearReason"] = f"clear suppressed by stronger open incident {stronger_key}"
        return

    stronger_record["lastSeenAt"] = current
    stronger_record["lastSeenIso"] = now_iso()
    stronger_record["lastSuppressedSymptomSource"] = incident_source(event)
    stronger_record["lastSuppressedSymptomSummary"] = redacted_state_text(event.get("summary"), 500)
    stronger_record["lastSuppressedSymptomEvidence"] = redacted_state_text(event.get("evidence"), 1000, tail=True)
    if critical_failure_code(event):
        stronger_record["lastSuppressedSymptomFailureCode"] = critical_failure_code(event)
    stronger_record["suppressedCount"] = int_field(stronger_record, "suppressedCount") + 1
    # Pattern C — tag the suppressed symptom with inhibited_by:<root_source>,
    # mirroring how Pattern F tags flap_storm members. The root source is the
    # last segment of the stronger_key (scope|root_source). Auto-release is
    # automatic: this reason is derived at decision time from open-incident
    # state, so it disappears once the root incident clears (NO persistent flag).
    root_source = stronger_key.rsplit("|", 1)[-1]
    stronger_record["lastSuppressedSymptomReason"] = f"inhibited_by:{root_source}"


def incident_event_fields_from_key(key: str) -> dict[str, str]:
    parts = key.split("|", 2)
    machine = parts[0] if len(parts) > 0 and parts[0] else "unknown"
    instance = parts[1] if len(parts) > 1 and parts[1] else "unknown"
    source = parts[2] if len(parts) > 2 and parts[2] else "unknown"
    fields = {"machine": machine, "instance": instance, "source": source}
    if source.startswith("heartbeat-watchdog:"):
        fields["source"] = "heartbeat-watchdog"
        fields["alertSource"] = source.split(":", 1)[1]
    elif source.startswith("daily-health-fail:"):
        # Per-instance daily-health-fail incidents key as daily-health-fail:<instance>.
        # Must be checked before daily-health: — "daily-health-fail:x" does NOT
        # startswith "daily-health:" (char 13 is '-' not ':'), but keeping the more
        # specific prefix first guards against future loosening.
        fields["source"] = "daily-health-fail"
        fields["alertSource"] = source.split(":", 1)[1]
    elif source.startswith("daily-health:"):
        fields["source"] = "daily-health"
        fields["alertSource"] = source.split(":", 1)[1]
    elif instance == "bot-errors-collector" and source.startswith("remote-") and ":" in source:
        fields["source"], remote = source.split(":", 1)
        fields["diagnostics"] = {"remote": remote}
    return fields


def stale_incident_event(key: str, record: dict[str, Any], current: int) -> dict[str, Any] | None:
    previous_status = str(record.get("status") or "open")
    opened = int_field(record, "openedAt", current)
    last_seen = int_field(record, "lastSeenAt", opened)
    quiet_seconds = max(0, current - last_seen)
    if quiet_seconds < INCIDENT_STALE_SECONDS:
        return None

    awaiting_physical = previous_status == "awaiting_physical"
    renotify_seconds = AWAITING_PHYSICAL_RENOTIFY_SECONDS if awaiting_physical else INCIDENT_STALE_RENOTIFY_SECONDS
    last_stale_notified = int_field(record, "lastStaleRenotifiedAt")
    if last_stale_notified and current - last_stale_notified < renotify_seconds:
        return None
    last_stale_failed = int_field(record, "lastStaleRenotifyFailedAt")
    if last_stale_failed and current - last_stale_failed < INCIDENT_STALE_FAILURE_RETRY_SECONDS:
        return None

    summary = str(record.get("lastSummary") or key)
    if awaiting_physical:
        title = f"Stale incident digest, awaiting physical action: {summary}"
        action = physical_action_text()
        next_status = "awaiting_physical"
    else:
        title = f"Stale incident digest: {summary}"
        action = stale_action_text()
        next_status = "stale"
    severity = "info"

    additions = [
        "stale_digest=true",
        "incident_stale=true",
        f"incident_key={key}",
        f"incident_status={next_status}",
        f"previous_status={previous_status}",
        f"opened={record.get('openedIso') or opened}",
        f"last_seen={record.get('lastSeenIso') or last_seen}",
        f"quiet_seconds={quiet_seconds}",
        f"suppressed_duplicates={int_field(record, 'suppressedCount')}",
        f"renotify_cadence_seconds={renotify_seconds}",
        f"requested_action={action}",
    ]
    fields = incident_event_fields_from_key(key)
    event = {
        "schemaVersion": 1,
        "id": f"stale-{safe_segment(key)}-{current}",
        "eventType": "alert",
        "severity": severity,
        "createdAt": now_iso(),
        **fields,
        "summary": title,
        "evidence": "\n".join(additions),
        "diagnostics": {
            "logHints": ["journalctl --user -u bot-errors-dispatcher.service --since '30 minutes ago'"],
            "dispatchLog": str(state_paths()["logs"] / "dispatch.jsonl"),
            "queue": str(state_root()),
        },
        "delivery": {"attempts": 1, "status": "stale-renotify", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    failure_code = str(record.get("failureCode") or "").strip()
    recoverability = str(record.get("recoverability") or "").strip()
    asset_kind = str(record.get("assetKind") or "").strip()
    clear_requirement = str(record.get("clearRequirement") or "").strip()
    if failure_code or recoverability or asset_kind:
        event["criticalAsset"] = {
            "asset": {
                "kind": asset_kind or "whatsapp_linked_device",
                "instance": fields.get("instance", "unknown"),
                "owner": "whatsoup",
            },
            "failure": {
                "code": failure_code or "UNKNOWN_STALE_INCIDENT",
                "domain": "account_linkage" if (asset_kind or "").startswith("whatsapp") else "operational_reliability",
                "recoverability": recoverability or "unknown",
                "confidence": "confirmed" if previous_status == "awaiting_physical" else "probable",
                "operatorAction": action,
                "clearRequirement": clear_requirement or "matching clear event from the original source",
            },
        }
    return event


def mark_stale_incident_notified(record: dict[str, Any], event: dict[str, Any], current: int) -> None:
    previous_status = str(record.get("status") or "open")
    if previous_status != "awaiting_physical":
        record["status"] = "stale"
    if not record.get("staleAt"):
        record["staleAt"] = current
        record["staleIso"] = now_iso()
    record["lastStaleRenotifiedAt"] = current
    record["lastStaleRenotifiedIso"] = now_iso()
    record["lastNotifiedAt"] = current
    record["lastNotifiedIso"] = now_iso()
    record["lastStaleRenotifyEventId"] = event.get("id")
    record["staleRenotifyCount"] = int_field(record, "staleRenotifyCount") + 1
    record.pop("lastStaleRenotifyError", None)


def mark_stale_incident_failed(record: dict[str, Any], event: dict[str, Any], current: int, error: str) -> None:
    if not record.get("staleAt"):
        record["staleAt"] = current
        record["staleIso"] = now_iso()
    record["lastStaleRenotifyFailedAt"] = current
    record["lastStaleRenotifyFailedIso"] = now_iso()
    record["lastStaleRenotifyFailedEventId"] = event.get("id")
    record["lastStaleRenotifyError"] = truncate(error, 500)
    record["staleRenotifyFailureCount"] = int_field(record, "staleRenotifyFailureCount") + 1


def sweep_stale_incidents(paths: dict[str, Path], skip_keys: set[str] | None = None) -> tuple[int, int, str | None]:
    incident_state = load_incident_state(paths)
    open_incidents = incident_state.setdefault("openIncidents", {})
    current = int(time.time())
    sent = 0
    failed = 0
    last_error = None
    changed = False
    for key, record in sorted(open_incidents.items()):
        if skip_keys and str(key) in skip_keys:
            continue
        if not isinstance(record, dict):
            continue
        event = stale_incident_event(str(key), record, current)
        if event is None:
            continue
        if sent + failed >= INCIDENT_STALE_SWEEP_MAX_EVENTS:
            append_dispatch_log(paths, {
                "type": "stale_renotify_batch_cap_reached",
                "limit": INCIDENT_STALE_SWEEP_MAX_EVENTS,
                "sent": sent,
                "failed": failed,
            })
            break
        text = format_event(event)
        try:
            send_whatsapp(text)
        except Exception as exc:
            failed += 1
            last_error = str(exc)
            mark_stale_incident_failed(record, event, current, str(exc))
            changed = True
            append_dispatch_log(paths, {
                "type": "stale_renotify_failed",
                "incidentKey": key,
                "eventId": event.get("id"),
                "error": str(exc),
            })
            continue
        mark_stale_incident_notified(record, event, current)
        sent += 1
        changed = True
        append_dispatch_log(paths, {
            "type": "stale_renotify",
            "incidentKey": key,
            "eventId": event.get("id"),
            "status": record.get("status"),
            "staleRenotifyCount": record.get("staleRenotifyCount"),
        })
    if changed:
        save_incident_state(paths, incident_state)
    return sent, failed, last_error


def storm_threshold() -> int:
    return max(0, env_int("BOT_ERRORS_STORM_THRESHOLD", 3))


def storm_window_seconds() -> int:
    return max(1, env_int("BOT_ERRORS_STORM_WINDOW_SECONDS", 120))


def recovery_dedupe_window_seconds() -> int:
    return max(1, env_int("BOT_ERRORS_RECOVERY_DEDUPE_WINDOW_SECONDS", storm_window_seconds()))


def suppressed_max_files() -> int:
    return max(1, env_int("BOT_ERRORS_SUPPRESSED_MAX_FILES", 2000))


def test_provenance_meta_window_seconds() -> int:
    return max(1, env_int("BOT_ERRORS_TEST_PROVENANCE_META_WINDOW_SECONDS", 900))


def created_epoch(event: dict[str, Any]) -> int:
    created = str(event.get("createdAt") or "").strip()
    if created:
        if "." in created and created.endswith("Z"):
            created = created.split(".", 1)[0] + "Z"
        try:
            return int(calendar.timegm(time.strptime(created, "%Y-%m-%dT%H:%M:%SZ")))
        except ValueError:
            pass
    return int(time.time())


def iso_from_epoch(epoch: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def event_host(event: dict[str, Any]) -> str:
    for key in ("machine", "machineName", "host", "hostname", "instance"):
        value = str(event.get(key) or "").strip()
        if value:
            return value
    return "unknown"


def sorted_unique_hosts(events: list[dict[str, Any]]) -> list[str]:
    hosts = {event_host(event) for event in events}
    return sorted(hosts, key=lambda value: value.lower())


def normalize_token_lists(text: str) -> str:
    def sort_match(match: re.Match[str]) -> str:
        items = [item.strip() for item in match.group(0).split(",") if item.strip()]
        return ",".join(sorted(items, key=lambda value: value.lower()))

    return COMMA_TOKEN_LIST.sub(sort_match, text)


def normalized_summary(event: dict[str, Any]) -> str:
    text = redact(event.get("summary") or "unspecified bot error").lower()
    host_tokens = set()
    for key in ("machine", "machineName", "host", "hostname", "instance"):
        raw = str(event.get(key) or "").strip().lower()
        if not raw:
            continue
        host_tokens.add(raw)
        host_tokens.add(raw.split(".", 1)[0])
    for token in sorted(host_tokens, key=len, reverse=True):
        if token:
            text = re.sub(rf"\b{re.escape(token)}\b", "{host}", text)
    text = re.sub(r"\b(?:maclab|mwlab|mini\d{1,2})\b", "{host}", text)
    text = normalize_token_lists(text)
    return re.sub(r"\s+", " ", text).strip()


def storm_fingerprint(event: dict[str, Any]) -> str:
    parts = [
        str(event.get("source") or "unknown").strip().lower(),
        str(event.get("severity") or "critical").strip().lower(),
        normalized_summary(event),
    ]
    return "\n".join(parts)


def storm_fingerprint_hash(fingerprint: str) -> str:
    return hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:16]


def find_event_path_by_id(event_id: str, paths: dict[str, Path], keys: tuple[str, ...]) -> Path | None:
    if not event_id:
        return None
    for key in keys:
        directory = paths[key]
        if not directory.exists():
            continue
        for path in directory.glob("*"):
            if not path.is_file():
                continue
            try:
                if read_json(path).get("id") == event_id:
                    return path
            except Exception:
                continue
    return None


def is_storm_candidate(event: dict[str, Any]) -> bool:
    if isinstance(event.get("storm"), dict):
        return False
    event_type = str(event.get("eventType") or "alert")
    severity = str(event.get("severity") or "").lower()
    return event_type == "alert" and severity in {"critical", "warning"}


def recovery_normalized_summary(event: dict[str, Any]) -> str:
    text = str(event.get("summary") or "unspecified bot error").strip().lower()
    return re.sub(r"\s+", " ", text)


def recovery_identity(event: dict[str, Any]) -> tuple[str, str]:
    host = ""
    for key in ("machine", "machineName", "host", "hostname"):
        host = str(event.get(key) or "").strip().lower()
        if host:
            break
    instance = str(event.get("instance") or "").strip().lower()
    return host, instance


def recovery_episode_fingerprint(event: dict[str, Any]) -> str:
    host, instance = recovery_identity(event)
    parts = [
        str(event.get("source") or "unknown").strip().lower(),
        recovery_normalized_summary(event),
        host,
        instance,
    ]
    return "\n".join(parts)


def recovery_duplicate_fingerprint(event: dict[str, Any]) -> str:
    host, instance = recovery_identity(event)
    parts = [
        str(event.get("eventType") or "alert").strip().lower(),
        str(event.get("severity") or "").strip().lower(),
        str(event.get("source") or "unknown").strip().lower(),
        recovery_normalized_summary(event),
        host,
        instance,
    ]
    return "\n".join(parts)


def is_recovery_dedupe_candidate(event: dict[str, Any]) -> bool:
    event_type = str(event.get("eventType") or "alert").strip().lower()
    severity = str(event.get("severity") or "").strip().lower()
    source = str(event.get("source") or "").strip().lower()
    if source == "daily-health" and severity == "info":
        return False
    return event_type == "clear" or severity == "info"


def is_recovery_episode_barrier(event: dict[str, Any]) -> bool:
    event_type = str(event.get("eventType") or "alert").strip().lower()
    severity = str(event.get("severity") or "").strip().lower()
    return event_type == "alert" and severity in {"critical", "warning"}


def manifest_entry(path: Path, event: dict[str, Any]) -> dict[str, Any]:
    diagnostics = event.get("diagnostics") if isinstance(event.get("diagnostics"), dict) else {}
    log_hints = diagnostics.get("logHints") if isinstance(diagnostics.get("logHints"), list) else []
    return {
        "eventId": event.get("id"),
        "machine": event_host(event),
        "instance": event.get("instance"),
        "source": event.get("source"),
        "severity": event.get("severity"),
        "createdAt": event.get("createdAt"),
        "summary": truncate(redact(event.get("summary")), 700),
        "evidence": truncate(redact(event.get("evidence")), 1800),
        "outboxPath": str(path),
        "logHints": [truncate(redact(hint), 900) for hint in log_hints[:10]],
    }


def mark_collapsed(event: dict[str, Any], digest_id: str, manifest_path: Path) -> dict[str, Any]:
    delivery = event.setdefault("delivery", {})
    if isinstance(delivery, dict):
        delivery["status"] = "storm-collapsed"
        delivery["collapsedAt"] = now_iso()
        delivery["collapsedInto"] = digest_id
        delivery["lastError"] = None
    diagnostics = event.setdefault("diagnostics", {})
    if isinstance(diagnostics, dict):
        diagnostics["stormCollapse"] = {
            "digestId": digest_id,
            "manifest": str(manifest_path),
            "collapsedAt": now_iso(),
        }
    return event


def storm_digest_event(
    paths: dict[str, Path],
    fingerprint: str,
    fingerprint_hash: str,
    bucket_start: int,
    bucket_end: int,
    events: list[dict[str, Any]],
    manifest_path: Path,
) -> dict[str, Any]:
    first = events[0]
    hosts = sorted_unique_hosts(events)
    severity = str(first.get("severity") or "critical").lower()
    source = str(first.get("source") or "unknown")
    summary = normalized_summary(first) or "same fingerprint alert storm"
    digest_id = f"storm-{fingerprint_hash}-{bucket_start}"
    evidence_lines = [
        f"affected_hosts:{len(hosts)}",
        f"hosts:{', '.join(hosts)}",
        f"fingerprint:{fingerprint_hash}",
        f"source:{source}",
        f"severity:{severity}",
        f"window_start_epoch:{bucket_start}",
        f"window_end_epoch:{bucket_end}",
        f"collapsed_events:{len(events)}",
        f"manifest:{manifest_path}",
        f"fingerprint_basis:{fingerprint.replace(chr(10), ' | ')}",
    ]
    return {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": severity,
        "id": digest_id,
        "createdAt": now_iso(),
        "machine": "fleet",
        "platform": "mixed",
        "instance": "storm-collapse",
        "source": "storm-collapse",
        "summary": f"BOT ERRORS storm collapse: {len(hosts)} hosts - {summary}",
        "evidence": "\n".join(evidence_lines),
        "diagnostics": {
            "logHints": [str(manifest_path)],
            "queue": str(paths["outbox"]),
            "forceNotify": True,
            "forceNotifyLevel": f"storm-{fingerprint_hash}-{bucket_start}",
        },
        "storm": {
            "fingerprint": fingerprint_hash,
            "source": source,
            "affectedHosts": len(hosts),
            "hosts": hosts,
            "windowStartEpoch": bucket_start,
            "windowEndEpoch": bucket_end,
            "manifest": str(manifest_path),
            "collapsedEvents": len(events),
        },
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }


def storm_digest_outbox_path(paths: dict[str, Path], digest_id: str, source: str, window_start: int) -> Path:
    created = iso_from_epoch(window_start).replace("-", "").replace(":", "")
    instance = safe_segment("storm-collapse")
    source_segment = safe_segment(source or "unknown")
    event_id = safe_segment(digest_id)
    return paths["outbox"] / f"{created}.{instance}.{source_segment}.{event_id}.json"


def merge_manifest_entries(existing: list[Any], additions: list[dict[str, Any]]) -> list[Any]:
    seen: set[tuple[str, str]] = set()
    merged: list[Any] = []
    for entry in existing:
        if isinstance(entry, dict):
            key = (str(entry.get("eventId") or ""), str(entry.get("outboxPath") or ""))
            seen.add(key)
        merged.append(entry)
    for entry in additions:
        key = (str(entry.get("eventId") or ""), str(entry.get("outboxPath") or ""))
        if key in seen:
            continue
        seen.add(key)
        merged.append(entry)
    return merged


def existing_storm_window(
    paths: dict[str, Path],
    fingerprint_hash: str,
    start_epoch: int,
) -> tuple[dict[str, Any], Path] | None:
    for path in sorted(paths["storm_manifests"].glob(f"*.{fingerprint_hash}.json")):
        try:
            manifest = read_json(path)
            if manifest.get("fingerprint") != fingerprint_hash:
                continue
            window_start = int(manifest.get("windowStartEpoch") or 0)
            window_end = int(manifest.get("windowEndEpoch") or 0)
        except Exception:
            continue
        if window_start <= start_epoch < window_end:
            return manifest, path
    return None


def collapse_storm_group(
    paths: dict[str, Path],
    key: tuple[str, int],
    records: list[tuple[Path, dict[str, Any]]],
) -> int:
    fingerprint, requested_start = key
    window = storm_window_seconds()
    fingerprint_hash = storm_fingerprint_hash(fingerprint)
    existing = existing_storm_window(paths, fingerprint_hash, requested_start)
    if existing:
        existing_manifest, manifest_path = existing
        bucket_start = int(existing_manifest.get("windowStartEpoch") or requested_start)
        bucket_end = int(existing_manifest.get("windowEndEpoch") or (bucket_start + window))
        manifest = existing_manifest
    else:
        bucket_start = requested_start
        bucket_end = bucket_start + window
        manifest_path = paths["storm_manifests"] / f"{bucket_start}.{fingerprint_hash}.json"
        manifest = {}
    digest_id = f"storm-{fingerprint_hash}-{bucket_start}"
    events = [event for _, event in records]
    additions = [manifest_entry(path, event) for path, event in records]
    if not manifest and manifest_path.exists():
        try:
            manifest = read_json(manifest_path)
        except Exception:
            manifest = {}
    existing_entries = manifest.get("entries") if isinstance(manifest.get("entries"), list) else []
    existing_collapsed = (
        manifest.get("entriesCollapsed")
        if isinstance(manifest.get("entriesCollapsed"), list)
        else []
    )
    existing_hosts = manifest.get("hosts") if isinstance(manifest.get("hosts"), list) else []
    merged_hosts = sorted(
        {str(host) for host in existing_hosts if str(host)} | set(sorted_unique_hosts(events)),
        key=lambda value: value.lower(),
    )
    manifest = {
        "schemaVersion": 1,
        "kind": "bot_errors_storm_collapse",
        "createdAt": manifest.get("createdAt") or now_iso(),
        "updatedAt": now_iso(),
        "digestId": digest_id,
        "fingerprint": fingerprint_hash,
        "windowStartEpoch": bucket_start,
        "windowEndEpoch": bucket_end,
        "affectedHosts": len(merged_hosts),
        "hosts": merged_hosts,
        "entries": merge_manifest_entries(existing_entries, additions),
    }
    atomic_write_json(manifest_path, manifest)

    known_digest_path = find_event_path_by_id(
        digest_id,
        paths,
        ("outbox", "processing", "sent", "suppressed", "quarantine"),
    )
    digest = storm_digest_event(
        paths, fingerprint, fingerprint_hash, bucket_start, bucket_end, events, manifest_path
    )
    digest_path = known_digest_path or storm_digest_outbox_path(paths, digest_id, str(digest.get("source")), bucket_start)
    if known_digest_path is None:
        atomic_write_json(digest_path, digest)
        append_dispatch_log(paths, {
            "type": "storm_digest_queued",
            "digestId": digest.get("id"),
            "digestPath": str(digest_path),
            "fingerprint": fingerprint_hash,
            "affectedHosts": len(sorted_unique_hosts(events)),
            "collapsedEvents": len(events),
            "manifest": str(manifest_path),
        })
    else:
        append_dispatch_log(paths, {
            "type": "storm_digest_reused",
            "digestId": digest_id,
            "digestPath": str(digest_path),
            "fingerprint": fingerprint_hash,
            "manifest": str(manifest_path),
        })
    manifest["digestOutboxPath"] = str(digest_path)

    collapsed = 0
    collapsed_entries: list[dict[str, Any]] = []
    for path, event in records:
        if not path.exists():
            append_dispatch_log(paths, {
                "type": "storm_collapse_missing_source",
                "digestId": digest.get("id"),
                "sourcePath": str(path),
            })
            continue
        event = mark_collapsed(event, str(digest.get("id")), manifest_path)
        atomic_write_json(path, event)
        target = paths["storm_collapsed"] / (
            f"{path.name}.{safe_segment(str(digest.get('id')))}.{int(time.time())}.collapsed"
        )
        os.replace(path, target)
        collapsed += 1
        collapsed_entries.append({
            "eventId": event.get("id"),
            "sourcePath": str(path),
            "collapsedPath": str(target),
        })
        append_dispatch_log(paths, {
            "type": "storm_collapsed",
            "eventId": event.get("id"),
            "digestId": digest.get("id"),
            "fingerprint": fingerprint_hash,
            "sourcePath": str(path),
            "collapsedPath": str(target),
            "manifest": str(manifest_path),
        })

    manifest["entriesCollapsed"] = merge_manifest_entries(existing_collapsed, collapsed_entries)
    atomic_write_json(manifest_path, manifest)
    return collapsed


def collapse_ready_storms(paths: dict[str, Path]) -> int:
    threshold = storm_threshold()
    if threshold < 2:
        return 0
    window = storm_window_seconds()
    groups: dict[str, list[tuple[Path, dict[str, Any], int]]] = {}
    for path in sorted(paths["outbox"].glob("*.json")):
        if not ready(path, paths["quarantine"]):
            continue
        try:
            event = read_json(path)
        except Exception:
            continue
        if not is_storm_candidate(event):
            continue
        fingerprint = storm_fingerprint(event)
        groups.setdefault(fingerprint, []).append((path, event, created_epoch(event)))

    collapsed = 0
    for fingerprint, records in groups.items():
        remaining = sorted(records, key=lambda record: (record[2], str(record[0])))
        while remaining:
            collapsed_window = False
            for index, (_, _, start_epoch) in enumerate(remaining):
                cluster = [
                    (path, event, epoch)
                    for path, event, epoch in remaining[index:]
                    if start_epoch <= epoch < start_epoch + window
                ]
                events = [event for _, event, _ in cluster]
                if len(sorted_unique_hosts(events)) < threshold:
                    continue
                collapsed += collapse_storm_group(
                    paths,
                    (fingerprint, start_epoch),
                    [(path, event) for path, event, _ in cluster],
                )
                clustered_paths = {path for path, _, _ in cluster}
                remaining = [record for record in remaining if record[0] not in clustered_paths]
                collapsed_window = True
                break
            if not collapsed_window:
                break
    return collapsed


def move_suppressed_event(
    path: Path,
    paths: dict[str, Path],
    event: dict[str, Any],
    reason: str,
    log_type: str = "suppressed",
    source_name: str | None = None,
) -> Path:
    event = mark_suppressed(event, reason)
    atomic_write_json(path, event)
    suppressed_path = archive_path(paths["suppressed"], source_name or path.name, "suppressed", event)
    os.replace(path, suppressed_path)
    fsync_parent(suppressed_path)
    append_dispatch_log(paths, {
        "type": log_type,
        "eventId": event.get("id"),
        "path": str(suppressed_path),
        "reason": reason,
        "source": event.get("source"),
        "severity": event.get("severity"),
        "eventType": event.get("eventType"),
        "attempts": event.get("delivery", {}).get("attempts") if isinstance(event.get("delivery"), dict) else None,
    })
    return suppressed_path


def suppress_ready_recovery_duplicates(paths: dict[str, Path]) -> int:
    window = recovery_dedupe_window_seconds()
    groups: dict[str, list[tuple[Path, dict[str, Any], int]]] = {}
    for path in sorted(paths["outbox"].glob("*.json")):
        if not ready(path, paths["quarantine"]):
            continue
        try:
            event = read_json(path)
        except Exception:
            continue
        if not is_recovery_dedupe_candidate(event) and not is_recovery_episode_barrier(event):
            continue
        groups.setdefault(recovery_episode_fingerprint(event), []).append((path, event, created_epoch(event)))

    suppressed = 0
    for records in groups.values():
        kept_by_duplicate_fingerprint: dict[str, int] = {}
        for path, event, epoch in sorted(records, key=lambda record: (record[2], str(record[0]))):
            if is_recovery_episode_barrier(event):
                kept_by_duplicate_fingerprint.clear()
                append_dispatch_log(paths, {
                    "type": "recovery_dedupe_barrier",
                    "eventId": event.get("id"),
                    "source": event.get("source"),
                    "severity": event.get("severity"),
                    "eventType": event.get("eventType"),
                    "episodeFingerprint": storm_fingerprint_hash(recovery_episode_fingerprint(event)),
                    "createdAtEpoch": epoch,
                })
                continue
            if not is_recovery_dedupe_candidate(event):
                continue
            duplicate_fingerprint = recovery_duplicate_fingerprint(event)
            first_epoch = kept_by_duplicate_fingerprint.get(duplicate_fingerprint)
            if first_epoch is not None and first_epoch <= epoch < first_epoch + window:
                if not path.exists():
                    continue
                move_suppressed_event(
                    path,
                    paths,
                    event,
                    RECOVERY_DUPLICATE_SUPPRESSION_REASON,
                    "recovery_duplicate_suppressed",
                )
                suppressed += 1
                continue
            kept_by_duplicate_fingerprint[duplicate_fingerprint] = epoch
    return suppressed


def prune_suppressed(paths: dict[str, Path]) -> int:
    cap = suppressed_max_files()
    files = [path for path in paths["suppressed"].glob("*") if path.is_file()]
    if len(files) <= cap:
        return 0

    def sort_key(path: Path) -> tuple[int, str]:
        # Prefer the authoritative in-record suppressedAt timestamp over file
        # mtime, which is clock-skew / touch-fragile.  Fall back to mtime only
        # when the field is absent or unparseable (e.g. legacy/malformed files).
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            suppressed_at = raw.get("delivery", {}).get("suppressedAt") if isinstance(raw, dict) else None
            if isinstance(suppressed_at, str):
                epoch_ns = int(datetime.fromisoformat(suppressed_at.replace("Z", "+00:00")).timestamp() * 1_000_000_000)
                return epoch_ns, str(path)
        except Exception:  # noqa: BLE001
            pass
        try:
            return path.stat().st_mtime_ns, str(path)
        except OSError:
            return 0, str(path)

    pruned = 0
    for path in sorted(files, key=sort_key)[: len(files) - cap]:
        try:
            path.unlink()
            pruned += 1
        except FileNotFoundError:
            continue
    if pruned:
        fsync_parent(paths["suppressed"] / ".prune-marker")
        append_dispatch_log(paths, {
            "type": "suppressed_pruned",
            "path": str(paths["suppressed"]),
            "maxFiles": cap,
            "pruned": pruned,
        })
    return pruned


def read_meta_state(paths: dict[str, Path]) -> dict[str, Any]:
    try:
        return read_json(paths["meta_state"])
    except Exception:
        return {}


def write_meta_state(paths: dict[str, Path], state: dict[str, Any]) -> None:
    atomic_write_json(paths["meta_state"], state)


def test_provenance_meta_event(paths: dict[str, Path], refused: int, window: int) -> dict[str, Any]:
    now = int(time.time())
    return {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "warning",
        "id": f"dispatcher-test-provenance-refused-{now}",
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": sys.platform,
        "instance": "bot-errors-dispatcher",
        "source": "test-provenance-refused",
        "summary": "BOT ERRORS dispatcher refused test-provenance events",
        "evidence": "\n".join([
            f"refused_events:{refused}",
            f"debounce_window_seconds:{window}",
            "disposition: originals retained in suppressed audit state",
            "reason: producer test-provenance event reached dispatcher backstop",
        ]),
        "process": {"pid": os.getpid()},
        "diagnostics": {"omitDispatchLogInMessage": True},
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }


def queue_test_provenance_meta_alert(paths: dict[str, Path], refused: int) -> int:
    if refused <= 0:
        return 0
    now = int(time.time())
    window = test_provenance_meta_window_seconds()
    state = read_meta_state(paths)
    last = int(state.get("testProvenanceMetaAlertAtEpoch") or 0)
    if last and now - last < window:
        append_dispatch_log(paths, {
            "type": "test_provenance_meta_debounced",
            "refused": refused,
            "windowSeconds": window,
        })
        return 0

    event = test_provenance_meta_event(paths, refused, window)
    path = outbox_path_for_event(event, paths)
    atomic_write_json(path, event)
    state["testProvenanceMetaAlertAtEpoch"] = now
    state["testProvenanceMetaAlertEventId"] = event["id"]
    write_meta_state(paths, state)
    append_dispatch_log(paths, {
        "type": "test_provenance_meta_queued",
        "eventId": event["id"],
        "refused": refused,
        "windowSeconds": window,
    })
    return 1


def suppress_test_provenance_events(paths: dict[str, Path]) -> tuple[int, int]:
    suppressed = 0
    for path in sorted(paths["outbox"].glob("*.json")):
        if not ready(path, paths["quarantine"]):
            continue
        try:
            event = read_json(path)
        except Exception:
            continue
        if not is_test_provenance_event(event):
            continue
        move_suppressed_event(
            path,
            paths,
            event,
            TEST_PROVENANCE_SUPPRESSION_REASON,
            "test_provenance_suppressed",
        )
        suppressed += 1
    alerted = queue_test_provenance_meta_alert(paths, suppressed)
    return suppressed, alerted


def ready(path: Path, quarantine_dir: Path) -> bool:
    try:
        event = read_json(path)
    except Exception as exc:
        quarantine_poison(path, quarantine_dir, f"invalid JSON before claim: {exc}")
        return False
    delivery = event.get("delivery") if isinstance(event.get("delivery"), dict) else {}
    next_attempt = int(delivery.get("nextAttemptAtEpoch") or 0)
    return next_attempt <= int(time.time())


def quarantine_poison(path: Path, quarantine_dir: Path, reason: str) -> Path:
    ensure_private_dir(quarantine_dir)
    dest = quarantine_dir / f"{path.name}.{int(time.time())}.{os.getpid()}.poison"
    try:
        shutil.move(str(path), str(dest))
    except FileNotFoundError:
        return dest
    meta = {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "critical",
        "id": f"poison-{int(time.time())}-{os.getpid()}",
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "instance": "bot-errors-dispatcher",
        "source": "poison-event-quarantine",
        "summary": "BOT ERRORS dispatcher quarantined an unreadable event",
        "evidence": f"source={path}; quarantine={dest}; reason={reason}",
        "diagnostics": {
            "logHints": ["journalctl --user -u bot-errors-dispatcher.service --since '30 minutes ago'"],
            "queue": str(state_root()),
        },
        "delivery": {"attempts": 0, "status": "meta"},
    }
    text = format_event(meta)
    direct_whatsapp = "not_attempted"
    email_status = "not_attempted"
    direct_error = None
    try:
        send_whatsapp(text)
        direct_whatsapp = "sent"
    except Exception as exc:
        direct_whatsapp = "failed"
        direct_error = str(exc)
        email_status = "accepted_unconfirmed" if email_fallback("BOT ERRORS poison event quarantine", text) else "failed"
    try:
        log_record = {
            "type": "quarantine",
            "sourcePath": str(path),
            "quarantinePath": str(dest),
            "reason": reason,
            "directWhatsapp": direct_whatsapp,
            "emailFallback": email_status,
        }
        if direct_error:
            log_record["directError"] = direct_error
        append_dispatch_log(state_paths(), log_record)
    except Exception:
        pass
    return dest


def writefail_dirs() -> list[Path]:
    candidates: list[Path] = []
    override = os.environ.get("BOT_ERRORS_WRITEFAIL_DIR")
    if override:
        candidates.append(Path(override))
    candidates.append(state_root() / "writefail")
    candidates.append(Path(os.environ.get("TMPDIR", "/tmp")) / "bot-errors-writefail")
    candidates.append(Path.home() / ".bot-errors-writefail")
    seen: set[str] = set()
    ordered: list[Path] = []
    for path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        ordered.append(path)
    return ordered


def event_has_incident_identity(event: dict[str, Any]) -> bool:
    return bool(event.get("machine") and event.get("instance") and (event.get("source") or event.get("alertSource")))


def event_created_identity(event: dict[str, Any]) -> str:
    return str(event.get("createdAt") or "")


def remember_known_event(index: dict[str, dict[str, Any]], event: dict[str, Any]) -> None:
    event_id = str(event.get("id") or "")
    if not event_id:
        return
    created_at = event_created_identity(event)
    entry = index.setdefault(event_id, {"unqualified": set(), "incidentKeys": {}})
    if event_has_incident_identity(event):
        incident_keys = entry.setdefault("incidentKeys", {})
        if isinstance(incident_keys, dict):
            key = incident_key(event)
            created_values = incident_keys.setdefault(key, set())
            if isinstance(created_values, set):
                created_values.add(created_at)
    else:
        unqualified = entry.setdefault("unqualified", set())
        if isinstance(unqualified, set):
            unqualified.add(created_at)


def created_matches(known_values: set[str], created_at: str) -> bool:
    return (not created_at) or (not known_values) or ("" in known_values) or (created_at in known_values)


def build_known_event_index(paths: dict[str, Path]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for key in ("outbox", "processing", "sent", "storm_collapsed", "suppressed", "quarantine"):
        directory = paths[key]
        if not directory.exists():
            continue
        for path in directory.glob("*"):
            if not path.is_file():
                continue
            try:
                existing = read_json(path)
            except Exception:
                continue
            remember_known_event(index, existing)
    return index


def event_already_known(
    event: dict[str, Any],
    paths: dict[str, Path],
    known_index: dict[str, dict[str, Any]] | None = None,
) -> bool:
    event_id = str(event.get("id") or "")
    if not event_id:
        return False
    index = known_index if known_index is not None else build_known_event_index(paths)
    entry = index.get(event_id)
    if not entry:
        return False
    created_at = event_created_identity(event)
    unqualified = entry.get("unqualified")
    unqualified_values = unqualified if isinstance(unqualified, set) else set()
    incident_keys = entry.get("incidentKeys")
    incident_key_values = incident_keys if isinstance(incident_keys, dict) else {}
    if event_has_incident_identity(event):
        if created_matches(unqualified_values, created_at):
            return True
        known_created_values = incident_key_values.get(incident_key(event))
        return isinstance(known_created_values, set) and created_matches(known_created_values, created_at)
    if created_matches(unqualified_values, created_at):
        return True
    return any(isinstance(values, set) and created_matches(values, created_at) for values in incident_key_values.values())


def outbox_path_for_event(event: dict[str, Any], paths: dict[str, Path]) -> Path:
    created = str(event.get("createdAt") or now_iso()).replace("-", "").replace(":", "")
    instance = safe_segment(str(event.get("instance") or "unknown"))
    source = safe_segment(str(event.get("source") or "unknown"))
    event_id = safe_segment(str(event.get("id") or f"recovered-{int(time.time())}-{os.getpid()}"))
    return safe_child_path(paths["outbox"], f"{created}.{instance}.{source}.{event_id}.json")


def move_writefail(path: Path, target_dir: Path, suffix: str) -> Path:
    target = safe_child_path(target_dir, f"{path.name}.{int(time.time())}.{suffix}")
    shutil.move(str(path), str(target))
    fsync_parent(target)
    try:
        target.chmod(0o600)
    except OSError:
        pass
    return target


def recover_writefail_breadcrumbs(paths: dict[str, Path], limit: int = 25) -> int:
    recovered = 0
    scanned = 0
    known_index = build_known_event_index(paths)
    for base in writefail_dirs():
        if not base.exists():
            continue
        for path in sorted(base.glob("*.writefail")):
            if scanned >= limit:
                return recovered
            scanned += 1
            try:
                crumb = read_json(path)
                if crumb.get("kind") != "outbox_write_failure":
                    raise ValueError("writefail breadcrumb kind is not outbox_write_failure")
                event = crumb.get("event")
                if not isinstance(event, dict):
                    raise ValueError("writefail breadcrumb missing event object")
                event_id = str(event.get("id") or "")
                if event_already_known(event, paths, known_index):
                    duplicate = move_writefail(path, paths["writefail_recovered"], "duplicate")
                    append_dispatch_log(paths, {
                        "type": "writefail_duplicate",
                        "eventId": event_id,
                        "breadcrumb": str(path),
                        "path": str(duplicate),
                    })
                    continue
                diagnostics = event.setdefault("diagnostics", {})
                if not isinstance(diagnostics, dict):
                    diagnostics = {}
                    event["diagnostics"] = diagnostics
                diagnostics["writefailRecovery"] = {
                    "breadcrumb": str(path),
                    "failedTarget": crumb.get("failedTarget"),
                    "harvest": crumb.get("harvest") if isinstance(crumb.get("harvest"), dict) else None,
                    "reason": crumb.get("reason"),
                    "recordedAt": crumb.get("recordedAt"),
                    "recoveredAt": now_iso(),
                }
                log_hints = diagnostics.get("logHints")
                if isinstance(log_hints, list):
                    log_hints.append(str(path))
                else:
                    diagnostics["logHints"] = [str(path)]
                reset_delivery(event)
                outbox_path = outbox_path_for_event(event, paths)
                try:
                    atomic_write_json(outbox_path, event)
                except Exception as exc:  # noqa: BLE001 - keep breadcrumb for a later retry.
                    append_dispatch_log(paths, {
                        "type": "writefail_requeue_failed",
                        "eventId": event_id,
                        "breadcrumb": str(path),
                        "outboxPath": str(outbox_path),
                        "reason": str(exc),
                    })
                    return recovered
                remember_known_event(known_index, event)
                recovered_path = move_writefail(path, paths["writefail_recovered"], "recovered")
                append_dispatch_log(paths, {
                    "type": "writefail_recovered",
                    "eventId": event_id,
                    "breadcrumb": str(path),
                    "path": str(recovered_path),
                    "outboxPath": str(outbox_path),
                })
                recovered += 1
            except Exception as exc:  # noqa: BLE001 - one bad breadcrumb must not block dispatch.
                try:
                    quarantined = move_writefail(path, paths["writefail_quarantine"], "poison")
                    append_dispatch_log(paths, {
                        "type": "writefail_quarantine",
                        "breadcrumb": str(path),
                        "path": str(quarantined),
                        "reason": str(exc),
                    })
                except Exception:
                    append_dispatch_log(paths, {
                        "type": "writefail_recovery_failed",
                        "breadcrumb": str(path),
                        "reason": str(exc),
                    })
    return recovered


def claim(path: Path, processing_dir: Path) -> Path:
    dest = safe_child_path(processing_dir, f"{path.name}.{os.getpid()}.processing", 240)
    os.replace(path, dest)
    fsync_parent(dest)
    return dest


def original_name_from_processing(path: Path) -> str:
    name = path.name
    marker = ".json."
    if marker in name and name.endswith(".processing"):
        return name.split(marker, 1)[0] + ".json"
    if name.endswith(".processing"):
        return name[: -len(".processing")]
    return name


def reclaim_processing(paths: dict[str, Path]) -> int:
    reclaimed = 0
    for path in sorted(paths["processing"].glob("*")):
        if not path.is_file():
            continue
        target = safe_child_path(paths["outbox"], original_name_from_processing(path))
        os.replace(path, target)
        fsync_parent(target)
        append_dispatch_log(paths, {"type": "reclaim", "from": str(path), "to": str(target)})
        reclaimed += 1
    return reclaimed


def record_state(paths: dict[str, Path], **updates: Any) -> None:
    counts = {
        "outbox": len(list(paths["outbox"].glob("*.json"))),
        "processing": len(list(paths["processing"].glob("*"))),
        "sent": len(list(paths["sent"].glob("*"))),
        "stormCollapsed": len(list(paths["storm_collapsed"].glob("*"))),
        "stormManifests": len(list(paths["storm_manifests"].glob("*"))),
        "suppressed": len(list(paths["suppressed"].glob("*"))),
        "quarantine": len(list(paths["quarantine"].glob("*"))),
        "writefail": sum(len(list(path.glob("*.writefail"))) for path in writefail_dirs() if path.exists()),
        "writefailRecovered": len(list(paths["writefail_recovered"].glob("*"))),
        "writefailQuarantine": len(list(paths["writefail_quarantine"].glob("*"))),
    }
    state = {
        "updatedAt": now_iso(),
        "pid": os.getpid(),
        "machine": socket.gethostname(),
        "counts": counts,
        **updates,
    }
    atomic_write_json(paths["state"], state)


def process_one(path: Path, paths: dict[str, Path]) -> tuple[bool, str]:
    claimed = claim(path, paths["processing"])
    try:
        event = read_json(claimed)
    except Exception as exc:
        quarantine_poison(claimed, paths["quarantine"], f"invalid JSON after claim: {exc}")
        return False, "poison"

    # --- Test-leak defense-in-depth (B2) ---
    # Drop test-fixture events BEFORE any delivery, incident-state load, or
    # diagnostics injection.  Running first on the as-claimed event keeps
    # matchedPattern attribution honest (it reflects only the payload's own
    # fields, never our injected dispatchLog path) and avoids a wasted
    # load_incident_state read for events we are about to discard.
    matched_pattern = matched_test_leak_pattern(event)
    if matched_pattern is not None:
        testleak_path = archive_path(paths["testleak"], path.name, "testleak", event)
        os.replace(claimed, testleak_path)
        append_dispatch_log(paths, {
            "type": "test_leak_dropped",
            "eventId": event.get("id"),
            "source": event.get("source"),
            "path": str(testleak_path),
            "matchedPattern": matched_pattern,
        })
        return False, "test_leak"

    diagnostics = event.setdefault("diagnostics", {})
    if isinstance(diagnostics, dict) and not omit_dispatch_log_in_message(event):
        diagnostics["dispatchLog"] = str(paths["logs"] / "dispatch.jsonl")
    event = mark_attempt(event)
    atomic_write_json(claimed, event)
    incident_state = load_incident_state(paths)

    if str(event.get("source") or "") == "daily-health" and not is_incident_clear(event):
        recovered = close_recovered_daily_health_incidents(event, incident_state)
        if recovered:
            diagnostics = event.setdefault("diagnostics", {})
            if isinstance(diagnostics, dict):
                diagnostics["sourceSpecificRecoveredIncidents"] = recovered
    suppress_reason = should_suppress_send(event, incident_state)
    if suppress_reason:
        event = mark_suppressed(event, suppress_reason)
        atomic_write_json(claimed, event)
        save_incident_state(paths, incident_state)
        suppressed_path = archive_path(paths["suppressed"], path.name, "suppressed", event)
        os.replace(claimed, suppressed_path)
        append_dispatch_log(paths, {
            "type": "suppressed",
            "eventId": event.get("id"),
            "path": str(suppressed_path),
            "reason": suppress_reason,
            "source": event.get("source"),
            "severity": event.get("severity"),
            "attempts": event.get("delivery", {}).get("attempts") if isinstance(event.get("delivery"), dict) else None,
        })
        return True, "suppressed"

    append_clear_context(event, incident_state)
    text = format_event(event)
    try:
        send_whatsapp(text)
    except Exception as exc:
        event = mark_failure(event, str(exc))
        attempts = int(event.get("delivery", {}).get("attempts") or 0)
        delivery = event.get("delivery") if isinstance(event.get("delivery"), dict) else {}

        # --- F5: email fallback (attempts >= 3) with unavailability tracking ---
        email_status = "not_attempted"
        if attempts >= 3:
            fallback_path = Path(EMAIL_FALLBACK)
            if not fallback_path.exists() or not os.access(fallback_path, os.X_OK):
                # Fallback script is missing or non-executable — record unavailability
                email_status = "failed"
                if isinstance(delivery, dict):
                    delivery["email_fallback_unavailable"] = True
            else:
                email_status = (
                    "accepted_unconfirmed"
                    if email_fallback(f"BOT ERRORS delivery failing: {event.get('summary', 'unknown')}", text)
                    else "failed"
                )
        if isinstance(delivery, dict):
            delivery["emailFallback"] = email_status
            if email_status != "not_attempted":
                delivery["emailFallbackAt"] = now_iso()

        # --- F5: dead-letter if attempt cap exhausted ---
        if next_backoff(attempts) is None:
            dead_path = move_to_dead_letter(claimed, paths, event, original_name_from_processing(claimed))
            append_dispatch_log(paths, {
                "type": "dead_lettered",
                "eventId": event.get("id"),
                "path": str(dead_path),
                "attempts": attempts,
                "error": str(exc),
            })
            return False, f"dead_letter; attempts={attempts}; {exc}"

        atomic_write_json(claimed, event)
        retry_path = safe_child_path(paths["outbox"], path.name)
        os.replace(claimed, retry_path)
        fsync_parent(retry_path)
        append_dispatch_log(paths, {
            "type": "send_failed",
            "eventId": event.get("id"),
            "path": str(retry_path),
            "attempts": attempts,
            "error": str(exc),
            "emailFallback": email_status,
        })
        return False, f"{exc}; email_fallback={email_status}"

    mark_incident_sent(event, incident_state)
    save_incident_state(paths, incident_state)
    event = mark_sent(event)
    atomic_write_json(claimed, event)
    sent_path = archive_path(paths["sent"], path.name, "sent", event)
    os.replace(claimed, sent_path)
    append_dispatch_log(paths, {
        "type": "sent",
        "eventId": event.get("id"),
        "path": str(sent_path),
        "attempts": event.get("delivery", {}).get("attempts") if isinstance(event.get("delivery"), dict) else None,
    })
    return True, "sent"


def run_once(max_events: int) -> dict[str, Any]:
    paths = setup_dirs()
    lock_path = paths["locks"] / "dispatcher.lock"
    with lock_path.open("w", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        writefail_recovered = recover_writefail_breadcrumbs(paths)
        reclaimed = reclaim_processing(paths)
        test_provenance_suppressed, test_provenance_meta_alerted = suppress_test_provenance_events(paths)
        recovery_deduped = suppress_ready_recovery_duplicates(paths)
        storm_collapsed = collapse_ready_storms(paths)
        processed = 0
        sent = 0
        suppressed = test_provenance_suppressed + recovery_deduped
        failed = 0
        test_leak_dropped = 0
        last_error = None
        touched_incident_keys: set[str] = set()
        for path in sorted(paths["outbox"].glob("*.json")):
            if processed >= max_events:
                break
            if not ready(path, paths["quarantine"]):
                continue
            try:
                preview = read_json(path)
                if is_incident_alert(preview) or is_incident_clear(preview):
                    touched_incident_keys.add(incident_key(preview))
            except Exception:
                pass
            processed += 1
            ok, detail = process_one(path, paths)
            if detail == "test_leak":
                test_leak_dropped += 1
            elif ok:
                if detail == "suppressed":
                    suppressed += 1
                else:
                    sent += 1
            else:
                failed += 1
                last_error = detail
        stale_renotified, stale_failed, stale_error = sweep_stale_incidents(paths, touched_incident_keys)
        if stale_failed:
            failed += stale_failed
            last_error = stale_error

        # --- F5: dead-letter meta-alert (at most once per hour when dir non-empty) ---
        dead_letter_meta_alerted = queue_dead_letter_meta_alert(paths, int(time.time()))

        # Daily test-leak summary marker (at most once per UTC date per day).
        if test_leak_dropped > 0:
            incident_state = load_incident_state(paths)
            today = time.strftime("%Y-%m-%d", time.gmtime())
            emitted = record_test_leak_daily_marker(incident_state, today, test_leak_dropped)
            save_incident_state(paths, incident_state)
            if emitted:
                append_dispatch_log(paths, {
                    "type": "test_leak_daily_summary",
                    "date": today,
                    "count": test_leak_dropped,
                    "severity": "info",
                    "source": "dispatcher",
                })

        suppressed_pruned = prune_suppressed(paths)

        record_state(
            paths,
            lastRunAt=now_iso(),
            processed=processed,
            sent=sent,
            suppressed=suppressed,
            staleRenotified=stale_renotified,
            staleFailed=stale_failed,
            failed=failed,
            testLeakDropped=test_leak_dropped,
            reclaimed=reclaimed,
            writefailRecovered=writefail_recovered,
            testProvenanceSuppressed=test_provenance_suppressed,
            testProvenanceMetaAlerted=test_provenance_meta_alerted,
            recoveryDeduped=recovery_deduped,
            stormCollapsed=storm_collapsed,
            suppressedPruned=suppressed_pruned,
            deadLetterMetaAlerted=dead_letter_meta_alerted,
            lastError=last_error,
        )
        return {
            "processed": processed,
            "sent": sent,
            "suppressed": suppressed,
            "staleRenotified": stale_renotified,
            "staleFailed": stale_failed,
            "failed": failed,
            "testLeakDropped": test_leak_dropped,
            "reclaimed": reclaimed,
            "writefailRecovered": writefail_recovered,
            "testProvenanceSuppressed": test_provenance_suppressed,
            "testProvenanceMetaAlerted": test_provenance_meta_alerted,
            "recoveryDeduped": recovery_deduped,
            "stormCollapsed": storm_collapsed,
            "suppressedPruned": suppressed_pruned,
            "deadLetterMetaAlerted": dead_letter_meta_alerted,
            "lastError": last_error,
        }


def run_daemon(interval: int, max_events: int) -> None:
    while True:
        try:
            result = run_once(max_events)
            print(json.dumps({"time": now_iso(), **result}), flush=True)
        except BlockingIOError:
            print(json.dumps({"time": now_iso(), "skipped": "locked"}), flush=True)
        except Exception as exc:
            paths = setup_dirs()
            record_state(paths, lastRunAt=now_iso(), processed=0, sent=0, failed=1, lastError=str(exc))
            print(json.dumps({"time": now_iso(), "error": str(exc)}), flush=True)
        time.sleep(interval)


def main() -> int:
    parser = argparse.ArgumentParser(description="Drain local BOT ERRORS outbox")
    parser.add_argument("--once", action="store_true", help="process ready events once and exit")
    parser.add_argument("--daemon", action="store_true", help="run continuously")
    parser.add_argument("--interval", type=int, default=30)
    parser.add_argument("--max-events", type=int, default=25)
    parser.add_argument("--format-event", help="format one event JSON file without sending")
    args = parser.parse_args()

    if args.format_event:
        print(format_event(read_json(Path(args.format_event))))
        return 0

    if args.daemon:
        run_daemon(args.interval, args.max_events)
        return 0

    result = run_once(args.max_events)
    print(json.dumps(result, sort_keys=True))
    return 1 if result.get("failed") else 0


if __name__ == "__main__":
    sys.exit(main())
