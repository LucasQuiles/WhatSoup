"""Verified transition accounting for BOT ERRORS flap detection."""
from __future__ import annotations

import importlib.util
import json
import os
import random
import time
from pathlib import Path

import pytest


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load(state_dir: Path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    os.environ["BOT_ERRORS_FLAP_DETECTION"] = "1"
    os.environ["BOT_ERRORS_FLAP_TRIP_THRESHOLD"] = "3"
    os.environ["BOT_ERRORS_FLAP_WINDOW_SECONDS"] = "600"
    os.environ["BOT_ERRORS_FLAP_STABLE_SECONDS"] = "900"
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location(
        f"bot_errors_transition_model_{time.time_ns()}", _SCRIPT
    )
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def _iso(epoch: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _fault(epoch: int, event_id: str) -> dict:
    return {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": "alert",
        "severity": "critical",
        "createdAt": _iso(epoch),
        "machine": "host-a",
        "instance": "agent-a",
        "source": "release-drift",
        "summary": "release drift remains present",
        "evidence": "expected=release-a actual=release-b",
        "diagnostics": {"omitDispatchLogInMessage": True},
    }


def _clear(epoch: int, event_id: str) -> dict:
    event = _fault(epoch, event_id)
    event.update({
        "eventType": "clear",
        "severity": "info",
        "summary": "release drift cleared",
        "evidence": "expected=release-a actual=release-a",
    })
    return event


@pytest.fixture(autouse=True)
def _restore_env():
    keys = [
        "BOT_ERRORS_STATE_DIR",
        "BOT_ERRORS_FLAP_DETECTION",
        "BOT_ERRORS_FLAP_TRIP_THRESHOLD",
        "BOT_ERRORS_FLAP_WINDOW_SECONDS",
        "BOT_ERRORS_FLAP_STABLE_SECONDS",
    ]
    saved = {key: os.environ.get(key) for key in keys}
    yield
    for key, value in saved.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def test_repeated_open_fault_observations_create_zero_verified_reopens(tmp_path):
    mod = _load(tmp_path)
    paths = mod.setup_dirs()
    now = int(time.time())
    first = _fault(now, "release-drift-0000")
    key = mod.incident_key(first)
    state = mod.load_incident_state(paths)
    normalized = mod.normalize_dispatch_observation(first)
    mod.mark_incident_sent(first, state, normalized)
    mod.save_incident_state(paths, state)

    for index in range(1, 1501):
        event = _fault(now + index, f"release-drift-{index:04d}")
        (paths["outbox"] / f"{index:04d}.json").write_text(
            json.dumps(event), encoding="utf-8"
        )

    assert mod.flap_scan_outbox(paths) == 0
    reloaded = mod.load_incident_state(paths)
    entry = reloaded.get("flapState", {}).get(key, {})
    assert entry.get("verifiedReopenCount", 0) == 0
    assert entry.get("verifiedReopenTimestamps", []) == []


def test_only_fresh_fault_after_accepted_close_records_verified_reopen(tmp_path):
    mod = _load(tmp_path)
    now = int(time.time())
    key = mod.incident_key(_fault(now, "opening"))
    state = {
        "version": 1,
        "openIncidents": {},
        "lastSentAt": {},
        "closedHistory": [{
            "incidentKey": key,
            "closedAt": now - 10,
            "closingObservationTime": now - 10,
            "closingEventIdentityDigest": "c" * 64,
        }],
    }
    stale = _fault(now - 11, "stale-replay")
    fresh = _fault(now, "fresh-reopen")

    assert mod.record_verified_reopen_if_applicable(stale, state, now) is False
    assert mod.record_verified_reopen_if_applicable(fresh, state, now) is True
    assert mod.record_verified_reopen_if_applicable(fresh, state, now) is False
    entry = state["flapState"][key]
    assert entry["verifiedReopenCount"] == 1
    assert entry["verifiedReopenTimestamps"] == [now]


def test_storm_resolution_requires_accepted_close_liveness_receipt(tmp_path):
    mod = _load(tmp_path)
    now = int(time.time())
    entry = {
        "stormAt": now - 10_000,
        "verifiedReopenTimestamps": [now - 2_000],
        "verifiedReopenCount": 3,
        "lastVerifiedReopenAt": now - 2_000,
    }

    assert mod.flap_should_resolve(entry, now, underlying_open=False) is False
    entry["lastAcceptedCloseAt"] = now - 1_000
    entry["livenessVerifiedAt"] = now - 1_000
    assert mod.flap_should_resolve(entry, now, underlying_open=True) is False
    assert mod.flap_should_resolve(entry, now, underlying_open=False) is True


def test_process_lifecycle_counts_one_close_to_reopen_and_no_repeats(tmp_path, monkeypatch):
    mod = _load(tmp_path)
    paths = mod.setup_dirs()
    now = int(time.time())
    sent: list[str] = []
    monkeypatch.setattr(mod, "send_whatsapp", lambda text: sent.append(text))

    events = [
        ("open.json", _fault(now - 20, "opening-fault")),
        ("close.json", _clear(now - 10, "accepted-clear")),
        ("reopen.json", _fault(now, "verified-reopen")),
        ("repeat.json", _fault(now + 1, "open-repeat")),
    ]
    results = []
    for name, event in events:
        path = paths["outbox"] / name
        path.write_text(json.dumps(event), encoding="utf-8")
        results.append(mod.process_one(path, paths))

    assert results[:3] == [(True, "sent"), (True, "sent"), (True, "sent")]
    assert results[3] == (True, "suppressed")
    state = mod.load_incident_state(paths)
    key = mod.incident_key(events[0][1])
    assert state["flapState"][key]["verifiedReopenCount"] == 1
    assert len(state["flapState"][key]["verifiedReopenTimestamps"]) == 1
    assert key in state["openIncidents"]
    assert len(sent) == 3


def test_seeded_transition_model_matches_reference_count(tmp_path):
    mod = _load(tmp_path)
    seed = 20260721
    rng = random.Random(seed)
    now = int(time.time())
    key = mod.incident_key(_fault(now, "seed-opening"))
    state: dict = {
        "version": 1,
        "openIncidents": {key: {"status": "open"}},
        "lastSentAt": {},
        "closedHistory": [],
    }
    reference_reopens = 0
    last_close_observation = 0

    for index in range(500):
        action = rng.choice(["repeat", "repeat", "close", "fresh", "stale", "replay"])
        observation_time = now + index + 1
        if action == "close" and key in state["openIncidents"]:
            last_close_observation = observation_time
            state["closedHistory"].append({
                "incidentKey": key,
                "closedAt": observation_time,
                "closingObservationTime": observation_time,
                "closingEventIdentityDigest": f"{index:064x}"[-64:],
            })
            state["openIncidents"].pop(key)
            continue
        if action == "repeat" and key in state["openIncidents"]:
            continue
        if action not in {"fresh", "stale", "replay"}:
            continue
        event_time = (
            last_close_observation - 1
            if action in {"stale", "replay"} and last_close_observation
            else observation_time
        )
        event_id = "seed-replay" if action == "replay" else f"seed-{index}"
        event = _fault(event_time, event_id)
        recorded = mod.record_verified_reopen_if_applicable(event, state, observation_time)
        expected = key not in state["openIncidents"] and event_time > last_close_observation > 0
        assert recorded is expected, f"seed={seed} index={index} action={action}"
        if expected:
            reference_reopens += 1
            state["openIncidents"][key] = {"status": "open"}

    actual = state.get("flapState", {}).get(key, {}).get("verifiedReopenCount", 0)
    assert actual == reference_reopens, f"seed={seed}"
