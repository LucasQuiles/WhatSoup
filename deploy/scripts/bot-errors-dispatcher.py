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
import stat
import subprocess
import sys
import time
from collections.abc import Mapping
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.bot_errors_daily_health import daily_health_host_from_payload
from lib.bounded_jsonl import (
    append_bounded_jsonl,
    require_bounded_jsonl_commit,
)
from lib.bot_errors_envelope import EnvelopeError, classify_event, new_event_fields, normalize_event
from lib.bot_errors_redaction import redact_bot_errors_text, redact_json_value as redact_shared_json_value
from lib.controller_log import (
    ControllerLogContext,
    controller_cycle,
    metadata_only_controller_details,
    write_controller_log,
)
from lib.controller_state import (
    STATE_RECOVERY_REQUIRED_EXIT,
    ControllerStateRequired,
    emit_state_recovery_fallback,
    open_controller_state,
    state_diagnostic_details,
)
from lib.durable_json import (
    JsonVersion,
    PublicationResult,
    durable_json_target,
    observe_json,
    operation_id,
    publish_event_json,
    publish_state_json,
    require_advance,
    require_all_advance,
)
from lib.state_files import (
    DISPATCHER_META_STATE,
    DISPATCHER_STATE,
    INCIDENT_STATE,
    MAINTENANCE,
)
from lib.state_root import state_root


BOT_ERRORS_JID = os.environ.get("BOT_ERRORS_JID", "").strip()
BOT_ERRORS_EXPECTED_JID = os.environ.get("BOT_ERRORS_EXPECTED_JID", "").strip()
CONTROLLER_LOG_CONTEXT = ControllerLogContext("dispatcher")
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
RECOVERED_BEFORE_DELIVERY_REASON = (
    "incident recovered before its pending alert was delivered; "
    "alert and clear retained as audit-only"
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
# A transient WhatsApp-transport blip (send socket briefly down, "temporarily
# disconnected") rides its own, far longer retry budget so a momentary outage
# never burns the permanent dead-letter cap and strands a deliverable alert.
# Default 240 transient tries × 300s ≈ 20h of coverage before fail-safe dead-letter.
BOT_ERRORS_TRANSIENT_MAX_ATTEMPTS = positive_env_int("BOT_ERRORS_TRANSIENT_MAX_ATTEMPTS", 240)
BOT_ERRORS_TRANSIENT_BACKOFF_SECONDS = positive_env_int("BOT_ERRORS_TRANSIENT_BACKOFF_SECONDS", 300)
DEAD_LETTER_META_ALERT_THROTTLE_SECONDS = 3600  # at most one meta-alert per hour
CLOCK_SKEW_TOLERANCE_SECONDS = 60  # tolerate up to 60s clock skew on clear events
INCIDENT_RENOTIFY_SECONDS = positive_env_int("BOT_ERRORS_INCIDENT_RENOTIFY_SECONDS", 6 * 60 * 60)
INCIDENT_RENOTIFY_CAP_SECONDS = positive_env_int("BOT_ERRORS_INCIDENT_RENOTIFY_CAP_SECONDS", 24 * 60 * 60)
INCIDENT_ESCALATE_SECONDS = positive_env_int("BOT_ERRORS_INCIDENT_ESCALATE_SECONDS", 24 * 60 * 60)
INCIDENT_ESCALATE_SUPPRESSED = positive_env_int("BOT_ERRORS_INCIDENT_ESCALATE_SUPPRESSED", 72)
INCIDENT_STALE_SECONDS = positive_env_int("BOT_ERRORS_INCIDENT_STALE_SECONDS", INCIDENT_ESCALATE_SECONDS)
INCIDENT_STALE_RENOTIFY_SECONDS = positive_env_int("BOT_ERRORS_INCIDENT_STALE_RENOTIFY_SECONDS", 24 * 60 * 60)
INCIDENT_STALE_FAILURE_RETRY_SECONDS = positive_env_int("BOT_ERRORS_INCIDENT_STALE_FAILURE_RETRY_SECONDS", 15 * 60)
INCIDENT_STALE_SWEEP_MAX_EVENTS = positive_env_int("BOT_ERRORS_INCIDENT_STALE_SWEEP_MAX_EVENTS", 3)
# Pattern A — suppress non-actionable (self-healed / no-op) stale renotify.
# Default-on; fail-open (any classifier error falls through to send).
SUPPRESS_STALE_INFO_RENOTIFY = env_flag("BOT_ERRORS_SUPPRESS_STALE_INFO_RENOTIFY", True)
# A2 / §10 C2 — liveness-gated auto-close. Do NOT auto-close a daily-health
# incident as "aged out" while that machine's OWN daily-health monitoring is
# itself stale: when the monitoring path is down, the incident going quiet is
# uninformative (silence is not proof of repair). Bounded by a hold cap so
# openIncidents still cannot grow without limit if monitoring never returns
# (preserves the §10 C5 invariant). Fail-open: any error falls through to close.
AUTOCLOSE_LIVENESS_GATE = env_flag("BOT_ERRORS_AUTOCLOSE_LIVENESS_GATE", True)
AUTOCLOSE_LIVENESS_HOLD_CAP_SECONDS = positive_env_int(
    "BOT_ERRORS_AUTOCLOSE_LIVENESS_HOLD_CAP_SECONDS", INCIDENT_ESCALATE_SECONDS
)
AUTOCLOSE_REOPEN_WINDOW_SECONDS = positive_env_int(
    "BOT_ERRORS_AUTOCLOSE_REOPEN_WINDOW_SECONDS", 30 * 24 * 60 * 60
)
AUTOCLOSE_REOPEN_SAMPLE_LIMIT = positive_env_int("BOT_ERRORS_AUTOCLOSE_REOPEN_SAMPLE_LIMIT", 100)
AUTOCLOSE_PROTECTED_SOURCES = {
    "whatsapp_device_bond_lost",
    "instance_logged_out",
    "signal_cli_unregistered",
}
AUTOCLOSE_PROTECTED_FAILURE_CODES = {
    "WA_AUTH_BOND_SERVER_REVOKED",
}
# Explicit extra sources to force-suppress on stale renotify (CSV), beyond the
# built-in recovery/no-op pattern set and the SSOT action==none signal.
STALE_RENOTIFY_SUPPRESS_SOURCES = {
    part.strip()
    for part in os.environ.get("BOT_ERRORS_STALE_RENOTIFY_SUPPRESS_SOURCES", "").split(",")
    if part.strip()
}
# Recovery / no-op source signatures: definitionally non-actionable once stale.
STALE_RENOTIFY_SUPPRESS_SUFFIXES = ("_restored", "_recovered", "_reverted", "_unknown", "_cleared")
# runtime-tool-error:* — the producer explicitly emits only for operator-actionable
# blocked or infrastructure failures (#2407). Stale incidents must NOT be auto-closed
# without recovery proof. Previously suppressed as "self-corrected" — contradiction
# with producer contract fixed by removing the prefix from stale suppression.
# flap_storm stays exempt (handled above).
STALE_RENOTIFY_SUPPRESS_PREFIXES = ("provider_fallback_",)
# Pattern A (open variant) — suppress the periodic still-open renotify/age-escalation
# for sources that are never operator-actionable even while live. A runtime-tool-error:*
# incident is a collapsed bucket of self-corrected tool failures; the 6h "still open"
# renotify and the age-based escalation re-page it forever with no action to take. The
# genuine stuck-agent signal is flap-storm (intensity), handled earlier via
# force_notify_level, so suppressing the time-based renotify here loses no real signal.
# Default-on; fail-open (any classifier error falls through to send).
SUPPRESS_OPEN_NONACTIONABLE_RENOTIFY = env_flag("BOT_ERRORS_SUPPRESS_OPEN_NONACTIONABLE_RENOTIFY", True)
# Pattern A (digest coalescing) — the auto-close summary is consolidated WITHIN a
# single sweep run, but the sweep runs every ~30s, so a draining backlog emits one
# "Auto-closed N" digest per tick (the digest itself becomes the noise). These are
# strictly informational (requested_action: none). Coalesce the digest across runs:
# closures still happen immediately (so renotify stops), but the WhatsApp summary is
# emitted at most once per window — or sooner if the pending batch is large, so a real
# flood is still reported promptly. Set the window to 0 to restore per-run digests.
def _nonneg_env_int(name: str, default: int) -> int:
    # Like positive_env_int but allows 0 (used as a "disabled" sentinel). Defined
    # inline because env_int is declared later in the module than this constant block.
    try:
        return max(0, int(os.environ.get(name, str(default))))
    except (TypeError, ValueError):
        return default


# 0 disables coalescing (legacy per-sweep digest).
STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS = _nonneg_env_int(
    "BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS", 60 * 60
)
STALE_AUTOCLOSE_DIGEST_MAX_PENDING = max(
    1, _nonneg_env_int("BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_MAX_PENDING", 50)
)
# Pattern F — flap-storm detection (consolidate AND escalate). Default-on;
# fail-open (any flap error falls through to normal per-event handling).
FLAP_DETECTION = env_flag("BOT_ERRORS_FLAP_DETECTION", True)
FLAP_TRIP_THRESHOLD = positive_env_int("BOT_ERRORS_FLAP_TRIP_THRESHOLD", 5)
FLAP_WINDOW_SECONDS = positive_env_int("BOT_ERRORS_FLAP_WINDOW_SECONDS", 600)
FLAP_PROMOTE_SECONDS = positive_env_int("BOT_ERRORS_FLAP_PROMOTE_SECONDS", 1800)
FLAP_CRITICAL_COUNT = positive_env_int("BOT_ERRORS_FLAP_CRITICAL_COUNT", 50)
# Post-promotion reminder backoff (seconds). Each successful critical reminder
# advances to the next step. Exhausting the list repeats the last value.
_FLAP_CADENCE_BACKOFF_DEFAULT = "1800,3600,7200,10800"
FLAP_STORM_CADENCE_BACKOFF_SECONDS = [
    int(x)
    for x in os.environ.get("BOT_ERRORS_FLAP_STORM_CADENCE_BACKOFF", _FLAP_CADENCE_BACKOFF_DEFAULT).split(",")
]
FLAP_STABLE_SECONDS = positive_env_int("BOT_ERRORS_FLAP_STABLE_SECONDS", 3600)
# How long a flapState entry that never opened a storm is kept after its last
# trip. sweep_flap_storms only ever removed entries it RESOLVED, so a key that
# merely tripped a few times was retained forever: the live store had grown to
# 517 entries, including three orphaned hostname generations of one machine
# (a hostname change strands the old key permanently, since incident_key embeds
# the machine name) and entries last seen 47 days earlier.
FLAP_ENTRY_RETENTION_SECONDS = positive_env_int(
    "BOT_ERRORS_FLAP_ENTRY_RETENTION_SECONDS", 604800
)
# #2428: how long a counted event id is remembered after it was last seen in
# the outbox. An undelivered event keeps being seen every scan so it never
# ages out while retries continue; once delivered/quarantined it ages out and
# the memory stays bounded. Default covers the transient-transport retry
# ceiling (240 attempts) with margin.
FLAP_SEEN_EVENT_RETENTION_SECONDS = positive_env_int(
    "BOT_ERRORS_FLAP_SEEN_EVENT_RETENTION_SECONDS", 21600
)
FLAP_SEEN_EVENT_MAX_IDS = positive_env_int("BOT_ERRORS_FLAP_SEEN_EVENT_MAX_IDS", 512)
FLAP_STORM_ACTION = "source unstable — investigate root cause (flap storm)"
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
# For AUTOCLOSE_PROTECTED sources that require outbound proof, a sustained
# stable connection (process uptime above this threshold + zero reconnect
# attempts + verified WhatsApp health) is accepted as an ALTERNATIVE to a
# post-relink outbound send.  A server-revoked bond (WA_AUTH_BOND_SERVER_REVOKED)
# forces a socket disconnect within seconds; a process that has been connected
# for this long with zero reconnect attempts cannot have a revoked bond.  This
# lets low-traffic / allowlist-restricted bots clear ghost bond-lost incidents
# without requiring an organic outbound message that may never come.  Default
# 10 minutes — well past any server-revocation propagation window.
SUSTAINED_STABILITY_MIN_UPTIME_SECONDS = positive_env_int(
    "BOT_ERRORS_SUSTAINED_STABILITY_MIN_UPTIME_SECONDS",
    600,
)
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

# Pattern D — transient-vs-outage severity tiering. Default-on. A failure that
# classifies as transient (recoverable soft-fault: SSH timeout to a peer that is
# still online, a health body that degrades while the WhatsApp link stays
# connected, a provider rate-limit/fallback) is held at warning tier and NOT
# pushed to WhatsApp unless it persists past TRANSIENT_PROMOTE_SECONDS — at which
# point it promotes to the hard-outage (critical) tier and sends. A transient
# that recovers before promotion never reaches WhatsApp at all, and its recovery
# clear stays silent too. Hard outages (host offline, unit crash, logout, bond
# revoked) are never downgraded. FAIL-OPEN: gate off or any classification error
# sends as before — a real alert is never lost to a tiering bug.
TRANSIENT_TIERING_ENABLED = env_flag("BOT_ERRORS_TRANSIENT_TIERING", True)
TRANSIENT_PROMOTE_SECONDS = positive_env_int("BOT_ERRORS_TRANSIENT_PROMOTE_SECONDS", 30 * 60)

# #2409 — cause-aware disposition for health_body_degraded. The producer emits a
# bounded degradation-cause vector; the registered per-cause policy decides
# whether a connected degradation is a soft-fault hold or a visible outage.
DEGRADATION_DISPOSITIONS_PATH = Path(__file__).resolve().parents[2] / "src" / "lib" / "fault-taxonomy-registry.json"
_DEGRADATION_DISPOSITIONS_CACHE: dict[str, Any] = {"loaded": False, "value": None}
_DEGRADATION_CAUSE_TOKEN_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_DEGRADATION_CAUSES_EVIDENCE_RE = re.compile(r"(?:^|\s)degradation_causes=([^\s]*)")


def load_degradation_cause_dispositions() -> dict[str, str] | None:
    """{cause: impactTier} from the registry, or None on ANY integrity failure.

    None means the policy cannot be trusted; the caller must fail toward
    visibility (outage), never toward a blanket hold.
    """
    if _DEGRADATION_DISPOSITIONS_CACHE["loaded"]:
        return _DEGRADATION_DISPOSITIONS_CACHE["value"]
    value: dict[str, str] | None = None
    try:
        with DEGRADATION_DISPOSITIONS_PATH.open("r", encoding="utf-8") as handle:
            registry = json.load(handle)
        block = registry.get("degradationCauseDispositions") if isinstance(registry, dict) else None
        dispositions = block.get("dispositions") if isinstance(block, dict) else None
        if isinstance(dispositions, dict) and dispositions:
            parsed: dict[str, str] = {}
            for cause, entry in dispositions.items():
                tier = entry.get("impactTier") if isinstance(entry, dict) else None
                if not isinstance(cause, str) or tier not in ("page", "hold"):
                    parsed = {}
                    break
                parsed[cause] = tier
            value = parsed or None
    except Exception:  # noqa: BLE001 - unreadable/malformed policy must classify visible, not crash.
        value = None
    _DEGRADATION_DISPOSITIONS_CACHE["loaded"] = True
    _DEGRADATION_DISPOSITIONS_CACHE["value"] = value
    return value


def degradation_causes_from_event(event: dict[str, Any]) -> list[str] | None:
    """Bounded cause tokens from the event, or None when absent/malformed.

    Structured diagnostics outrank evidence parsing: a present-but-invalid
    diagnostics vector is malformed (None), never silently ignored. Evidence
    parsing takes the LAST degradation_causes= reading (multi-poll evidence,
    same last-wins rule as whatsapp_connected=).
    """
    diagnostics = event.get("diagnostics") if isinstance(event.get("diagnostics"), dict) else {}
    structured = diagnostics.get("degradationCauses")
    if structured is not None:
        if (
            isinstance(structured, list)
            and structured
            and all(isinstance(c, str) and _DEGRADATION_CAUSE_TOKEN_RE.match(c) for c in structured)
        ):
            return list(structured)
        return None
    tokens = _DEGRADATION_CAUSES_EVIDENCE_RE.findall(str(event.get("evidence") or ""))
    if not tokens:
        return None
    causes = [c for c in tokens[-1].split(",") if c]
    if not causes or not all(_DEGRADATION_CAUSE_TOKEN_RE.match(c) for c in causes):
        return None
    return causes

# Pattern H — relay-host flap coalescing. The collector emits a relay_host_down
# (warning) when a peer probe misses and a paired relay_host_recovered (info) when
# it returns. Observed flaps recover in ~6 min — one missed probe interval, not an
# outage — yet fan out per host (×N), paging a down AND an up for every blip.
# With the gate on: relay_host_down classifies transient (held by Pattern D's
# machinery, never surfaced unless it persists past TRANSIENT_PROMOTE_SECONDS), and
# a relay_host_recovered whose paired down was held-and-unsurfaced is suppressed
# too — so a self-healed flap pages neither leg. If the down PROMOTED to a real
# outage (or has a surfaced open incident), the recovery is meaningful and sends.
# Default-on. FAIL-OPEN: gate off → relay_host_down classifies outage and the
# recovered sends, exactly as before; any handler error falls through to send.
RELAY_FLAP_COALESCE = env_flag("BOT_ERRORS_RELAY_FLAP_COALESCE", True)
RELAY_DOWN_SOURCE = "relay_host_down"
RELAY_RECOVERED_SOURCE = "relay_host_recovered"

# Reachability diagnoses (collector reachabilityDiagnosis, or source suffix) that
# represent a transient soft-fault: the host is up, a single probe timed out.
TRANSIENT_REACHABILITY_DIAGNOSES = frozenset({"tailscale_online_ssh_timeout"})


def _load_transient_sources() -> frozenset[str]:
    """Exact event-source strings that classify transient, operator-extensible.

    The two concrete classifiers below (reachability timeout, health-body
    degraded while WhatsApp-connected) are verified against real emitted events.
    Provider rate-limit/fallback source names are not yet confirmed against a
    live emitter, so the seed is empty rather than shipping identifiers that
    match nothing (dead config). Operators add confirmed source names via
    BOT_ERRORS_TRANSIENT_SOURCES (comma-separated).
    """
    raw = os.environ.get("BOT_ERRORS_TRANSIENT_SOURCES")
    if not raw:
        return frozenset()
    return frozenset(s.strip() for s in raw.split(",") if s.strip())


TRANSIENT_SOURCES = _load_transient_sources()


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


# These incidents are emitted from the local durability writer and their clear
# can race a new quarantine only across the outbox boundary. Their clear must
# prove a strictly later full timestamp; an equal or unparseable timestamp is
# deliberately left open rather than risking loss of a new alert.
QUARANTINE_INCIDENT_SOURCES = frozenset({
    "outbound_delivery_ambiguous",
    "outbound_delivery_not_attempted",
    "outbound_record_unreconstructable",
    "outbound_quarantine_unclassified",
    "outbound_quarantined",
})


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
        "state": root / DISPATCHER_STATE,
        "incident_state": root / INCIDENT_STATE,
        "meta_state": root / DISPATCHER_META_STATE,
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


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def persist_controller_log_health(paths: dict[str, Path], record: dict[str, Any]) -> None:
    target = _durable_target(
        paths["root"] / "controller-log-health" / "dispatcher.json"
    )
    observation = observe_json(target)
    generation = (observation.version.generation or 0) + 1
    publication_operation = operation_id(
        target,
        record,
        component="dispatcher.controller_log_health",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        record,
        component="dispatcher.controller_log_health",
        operation_id=publication_operation,
        expected=observation.version,
        generation=generation,
    )
    if not publication.advance_allowed:
        require_advance(publication)


def controller_log_fallback(line: str) -> None:
    print(line, file=sys.stderr, flush=True)


MAX_DISPATCH_JSONL_BYTES = positive_env_int("BOT_ERRORS_DISPATCH_JSONL_MAX_BYTES", 50 * 1024 * 1024)


def append_dispatch_log(
    paths: dict[str, Path],
    payload: dict[str, Any],
    *,
    level: str = "info",
    outcome: str = "observed",
) -> str:
    log_path = paths["logs"] / "dispatch.jsonl"
    redacted = redact_shared_json_value(payload, redact)
    record_kind = redacted.get("type") if isinstance(redacted, dict) else None
    if not isinstance(record_kind, str):
        raise ValueError("dispatcher controller log requires a bounded type")
    details = {key: value for key, value in redacted.items() if key != "type"}
    result = write_controller_log(
        context=CONTROLLER_LOG_CONTEXT,
        record_kind=record_kind,
        level=level,
        outcome=outcome,
        durability_class="diagnostic_best_effort",
        details=metadata_only_controller_details(details),
        append_record=lambda record: require_bounded_jsonl_commit(
            append_bounded_jsonl(
                log_path,
                record,
                component="dispatcher.dispatch_log",
                max_bytes=MAX_DISPATCH_JSONL_BYTES,
            )
        ),
        persist_health=lambda record: persist_controller_log_health(paths, record),
        emit_fallback=controller_log_fallback,
    )
    return result


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("event JSON root must be an object")
    return data


# ---------------------------------------------------------------------------
# #2484 — Queue-entry leaf-trust primitives.
#
# Queue consumers (dispatcher, collector, health, watchdog) must not follow
# symlink leaves into targets outside the declared queue root.  The functions
# below inspect the leaf WITHOUT following it, open the leaf with O_NOFOLLOW,
# and verify the opened descriptor is a regular file via fstat.  Parsing
# happens from the already-open descriptor so a pathname reopen cannot be
# substituted between the trust check and the read.
# ---------------------------------------------------------------------------


class UntrustedEntryError(Exception):
    """A queue leaf entry is not a trusted regular file (symlink, dir, device, socket, FIFO)."""


def safe_open_entry(path: Path) -> int:
    """Open a queue-entry leaf without following symlinks.

    Uses ``O_NOFOLLOW`` to reject symlink leaves at the kernel level, then
    verifies the opened descriptor is a regular file via ``fstat``.
    Returns the file descriptor.  Raises :class:`UntrustedEntryError` for
    symlinks, directories, devices, sockets, FIFOs, or other non-regular
    entries.
    """
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as exc:
        # O_NOFOLLOW raises ELOOP (Linux) or ENOTSUP/EMLINK (macOS) when the
        # final path component is a symlink.  Any other OSError (EACCES,
        # ENOENT, etc.) is also treated as an untrusted/unreadable entry.
        raise UntrustedEntryError(f"entry is not a regular file: {exc}") from exc
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            os.close(fd)
            raise UntrustedEntryError("entry is not a regular file")
        return fd
    except UntrustedEntryError:
        raise
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise


def safe_read_json(path: Path) -> dict[str, Any]:
    """Read JSON from a queue entry without following symlinks.

    Opens the leaf with ``O_NOFOLLOW``, verifies it is a regular file, then
    parses from the open descriptor.  Raises :class:`UntrustedEntryError` for
    non-regular entries; :class:`ValueError` if the root is not a JSON object.
    """
    fd = safe_open_entry(path)
    try:
        with os.fdopen(fd, "r", encoding="utf-8", closefd=True) as handle:
            data = json.load(handle)
        if not isinstance(data, dict):
            raise ValueError("event JSON root must be an object")
        return data
    except UntrustedEntryError:
        raise
    except Exception:
        raise


def safe_is_regular_entry(path: Path) -> bool:
    """Check whether a path is a regular file, without following symlinks.

    Uses ``lstat`` to inspect the leaf itself.  Returns ``True`` only for
    regular files (not symlinks, directories, devices, sockets, or FIFOs).
    """
    try:
        st = path.lstat()
        return stat.S_ISREG(st.st_mode)
    except (OSError, ValueError):
        return False


def is_durable_internal_entry(path: Path) -> bool:
    name = path.name
    return name == ".durable-json.lock" or (
        name.startswith(".durable-json.") and name.endswith(".tmp")
    )


def safe_is_data_entry(path: Path) -> bool:
    return not is_durable_internal_entry(path) and safe_is_regular_entry(path)


def quarantine_untrusted_entry(path: Path, quarantine_dir: Path, reason: str) -> Path:
    """Quarantine an untrusted queue entry without dereferencing its target.

    Moves the directory entry itself (the link, not the target) into the
    quarantine directory.  Never reads, copies, or opens the target bytes.
    """
    ensure_private_dir(quarantine_dir)
    dest = quarantine_dir / f"{path.name}.{int(time.time())}.{os.getpid()}.untrusted"
    try:
        # shutil.move on a symlink moves the link itself, not the target.
        shutil.move(str(path), str(dest))
    except FileNotFoundError:
        pass
    return dest


def redact_dispatcher_text(value: Any) -> str:
    return redact_bot_errors_text(value, credential_path_marker="[REDACTED CREDENTIAL PATH]")


# ---------------------------------------------------------------------------
# #2723 R5.1/R5.2 — Controller-state session adoption + IncidentStateCycle
# ---------------------------------------------------------------------------
# Replaces corrupt-file-archive load_incident_state and path-based
# save_incident_state with ControllerStateSession and the IncidenStateCycle
# adapter.  Schema: bootstrap/validate/reconcile/project/open follow the
# established collector.py/watchdog.py pattern.

DISPATCHER_STATE_LOCK_TIMEOUT_SECONDS = 30.0


def dispatcher_bootstrap_state() -> dict[str, Any]:
    """#2723 R5.1: bootstrap an empty incident-state payload."""
    return {
        "version": 1,
        "openIncidents": {},
        "lastSentAt": {},
    }


def json_snapshot(payload: Any) -> Any:
    """Independent deep copy of a JSON-shaped payload: the file's ONE snapshot idiom.

    Shared by :func:`validate_dispatcher_state` and the claimed-event snapshot in
    :func:`process_one`. Both take an independent copy of parsed JSON so later
    mutation cannot reach it, and both must agree on how deep a payload they
    accept -- so there is one implementation rather than two.

    A JSON round-trip, deliberately, NOT ``copy.deepcopy``. ``deepcopy``
    consumes roughly twice the interpreter stack per nesting level, which cost
    ``process_one`` half its tolerated event depth when it was used here
    (#3404 follow-up): events the dispatcher's own reader accepts, and that it
    had always handled, began raising ``RecursionError`` mid-cycle. The
    round-trip tolerates an order of magnitude more nesting.

    The round-trip is structural identity for these inputs rather than a
    coincidence: events arrive through ``safe_read_json`` and state through the
    controller store, so every member is already JSON-serialisable.

    RAISES rather than deciding: ``RecursionError`` for a payload nested past
    the encoder's limit, ``TypeError``/``ValueError`` for a member JSON cannot
    represent. The failure mode belongs to the caller -- ``process_one``
    quarantines the event as poison so one bad event cannot abort the pass,
    while ``validate_dispatcher_state`` lets it propagate as it always has.
    """
    return json.loads(json.dumps(payload))


def validate_dispatcher_state(payload: Any) -> dict[str, Any]:
    """#2723 R5.1: validate and sanitise incident-state payload.

    Strips internal ``_controllerState`` key, preserves all incident-state
    sections as-is (openIncidents, lastSentAt, flapState, transientState,
    staleAutocloseDigest, staleAutocloseHistory, promotionSafety,
    dailyHealthFreshness, currentEpisodeId, testLeakDaily).  Fails hard on
    non-dict root.
    """
    if not isinstance(payload, dict):
        raise ValueError("dispatcher incident state root must be an object")
    sanitized: dict[str, Any] = {
        key: value
        for key, value in payload.items()
        if key != "_controllerState"
    }
    # Ensure the two core sections exist as dicts (callers write into them).
    if not isinstance(sanitized.setdefault("openIncidents", {}), dict):
        raise ValueError("dispatcher state openIncidents must be an object")
    if not isinstance(sanitized.setdefault("lastSentAt", {}), dict):
        raise ValueError("dispatcher state lastSentAt must be an object")
    return json_snapshot(sanitized)


def redacted_dispatcher_payload(value: Any) -> Any:
    """#2723 R5.1: redact dispatcher incident-state payload.

    Dispatcher state carries no per-event credential paths (these live in
    the queue events, not in aggregated incident state).  Currently a
    pass-through; inject shared-json redaction if future state sections
    embed credential-bearing text.
    """
    return redact_shared_json_value(value, redact_dispatcher_text)


def reconcile_recovered_dispatcher_state(
    payload: Any,
) -> tuple[dict[str, Any], str]:
    """#2723 R5.2: reconcile a recovered incident-state payload.

    Validated-previous-only: accept the recovered payload as-is after
    validation.  No mutation of membership, counters, clocks, or
    bookkeeping beyond what validate_dispatcher_state enforces.
    """
    return validate_dispatcher_state(payload), "validated_previous_only"


def project_dispatcher_state_mode(diagnostic: Any) -> str:
    """#2723 R5.7: project diagnostic details, stripping schemaVersion.

    schemaVersion is a reserved controller-log record field; the record
    envelope owns it, the closed diagnostic details must not shadow it.
    Follows the same pattern as collector.py:1695-1717.
    """
    details = metadata_only_controller_details(
        {
            key: value
            for key, value in state_diagnostic_details(diagnostic).items()
            if key != "schemaVersion"
        }
    )
    failed = getattr(diagnostic, "mode", None) == "recovery_required"
    log_path = state_root() / "logs" / "dispatcher.jsonl"
    return write_controller_log(
        context=CONTROLLER_LOG_CONTEXT,
        record_kind="controller_state_mode",
        level="error" if failed else "info",
        outcome="failed" if failed else "observed",
        durability_class="diagnostic_best_effort",
        details=details,
        append_record=lambda record: append_private_jsonl(log_path, record),
        persist_health=lambda record: persist_controller_log_health(
            state_paths(), record
        ),
        emit_fallback=lambda _line: emit_state_recovery_fallback(diagnostic),
    )


def open_dispatcher_state_session():
    """#2723 R5.1/R5.3: open controller state session for incident state.

    Returns the session (context-manager) or propagates
    ControllerStateRequired if the state directory/file is unsafe, locked,
    or corrupt beyond recovery.
    """
    anchor = state_root() / INCIDENT_STATE
    return open_controller_state(
        anchor,
        component="dispatcher-incident",
        bootstrap=dispatcher_bootstrap_state,
        validate_payload=validate_dispatcher_state,
        lock_timeout_seconds=DISPATCHER_STATE_LOCK_TIMEOUT_SECONDS,
    )


class IncidentStateCycle:
    """#2723 R5.2: session adapter bridging incident-state access to
    ControllerStateSession.

    Wraps a loaded session with a mutable ``payload`` dict and a
    ``commit()`` method that sets ``updatedAt``, redacts, persists via
    ``session.save()``, consumes the capability, and installs the next one.

    Construction is intentionally simple — the payload starts from the
    session's loaded payload after reconciliation; callers mutate
    ``.payload`` directly (as they did with the raw dict from
    ``load_incident_state``), then call ``.commit()`` at each semantic
    save barrier.

    ``commit()`` returns the ``PublicationResult`` so callers that batch
    publication results (e.g. ``collapse_storm_group`` with
    ``require_all_advance``) can still collect it.
    """

    def __init__(self, session: Any, payload: dict[str, Any], capability: Any, paths: dict[str, Path] | None = None):
        self._session = session
        self._payload = payload
        self._capability = capability
        self._paths = paths

    @property
    def payload(self) -> dict[str, Any]:
        """The mutable incident-state dict that downstream functions write into."""
        return self._payload

    def commit(self) -> Any:
        """Set ``updatedAt``, redact, persist, and advance the capability.

        Returns the ``PublicationResult`` from ``session.save()``.
        Also writes the raw incident state file so test
        ``readIncidentState`` surfaces the updated payload
        (#3053 regression fix — IncidentStateCycle diverts
        persistence away from save_incident_state).
        """
        self._payload["updatedAt"] = now_iso()
        redacted = redacted_dispatcher_payload(self._payload)
        result = self._session.save(redacted, self._capability)
        self._capability = result.capability
        # #3053: co-write removed — session save() already writes primary via _atomic_bytes
        return result


# ---------------------------------------------------------------------------
# Session-backed compat wrappers for load_incident_state / save_incident_state
# (RESTORE-COMPAT per Q53 conformance spec — preserves historical calling
# conventions so 33+ callers work without immediate migration).
# ---------------------------------------------------------------------------


def load_incident_state(paths: dict[str, Path]) -> dict[str, Any]:
    """RESTORE-COMPAT compat wrapper — reads state file directly.

    Uses ``validate_dispatcher_state`` (the session's validator) to
    sanitise the loaded payload, and falls back to bootstrap on missing
    or corrupt files.  Avoids the session lock overhead so callers that
    load→mutate→save in sequence don't contending on the same file lock.

    Uses ``paths["incident_state"]`` (canonical ``state_paths()`` path).
    """
    incident_path = paths.get("incident_state")
    if incident_path is None or not incident_path.exists():
        return dispatcher_bootstrap_state()
    try:
        loaded = read_json(incident_path)
    except Exception:  # noqa: BLE001 - never fail on corrupt state
        return dispatcher_bootstrap_state()
    try:
        return validate_dispatcher_state(loaded)
    except (ValueError, TypeError):
        return dispatcher_bootstrap_state()


class _CompatPublication:
    """Wraps ``StateCommitResult`` to satisfy ``PublicationResult`` interface.

    Callers pass the return value to ``require_all_advance`` which expects
    ``advance_allowed``, ``error_class``, and ``public_projection()``.
    """

    __slots__ = ("advance_allowed", "error_class")

    def __init__(self, commit: StateCommitResult) -> None:
        self.advance_allowed: bool = commit.mode in ("valid", "reconciled")
        self.error_class: Any = None

    def public_projection(self) -> dict[str, Any]:
        return {"advance_allowed": self.advance_allowed}


def save_incident_state(
    paths: dict[str, Path],
    state: dict[str, Any],
) -> PublicationResult:
    """RESTORE-COMPAT compat wrapper — uses ``publish_state_json`` directly.

    Sets ``updatedAt``, redacts via ``redacted_dispatcher_payload``,
    persists via ``publish_state_json`` (the original mechanism),
    and returns a ``PublicationResult`` compatible with
    ``require_all_advance``.

    Avoids the session lock overhead so callers that load→mutate→save
    in sequence don't contend on the same file lock.
    """
    incident_path = paths.get("incident_state")
    if incident_path is None:
        raise ValueError("save_incident_state: paths missing incident_state key")
    _reject_bare_write_if_adopted(incident_path)
    state["updatedAt"] = now_iso()
    target = _durable_target(incident_path)
    observation = observe_json(target)
    _reject_bare_write_over_envelope(incident_path, observation.payload)
    generation = (observation.version.generation or 0) + 1
    publication_operation = operation_id(
        target,
        redacted_dispatcher_payload(state),
        component="dispatcher.incident_state",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        redacted_dispatcher_payload(state),
        component="dispatcher.incident_state",
        operation_id=publication_operation,
        expected=observation.version,
        generation=generation,
    )
    require_advance(publication)
    return publication

# Exit status for a refused post-adoption bare write reached in daemon mode.
# Distinct from STATE_RECOVERY_REQUIRED_EXIT (78): that path carries a
# controller-state diagnostic and runs the recovery projection. This one is a
# programming error (a helper reached save_incident_state without its
# IncidentStateCycle) and must stop the loop loudly rather than fail every
# cycle in silence. Restart=always brings the unit back; the deadman then
# reports cycle_stale once the staleness outgrows what the restart explains.
INCIDENT_CYCLE_REQUIRED_EXIT = 79


# Exit status for a refused post-adoption bare write reached in daemon mode.
# Distinct from STATE_RECOVERY_REQUIRED_EXIT (78): that path carries a
# controller-state diagnostic and runs the recovery projection. This one is a
# programming error (a helper reached save_incident_state without its
# IncidentStateCycle) and must stop the loop loudly rather than fail every
# cycle in silence. Restart=always brings the unit back; the deadman then
# reports cycle_stale once the staleness outgrows what the restart explains.
INCIDENT_CYCLE_REQUIRED_EXIT = 79


class IncidentCycleRequiredError(RuntimeError):
    """#3054: a cycle-accepting helper was called post-adoption without the
    ``IncidentStateCycle``.

    Post-adoption (the state dir carries the ``.initialized`` marker) the
    incident-state primary is enveloped (``_controllerState``). Routing a
    state write through ``save_incident_state`` — the RESTORE-COMPAT
    bare-JSON wrapper — would overwrite the enveloped primary with bare
    JSON, so the next ``session.save()`` / ``_validate_envelope`` rejects
    it with ``schema_incompatible``: the corruption class #3053 fixed.
    Raising at the helper boundary fails the regression loudly instead of
    silently corrupting state. Pre-adoption (no ``.initialized``) the bare
    write is still the legitimate legacy/compat path, so the guard is inert.
    """


def _incident_state_is_adopted(anchor: Path) -> bool:
    """True when the incident-state dir carries the ``.initialized`` marker.

    Single definition of "adopted" so the helper-boundary guard and the
    writer-level guard cannot drift apart.
    """
    return (anchor.parent / (anchor.name + ".initialized")).exists()


def _reject_bare_write_if_adopted(anchor: Path) -> None:
    """#3054 writer-level guard — refuse a bare-JSON write post-adoption.

    ``_require_incident_cycle_if_adopted`` is a *helper-boundary* check: it
    is inert whenever a cycle was supplied, because its question is "does a
    cycle exist?". That is not the same question as "does this write use
    the cycle?", so a helper could pass the boundary guard with
    ``incident`` in hand and still reach ``save_incident_state`` on a later
    branch — overwriting the ``_controllerState`` envelope with bare JSON
    and producing the ``schema_incompatible`` corruption #3053 fixed.

    Guarding inside the writer closes that gap for every call site at once,
    including ones added later, because the bare write is never legitimate
    post-adoption. Pre-adoption (no ``.initialized``) the bare write is
    still the correct legacy/compat path, so this stays inert there.
    ``IncidentStateCycle.commit()`` persists through ``session.save()`` and
    never routes here, so the supported path is unaffected.
    """
    if _incident_state_is_adopted(anchor):
        raise IncidentCycleRequiredError(
            f"save_incident_state: refusing a post-adoption bare-JSON write to "
            f"{anchor.name}. The incident-state primary is enveloped "
            f"(_controllerState); this wrapper would overwrite it and the next "
            f"validate would reject it as schema_incompatible (#3053/#3054). "
            f"Route this write through IncidentStateCycle.commit()."
        )


def _reject_bare_write_over_envelope(anchor: Path, observed: Mapping[str, Any] | None) -> None:
    """Second half of the writer guard: never overwrite an observed envelope.

    ``_reject_bare_write_if_adopted`` reads the ``.initialized`` marker before
    the write observes the file, and adoption takes a different lock
    (``incident-state.json.lock``) from the bare publisher
    (``.durable-json.lock``), so a bare caller can pass the marker check while
    adoption completes underneath it. The write publishes against
    ``observation.version``: if adoption landed after the observation the
    compare-and-swap refuses the write, and if it landed before, the observed
    payload already carries ``_controllerState`` and this check refuses it.
    Together the marker check, this check, and the CAS leave no window in
    which bare JSON can replace the envelope.
    """
    if isinstance(observed, Mapping) and "_controllerState" in observed:
        raise IncidentCycleRequiredError(
            f"save_incident_state: refusing to overwrite the enveloped incident "
            f"state at {anchor.name} with bare JSON (observed _controllerState "
            f"without the adoption marker). Route this write through "
            f"IncidentStateCycle.commit()."
        )


def _reject_bare_write_over_envelope(anchor: Path, observed: Mapping[str, Any] | None) -> None:
    """Second half of the writer guard: never overwrite an observed envelope.

    ``_reject_bare_write_if_adopted`` reads the ``.initialized`` marker before
    the write observes the file, and adoption takes a different lock
    (``incident-state.json.lock``) from the bare publisher
    (``.durable-json.lock``), so a bare caller can pass the marker check while
    adoption completes underneath it. The write publishes against
    ``observation.version``: if adoption landed after the observation the
    compare-and-swap refuses the write, and if it landed before, the observed
    payload already carries ``_controllerState`` and this check refuses it.
    Together the marker check, this check, and the CAS leave no window in
    which bare JSON can replace the envelope.
    """
    if isinstance(observed, Mapping) and "_controllerState" in observed:
        raise IncidentCycleRequiredError(
            f"save_incident_state: refusing to overwrite the enveloped incident "
            f"state at {anchor.name} with bare JSON (observed _controllerState "
            f"without the adoption marker). Route this write through "
            f"IncidentStateCycle.commit()."
        )


def _require_incident_cycle_if_adopted(
    paths: dict[str, Path],
    incident: "IncidentStateCycle | None",
    *,
    helper: str,
) -> None:
    """#3054 guard — fail closed when a cycle-accepting helper is invoked
    post-adoption without the ``IncidentStateCycle``.

    Inert when ``incident`` is provided (the session save path) or when the
    state dir is not yet adopted (no ``.initialized`` marker beside the
    incident-state anchor — the bare ``save_incident_state`` write is the
    correct legacy/compat path there). The legacy-adoption read path in
    ``controller_state`` (``.initialized`` absent → ``legacy_valid``) is
    untouched: this guard only restrains writes, never reads.
    """
    if incident is not None:
        return
    anchor = paths.get("incident_state")
    if anchor is None:
        return
    if _incident_state_is_adopted(anchor):
        raise IncidentCycleRequiredError(
            f"{helper}: post-adoption incident-state write requires the "
            f"IncidentStateCycle (incident=None would route through "
            f"save_incident_state's bare-JSON wrapper and corrupt the "
            f"_controllerState envelope — #3053/#3054)."
        )

def record_daily_health_freshness(event: dict[str, Any], incident_state: dict[str, Any]) -> str | None:
    """Stamp per-host daily-health liveness into the durable freshness ledger.

    Any ``daily-health*`` event (info cadence, ``daily-health-fail``, recovery) is
    proof that host's daily-health monitor is alive and reporting, so it refreshes
    liveness. The heartbeat-watchdog reads this ledger instead of scanning the
    FIFO-pruned suppressed/ archive — decoupling liveness from a garbage-collected
    directory, the root cause of the mass "cadence stale" false positives. The host
    key is the shared canonical key so the write and the watchdog lookup cannot
    drift. Returns the host recorded, or ``None`` when the event is not daily-health,
    no host can be derived, or the event's own observation time cannot be trusted
    (the watchdog then falls back to a file scan).

    The stamp uses the event's own ``createdAt`` as the observation time — never
    the dispatch wall-clock (TRUTH-01) — so a backlogged event processed long
    after it was produced does not read as "just seen". Fails closed: a missing
    or malformed ``createdAt`` records nothing rather than manufacturing
    freshness from "now", and never clobbers a prior good stamp.

    Monotonic: a stamp is written only when the event's observation time is
    STRICTLY newer than the host's current ledger entry (an absent or corrupt
    entry counts as -infinity, i.e. always write). Event-own-time semantics
    make this a real edge that dispatch-wall-clock stamping never had — real
    time only moves forward, but a backlogged file surfacing out of order, a
    delayed replay, or storm-collapse/dedupe absorbing members out of
    creation order can all present a genuinely OLDER event after a fresher
    one already stamped the ledger. Without this guard that would rewind the
    ledger and manufacture a false "cadence stale" alert for a host that is
    actually live — the same failure class this fix closes, reopened through
    a new seam. Returns ``None`` (no write) both when the event cannot be
    attributed to a host/time at all, and when it can but loses to an
    already-fresher stamp.
    """
    source = str(event.get("source") or "")
    if not source.startswith("daily-health"):
        return None
    host = daily_health_host_from_payload(event)
    if not host:
        return None
    observed_epoch = event_created_epoch(event)
    if observed_epoch is None:
        return None
    ledger = incident_state.setdefault("dailyHealthFreshness", {})
    if not isinstance(ledger, dict):
        ledger = {}
        incident_state["dailyHealthFreshness"] = ledger
    existing = ledger.get(host)
    existing_last_seen = existing.get("lastSeenAt") if isinstance(existing, dict) else None
    if isinstance(existing_last_seen, int) and observed_epoch <= existing_last_seen:
        return None
    ledger[host] = {"lastSeenAt": observed_epoch, "lastSeenIso": iso_from_epoch(observed_epoch)}
    return host


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


def incident_source_fingerprint(raw_source: str) -> str:
    """#2507: content-addressable source fingerprint (16 hex chars from SHA256)
    to disambiguate values that safe_segment would collapse together
    (e.g. 'collector:writefail' vs 'collector.writefail' vs 'collector@writefail')."""
    return hashlib.sha256(raw_source.encode()).hexdigest()[:16]


_SAFE_SEGMENT_KEPT = re.compile(r"^[A-Za-z0-9_.:-]+$")


def _safe_segment_is_lossy(value: str) -> bool:
    """True when safe_segment would mutate characters in `value`."""
    return not bool(_SAFE_SEGMENT_KEPT.match(value.strip()))


def incident_key(event: dict[str, Any]) -> str:
    machine = safe_segment(str(event.get("machine") or "unknown"))
    instance = safe_segment(str(event.get("instance") or "unknown"))
    source = incident_source(event)
    segment = safe_segment(source)
    # #2507: when safe_segment would collapse distinct source values
    # (e.g. collector:writefail vs collector.writefail vs
    # collector@writefail → all become collector_writefail), append a
    # content-addressable fingerprint so keys remain distinct.
    if _safe_segment_is_lossy(source):
        segment += "." + incident_source_fingerprint(source)
    return "|".join([machine, instance, segment])


def legacy_unqualified_incident_key(event: dict[str, Any]) -> str | None:
    source = str(event.get("source") or "unknown")
    qualified_source = incident_source(event)
    if qualified_source == source:
        return None
    machine = safe_segment(str(event.get("machine") or "unknown"))
    instance = safe_segment(str(event.get("instance") or "unknown"))
    segment = safe_segment(source)
    if _safe_segment_is_lossy(source):
        segment += "." + incident_source_fingerprint(source)
    return "|".join([machine, instance, segment])


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
    return classify_event(event).kind == "incident_alert"


def is_incident_clear(event: dict[str, Any]) -> bool:
    return classify_event(event).kind == "incident_recovery"


def is_daily_health_clear(event: dict[str, Any]) -> bool:
    return is_incident_clear(event) and str(event.get("source") or "") == "daily-health"


def maintenance_state_path() -> Path:
    """Path to the maintenance-window state file.

    MUST match ``bot-errors-maintenance.py``'s resolution so the CLI and the
    dispatcher agree on a single file (``BOT_ERRORS_STATE_DIR`` honored).
    """
    return state_root() / MAINTENANCE


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


def _truthy_token(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def classify_failure_mode(event: dict[str, Any]) -> str:
    """Classify an alert as ``"transient"`` (recoverable soft-fault) or ``"outage"``.

    Conservative by design: only well-understood soft-faults classify transient.
    Everything else — including anything ambiguous or unknown — classifies
    ``"outage"`` so a real failure is never silently downgraded (fail toward
    visibility). Pattern D.
    """
    source = str(event.get("source") or "")
    diagnostics = event.get("diagnostics") if isinstance(event.get("diagnostics"), dict) else {}
    evidence = str(event.get("evidence") or "")

    # SSH timeout to a peer Tailscale still reports online: host is up, the probe
    # timed out — transient.
    diagnosis = str(diagnostics.get("reachabilityDiagnosis") or "")
    if diagnosis in TRANSIENT_REACHABILITY_DIAGNOSES:
        return "transient"
    if source.endswith("_online_ssh_timeout"):
        return "transient"

    # Health body degraded (#2409): the connected bond is one input, not the
    # impact classifier. Every cause in the producer's vector must carry a
    # registered hold-class disposition for the event to be held; a page-class
    # cause, an absent/malformed/unknown vector, or an untrusted policy all
    # classify outage (fail toward visibility). This branch returns for the
    # source unconditionally, so the BOT_ERRORS_TRANSIENT_SOURCES escape below
    # deliberately cannot re-hold a disconnected or page-class degradation.
    if source == "health_body_degraded":
        connected = diagnostics.get("whatsappConnected")
        if connected is None:
            # Last-wins: a multi-poll evidence block may carry several
            # whatsapp_connected= readings; the most recent one decides. A later
            # =false must not be masked by an earlier =true (would mis-hold a real
            # disconnect as transient).
            tokens = re.findall(r"(?:^|\s)whatsapp_connected=([^\s]+)", evidence)
            connected = _truthy_token(tokens[-1]) if tokens else False
        else:
            connected = bool(connected)
        if not connected:
            return "outage"
        causes = degradation_causes_from_event(event)
        if not causes:
            return "outage"
        dispositions = load_degradation_cause_dispositions()
        if dispositions is None:
            return "outage"
        if all(dispositions.get(cause) == "hold" for cause in causes):
            return "transient"
        return "outage"

    # Operator-confirmed transient source names (provider rate-limit/fallback,
    # model-unknown) via BOT_ERRORS_TRANSIENT_SOURCES.
    if source in TRANSIENT_SOURCES:
        return "transient"

    # Pattern H — a relay-host probe miss is a recoverable soft-fault: hold it so a
    # ~6-min self-healing flap never surfaces; Pattern D promotes it to an outage
    # only if the host stays down past the promote window.
    if RELAY_FLAP_COALESCE and source == RELAY_DOWN_SOURCE:
        return "transient"

    return "outage"


def apply_transient_tiering(
    event: dict[str, Any], incident_state: dict[str, Any], key: str, current: int
) -> str | None:
    """Hold or promote a transient alert (Pattern D).

    Returns a suppress-reason string to HOLD the alert (transient still inside the
    soft window — not pushed to WhatsApp), or ``None`` to SEND it (not transient,
    or persisted past the promote window so it is now a hard outage, or any
    classification error → fail-open send).

    Bookkeeping lives in ``incident_state['transientState'][key]`` — a sidecar
    that never touches ``flapState``, so Pattern F accumulation is preserved
    (design constraint C1). Mutates ``event['severity']`` to ``warning`` while
    held and restores ``critical`` on promotion.
    """
    try:
        if classify_failure_mode(event) != "transient":
            return None
        transient_state = incident_state.setdefault("transientState", {})
        if not isinstance(transient_state, dict):
            return None
        record = transient_state.get(key)
        if not isinstance(record, dict):
            record = {
                "transientSince": current,
                "firstSeverity": str(event.get("severity") or ""),
            }
            transient_state[key] = record
        since = int_field(record, "transientSince", current)
        record["lastSeenAt"] = current
        elapsed = max(0, current - since)
        diagnostics = event.setdefault("diagnostics", {})

        if record.get("promoted") or elapsed >= TRANSIENT_PROMOTE_SECONDS:
            # Persisted past the promote window (or already promoted): a slow
            # outage masquerading as transient. Restore the hard-outage tier and
            # let normal open-incident handling send it. Guards the false-negative
            # direction (a real outage misread as transient).
            record["promoted"] = True
            record["promotedAt"] = int_field(record, "promotedAt", current)
            event["severity"] = str(record.get("firstSeverity") or "critical") or "critical"
            diagnostics["failureClass"] = "outage_promoted"
            diagnostics["transientPromoted"] = True
            return None

        # Still inside the soft window: hold at warning tier, do not push.
        event["severity"] = "warning"
        held = int_field(record, "heldCount") + 1
        record["heldCount"] = held
        diagnostics["failureClass"] = "transient"
        diagnostics["transientHeld"] = True
        return (
            f"transient_held: {key} warning-tier "
            f"({elapsed}s/{TRANSIENT_PROMOTE_SECONDS}s to promote, held x{held})"
        )
    except Exception:
        # FAIL-OPEN: never lose a real alert to a tiering bug.
        return None


def resolve_transient_on_clear(
    event: dict[str, Any], incident_state: dict[str, Any], key: str
) -> str | None:
    """Retire transient bookkeeping on a clear (Pattern D).

    Returns a suppress-reason when the transient was HELD (never surfaced) so its
    recovery stays silent too; ``None`` when it had PROMOTED to an outage (let
    normal clear handling close the surfaced incident) or no transient record
    exists. Fail-open: any error → ``None`` (let the clear flow).
    """
    try:
        transient_state = incident_state.get("transientState")
        if not isinstance(transient_state, dict):
            return None
        record = transient_state.pop(key, None)
        if not isinstance(record, dict):
            return None
        if record.get("promoted"):
            return None  # promoted to outage — normal clear closes the open incident
        event.setdefault("diagnostics", {})["transientAutoresolved"] = True
        return f"transient_autoresolved: {key} recovered before promotion; held recovery not surfaced"
    except Exception:
        return None


def coalesce_relay_recovered(event: dict[str, Any], incident_state: dict[str, Any]) -> str | None:
    """Suppress a relay_host_recovered whose paired down was held silently (Pattern H).

    #2419: the collector now emits recovery as a typed SAME-SOURCE clear
    (event_type="clear", source="relay_host_down"), which the standard Pattern D
    clear path handles end-to-end: a held transient retires silently via
    resolve_transient_on_clear, a surfaced outage pops via mark_incident_sent.
    This function remains ONLY for legacy in-flight events that still carry
    source="relay_host_recovered"; new-format clears never enter it. Legacy
    pairing is by source-segment substitution:

    - paired down is a SURFACED open incident → the recovery is news → ``None`` (send).
    - paired down is a HELD, unpromoted transient → never surfaced → suppress the
      recovery and retire the held record (a self-healed flap pages neither leg).
    - paired down PROMOTED to an outage → recovery is meaningful → ``None`` (send).
    - no record at all → fail toward visibility → ``None`` (send): we cannot prove
      the down was held, so we never silence a recovery the operator may have been
      waiting on.

    FAIL-OPEN: gate off or any error → ``None`` (send), exactly as before.
    """
    try:
        if not RELAY_FLAP_COALESCE:
            return None
        if str(event.get("source") or "") != RELAY_RECOVERED_SOURCE:
            return None
        recovered_key = incident_key(event)
        down_key = recovered_key.replace(RELAY_RECOVERED_SOURCE, RELAY_DOWN_SOURCE, 1)
        # A surfaced (open) down means the operator saw the outage — let recovery send.
        open_incidents = incident_state.get("openIncidents")
        if isinstance(open_incidents, dict) and isinstance(open_incidents.get(down_key), dict):
            return None
        transient_state = incident_state.get("transientState")
        record = transient_state.get(down_key) if isinstance(transient_state, dict) else None
        if not isinstance(record, dict):
            return None  # no held record — fail toward visibility, send the recovery
        if record.get("promoted"):
            return None  # outage was surfaced — recovery is meaningful
        transient_state.pop(down_key, None)  # retire the held flap
        event.setdefault("diagnostics", {})["relayFlapCoalesced"] = True
        return (
            f"relay_flap_coalesced: {down_key} recovered before promotion; "
            f"held flap not surfaced (down+up both silent)"
        )
    except Exception:
        return None  # FAIL-OPEN: never lose a recovery to a coalescing bug


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
    if evidence_field(probe, "outbound_success_evidence") != "provider_acknowledged_or_better":
        return False
    return evidence_epoch(probe, "outbound_success_at") is not None


def has_post_incident_outbound_proof(probe: str, record: dict[str, Any], opened_epoch: int) -> bool:
    """True iff the probe carries an outbound send timestamp strictly AFTER the
    incident opened.  This is the original proof path for AUTOCLOSE_PROTECTED
    sources: a successful outbound send after the relink proves the server-side
    bond is alive.
    """
    if evidence_field(probe, "outbound_success_evidence") != "provider_acknowledged_or_better":
        return False
    outbound_epoch = evidence_epoch(probe, "outbound_success_at")
    if outbound_epoch is None:
        return False
    opened_at = int_field(record, "openedAt", opened_epoch)
    required_after = max(opened_epoch, opened_at)
    if required_after > 0 and outbound_epoch <= required_after:
        return False
    return True


def has_sustained_connection_stability(probe: str) -> bool:
    """True iff the probe shows a WhatsApp connection that has been continuously
    stable long enough to rule out a server-side bond revocation.

    A ``WA_AUTH_BOND_SERVER_REVOKED`` revocation forces a socket disconnect
    within seconds — the client cannot maintain a ``connected`` state against a
    revoked bond.  Therefore a process whose WhatsApp socket has been up for
    ``SUSTAINED_STABILITY_MIN_UPTIME_SECONDS`` with zero reconnect attempts is
    genuinely bonded server-side, even without a post-relink outbound send.

    This is the alternative proof path for low-traffic / allowlist-restricted
    bots whose bond-lost incidents cannot clear via outbound proof alone.
    """
    try:
        uptime = int(evidence_field(probe, "lifecycle_process_uptime_seconds") or "0")
    except ValueError:
        return False
    if uptime < SUSTAINED_STABILITY_MIN_UPTIME_SECONDS:
        return False
    attempts_raw = evidence_field(probe, "reconnect_attempts")
    if attempts_raw is not None:
        try:
            if int(attempts_raw) != 0:
                return False
        except ValueError:
            return False
    return True


def record_has_verified_health_recovery(record: dict[str, Any]) -> bool:
    """True iff this incident record's last-known health probe is a VERIFIED
    WhatsApp recovery per the exogenous oracle.

    The age-out close path (sweep_stale_incidents) fires on a QUIET incident that
    received no fresh events. By construction its lastEvidence is the last probe
    we saw; a genuinely recovered daily-health incident is closed earlier by
    close_recovered_daily_health_incidents (a fresh 200 probe) and never reaches
    age-out. So this normally returns False for a quiet failure incident — which
    is exactly the point: age alone must not be read as recovery (#1429). Reuses
    the same probe-extraction shape and the same oracle as the recovery path; no
    parallel verification logic. Fail-closed: any parse error -> not verified.
    """
    for raw_line in str(record.get("lastEvidence") or "").splitlines():
        line = raw_line.strip()
        match = re.match(r"^health\s+([^:\s]+):\s+(.+)$", line)
        probe = match.group(2).strip() if match else line
        if is_verified_whatsapp_health_recovery(probe):
            return True
    return False


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
                if require_outbound_proof:
                    # AUTOCLOSE_PROTECTED sources need extra proof beyond base
                    # verified health.  Accept EITHER a post-incident outbound
                    # send (original path) OR sustained connection stability
                    # (alternative path for low-traffic bots).
                    if not is_verified_whatsapp_health_recovery(probe):
                        continue
                    if has_post_incident_outbound_proof(probe, record, opened):
                        pass
                    elif has_sustained_connection_stability(probe):
                        pass
                    else:
                        continue
                else:
                    if not is_verified_whatsapp_health_recovery(probe):
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


def absorb_daily_health_signal(event: dict[str, Any], incident_state: dict[str, Any]) -> list[str]:
    """Stamp freshness and (when applicable) close recovered incidents for a
    daily-health event, regardless of which terminal path actually consumes
    it (TRUTH-01).

    ``process_one()`` is not the only place a daily-health event can end its
    life: ``collapse_ready_storms()`` and ``suppress_ready_recovery_
    duplicates()`` both remove ready events from outbox/ before the main
    per-event loop ever reaches ``process_one()``. Pre-fix, only the
    process_one path called ``record_daily_health_freshness()`` /
    ``close_recovered_daily_health_incidents()``, so a storm-collapsed or
    recovery-deduped member silently lost both its liveness stamp and any
    incident recovery its evidence carried. This helper is the single call
    site all three paths share, so the behavior cannot drift between them.

    Freshness always runs first and independently (it has its own source/
    host/observation-time gates in ``record_daily_health_freshness``).
    Closure mirrors process_one's own gate — exact source ``"daily-health"``
    and not a clear-type event — so behavior at each call site matches what
    process_one would have done had the event reached it.

    Also stamps the ``sourceSpecificRecoveredIncidents`` diagnostic onto the
    event itself when incidents were recovered (folded in here from the
    three call sites that used to repeat the same 4-line block).
    Returns the recovered incident keys (possibly empty). The freshness
    host is intentionally not returned — no caller has ever consumed it
    (confirmed by grep across every call site before this change); a
    caller that needs to know whether THIS event could plausibly have
    changed the ledger can check ``event["source"]`` itself, which is
    already in hand.
    """
    record_daily_health_freshness(event, incident_state)
    recovered: list[str] = []
    if str(event.get("source") or "") == "daily-health" and not is_incident_clear(event):
        recovered = close_recovered_daily_health_incidents(event, incident_state)
    if recovered:
        diagnostics = event.setdefault("diagnostics", {})
        if isinstance(diagnostics, dict):
            diagnostics["sourceSpecificRecoveredIncidents"] = recovered
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


def incident_renotify_interval_seconds(open_record: dict[str, Any]) -> int:
    """Current still-open reminder interval for an open incident.

    Reminders back off exponentially per incident_key: the first reminder is due
    INCIDENT_RENOTIFY_SECONDS after the initial (immediate) escalation, then the
    interval doubles per sent reminder (advance_incident_renotify_interval),
    capped at INCIDENT_RENOTIFY_CAP_SECONDS. The interval is persisted on the
    open incident record so dispatcher restarts do not reset the backoff.
    """
    stored = int_field(open_record, "renotifyIntervalSeconds", INCIDENT_RENOTIFY_SECONDS)
    if stored <= 0:
        stored = INCIDENT_RENOTIFY_SECONDS
    return min(stored, INCIDENT_RENOTIFY_CAP_SECONDS)


def advance_incident_renotify_interval(open_record: dict[str, Any]) -> None:
    open_record["renotifyIntervalSeconds"] = min(
        incident_renotify_interval_seconds(open_record) * 2,
        INCIDENT_RENOTIFY_CAP_SECONDS,
    )


def source_from_incident_key(key: str) -> str:
    parts = str(key).split("|")
    return parts[2] if len(parts) >= 3 else ""


def is_autoclose_protected(event: dict[str, Any], key: str) -> bool:
    sources = {
        str(event.get("source") or "").strip().lower(),
        str(event.get("alertSource") or "").strip().lower(),
        source_from_incident_key(key).strip().lower(),
    }
    if AUTOCLOSE_PROTECTED_SOURCES & sources:
        return True
    if critical_failure_code(event).strip().upper() in AUTOCLOSE_PROTECTED_FAILURE_CODES:
        return True
    return event_has_awaiting_physical_context(event) or is_physical_intervention_signal(event)


def prune_stale_autoclose_history(incident_state: dict[str, Any], current: int) -> dict[str, Any]:
    history = incident_state.get("staleAutocloseHistory")
    if not isinstance(history, dict):
        return {}
    for key, record in list(history.items()):
        closed_at = int_field(record, "closedAt") if isinstance(record, dict) else 0
        if closed_at <= 0 or current - closed_at > AUTOCLOSE_REOPEN_WINDOW_SECONDS:
            history.pop(str(key), None)
    if not history:
        incident_state.pop("staleAutocloseHistory", None)
    return history


def record_unverified_autoclose(incident_state: dict[str, Any], key: str, current: int) -> None:
    history = prune_stale_autoclose_history(incident_state, current)
    if not history:
        history = {}
        incident_state["staleAutocloseHistory"] = history
    history[str(key)] = {
        "closedAt": current,
        "closedIso": now_iso(),
        "reason": "nonactionable_aged_out_unverified",
        "source": source_from_incident_key(key),
    }


def record_autoclose_reopen_if_recent(
    event: dict[str, Any],
    incident_state: dict[str, Any],
    key: str,
    current: int,
) -> dict[str, Any] | None:
    history = prune_stale_autoclose_history(incident_state, current)
    prior = history.get(key)
    if not isinstance(prior, dict):
        return None
    closed_at = int_field(prior, "closedAt")
    if closed_at <= 0:
        history.pop(key, None)
        return None
    seconds_since = max(0, current - closed_at)
    if seconds_since > AUTOCLOSE_REOPEN_WINDOW_SECONDS:
        history.pop(key, None)
        return None
    event_record = {
        "incidentKey": key,
        "reopenedAt": current,
        "reopenedIso": now_iso(),
        "closedAt": closed_at,
        "closedIso": prior.get("closedIso"),
        "secondsSinceAutoclose": seconds_since,
        "source": source_from_incident_key(key),
        "eventId": event.get("id"),
        "summary": redacted_state_text(event.get("summary"), 500),
    }
    safety = incident_state.setdefault("promotionSafety", {})
    safety["autoCloseThenReopenCount"] = int_field(safety, "autoCloseThenReopenCount") + 1
    safety["lastAutoCloseThenReopen"] = event_record
    samples = safety.get("autoCloseThenReopen")
    if not isinstance(samples, list):
        samples = []
    samples.append(event_record)
    safety["autoCloseThenReopen"] = samples[-AUTOCLOSE_REOPEN_SAMPLE_LIMIT:]
    history.pop(key, None)
    if not history:
        incident_state.pop("staleAutocloseHistory", None)
    return event_record


def event_created_epoch(event: dict[str, Any]) -> int | None:
    created = event.get("createdAt")
    if not isinstance(created, str) or not created.strip():
        return None
    try:
        parsed = datetime.fromisoformat(created.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return int(parsed.timestamp())


def event_created_order(event: dict[str, Any]) -> int | None:
    """Return a UTC microsecond order only for unambiguous full timestamps."""
    created = event.get("createdAt")
    if not isinstance(created, str) or not created.strip():
        return None
    try:
        parsed = datetime.fromisoformat(created.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return int(parsed.timestamp()) * 1_000_000 + parsed.microsecond


def is_quarantine_incident(event: dict[str, Any]) -> bool:
    return str(event.get("source") or "") in QUARANTINE_INCIDENT_SOURCES


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
    code = critical_failure_code(event)
    if code == "WA_AUTH_BOND_SERVER_REVOKED":
        return True
    if code == "WEAK_LOGGED_OUT_SIGNAL":
        return False
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
    additions = [
        "incident_still_open=true",
        f"incident_key={key}",
        f"incident_status={status}",
        f"opened={open_record.get('openedIso') or opened}",
        f"age_seconds={max(0, current - opened)}",
        f"suppressed_duplicates={suppressed}",
        f"last_notified={open_record.get('lastNotifiedIso') or open_record.get('lastSentIso') or last_notified}",
        f"escalated={str(escalated).lower()}",
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
    # Test seam: force a delivery failure with a caller-supplied error string so
    # subprocess tests can drive the transient-vs-permanent failure routing
    # deterministically (mirrors the BOT_ERRORS_DRY_SEND_CAPTURE dry-run seam).
    dry_fail = os.environ.get("BOT_ERRORS_DRY_SEND_FAIL")
    if dry_fail:
        raise RuntimeError(dry_fail)
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


# Pattern E SSOT / Pattern A: the single "no remediation" action sentinel.
# format_event renders it for non-actionable info events, and Pattern A keys on
# it (the incident-level SSOT field, per §10 C4) to decide a stale renotify is
# non-actionable and may be suppressed.
NONACTIONABLE_ACTION = "none — informational event; no Q remediation required."
INVESTIGATE_ACTION = "Q investigate, remediate, and report disposition in BOT ERRORS."


def requested_action_text(event: dict[str, Any]) -> str:
    """Single source of truth for an event's requested_action (Pattern E).

    Precedence derives the action from the event's real state. A real action
    (physical / operator) wins over the informational "none" fallback EVEN on
    info severity — otherwise an info-severity awaiting_physical digest renders
    "none" and loses its action (false negative). "none" is honest only for an
    info event with no real standing action (e.g. a self-healed stale digest).
    Returned WITHOUT the "  > requested_action: " line prefix.
    """
    severity = str(event.get("severity") or "").lower()
    if event_has_awaiting_physical_context(event) or is_verified_device_bond_lost_signal(event):
        return physical_action_text()
    if is_physical_intervention_signal(event):
        return physical_candidate_action_text()
    operator_action = critical_operator_action(event)
    if operator_action:
        return redact(operator_action).replace("@", " at ")
    if severity == "info":
        return NONACTIONABLE_ACTION
    if event_has_stale_context(event):
        return stale_action_text()
    return INVESTIGATE_ACTION


def stamp_delivery_freshness(event: dict[str, Any], current: int) -> None:
    """A4: on a RE-delivery (attempts > 1), stamp how old the event is at send
    time and that the underlying condition was NOT re-validated before re-sending.

    The dispatcher has no per-source re-probe, so a re-sent alert can describe a
    condition that already self-healed (the "attempts=5, already false" problem).
    These markers let a reader judge currency instead of trusting a stale echo.
    First deliveries (attempts <= 1) are left clean. Fail-open: any error is
    swallowed — freshness telemetry must never block or corrupt a real send.
    """
    try:
        delivery = event.get("delivery")
        if not isinstance(delivery, dict):
            return
        if int(delivery.get("attempts") or 0) <= 1:
            return
        created = event.get("createdAt")
        if isinstance(created, str) and created.strip():
            try:
                created_epoch = int(
                    datetime.fromisoformat(created.strip().replace("Z", "+00:00")).timestamp()
                )
                delivery["ageAtDeliverySeconds"] = max(0, current - created_epoch)
            except Exception:
                pass
        delivery["revalidated"] = False
    except Exception:
        return


def format_event(event: dict[str, Any]) -> str:
    classification = classify_event(event)
    severity = classification.severity
    if classification.kind == "incident_recovery":
        title = "BOT RECOVERY"
    elif classification.kind == "observation":
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
        event_line("delivery_age_seconds", delivery.get("ageAtDeliverySeconds")),
        event_line(
            "revalidated",
            ("no — condition not re-probed before re-send (may be stale)"
             if delivery.get("revalidated") is False else None),
            120,
        ),
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
    clear_requirement = critical_clear_requirement(event)
    requested_action = f"  > requested_action: {requested_action_text(event)}"
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


# Transient WhatsApp-transport signatures: the dispatcher's own send path could
# not reach a *connected* socket (WA briefly disconnected / reconnecting), as
# opposed to a permanent/content failure (unknown chat, malformed payload, target
# mismatch). Transient failures are deferred and redelivered on transport
# recovery; everything else still dead-letters at the permanent cap.
_TRANSIENT_TRANSPORT_SIGNATURES = (
    "temporarily disconnected",
    "try again in a moment",
    "connection closed",
    "connection lost",
    "not connected",
    "socket hang up",
    "websocket is not open",
    "stream errored out",
    "signal-cli socket error",
    "signal-cli connection closed",
    "signal-cli connection ended by peer",
    "signal-cli socket write failed",
)


def is_transient_transport_failure(error: str) -> bool:
    lower = (error or "").lower()
    return any(sig in lower for sig in _TRANSIENT_TRANSPORT_SIGNATURES) or (
        "signal-cli rpc " in lower and " timed out after " in lower
    )


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
    target = _durable_target(dest)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        record,
        component="dispatcher.dead_letter_record",
        predecessor=absent,
    )
    publication = publish_event_json(
        target,
        record,
        component="dispatcher.dead_letter_record",
        operation_id=publication_operation,
    )
    require_all_advance([publication])
    try:
        claimed.unlink()
    except FileNotFoundError:
        pass
    fsync_parent(dest)
    return dest


def dead_letter_meta_event(paths: dict[str, Path], count: int, oldest_summary: str) -> dict[str, Any]:
    now = int(time.time())
    return {
        **new_event_fields("alert", "critical"),
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
    dl_files = [f for f in dl_dir.glob("*.json") if safe_is_regular_entry(f)]
    if not dl_files:
        state = read_meta_state(paths)
        was_nonempty = state.get("dlWasNonempty", False)
        state["dlWasNonempty"] = False
        write_meta_state(paths, state)
        if not was_nonempty:
            # Already empty on the previous sweep — no transition, no clear.
            return 0
        # #2421 with RED-3061-r6 fix: emit clear ONLY on the non-empty→empty
        # transition, not on every sweep when the dead letter is already empty.
        # This prevents the cyclic outbox occupation (the meta-clear writes to
        # outbox; consuming it on the next dispatch leaves the queue empty,
        # which without this guard would trigger another write, ad infinitum).
        clear_event = dead_letter_meta_event(paths, 0, "")
        clear_event["eventType"] = "clear"
        clear_event["severity"] = "info"
        clear_path = outbox_path_for_event(clear_event, paths)
        clear_target = _durable_target(clear_path)
        empty_observation = JsonVersion(False, None, None, None)
        clear_publication = publish_event_json(
            clear_target,
            clear_event,
            component="dispatcher.dead_letter_meta_clear",
            operation_id=operation_id(clear_target, clear_event, component="dispatcher.dead_letter_meta_clear", predecessor=empty_observation),
        )
        require_advance(clear_publication)
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
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        event,
        component="dispatcher.dead_letter_meta_alert",
        predecessor=absent,
    )
    event_publication = publish_event_json(
        target,
        event,
        component="dispatcher.dead_letter_meta_alert",
        operation_id=publication_operation,
    )
    require_advance(event_publication)
    state["deadLetterMetaAlertAtEpoch"] = now
    state["deadLetterMetaAlertEventId"] = event["id"]
    state["dlWasNonempty"] = True
    state_publication = write_meta_state(paths, state)
    require_all_advance([event_publication, state_publication])
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
    # Pattern H — a relay_host_recovered (info alert) whose paired relay_host_down
    # was held-and-unsurfaced is a self-healed flap; suppress it so the blip pages
    # neither leg. Handled here because the info severity means it never reaches the
    # is_incident_alert / is_incident_clear branches below.
    if source == RELAY_RECOVERED_SOURCE:
        # #2419: LEGACY-ONLY branch — the collector now emits recovery as a
        # same-source clear (source="relay_host_down"), which routes through
        # the standard Pattern D clear path below instead of this pairing shim.
        relay_reason = coalesce_relay_recovered(event, incident_state)
        if relay_reason is not None:
            return relay_reason
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
    # Pattern F — suppress individual members of an OPEN flap storm; the
    # consolidated flap_storm alert (emitted by the pre-collapse scan) already
    # carries the count/rate. The storm itself never routes through here
    # (it is sent directly), so this cannot suppress the storm alert.
    if FLAP_DETECTION and is_incident_alert(event) and not is_incident_clear(event) and source != "flap_storm":
        flap_state = incident_state.get("flapState")
        if isinstance(flap_state, dict):
            flap_rec = flap_state.get(key)
            if isinstance(flap_rec, dict) and flap_rec.get("stormAt"):
                return f"flap_storm_member: {key} consolidated into open flap storm"
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
        # Pattern D — hold a transient soft-fault at warning tier; only a
        # transient that persists past TRANSIENT_PROMOTE_SECONDS promotes back to
        # the hard-outage tier and falls through to normal send handling.
        if TRANSIENT_TIERING_ENABLED:
            transient_reason = apply_transient_tiering(event, incident_state, key, current)
            if transient_reason is not None:
                return transient_reason
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
            renotify_seconds = (
                AWAITING_PHYSICAL_RENOTIFY_SECONDS
                if awaiting_physical
                else incident_renotify_interval_seconds(open_record)
            )
            escalated = (
                False
                if awaiting_physical
                else age_seconds >= INCIDENT_ESCALATE_SECONDS or suppressed >= INCIDENT_ESCALATE_SUPPRESSED
            )
            if since_notified >= renotify_seconds:
                try:
                    suppress_open_renotify = (
                        SUPPRESS_OPEN_NONACTIONABLE_RENOTIFY
                        and open_renotify_is_nonactionable(event, key)
                    )
                except Exception:
                    suppress_open_renotify = False  # fail-open: send on classifier error
                if suppress_open_renotify:
                    # Absorb the fresh occurrence silently: keep the audit counter and
                    # the lastSeen bookkeeping (already updated above), but do NOT
                    # re-page or age-escalate. flap-storm (force_notify_level, handled
                    # earlier) remains the only escalation path for a stuck agent.
                    open_record["openRenotifySuppressedCount"] = (
                        int_field(open_record, "openRenotifySuppressedCount") + 1
                    )
                    open_record["lastOpenRenotifySuppressedAt"] = current
                    open_record["lastOpenRenotifySuppressedIso"] = now_iso()
                    return (
                        f"open renotify suppressed (non-actionable source) for {key}; "
                        f"flap-storm still escalates"
                    )
                open_record["lastNotifiedAt"] = current
                open_record["lastNotifiedIso"] = now_iso()
                open_record["renotifyCount"] = int_field(open_record, "renotifyCount") + 1
                if not awaiting_physical:
                    advance_incident_renotify_interval(open_record)
                append_still_open_context(event, open_record, key, current, suppressed, escalated)
                return None
            return f"incident already open for {key}; duplicate suppressed"
        last_sent = int(incident_state.setdefault("lastSentAt", {}).get(key) or 0)
        if last_sent and current - last_sent < INCIDENT_COOLDOWN_SECONDS:
            if force_notify_level(event):
                return None
            return f"incident cooldown active for {key}; last sent {current - last_sent}s ago"
    if is_incident_clear(event):
        # Pattern D — a held transient that recovers before promotion: retire its
        # bookkeeping and keep the recovery silent (we never surfaced the alert).
        if TRANSIENT_TIERING_ENABLED:
            transient_clear = resolve_transient_on_clear(event, incident_state, key)
            if transient_clear is not None:
                return transient_clear
        open_record = open_incidents.get(key)
        if not isinstance(open_record, dict):
            recovered_keys = daily_health_recovered_incident_keys(event, incident_state)
            if recovered_keys:
                return None
            return f"clear has no open incident for {key}; stale recovery suppressed"
        if is_quarantine_incident(event):
            opened_created = open_record.get("eventCreatedAt")
            if isinstance(opened_created, str) and opened_created.strip():
                opened_order = event_created_order({"createdAt": opened_created})
                clear_order = event_created_order(event)
                if opened_order is None or clear_order is None:
                    return f"quarantine clear ordering is ambiguous for {key}; stale recovery suppressed"
                if clear_order <= opened_order:
                    return f"quarantine clear does not follow open incident for {key}; stale recovery suppressed"
        opened = int_field(open_record, "eventCreatedAtEpoch")
        created = event_created_epoch(event)
        if opened > 0 and created is not None and created < opened - CLOCK_SKEW_TOLERANCE_SECONDS:
            return f"clear predates open incident for {key}; stale recovery suppressed"
    return None


def is_test_provenance_event(event: dict[str, Any]) -> bool:
    runtime = event.get("runtime") if isinstance(event.get("runtime"), dict) else {}
    provenance = runtime.get("provenance") if isinstance(runtime.get("provenance"), dict) else {}
    return provenance.get("test") is True


# Test roots recognised ONLY by the email-fallback gate. Linux pytest basetemps
# (``pytest-of-<user>``) are deliberately not global TEST_LEAK patterns: the
# repository's own suite runs with tmp_path roots under them, and a global
# match would silently drop fixture events in unrelated tests.
#
# #3404: these patterns are matched against the STATE DIRECTORY the dispatcher
# was launched with, never against strings inside the event. A genuine alert
# may legitimately *mention* such a path (a tmp-retention alert about orphaned
# ``/tmp/pytest-of-*`` directories, for example); what makes a run a test run
# is where its own state lives.
_EMAIL_FALLBACK_TEST_ROOT_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"/pytest-of-[^/]+/", re.I),
]

# Fields the DISPATCHER owns and writes into an event it is delivering. They
# carry local paths -- the dispatch log under the state root, and the transport's
# own exception text -- so no test-provenance decision may read them (#3404).
#
# ``delivery`` is excluded wholesale rather than key by key. It is the
# dispatcher's bookkeeping block by contract: the TypeScript producer
# (src/lib/bot-errors-outbox.ts) emits it empty, and only the dispatcher writes
# attempts, status, backoff, lastError and emailFallback into it. Nothing a
# producer legitimately puts there is evidence of test provenance. Naming the
# block instead of chasing its keys is what stops this from regressing the next
# time a field is added to it -- which is exactly how ``lastError`` was missed.
_DISPATCHER_OWNED_TOP_LEVEL_KEYS: tuple[str, ...] = ("delivery",)


def producer_claim(
    event: dict[str, Any],
    *,
    injected_dispatch_log: str | None = None,
) -> dict[str, Any]:
    """The event as its PRODUCER claimed it: dispatcher-owned bookkeeping removed.

    An independent copy (see :func:`json_snapshot`), so later mutation of the
    live event cannot reach it, with the dispatcher's own writes stripped.

    This is the input to every test-provenance decision: the B2 queue check and
    the F5 email gate both read it and never the live event. Deriving those
    decisions from the live event is a silent-loss bug, because the retry path
    persists dispatcher text back into the queued file -- a transport error
    naming a fixture path made attempt 2 archive a genuine critical alert as a
    test leak.

    ``diagnostics.dispatchLog`` is stripped ONLY when it equals
    ``injected_dispatch_log``, the value this dispatcher writes. It is not a
    dispatcher-exclusive key: ``bot-errors-emit.py`` accepts arbitrary
    ``diagnostics`` keys from the command line, and with
    ``diagnostics.omitDispatchLogInMessage`` set the dispatcher does not
    overwrite what the producer put there -- while ``format_event`` still
    renders it into the delivered message. Stripping it unconditionally
    therefore laundered a producer-supplied fixture path straight past this
    check and into WhatsApp. A value the producer chose is producer-claimed
    text and stays in the claim.

    Detection of real test-fixture events is otherwise unaffected: those declare
    themselves in producer-owned fields (evidence, summary, payload,
    diagnostics), which are all preserved here. ``event_is_test_leak`` and
    ``matched_test_leak_pattern`` are unchanged; only what they are handed is.

    Raises whatever :func:`json_snapshot` raises; the caller decides.
    """
    claim = json_snapshot(event)
    if not isinstance(claim, dict):
        raise ValueError("event root must be an object")
    for key in _DISPATCHER_OWNED_TOP_LEVEL_KEYS:
        claim.pop(key, None)
    diagnostics = claim.get("diagnostics")
    if (
        injected_dispatch_log is not None
        and isinstance(diagnostics, dict)
        and diagnostics.get("dispatchLog") == injected_dispatch_log
    ):
        diagnostics.pop("dispatchLog", None)
    return claim


UNRESOLVABLE_STATE_DIR_PATTERN = "<state directory could not be resolved>"


def matched_state_dir_test_root_pattern(state_dir: Path | str | None) -> str | None:
    """Return the test-root pattern matching the dispatcher's own state directory.

    Recognises the global test-leak roots (vitest/jest sandboxes, operator
    additions via BOT_ERRORS_TEST_LEAK_PATH_PATTERNS) and the email-gate-only
    pytest basetemp rule. ``None`` when the state directory is not under any
    recognised test root.

    Four spellings of the directory are tested, not just the one supplied.
    ``BOT_ERRORS_STATE_DIR`` is accepted unnormalised (``lib.state_root`` wraps
    it in ``Path`` and nothing more), so a relative value or a symlink into a
    sandbox would otherwise present a clean-looking string for a state root that
    really is a test root -- a fail-OPEN miss, letting a test run email the
    operator. The spellings are:

    * ``raw`` -- exactly what the caller supplied;
    * ``absolute`` -- ``raw`` anchored at the working directory, which is what
      catches a relative value;
    * ``parent-resolved`` -- the #2723 anchor form, resolving OS aliases such as
      ``/var`` to ``/private/var`` while keeping the final component's own name;
    * ``fully resolved`` -- every component dereferenced, INCLUDING the leaf.

    The last of these is load-bearing on its own. The parent-resolved form
    deliberately preserves the leaf name, so a state directory that is itself a
    symlink into a sandbox resolves to nothing revealing and the check misses
    it. That was a real hole in the first version of this function.

    Fails CLOSED: if the directory cannot be resolved at all, this reports
    ``UNRESOLVABLE_STATE_DIR_PATTERN`` rather than ``None``, so an
    unclassifiable state root blocks the email instead of silently allowing it.
    """
    if state_dir is None:
        return None
    raw = os.fspath(state_dir)
    spellings = [raw]
    try:
        absolute = Path(raw).absolute()
        spellings.append(os.fspath(absolute))
        spellings.append(os.fspath(absolute.parent.resolve() / absolute.name))
        spellings.append(os.fspath(Path(raw).resolve(strict=False)))
    except (OSError, RuntimeError, ValueError):
        return UNRESOLVABLE_STATE_DIR_PATTERN
    for spelling in spellings:
        text = spelling.rstrip("/") + "/"
        for pattern in (*TEST_LEAK_PATTERNS, *_EMAIL_FALLBACK_TEST_ROOT_PATTERNS):
            if pattern.search(text):
                return pattern.pattern
    return None


def email_fallback_blocked_reason(
    claimed_event: dict[str, Any],
    *,
    state_dir: Path | str | None = None,
) -> str | None:
    """Why an event must NOT be escalated by email, or None when it may.

    CONTRACT: ``claimed_event`` MUST be the event AS ITS PRODUCER CLAIMED IT --
    the payload as read off the queue, before any dispatcher bookkeeping is
    written into it. ``process_one`` snapshots exactly that at the B2 test-leak
    check and carries the snapshot to this call; do not pass the live event.

    That contract is the whole of #3404. The gate used to scan the event as it
    stood at the F5 call site, which by then carried dispatcher-owned text:
    ``diagnostics.dispatchLog`` (always) and ``delivery.lastError`` (the
    transport's own exception string, written by ``mark_failure`` three
    statements earlier -- and the email fallback only runs when the transport is
    already failing). A production dispatcher whose socket or state root sat
    under a tmp dir, or whose bridge returned an error payload naming a fixture
    path, therefore reported ``test_leak`` for a perfectly clean alert and
    dead-lettered it silently. Reading only the claimed payload closes that
    class for the fields ``producer_claim`` names -- the ``delivery`` block, and
    ``diagnostics.dispatchLog`` when it holds this dispatcher's own value. Other
    dispatcher-written diagnostics survive the claim and are a known remainder,
    not something this closes by construction.

    Three gates, evaluated in order:

    * ``test_provenance`` -- the producer flagged ``runtime.provenance.test``.
    * ``test_leak`` -- the claimed payload matches a global test-leak pattern
      (identical ``event_is_test_leak`` semantics to the queue path). On the
      ``process_one`` route this branch is unreachable by construction: the B2
      check drops such events as ``test_leak_dropped`` at the claim, long before
      F5. It is kept as defence in depth for any other caller of this gate and
      as an anti-regression pin on the shared detector.
    * ``test_state_dir`` -- the state directory the dispatcher was launched
      with (``state_dir``; defaults to the resolved state root) lies under a
      recognised test root. This is what the 2026-08-28 incident actually was:
      a pytest-fixture dead-letter reached the operator as a real critical
      email because the run itself was a test run. Binding to the launched
      state dir replaces the earlier scan for ``/pytest-of-<user>/`` anywhere in
      the event text, which also blocked genuine alerts that merely mentioned
      such a path (#3404).
    """
    if is_test_provenance_event(claimed_event):
        return "test_provenance"
    if event_is_test_leak(claimed_event):
        return "test_leak"
    if state_dir is None:
        # Unreachable in production: process_one, the only caller, always passes
        # paths["root"]. Kept so a unit test can exercise the gate against the
        # env-configured root without building a paths dict.
        state_dir = state_root()
    if matched_state_dir_test_root_pattern(state_dir) is not None:
        return "test_state_dir"
    return None


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
        reopen_record = None if existing_record else record_autoclose_reopen_if_recent(
            event, incident_state, key, current
        )
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
        if reopen_record is not None:
            updated_record["autoCloseReopened"] = True
            updated_record["autoCloseReopenCount"] = int_field(
                existing_record, "autoCloseReopenCount"
            ) + 1
            updated_record["lastAutoCloseReopen"] = reopen_record
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
        # Pattern D — retire any transient bookkeeping for this key on close, so a
        # promoted record cannot persist and collapse the promote window for a
        # future re-opened incident on the same key.
        transient_state = incident_state.get("transientState")
        if isinstance(transient_state, dict):
            transient_state.pop(key, None)
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


def stale_renotify_is_nonactionable(event: dict[str, Any], key: str) -> bool:
    """Pattern A: is this stale renotify safe to suppress (non-actionable)?

    Suppress a self-healed / no-op stale incident when ANY of:
    - explicit configured suppress source (BOT_ERRORS_STALE_RENOTIFY_SUPPRESS_SOURCES);
    - a recovery / no-op source signature (*_restored/_recovered/_reverted/_unknown/
      _cleared, provider_fallback_*) — definitionally non-actionable once stale;
    - the SSOT requested_action (Pattern E) resolves to the non-actionable sentinel,
      i.e. format_event would render "none — informational" (§10 C4).

    flap_storm incidents are EXEMPT (§10 C4) — they always renotify on their own
    cadence. Callers wrap this fail-open: any exception => do not suppress (send).
    """
    source = str(event.get("source") or "")
    alert_source = str(event.get("alertSource") or "")
    if source == "flap_storm" or "flap_storm" in str(key):
        return False
    if is_autoclose_protected(event, key):
        return False
    if source in STALE_RENOTIFY_SUPPRESS_SOURCES or alert_source in STALE_RENOTIFY_SUPPRESS_SOURCES:
        return True
    for cand in (source.lower(), alert_source.lower()):
        if not cand:
            continue
        if cand.endswith(STALE_RENOTIFY_SUPPRESS_SUFFIXES) or cand.startswith(STALE_RENOTIFY_SUPPRESS_PREFIXES):
            return True
    # SSOT signal: the derived action is non-actionable. This covers both the
    # plain info "none" sentinel AND the stale "verify whether it recovered —
    # unless fresh alerts resume" filler that stale_incident_event bakes as the
    # operatorAction for any stale incident carrying a failure_code (e.g. a
    # daily-health provider_probe quiet for days). That filler describes a no-op
    # by definition: if the source were still broken it would re-emit FRESH
    # events (which renotify normally) instead of going silent. A genuine
    # standing action (physical relink / manual intervention) resolves to a
    # different, real action string and is NOT caught here.
    return requested_action_text(event) in (NONACTIONABLE_ACTION, stale_action_text())


def open_renotify_is_nonactionable(event: dict[str, Any], key: str) -> bool:
    """Pattern A (open variant): suppress the periodic still-open renotify for a
    source that is never operator-actionable even while the incident is live.

    Scope = the same non-actionable prefixes as the stale path (runtime-tool-error:*,
    provider_fallback_*) plus any explicitly configured suppress source. A
    runtime-tool-error incident is the agent's OWN tool call failing and
    self-correcting inline; the time-based renotify/escalation has no remediation
    behind it. flap_storm is EXEMPT — a genuinely stuck agent still escalates
    through force_notify_level, which is evaluated BEFORE this branch. Callers
    wrap this fail-open: any exception => do not suppress (send).
    """
    source = str(event.get("source") or "")
    alert_source = str(event.get("alertSource") or "")
    if source == "flap_storm" or "flap_storm" in str(key):
        return False
    if is_autoclose_protected(event, key):
        return False
    if source in STALE_RENOTIFY_SUPPRESS_SOURCES or alert_source in STALE_RENOTIFY_SUPPRESS_SOURCES:
        return True
    for cand in (source.lower(), alert_source.lower()):
        if cand.startswith(STALE_RENOTIFY_SUPPRESS_PREFIXES):
            return True
    return False


def mark_stale_incident_suppressed(record: dict[str, Any], event: dict[str, Any], current: int) -> None:
    """Pattern A: record a suppressed (non-sent) stale renotify for audit.

    The incident stays in state (audit trail preserved); only the WhatsApp push
    is gated. lastStaleRenotifiedAt is intentionally NOT advanced — we did not
    notify — so the existing renotify cadence still governs if it later becomes
    actionable.
    """
    if not record.get("staleAt"):
        record["staleAt"] = current
        record["staleIso"] = now_iso()
    record["staleSuppressed"] = True
    record["lastStaleSuppressedAt"] = current
    record["lastStaleSuppressedIso"] = now_iso()
    record["lastStaleSuppressedEventId"] = event.get("id")
    record["staleSuppressedCount"] = int_field(record, "staleSuppressedCount") + 1


def stale_autoclose_summary_event(keys: list[str], current: int) -> dict[str, Any]:
    """One consolidated digest for a batch of auto-closed non-actionable stale
    incidents (Pattern A safety valve + §10 C5). Recoveries are summarized and
    consolidated — never 200 individual alerts."""
    preview = ", ".join(keys[:10])
    if len(keys) > 10:
        preview += f", +{len(keys) - 10} more"
    additions = [
        "stale_autoclose=true",
        f"closed_count={len(keys)}",
        f"closed_keys={preview}",
        "reason=non-actionable incidents AGED OUT past escalate horizon; "
        "removed from open state to bound incident state. recovery UNVERIFIED "
        "(silence is not proof of repair — esp. if the monitoring path was down); "
        "each will REOPEN automatically if the condition still fails on the next run.",
    ]
    return {
        **new_event_fields("observation", "info"),
        "id": f"stale-autoclose-{current}",
        "createdAt": now_iso(),
        "machine": "bot-errors",
        "instance": "dispatcher",
        "source": "stale-autoclose",
        "summary": (
            f"Auto-closed {len(keys)} non-actionable stale incident(s) — "
            "aged out, recovery unverified (reopens if still failing)"
        ),
        "evidence": "\n".join(additions),
        "diagnostics": {
            "dispatchLog": str(state_paths()["logs"] / "dispatch.jsonl"),
            "queue": str(state_root()),
        },
        "delivery": {"attempts": 1, "status": "stale-autoclose", "nextAttemptAtEpoch": 0, "lastError": None},
    }


def should_emit_autoclose_digest(accum: dict[str, Any], current: int) -> bool:
    """Decide whether the coalesced auto-close digest is due this sweep.

    Emit when: coalescing is disabled (window<=0), OR the pending batch has reached
    the burst cap (report a flood promptly), OR the coalescing window has elapsed
    since the last digest. A first-ever digest (lastDigestAt==0) fires immediately so
    the operator still gets prompt first notice; subsequent trickle is then absorbed.
    Fail-open: any malformed accumulator falls through to emit.
    """
    try:
        pending = int(accum.get("pendingCount") or 0)
        if pending <= 0:
            return False
        if STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS <= 0:
            return True
        if pending >= STALE_AUTOCLOSE_DIGEST_MAX_PENDING:
            return True
        last_digest_at = int(accum.get("lastDigestAt") or 0)
        return (current - last_digest_at) >= STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS
    except Exception:
        return True


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
    ]
    fields = incident_event_fields_from_key(key)
    event = {
        **new_event_fields("observation", severity),
        "id": f"stale-{safe_segment(key)}-{current}",
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


# ---------------------------------------------------------------------------
# Pattern F — flap-storm detection (design §9 + §10 C0/C1/C2/C4)
#
# A flapping source (self-heal-then-fail) is a fault signature, not just noise:
# we CONSOLIDATE its member events into one alert AND ESCALATE on intensity.
# Trip state is disk-persisted under incident_state["flapState"], keyed by
# incident_key, because the dispatcher loads→processes→saves→exits and an
# in-memory window counter would reset every run (C0). Timestamps are
# dispatcher wall-clock (never author createdAt — collector clock skew, C0).
# Trips are counted on raw INPUT before storm-collapse consumes members (C1).
# ---------------------------------------------------------------------------

def flap_entry(flap_state: dict[str, Any], key: str) -> dict[str, Any]:
    entry = flap_state.get(key)
    if not isinstance(entry, dict):
        entry = {"tripTimestamps": [], "cumulativeCount": 0}
        flap_state[key] = entry
    if not isinstance(entry.get("tripTimestamps"), list):
        entry["tripTimestamps"] = []
    return entry


def flap_trips_in_window(entry: dict[str, Any], now: int) -> int:
    return sum(
        1
        for t in entry.get("tripTimestamps", [])
        if isinstance(t, (int, float)) and 0 <= now - t <= FLAP_WINDOW_SECONDS
    )


def flap_occurrence_already_counted(entry: dict[str, Any], event_id: str, now: int) -> bool:
    """#2428: one trip per distinct event OCCURRENCE, not per delivery attempt.

    The dispatcher returns an undelivered event to the outbox with its
    ORIGINAL identity, so every scan re-reads the same ``id`` while ordinary
    (10-attempt) or transient-transport (240-attempt) retries are in flight.
    Counting each re-scan as a trip measured dispatcher delivery attempts —
    one stuck alert across five scans reached FLAP_TRIP_THRESHOLD and opened
    a synthetic storm whose members then became suppressible.

    Ids are remembered under ``entry["seenEventIds"]`` (id -> last-seen
    epoch), refreshed on every sighting, pruned once unseen for
    FLAP_SEEN_EVENT_RETENTION_SECONDS (i.e. after the event left the outbox),
    and hard-capped at FLAP_SEEN_EVENT_MAX_IDS by dropping the oldest. An
    id-less event cannot be deduped and falls back to per-scan counting
    (the pre-#2428 behavior, fail-open).
    """
    if not event_id:
        return False
    seen = entry.get("seenEventIds")
    if not isinstance(seen, dict):
        seen = {}
        entry["seenEventIds"] = seen
    for stale in [k for k, t in seen.items() if not isinstance(t, (int, float)) or now - t > FLAP_SEEN_EVENT_RETENTION_SECONDS]:
        seen.pop(stale, None)
    already = event_id in seen
    seen[event_id] = now
    if len(seen) > FLAP_SEEN_EVENT_MAX_IDS:
        for oldest in sorted(seen, key=lambda k: seen[k])[: len(seen) - FLAP_SEEN_EVENT_MAX_IDS]:
            seen.pop(oldest, None)
    return already


def record_flap_trip(flap_state: dict[str, Any], key: str, now: int) -> dict[str, Any]:
    """Record one raw trip for incident_key at wall-clock `now`, pruning the
    sliding window. Counts input per raw trip (C1)."""
    entry = flap_entry(flap_state, key)
    pruned = [t for t in entry["tripTimestamps"] if isinstance(t, (int, float)) and 0 <= now - t <= FLAP_WINDOW_SECONDS]
    pruned.append(now)
    entry["tripTimestamps"] = pruned
    entry["cumulativeCount"] = int(entry.get("cumulativeCount") or 0) + 1
    entry["lastTripAt"] = now
    if not entry.get("firstTripAt"):
        entry["firstTripAt"] = now
    # Watermark: the last moment this source was flapping at STORM intensity,
    # which is what flap_should_resolve measures quiet against. `pruned` is the
    # in-window trip list including this trip, so its length is the current
    # windowed rate. Seeded on first sight so entries written before this field
    # existed converge on the normal stable window instead of being pinned open.
    if len(pruned) >= FLAP_TRIP_THRESHOLD or not entry.get("lastStormRateAt"):
        entry["lastStormRateAt"] = now
    return entry


def flap_evaluate(entry: dict[str, Any], now: int) -> dict[str, Any]:
    """Decide whether to emit a flap_storm alert for this entry now (after its
    trip was recorded). Mutates storm lifecycle fields. Returns
    {emit: bool, severity: str|None, reason: str}.

    - First crossing of FLAP_TRIP_THRESHOLD in the window opens the storm at
      `warning` and emits once; member events are then suppressed.
    - Promote to `critical` when the storm persists FLAP_PROMOTE_SECONDS or the
      cumulative count crosses FLAP_CRITICAL_COUNT (the 263-case). Re-emits once
      on escalation, and on the FLAP_PROMOTE_SECONDS cadence while active.
    """
    trips = flap_trips_in_window(entry, now)
    cumulative = int(entry.get("cumulativeCount") or 0)
    if not entry.get("stormAt"):
        if trips >= FLAP_TRIP_THRESHOLD:
            entry["stormAt"] = now
            entry["stormSeverity"] = "warning"
            entry["lastStormEmitAt"] = now
            return {"emit": True, "severity": "warning", "reason": "flap_storm_opened"}
        return {"emit": False, "severity": None, "reason": "below_threshold"}
    storm_at = int(entry.get("stormAt") or now)
    promoted = (now - storm_at >= FLAP_PROMOTE_SECONDS) or (cumulative >= FLAP_CRITICAL_COUNT)
    new_severity = "critical" if promoted else "warning"
    escalated = new_severity == "critical" and entry.get("stormSeverity") != "critical"
    last_emit = int(entry.get("lastStormEmitAt") or storm_at)
    # Use progressive backoff for post-promotion cadence, not the initial
    # promotion threshold (#2393).  Before promotion and on escalation the
    # cadence remains the original FLAP_PROMOTE_SECONDS interval.
    if promoted and not escalated:
        step = int(entry.get("cadenceStep") or 0)
        backoff = FLAP_STORM_CADENCE_BACKOFF_SECONDS[min(step, len(FLAP_STORM_CADENCE_BACKOFF_SECONDS) - 1)]
        cadence_due = now - last_emit >= backoff
    else:
        cadence_due = now - last_emit >= FLAP_PROMOTE_SECONDS
    entry["stormSeverity"] = new_severity
    if escalated or cadence_due:
        entry["lastStormEmitAt"] = now
        if promoted and not escalated:
            step = int(entry.get("cadenceStep") or 0)
            entry["cadenceStep"] = step + 1
        return {
            "emit": True,
            "severity": new_severity,
            "reason": "flap_storm_escalated" if escalated else "flap_storm_cadence",
        }
    return {"emit": False, "severity": new_severity, "reason": "flap_storm_member_suppressed"}


def flap_source_went_quiet(entry: dict[str, Any], now: int) -> bool:
    """True when the source actually FELL SILENT, not merely dropped below storm
    rate. Only silence justifies the 'stable after N flaps' recovery wording.

    This is the pre-rate-based resolve condition, kept as the wording
    discriminator: a storm that closes because the rate decayed while the source
    keeps tripping has produced no evidence of recovery, and announcing one would
    be a false all-clear. `openIncidents` cannot answer this on its own — an open
    storm SUPPRESSES its member events, so the underlying condition is often
    absent from that map exactly when it is still occurring.
    """
    last_trip = int(entry.get("lastTripAt") or 0)
    return flap_trips_in_window(entry, now) == 0 and (now - last_trip) >= FLAP_STABLE_SECONDS


def flap_should_resolve(entry: dict[str, Any], now: int) -> bool:
    """An open storm resolves after FLAP_STABLE_SECONDS below storm intensity.

    Resolution is the symmetric counterpart of opening: a storm OPENS at
    >= FLAP_TRIP_THRESHOLD trips in the window, so it CLOSES once the windowed
    rate has stayed under that threshold for the stable period.

    It previously demanded ZERO trips in the window AND FLAP_STABLE_SECONDS
    since the last trip — strictly harder than the condition that opened it, and
    unreachable for a chronic low-rate source. Measured on 2026-09-01:
    health_body_degraded tripped 1.2-2.5 times per hour on all 8 monitored bots,
    so an hour of total quiet never arrived and every storm stayed open at
    `critical` for 1000-1800 hours, re-emitting on the backoff cadence
    (63 of 298 BOT ERRORS messages in 26h). Quiet is now measured from
    `lastStormRateAt` -- the last time the source actually reached storm rate --
    not from the last trip of any size.

    (C2 notes liveness should also gate this; collector silence alone is a
    weaker signal — tracked as a follow-up; time-stable is the Wave-1 gate.)
    """
    if not entry.get("stormAt"):
        return False
    if flap_trips_in_window(entry, now) >= FLAP_TRIP_THRESHOLD:
        return False
    watermark = entry.get("lastStormRateAt")
    if not isinstance(watermark, (int, float)):
        # Pre-upgrade entry: `stormAt` is the last moment this source was PROVEN
        # to be at storm rate, which is exactly what the watermark records, so it
        # is the honest stand-in. Falling back to `lastTripAt` instead would
        # reproduce the original defect on every existing entry -- a chronic
        # source refreshes lastTripAt faster than the stable window, so the 9
        # storms open on the live store would have stayed open. The
        # trips-in-window guard above still protects a legacy entry that is
        # genuinely storming right now.
        watermark = int(entry.get("stormAt") or entry.get("lastTripAt") or 0)
    return (now - int(watermark)) >= FLAP_STABLE_SECONDS


def flap_storm_event(key: str, entry: dict[str, Any], severity: str, now: int) -> dict[str, Any]:
    """Build the consolidated flap_storm alert with Pattern E enrichment and a
    real requested_action (never 'none'); exempt from Pattern A suppression."""
    fields = incident_event_fields_from_key(key)
    underlying = str(fields.get("alertSource") or fields.get("source") or "unknown")
    trips = flap_trips_in_window(entry, now)
    cumulative = int(entry.get("cumulativeCount") or 0)
    first = int(entry.get("firstTripAt") or now)
    last = int(entry.get("lastTripAt") or now)
    additions = [
        "flap_storm=true",
        f"incident_key={key}",
        f"underlying_source={underlying}",
        f"flap_trips_in_window={trips}",
        f"flap_window_seconds={FLAP_WINDOW_SECONDS}",
        f"flap_cumulative_count={cumulative}",
        f"flap_first_seen={iso_from_epoch(first)}",
        f"flap_last_seen={iso_from_epoch(last)}",
        f"flap_rate_per_window={trips}",
        "severity_rationale=" + (
            f"critical: sustained ≥{FLAP_PROMOTE_SECONDS}s or count ≥{FLAP_CRITICAL_COUNT}"
            if severity == "critical"
            else f"warning: ≥{FLAP_TRIP_THRESHOLD} trips in {FLAP_WINDOW_SECONDS}s"
        ),
    ]
    return {
        **new_event_fields("alert", severity),
        "id": f"flap-storm-{safe_segment(key)}-{now}",
        "createdAt": now_iso(),
        **fields,
        "source": "flap_storm",
        "alertSource": underlying,
        "summary": f"Flap storm: {underlying} unstable — {cumulative} trips, {trips} in last {FLAP_WINDOW_SECONDS}s",
        "evidence": "\n".join(additions),
        "criticalAsset": {
            "asset": {"kind": "monitored_source", "instance": fields.get("instance", "unknown"), "owner": "whatsoup"},
            "failure": {
                "code": "FLAP_STORM",
                "domain": "operational_reliability",
                "recoverability": "operator_recoverable",
                "confidence": "confirmed",
                "operatorAction": FLAP_STORM_ACTION,
                "clearRequirement": f"source quiet ≥ {FLAP_STABLE_SECONDS}s",
            },
        },
        "diagnostics": {
            "dispatchLog": str(state_paths()["logs"] / "dispatch.jsonl"),
            "queue": str(state_root()),
        },
        "delivery": {"attempts": 1, "status": "flap-storm", "nextAttemptAtEpoch": 0, "lastError": None},
    }


def flap_resolve_event(key: str, entry: dict[str, Any], now: int,
                       underlying_open: bool = False) -> dict[str, Any]:
    """One terminal storm-close summary (info).

    Two honest endings (reliability 4.3): the source went genuinely quiet
    ('stable after N flaps'), or the trip traffic drained while the underlying
    incident is STILL OPEN — a persistent condition, not a recovery. The
    second wording hands off to the still-open digests so fixing the flap
    inflation never makes steady degradation read as resolved.
    """
    fields = incident_event_fields_from_key(key)
    underlying = str(fields.get("alertSource") or fields.get("source") or "unknown")
    cumulative = int(entry.get("cumulativeCount") or 0)
    first = int(entry.get("firstTripAt") or now)
    storm_at = int(entry.get("stormAt") or first)
    minutes = max(1, (now - storm_at) // 60)
    additions = [
        "flap_storm_resolved=true",
        f"incident_key={key}",
        f"underlying_source={underlying}",
        f"flap_total_count={cumulative}",
        f"flap_duration_minutes={minutes}",
        f"flap_first_seen={iso_from_epoch(first)}",
    ]
    if underlying_open:
        additions.append("persistent_overdue=true")
        additions.append("underlying_incident_open=true")
    return {
        **new_event_fields("observation", "info"),
        "id": f"flap-resolved-{safe_segment(key)}-{now}",
        "createdAt": now_iso(),
        **fields,
        "source": "flap_storm_resolved",
        "alertSource": underlying,
        "summary": (
            f"Flap storm closed: {underlying} re-emit churn ended after {cumulative} trips over {minutes}m — "
            "underlying incident STILL OPEN (persistent condition; tracked by still-open digests)"
            if underlying_open
            else f"Flap storm resolved: {underlying} stable after {cumulative} flaps over {minutes}m"
        ),
        "evidence": "\n".join(additions),
        "diagnostics": {
            "dispatchLog": str(state_paths()["logs"] / "dispatch.jsonl"),
            "queue": str(state_root()),
        },
        "delivery": {"attempts": 1, "status": "flap-resolved", "nextAttemptAtEpoch": 0, "lastError": None},
    }


def flap_scan_outbox(paths: dict[str, Path], incident: IncidentStateCycle | None = None) -> int:
    """Pre-collapse pass (§10 C1): record ONE flap trip per raw incident-alert
    event currently in the outbox, keyed by incident_key, and emit consolidated
    flap_storm alerts when a key crosses threshold / promotes. Runs BEFORE
    collapse_ready_storms so trips count raw input, not post-collapse survivors.
    Member events are suppressed later in should_suppress_send via flapState.
    Returns the number of storm alerts emitted. Fail-open throughout.

    When *incident* is provided, uses its ``.payload`` and ``.commit()``
    instead of ``load_incident_state``/``save_incident_state``.
    """
    _require_incident_cycle_if_adopted(paths, incident, helper="flap_scan_outbox")
    if not FLAP_DETECTION:
        return 0
    try:
        incident_state = (incident.payload if incident else load_incident_state(paths))
    except Exception:  # noqa: BLE001 - never block dispatch on a flap read
        return 0
    flap_state = incident_state.setdefault("flapState", {})
    now = int(time.time())
    emitted = 0
    changed = False
    for path in sorted(paths["outbox"].glob("*.json")):
        try:
            if not ready(path, paths["quarantine"]):
                continue
            event = safe_read_json(path)
        except Exception:  # noqa: BLE001 - skip unreadable, process_one will quarantine
            continue
        if not is_incident_alert(event) or is_incident_clear(event):
            continue
        if str(event.get("source") or "") == "flap_storm":
            continue
        # Reliability 4.3 (the ml-bot immortal-storm defect): a re-NOTIFICATION
        # of an unchanged open condition (poller re-emit through its throttle,
        # fresh id each time) is not an occurrence and must not trip the flap
        # window — counting it inflated cumulative forever and refreshed
        # lastTripAt faster than FLAP_STABLE_SECONDS, so the storm could never
        # resolve. Only the EMITTER knows re-emit vs fresh occurrence, so it
        # stamps `renotify: true`; per-occurrence sources (e.g. outbound
        # quarantines — genuine bursts) never carry the flag and keep tripping.
        if event.get("renotify") is True:
            continue
        key = incident_key(event)
        try:
            # #2428: a delivery retry of the SAME event occurrence must not
            # re-trip — count once per distinct event id (see
            # flap_occurrence_already_counted). The seen-map refresh is a
            # state change even when no trip is recorded.
            if flap_occurrence_already_counted(flap_entry(flap_state, key), str(event.get("id") or ""), now):
                changed = True
                continue
            entry = record_flap_trip(flap_state, key, now)
            changed = True
            decision = flap_evaluate(entry, now)
            if decision.get("emit"):
                send_whatsapp(format_event(flap_storm_event(key, entry, str(decision["severity"]), now)))
                emitted += 1
                append_dispatch_log(paths, {
                    "type": "flap_storm",
                    "incidentKey": key,
                    "severity": decision.get("severity"),
                    "reason": decision.get("reason"),
                    "cumulativeCount": entry.get("cumulativeCount"),
                    "tripsInWindow": flap_trips_in_window(entry, now),
                })
        except Exception as exc:  # noqa: BLE001 - one bad event must not block the scan
            append_dispatch_log(paths, {"type": "flap_scan_error", "incidentKey": key, "error": str(exc)})
            continue
    if changed:
        if incident:
            incident.commit()
        else:
            save_incident_state(paths, incident_state)
    return emitted


def sweep_flap_storms(paths: dict[str, Path], incident: IncidentStateCycle | None = None) -> tuple[int, int]:
    """Sweep open flap storms for resolution. Returns (resolved, errors).
    Called from run_once after per-event processing. Fail-open per entry.
    When *incident* is provided, uses its .payload and .commit()."""
    _require_incident_cycle_if_adopted(paths, incident, helper="sweep_flap_storms")
    if not FLAP_DETECTION:
        return 0, 0
    incident_state = (incident.payload if incident else load_incident_state(paths))
    flap_state = incident_state.get("flapState")
    if not isinstance(flap_state, dict) or not flap_state:
        return 0, 0
    now = int(time.time())
    resolved = 0
    errors = 0
    changed = False
    for key in sorted(flap_state.keys()):
        entry = flap_state.get(key)
        if not isinstance(entry, dict):
            continue
        try:
            # Retention prune. An entry that never opened a storm has nothing to
            # resolve, so it is dropped SILENTLY once it ages out — announcing a
            # resolve here would report a recovery that never happened. Open
            # storms are exempt: they leave only through the resolve path below,
            # so retention can never erase a live incident.
            if not entry.get("stormAt"):
                last_trip = int(entry.get("lastTripAt") or 0)
                if last_trip and (now - last_trip) >= FLAP_ENTRY_RETENTION_SECONDS:
                    flap_state.pop(key, None)
                    changed = True
                    append_dispatch_log(paths, {
                        "type": "flap_entry_pruned",
                        "incidentKey": key,
                        "lastTripAt": last_trip,
                        "ageSeconds": now - last_trip,
                    })
                continue
            if flap_should_resolve(entry, now):
                open_incidents = incident_state.get("openIncidents")
                # A resolve may only claim 'stable' when the source actually went
                # silent. Rate-based resolution closes storms whose source is
                # still tripping below threshold, and an open storm suppresses its
                # own members so `openIncidents` usually has no record of the
                # underlying condition — trusting that map alone would have
                # announced recovery for every still-degraded instance.
                underlying_open = (
                    (isinstance(open_incidents, dict) and isinstance(open_incidents.get(key), dict))
                    or not flap_source_went_quiet(entry, now)
                )
                send_whatsapp(format_event(flap_resolve_event(str(key), entry, now, underlying_open)))
                append_dispatch_log(paths, {
                    "type": "flap_storm_resolved",
                    "incidentKey": key,
                    "cumulativeCount": entry.get("cumulativeCount"),
                    "underlyingOpen": underlying_open,
                })
                flap_state.pop(key, None)
                resolved += 1
                changed = True
        except Exception as exc:  # noqa: BLE001 - one bad entry must not block the sweep
            errors += 1
            append_dispatch_log(paths, {"type": "flap_resolve_error", "incidentKey": key, "error": str(exc)})
    if changed:
        if incident:
            incident.commit()
        else:
            save_incident_state(paths, incident_state)
    return resolved, errors


def _machine_of_key(key: str) -> str:
    parts = str(key).split("|")
    return parts[0] if parts else str(key)


def _source_of_key(key: str) -> str:
    parts = str(key).split("|")
    return parts[2] if len(parts) >= 3 else ""


def is_whatsapp_daily_health_key(key: str) -> bool:
    """True iff this incident key is a WhatsApp daily-health incident that the
    recovery oracle (is_verified_whatsapp_health_recovery) actually governs.

    Scoped to exactly the keys close_recovered_daily_health_incidents can close:
    a ``daily-health-fail:`` incident, or a WhatsApp recovery source (optionally
    ``daily-health:``-prefixed). Non-WhatsApp daily-health incidents (e.g.
    provider-probe) are deliberately excluded so the WhatsApp oracle does not
    gate incidents it cannot verify — they keep the legacy age-out close.
    """
    source = _source_of_key(key)
    if source.startswith("daily-health-fail:"):
        return True
    tail = source.split(":")[-1] if source else ""
    prefix = source.split(":", 1)[0] if source else ""
    if prefix in {"", "daily-health"} and tail in DAILY_HEALTH_WHATSAPP_RECOVERY_SOURCES:
        return True
    if source in DAILY_HEALTH_WHATSAPP_RECOVERY_SOURCES:
        return True
    return False


def daily_health_monitoring_stale(machine: str, open_incidents: dict[str, Any]) -> bool:
    """A2 / §10 C2: is this machine's OWN daily-health cadence currently flagged
    stale by the heartbeat-watchdog?

    Signalled by an open incident whose source segment is
    ``heartbeat-watchdog:daily_health:<machine>`` (the watchdog tracks per-machine
    daily-health cadence). When that is open, the monitoring path that would emit a
    FRESH failure for any of this machine's daily-health incidents is itself down,
    so a daily-health incident going quiet is NOT evidence of recovery.
    """
    target = f"heartbeat-watchdog:daily_health:{machine}".lower()
    for k in open_incidents:
        if _source_of_key(k).lower() == target:
            return True
    return False


def sweep_stale_incidents(paths: dict[str, Path], skip_keys: set[str] | None = None, incident: IncidentStateCycle | None = None) -> tuple[int, int, str | None]:
    _require_incident_cycle_if_adopted(paths, incident, helper="sweep_stale_incidents")
    incident_state = (incident.payload if incident else load_incident_state(paths))
    open_incidents = incident_state.setdefault("openIncidents", {})
    current = int(time.time())
    sent = 0
    failed = 0
    suppressed = 0
    last_error = None
    changed = False
    auto_closed: list[str] = []
    for key, record in sorted(open_incidents.items()):
        if skip_keys and str(key) in skip_keys:
            continue
        if not isinstance(record, dict):
            continue
        event = stale_incident_event(str(key), record, current)
        if event is None:
            continue
        # Pattern A — suppress non-actionable (self-healed / no-op) stale renotify.
        if SUPPRESS_STALE_INFO_RENOTIFY:
            try:
                nonactionable = stale_renotify_is_nonactionable(event, str(key))
            except Exception as exc:  # fail-open: never lose a real alert to the filter
                nonactionable = False
                append_dispatch_log(paths, {
                    "type": "stale_suppress_classify_error",
                    "incidentKey": key,
                    "error": str(exc),
                })
            if nonactionable:
                mark_stale_incident_suppressed(record, event, current)
                suppressed += 1
                changed = True
                opened = int_field(record, "openedAt", current)
                age = max(0, current - opened)
                # Safety valve / §10 C5 terminal removal: a non-actionable stale
                # incident past the escalate horizon is auto-closed (removed from
                # open state) and reported ONCE in a consolidated summary below.
                will_close = age >= INCIDENT_ESCALATE_SECONDS
                held_for_liveness = False
                # A2 / §10 C2: do not close a daily-health incident as "aged out"
                # while this machine's own daily-health monitoring is stale — the
                # silence is uninformative, not proof of repair. Hold it (still
                # suppressed, not sent) until monitoring returns OR the bounded hold
                # cap elapses (§10 C5: openIncidents must stay bounded). Fail-open.
                if will_close and AUTOCLOSE_LIVENESS_GATE:
                    try:
                        if _source_of_key(str(key)).startswith("daily-health") and \
                                daily_health_monitoring_stale(
                                    _machine_of_key(str(key)), open_incidents
                                ):
                            machine = _machine_of_key(str(key))
                            # Bound the hold from when holding BEGAN (not the
                            # incident's own age): a long-quiet incident that only
                            # just lost monitoring should still ride out the outage.
                            first_held = int_field(record, "autocloseFirstHeldAt")
                            if first_held <= 0:
                                first_held = current
                                record["autocloseFirstHeldAt"] = first_held
                            held_seconds = max(0, current - first_held)
                            if held_seconds < AUTOCLOSE_LIVENESS_HOLD_CAP_SECONDS:
                                will_close = False
                                held_for_liveness = True
                                record["autocloseHeldForLiveness"] = True
                                record["lastAutocloseHoldAt"] = current
                                append_dispatch_log(paths, {
                                    "type": "autoclose_held_for_liveness",
                                    "incidentKey": key,
                                    "machine": machine,
                                    "reason": "daily_health_monitoring_stale",
                                    "ageSeconds": age,
                                    "heldSeconds": held_seconds,
                                })
                            else:
                                # Same sticky-flag correction as the recovery
                                # gate below: the hold has lapsed, so record that
                                # rather than leaving a write-once True that reads
                                # as a live hold forever.
                                record["autocloseHeldForLiveness"] = False
                                record["autocloseHoldReleasedAt"] = current
                                record["autocloseHoldReleasedReason"] = "liveness_cap_reached"
                                append_dispatch_log(paths, {
                                    "type": "autoclose_liveness_hold_cap_reached",
                                    "incidentKey": key,
                                    "machine": machine,
                                    "heldSeconds": held_seconds,
                                })
                    except Exception as exc:  # fail-open: never leak the close on a bug
                        append_dispatch_log(paths, {
                            "type": "autoclose_liveness_gate_error",
                            "incidentKey": key,
                            "error": str(exc),
                        })
                # #1429 / §10 C2: an age-out close on a daily-health incident must
                # be gated on POSITIVE recovery proof, not elapsed time alone. If
                # the exogenous oracle (is_verified_whatsapp_health_recovery, via
                # record_has_verified_health_recovery) confirms recovery -> close
                # as recovered (existing labeling). Otherwise HOLD (still
                # suppressed, not sent), REUSING the same bounded hold-cap as the
                # liveness gate (autocloseFirstHeldAt + AUTOCLOSE_LIVENESS_HOLD_CAP_
                # SECONDS) so openIncidents stays bounded (§10 C5). Once the cap
                # elapses, allow a BOUNDED, clearly-labeled unverified close that is
                # auditably distinct from a verified-recovery close. Fail-open on any
                # bug (never leak the close). Only daily-health incidents have a
                # WhatsApp-health oracle; other sources keep the legacy age-out close.
                held_for_recovery = False
                if will_close and AUTOCLOSE_LIVENESS_GATE \
                        and is_whatsapp_daily_health_key(str(key)):
                    try:
                        machine = _machine_of_key(str(key))
                        if record_has_verified_health_recovery(record):
                            record["autocloseRecoveryVerified"] = True
                            append_dispatch_log(paths, {
                                "type": "autoclose_recovery_verified",
                                "incidentKey": key,
                                "machine": machine,
                                "ageSeconds": age,
                            })
                        else:
                            first_held = int_field(record, "autocloseFirstHeldAt")
                            if first_held <= 0:
                                first_held = current
                                record["autocloseFirstHeldAt"] = first_held
                            held_seconds = max(0, current - first_held)
                            if held_seconds < AUTOCLOSE_LIVENESS_HOLD_CAP_SECONDS:
                                will_close = False
                                held_for_recovery = True
                                record["autocloseHeldForRecovery"] = True
                                record["lastAutocloseHoldAt"] = current
                                append_dispatch_log(paths, {
                                    "type": "autoclose_held_for_recovery",
                                    "incidentKey": key,
                                    "machine": machine,
                                    "reason": "recovery_not_verified",
                                    "ageSeconds": age,
                                    "heldSeconds": held_seconds,
                                })
                            else:
                                # Bounded fallback: cap exceeded with no verified
                                # recovery. Close, but tag it distinctly so it is
                                # auditable and never read as a verified recovery.
                                record["autocloseBoundedUnverified"] = True
                                # The hold is OVER. Say so explicitly rather than
                                # leaving the sticky True behind: these flags were
                                # write-once, so a record could assert
                                # "held for recovery" indefinitely after the cap
                                # released it, and a reader (human or tool) has no
                                # way to tell a live hold from an expired one. An
                                # operator reading such a record on 2026-08-16
                                # concluded an incident was still being held when
                                # the hold had lapsed three days earlier.
                                record["autocloseHeldForRecovery"] = False
                                record["autocloseHoldReleasedAt"] = current
                                record["autocloseHoldReleasedReason"] = "cap_reached"
                                append_dispatch_log(paths, {
                                    "type": "autoclose_bounded_unverified_cap_reached",
                                    "incidentKey": key,
                                    "machine": machine,
                                    "reason": "recovery_not_verified_cap_reached",
                                    "heldSeconds": held_seconds,
                                })
                    except Exception as exc:  # fail-open: never leak the close on a bug
                        append_dispatch_log(paths, {
                            "type": "autoclose_recovery_gate_error",
                            "incidentKey": key,
                            "error": str(exc),
                        })
                if will_close:
                    auto_closed.append(str(key))
                bounded_unverified = bool(record.get("autocloseBoundedUnverified"))
                append_dispatch_log(paths, {
                    "type": "stale_renotify_suppressed",
                    "reason": (
                        "bounded_unverified_autoclose_cap_reached"
                        if (will_close and bounded_unverified)
                        else "nonactionable_aged_out_unverified"
                    ),
                    "incidentKey": key,
                    "staleSuppressedCount": record.get("staleSuppressedCount"),
                    "ageSeconds": age,
                    "willAutoClose": will_close,
                    "heldForLiveness": held_for_liveness,
                    "heldForRecovery": held_for_recovery,
                    "boundedUnverifiedClose": bool(will_close and bounded_unverified),
                })
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
    # Terminal removal + coalesced auto-close summary (§10 C5 + Pattern A safety
    # valve): non-actionable stale incidents past the escalate horizon are removed
    # from open state immediately (so openIncidents cannot grow unbounded and the
    # renotify stops), but the WhatsApp digest is coalesced ACROSS sweep runs. The
    # sweep ticks every ~30s; without cross-run coalescing a draining backlog emits
    # one "Auto-closed N" message per tick, and the digest itself becomes the noise.
    if auto_closed:
        # Closure is unconditional and immediate — independent of digest cadence.
        last_sent_at = incident_state.get("lastSentAt")
        for closed_key in auto_closed:
            record_unverified_autoclose(incident_state, closed_key, current)
            open_incidents.pop(closed_key, None)
            if isinstance(last_sent_at, dict):
                last_sent_at.pop(closed_key, None)
        changed = True

    # #2403: evaluate pending digest on EVERY sweep, not only when new
    # auto-closures occur.  A digest that was waiting for the coalescing window
    # or recovering from a send failure must be re-checked even on a quiet sweep.
    # BUGFIX RED-3061-R3: `pending_check` must also fire when `auto_closed` is
    # non-empty but no `staleAutocloseDigest` entry exists yet (first-time auto-
    # closure — the original pre-#2403 code created the digest inside `if auto_closed:`
    # but the #2403 refactor moved it outside and the `has_accum` gate blocked it).
    accum = incident_state.get("staleAutocloseDigest")
    has_accum = isinstance(accum, dict)
    pending_check = bool(auto_closed) or (has_accum and int(accum.get("pendingCount") or 0) > 0)
    if pending_check:
        if not has_accum:
            accum = {}
            incident_state["staleAutocloseDigest"] = accum
        if auto_closed:
            pending_keys = accum.get("pendingKeys")
            if not isinstance(pending_keys, list):
                pending_keys = []
            pending_keys.extend(auto_closed)
            accum["pendingKeys"] = pending_keys[-200:]
            accum["pendingCount"] = int(accum.get("pendingCount") or 0) + len(auto_closed)
            if not accum.get("firstPendingAt"):
                accum["firstPendingAt"] = current

        if should_emit_autoclose_digest(accum, current):
            digest_keys = list(accum.get("pendingKeys") or [])
            digest_count = int(accum.get("pendingCount") or len(digest_keys))
            summary_event = stale_autoclose_summary_event(digest_keys, current)
            summary_event["summary"] = (
                f"Auto-closed {digest_count} non-actionable stale incident(s)"
            )
            try:
                send_whatsapp(format_event(summary_event))
                append_dispatch_log(paths, {
                    "type": "stale_autoclosed",
                    "count": digest_count,
                    "keysSample": digest_keys[:20],
                    "coalescedWindowSeconds": STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS,
                })
                accum["pendingKeys"] = []
                accum["pendingCount"] = 0
                accum["firstPendingAt"] = 0
                accum["lastDigestAt"] = current
            except Exception as exc:
                last_error = str(exc)
                append_dispatch_log(paths, {
                    "type": "stale_autoclose_summary_failed",
                    "count": digest_count,
                    "error": str(exc),
                })
        else:
            append_dispatch_log(paths, {
                "type": "stale_autoclose_digest_coalesced",
                "pendingCount": accum.get("pendingCount"),
                "closedThisSweep": len(auto_closed) if auto_closed else 0,
                "nextDigestInSeconds": max(
                    0,
                    STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS
                    - (current - int(accum.get("lastDigestAt") or 0)),
                ),
            })
    if suppressed:
        append_dispatch_log(paths, {"type": "stale_renotify_suppressed_total", "suppressed": suppressed})
    if changed:
        if incident:
            incident.commit()
        else:
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
            if not safe_is_data_entry(path):
                continue
            try:
                if safe_read_json(path).get("id") == event_id:
                    return path
            except Exception:
                continue
    return None


def is_storm_candidate(event: dict[str, Any]) -> bool:
    if isinstance(event.get("storm"), dict):
        return False
    classification = classify_event(event)
    return classification.kind == "incident_alert" and classification.severity in {"critical", "warning"}


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
    classification = classify_event(event)
    host, instance = recovery_identity(event)
    parts = [
        classification.event_type,
        classification.severity,
        str(event.get("source") or "unknown").strip().lower(),
        recovery_normalized_summary(event),
        host,
        instance,
    ]
    return "\n".join(parts)


def is_recovery_dedupe_candidate(event: dict[str, Any]) -> bool:
    classification = classify_event(event)
    source = str(event.get("source") or "").strip().lower()
    if source == "daily-health" and classification.kind == "observation":
        return False
    return classification.kind == "incident_recovery"


def is_recovery_episode_barrier(event: dict[str, Any]) -> bool:
    return classify_event(event).kind == "incident_alert"


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
        **new_event_fields("alert", severity),
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
    incident_state: dict[str, Any],
    incident: IncidentStateCycle | None = None,
) -> int:
    _require_incident_cycle_if_adopted(paths, incident, helper="collapse_storm_group")
    if incident is not None and incident.payload is not incident_state:
        # The cycle branch below persists incident.payload, so a caller that
        # hands in a different dict would have its mutations (freshness ledger,
        # daily-health absorption) silently dropped at commit(). Refuse before
        # any member publication or manifest write happens.
        raise ValueError(
            "collapse_storm_group: incident_state must be incident.payload when an "
            "IncidentStateCycle is supplied; commit() would persist a different object"
        )
    fingerprint, requested_start = key
    window = storm_window_seconds()
    fingerprint_hash = storm_fingerprint_hash(fingerprint)
    existing = existing_storm_window(paths, fingerprint_hash, requested_start)
    existing_collapsed: list[dict[str, Any]] = []
    if existing:
        existing_manifest, manifest_path = existing
        existing_collapsed = existing_manifest.get("entriesCollapsed") or []
        bucket_start = int(existing_manifest.get("windowStartEpoch") or requested_start)
        bucket_end = int(existing_manifest.get("windowEndEpoch") or (bucket_start + window))
    else:
        bucket_start = requested_start
        bucket_end = bucket_start + window
        manifest_path = paths["storm_manifests"] / f"{bucket_start}.{fingerprint_hash}.json"
    digest_id = f"storm-{fingerprint_hash}-{bucket_start}"
    events = [event for _, event in records]
    additions = [manifest_entry(path, event) for path, event in records]

    # #2282: locate the newest existing snapshot revision BEFORE mutating
    # anything. While a digest is still queued its snapshot may be re-closed —
    # manifest and digest payload updated in lockstep so the delivered page and
    # the manifest it references always agree. Once a digest is delivered (or
    # terminally suppressed/quarantined) its evidence is immutable: later
    # arrivals become an explicit superseding revision with its own manifest.
    known_digest_path = find_event_path_by_id(
        digest_id,
        paths,
        ("outbox", "processing", "sent", "suppressed", "quarantine"),
    )
    if known_digest_path is not None:
        latest_digest_id = digest_id
        latest_digest_path = known_digest_path
        next_version = 2
        while True:
            candidate_id = f"storm-{fingerprint_hash}-{bucket_start}-v{next_version}"
            candidate_path = find_event_path_by_id(
                candidate_id,
                paths,
                ("outbox", "processing", "sent", "suppressed", "quarantine"),
            )
            if candidate_path is None:
                break
            latest_digest_id = candidate_id
            latest_digest_path = candidate_path
            next_version += 1
        in_flight = latest_digest_path.parent in (paths["outbox"], paths["processing"])
        if in_flight:
            # Queued snapshot: absorb the late arrivals into the digest's bound
            # manifest and regenerate the digest's membership-derived payload.
            digest_event = read_json(latest_digest_path)
            storm_block = digest_event.get("storm") if isinstance(digest_event.get("storm"), dict) else {}
            bound_manifest_path = Path(str(storm_block.get("manifest") or "") or str(manifest_path))
            try:
                bound = read_json(bound_manifest_path)
            except Exception:
                bound = {}
            bound_entries = bound.get("entries") if isinstance(bound.get("entries"), list) else []
            bound_collapsed = bound.get("entriesCollapsed") if isinstance(bound.get("entriesCollapsed"), list) else []
            bound_hosts = bound.get("hosts") if isinstance(bound.get("hosts"), list) else []
            merged_entries = merge_manifest_entries(bound_entries, additions)
            merged_hosts = sorted(
                {str(host) for host in bound_hosts if str(host)} | set(sorted_unique_hosts(events)),
                key=lambda value: value.lower(),
            )
            append_dispatch_log(paths, {
                "type": "storm_digest_reused",
                "digestId": latest_digest_id,
                "fingerprint": fingerprint_hash,
                "collapsedEvents": len(events),
            })
            publications: list[PublicationResult] = []
            updated_manifest = dict(bound)
            updated_manifest.setdefault("schemaVersion", 1)
            updated_manifest.setdefault("kind", "bot_errors_storm_collapse")
            updated_manifest.setdefault("createdAt", now_iso())
            updated_manifest.setdefault("digestId", latest_digest_id)
            updated_manifest.setdefault("fingerprint", fingerprint_hash)
            updated_manifest.setdefault("windowStartEpoch", bucket_start)
            updated_manifest.setdefault("windowEndEpoch", bucket_end)
            updated_manifest["entries"] = merged_entries
            updated_manifest["hosts"] = merged_hosts
            updated_manifest["affectedHosts"] = len(merged_hosts)
            updated_manifest["updatedAt"] = now_iso()
            manifest_target = _durable_target(bound_manifest_path)
            manifest_observation = observe_json(manifest_target)
            manifest_generation = (manifest_observation.version.generation or 0) + 1
            manifest_operation = operation_id(
                manifest_target, updated_manifest,
                component="dispatcher.storm_manifest_initial",
                predecessor=manifest_observation.version,
            )
            absorb_manifest_publication = publish_state_json(
                manifest_target, updated_manifest,
                component="dispatcher.storm_manifest_initial",
                operation_id=manifest_operation,
                expected=manifest_observation.version,
                generation=manifest_generation,
            )
            require_all_advance([absorb_manifest_publication])
            publications.append(absorb_manifest_publication)
            summary_text = str(digest_event.get("summary") or "")
            summary_tail = (
                summary_text.split(" hosts - ", 1)[1]
                if " hosts - " in summary_text
                else (normalized_summary(events[0]) or "same fingerprint alert storm")
            )
            digest_event["summary"] = f"BOT ERRORS storm collapse: {len(merged_hosts)} hosts - {summary_tail}"
            digest_event["evidence"] = "\n".join([
                f"affected_hosts:{len(merged_hosts)}",
                f"hosts:{', '.join(merged_hosts)}",
                f"fingerprint:{fingerprint_hash}",
                f"source:{storm_block.get('source') or str(events[0].get('source') or 'unknown')}",
                f"severity:{digest_event.get('severity') or 'critical'}",
                f"window_start_epoch:{bucket_start}",
                f"window_end_epoch:{bucket_end}",
                f"collapsed_events:{len(merged_entries)}",
                f"manifest:{bound_manifest_path}",
                f"fingerprint_basis:{fingerprint.replace(chr(10), ' | ')}",
            ])
            digest_event["storm"] = {
                **storm_block,
                "hosts": merged_hosts,
                "affectedHosts": len(merged_hosts),
                "collapsedEvents": len(merged_entries),
                "manifest": str(bound_manifest_path),
            }
            digest_target = _durable_target(latest_digest_path)
            digest_observation = observe_json(digest_target)
            digest_generation = (digest_observation.version.generation or 0) + 1
            digest_operation = operation_id(
                digest_target, digest_event,
                component="dispatcher.storm_digest_refresh",
                predecessor=digest_observation.version,
            )
            digest_refresh_publication = publish_state_json(
                digest_target, digest_event,
                component="dispatcher.storm_digest_refresh",
                operation_id=digest_operation,
                expected=digest_observation.version,
                generation=digest_generation,
            )
            require_all_advance([digest_refresh_publication])
            publications.append(digest_refresh_publication)
            collapsed = 0
            collapsed_entries: list[dict[str, Any]] = []
            prepared: list[tuple[Path, Path, dict[str, Any]]] = []
            state_changed = False
            for path, event in records:
                if not path.exists():
                    append_dispatch_log(paths, {
                        "type": "storm_collapse_missing_source",
                        "digestId": latest_digest_id,
                        "sourcePath": str(path),
                    })
                    continue
                absorb_daily_health_signal(event, incident_state)
                if str(event.get("source") or "").startswith("daily-health"):
                    state_changed = True
                event = mark_collapsed(event, latest_digest_id, bound_manifest_path)
                member_target = _durable_target(path)
                member_observation = observe_json(member_target)
                member_generation = (member_observation.version.generation or 0) + 1
                member_operation = operation_id(
                    member_target, event,
                    component="dispatcher.storm_member_state",
                    predecessor=member_observation.version,
                )
                member_publication = publish_state_json(
                    member_target, event,
                    component="dispatcher.storm_member_state",
                    operation_id=member_operation,
                    expected=member_observation.version,
                    generation=member_generation,
                )
                require_all_advance([member_publication])
                publications.append(member_publication)
                target = paths["storm_collapsed"] / (
                    f"{path.name}.{safe_segment(latest_digest_id)}.{int(time.time())}.collapsed"
                )
                prepared.append((path, target, event))
            if state_changed:
                if incident:
                    incident.commit()
                else:
                    publications.append(save_incident_state(paths, incident_state))
            require_all_advance(publications)
            for path, target, event in prepared:
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
                    "digestId": latest_digest_id,
                    "fingerprint": fingerprint_hash,
                    "sourcePath": str(path),
                    "collapsedPath": str(target),
                    "manifest": str(bound_manifest_path),
                })
            updated_manifest["entriesCollapsed"] = merge_manifest_entries(bound_collapsed, collapsed_entries)
            final_observation = observe_json(manifest_target)
            final_generation = (final_observation.version.generation or 0) + 1
            final_operation = operation_id(
                manifest_target, updated_manifest,
                component="dispatcher.storm_manifest_final",
                predecessor=final_observation.version,
            )
            final_publication = publish_state_json(
                manifest_target, updated_manifest,
                component="dispatcher.storm_manifest_final",
                operation_id=final_operation,
                expected=final_observation.version,
                generation=final_generation,
            )
            require_all_advance([*publications, final_publication])
            return collapsed

        # Delivered/terminal snapshot: evidence is immutable. Create an explicit
        # superseding revision with its own manifest and digest; the original
        # manifest and digest stay byte-stable.
        superseding_digest_id = f"storm-{fingerprint_hash}-{bucket_start}-v{next_version}"
        superseding_manifest_path = (
            paths["storm_manifests"] / f"{bucket_start}.{fingerprint_hash}.v{next_version}.json"
        )
        revision_hosts = sorted(set(sorted_unique_hosts(events)), key=lambda value: value.lower())
        publications = []
        superseding_manifest = {
            "schemaVersion": 1,
            "kind": "bot_errors_storm_collapse",
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "digestId": superseding_digest_id,
            "fingerprint": fingerprint_hash,
            "windowStartEpoch": bucket_start,
            "windowEndEpoch": bucket_end,
            "affectedHosts": len(revision_hosts),
            "hosts": revision_hosts,
            "entries": additions,
            "supersedesDigest": latest_digest_id,
        }
        superseding_manifest_target = _durable_target(superseding_manifest_path)
        superseding_manifest_observation = observe_json(superseding_manifest_target)
        superseding_manifest_generation = (superseding_manifest_observation.version.generation or 0) + 1
        superseding_manifest_operation = operation_id(
            superseding_manifest_target, superseding_manifest,
            component="dispatcher.storm_manifest_superseding",
            predecessor=superseding_manifest_observation.version,
        )
        superseding_manifest_publication = publish_state_json(
            superseding_manifest_target, superseding_manifest,
            component="dispatcher.storm_manifest_superseding",
            operation_id=superseding_manifest_operation,
            expected=superseding_manifest_observation.version,
            generation=superseding_manifest_generation,
        )
        require_all_advance([superseding_manifest_publication])
        publications.append(superseding_manifest_publication)
        superseding_digest = storm_digest_event(
            paths, fingerprint, fingerprint_hash, bucket_start, bucket_end, events, superseding_manifest_path
        )
        superseding_digest["id"] = superseding_digest_id
        superseding_digest["supersedesId"] = latest_digest_id
        superseding_digest["storm"]["supersedesDigest"] = latest_digest_id
        superseding_digest_path = storm_digest_outbox_path(
            paths, superseding_digest_id, str(superseding_digest.get("source")), bucket_start
        )
        superseding_digest_target = _durable_target(superseding_digest_path)
        superseding_absent = JsonVersion(False, None, None, None)
        superseding_digest_operation = operation_id(
            superseding_digest_target, superseding_digest,
            component="dispatcher.storm_digest_superseding",
            predecessor=superseding_absent,
        )
        superseding_digest_publication = publish_event_json(
            superseding_digest_target, superseding_digest,
            component="dispatcher.storm_digest_superseding",
            operation_id=superseding_digest_operation,
        )
        require_all_advance([superseding_digest_publication])
        publications.append(superseding_digest_publication)
        append_dispatch_log(paths, {
            "type": "storm_digest_superseded",
            "supersedingDigestId": superseding_digest_id,
            "supersededDigestId": latest_digest_id,
            "supersedingDigestPath": str(superseding_digest_path),
            "fingerprint": fingerprint_hash,
            "affectedHosts": len(revision_hosts),
            "newCollapsedEvents": len(events),
            "manifest": str(superseding_manifest_path),
        })
        collapsed = 0
        collapsed_entries = []
        prepared = []
        state_changed = False
        for path, event in records:
            if not path.exists():
                append_dispatch_log(paths, {
                    "type": "storm_collapse_missing_source",
                    "digestId": superseding_digest_id,
                    "sourcePath": str(path),
                })
                continue
            absorb_daily_health_signal(event, incident_state)
            if str(event.get("source") or "").startswith("daily-health"):
                state_changed = True
            event = mark_collapsed(event, superseding_digest_id, superseding_manifest_path)
            member_target = _durable_target(path)
            member_observation = observe_json(member_target)
            member_generation = (member_observation.version.generation or 0) + 1
            member_operation = operation_id(
                member_target, event,
                component="dispatcher.storm_member_state",
                predecessor=member_observation.version,
            )
            member_publication = publish_state_json(
                member_target, event,
                component="dispatcher.storm_member_state",
                operation_id=member_operation,
                expected=member_observation.version,
                generation=member_generation,
            )
            require_all_advance([member_publication])
            publications.append(member_publication)
            target = paths["storm_collapsed"] / (
                f"{path.name}.{safe_segment(superseding_digest_id)}.{int(time.time())}.collapsed"
            )
            prepared.append((path, target, event))
        if state_changed:
            # Route through the cycle exactly as the two sibling branches of
            # this function already do. Without this gate a caller holding an
            # IncidentStateCycle still bare-wrote the primary here, destroying
            # the _controllerState envelope: the sole ungated save_incident_state
            # of the 12 executable call sites in this file, and the one that took the dispatcher into
            # a schema_incompatible crash loop on 2026-08-30.
            if incident:
                incident.commit()
            else:
                publications.append(save_incident_state(paths, incident_state))
        require_all_advance(publications)
        for path, target, event in prepared:
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
                "digestId": superseding_digest_id,
                "fingerprint": fingerprint_hash,
                "sourcePath": str(path),
                "collapsedPath": str(target),
                "manifest": str(superseding_manifest_path),
            })
        superseding_manifest["entriesCollapsed"] = merge_manifest_entries([], collapsed_entries)
        superseding_final_observation = observe_json(superseding_manifest_target)
        superseding_final_generation = (superseding_final_observation.version.generation or 0) + 1
        superseding_final_operation = operation_id(
            superseding_manifest_target, superseding_manifest,
            component="dispatcher.storm_manifest_final",
            predecessor=superseding_final_observation.version,
        )
        superseding_final_publication = publish_state_json(
            superseding_manifest_target, superseding_manifest,
            component="dispatcher.storm_manifest_final",
            operation_id=superseding_final_operation,
            expected=superseding_final_observation.version,
            generation=superseding_final_generation,
        )
        require_all_advance([*publications, superseding_final_publication])
        return collapsed

    # No existing digest — this is the first batch for this storm window.
    # Create fresh manifest + digest (original pre-#2282 behavior).
    manifest = existing_manifest if existing else {}
    if not manifest and manifest_path.exists():
        try:
            manifest = read_json(manifest_path)
        except Exception:
            manifest = {}
    existing_entries = manifest.get("entries") if isinstance(manifest.get("entries"), list) else []
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
    publications: list[PublicationResult] = []
    manifest_target = _durable_target(manifest_path)
    manifest_observation = observe_json(manifest_target)
    manifest_generation = (manifest_observation.version.generation or 0) + 1
    manifest_operation = operation_id(
        manifest_target, manifest,
        component="dispatcher.storm_manifest_initial",
        predecessor=manifest_observation.version,
    )
    initial_manifest_publication = publish_state_json(
        manifest_target, manifest,
        component="dispatcher.storm_manifest_initial",
        operation_id=manifest_operation,
        expected=manifest_observation.version,
        generation=manifest_generation,
    )
    require_all_advance([initial_manifest_publication])
    publications.append(initial_manifest_publication)

    digest = storm_digest_event(
        paths, fingerprint, fingerprint_hash, bucket_start, bucket_end, events, manifest_path
    )
    digest_path = storm_digest_outbox_path(paths, digest_id, str(digest.get("source")), bucket_start)
    digest_target = _durable_target(digest_path)
    absent = JsonVersion(False, None, None, None)
    digest_operation = operation_id(
        digest_target,
        digest,
        component="dispatcher.storm_digest",
        predecessor=absent,
    )
    digest_publication = publish_event_json(
        digest_target,
        digest,
        component="dispatcher.storm_digest",
        operation_id=digest_operation,
    )
    require_all_advance([digest_publication])
    publications.append(digest_publication)
    append_dispatch_log(paths, {
        "type": "storm_digest_queued",
        "digestId": digest.get("id"),
        "digestPath": str(digest_path),
        "fingerprint": fingerprint_hash,
        "affectedHosts": len(sorted_unique_hosts(events)),
        "collapsedEvents": len(events),
        "manifest": str(manifest_path),
    })
    manifest["digestOutboxPath"] = str(digest_path)

    # Absorb the whole batch in memory, persist the absorbed
    # state ONCE, and only then perform the terminal moves out of outbox/ —
    # mirroring process_one's proven save-before-move pattern. Pre-fix the
    # move for member N happened before ANY save, so a crash between "file
    # moved" and "state saved" lost that member's freshness/closure for
    # good (it is no longer in outbox/ for anything to reprocess). Absorb is
    # idempotent, so a crash AFTER the save but before some moves is safe —
    # restart just re-collapses the still-present survivors identically.
    # The save itself is gated on an actual daily-health event having been
    # absorbed, so a storm of non-daily-health alerts collapses without ever
    # touching incident_state (no wasted read/write/fsync).
    collapsed = 0
    collapsed_entries: list[dict[str, Any]] = []
    prepared: list[tuple[Path, Path, dict[str, Any]]] = []
    state_changed = False
    for path, event in records:
        if not path.exists():
            append_dispatch_log(paths, {
                "type": "storm_collapse_missing_source",
                "digestId": digest.get("id"),
                "sourcePath": str(path),
            })
            continue
        absorb_daily_health_signal(event, incident_state)
        if str(event.get("source") or "").startswith("daily-health"):
            state_changed = True
        event = mark_collapsed(event, str(digest.get("id")), manifest_path)
        member_target = _durable_target(path)
        member_observation = observe_json(member_target)
        member_generation = (member_observation.version.generation or 0) + 1
        member_operation = operation_id(
            member_target,
            event,
            component="dispatcher.storm_member_state",
            predecessor=member_observation.version,
        )
        member_publication = publish_state_json(
            member_target,
            event,
            component="dispatcher.storm_member_state",
            operation_id=member_operation,
            expected=member_observation.version,
            generation=member_generation,
        )
        require_all_advance([member_publication])
        publications.append(member_publication)
        target = paths["storm_collapsed"] / (
            f"{path.name}.{safe_segment(str(digest.get('id')))}.{int(time.time())}.collapsed"
        )
        prepared.append((path, target, event))

    if state_changed:
        if incident:
            incident.commit()
        else:
            publications.append(save_incident_state(paths, incident_state))

    require_all_advance(publications)

    for path, target, event in prepared:
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
    final_observation = observe_json(manifest_target)
    final_generation = (final_observation.version.generation or 0) + 1
    final_operation = operation_id(
        manifest_target,
        manifest,
        component="dispatcher.storm_manifest_final",
        predecessor=final_observation.version,
    )
    final_manifest_publication = publish_state_json(
        manifest_target,
        manifest,
        component="dispatcher.storm_manifest_final",
        operation_id=final_operation,
        expected=final_observation.version,
        generation=final_generation,
    )
    require_all_advance([*publications, final_manifest_publication])
    return collapsed


def collapse_ready_storms(paths: dict[str, Path], incident: IncidentStateCycle | None = None) -> int:
    _require_incident_cycle_if_adopted(paths, incident, helper="collapse_ready_storms")
    threshold = storm_threshold()
    if threshold < 2:
        return 0
    window = storm_window_seconds()
    groups: dict[str, list[tuple[Path, dict[str, Any], int]]] = {}
    for path in sorted(paths["outbox"].glob("*.json")):
        if not ready(path, paths["quarantine"]):
            continue
        try:
            event = safe_read_json(path)
        except Exception:
            continue
        if not is_storm_candidate(event):
            continue
        fingerprint = storm_fingerprint(event)
        groups.setdefault(fingerprint, []).append((path, event, created_epoch(event)))

    if not groups:
        return 0

    # TRUTH-01: loaded once up front and threaded into collapse_storm_group so
    # every collapsed member absorbs freshness + incident-closure before it
    # leaves outbox/ — collapse_ready_storms runs before process_one ever
    # sees these events, and pre-fix that meant they never absorbed at all.
    # Each collapse_storm_group() call now persists its OWN
    # absorbed state before its OWN terminal moves, so no outer save is
    # needed (or wanted — an outer save-once-at-the-end is exactly the
    # ordering that let a crash mid-batch lose an already-moved member's
    # stamp; see collapse_storm_group's docstring/comments for the fix).
    incident_state = (incident.payload if incident else load_incident_state(paths))
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
                    incident_state,
                    incident=incident,
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
    # Archival writes must honor the envelope contract ("normalized to v2
    # before ... archival") even on pre-loop paths that never reach
    # process_one. normalize_event is idempotent on already-v2 events, and
    # every caller passes an event that has classified successfully.
    event = mark_suppressed(normalize_event(event), reason)
    target = _durable_target(path)
    observation = observe_json(target)
    generation = (observation.version.generation or 0) + 1
    publication_operation = operation_id(
        target,
        event,
        component="dispatcher.suppressed_event_state",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        event,
        component="dispatcher.suppressed_event_state",
        operation_id=publication_operation,
        expected=observation.version,
        generation=generation,
    )
    require_all_advance([publication])
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


def queued_alert_precedes_recovery(
    alert_event: dict[str, Any],
    alert_epoch: int,
    alert_order: int | None,
    clear_event: dict[str, Any],
    clear_epoch: int,
    clear_order: int | None,
) -> bool:
    if is_quarantine_incident(alert_event) or is_quarantine_incident(clear_event):
        return alert_order is not None and clear_order is not None and alert_order < clear_order
    return alert_epoch <= clear_epoch


def suppress_alerts_recovered_before_delivery(paths: dict[str, Path], incident: IncidentStateCycle | None = None) -> int:
    """Retire queued alerts when a later clear proves recovery before delivery.

    This closes the retry-ordering hole where a temporarily undeliverable alert
    stays in ``outbox/``, its clear is orphan-suppressed, and the old alert pages
    after service recovery. When an incident is already recorded as open, only
    the undelivered duplicate alert is retired; its clear remains visible.
    """
    _require_incident_cycle_if_adopted(paths, incident, helper="suppress_alerts_recovered_before_delivery")
    incident_state = (incident.payload if incident else load_incident_state(paths))
    open_incidents = incident_state.get("openIncidents")
    if not isinstance(open_incidents, dict):
        open_incidents = {}

    alerts_by_key: dict[str, list[tuple[Path, dict[str, Any], int, int | None]]] = {}
    clears: list[tuple[Path, dict[str, Any], int, int | None]] = []
    for path in sorted(paths["outbox"].glob("*.json")):
        event = load_valid_event_or_quarantine(path, paths["quarantine"])
        if event is None:
            continue
        epoch = event_created_epoch(event)
        if epoch is None:
            continue
        order = event_created_order(event)
        if is_incident_alert(event):
            alerts_by_key.setdefault(incident_key(event), []).append((path, event, epoch, order))
        elif is_incident_clear(event) and delivery_ready(event):
            clears.append((path, event, epoch, order))

    suppressed = 0
    for clear_path, clear_event, clear_epoch, clear_order in sorted(
        clears,
        key=lambda row: (row[3] if row[3] is not None else row[2] * 1_000_000, str(row[0])),
    ):
        key = incident_key(clear_event)
        if not clear_path.exists():
            continue
        pending_alerts = [
            record for record in alerts_by_key.get(key, [])
            if record[0].exists()
            and queued_alert_precedes_recovery(
                record[1], record[2], record[3], clear_event, clear_epoch, clear_order,
            )
            and not ready(record[0], paths["quarantine"])
        ]
        if not pending_alerts:
            continue

        # #2430: absorb every daily-health carrier that will leave the
        # outbox in this iteration, then persist changed incident state
        # ONCE before any terminal move \u2014 mirroring the save-before-move
        # pattern of collapse_ready_storms / suppress_ready_recovery_
        # duplicates (the two sibling pre-loop passes). #3061 added the
        # in-memory absorb but no save, so the mutation was discarded at
        # end of cycle and the moved files could not be reconstructed.
        # When no same-key incident is open, both the alert(s) and the
        # clear are retired here, so batch-absorb both so the newer
        # valid observation wins the monotonic freshness ledger. When an
        # incident is open and the clear will still dispatch, only the
        # retiring alert is absorbed here; the clear\u2019s freshness is left
        # to normal process_one() processing. A save failure raises
        # through save_incident_state()/incident.commit() (via
        # require_advance) BEFORE any move runs, leaving both files
        # retryable in the outbox as a visible failed run.
        state_changed = False
        for _alert_path, alert_event, _alert_epoch, _alert_order in pending_alerts:
            if str(alert_event.get("source") or "").startswith("daily-health"):
                absorb_daily_health_signal(alert_event, incident_state)
                state_changed = True
        migrate_legacy_unqualified_incident(clear_event, incident_state)
        clear_will_dispatch = isinstance(open_incidents.get(key), dict)
        if not clear_will_dispatch and str(clear_event.get("source") or "").startswith("daily-health"):
            absorb_daily_health_signal(clear_event, incident_state)
            state_changed = True
        if state_changed:
            if incident:
                incident.commit()
            else:
                save_incident_state(paths, incident_state)

        alert_ids: list[str] = []
        for alert_path, alert_event, _alert_epoch, _alert_order in pending_alerts:
            move_suppressed_event(
                alert_path,
                paths,
                alert_event,
                RECOVERED_BEFORE_DELIVERY_REASON,
                "recovered_before_delivery_alert_suppressed",
            )
            alert_ids.append(str(alert_event.get("id") or "unknown"))
            suppressed += 1
        if not clear_will_dispatch:
            move_suppressed_event(
                clear_path,
                paths,
                clear_event,
                RECOVERED_BEFORE_DELIVERY_REASON,
                "recovered_before_delivery_clear_suppressed",
            )
            suppressed += 1
        append_dispatch_log(paths, {
            "type": "recovered_before_delivery",
            "incidentKey": key,
            "alertEventIds": alert_ids,
            "clearEventId": clear_event.get("id"),
            "clearCreatedAtEpoch": clear_epoch,
            "clearWillDispatch": clear_will_dispatch,
        })
        alerts_by_key[key] = [
            record for record in alerts_by_key.get(key, []) if record[0].exists()
        ]
    return suppressed


def suppress_ready_recovery_duplicates(paths: dict[str, Path], incident: IncidentStateCycle | None = None) -> int:
    _require_incident_cycle_if_adopted(paths, incident, helper="suppress_ready_recovery_duplicates")
    window = recovery_dedupe_window_seconds()
    groups: dict[str, list[tuple[Path, dict[str, Any], int]]] = {}
    for path in sorted(paths["outbox"].glob("*.json")):
        if not ready(path, paths["quarantine"]):
            continue
        try:
            event = safe_read_json(path)
        except Exception:
            continue
        if not is_recovery_dedupe_candidate(event) and not is_recovery_episode_barrier(event):
            continue
        groups.setdefault(recovery_episode_fingerprint(event), []).append((path, event, created_epoch(event)))

    if not groups:
        return 0

    # First, identify every duplicate to suppress across all
    # groups WITHOUT absorbing or moving yet. Barrier-clearing must still
    # happen inline here (it depends on chronological scan order), but the
    # actual freshness/closure absorption and terminal move are deferred to
    # the two steps below so the whole batch's absorbed state can be persisted
    # ONCE before any move — mirroring process_one's proven save-before-move
    # pattern (TRUTH-01: the dedupe group key is machine/instance via
    # recovery_identity, while the freshness ledger keys on the relay
    # remoteHost, so a discarded duplicate can carry a distinct remoteHost
    # from the kept sibling's — its stamp is genuinely lost, not merely
    # delayed, unless absorbed here before it leaves outbox/).
    duplicates: list[tuple[Path, dict[str, Any]]] = []
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
                duplicates.append((path, event))
                continue
            kept_by_duplicate_fingerprint[duplicate_fingerprint] = epoch

    if not duplicates:
        return 0

    # Next, absorb the whole batch in memory, then persist ONCE — gated
    # on an actual daily-health duplicate having been absorbed, so a batch
    # of non-daily-health duplicates never touches incident_state (no
    # wasted read/write/fsync). Loaded lazily (only once a duplicate is
    # actually found) for the same reason.
    incident_state = (incident.payload if incident else load_incident_state(paths))
    state_changed = False
    for _path, event in duplicates:
        absorb_daily_health_signal(event, incident_state)
        if str(event.get("source") or "").startswith("daily-health"):
            state_changed = True
    if state_changed:
        if incident:
            incident.commit()
        else:
            save_incident_state(paths, incident_state)

    # Finally, the terminal moves, only now that any absorbed state is durable.
    suppressed = 0
    for path, event in duplicates:
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
    return suppressed


def prune_suppressed(paths: dict[str, Path]) -> int:
    cap = suppressed_max_files()
    files = [
        path
        for path in paths["suppressed"].glob("*")
        if safe_is_data_entry(path)
    ]
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


def write_meta_state(
    paths: dict[str, Path],
    state: dict[str, Any],
) -> PublicationResult:
    target = _durable_target(paths["meta_state"])
    observation = observe_json(target)
    generation = (observation.version.generation or 0) + 1
    publication_operation = operation_id(
        target,
        state,
        component="dispatcher.meta_state",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        state,
        component="dispatcher.meta_state",
        operation_id=publication_operation,
        expected=observation.version,
        generation=generation,
    )
    require_advance(publication)
    return publication


def test_provenance_meta_event(paths: dict[str, Path], refused: int, window: int) -> dict[str, Any]:
    now = int(time.time())
    return {
        **new_event_fields("alert", "warning"),
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
    target = _durable_target(path)
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        target,
        event,
        component="dispatcher.test_provenance_meta_alert",
        predecessor=absent,
    )
    event_publication = publish_event_json(
        target,
        event,
        component="dispatcher.test_provenance_meta_alert",
        operation_id=publication_operation,
    )
    require_advance(event_publication)
    state["testProvenanceMetaAlertAtEpoch"] = now
    state["testProvenanceMetaAlertEventId"] = event["id"]
    state_publication = write_meta_state(paths, state)
    require_all_advance([event_publication, state_publication])
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
            event = safe_read_json(path)
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


def load_valid_event_or_quarantine(path: Path, quarantine_dir: Path) -> dict[str, Any] | None:
    # #2484: reject symlink and non-regular leaves before reading.  Quarantine
    # the directory entry itself without dereferencing its target.
    if not safe_is_regular_entry(path):
        quarantine_untrusted_entry(path, quarantine_dir, "untrusted leaf entry")
        return None
    try:
        event = safe_read_json(path)
    except UntrustedEntryError:
        quarantine_untrusted_entry(path, quarantine_dir, "untrusted leaf entry after open")
        return None
    except Exception as exc:
        quarantine_poison(path, quarantine_dir, f"invalid JSON before claim: {exc}")
        return None
    try:
        classify_event(event)
    except EnvelopeError as exc:
        quarantine_invalid_envelope(path, quarantine_dir, exc.code)
        return None
    return event


def delivery_ready(event: dict[str, Any]) -> bool:
    delivery = event.get("delivery") if isinstance(event.get("delivery"), dict) else {}
    # #2437: a syntactically valid event may still carry a malformed
    # nextAttemptAtEpoch (non-numeric string, float, dict, list, etc.).
    # int(...) raises on those, which previously aborted the whole scan loop
    # and permanently wedged the dispatcher queue. Treat any unreadable
    # timestamp as "not ready" so the scan skips this record instead of
    # crashing; ready() quarantines such events so they do not linger.
    try:
        next_attempt = int(delivery.get("nextAttemptAtEpoch") or 0)
    except (TypeError, ValueError):
        return False
    return next_attempt <= int(time.time())


def ready(path: Path, quarantine_dir: Path) -> bool:
    event = load_valid_event_or_quarantine(path, quarantine_dir)
    if event is None:
        return False
    delivery = event.get("delivery") if isinstance(event.get("delivery"), dict) else {}
    try:
        int(delivery.get("nextAttemptAtEpoch") or 0)
    except (TypeError, ValueError) as exc:
        # #2437: quarantine malformed metadata so a single poison record
        # cannot wedge the queue; the scan continues with the next event.
        quarantine_poison(path, quarantine_dir, f"malformed delivery.nextAttemptAtEpoch: {exc}")
        return False
    try:
        int(delivery.get("attempts") or 0)
    except (TypeError, ValueError) as exc:
        # #2437 boundary-2: same poison-record class as nextAttemptAtEpoch,
        # but the malformed value is only reached inside mark_attempt() AFTER
        # claim() has moved the file to processing/. The exception escapes
        # process_one() pre-update; on restart reclaim_processing() bounces
        # the record back to outbox, creating an infinite claim-fail loop.
        # Validate here (before claim) so the scan quarantines and continues.
        quarantine_poison(path, quarantine_dir, f"malformed delivery.attempts: {exc}")
        return False
    return delivery_ready(event)


def quarantine_invalid_envelope(path: Path, quarantine_dir: Path, code: str) -> Path:
    """Quarantine an invalid envelope without treating it as an alert to send."""

    ensure_private_dir(quarantine_dir)
    reason = safe_segment(code)
    dest = quarantine_dir / f"{path.name}.{int(time.time())}.{os.getpid()}.{reason}.invalid-envelope"
    try:
        shutil.move(str(path), str(dest))
    except FileNotFoundError:
        return dest
    return dest


def quarantine_poison(path: Path, quarantine_dir: Path, reason: str) -> Path:
    ensure_private_dir(quarantine_dir)
    dest = quarantine_dir / f"{path.name}.{int(time.time())}.{os.getpid()}.poison"
    try:
        shutil.move(str(path), str(dest))
    except FileNotFoundError:
        return dest
    meta = {
        **new_event_fields("alert", "critical"),
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
        # #3070: classify an accepted email fallback as TERMINAL here, not
        # accepted_unconfirmed. A poison event is already moved to quarantine
        # (no requeue path), so a successful email handoff is a delivered
        # alert -- mirroring the #3024 delivery-site semantics so the dispatch
        # log never reports a delivered poison alert as unconfirmed/retryable.
        email_status = "email_delivered" if email_fallback("BOT ERRORS poison event quarantine", text) else "failed"
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
        if email_status != "not_attempted":
            log_record["emailFallbackAt"] = now_iso()
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
            if not safe_is_data_entry(path):
                continue
            try:
                existing = safe_read_json(path)
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


def outbox_timestamp_prefix(created_at: object) -> str:
    """Keep milliseconds without overtaking a legacy same-second `...Z.` file."""
    raw = str(created_at or now_iso())
    fractional = re.fullmatch(r"(.*)\.(\d{3})Z", raw)
    if fractional:
        return f"{fractional.group(1).replace('-', '').replace(':', '')}Z_{fractional.group(2)}"
    return raw.replace("-", "").replace(":", "")


def outbox_path_for_event(event: dict[str, Any], paths: dict[str, Path]) -> Path:
    created = outbox_timestamp_prefix(event.get("createdAt"))
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
            if not safe_is_regular_entry(path):
                continue
            try:
                crumb = safe_read_json(path)
                if crumb.get("kind") != "outbox_write_failure":
                    raise ValueError("writefail breadcrumb kind is not outbox_write_failure")
                event = crumb.get("event")
                if not isinstance(event, dict):
                    raise ValueError("writefail breadcrumb missing event object")
                try:
                    event = normalize_event(event)
                except EnvelopeError as exc:
                    quarantined = move_writefail(
                        path,
                        paths["writefail_quarantine"],
                        f"invalid-envelope-{safe_segment(exc.code)}",
                    )
                    append_dispatch_log(paths, {
                        "type": "writefail_invalid_envelope",
                        "reason": exc.code,
                    })
                    continue
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
                    target = _durable_target(outbox_path)
                    absent = JsonVersion(False, None, None, None)
                    publication_operation = operation_id(
                        target,
                        event,
                        component="dispatcher.writefail_recovery_event",
                        predecessor=absent,
                    )
                    publication = publish_event_json(
                        target,
                        event,
                        component="dispatcher.writefail_recovery_event",
                        operation_id=publication_operation,
                    )
                    require_all_advance([publication])
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
    # #2484: re-establish the no-follow regular-file invariant AFTER the move.
    # os.replace moves the directory entry itself; if the original was a
    # symlink the claimed path is still a symlink pointing outside the queue.
    if not safe_is_regular_entry(dest):
        quarantine_untrusted_entry(dest, processing_dir.parent / "quarantine", "untrusted entry survived claim")
        raise UntrustedEntryError("claimed entry is not a regular file")
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
        if not safe_is_data_entry(path):
            continue
        target = safe_child_path(paths["outbox"], original_name_from_processing(path))
        os.replace(path, target)
        fsync_parent(target)
        append_dispatch_log(paths, {"type": "reclaim", "from": str(path), "to": str(target)})
        reclaimed += 1
    return reclaimed


def record_state(paths: dict[str, Path], **updates: Any) -> None:
    counts = {
        "outbox": sum(1 for p in paths["outbox"].glob("*.json") if safe_is_data_entry(p)),
        "processing": sum(1 for p in paths["processing"].glob("*") if safe_is_data_entry(p)),
        "sent": sum(1 for p in paths["sent"].glob("*") if safe_is_data_entry(p)),
        "stormCollapsed": sum(1 for p in paths["storm_collapsed"].glob("*") if safe_is_data_entry(p)),
        "stormManifests": sum(1 for p in paths["storm_manifests"].glob("*") if safe_is_data_entry(p)),
        "suppressed": sum(1 for p in paths["suppressed"].glob("*") if safe_is_data_entry(p)),
        "quarantine": sum(1 for p in paths["quarantine"].glob("*") if safe_is_data_entry(p)),
        "writefail": sum(sum(1 for p in path.glob("*.writefail") if safe_is_regular_entry(p)) for path in writefail_dirs() if path.exists()),
        "writefailRecovered": sum(1 for p in paths["writefail_recovered"].glob("*") if safe_is_data_entry(p)),
        "writefailQuarantine": sum(1 for p in paths["writefail_quarantine"].glob("*") if safe_is_data_entry(p)),
    }
    state = {
        "updatedAt": now_iso(),
        "pid": os.getpid(),
        "machine": socket.gethostname(),
        "counts": counts,
        **updates,
    }
    target = _durable_target(paths["state"])
    observation = observe_json(target)
    generation = (observation.version.generation or 0) + 1
    publication_operation = operation_id(
        target,
        state,
        component="dispatcher.state",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        state,
        component="dispatcher.state",
        operation_id=publication_operation,
        expected=observation.version,
        generation=generation,
    )
    require_advance(publication)


def process_one(path: Path, paths: dict[str, Path], incident: IncidentStateCycle | None = None) -> tuple[bool, str]:
    _require_incident_cycle_if_adopted(paths, incident, helper="process_one")
    # #2484: ready() already verified the leaf is regular and readable, but
    # claim() renames it — re-verify the claimed path before parsing.
    try:
        claimed = claim(path, paths["processing"])
    except UntrustedEntryError:
        return False, "untrusted"
    try:
        event = safe_read_json(claimed)
    except UntrustedEntryError:
        quarantine_untrusted_entry(claimed, paths["quarantine"], "untrusted entry after claim")
        return False, "untrusted"
    except Exception as exc:
        quarantine_poison(claimed, paths["quarantine"], f"invalid JSON after claim: {exc}")
        return False, "poison"
    try:
        event = normalize_event(event)
    except EnvelopeError as exc:
        quarantine_invalid_envelope(claimed, paths["quarantine"], exc.code)
        return False, "invalid_envelope"
    normalize_target = _durable_target(claimed)
    normalize_observation = observe_json(normalize_target)
    normalize_operation = operation_id(
        normalize_target,
        event,
        component="dispatcher.claimed_event_normalize",
        predecessor=normalize_observation.version,
    )
    normalize_publication = publish_state_json(
        normalize_target,
        event,
        component="dispatcher.claimed_event_normalize",
        operation_id=normalize_operation,
        expected=normalize_observation.version,
        generation=(normalize_observation.version.generation or 0) + 1,
    )
    if not normalize_publication.advance_allowed:
        require_advance(normalize_publication)

    # #3404: recover what the PRODUCER claimed, before ANY test-provenance
    # decision is taken on this event. Both gates below read this and nothing
    # else: the B2 queue check here, and the F5 email gate further down.
    #
    # Neither may read the live event, because on every attempt after the first
    # the live event carries the dispatcher's OWN text, persisted by the retry
    # path: diagnostics.dispatchLog, and delivery.lastError holding the
    # transport's exception string. When a transport error named a fixture path
    # -- shipped code raises RuntimeError(f"socket missing: {socket_path}") --
    # attempt 1 wrote it into the event, the retry published it back to the
    # queue file, and attempt 2's B2 check read it and ARCHIVED a genuine
    # critical alert as a test leak. The alert was destroyed, not merely
    # delayed, and the email fallback never ran.
    #
    # A snapshot failure must NOT escape: run_once calls process_one unguarded
    # and reclaim_processing returns a stranded claimed file to the outbox with
    # no attempt counter, so an exception here would abort the pass, skip every
    # alert queued behind this one, and do it again on the next cycle, forever.
    # Quarantining is the failure mode the function already uses for an event it
    # cannot handle, and it is loud: the file leaves the queue for good and
    # quarantine_poison raises a meta-alert to the operator.
    #
    # Catching Exception rather than an enumerated tuple is deliberate. The
    # tuple form is a standing bet that no future edit to producer_claim can
    # raise anything else, and losing that bet costs the whole alerting
    # pipeline; over-catching costs one quarantined event and a meta-alert
    # naming it. Quarantine is the right shape for ANY snapshot failure.
    try:
        claimed_event = producer_claim(
            event,
            injected_dispatch_log=str(paths["logs"] / "dispatch.jsonl"),
        )
    except Exception:
        quarantine_poison(
            claimed,
            paths["quarantine"],
            "claimed event could not be snapshotted (nesting depth or non-serialisable member)",
        )
        return False, "poison"

    # --- Test-leak defense-in-depth (B2) ---
    # Drop test-fixture events BEFORE any delivery or incident-state load.
    # Reading the producer's claim keeps matchedPattern attribution honest -- it
    # reflects only the payload's own fields, never dispatcher bookkeeping --
    # and avoids a wasted load_incident_state read for events we are about to
    # discard.
    matched_pattern = matched_test_leak_pattern(claimed_event)
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
    attempt_target = _durable_target(claimed)
    attempt_observation = observe_json(attempt_target)
    attempt_generation = (attempt_observation.version.generation or 0) + 1
    attempt_operation = operation_id(
        attempt_target,
        event,
        component="dispatcher.process_attempt_state",
        predecessor=attempt_observation.version,
    )
    attempt_publication = publish_state_json(
        attempt_target,
        event,
        component="dispatcher.process_attempt_state",
        operation_id=attempt_operation,
        expected=attempt_observation.version,
        generation=attempt_generation,
    )
    require_all_advance([attempt_publication])
    incident_state = (incident.payload if incident else load_incident_state(paths))

    # Stamp daily-health liveness into the durable freshness ledger before any
    # suppress/send branch — all three downstream paths that persist incident_state
    # (suppress, send-success) then carry it, and the high-frequency info cadence is
    # always suppressed (and thus always saved). The watchdog reads this ledger
    # instead of the FIFO-pruned suppressed/ archive. Shared with the pre-loop
    # terminal paths (storm-collapse, recovery-dedup) via absorb_daily_health_signal
    # (TRUTH-01) so a member consumed before ever reaching process_one still stamps
    # freshness and closes any incident its evidence recovers. absorb also stamps
    # the sourceSpecificRecoveredIncidents diagnostic itself now.
    # --- Episode-state gate (#2281) ---
    # If the event belongs to a previous (superseded) episode, quarantine it
    # instead of delivering a stale alert for a condition that may no longer exist.
    delivery = event.get("delivery")
    if isinstance(delivery, dict) and delivery.get("episodeId") is not None:
        current_episode = incident_state.get("currentEpisodeId")
        if current_episode is not None and delivery["episodeId"] != current_episode:
            append_dispatch_log(paths, {
                "type": "stale_episode_quarantined",
                "eventId": event.get("id"),
                "oldEpisode": delivery["episodeId"],
                "currentEpisode": current_episode,
            })
            return True, "stale_episode_quarantined"

    absorb_daily_health_signal(event, incident_state)
    suppress_reason = should_suppress_send(event, incident_state)
    if suppress_reason:
        event = mark_suppressed(event, suppress_reason)
        suppressed_target = _durable_target(claimed)
        suppressed_observation = observe_json(suppressed_target)
        suppressed_generation = (
            suppressed_observation.version.generation or 0
        ) + 1
        suppressed_operation = operation_id(
            suppressed_target,
            event,
            component="dispatcher.process_suppressed_state",
            predecessor=suppressed_observation.version,
        )
        suppressed_publication = publish_state_json(
            suppressed_target,
            event,
            component="dispatcher.process_suppressed_state",
            operation_id=suppressed_operation,
            expected=suppressed_observation.version,
            generation=suppressed_generation,
        )
        require_advance(suppressed_publication)
        if incident:
            incident.commit()
        else:
            incident_publication = save_incident_state(paths, incident_state)
            require_all_advance(
                [suppressed_publication, incident_publication]
            )
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
    stamp_delivery_freshness(event, int(time.time()))
    text = format_event(event)
    try:
        send_whatsapp(text)
    except Exception as exc:
        event = mark_failure(event, str(exc))
        attempts = int(event.get("delivery", {}).get("attempts") or 0)
        delivery = event.get("delivery") if isinstance(event.get("delivery"), dict) else {}

        # --- BE-G5: transient-transport carve-out ---
        # A momentary WhatsApp disconnect ("temporarily disconnected") is not a
        # permanent delivery failure. Track it on its own counter, roll back the
        # permanent attempt this try would otherwise consume, and re-queue for
        # redelivery when transport recovers — so a transport blip never burns the
        # dead-letter cap on a deliverable alert. A genuinely stuck transport still
        # dead-letters once the (far larger) transient budget is exhausted, so a
        # real undeliverable alert still surfaces (fail-safe).
        if is_transient_transport_failure(str(exc)) and isinstance(delivery, dict):
            transient_attempts = int(delivery.get("transientAttempts") or 0) + 1
            delivery["transientAttempts"] = transient_attempts
            if transient_attempts < BOT_ERRORS_TRANSIENT_MAX_ATTEMPTS:
                # This try did not advance the permanent attempt budget.
                delivery["attempts"] = max(attempts - 1, 0)
                delivery["status"] = "queued"
                delivery["nextAttemptAtEpoch"] = int(time.time()) + BOT_ERRORS_TRANSIENT_BACKOFF_SECONDS
                transient_target = _durable_target(claimed)
                transient_observation = observe_json(transient_target)
                transient_generation = (
                    transient_observation.version.generation or 0
                ) + 1
                transient_operation = operation_id(
                    transient_target,
                    event,
                    component="dispatcher.process_transient_state",
                    predecessor=transient_observation.version,
                )
                transient_publication = publish_state_json(
                    transient_target,
                    event,
                    component="dispatcher.process_transient_state",
                    operation_id=transient_operation,
                    expected=transient_observation.version,
                    generation=transient_generation,
                )
                require_all_advance([transient_publication])
                retry_path = safe_child_path(paths["outbox"], path.name)
                os.replace(claimed, retry_path)
                fsync_parent(retry_path)
                append_dispatch_log(paths, {
                    "type": "send_deferred_transient",
                    "eventId": event.get("id"),
                    "path": str(retry_path),
                    "attempts": delivery["attempts"],
                    "transientAttempts": transient_attempts,
                    "error": str(exc),
                })
                return False, f"transient_transport_deferred; transientAttempts={transient_attempts}; {exc}"
            # Transient budget exhausted → fall through to the permanent path
            # (email fallback + dead-letter) as a fail-safe.

        # --- F5: email fallback (attempts >= 3) with unavailability tracking ---
        email_status = "not_attempted"
        email_blocked = (
            email_fallback_blocked_reason(claimed_event, state_dir=paths["root"])
            if attempts >= 3
            else None
        )
        if email_blocked is not None:
            # Synthetic / test-provenance events never escalate by email; they
            # keep the ordinary retry -> dead-letter lifecycle.
            append_dispatch_log(paths, {
                "type": "email_fallback_test_provenance_suppressed",
                "eventId": event.get("id"),
                "reason": email_blocked,
                "attempts": attempts,
            })
        elif attempts >= 3:
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
        if email_status == "accepted_unconfirmed":
            # Email fallback accepted — the event is delivered via email.
            # Terminal: persist incident state, publish the durable sent
            # record, and archive out of processing/ exactly like the
            # primary-channel sent path. Returning without the archive
            # move would leak the claimed file into processing/, where
            # reclaim_processing would resurrect and re-send it (#2435).
            if isinstance(delivery, dict):
                delivery["nextAttemptAtEpoch"] = 0
                delivery["status"] = "email_delivered"
                delivery["lastError"] = None
            if incident:
                incident.commit()
            else:
                incident_publication = save_incident_state(paths, incident_state)
            email_target = _durable_target(claimed)
            email_observation = observe_json(email_target)
            email_generation = (email_observation.version.generation or 0) + 1
            email_operation = operation_id(
                email_target,
                event,
                component="dispatcher.process_sent_state",
                predecessor=email_observation.version,
            )
            email_publication = publish_state_json(
                email_target,
                event,
                component="dispatcher.process_sent_state",
                operation_id=email_operation,
                expected=email_observation.version,
                generation=email_generation,
            )
            require_all_advance(
                [email_publication]
                if incident
                else [incident_publication, email_publication]
            )
            email_sent_path = archive_path(paths["sent"], path.name, "sent", event)
            os.replace(claimed, email_sent_path)
            append_dispatch_log(paths, {
                "type": "email_delivered",
                "eventId": event.get("id"),
                "path": str(email_sent_path),
                "attempts": delivery.get("attempts") if isinstance(delivery, dict) else None,
            })
            return True, "email_delivered"

        # --- F5: dead-letter if attempt cap exhausted ---
        if next_backoff(attempts) is None:
            # Dead-letter is the one genuinely terminal
            # stamp-loss path in this branch -- unlike the transient-transport
            # and generic-retry sub-paths above (which requeue to outbox/ and
            # self-heal by re-absorbing on the next cycle), a dead-lettered
            # event is never reprocessed. The freshness/closure absorbed into
            # incident_state at the top of process_one must be persisted
            # before this terminal move, or it is lost for good.
            if incident:
                incident.commit()
            else:
                save_incident_state(paths, incident_state)
            dead_path = move_to_dead_letter(claimed, paths, event, original_name_from_processing(claimed))
            append_dispatch_log(paths, {
                "type": "dead_lettered",
                "eventId": event.get("id"),
                "path": str(dead_path),
                "attempts": attempts,
                "error": str(exc),
            })
            return False, f"dead_letter; attempts={attempts}; {exc}"

        failure_target = _durable_target(claimed)
        failure_observation = observe_json(failure_target)
        failure_generation = (failure_observation.version.generation or 0) + 1
        failure_operation = operation_id(
            failure_target,
            event,
            component="dispatcher.process_failure_state",
            predecessor=failure_observation.version,
        )
        failure_publication = publish_state_json(
            failure_target,
            event,
            component="dispatcher.process_failure_state",
            operation_id=failure_operation,
            expected=failure_observation.version,
            generation=failure_generation,
        )
        require_all_advance([failure_publication])
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
    event = mark_sent(event)
    sent_target = _durable_target(claimed)
    sent_observation = observe_json(sent_target)
    sent_generation = (sent_observation.version.generation or 0) + 1
    sent_operation = operation_id(
        sent_target,
        event,
        component="dispatcher.process_sent_state",
        predecessor=sent_observation.version,
    )
    sent_publication = publish_state_json(
        sent_target,
        event,
        component="dispatcher.process_sent_state",
        operation_id=sent_operation,
        expected=sent_observation.version,
        generation=sent_generation,
    )
    if incident:
        incident.commit()
        require_all_advance([sent_publication])
    else:
        incident_publication = save_incident_state(paths, incident_state)
        require_all_advance([incident_publication, sent_publication])
    sent_path = archive_path(paths["sent"], path.name, "sent", event)
    os.replace(claimed, sent_path)
    append_dispatch_log(paths, {
        "type": "sent",
        "eventId": event.get("id"),
        "path": str(sent_path),
        "attempts": event.get("delivery", {}).get("attempts") if isinstance(event.get("delivery"), dict) else None,
    })
    return True, "sent"


@controller_cycle(
    CONTROLLER_LOG_CONTEXT,
    lambda kind, details, level, outcome: append_dispatch_log(
        state_paths(),
        {"type": kind, **details},
        level=level,
        outcome=outcome,
    ),
)
def run_once(max_events: int) -> dict[str, Any]:
    paths = setup_dirs()
    lock_path = paths["locks"] / "dispatcher.lock"
    with lock_path.open("w", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # #2723 R5.3: open controller state session BEFORE any domain effect
        # (recover_writefail_breadcrumbs, reclaim_processing, etc.).
        # ControllerStateRequired / recovery_required raises before ANY queue
        # effect — the caller (run_daemon / main) catches and exits 78.
        # The session stays open throughout the cycle so IncidentStateCycle
        # can commit state at each save barrier.
        with open_dispatcher_state_session() as session:
            _load_result = session.load()
            project_dispatcher_state_mode(_load_result.diagnostic)
            if _load_result.mode == "recovery_required":
                raise ControllerStateRequired(_load_result.diagnostic)
            if _load_result.mode == "recovered":
                _payload, _outcome = reconcile_recovered_dispatcher_state(_load_result.payload)
                _committed = session.complete_reconciliation(
                    _load_result.payload if _payload is None else _payload,
                    _load_result.capability,
                    outcome=_outcome,
                )
                project_dispatcher_state_mode(_committed.diagnostic)
                _load_result = session.reload()
                project_dispatcher_state_mode(_load_result.diagnostic)
            if _load_result.mode not in {"bootstrap", "valid", "reconciled"}:
                raise ControllerStateRequired(_load_result.diagnostic)
            _incident_cycle = IncidentStateCycle(
                session, _load_result.payload, _load_result.capability, paths=paths
            )

            writefail_recovered = recover_writefail_breadcrumbs(paths)
            reclaimed = reclaim_processing(paths)
            test_provenance_suppressed, test_provenance_meta_alerted = suppress_test_provenance_events(paths)
            recovery_deduped = suppress_ready_recovery_duplicates(paths, incident=_incident_cycle)
            # Pattern F (§10 C1): count flap trips on raw input BEFORE storm-collapse
            # consumes members. Emits consolidated flap_storm alerts; members are
            # suppressed downstream in should_suppress_send via persisted flapState.
            flap_storms = flap_scan_outbox(paths, incident=_incident_cycle)
            recovered_before_delivery = suppress_alerts_recovered_before_delivery(paths, incident=_incident_cycle)
            storm_collapsed = collapse_ready_storms(paths, incident=_incident_cycle)
            processed = 0
            sent = 0
            suppressed = test_provenance_suppressed + recovery_deduped + recovered_before_delivery
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
                    preview = safe_read_json(path)
                    if is_incident_alert(preview) or is_incident_clear(preview):
                        touched_incident_keys.add(incident_key(preview))
                except Exception:
                    pass
                processed += 1
                ok, detail = process_one(path, paths, incident=_incident_cycle)
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
            stale_renotified, stale_failed, stale_error = sweep_stale_incidents(paths, touched_incident_keys, incident=_incident_cycle)
            if stale_failed:
                failed += stale_failed
                last_error = stale_error
            # Pattern F: resolve flap storms quiet beyond the stable window (one
            # terminal "resolved after N flaps" summary each, then terminal removal).
            flap_resolved, flap_resolve_errors = sweep_flap_storms(paths, incident=_incident_cycle)

            # --- F5: dead-letter meta-alert (at most once per hour when dir non-empty) ---
            dead_letter_meta_alerted = queue_dead_letter_meta_alert(paths, int(time.time()))

            # Daily test-leak summary marker (at most once per UTC date per day).
            if test_leak_dropped > 0:
                incident_state = _incident_cycle.payload
                today = time.strftime("%Y-%m-%d", time.gmtime())
                emitted = record_test_leak_daily_marker(incident_state, today, test_leak_dropped)
                # Save only when a marker was actually emitted.
                if emitted:
                    _incident_cycle.commit()
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
                cycleCompletedAt=now_iso(),
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
                recoveredBeforeDelivery=recovered_before_delivery,
                stormCollapsed=storm_collapsed,
                flapStorms=flap_storms,
                flapResolved=flap_resolved,
                flapResolveErrors=flap_resolve_errors,
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
                "recoveredBeforeDelivery": recovered_before_delivery,
                "stormCollapsed": storm_collapsed,
                "flapStorms": flap_storms,
                "flapResolved": flap_resolved,
                "flapResolveErrors": flap_resolve_errors,
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
        except ControllerStateRequired as exc:
            project_dispatcher_state_mode(exc.diagnostic)
            emit_state_recovery_fallback(exc.diagnostic)
            print(json.dumps({
                "time": now_iso(),
                "error": f"incident state recovery required: {exc.diagnostic}",
                "exit": STATE_RECOVERY_REQUIRED_EXIT,
            }), flush=True)
            sys.exit(STATE_RECOVERY_REQUIRED_EXIT)
        except IncidentCycleRequiredError as exc:
            # A refused post-adoption bare write is a programming error, not a
            # transient fault. Swallowing it below kept the daemon alive with
            # every cycle failing while record_state dropped cycleCompletedAt,
            # which parks the deadman on the cycle_incomplete branch that a 30s
            # interval never trips. Exit instead: the state file keeps its last
            # cycleCompletedAt, the unit restarts, and the restart-bounded grace
            # reports cycle_stale once the staleness outgrows the restart.
            print(json.dumps({
                "time": now_iso(),
                "error": str(exc),
                "exit": INCIDENT_CYCLE_REQUIRED_EXIT,
            }), flush=True)
            sys.exit(INCIDENT_CYCLE_REQUIRED_EXIT)
        except IncidentCycleRequiredError as exc:
            # A refused post-adoption bare write is a programming error, not a
            # transient fault. Swallowing it below kept the daemon alive with
            # every cycle failing while record_state dropped cycleCompletedAt,
            # which parks the deadman on the cycle_incomplete branch that a 30s
            # interval never trips. Exit instead: the state file keeps its last
            # cycleCompletedAt, the unit restarts, and the restart-bounded grace
            # reports cycle_stale once the staleness outgrows the restart.
            print(json.dumps({
                "time": now_iso(),
                "error": str(exc),
                "exit": INCIDENT_CYCLE_REQUIRED_EXIT,
            }), flush=True)
            sys.exit(INCIDENT_CYCLE_REQUIRED_EXIT)
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

    try:
        result = run_once(args.max_events)
    except ControllerStateRequired as exc:
        import sys, traceback; traceback.print_exception(type(exc), exc, exc.__traceback__, file=sys.stderr)
        project_dispatcher_state_mode(exc.diagnostic)
        emit_state_recovery_fallback(exc.diagnostic)
        print(json.dumps({
            "time": now_iso(),
            "error": f"incident state recovery required: {exc.diagnostic}",
            "exit": STATE_RECOVERY_REQUIRED_EXIT,
        }))
        return STATE_RECOVERY_REQUIRED_EXIT
    print(json.dumps(result, sort_keys=True))
    return 1 if result.get("failed") else 0


if __name__ == "__main__":
    sys.exit(main())
