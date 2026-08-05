#!/usr/bin/env python3
"""Independent heartbeat watchdog for BOT ERRORS monitoring components."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.bot_errors_daily_health import daily_health_host_from_payload, normalize_hub_host
from lib.bot_errors_envelope import new_event_fields
from lib.bot_errors_redaction import redact_bot_errors_text, redact_json_value as redact_shared_json_value
from lib.bot_errors_roster import RosterError, load_roster  # noqa: E402
from lib.queue_age import parse_queue_threshold, scan_directory, threshold_met
from lib.controller_log import (
    ControllerLogContext,
    controller_cycle,
    metadata_only_controller_details,
    write_controller_log,
)
from lib.durable_json import (
    JsonVersion,
    durable_json_target,
    observe_json,
    operation_id,
    publish_event_json,
    publish_state_json,
    require_advance,
)


DEFAULT_CHECKS = "q_loop,dispatcher,collector,daily_health,queue_backlog,local_services,local_instance_health,browser_debug"

# Canonical registry of all recognized watchdog check identifiers (#2465).
# Every name here MUST have a corresponding branch in collect_problems() AND
# an entry in active_reconcile_prefixes(). The drift-guard test enforces this
# alignment so a future check added to only one location fails CI.
KNOWN_WATCHDOG_CHECKS: frozenset[str] = frozenset({
    "q_loop",
    "dispatcher",
    "collector",
    "daily_health",
    "queue_backlog",
    "local_services",
    "local_instance_health",
    "fleet_sentinel",
    "collector_roster",
    "browser_debug",
})

REPO_ROOT = Path(__file__).resolve().parents[2]
TERMINAL_AUTH_FAILURE_CLASSES = {"pairing_required", "serverside_logout_irreversible"}
CONTROLLER_LOG_CONTEXT = ControllerLogContext("heartbeat_watchdog")


class QueueDirectoryError(RuntimeError):
    pass


class DailyHealthEventError(RuntimeError):
    pass


def positive_env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a positive integer") from exc
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def positive_env_int_or_default(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def watchdog_renotify_seconds() -> int:
    return positive_env_int("BOT_ERRORS_WATCHDOG_RENOTIFY_SECONDS", 6 * 60 * 60)


def watchdog_escalate_seconds() -> int:
    return positive_env_int("BOT_ERRORS_WATCHDOG_ESCALATE_SECONDS", 24 * 60 * 60)


def watchdog_escalate_suppressed() -> int:
    return positive_env_int("BOT_ERRORS_WATCHDOG_ESCALATE_SUPPRESSED", 72)


def watchdog_recovery_confirmations() -> int:
    return positive_env_int("BOT_ERRORS_WATCHDOG_RECOVERY_CONFIRMATIONS", 2)


def watchdog_stale_confirmations() -> int:
    return positive_env_int("BOT_ERRORS_WATCHDOG_STALE_CONFIRMATIONS", 1)


def watchdog_flap_rearm_seconds() -> int:
    return positive_env_int("BOT_ERRORS_WATCHDOG_FLAP_REARM_SECONDS", 6 * 60 * 60)


def max_awaiting_q_age_seconds() -> int:
    return positive_env_int_or_default("BOT_ERRORS_MAX_AWAITING_Q_AGE", 20 * 60)


# Incident key for q-loop usage-window capacity events. Kept distinct from the
# genuine-failure key ("q_loop:supervisor") so capacity is never paged critical.
Q_LOOP_CAPACITY_KEY = "q_loop:supervisor:capacity"
Q_LOOP_AWAITING_Q_KEY = "q_loop:awaiting_q"
BROWSER_DEBUG_PREFIX = "browser_debug:"
BROWSER_DEBUG_PROBE_KEY = f"{BROWSER_DEBUG_PREFIX}probe"

# q-loop "q_unavailable_<reason>" phases that are self-recovering usage/rate
# capacity conditions (claude-cli usage-window caps), NOT supervisor failures.
# The only remediation is to wait for the usage window to reset, so paging them
# as critical supervisor failures is the broken-alert anti-pattern. Substring
# match keeps this robust to reason variants (e.g. "session_limit_5h").
_Q_LOOP_CAPACITY_REASON_TOKENS = (
    "session_limit",
    "rate_limit",
    "usage_limit",
    "usage_window",
    "quota",
)


def is_capacity_supervisor_reason(reason: str) -> bool:
    """True when a q-loop unavailable reason is a self-recovering capacity cap.

    Capacity caps recover on their own when the usage window resets; they are
    not supervisor failures and must not escalate to a paging critical alert.
    """
    candidate = (reason or "").lower()
    if not candidate:
        return False
    return any(token in candidate for token in _Q_LOOP_CAPACITY_REASON_TOKENS)


def is_capacity_incident_key(key: str) -> bool:
    """True for incident keys that represent self-recovering capacity events."""
    return key == Q_LOOP_CAPACITY_KEY


def is_browser_debug_incident_key(key: str) -> bool:
    return key.startswith(BROWSER_DEBUG_PREFIX)


def is_nonpaging_incident_key(key: str) -> bool:
    return is_capacity_incident_key(key) or is_browser_debug_incident_key(key)


def incident_severity(key: str, escalated: bool) -> str:
    """Severity for an incident, capping non-paging signals at ``warning``.

    Genuine failures escalate to ``critical`` when ``escalated`` is set, but a
    capacity event or resource-observation warning must never page critical
    regardless of age or suppression count.
    """
    if is_nonpaging_incident_key(key) or key == Q_LOOP_AWAITING_Q_KEY:
        return "warning"
    return "critical" if escalated else "warning"


def open_incident_summary(key: str) -> str:
    if is_capacity_incident_key(key):
        return f"BOT ERRORS heartbeat watchdog capacity: {key}"
    if key == BROWSER_DEBUG_PROBE_KEY:
        return f"BOT ERRORS browser debug visibility degraded: {key}"
    if is_browser_debug_incident_key(key):
        return f"BOT ERRORS browser debug session unattended: {key}"
    return f"BOT ERRORS heartbeat watchdog stale: {key}"


def incident_requested_action(key: str, *, persistent: bool = False) -> str:
    if is_capacity_incident_key(key):
        return "requested_action=No action required; Q is at usage-window capacity and self-recovers when the window resets."
    if key == BROWSER_DEBUG_PROBE_KEY:
        return "requested_action=Restore controller-connection visibility before classifying or terminating browser debug sessions."
    if is_browser_debug_incident_key(key):
        qualifier = "persistent " if persistent else ""
        return (
            f"requested_action=Inspect the {qualifier}unattended browser debug tree; close only the confirmed root session, "
            "preserve its profile, and verify memory recovery."
        )
    if persistent:
        return "requested_action=Q investigate persistent monitor failure; this alert bypasses duplicate suppression by design."
    return "requested_action=Q investigate the silent monitor and restore cadence."


def validate_thresholds() -> None:
    watchdog_renotify_seconds()
    watchdog_escalate_seconds()
    watchdog_escalate_suppressed()
    watchdog_recovery_confirmations()
    watchdog_stale_confirmations()
    browser_debug_min_age_seconds()
    browser_debug_min_rss_mb()
    watchdog_flap_rearm_seconds()
    validate_queue_thresholds()


def validate_queue_thresholds() -> None:
    """Validate queue backlog thresholds at startup (fail-closed).  See #2460.

    Invalid thresholds (negative, non-finite, non-integral) raise ValueError
    so the script exits with a clear diagnostic instead of silently weakening
    monitoring.
    """
    pairs = [
        ("BOT_ERRORS_WATCHDOG_OUTBOX_CRITICAL_COUNT", "BOT_ERRORS_OUTBOX_CRITICAL_COUNT"),
        ("BOT_ERRORS_WATCHDOG_OUTBOX_CRITICAL_OLDEST_SECONDS", "BOT_ERRORS_OUTBOX_CRITICAL_OLDEST_SECONDS"),
        ("BOT_ERRORS_WATCHDOG_PROCESSING_CRITICAL_COUNT", "BOT_ERRORS_PROCESSING_CRITICAL_COUNT"),
        ("BOT_ERRORS_WATCHDOG_PROCESSING_CRITICAL_OLDEST_SECONDS", "BOT_ERRORS_PROCESSING_CRITICAL_OLDEST_SECONDS"),
        ("BOT_ERRORS_WATCHDOG_WRITEFAIL_CRITICAL_COUNT", "BOT_ERRORS_WRITEFAIL_CRITICAL_COUNT"),
        ("BOT_ERRORS_WATCHDOG_WRITEFAIL_CRITICAL_OLDEST_SECONDS", "BOT_ERRORS_WRITEFAIL_CRITICAL_OLDEST_SECONDS"),
    ]
    for primary, fallback in pairs:
        parse_queue_threshold(fallback, 0)
        parse_queue_threshold(primary, 0)


def now_epoch() -> int:
    override = os.environ.get("BOT_ERRORS_DRY_NOW")
    if override is not None:
        try:
            return int(override)
        except (TypeError, ValueError, OverflowError):
            pass
    return int(time.time())


def now_iso(ts: int | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_epoch() if ts is None else ts))


def finite_epoch(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return int(value)


def parse_iso_epoch(value: Any) -> int | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def state_root() -> Path:
    return Path(os.environ.get("BOT_ERRORS_STATE_DIR", Path.home() / ".local/state/bot-errors"))


def q_loop_state_path() -> Path:
    explicit = os.environ.get("BOT_ERRORS_Q_LOOP_STATE")
    if explicit:
        return Path(explicit)
    root = Path(os.environ.get("BOT_ERRORS_Q_LOOP_STATE_DIR", Path.home() / ".local/state/bot-errors-q-loop"))
    return root / "state.json"


def watchdog_state_path() -> Path:
    return state_root() / "heartbeat-watchdog-state.json"


def fleet_sentinel_heartbeat_path() -> Path:
    raw = os.environ.get("BOT_ERRORS_FLEET_SENTINEL_HEARTBEAT", "").strip()
    if raw:
        return Path(raw).expanduser()
    return state_root() / "fleet-sentinel" / "sentinel-heartbeat.json"


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


def _durable_target(path: Path):
    ensure_private_dir(path.parent)
    return durable_json_target(
        trusted_root=path.parent.resolve(strict=True),
        relative_path=path.name,
    )


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


def redact_watchdog_text(value: Any) -> str:
    return redact_bot_errors_text(value, credential_path_marker="[REDACTED_CREDENTIAL_PATH]")


def redacted_watchdog_payload(value: Any) -> Any:
    return redact_shared_json_value(value, redact_watchdog_text)


def persist_controller_log_health(record: dict[str, Any]) -> None:
    target = _durable_target(
        state_root() / "controller-log-health" / "heartbeat-watchdog.json"
    )
    observation = observe_json(target)
    publication_operation = operation_id(
        target,
        record,
        component="heartbeat_watchdog.controller_log_health",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        record,
        component="heartbeat_watchdog.controller_log_health",
        operation_id=publication_operation,
        expected=observation.version,
        generation=(observation.version.generation or 0) + 1,
    )
    if not publication.advance_allowed:
        require_advance(publication)


def controller_log_fallback(line: str) -> None:
    print(line, file=sys.stderr, flush=True)


def append_log(
    kind: str,
    payload: dict[str, Any],
    *,
    level: str = "info",
    outcome: str = "observed",
) -> str:
    path = state_root() / "logs" / "heartbeat-watchdog.jsonl"
    return write_controller_log(
        context=CONTROLLER_LOG_CONTEXT,
        record_kind=kind,
        level=level,
        outcome=outcome,
        durability_class="diagnostic_best_effort",
        details=metadata_only_controller_details(redacted_watchdog_payload(payload)),
        append_record=lambda record: append_private_jsonl(path, record),
        persist_health=persist_controller_log_health,
        emit_fallback=controller_log_fallback,
    )


def critical_file_problem(path: Path) -> str | None:
    try:
        st = path.lstat()
    except FileNotFoundError:
        return f"missing {path}"
    except OSError as exc:
        return f"failed to inspect critical file {path}: {type(exc).__name__}: {exc}"
    if path.is_symlink():
        return f"refusing to trust symlinked critical file {path}"
    if not os.path.isfile(path):
        return f"refusing to trust non-regular critical file {path}"
    mode = st.st_mode & 0o777
    if mode & 0o077:
        return f"refusing to trust non-private critical file {path} mode={mode:o}"
    try:
        parent_stat = path.parent.lstat()
    except FileNotFoundError:
        return f"missing critical file parent {path.parent}"
    except OSError as exc:
        return f"failed to inspect critical file parent {path.parent}: {type(exc).__name__}: {exc}"
    if path.parent.is_symlink():
        return f"refusing to trust critical file under symlinked directory {path.parent}"
    if not os.path.isdir(path.parent):
        return f"refusing to trust critical file under non-directory parent {path.parent}"
    parent_mode = parent_stat.st_mode & 0o777
    if parent_mode & 0o077:
        return f"refusing to trust critical file in non-private directory {path.parent} mode={parent_mode:o}"
    return None


def load_json(path: Path, *, require_private: bool = False) -> dict[str, Any] | None:
    if require_private and critical_file_problem(path) is not None:
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def load_state() -> dict[str, Any]:
    path = watchdog_state_path()
    data = load_json(path, require_private=True)
    if data is None:
        data = {"version": 1, "open": {}}
    for section in ("open", "pendingStale", "recentlyRecovered"):
        if not isinstance(data.get(section), dict):
            data[section] = {}
    return data


def save_state(state: dict[str, Any]) -> None:
    redacted_state = redacted_watchdog_payload(state)
    redacted_state["updatedAt"] = now_iso()
    target = _durable_target(watchdog_state_path())
    observation = observe_json(target)
    publication_operation = operation_id(
        target,
        redacted_state,
        component="heartbeat_watchdog.state",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        redacted_state,
        component="heartbeat_watchdog.state",
        operation_id=publication_operation,
        expected=observation.version,
        generation=(observation.version.generation or 0) + 1,
    )
    require_advance(publication)


def outbox_event(
    summary: str,
    evidence: str,
    severity: str,
    source_key: str,
    event_type: str = "alert",
    force_notify: bool = False,
) -> Path:
    root = state_root()
    outbox = Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", root / "outbox"))
    ensure_private_dir(root)
    ensure_private_dir(outbox)
    current = now_epoch()
    safe_summary = redact_watchdog_text(summary)
    safe_evidence = redact_watchdog_text(evidence)
    event_id = f"heartbeat-watchdog-{re.sub(r'[^A-Za-z0-9_.:-]+', '_', source_key).replace(':', '-')}-{event_type}-{current}"
    envelope_event_type = "observation" if event_type == "alert" and severity == "info" else event_type
    event = {
        **new_event_fields(envelope_event_type, severity),
        "id": event_id,
        "createdAt": now_iso(current),
        "machine": socket.gethostname(),
        "platform": sys.platform,
        "instance": "bot-errors-heartbeat-watchdog",
        "source": "heartbeat-watchdog",
        "alertSource": source_key,
        "summary": safe_summary,
        "evidence": safe_evidence,
        "process": {"pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv},
        "diagnostics": {
            "logHints": [
                str(state_root() / "logs/heartbeat-watchdog.jsonl"),
                str(watchdog_state_path()),
            ],
            "queue": str(outbox),
        },
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    if force_notify:
        event["diagnostics"]["forceNotify"] = True
        event["diagnostics"]["forceNotifyLevel"] = "escalated" if "escalated=true" in safe_evidence else "still_open"
    path = outbox / f"{event['createdAt'].replace(':', '').replace('-', '')}.{event_id}.json"
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        event,
        component="heartbeat_watchdog.outbox_event",
        predecessor=absent,
    )
    publication = publish_event_json(
        target,
        event,
        component="heartbeat_watchdog.outbox_event",
        operation_id=publication_operation,
    )
    require_advance(publication)
    return path


def json_updated_age(path: Path, key: str = "updated_at") -> tuple[int | None, str]:
    current = now_epoch()
    problem = critical_file_problem(path)
    if problem is not None:
        return None, problem
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        return None, f"failed to read {path}: {type(exc).__name__}: {exc}"
    try:
        data = json.loads(text)
    except Exception as exc:
        return None, f"invalid JSON in {path}: {type(exc).__name__}: {exc}"
    if not isinstance(data, dict):
        return None, f"invalid JSON object in {path}: {type(data).__name__}"
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None, f"missing numeric {key} in {path}"
    updated = finite_epoch(value)
    if updated is None:
        return None, f"non-finite {key} in {path}: value={value}"
    if updated > current:
        return None, f"future {key} in {path}: value={updated} now={current} future_by_seconds={updated - current}"
    return max(0, current - updated), f"{path} {key}={updated}"


def file_age(path: Path) -> tuple[int | None, str]:
    problem = critical_file_problem(path)
    if problem is not None:
        return None, problem
    try:
        mtime = int(path.stat().st_mtime)
    except OSError as exc:
        return None, f"failed to stat {path}: {type(exc).__name__}: {exc}"
    current = now_epoch()
    if mtime > current:
        return None, f"future mtime for {path}: mtime={mtime} now={current} future_by_seconds={mtime - current}"
    return max(0, current - mtime), f"{path} mtime={mtime}"


def fleet_sentinel_age(path: Path) -> tuple[int | None, str]:
    problem = critical_file_problem(path)
    if problem is not None:
        return None, problem
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        return None, f"failed to read {path}: {type(exc).__name__}: {exc}"
    try:
        data = json.loads(text)
    except Exception as exc:
        return None, f"invalid JSON in {path}: {type(exc).__name__}: {exc}"
    if not isinstance(data, dict):
        return None, f"invalid JSON object in {path}: {type(data).__name__}"
    if data.get("kind") != "bot-errors-sentinel-heartbeat":
        return None, f"unexpected fleet sentinel heartbeat kind={data.get('kind')!r} in {path}"
    checked_at = parse_iso_epoch(data.get("checkedAt"))
    if checked_at is None:
        return None, f"missing parseable checkedAt in {path}"
    current = now_epoch()
    if checked_at > current:
        return None, (
            f"future checkedAt in {path}: checkedAt={data.get('checkedAt')} "
            f"epoch={checked_at} now={current} future_by_seconds={checked_at - current}"
        )
    return max(0, current - checked_at), (
        f"{path} checkedAt={data.get('checkedAt')} healthy={data.get('healthy')} "
        f"fleetAction={data.get('fleetAction')} hostCount={data.get('hostCount')}"
    )


def _readable_fleet_sentinel_heartbeat(path: Path) -> dict[str, Any] | None:
    if critical_file_problem(path) is not None:
        return None
    data = load_json(path)
    if not isinstance(data, dict) or data.get("kind") != "bot-errors-sentinel-heartbeat":
        return None
    return data


def fleet_sentinel_roster_problem(path: Path) -> str | None:
    """Independently verify the sentinel heartbeat is bound to the intended
    roster (#1875).

    The age/deadman check (``fleet_sentinel_age``) owns a missing, unreadable, or
    wrong-kind heartbeat, so this returns ``None`` for those and only evaluates a
    readable, current-kind snapshot. It re-derives the expected roster digest and
    count directly from disk (not from the value the sentinel declared) and
    rejects a roster-blind, zero/truncated, wrong-manifest, or incompletely
    observed snapshot as not-green.
    """
    data = _readable_fleet_sentinel_heartbeat(path)
    if data is None:
        return None
    try:
        _roster_data, inventory = load_roster()
    except RosterError as exc:
        return f"fleet sentinel roster unreadable for independent check: {exc}"
    independent_digest = str(inventory["digest"])
    independent_expected = int(inventory["expectedHostCount"])
    declared_digest = data.get("rosterDigest")
    declared_expected = data.get("expectedHostCount")
    declared_observed = data.get("observedHostCount")
    declared_unknown = data.get("unknownHostCount")
    # 1. Roster-blind: the heartbeat carries no roster binding at all.
    if not isinstance(declared_digest, str) or not declared_digest:
        return (
            "fleet sentinel heartbeat is roster-blind: no rosterDigest bound; "
            f"independent roster expects {independent_expected} hosts "
            f"(digest {independent_digest[:12]})"
        )
    # 2. Zero / truncated roster.
    if not isinstance(declared_expected, int) or isinstance(declared_expected, bool) or declared_expected <= 0:
        return (
            "fleet sentinel heartbeat declares zero/no expected hosts: "
            f"expectedHostCount={declared_expected!r}; independent roster expects {independent_expected}"
        )
    # 3. Digest mismatch: wrong manifest / stale / truncated roster.
    if declared_digest != independent_digest:
        return (
            "fleet sentinel roster digest mismatch: "
            f"heartbeat_digest={declared_digest[:12]} independent_digest={independent_digest[:12]} "
            f"heartbeat_expected_hosts={declared_expected} independent_expected_hosts={independent_expected}"
        )
    # 4. Count mismatch against the independently-loaded roster.
    if declared_expected != independent_expected:
        return (
            "fleet sentinel expected-host count mismatch: "
            f"heartbeat={declared_expected} independent={independent_expected}"
        )
    # 5. Accounting gap: observed + unknown must account for every expected host.
    # A shortfall means the snapshot dropped roster members entirely. This is
    # robust to a heartbeat-only fleet (where every host may legitimately be
    # unknown/unprobed) because it fires only when the counts fail to add up, not
    # merely because some hosts are unknown.
    if (
        isinstance(declared_observed, int)
        and not isinstance(declared_observed, bool)
        and isinstance(declared_unknown, int)
        and not isinstance(declared_unknown, bool)
        and declared_observed + declared_unknown != declared_expected
    ):
        return (
            "fleet sentinel roster accounting gap: "
            f"observedHostCount={declared_observed} unknownHostCount={declared_unknown} "
            f"expectedHostCount={declared_expected} (roster members dropped from snapshot)"
        )
    return None


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(float(raw))
    except (OverflowError, ValueError):
        return default


def directory_stats(path: Path, pattern: str) -> tuple[int, int]:
    """Delegate to the shared SSOT scanner (lib.queue_age).  See #2460.

    Uses createdAt for *.json entries (same clock as daily health-check) so
    that dispatcher retries (which refresh mtime without changing createdAt)
    cannot make an old event appear brand-new to the watchdog.
    """
    try:
        return scan_directory(path, pattern, float(now_epoch()))
    except OSError as exc:
        raise QueueDirectoryError(f"path={path} pattern={pattern} error={type(exc).__name__}: {exc}") from exc


def queue_backlog_problem(
    label: str,
    paths: list[Path],
    pattern: str,
    max_count: int,
    max_oldest_seconds: int,
) -> str | None:
    total_count = 0
    oldest_seconds = 0
    for path in paths:
        try:
            count, oldest = directory_stats(path, pattern)
        except QueueDirectoryError as exc:
            return f"{label} backlog scan failed: {exc}"
        total_count += count
        oldest_seconds = max(oldest_seconds, oldest)
    over_count = threshold_met(total_count, max_count)
    over_age = threshold_met(oldest_seconds, max_oldest_seconds)
    if not over_count and not over_age:
        return None
    return (
        f"{label} backlog critical: count={total_count} max_count={max_count} "
        f"oldest_seconds={oldest_seconds} max_oldest_seconds={max_oldest_seconds} "
        f"paths={','.join(str(path) for path in paths)}"
    )


def queue_backlog_problems() -> dict[str, str]:
    root = state_root()
    checks = [
        (
            "queue:outbox",
            "outbox",
            [Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", root / "outbox"))],
            "*.json",
            parse_queue_threshold("BOT_ERRORS_WATCHDOG_OUTBOX_CRITICAL_COUNT", parse_queue_threshold("BOT_ERRORS_OUTBOX_CRITICAL_COUNT", 100)),
            parse_queue_threshold(
                "BOT_ERRORS_WATCHDOG_OUTBOX_CRITICAL_OLDEST_SECONDS",
                parse_queue_threshold("BOT_ERRORS_OUTBOX_CRITICAL_OLDEST_SECONDS", 3600),
            ),
        ),
        (
            "queue:processing",
            "processing",
            [root / "processing"],
            "*",
            parse_queue_threshold(
                "BOT_ERRORS_WATCHDOG_PROCESSING_CRITICAL_COUNT",
                parse_queue_threshold("BOT_ERRORS_PROCESSING_CRITICAL_COUNT", 10),
            ),
            parse_queue_threshold(
                "BOT_ERRORS_WATCHDOG_PROCESSING_CRITICAL_OLDEST_SECONDS",
                parse_queue_threshold("BOT_ERRORS_PROCESSING_CRITICAL_OLDEST_SECONDS", 300),
            ),
        ),
        (
            "queue:writefail",
            "writefail",
            [
                root / "writefail",
                Path(os.environ.get("TMPDIR", "/tmp")) / "bot-errors-writefail",
                Path.home() / ".bot-errors-writefail",
            ],
            "*.writefail",
            parse_queue_threshold(
                "BOT_ERRORS_WATCHDOG_WRITEFAIL_CRITICAL_COUNT",
                parse_queue_threshold("BOT_ERRORS_WRITEFAIL_CRITICAL_COUNT", 10),
            ),
            parse_queue_threshold(
                "BOT_ERRORS_WATCHDOG_WRITEFAIL_CRITICAL_OLDEST_SECONDS",
                parse_queue_threshold("BOT_ERRORS_WRITEFAIL_CRITICAL_OLDEST_SECONDS", 600),
            ),
        ),
    ]
    problems: dict[str, str] = {}
    for key, label, paths, pattern, max_count, max_oldest_seconds in checks:
        problem = queue_backlog_problem(label, paths, pattern, max_count, max_oldest_seconds)
        if problem:
            problems[key] = problem
    return problems


def env_host_list(name: str) -> list[str]:
    raw = os.environ.get(name, "")
    return [part.strip() for part in raw.split(",") if part.strip()]


def daily_health_hosts() -> list[str]:
    raw = os.environ.get("BOT_ERRORS_DAILY_HEALTH_HOSTS", "")
    if raw:
        required = env_host_list("BOT_ERRORS_DAILY_HEALTH_HOSTS")
    else:
        collector_hosts = collector_configured_hosts()
        if not collector_hosts:
            return []
        required = unique_hosts([*local_daily_health_hosts(), *collector_hosts])
    optional = set(optional_daily_health_hosts())
    return [host for host in required if host not in optional]


def unique_hosts(hosts: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for host in hosts:
        cleaned = host.strip()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        result.append(cleaned)
    return result


def canonical_local_host() -> str:
    return normalize_hub_host(socket.gethostname().split(".", 1)[0])


def local_daily_health_hosts() -> list[str]:
    if "BOT_ERRORS_LOCAL_DAILY_HEALTH_HOSTS" in os.environ:
        return [part.strip() for part in os.environ["BOT_ERRORS_LOCAL_DAILY_HEALTH_HOSTS"].split(",") if part.strip()]
    return [canonical_local_host()]


def health_profile_path() -> Path:
    raw = os.environ.get("BOT_ERRORS_HEALTH_PROFILE", "").strip()
    if raw:
        return Path(raw).expanduser()
    return REPO_ROOT / "deploy" / "health-profiles" / f"{canonical_local_host()}.json"


def load_health_profile() -> dict[str, Any] | None:
    path = health_profile_path()
    data = load_json(path)
    return data if isinstance(data, dict) else None


def expected_local_instances() -> list[dict[str, Any]]:
    profile = load_health_profile()
    if not profile:
        return []
    result: list[dict[str, Any]] = []
    instances = profile.get("instances")
    if not isinstance(instances, list):
        return result
    for instance in instances:
        if not isinstance(instance, dict):
            continue
        expected = str(instance.get("expected") or "").strip()
        service = str(instance.get("service") or "").strip()
        name = str(instance.get("name") or service).strip()
        if expected != "always_on" or not service:
            continue
        item: dict[str, Any] = {"name": name, "service": service}
        health_port = instance.get("healthPort")
        if isinstance(health_port, int) and not isinstance(health_port, bool):
            item["healthPort"] = health_port
        elif isinstance(health_port, str) and health_port.strip().isdigit():
            item["healthPort"] = int(health_port.strip())
        result.append(item)
    return result


def expected_local_services() -> list[dict[str, str]]:
    return [
        {"name": str(instance["name"]), "service": str(instance["service"])}
        for instance in expected_local_instances()
    ]


def dry_service_states() -> dict[str, str]:
    raw = os.environ.get("BOT_ERRORS_DRY_SERVICE_STATES", "").strip()
    if not raw:
        return {}
    try:
        loaded = json.loads(raw)
        if isinstance(loaded, dict):
            return {str(key): str(value) for key, value in loaded.items()}
    except json.JSONDecodeError:
        pass
    states: dict[str, str] = {}
    for item in raw.split(","):
        if "=" not in item:
            continue
        key, value = item.split("=", 1)
        if key.strip():
            states[key.strip()] = value.strip()
    return states


def service_check_timeout() -> float:
    raw = os.environ.get("BOT_ERRORS_SERVICE_CHECK_TIMEOUT_SECONDS", "5")
    try:
        value = float(raw)
    except ValueError:
        return 5
    return max(0.1, value) if math.isfinite(value) else 5


def systemd_service_status(service: str) -> str:
    proc = subprocess.run(
        ["systemctl", "--user", "is-active", service],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=service_check_timeout(),
        check=False,
    )
    status = proc.stdout.strip() or proc.stderr.strip() or f"rc={proc.returncode}"
    return status[:200]


def launchd_service_status(service: str) -> str:
    proc = subprocess.run(
        ["launchctl", "list", service],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=service_check_timeout(),
        check=False,
    )
    if proc.returncode != 0:
        return f"inactive rc={proc.returncode}: {(proc.stderr.strip() or proc.stdout.strip())[:160]}"
    first = next((line for line in proc.stdout.splitlines() if line.strip()), "")
    if first.startswith("-"):
        return f"inactive {first[:160]}"
    return "active"


def local_service_status(service: str) -> str:
    dry = dry_service_states()
    if service in dry:
        return dry[service]
    try:
        if sys.platform == "darwin":
            return launchd_service_status(service)
        return systemd_service_status(service)
    except Exception as exc:  # noqa: BLE001 - watchdog should report check failures.
        return f"check_failed: {str(exc)[:180]}"


def service_is_active(status: str) -> bool:
    normalized = status.strip().lower()
    return normalized == "active" or normalized.startswith("active ")


_SYSTEMD_CRASH_RESULTS = {
    "exit-code",
    "signal",
    "core-dump",
    "watchdog",
    "oom-kill",
    "timeout",
    "start-limit-hit",
    "resources",
    "protocol",
}


def intent_detection_enabled() -> bool:
    raw = os.environ.get("BOT_ERRORS_WATCHDOG_INTENT_DETECTION", "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def restart_grace_seconds() -> float:
    raw = os.environ.get("BOT_ERRORS_RESTART_GRACE_SECONDS", "45")
    try:
        value = float(raw)
    except ValueError:
        return 45.0
    return max(0.0, value) if math.isfinite(value) else 45.0


def monotonic_now_seconds() -> float:
    return time.clock_gettime(time.CLOCK_MONOTONIC)


def dry_service_intent() -> dict[str, dict[str, str]]:
    raw = os.environ.get("BOT_ERRORS_DRY_SERVICE_INTENT", "").strip()
    if not raw:
        return {}
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(loaded, dict):
        return {}
    result: dict[str, dict[str, str]] = {}
    for key, value in loaded.items():
        if isinstance(value, dict):
            result[str(key)] = {str(prop_key): str(prop_value) for prop_key, prop_value in value.items()}
    return result


def service_intent_properties(service: str) -> dict[str, str]:
    dry = dry_service_intent()
    if service in dry:
        return dict(dry[service])
    proc = subprocess.run(
        [
            "systemctl",
            "--user",
            "show",
            service,
            "-p",
            "ActiveState",
            "-p",
            "SubState",
            "-p",
            "Result",
            "-p",
            "ExecMainStatus",
            "-p",
            "StateChangeTimestampMonotonic",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=service_check_timeout(),
        check=False,
    )
    props: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        props[key.strip()] = value.strip()
    if proc.returncode != 0 and not props:
        props["_showError"] = (proc.stderr.strip() or f"rc={proc.returncode}")[:160]
    return props


def activating_elapsed_seconds(props: dict[str, str], monotonic_now: float) -> float | None:
    raw = props.get("StateChangeTimestampMonotonic")
    try:
        ts_us = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if ts_us <= 0:
        return None
    return max(0.0, monotonic_now - ts_us / 1_000_000.0)


def classify_service_intent(
    props: dict[str, str],
    grace_seconds: float,
    monotonic_now: float,
) -> tuple[str, str]:
    active_state = props.get("ActiveState", "").strip().lower()
    sub_state = props.get("SubState", "").strip().lower()
    result = props.get("Result", "").strip().lower()
    exec_status = props.get("ExecMainStatus", "").strip()

    if active_state in {"active", "reloading"}:
        return "active", f"ActiveState={active_state} SubState={sub_state or 'running'}"

    if active_state == "activating":
        elapsed = activating_elapsed_seconds(props, monotonic_now)
        if elapsed is None or elapsed < grace_seconds:
            rendered = "unknown" if elapsed is None else round(elapsed, 1)
            return (
                "activating_grace",
                f"restart in flight: elapsed={rendered}s grace={grace_seconds}s SubState={sub_state}",
            )
        return (
            "crash",
            f"restart stalled: activating elapsed={round(elapsed, 1)}s >= grace={grace_seconds}s "
            f"SubState={sub_state}",
        )

    if active_state == "failed" or result in _SYSTEMD_CRASH_RESULTS:
        return (
            "crash",
            f"ActiveState={active_state or 'unknown'} Result={result or 'unknown'} "
            f"ExecMainStatus={exec_status or '?'} SubState={sub_state}",
        )

    if active_state in {"inactive", "deactivating"}:
        if result in {"", "success"} and exec_status in {"", "0"}:
            return (
                "planned",
                f"clean stop: ActiveState={active_state} SubState={sub_state or 'dead'} "
                f"Result={result or 'success'}",
            )
        return (
            "crash",
            f"unclean stop: ActiveState={active_state} Result={result or 'unknown'} "
            f"ExecMainStatus={exec_status or '?'} SubState={sub_state}",
        )

    detail = f"unclassified: ActiveState={active_state or 'unknown'} Result={result or 'unknown'}"
    if props.get("_showError"):
        detail += f" probe_error={props['_showError']}"
    return "crash", detail


def log_intent_skip(service: str, name: str, classification: str, detail: str) -> None:
    print(
        f"[watchdog] intent-skip service={service} instance={name} "
        f"classification={classification} {detail}",
        file=sys.stderr,
    )


def local_service_problems() -> dict[str, str]:
    profile = health_profile_path()
    problems: dict[str, str] = {}
    legacy_states = dry_service_states()
    dry_intent = dry_service_intent()
    use_intent = intent_detection_enabled() and (sys.platform != "darwin" or bool(dry_intent))
    grace = restart_grace_seconds()
    monotonic_now = monotonic_now_seconds() if use_intent else 0.0
    for item in expected_local_services():
        service = item["service"]
        name = item["name"]
        key = f"local_service:{service}"
        if service in legacy_states:
            status = legacy_states[service]
            if service_is_active(status):
                continue
            problems[key] = (
                f"local service inactive: service={service} instance={name} "
                f"status={status} expected=always_on profile={profile}"
            )
            continue
        if not use_intent:
            status = local_service_status(service)
            if service_is_active(status):
                continue
            problems[key] = (
                f"local service inactive: service={service} instance={name} "
                f"status={status} expected=always_on profile={profile}"
            )
            continue
        try:
            props = service_intent_properties(service)
            classification, detail = classify_service_intent(props, grace, monotonic_now)
        except Exception as exc:  # noqa: BLE001 - ambiguity must alert, not hide.
            problems[key] = (
                f"local service intent check failed: service={service} instance={name} "
                f"error={str(exc)[:160]} expected=always_on profile={profile}"
            )
            continue
        if classification in {"active", "planned", "activating_grace"}:
            if classification != "active":
                log_intent_skip(service, name, classification, detail)
            continue
        problems[key] = (
            f"local service crash: service={service} instance={name} "
            f"intent={classification} {detail} expected=always_on profile={profile}"
        )
    return problems


def local_health_timeout() -> float:
    raw = os.environ.get("BOT_ERRORS_LOCAL_HEALTH_TIMEOUT_SECONDS", "3")
    try:
        value = float(raw)
    except ValueError:
        return 3
    return max(0.1, value) if math.isfinite(value) else 3


def local_health_retries() -> int:
    raw = os.environ.get("BOT_ERRORS_LOCAL_HEALTH_RETRIES", "2")
    try:
        value = int(raw)
    except ValueError:
        return 2
    return max(0, value)


def local_health_retry_backoff() -> float:
    raw = os.environ.get("BOT_ERRORS_LOCAL_HEALTH_RETRY_BACKOFF_SECONDS", "0.75")
    try:
        value = float(raw)
    except ValueError:
        return 0.75
    return max(0.0, value) if math.isfinite(value) else 0.75


def dry_local_health_responses() -> dict[str, Any]:
    raw = os.environ.get("BOT_ERRORS_DRY_LOCAL_HEALTH_RESPONSES", "").strip()
    if not raw:
        return {}
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def dry_local_health_status(value: Any) -> tuple[int, str | None]:
    try:
        return int(value), None
    except (TypeError, ValueError, OverflowError):
        return 0, f"invalid dry local health status={value!r}"


def local_health_http_response(name: str, port: int) -> tuple[int, str, str]:
    url = f"http://127.0.0.1:{port}/health"
    dry = dry_local_health_responses()
    entry = dry.get(name)
    if entry is None:
        entry = dry.get(str(port))
    if entry is not None:
        if isinstance(entry, dict):
            status, status_error = dry_local_health_status(entry.get("status", 200))
            if status_error is not None:
                return status, status_error, url
            body = entry.get("body", entry.get("json", ""))
            if not isinstance(body, str):
                body = json.dumps(body)
            return status, body, url
        if isinstance(entry, str):
            status, status_error = dry_local_health_status(os.environ.get("BOT_ERRORS_DRY_LOCAL_HEALTH_STATUS", "200"))
            return status, status_error or entry, url
    req = Request(url, method="GET")
    attempts = local_health_retries() + 1
    last_failure: tuple[int, str, str] = (0, "no attempts", url)
    for attempt in range(attempts):
        try:
            with urlopen(req, timeout=local_health_timeout()) as response:
                body = response.read(64 * 1024).decode("utf-8", errors="replace")
                return int(response.status), body, url
        except HTTPError as exc:
            body = exc.read(64 * 1024).decode("utf-8", errors="replace")
            return int(exc.code), body, url
        except URLError as exc:
            last_failure = (0, str(exc.reason), url)
        except Exception as exc:  # noqa: BLE001 - watchdog should report probe failures.
            last_failure = (0, str(exc), url)
        if attempt + 1 < attempts:
            time.sleep(local_health_retry_backoff())
    return last_failure


def compact_health_field(value: Any) -> str:
    if value is None:
        return "none"
    return str(value).replace("\n", " ")[:200]


def is_terminal_auth_failure_class(value: Any) -> bool:
    return isinstance(value, str) and value.strip().lower() in TERMINAL_AUTH_FAILURE_CLASSES


def health_reasons_from_payload(payload: dict, name: str) -> tuple[list[str], dict]:
    """Extract failure reasons + formatting context from a parsed /health body.

    Runs on ANY status code: a server-side logout returns HTTP 503 with the full
    telemetry (including auth_failure_class), so the terminal-auth class must be
    surfaced as a token regardless of the HTTP status. Returns ([], {}) when the
    telemetry is clean (healthy instance).
    """
    instance = payload.get("instance") if isinstance(payload.get("instance"), dict) else {}
    actual_name = instance.get("name") if isinstance(instance, dict) else None
    whatsapp = payload.get("whatsapp") if isinstance(payload.get("whatsapp"), dict) else {}
    connection = whatsapp.get("connection") if isinstance(whatsapp.get("connection"), dict) else {}
    auth_bond = whatsapp.get("auth_bond") if isinstance(whatsapp.get("auth_bond"), dict) else {}
    connected = whatsapp.get("connected") if isinstance(whatsapp, dict) else None
    health_status = payload.get("status")
    degradation_causes = payload.get("degradation_causes")
    auth_failure = connection.get("auth_failure_class") if isinstance(connection, dict) else None
    bond_status = auth_bond.get("status") if isinstance(auth_bond, dict) else None
    bond_issues = auth_bond.get("issues") if isinstance(auth_bond, dict) else None
    reasons: list[str] = []
    if isinstance(actual_name, str) and actual_name != name:
        reasons.append(f"health_identity_mismatch actual={actual_name}")
    if health_status == "unhealthy":
        reasons.append("health_status=unhealthy")
    elif health_status == "degraded":
        # /health returns HTTP 200 for degraded (src/core/health.ts), so the
        # transport path succeeds — without this branch a reachable degraded
        # runtime reads as healthy silence.
        reasons.append("health_status=degraded")
        if isinstance(degradation_causes, list) and degradation_causes:
            reasons.append(
                f"degradation_causes={','.join(str(cause) for cause in degradation_causes[:5])}"
            )
    if connected is not True:
        reasons.append(f"connected={str(connected).lower()}")
    if auth_failure not in (None, "", "none"):
        reasons.append(f"auth_failure_class={auth_failure}")
        if is_terminal_auth_failure_class(auth_failure):
            reasons.append("physical_intervention_required=terminal_auth_failure_class")
    if bond_status not in (None, "", "present"):
        reasons.append(f"auth_bond_status={bond_status}")
    if isinstance(bond_issues, list) and bond_issues:
        reasons.append(f"auth_bond_issues={','.join(str(issue) for issue in bond_issues[:5])}")
    return reasons, {"connection": connection, "bond_status": bond_status}


def format_health_failure(
    name: str, port: int, url: str, status: int, reasons: list[str], ctx: dict, profile: Any
) -> str:
    connection = ctx.get("connection") if isinstance(ctx, dict) else {}
    bond_status = ctx.get("bond_status") if isinstance(ctx, dict) else None
    return (
        f"local instance health failure: instance={name} port={port} url={url} "
        f"http_status={status} {' '.join(reasons)} "
        f"connection_state={compact_health_field(connection.get('state') if isinstance(connection, dict) else None)} "
        f"last_status_code={compact_health_field(connection.get('last_status_code') if isinstance(connection, dict) else None)} "
        f"last_disconnect_reason={compact_health_field(connection.get('last_disconnect_reason') if isinstance(connection, dict) else None)} "
        f"auth_bond_status={compact_health_field(bond_status)} profile={profile}"
    )


def local_instance_health_problems(
    evaluated_out: set[str] | None = None,
) -> dict[str, str]:
    """Returns the problems dict (the long-standing contract). When
    evaluated_out is provided, the names of locally-evaluated instances are
    added to it so reconcile() can scope its clear path (#2431)."""
    profile = health_profile_path()
    problems: dict[str, str] = {}
    evaluated: set[str] = set()
    for item in expected_local_instances():
        port = item.get("healthPort")
        if isinstance(port, bool) or not isinstance(port, int):
            continue
        name = str(item["name"])
        evaluated.add(name)
        status, body, url = local_health_http_response(name, port)
        key = f"local_health:{name}"
        # Parse the telemetry REGARDLESS of status code. A server-side logout
        # returns HTTP 503 with the full health body carrying
        # auth_failure_class=serverside_logout_irreversible — the old code
        # short-circuited on non-200 and dumped the opaque body, so the
        # terminal-auth token never surfaced and the dispatcher's Pattern-C
        # inhibition never engaged (the instance re-paged indefinitely).
        payload: dict | None = None
        if isinstance(body, str) and body.strip():
            try:
                parsed = json.loads(body)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict):
                payload = parsed
        if payload is None:
            # No structured telemetry to classify. Fail-open: still alert on the
            # raw probe failure so a hard-down instance (503 HTML / empty body /
            # transport error) is never silently swallowed.
            if status != 200:
                problems[key] = (
                    f"local health probe failed: instance={name} port={port} url={url} "
                    f"http_status={status} body={compact_health_field(body)} profile={profile}"
                )
            else:
                problems[key] = (
                    f"local health probe invalid JSON: instance={name} port={port} url={url} "
                    f"http_status={status} body={compact_health_field(body)} profile={profile}"
                )
            continue
        reasons, ctx = health_reasons_from_payload(payload, name)
        if status != 200 and not reasons:
            # Non-200 with parseable-but-clean telemetry is still a probe
            # failure — never drop it (fail-open).
            reasons = [f"http_status_non_ok={status}"]
        if not reasons:
            continue
        problems[key] = format_health_failure(name, port, url, status, reasons, ctx, profile)
    if evaluated_out is not None:
        evaluated_out.update(evaluated)
    return problems


def parse_remote_host(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    remote = value.strip()
    if not remote:
        return None
    return remote.split(":", 1)[0]


def collector_configured_hosts() -> list[str]:
    data = load_json(state_root() / "collector-state.json", require_private=True)
    if not data:
        return []
    raw_hosts = data.get("configuredRemoteHosts")
    if isinstance(raw_hosts, list):
        return unique_hosts([host for host in (parse_remote_host(value) for value in raw_hosts) if host])
    raw_remotes = data.get("configuredRemotes")
    if isinstance(raw_remotes, list):
        return unique_hosts([host for host in (parse_remote_host(value) for value in raw_remotes) if host])
    remotes = data.get("remotes")
    if isinstance(remotes, dict):
        return unique_hosts([host for host in (parse_remote_host(value) for value in remotes.keys()) if host])
    return []


def collector_best_effort_hosts() -> list[str]:
    data = load_json(state_root() / "collector-state.json", require_private=True)
    if not data:
        return []
    raw_hosts = data.get("configuredBestEffortRemoteHosts")
    if isinstance(raw_hosts, list):
        return unique_hosts([host for host in (parse_remote_host(value) for value in raw_hosts) if host])
    raw_remotes = data.get("configuredBestEffortRemotes")
    if isinstance(raw_remotes, list):
        return unique_hosts([host for host in (parse_remote_host(value) for value in raw_remotes) if host])
    return []


def collector_reachability_evidence(host: str) -> str:
    """Return bounded, non-address collector context for a stale host.

    The collector already owns the remote reachability probe. Reusing its
    durable receipt keeps the heartbeat watchdog independent of SSH/Tailscale
    execution while making a cadence alert actionable. Network addresses and
    arbitrary target lists are deliberately excluded.
    """
    data = load_json(state_root() / "collector-state.json", require_private=True)
    remotes = data.get("remotes") if isinstance(data, dict) else None
    remote = remotes.get(host) if isinstance(remotes, dict) else None
    if not isinstance(remote, dict):
        return ""

    parts: list[str] = []
    reachability = remote.get("lastReachability")
    if isinstance(reachability, dict):
        diagnosis = reachability.get("reachabilityDiagnosis")
        if isinstance(diagnosis, str) and diagnosis.strip():
            parts.append(
                f"collector_reachability={compact_health_field(redact_watchdog_text(diagnosis.strip()))}"
            )

    failures = remote.get("consecutiveFailures")
    if isinstance(failures, int) and not isinstance(failures, bool) and failures >= 0:
        parts.append(f"collector_consecutive_failures={failures}")
    last_success = remote.get("lastSuccessIso")
    if isinstance(last_success, str) and last_success.strip():
        parts.append(
            f"collector_last_success={compact_health_field(redact_watchdog_text(last_success.strip()))}"
        )

    tailscale = reachability.get("tailscale") if isinstance(reachability, dict) else None
    if isinstance(tailscale, dict):
        online = tailscale.get("online")
        if isinstance(online, bool):
            parts.append(f"tailscale_online={str(online).lower()}")
        last_seen = tailscale.get("lastSeen")
        if isinstance(last_seen, str) and last_seen.strip():
            parts.append(
                f"tailscale_last_seen={compact_health_field(redact_watchdog_text(last_seen.strip()))}"
            )
    return " ".join(parts)


def optional_daily_health_hosts() -> list[str]:
    return unique_hosts([*env_host_list("BOT_ERRORS_DAILY_HEALTH_OPTIONAL_HOSTS"), *collector_best_effort_hosts()])


def collector_roster_drift_problem() -> str | None:
    """Independently compare the collector's configured remotes against the
    tracked ``collectorRemote: true`` roster (#1880).

    The collector's required-remote list and the daily-health cadence both derive
    from the same host-local configuration, so an omission shrinks the producer
    and the checker together and creates no drift attention. This check derives
    the *required* set from the independent roster instead, so a required host
    that is missing from collector configuration surfaces as explicit drift.

    Privacy: a missing host is a public roster member and is named so the operator
    can act; an *extra* configured remote may be a private ssh alias, so only its
    count is reported, never the raw identifier. A missing state file is owned by
    the collector freshness check; a present-but-unreadable one is reported as
    config-unreadable drift.
    """
    collector_path = state_root() / "collector-state.json"
    if not collector_path.exists():
        return None
    try:
        _roster_data, inventory = load_roster()
    except RosterError as exc:
        return f"collector roster comparison unavailable: roster unreadable: {exc}"
    data = load_json(collector_path, require_private=True)
    if data is None:
        return f"collector roster drift: collector-state config-unreadable path={collector_path}"
    roster_required = set(inventory["collectorRemoteHosts"])
    roster_all = set(inventory["expectedHosts"])
    configured = set(collector_configured_hosts())
    excluded = set(collector_best_effort_hosts()) | set(env_host_list("BOT_ERRORS_DAILY_HEALTH_OPTIONAL_HOSTS"))
    missing = sorted((roster_required - configured) - excluded)
    extra = sorted(configured - roster_all)
    if not missing and not extra:
        return None
    parts = [f"collector roster drift: required={len(roster_required)} configured={len(configured)}"]
    if missing:
        parts.append(f"missing={','.join(missing)}")
    if extra:
        parts.append(f"extra_count={len(extra)}")
    return " ".join(parts)


def daily_health_event_host(path: Path, data: dict[str, Any] | None) -> str | None:
    match = re.search(r"\.relay-([A-Za-z0-9_.:-]+)\.bot-errors-health\.daily-health\.", path.name)
    if match:
        return match.group(1)
    # Payload branch shares the dispatcher's canonical key so the freshness ledger
    # the dispatcher writes and the host the watchdog reads cannot drift apart.
    return daily_health_host_from_payload(data)


def daily_health_events() -> list[tuple[Path, int, dict[str, Any] | None]]:
    root = state_root()
    events: list[tuple[Path, int, dict[str, Any] | None]] = []
    for dirname in ("outbox", "processing", "sent", "suppressed", "relayed", "storm-collapsed"):
        directory = root / dirname
        if not directory.exists():
            continue
        try:
            paths = list(directory.glob("*.json*"))
        except OSError as exc:
            raise DailyHealthEventError(
                f"directory={directory} pattern=*.json* error={type(exc).__name__}: {exc}"
            ) from exc
        for path in paths:
            data = load_json(path)
            if "daily-health" not in path.name and (not data or data.get("source") != "daily-health"):
                continue
            created = parse_iso_epoch(data.get("createdAt")) if data else None
            if created is None:
                try:
                    created = int(path.stat().st_mtime)
                except OSError as exc:
                    raise DailyHealthEventError(f"path={path} error={type(exc).__name__}: {exc}") from exc
            events.append((path, created, data))
    return events


def daily_health_freshness_ledger_age(host: str) -> tuple[int | None, str]:
    """Read per-host daily-health freshness from the durable incident-state ledger.

    The dispatcher records ``dailyHealthFreshness[host] = {lastSeenAt, lastSeenIso}``
    into incident-state.json, which is never FIFO-pruned. Unlike a scan of the
    garbage-collected suppressed/ archive, this freshness survives archive eviction —
    it is the authoritative liveness source. Returns ``(age_seconds, detail)`` or
    ``(None, reason)`` when the host is absent or the record is unusable.
    """
    path = state_root() / "incident-state.json"
    if not path.exists():
        return None, f"no incident-state ledger at {path}"
    data = load_json(path)
    if not isinstance(data, dict):
        return None, f"unreadable incident-state ledger at {path}"
    ledger = data.get("dailyHealthFreshness")
    if not isinstance(ledger, dict):
        return None, "incident-state ledger has no dailyHealthFreshness map"
    record = ledger.get(host)
    if not isinstance(record, dict):
        return None, f"no dailyHealthFreshness entry for {host}"
    last_seen = record.get("lastSeenAt")
    last_seen_epoch: int | None
    try:
        last_seen_epoch = int(last_seen)
    except (TypeError, ValueError):
        last_seen_epoch = parse_iso_epoch(record.get("lastSeenIso"))
    if last_seen_epoch is None:
        return None, f"invalid dailyHealthFreshness lastSeenAt for {host}: {last_seen!r}"
    current = now_epoch()
    if last_seen_epoch > current:
        return None, (
            f"future dailyHealthFreshness for {host}: lastSeenAt={last_seen_epoch} "
            f"now={current} future_by_seconds={last_seen_epoch - current}"
        )
    return max(0, current - last_seen_epoch), f"ledger dailyHealthFreshness[{host}] lastSeenAt={last_seen_epoch}"


def _daily_health_file_age(host: str | None) -> tuple[int | None, str]:
    newest: int | None = None
    newest_path = ""
    try:
        events = daily_health_events()
    except DailyHealthEventError as exc:
        return None, f"failed to scan daily-health events under {state_root()}: {exc}"
    for path, mtime, data in events:
        if host is not None:
            event_host = daily_health_event_host(path, data)
            if event_host != host:
                continue
        if newest is None or mtime > newest:
            newest = mtime
            newest_path = str(path)
    if newest is None:
        scope = f" for {host}" if host else ""
        return None, f"no daily-health event{scope} under {state_root()}"
    current = now_epoch()
    if newest > current:
        return None, (
            f"future daily-health event time: path={newest_path} "
            f"timestamp={newest} now={current} future_by_seconds={newest - current}"
        )
    return max(0, current - newest), f"{newest_path} mtime={newest}"


def daily_health_age(host: str | None = None) -> tuple[int | None, str]:
    dry_age = os.environ.get("BOT_ERRORS_DRY_DAILY_HEALTH_AGE_SECONDS")
    if dry_age is not None and host is None:
        try:
            age = int(dry_age)
        except (TypeError, ValueError, OverflowError):
            return None, f"invalid dry daily-health age: value={dry_age!r}"
        if age < 0:
            return None, f"invalid dry daily-health age: value={dry_age!r}"
        return age, "dry daily-health age"
    file_age, file_detail = _daily_health_file_age(host)
    if host is None:
        # Aggregate "any daily-health" check: the per-host freshness ledger does not apply.
        return file_age, file_detail
    ledger_age, ledger_detail = daily_health_freshness_ledger_age(host)
    # Freshest signal wins. The durable ledger decouples liveness from the
    # garbage-collected suppressed/ archive (the false-positive root cause): a FIFO
    # eviction can no longer age a live host out, while a genuinely dead host gets no
    # fresh ledger write and still ages out correctly via both sources.
    candidates = [
        (age, detail)
        for age, detail in ((file_age, file_detail), (ledger_age, ledger_detail))
        if age is not None
    ]
    if not candidates:
        return ledger_age, f"{ledger_detail}; file-scan: {file_detail}"
    return min(candidates, key=lambda candidate: candidate[0])


def browser_debug_min_age_seconds() -> int:
    return positive_env_int("BOT_ERRORS_BROWSER_DEBUG_MIN_AGE_SECONDS", 30 * 60)


def browser_debug_min_rss_mb() -> int:
    return positive_env_int("BOT_ERRORS_BROWSER_DEBUG_MIN_RSS_MB", 512)


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    converted = float(value)
    return converted if math.isfinite(converted) and converted >= 0 else None


def _dry_browser_debug_snapshot(raw: str) -> tuple[list[dict[str, Any]], str | None]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        return [], f"dry snapshot invalid JSON: {exc.msg}"
    if not isinstance(parsed, list):
        return [], "dry snapshot must be a list"
    rows: list[dict[str, Any]] = []
    for index, item in enumerate(parsed):
        if not isinstance(item, dict):
            return [], f"dry snapshot row {index} must be an object"
        pid = finite_epoch(item.get("pid"))
        age_seconds = _finite_number(item.get("ageSeconds"))
        rss_mb = _finite_number(item.get("rssMb"))
        process_count = finite_epoch(item.get("processCount"))
        debug_port = finite_epoch(item.get("debugPort"))
        controller_raw = item.get("controllerConnections")
        controller_connections = None if controller_raw is None else finite_epoch(controller_raw)
        profile_hash = re.sub(r"[^a-zA-Z0-9_.-]", "", str(item.get("profileHash") or ""))[:40]
        if (
            pid is None or pid <= 0
            or age_seconds is None
            or rss_mb is None
            or process_count is None or process_count <= 0
            or debug_port is None or not 1 <= debug_port <= 65535
            or (controller_raw is not None and (controller_connections is None or controller_connections < 0))
            or not profile_hash
        ):
            return [], f"dry snapshot row {index} has invalid required fields"
        rows.append({
            "pid": pid,
            "ageSeconds": age_seconds,
            "rssMb": rss_mb,
            "processCount": process_count,
            "debugPort": debug_port,
            "controllerConnections": controller_connections,
            "profileHash": profile_hash,
        })
    return rows, None


def _proc_processes() -> tuple[dict[int, dict[str, Any]], str | None]:
    proc_root = Path("/proc")
    if sys.platform != "linux" or not proc_root.is_dir():
        return {}, None
    try:
        uptime_seconds = float((proc_root / "uptime").read_text(encoding="utf-8").split()[0])
        clock_ticks = int(os.sysconf("SC_CLK_TCK"))
    except (OSError, ValueError, IndexError) as exc:
        return {}, f"process clock unavailable: {exc}"
    records: dict[int, dict[str, Any]] = {}
    try:
        entries = list(proc_root.iterdir())
    except OSError as exc:
        return {}, f"process inventory unavailable: {exc}"
    for entry in entries:
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        try:
            args = [
                part.decode("utf-8", errors="replace")
                for part in (entry / "cmdline").read_bytes().split(b"\0")
                if part
            ]
            stat_text = (entry / "stat").read_text(encoding="utf-8")
            stat_tail = stat_text[stat_text.rfind(")") + 1:].strip().split()
            ppid = int(stat_tail[1])
            start_ticks = int(stat_tail[19])
            rss_kb = 0
            for line in (entry / "status").read_text(encoding="utf-8").splitlines():
                if line.startswith("VmRSS:"):
                    rss_kb = int(line.split()[1])
                    break
        except (FileNotFoundError, PermissionError, ProcessLookupError, OSError, ValueError, IndexError):
            continue
        records[pid] = {
            "pid": pid,
            "ppid": ppid,
            "args": args,
            "ageSeconds": max(0.0, uptime_seconds - (start_ticks / clock_ticks)),
            "rssMb": rss_kb / 1024.0,
        }
    return records, None


def _browser_debug_port(args: list[str]) -> int | None:
    for index, arg in enumerate(args):
        raw = ""
        if arg.startswith("--remote-debugging-port="):
            raw = arg.partition("=")[2]
        elif arg == "--remote-debugging-port" and index + 1 < len(args):
            raw = args[index + 1]
        if raw.isdigit() and 1 <= int(raw) <= 65535:
            return int(raw)
    return None


def _browser_profile_hash(args: list[str], debug_port: int) -> str:
    profile = next((arg.partition("=")[2] for arg in args if arg.startswith("--user-data-dir=")), "")
    identity = profile or f"debug-port:{debug_port}"
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]


def _established_debug_connections(ports: set[int]) -> tuple[dict[int, int], str | None]:
    counts = {port: 0 for port in ports}
    if not ports:
        return counts, None
    try:
        result = subprocess.run(
            ["ss", "-Htn", "state", "established"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
        return counts, f"controller connection inventory unavailable: {exc}"
    if result.returncode != 0:
        return counts, f"controller connection inventory failed: rc={result.returncode}"
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) < 4:
            continue
        local_endpoint = fields[2]
        for port in ports:
            if local_endpoint.rsplit(":", 1)[-1] == str(port):
                counts[port] += 1
    return counts, None


def browser_debug_snapshot() -> tuple[list[dict[str, Any]], str | None]:
    dry = os.environ.get("BOT_ERRORS_DRY_BROWSER_DEBUG_SNAPSHOT")
    if dry is not None:
        return _dry_browser_debug_snapshot(dry)
    records, inventory_error = _proc_processes()
    if inventory_error is not None or not records:
        return [], inventory_error
    roots: list[tuple[dict[str, Any], int]] = []
    children: dict[int, list[int]] = {}
    for record in records.values():
        children.setdefault(int(record["ppid"]), []).append(int(record["pid"]))
        args = record["args"]
        if not isinstance(args, list) or not args or any(str(arg).startswith("--type=") for arg in args):
            continue
        binary = Path(str(args[0])).name.lower()
        if not any(name in binary for name in ("chrome", "chromium", "msedge", "brave")):
            continue
        debug_port = _browser_debug_port([str(arg) for arg in args])
        if debug_port is not None:
            roots.append((record, debug_port))
    connections, connection_error = _established_debug_connections({port for _, port in roots})
    rows: list[dict[str, Any]] = []
    for root, debug_port in roots:
        root_pid = int(root["pid"])
        descendants: set[int] = set()
        pending = [root_pid]
        while pending:
            current = pending.pop()
            if current in descendants:
                continue
            descendants.add(current)
            pending.extend(children.get(current, []))
        rows.append({
            "pid": root_pid,
            "ageSeconds": float(root["ageSeconds"]),
            "rssMb": sum(float(records[pid]["rssMb"]) for pid in descendants if pid in records),
            "processCount": len(descendants),
            "debugPort": debug_port,
            "controllerConnections": None if connection_error is not None else connections.get(debug_port, 0),
            "profileHash": _browser_profile_hash([str(arg) for arg in root["args"]], debug_port),
        })
    return rows, connection_error


def browser_debug_problems() -> dict[str, str]:
    rows, scan_error = browser_debug_snapshot()
    min_age = browser_debug_min_age_seconds()
    min_rss = browser_debug_min_rss_mb()
    qualifying = [
        row for row in rows
        if float(row["ageSeconds"]) >= min_age and float(row["rssMb"]) >= min_rss
    ]
    problems: dict[str, str] = {}
    if scan_error is not None and not rows:
        problems[BROWSER_DEBUG_PROBE_KEY] = (
            "browser debug process inventory unavailable: "
            "qualifying_sessions=unknown controller_connections=unknown "
            f"scan_error={redact_watchdog_text(scan_error)}"
        )
    unknown = [row for row in qualifying if row["controllerConnections"] is None]
    if unknown:
        max_rss = max(float(row["rssMb"]) for row in unknown)
        ports = ",".join(str(row["debugPort"]) for row in unknown[:8])
        problems[BROWSER_DEBUG_PROBE_KEY] = (
            "browser debug controller visibility unavailable: "
            f"qualifying_sessions={len(unknown)} max_rss_mb={max_rss:.1f} "
            f"debug_ports={ports} controller_connections=unknown "
            f"scan_error={redact_watchdog_text(scan_error or 'unknown')}"
        )
    for row in qualifying:
        if row["controllerConnections"] != 0:
            continue
        profile_hash = str(row["profileHash"])
        key = f"{BROWSER_DEBUG_PREFIX}{profile_hash}"
        problems[key] = (
            "browser debug session unattended: "
            f"profile_hash={profile_hash} root_pid={row['pid']} "
            f"age_seconds={float(row['ageSeconds']):.0f} rss_mb={float(row['rssMb']):.1f} "
            f"process_count={row['processCount']} debug_port={row['debugPort']} "
            f"controller_connections=0 min_age_seconds={min_age} min_rss_mb={min_rss}"
        )
    return problems


def configured_checks() -> set[str]:
    """Parse and validate BOT_ERRORS_WATCHDOG_CHECKS against the canonical registry.

    Fail-closed (#2465): an empty, whitespace-only, or unknown-token selector
    raises ValueError rather than silently producing a zero-check green result.
    A mixed valid+unknown selector is also rejected in full -- partial execution
    of a misconfigured selector would mask the typo.
    """
    raw = os.environ.get("BOT_ERRORS_WATCHDOG_CHECKS", DEFAULT_CHECKS)
    tokens = {part.strip() for part in raw.split(",") if part.strip()}
    if not tokens:
        raise ValueError(
            "BOT_ERRORS_WATCHDOG_CHECKS is empty or whitespace-only; "
            "an empty check set cannot produce a meaningful watchdog verdict "
            "(every observer would be silently disabled). "
            "Set it to a comma-separated subset of: "
            + ",".join(sorted(KNOWN_WATCHDOG_CHECKS))
        )
    unknown = tokens - KNOWN_WATCHDOG_CHECKS
    if unknown:
        raise ValueError(
            "BOT_ERRORS_WATCHDOG_CHECKS contains unknown token(s): "
            + ",".join(sorted(unknown))
            + ". Valid checks: " + ",".join(sorted(KNOWN_WATCHDOG_CHECKS))
        )
    return tokens


def active_reconcile_prefixes(checks: set[str]) -> list[str]:
    prefixes: list[str] = []
    if "q_loop" in checks:
        prefixes.append("q_loop")
    if "dispatcher" in checks:
        prefixes.append("dispatcher")
    if "collector" in checks:
        prefixes.append("collector")
    if "daily_health" in checks:
        prefixes.append("daily_health")
    if "queue_backlog" in checks:
        prefixes.append("queue:")
    if "local_services" in checks:
        prefixes.append("local_service:")
    if "local_instance_health" in checks:
        prefixes.append("local_health:")
    if "fleet_sentinel" in checks:
        prefixes.append("fleet_sentinel")
    if "collector_roster" in checks:
        prefixes.append("collector_roster")
    if "browser_debug" in checks:
        prefixes.append(BROWSER_DEBUG_PREFIX)
    return prefixes


def key_in_active_scope(key: str, prefixes: list[str]) -> bool:
    return any(key == prefix or key.startswith(prefix) for prefix in prefixes)


def collect_problems(args: argparse.Namespace, checks: set[str] | None = None, evaluated_instances: set[str] | None = None) -> dict[str, str]:
    checks = checks if checks is not None else configured_checks()
    problems: dict[str, str] = {}
    if "q_loop" in checks:
        q_loop_path = q_loop_state_path()
        age, detail = json_updated_age(q_loop_path)
        if age is None or age > args.max_q_loop_age:
            problems["q_loop"] = f"q-loop heartbeat stale: age_seconds={age if age is not None else 'missing'} max={args.max_q_loop_age} detail={detail}"
        state = load_json(q_loop_path, require_private=True)
        if state is not None:
            phase = str(state.get("phase") or "")
            if phase.startswith("q_unavailable_"):
                last_unavailable = state.get("last_q_unavailable_at")
                unavailable_at = finite_epoch(last_unavailable)
                unavailable_age = max(0, now_epoch() - unavailable_at) if unavailable_at is not None else "unknown"
                reason = str(state.get("last_q_unavailable_reason") or phase.removeprefix("q_unavailable_") or "unknown")
                last_seen = unavailable_at if unavailable_at is not None else "unknown"
                if is_capacity_supervisor_reason(reason) or is_capacity_supervisor_reason(phase):
                    # Self-recovering usage-window capacity cap: NOT a supervisor
                    # failure. Report as a distinct, non-paging capacity incident
                    # whose only remediation is to wait for the window to reset.
                    problems[Q_LOOP_CAPACITY_KEY] = (
                        f"q-loop at usage-window capacity; self-recovers when window resets: "
                        f"phase={phase} reason={reason} "
                        f"age_seconds={unavailable_age} last_q_unavailable_at={last_seen} "
                        f"detail={detail}"
                    )
                else:
                    problems["q_loop:supervisor"] = (
                        f"q-loop supervisor unavailable: phase={phase} reason={reason} "
                        f"age_seconds={unavailable_age} last_q_unavailable_at={last_seen} "
                        f"detail={detail}"
                    )
            else:
                waiting_since = finite_epoch(state.get("awaiting_q_since"))
                waiting_max = max_awaiting_q_age_seconds()
                if waiting_since is not None and waiting_since > 0:
                    waiting_age = max(0, now_epoch() - waiting_since)
                    if waiting_age > waiting_max:
                        last_q_message_at = finite_epoch(state.get("last_q_message_at"))
                        last_q_age = (
                            max(0, now_epoch() - last_q_message_at)
                            if last_q_message_at is not None and last_q_message_at > 0
                            else "missing"
                        )
                        problems[Q_LOOP_AWAITING_Q_KEY] = (
                            f"q-loop awaiting Q stale: age_seconds={waiting_age} "
                            f"max={waiting_max} phase={phase or 'unknown'} "
                            f"last_q_message_age_seconds={last_q_age} detail={detail}"
                        )
    if "dispatcher" in checks:
        age, detail = file_age(state_root() / "dispatcher-state.json")
        if age is None or age > args.max_dispatcher_age:
            problems["dispatcher"] = f"dispatcher heartbeat stale: age_seconds={age if age is not None else 'missing'} max={args.max_dispatcher_age} detail={detail}"
    if "collector" in checks:
        age, detail = file_age(state_root() / "collector-state.json")
        if age is None or age > args.max_collector_age:
            problems["collector"] = f"collector heartbeat stale: age_seconds={age if age is not None else 'missing'} max={args.max_collector_age} detail={detail}"
    if "fleet_sentinel" in checks:
        sentinel_path = fleet_sentinel_heartbeat_path()
        age, detail = fleet_sentinel_age(sentinel_path)
        if age is None or age > args.max_fleet_sentinel_age:
            problems["fleet_sentinel"] = (
                f"fleet sentinel heartbeat stale: age_seconds={age if age is not None else 'missing'} "
                f"max={args.max_fleet_sentinel_age} detail={detail}"
            )
        roster_problem = fleet_sentinel_roster_problem(sentinel_path)
        if roster_problem is not None:
            problems["fleet_sentinel:roster"] = roster_problem
        # #2432: non-green aggregate detection — a fresh, roster-bound
        # aggregate with healthy=false and nonGreenReason must alert.
        sentinel_data = _readable_fleet_sentinel_heartbeat(sentinel_path)
        if sentinel_data is not None and sentinel_data.get("nonGreenReason"):
            problems["fleet_sentinel:non_green"] = (
                f"fleet sentinel aggregate non-green: "
                f"nonGreenReason={sentinel_data['nonGreenReason']} "
                f"fleetAction={sentinel_data.get('fleetAction')} "
                f"healthy={sentinel_data.get('healthy')}"
            )
    if "collector_roster" in checks:
        drift = collector_roster_drift_problem()
        if drift is not None:
            problems["collector_roster"] = drift
    if "daily_health" in checks:
        hosts = daily_health_hosts()
        if hosts:
            for host in hosts:
                age, detail = daily_health_age(host)
                key = f"daily_health:{host}"
                if age is None or age > args.max_daily_health_age:
                    collector_context = collector_reachability_evidence(host)
                    problems[key] = (
                        f"daily-health cadence stale for {host}: "
                        f"age_seconds={age if age is not None else 'missing'} "
                        f"max={args.max_daily_health_age} detail={detail}"
                        f"{' ' + collector_context if collector_context else ''}"
                    )
        else:
            age, detail = daily_health_age()
            if age is None or age > args.max_daily_health_age:
                problems["daily_health"] = f"daily-health cadence stale: age_seconds={age if age is not None else 'missing'} max={args.max_daily_health_age} detail={detail}"
    if "queue_backlog" in checks:
        problems.update(queue_backlog_problems())
    if "local_services" in checks:
        problems.update(local_service_problems())
    if "local_instance_health" in checks:
        problems.update(local_instance_health_problems(evaluated_instances))
    if "browser_debug" in checks:
        problems.update(browser_debug_problems())
    return problems


def incident_epoch(incident: dict[str, Any], key: str, fallback: int) -> int:
    parsed = parse_iso_epoch(incident.get(key))
    return parsed if parsed is not None else fallback


def int_or_zero(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return 0


def incident_age_seconds(incident: dict[str, Any], current: int) -> int:
    first_seen = incident_epoch(incident, "firstSeenAt", current)
    wall_age = max(0, current - first_seen)
    previous_age = int_or_zero(incident.get("ageSeconds"))
    return max(previous_age, wall_age)


def replacement_incident(current: int) -> dict[str, Any]:
    return {
        "firstSeenAt": now_iso(current),
        "lastSeenAt": now_iso(current),
        "lastNotifiedAt": now_iso(current),
        "lastEvidence": "malformed incident record",
        "suppressed": 0,
    }


def deferred_recovery_event(key: str, record: dict[str, Any]) -> Path:
    """Emit the recovery notice that was held while the incident flapped.

    A flapping incident's stale->ok observations are provisional: within the
    re-arm window the same condition reopens silently, so its recovery notice is
    deferred until the key stays clean past the window and then sent exactly once.
    """
    return outbox_event(
        f"BOT ERRORS heartbeat watchdog recovered: {key}",
        "\n".join([
            f"source={key}",
            f"first_seen={record.get('firstSeenAt')}",
            f"flap_count={int_or_zero(record.get('flapCount'))}",
            "recovery_notice_deferred=true",
            f"held_since={record.get('recoveredAt')}",
            f"suppressed_duplicates={int_or_zero(record.get('suppressed'))}",
            f"last_evidence={record.get('lastEvidence')}",
            f"watchdog_state={watchdog_state_path()}",
        ]),
        "info",
        key,
        event_type="clear",
    )


def reconcile(problems: dict[str, str], active_prefixes: list[str], evaluated_instances: set[str] | None = None) -> list[Path]:
    state = load_state()
    open_incidents: dict[str, Any] = state["open"]
    written: list[Path] = []
    current = now_epoch()
    for key, evidence in sorted(problems.items()):
        redacted_evidence = redact_watchdog_text(evidence)
        if key in open_incidents and not isinstance(open_incidents[key], dict):
            open_incidents.pop(key, None)
        if key in open_incidents:
            incident = open_incidents[key]
            incident["suppressed"] = int_or_zero(incident.get("suppressed")) + 1
            incident["lastSeenAt"] = now_iso(current)
            incident["lastEvidence"] = redacted_evidence
            incident.pop("recoveryObservations", None)
            incident.pop("lastRecoveryObservedAt", None)
            suppressed = int_or_zero(incident.get("suppressed"))
            first_seen = incident_epoch(incident, "firstSeenAt", current)
            last_notified = incident_epoch(incident, "lastNotifiedAt", first_seen)
            age_seconds = incident_age_seconds(incident, current)
            incident["ageSeconds"] = age_seconds
            since_notify = max(0, current - last_notified)
            escalated = age_seconds >= watchdog_escalate_seconds() or suppressed >= watchdog_escalate_suppressed()
            # Non-paging capacity and resource signals remain warnings even
            # when they are old or repeatedly observed.
            if is_nonpaging_incident_key(key):
                escalated = False
            should_renotify = since_notify >= watchdog_renotify_seconds()
            if should_renotify:
                incident["lastNotifiedAt"] = now_iso(current)
                incident["lastNotificationSuppressed"] = suppressed
                severity = incident_severity(key, escalated)
                label = "escalated" if escalated else "still open"
                append_log(
                    "renotify_open",
                    {
                        "source": key,
                        "suppressed": suppressed,
                        "ageSeconds": age_seconds,
                        "sinceLastNotifySeconds": since_notify,
                        "escalated": escalated,
                        "evidence": evidence,
                    },
                )
                nonpaging = is_nonpaging_incident_key(key)
                requested_action = incident_requested_action(key, persistent=True)
                written.append(outbox_event(
                    f"BOT ERRORS heartbeat watchdog {label}: {key}",
                    "\n".join([
                        f"source={key}",
                        f"incident_still_open=true",
                        f"escalated={str(escalated).lower()}",
                        f"age_seconds={age_seconds}",
                        f"suppressed_duplicates={suppressed}",
                        f"last_notified={now_iso(last_notified)}",
                        evidence,
                        f"watchdog_state={watchdog_state_path()}",
                        f"watchdog_log={state_root() / 'logs/heartbeat-watchdog.jsonl'}",
                        requested_action,
                    ]),
                    severity,
                    key,
                    force_notify=not nonpaging,
                ))
                continue
            append_log("suppressed_open", {"source": key, "suppressed": suppressed, "evidence": evidence})
            continue
        flap_record = state["recentlyRecovered"].get(key)
        if isinstance(flap_record, dict):
            recovered_at = parse_iso_epoch(flap_record.get("recoveredAt"))
            state["recentlyRecovered"].pop(key, None)
            if recovered_at is not None and max(0, current - recovered_at) < watchdog_flap_rearm_seconds():
                # The condition re-entered stale inside the re-arm window. The
                # FIRST reopen still alerts — a genuinely new outage of a
                # recovered key must page immediately, and one extra message per
                # storm is the accepted price — but SUBSEQUENT reopens within the
                # window are silent: re-paging each oscillation is the
                # alternating stale/recovered storm this latch exists to prevent.
                # History (firstSeenAt, ageSeconds, suppressed count, renotify
                # clock) carries over so age-based escalation and the renotify
                # cadence behave as if the incident never closed.
                state["pendingStale"].pop(key, None)
                prior_flap_count = int_or_zero(flap_record.get("flapCount"))
                flap_count = prior_flap_count + 1
                first_reopen = prior_flap_count == 0
                open_incidents[key] = {
                    "firstSeenAt": flap_record.get("firstSeenAt") or now_iso(current),
                    "lastSeenAt": now_iso(current),
                    "lastNotifiedAt": (
                        now_iso(current)
                        if first_reopen
                        else flap_record.get("lastNotifiedAt") or now_iso(current)
                    ),
                    "lastEvidence": redacted_evidence,
                    "suppressed": int_or_zero(flap_record.get("suppressed")) + 1,
                    "ageSeconds": int_or_zero(flap_record.get("ageSeconds")),
                    "flapCount": flap_count,
                }
                if first_reopen:
                    append_log(
                        "flap_reopen_alert",
                        {"source": key, "flapCount": flap_count, "evidence": evidence},
                    )
                    written.append(outbox_event(
                        open_incident_summary(key),
                        "\n".join([
                            f"source={key}",
                            "incident_reopened=true",
                            f"flap_count={flap_count}",
                            f"first_seen={flap_record.get('firstSeenAt')}",
                            f"recovered_at={flap_record.get('recoveredAt')}",
                            evidence,
                            f"watchdog_state={watchdog_state_path()}",
                            f"watchdog_log={state_root() / 'logs/heartbeat-watchdog.jsonl'}",
                            incident_requested_action(key, persistent=True),
                        ]),
                        incident_severity(key, escalated=True),
                        key,
                    ))
                else:
                    append_log("flap_reopen", {"source": key, "flapCount": flap_count, "evidence": evidence})
                continue
            # Past the window with the problem back: flush any held recovery
            # notice for the settled prior incident, then open a fresh one below.
            if flap_record.get("holdNotice"):
                written.append(deferred_recovery_event(key, flap_record))
                append_log(
                    "recovery_notice_flushed",
                    {"source": key, "flapCount": int_or_zero(flap_record.get("flapCount"))},
                )
        required_stale = watchdog_stale_confirmations()
        if required_stale > 1:
            pending_record = state["pendingStale"].get(key)
            if not isinstance(pending_record, dict):
                pending_record = {"firstObservedAt": now_iso(current)}
            observations = int_or_zero(pending_record.get("observations")) + 1
            pending_record["observations"] = observations
            pending_record["lastEvidence"] = redacted_evidence
            if observations < required_stale:
                state["pendingStale"][key] = pending_record
                append_log(
                    "stale_pending",
                    {
                        "source": key,
                        "observations": observations,
                        "requiredObservations": required_stale,
                        "evidence": evidence,
                    },
                )
                continue
        state["pendingStale"].pop(key, None)
        open_incidents[key] = {
            "firstSeenAt": now_iso(current),
            "lastSeenAt": now_iso(current),
            "lastNotifiedAt": now_iso(current),
            "lastEvidence": redacted_evidence,
            "suppressed": 0,
        }
        new_summary = open_incident_summary(key)
        new_action = incident_requested_action(key)
        written.append(outbox_event(
            new_summary,
            "\n".join([
                f"source={key}",
                evidence,
                f"watchdog_state={watchdog_state_path()}",
                f"watchdog_log={state_root() / 'logs/heartbeat-watchdog.jsonl'}",
                new_action,
            ]),
            incident_severity(key, escalated=True),
            key,
        ))
    for key in sorted(set(open_incidents) - set(problems)):
        if not key_in_active_scope(key, active_prefixes):
            continue
        # #2431: constrain incident-clear to the evaluated instance set only.
        # An incident for a non-evaluated instance must survive the sweep so
        # that a removed/renamed instance does not silently lose its incident.
        if evaluated_instances is not None and key.startswith("local_health:"):
            instance_name = key.removeprefix("local_health:")
            if instance_name not in evaluated_instances:
                continue
        incident = open_incidents[key]
        if not isinstance(incident, dict):
            incident = replacement_incident(current)
            open_incidents[key] = incident
        recovery_observations = int_or_zero(incident.get("recoveryObservations")) + 1
        incident["recoveryObservations"] = recovery_observations
        incident["lastRecoveryObservedAt"] = now_iso(current)
        required_observations = watchdog_recovery_confirmations()
        if recovery_observations < required_observations:
            append_log(
                "recovery_pending",
                {
                    "source": key,
                    "recoveryObservations": recovery_observations,
                    "requiredRecoveryObservations": required_observations,
                    "lastEvidence": incident.get("lastEvidence"),
                },
            )
            continue
        incident = open_incidents.pop(key)
        flap_count = int_or_zero(incident.get("flapCount"))
        state["recentlyRecovered"][key] = {
            "recoveredAt": now_iso(current),
            "firstSeenAt": incident.get("firstSeenAt"),
            "lastNotifiedAt": incident.get("lastNotifiedAt"),
            "lastEvidence": incident.get("lastEvidence"),
            "suppressed": int_or_zero(incident.get("suppressed")),
            "ageSeconds": int_or_zero(incident.get("ageSeconds")),
            "flapCount": flap_count,
            "recoveryObservations": recovery_observations,
            "holdNotice": flap_count > 0,
        }
        if flap_count > 0:
            # A flapping incident's recovery is provisional: inside the re-arm
            # window the same condition reopens silently, so announcing each
            # oscillation as "recovered" is the other half of the alert storm.
            # The notice is deferred until the key stays clean past the window.
            append_log(
                "recovery_held",
                {
                    "source": key,
                    "flapCount": flap_count,
                    "recoveryObservations": recovery_observations,
                },
            )
            continue
        written.append(outbox_event(
            f"BOT ERRORS heartbeat watchdog recovered: {key}",
            "\n".join([
                f"source={key}",
                f"first_seen={incident.get('firstSeenAt')}",
                f"suppressed_duplicates={incident.get('suppressed', 0)}",
                f"recovery_observations={recovery_observations}",
                f"last_evidence={incident.get('lastEvidence')}",
                f"watchdog_state={watchdog_state_path()}",
            ]),
            "info",
            key,
            event_type="clear",
        ))
    for key in sorted(set(state["pendingStale"]) - set(problems)):
        if key_in_active_scope(key, active_prefixes):
            state["pendingStale"].pop(key, None)
    rearm_seconds = watchdog_flap_rearm_seconds()
    for key in sorted(set(state["recentlyRecovered"]) - set(problems)):
        if not key_in_active_scope(key, active_prefixes):
            continue
        record = state["recentlyRecovered"][key]
        if not isinstance(record, dict):
            state["recentlyRecovered"].pop(key, None)
            continue
        recovered_at = parse_iso_epoch(record.get("recoveredAt"))
        if recovered_at is None or max(0, current - recovered_at) >= rearm_seconds:
            state["recentlyRecovered"].pop(key, None)
            if record.get("holdNotice"):
                written.append(deferred_recovery_event(key, record))
                append_log(
                    "recovery_notice_flushed",
                    {"source": key, "flapCount": int_or_zero(record.get("flapCount"))},
                )
    save_state(state)
    return written


@controller_cycle(
    CONTROLLER_LOG_CONTEXT,
    lambda kind, details, level, outcome: append_log(
        kind,
        details,
        level=level,
        outcome=outcome,
    ),
)
def run_once(args: argparse.Namespace) -> int:
    validate_thresholds()
    try:
        checks = configured_checks()
    except ValueError as exc:
        # Configuration error: fail closed (#2465). Do NOT reconcile, refresh
        # state, or print a green-looking result. Exit nonzero with a bounded
        # diagnostic so supervisors see a configuration failure, not success.
        print(f"configuration_error: {exc}", file=sys.stderr)
        print(json.dumps({"time": now_iso(), "verdict": "configuration_error", "error": str(exc)}, sort_keys=True))
        return 2
    evaluated_instances: set[str] = set()
    problems = collect_problems(args, checks, evaluated_instances)
    written = reconcile(problems, active_reconcile_prefixes(checks), evaluated_instances)
    print(json.dumps({
        "time": now_iso(),
        "problems": sorted(problems),
        "eventsWritten": [str(path) for path in written],
    }, sort_keys=True))
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="BOT ERRORS independent heartbeat watchdog")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--max-q-loop-age", type=int, default=positive_env_int_or_default("BOT_ERRORS_MAX_Q_LOOP_AGE", 600))
    parser.add_argument("--max-dispatcher-age", type=int, default=positive_env_int_or_default("BOT_ERRORS_MAX_DISPATCHER_AGE", 300))
    parser.add_argument("--max-collector-age", type=int, default=positive_env_int_or_default("BOT_ERRORS_MAX_COLLECTOR_AGE", 180))
    parser.add_argument("--max-fleet-sentinel-age", type=int, default=positive_env_int_or_default("BOT_ERRORS_MAX_FLEET_SENTINEL_AGE", 2700))
    parser.add_argument("--max-daily-health-age", type=int, default=positive_env_int_or_default("BOT_ERRORS_MAX_DAILY_HEALTH_AGE", 25 * 60 * 60))
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    return run_once(args)


if __name__ == "__main__":
    sys.exit(main())
