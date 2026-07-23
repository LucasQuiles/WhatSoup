"""Daily-health freshness ledger: dispatcher write side, watchdog read side, parity.

Root cause being fixed: the heartbeat-watchdog inferred per-host daily-health
liveness from files in the FIFO-pruned suppressed/ archive. High-churn suppressed
events evict same-day daily-health freshness files within hours, so the watchdog
saw "no recent file" and raised false ">25h cadence stale" alerts. The dispatcher
now records per-host freshness into the durable incident-state ledger and the
watchdog reads that ledger (freshest-wins) instead of trusting the archive.

These tests pin: (1) the single canonical host key both sides share — the
false-assumption guard that recording under the machine product name while the
watchdog looks up the relay remoteHost would silently never match; (2) the
dispatcher write; (3) the watchdog read; (4) the integration that a live host with
an evicted archive is NOT stale, while a genuinely dead host still is.

Hostnames here are neutral placeholders; the logic is host-name agnostic.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

_SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_DISPATCHER = _SCRIPTS_DIR / "bot-errors-dispatcher.py"
_WATCHDOG = _SCRIPTS_DIR / "bot-errors-heartbeat-watchdog.py"

# Neutral placeholder host identities (no real fleet labels in this public repo).
_HOST_A = "relay-alpha"
_HOST_B = "relay-bravo"
_MACHINE = "Example-Machine"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


# Loaded once; state_root() reads BOT_ERRORS_STATE_DIR live per call, so per-test
# env overrides take effect without reloading the modules.
_disp = _load("bot_errors_dispatcher_freshness", _DISPATCHER)
_wd = _load("bot_errors_watchdog_freshness", _WATCHDOG)

from lib.bot_errors_daily_health import (  # noqa: E402
    daily_health_host_from_payload,
    normalize_hub_host,
)


# Default observation time for the fixture's own createdAt. Requirement 2 (use
# the event's own trustworthy observation time, never dispatch wall-clock) and
# requirement 3 (fail closed on malformed/absent time) mean createdAt is now a
# load-bearing field for every freshness-recording test, not incidental data.
_DEFAULT_CREATED_AT = "2026-07-22T11:20:00Z"
_DEFAULT_CREATED_EPOCH = 1784719200


def _daily_health_event(**kwargs: Any) -> dict[str, Any]:
    base = {
        "id": "evt-dh-001",
        "source": "daily-health",
        "severity": "info",
        "eventType": "alert",
        "summary": "daily health",
        "machine": _MACHINE,
        "createdAt": _DEFAULT_CREATED_AT,
        "diagnostics": {"relay": {"remoteHost": _HOST_A}},
    }
    base.update(kwargs)
    return base


# ---------------------------------------------------------------------------
# 1. Canonical host key (the false-assumption guard)
# ---------------------------------------------------------------------------

def test_host_key_prefers_relay_remotehost_not_machine():
    # The watchdog keys on the relay remoteHost, not the machine product name.
    assert daily_health_host_from_payload(_daily_health_event()) == _HOST_A


def test_host_key_hub_machine_fallback():
    # Hub-local events have no relay; the machine prefix normalizes to the hub key.
    hub = "nuc" "les"
    assert daily_health_host_from_payload({"machine": hub + "-primary"}) == hub


def test_host_key_none_when_undeterminable():
    assert daily_health_host_from_payload({"machine": _MACHINE}) is None
    assert daily_health_host_from_payload(None) is None
    assert daily_health_host_from_payload({"diagnostics": {"relay": {}}}) is None


def test_dispatcher_and_watchdog_derive_same_key_from_payload():
    # Cross-module parity: dispatcher write key == watchdog lookup key (filename miss).
    event = _daily_health_event()
    write_host = daily_health_host_from_payload(event)
    read_host = _wd.daily_health_event_host(Path("no-relay-token.json"), event)
    assert write_host == read_host == _HOST_A


def test_watchdog_filename_first_still_wins():
    path = Path(f"20260623T112005Z.relay-{_HOST_A}.bot-errors-health.daily-health.x.json")
    assert _wd.daily_health_event_host(path, None) == _HOST_A


# ---------------------------------------------------------------------------
# 1b. Hub-normalization rule (single source of truth; no drift across callers)
# ---------------------------------------------------------------------------

def test_normalize_hub_host_collapses_suffixed_hub():
    hub = "nuc" "les"
    assert normalize_hub_host(hub) == hub
    assert normalize_hub_host(hub + "-32") == hub
    assert normalize_hub_host(hub.upper()) == hub


def test_normalize_hub_host_passes_through_non_hub():
    assert normalize_hub_host("Relay-Alpha") == "relay-alpha"
    assert normalize_hub_host("  spaced-host  ") == "spaced-host"


def test_normalize_hub_host_coerces_empty_and_none():
    assert normalize_hub_host(None) == ""
    assert normalize_hub_host("") == ""


def test_canonical_local_host_uses_shared_rule(monkeypatch):
    # The watchdog's local-host resolver routes through the shared hub rule, so a
    # suffixed/domain-qualified hub hostname collapses to the canonical key.
    hub = "nuc" "les"
    monkeypatch.setattr(_wd.socket, "gethostname", lambda: f"{hub}-32.local")
    assert _wd.canonical_local_host() == hub
    monkeypatch.setattr(_wd.socket, "gethostname", lambda: "Relay-Bravo.lan")
    assert _wd.canonical_local_host() == "relay-bravo"


# ---------------------------------------------------------------------------
# 2. Dispatcher write side
# ---------------------------------------------------------------------------

def test_record_freshness_records_under_remotehost():
    state: dict[str, Any] = {}
    host = _disp.record_daily_health_freshness(_daily_health_event(), state)
    assert host == _HOST_A
    record = state["dailyHealthFreshness"][_HOST_A]
    assert isinstance(record["lastSeenAt"], int)
    assert "lastSeenIso" in record


def test_record_freshness_covers_daily_health_fail():
    state: dict[str, Any] = {}
    event = _daily_health_event(source="daily-health-fail", severity="critical")
    assert _disp.record_daily_health_freshness(event, state) == _HOST_A
    assert _HOST_A in state["dailyHealthFreshness"]


def test_record_freshness_skips_non_daily_health():
    state: dict[str, Any] = {}
    event = _daily_health_event(source="whatsapp_auth_bond_local_failure")
    assert _disp.record_daily_health_freshness(event, state) is None
    assert "dailyHealthFreshness" not in state


def test_record_freshness_skips_when_no_host():
    state: dict[str, Any] = {}
    event = _daily_health_event(machine=_MACHINE, diagnostics={})
    assert _disp.record_daily_health_freshness(event, state) is None
    assert "dailyHealthFreshness" not in state


def test_ledger_survives_load_incident_state_roundtrip(tmp_path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    try:
        paths = _disp.state_paths()
        state = _disp.load_incident_state(paths)
        _disp.record_daily_health_freshness(_daily_health_event(), state)
        _disp.save_incident_state(paths, state)
        reloaded = _disp.load_incident_state(paths)
        assert reloaded["dailyHealthFreshness"][_HOST_A]["lastSeenAt"] > 0
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)


def test_record_freshness_covers_recovery_clear_event():
    # A daily-health clear (recovery) event is still a daily-health event for
    # liveness purposes; the ledger cares about "host is alive and reporting",
    # not the alert/clear distinction.
    state: dict[str, Any] = {}
    event = _daily_health_event(eventType="clear", severity="warning")
    assert _disp.record_daily_health_freshness(event, state) == _HOST_A
    assert _HOST_A in state["dailyHealthFreshness"]


# ---------------------------------------------------------------------------
# 2b. Observation time — requirement 2 (event's own time, never dispatch
# wall-clock) and requirement 3 (fail closed on malformed/absent time, never
# manufacture freshness)
# ---------------------------------------------------------------------------

def test_record_freshness_uses_event_created_at_not_dispatch_clock(monkeypatch):
    # The dispatcher may process a backlogged event long after it was
    # produced. Freshness must reflect when the host actually reported
    # (createdAt), never the moment the dispatcher happened to get to it.
    monkeypatch.setattr(_disp.time, "time", lambda: _DEFAULT_CREATED_EPOCH + 999_999)
    state: dict[str, Any] = {}
    _disp.record_daily_health_freshness(_daily_health_event(), state)
    record = state["dailyHealthFreshness"][_HOST_A]
    assert record["lastSeenAt"] == _DEFAULT_CREATED_EPOCH, (
        f"expected event's own createdAt epoch, got a dispatch-wall-clock value: {record}"
    )
    assert record["lastSeenIso"] == _DEFAULT_CREATED_AT


def test_record_freshness_fails_closed_on_missing_created_at():
    state: dict[str, Any] = {}
    event = _daily_health_event()
    del event["createdAt"]
    assert _disp.record_daily_health_freshness(event, state) is None
    assert "dailyHealthFreshness" not in state


def test_record_freshness_fails_closed_on_malformed_created_at():
    state: dict[str, Any] = {}
    event = _daily_health_event(createdAt="not-a-timestamp")
    assert _disp.record_daily_health_freshness(event, state) is None
    assert "dailyHealthFreshness" not in state


def test_record_freshness_fails_closed_does_not_clobber_existing_entry():
    # A malformed later event must not overwrite a previously-good stamp with
    # nothing, and must not silently fall back to "now".
    state: dict[str, Any] = {"dailyHealthFreshness": {_HOST_A: {"lastSeenAt": 111, "lastSeenIso": "prior"}}}
    event = _daily_health_event(createdAt="")
    assert _disp.record_daily_health_freshness(event, state) is None
    assert state["dailyHealthFreshness"][_HOST_A] == {"lastSeenAt": 111, "lastSeenIso": "prior"}


# ---------------------------------------------------------------------------
# 2c. Monotonicity — a genuinely OLDER event absorbed after a fresher one
# already stamped the ledger must never regress it. This is a NEW edge
# introduced by requirement 2 (event's-own-time semantics): pre-fix
# dispatch-wall-clock stamps were monotonic by construction (real time only
# moves forward), so out-of-order absorption could not regress anything.
# Once the stamp is the event's own createdAt, a backlogged file surfacing
# out of order, a delayed replay, or storm-collapse/dedupe processing members
# out of creation order can absorb an old event AFTER a fresh one -- without
# a guard that would rewind the ledger and manufacture a false "cadence
# stale" alert for a host that is actually live.
# ---------------------------------------------------------------------------

def test_record_freshness_is_monotonic_rejects_older_event_after_fresher_stamp():
    state: dict[str, Any] = {}
    fresh_event = _daily_health_event(createdAt=_DEFAULT_CREATED_AT)
    assert _disp.record_daily_health_freshness(fresh_event, state) == _HOST_A
    fresh_record = dict(state["dailyHealthFreshness"][_HOST_A])

    older_event = _daily_health_event(
        id="evt-dh-002", createdAt=_disp.iso_from_epoch(_DEFAULT_CREATED_EPOCH - 3600)
    )
    result = _disp.record_daily_health_freshness(older_event, state)

    assert result is None, "an older event must not report itself as recorded"
    assert state["dailyHealthFreshness"][_HOST_A] == fresh_record, (
        "a genuinely older event must never regress an already-fresher stamp"
    )


def test_record_freshness_monotonic_guard_allows_equal_or_newer():
    # Not over-strict: a newer event still advances the stamp, and the very
    # first write for a host (no existing entry) always succeeds -- the
    # guard treats an absent entry as -infinity, not as a floor of "now".
    state: dict[str, Any] = {}
    older_event = _daily_health_event(
        id="evt-dh-002", createdAt=_disp.iso_from_epoch(_DEFAULT_CREATED_EPOCH - 3600)
    )
    assert _disp.record_daily_health_freshness(older_event, state) == _HOST_A

    newer_event = _daily_health_event(createdAt=_DEFAULT_CREATED_AT)
    assert _disp.record_daily_health_freshness(newer_event, state) == _HOST_A
    assert state["dailyHealthFreshness"][_HOST_A]["lastSeenAt"] == _DEFAULT_CREATED_EPOCH


# ---------------------------------------------------------------------------
# 3. Watchdog read side
# ---------------------------------------------------------------------------

def _write_ledger(tmp_path: Path, freshness: dict[str, Any]) -> None:
    payload = {"version": 1, "openIncidents": {}, "lastSentAt": {}, "dailyHealthFreshness": freshness}
    (tmp_path / "incident-state.json").write_text(json.dumps(payload), encoding="utf-8")


def test_ledger_age_reads_recent_entry(tmp_path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    try:
        _write_ledger(tmp_path, {_HOST_A: {"lastSeenAt": int(time.time()) - 100}})
        age, detail = _wd.daily_health_freshness_ledger_age(_HOST_A)
        assert age is not None and 80 <= age <= 300
        assert f"dailyHealthFreshness[{_HOST_A}]" in detail
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)


def test_ledger_age_absent_host_returns_none(tmp_path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    try:
        _write_ledger(tmp_path, {_HOST_A: {"lastSeenAt": int(time.time())}})
        age, detail = _wd.daily_health_freshness_ledger_age(_HOST_B)
        assert age is None
        assert f"no dailyHealthFreshness entry for {_HOST_B}" in detail
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)


def test_ledger_age_rejects_future_timestamp(tmp_path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    try:
        _write_ledger(tmp_path, {_HOST_A: {"lastSeenAt": int(time.time()) + 9999}})
        age, detail = _wd.daily_health_freshness_ledger_age(_HOST_A)
        assert age is None
        assert "future" in detail
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)


def test_ledger_age_no_ledger_file(tmp_path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    try:
        age, detail = _wd.daily_health_freshness_ledger_age(_HOST_A)
        assert age is None
        assert "no incident-state ledger" in detail
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)


# ---------------------------------------------------------------------------
# 4. Integration — the actual false-positive fix
# ---------------------------------------------------------------------------

def test_live_host_with_evicted_archive_is_not_stale(tmp_path):
    # The false-positive scenario: suppressed/ archive empty (FIFO-evicted), so a
    # file scan finds nothing, but the durable ledger has a fresh entry. Pre-fix
    # this returned None ("stale"); post-fix the ledger keeps the host live.
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    try:
        _write_ledger(tmp_path, {_HOST_A: {"lastSeenAt": int(time.time()) - 120}})
        age, detail = _wd.daily_health_age(_HOST_A)
        assert age is not None and age < 600, f"live host flagged stale: detail={detail}"
        assert f"dailyHealthFreshness[{_HOST_A}]" in detail
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)


def test_genuinely_dead_host_still_reads_stale(tmp_path):
    # No archive files AND no ledger entry — a host that truly stopped reporting
    # must still age out. The fix must not mask real staleness.
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    try:
        _write_ledger(tmp_path, {_HOST_A: {"lastSeenAt": int(time.time())}})
        age, detail = _wd.daily_health_age(_HOST_B)
        assert age is None, f"dead host not flagged: age={age} detail={detail}"
        assert f"no dailyHealthFreshness entry for {_HOST_B}" in detail
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)


def test_freshest_source_wins_when_both_present(tmp_path):
    # Stale archive file + fresh ledger entry → ledger (freshest) wins.
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    try:
        suppressed = tmp_path / "suppressed"
        suppressed.mkdir(parents=True, exist_ok=True)
        stale_file = suppressed / f"20260101T000000Z.relay-{_HOST_A}.bot-errors-health.daily-health.x.json"
        stale_file.write_text(
            json.dumps({"source": "daily-health", "createdAt": "2026-01-01T00:00:00Z"}),
            encoding="utf-8",
        )
        _write_ledger(tmp_path, {_HOST_A: {"lastSeenAt": int(time.time()) - 60}})
        age, detail = _wd.daily_health_age(_HOST_A)
        assert age is not None and age < 600
        assert f"dailyHealthFreshness[{_HOST_A}]" in detail
    finally:
        os.environ.pop("BOT_ERRORS_STATE_DIR", None)
