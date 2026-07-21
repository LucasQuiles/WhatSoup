"""Tests for F12 (Pattern F — flap-storm detection, consolidate AND escalate).

Design: docs/superpowers/specs/2026-06-16-bot-errors-noise-reduction-design.md
§9 Pattern F + §10 C0/C1/C4.

Covered:
- record_verified_reopen accumulates accepted transitions and prunes the window.
- flap_evaluate opens a storm at threshold (warning), suppresses members, and
  promotes to critical on cumulative count or sustained persistence.
- flap_should_resolve requires accepted close proof and a stable interval.
- flap_storm_event carries a REAL requested_action (never 'none') and is EXEMPT
  from Pattern A suppression (§10 C4).
- flapState survives a load/save round-trip (§10 C0 disk persistence).
- sweep_flap_storms emits one terminal resolve summary and removes the entry.
"""
from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_FLAP_DETECTION",
    "BOT_ERRORS_FLAP_TRIP_THRESHOLD",
    "BOT_ERRORS_FLAP_WINDOW_SECONDS",
    "BOT_ERRORS_FLAP_PROMOTE_SECONDS",
    "BOT_ERRORS_FLAP_CRITICAL_COUNT",
    "BOT_ERRORS_FLAP_STABLE_SECONDS",
]

# Small, testable thresholds.
_TEST_ENV = {
    "BOT_ERRORS_FLAP_TRIP_THRESHOLD": "3",
    "BOT_ERRORS_FLAP_WINDOW_SECONDS": "60",
    "BOT_ERRORS_FLAP_PROMOTE_SECONDS": "100",
    "BOT_ERRORS_FLAP_CRITICAL_COUNT": "10",
    "BOT_ERRORS_FLAP_STABLE_SECONDS": "200",
}


@pytest.fixture(autouse=True)
def _clean_env():
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    for k in _ENV_KEYS:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _load(state_dir: Path, extra_env: dict[str, str] | None = None):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    for k, v in {**_TEST_ENV, **(extra_env or {})}.items():
        os.environ[k] = v
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_f12", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


KEY = "host-a|instance-x|whatsapp_auth_bond_local_failure"


def test_record_verified_reopen_accumulates_and_prunes(tmp_path):
    mod = _load(tmp_path)
    fs: dict = {}
    t0 = 1_000_000
    for i in range(3):
        mod.record_verified_reopen(fs, KEY, t0 + i)
    entry = fs[KEY]
    assert mod.verified_reopens_in_window(entry, t0 + 2) == 3
    assert entry["verifiedReopenCount"] == 3
    # a reopen far outside the 60s window prunes old window entries
    mod.record_verified_reopen(fs, KEY, t0 + 500)
    assert mod.verified_reopens_in_window(fs[KEY], t0 + 500) == 1
    assert fs[KEY]["verifiedReopenCount"] == 4  # cumulative never prunes


def test_storm_opens_at_threshold_warning(tmp_path):
    mod = _load(tmp_path)
    fs: dict = {}
    t0 = 1_000_000
    mod.record_verified_reopen(fs, KEY, t0)
    mod.record_verified_reopen(fs, KEY, t0 + 1)
    entry = mod.record_verified_reopen(fs, KEY, t0 + 2)
    decision = mod.flap_evaluate(entry, t0 + 2)
    assert decision["emit"] is True
    assert decision["severity"] == "warning"
    assert entry.get("stormAt") == t0 + 2


def test_members_suppressed_after_open(tmp_path):
    mod = _load(tmp_path)
    fs: dict = {}
    t0 = 1_000_000
    for i in range(3):
        mod.record_verified_reopen(fs, KEY, t0 + i)
    mod.flap_evaluate(fs[KEY], t0 + 2)  # opens
    entry = mod.record_verified_reopen(fs, KEY, t0 + 3)
    decision = mod.flap_evaluate(entry, t0 + 3)
    assert decision["emit"] is False
    assert decision["reason"] == "flap_storm_member_suppressed"


def test_promote_to_critical_on_count(tmp_path):
    mod = _load(tmp_path)
    fs: dict = {}
    t0 = 1_000_000
    decision = {"severity": None}
    # 10 verified reopens within window reach the critical threshold.
    for i in range(10):
        entry = mod.record_verified_reopen(fs, KEY, t0 + i)
        decision = mod.flap_evaluate(entry, t0 + i)
    assert entry["verifiedReopenCount"] >= 10
    assert decision["emit"] is True
    assert decision["severity"] == "critical"


def test_promote_to_critical_on_persistence(tmp_path):
    mod = _load(tmp_path)
    fs: dict = {}
    t0 = 1_000_000
    for i in range(3):
        mod.record_verified_reopen(fs, KEY, t0 + i)
    mod.flap_evaluate(fs[KEY], t0 + 2)  # open warning at t0+2
    # a later trip after FLAP_PROMOTE_SECONDS (100s) -> critical via persistence
    later = t0 + 2 + 100
    entry = mod.record_verified_reopen(fs, KEY, later)
    decision = mod.flap_evaluate(entry, later)
    assert decision["emit"] is True
    assert decision["severity"] == "critical"


def test_scan_promotes_persistent_verified_storm_without_raw_arrival(tmp_path):
    mod = _load(tmp_path)
    paths = mod.state_paths()
    now = int(time.time())
    state = mod.load_incident_state(paths)
    state["flapState"] = {
        KEY: {
            "stormAt": now - mod.FLAP_PROMOTE_SECONDS,
            "stormSeverity": "warning",
            "lastStormEmitAt": now - mod.FLAP_PROMOTE_SECONDS,
            "verifiedReopenTimestamps": [],
            "verifiedReopenCount": 3,
            "firstVerifiedReopenAt": now - mod.FLAP_PROMOTE_SECONDS,
            "lastVerifiedReopenAt": now - mod.FLAP_PROMOTE_SECONDS,
        }
    }
    mod.save_incident_state(paths, state)

    assert mod.flap_scan_outbox(paths) == 1
    queued = [json.loads(path.read_text()) for path in paths["outbox"].glob("*.json")]
    storms = [event for event in queued if event.get("source") == "flap_storm"]
    assert len(storms) == 1
    assert storms[0]["severity"] == "critical"
    assert "verified reopens" in storms[0]["summary"]


def test_resolve_only_after_stable_window(tmp_path):
    mod = _load(tmp_path)
    fs: dict = {}
    t0 = 1_000_000
    for i in range(3):
        mod.record_verified_reopen(fs, KEY, t0 + i)
    mod.flap_evaluate(fs[KEY], t0 + 2)
    entry = fs[KEY]
    assert mod.flap_should_resolve(entry, t0 + 100, underlying_open=False) is False
    entry["lastAcceptedCloseAt"] = t0 + 2
    entry["livenessVerifiedAt"] = t0 + 2
    assert mod.flap_should_resolve(entry, t0 + 100, underlying_open=True) is False
    assert mod.flap_should_resolve(entry, t0 + 2 + 200, underlying_open=False) is True


def test_storm_event_has_real_action_and_exempt_from_pattern_a(tmp_path):
    mod = _load(tmp_path)
    fs: dict = {}
    t0 = 1_000_000
    for i in range(3):
        entry = mod.record_verified_reopen(fs, KEY, t0 + i)
    event = mod.flap_storm_event(KEY, entry, "warning", t0 + 2)
    assert mod.requested_action_text(event) == mod.FLAP_STORM_ACTION
    assert mod.requested_action_text(event) != mod.NONACTIONABLE_ACTION
    text = mod.format_event(event)
    assert "flap_storm=true" in text
    assert "none — informational" not in text
    # exempt from Pattern A suppression
    assert mod.stale_renotify_is_nonactionable(event, KEY) is False


def test_flapstate_survives_load_save_roundtrip(tmp_path):
    mod = _load(tmp_path)
    paths = mod.state_paths()
    state = mod.load_incident_state(paths)
    fs = state.setdefault("flapState", {})
    mod.record_verified_reopen(fs, KEY, 1_000_000)
    mod.save_incident_state(paths, state)
    reloaded = mod.load_incident_state(paths)
    assert KEY in reloaded.get("flapState", {})
    assert reloaded["flapState"][KEY]["verifiedReopenCount"] == 1


def test_load_retires_legacy_raw_storm_without_promoting_counts(tmp_path):
    mod = _load(tmp_path)
    paths = mod.state_paths()
    mod.save_incident_state(paths, {
        "version": 1,
        "openIncidents": {KEY: {"status": "open"}},
        "lastSentAt": {},
        "flapState": {
            KEY: {
                "stormAt": 100,
                "stormSeverity": "critical",
                "lastStormEmitAt": 200,
                "tripTimestamps": [98, 99, 100],
                "cumulativeCount": 1315,
            }
        },
    })

    reloaded = mod.load_incident_state(paths)
    entry = reloaded["flapState"][KEY]
    assert entry["legacyRawTripCount"] == 1315
    assert entry["verifiedReopenCount"] == 0
    assert entry["verifiedReopenTimestamps"] == []
    assert entry["legacyStormRetiredAt"] > 0
    assert "stormAt" not in entry
    assert "stormSeverity" not in entry


def test_sweep_resolves_and_removes_stable_entry(tmp_path):
    mod = _load(tmp_path)
    paths = mod.state_paths()
    state = mod.load_incident_state(paths)
    fs = state.setdefault("flapState", {})
    # open a storm in the distant past so it's stable now
    base = int(time.time()) - 10_000
    for i in range(3):
        mod.record_verified_reopen(fs, KEY, base + i)
    mod.flap_evaluate(fs[KEY], base + 2)
    fs[KEY]["lastAcceptedCloseAt"] = base + 3
    fs[KEY]["livenessVerifiedAt"] = base + 3
    mod.save_incident_state(paths, state)

    sends: list[str] = []
    mod.send_whatsapp = lambda text, *a, **k: sends.append(text)  # type: ignore[assignment]
    resolved, errors = mod.sweep_flap_storms(paths)

    assert resolved == 1 and errors == 0
    assert len(sends) == 1
    assert "resolved" in sends[0].lower()
    reloaded = mod.load_incident_state(paths)
    assert KEY not in reloaded.get("flapState", {})


def test_should_suppress_send_suppresses_open_storm_member(tmp_path):
    mod = _load(tmp_path)
    incident_state = {
        "version": 1,
        "lastSentAt": {},
        "flapState": {KEY: {"stormAt": 1, "verifiedReopenTimestamps": [], "verifiedReopenCount": 5}},
        "openIncidents": {KEY: {"status": "open"}},
    }
    member = {
        "eventType": "alert",
        "severity": "warning",
        "machine": "host-a",
        "instance": "instance-x",
        "source": "whatsapp_auth_bond_local_failure",
        "evidence": "auth bond failed again",
    }
    assert mod.incident_key(member) == KEY
    reason = mod.should_suppress_send(member, incident_state)
    assert reason is not None and "flap_storm_member" in reason


def test_should_not_suppress_when_no_open_storm(tmp_path):
    mod = _load(tmp_path)
    incident_state = {"version": 1, "openIncidents": {}, "lastSentAt": {}, "flapState": {}}
    member = {
        "eventType": "alert",
        "severity": "warning",
        "machine": "host-a",
        "instance": "instance-x",
        "source": "whatsapp_auth_bond_local_failure",
        "evidence": "auth bond failed",
    }
    assert mod.should_suppress_send(member, incident_state) is None
