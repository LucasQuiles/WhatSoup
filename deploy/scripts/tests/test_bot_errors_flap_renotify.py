"""Flap detection must count OCCURRENCES, not re-notifications (reliability
program 4.3, the ml-bot 731-'trip' immortal storm).

The health poller re-emits an UNCHANGED open condition (health_body_degraded)
through its 15-minute alert throttle. Each re-emit carries a fresh event id, so
occurrence-dedup (#2428) cannot catch it, and every re-emit recorded a flap
trip: a permanently-degraded instance read as an ever-climbing "flap storm"
(cumulative 731, 1-in-window) that could never resolve — the re-emit period
(15m) is shorter than the stable window (60m), so lastTripAt refreshed forever.

The emitter is the only party that KNOWS a re-emit is a re-notification rather
than a fresh occurrence, so the poller now stamps ``renotify: true`` on
non-transition re-emits and the flap scan skips them for trip counting.
Genuine per-occurrence alerts (e.g. outbound_delivery_ambiguous quarantines —
yl-bot's real 5-trips-in-600s burst) carry no flag and keep tripping.

Resolution honesty: when a storm drains only because re-emit churn stopped
counting while the underlying incident is STILL OPEN, the resolve summary must
say so (persistent-condition handoff to the still-open digests) — fixing the
emit inflation must not let steady degradation read as "resolved".
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path


_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

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

_TEST_ENV = {
    "BOT_ERRORS_FLAP_TRIP_THRESHOLD": "3",
    "BOT_ERRORS_FLAP_WINDOW_SECONDS": "60",
    "BOT_ERRORS_FLAP_PROMOTE_SECONDS": "100",
    "BOT_ERRORS_FLAP_CRITICAL_COUNT": "10",
    "BOT_ERRORS_FLAP_STABLE_SECONDS": "200",
}


_clean_env = dispatcher_fixtures.make_env_scrub_fixture(_ENV_KEYS)


def _load(state_dir: Path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    for k, v in _TEST_ENV.items():
        os.environ[k] = v
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_renotify", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


KEY = "mini8|ml-bot|health_body_degraded"


def _outbox_event(event_id: str, *, renotify: bool = False, evidence: str = "degraded"):
    event = {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "critical",
        "machine": "mini8",
        "instance": "ml-bot",
        "source": "health_body_degraded",
        "summary": "whatsoup at ml-bot health is degraded",
        "evidence": evidence,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "id": event_id,
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
    }
    if renotify:
        event["renotify"] = True
    return event


def _write_outbox(paths, name: str, event) -> Path:
    path = paths["outbox"] / name
    path.write_text(json.dumps(event), encoding="utf-8")
    return path


def test_renotify_alerts_never_trip_the_flap_detector(tmp_path, monkeypatch):
    """Three distinct-id renotify re-emits (the poller's throttled re-emit
    shape) must record ZERO trips and never open a storm."""
    mod = _load(tmp_path)
    paths = mod.setup_dirs()
    sent = []
    monkeypatch.setattr(mod, "send_whatsapp", lambda *a, **k: sent.append(a))
    for i in range(3):
        _write_outbox(paths, f"20260816T00000{i}Z.renotify.json",
                      _outbox_event(f"evt-renotify-{i}", renotify=True))

    mod.flap_scan_outbox(paths)

    state = mod.load_incident_state(paths)
    entry = state.get("flapState", {}).get(KEY)
    if entry is not None:
        assert int(entry.get("cumulativeCount") or 0) == 0
        assert not entry.get("stormAt")
    assert sent == []


def test_occurrence_alerts_still_trip_among_renotify_traffic(tmp_path, monkeypatch):
    """Genuine occurrences (no flag) keep counting even when interleaved with
    renotify re-emits — the yl-bot burst class must survive this fix."""
    mod = _load(tmp_path)
    paths = mod.setup_dirs()
    monkeypatch.setattr(mod, "send_whatsapp", lambda *a, **k: None)
    _write_outbox(paths, "20260816T000000Z.occ0.json", _outbox_event("evt-occ-0"))
    _write_outbox(paths, "20260816T000001Z.re1.json", _outbox_event("evt-re-1", renotify=True))
    _write_outbox(paths, "20260816T000002Z.occ1.json", _outbox_event("evt-occ-1"))

    mod.flap_scan_outbox(paths)

    state = mod.load_incident_state(paths)
    entry = state["flapState"][KEY]
    assert int(entry["cumulativeCount"]) == 2  # the two occurrences, not the re-emit


def test_renotify_does_not_refresh_last_trip_so_storm_can_resolve(tmp_path, monkeypatch):
    """The immortal-storm defect: re-emits refreshed lastTripAt forever, so
    now-lastTripAt never reached the stable window. Renotify traffic must not
    refresh lastTripAt — a storm over a steady condition drains and resolves."""
    mod = _load(tmp_path)
    paths = mod.setup_dirs()
    monkeypatch.setattr(mod, "send_whatsapp", lambda *a, **k: None)
    state = mod.load_incident_state(paths)
    fs = state.setdefault("flapState", {})
    base = int(time.time()) - 10_000  # storm opened in the distant past
    for i in range(3):
        mod.record_flap_trip(fs, KEY, base + i)
    mod.flap_evaluate(fs[KEY], base + 2)
    mod.save_incident_state(paths, state)

    _write_outbox(paths, "20260816T000003Z.re.json", _outbox_event("evt-re-late", renotify=True))
    mod.flap_scan_outbox(paths)

    reloaded = mod.load_incident_state(paths)
    entry = reloaded["flapState"][KEY]
    assert int(entry["lastTripAt"]) == base + 2, "a renotify must not refresh lastTripAt"
    assert mod.flap_should_resolve(entry, int(time.time())) is True


def test_resolve_states_persistent_handoff_when_underlying_still_open(tmp_path, monkeypatch):
    """A storm draining while its underlying incident is STILL OPEN must not
    read as recovery: the resolve event states the persistent-condition
    handoff, and the wording differs from the genuine stable-resolve."""
    mod = _load(tmp_path)
    paths = mod.setup_dirs()
    state = mod.load_incident_state(paths)
    fs = state.setdefault("flapState", {})
    base = int(time.time()) - 10_000
    for i in range(3):
        mod.record_flap_trip(fs, KEY, base + i)
    mod.flap_evaluate(fs[KEY], base + 2)
    # the underlying incident is still open in openIncidents
    state.setdefault("openIncidents", {})[KEY] = {"status": "open", "openedAt": base}
    mod.save_incident_state(paths, state)

    sends: list[str] = []
    monkeypatch.setattr(mod, "send_whatsapp", lambda text, *a, **k: sends.append(text))
    resolved, errors = mod.sweep_flap_storms(paths)

    assert resolved == 1 and errors == 0
    assert len(sends) == 1
    text = sends[0].lower()
    assert "still open" in text
    assert "persistent" in text
    # and the entry is gone either way (the storm bookkeeping ends)
    reloaded = mod.load_incident_state(paths)
    assert KEY not in reloaded.get("flapState", {})


def test_resolve_keeps_stable_wording_when_underlying_cleared(tmp_path, monkeypatch):
    """Control: with no open incident the classic 'stable after N flaps'
    resolve wording is preserved."""
    mod = _load(tmp_path)
    paths = mod.setup_dirs()
    state = mod.load_incident_state(paths)
    fs = state.setdefault("flapState", {})
    base = int(time.time()) - 10_000
    for i in range(3):
        mod.record_flap_trip(fs, KEY, base + i)
    mod.flap_evaluate(fs[KEY], base + 2)
    mod.save_incident_state(paths, state)

    sends: list[str] = []
    monkeypatch.setattr(mod, "send_whatsapp", lambda text, *a, **k: sends.append(text))
    resolved, _ = mod.sweep_flap_storms(paths)

    assert resolved == 1
    assert "stable after" in sends[0].lower()
    assert "still open" not in sends[0].lower()
