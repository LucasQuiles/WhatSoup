"""New transitions must leave room to finish existing delivery obligations."""

from copy import deepcopy
import importlib.util
from pathlib import Path
import sys

import pytest


@pytest.fixture
def observer():
    source = Path(__file__).resolve().parents[1] / "fleet_reliability_observer.py"
    spec = importlib.util.spec_from_file_location("transition_capacity_observer", source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(("mode", "maintenance"), [
    ("observer", True), ("watchdog", True), ("sentinel", True),
    ("service", True), ("service", False),
])
@pytest.mark.parametrize("near_capacity", [False, True])
@pytest.mark.parametrize("published", [False, True])
@pytest.mark.parametrize("recover", [False, True])
def test_transition_cannot_consume_existing_publication_headroom(
    tmp_path, observer, mode, maintenance, near_capacity, published, recover
):
    supervisor = observer.supervisor
    directory = tmp_path / "state"
    supervisor.private_directory(directory)
    path = directory / {
        "observer": "fleet-observer.json",
        "watchdog": "fleet-watchdog.json",
        "sentinel": "sentinel.json",
        "service": "supervisor.json",
    }[mode]
    host = {"host": "synthetic", "instance": "operations"}
    incident_id = "00000000-0000-4000-8000-000000000004"
    event = {
        "event_id": "00000000-0000-4000-8000-000000000001",
        "incident_id": "00000000-0000-4000-8000-000000000002",
        "kind": "alert", "reason": "existing_obligation", "created_at": 100,
        "instance": "operations", "host": "synthetic", "severity": "critical",
    }
    retained = {
        "event_id": "00000000-0000-4000-8000-000000000003",
        "published_at": 100, "delivery": "locally_persisted", "legacy_metadata": "",
    }
    if mode == "observer":
        state = observer.initial_state(100)
        record = observer._host_state(state, host)
        record["probe_failure_count"] = 1
        if recover:
            record["unverified"] = incident_id
    elif mode == "service":
        state = supervisor.initial_state(100)
        state.update(consecutive_failures=2, maintenance=True)
        if recover:
            state["incident_id"] = incident_id
    else:
        state = {"schema_version": 1, "incidents": {}, "counts": {}}
        if mode == "sentinel":
            state["counts"]["remote_observation_unavailable"] = 1
        if recover:
            reason = "observer_stale" if mode == "watchdog" else "remote_observation_unavailable"
            state["incidents"][reason] = incident_id
            if mode == "watchdog":
                supervisor.write_private(directory / "fleet-observer.json", {"completed_at": 100})
    state.update(completed_at=100, pending_events=[deepcopy(event)], alerts=[retained])
    if near_capacity:
        overhead = len(supervisor._bounded_json_bytes(state, supervisor.PRIVATE_JSON_MAX_BYTES)) + 1
        retained["legacy_metadata"] = "a" * (supervisor.PRIVATE_JSON_MAX_BYTES - 2500 - overhead)
    retained_before = deepcopy(retained)
    supervisor.write_private(path, state)
    config = {
        "state_dir": str(directory), "hosts": [host], "instance": "operations",
        "probe_timeout_seconds": 1, "freshness_seconds": 1200,
        "live_url": "http://127.0.0.1:1/",
    }
    emitted = []
    restarts = []

    def emit(item):
        emitted.append(deepcopy(item))
        return {"published": published, "file": "event.json"}

    def unavailable():
        if recover:
            return {"supervisor": {"status": "fresh"}}
        raise OSError("synthetic unavailable observation")

    def cycle(now):
        if mode == "observer":
            payload = {"checked_at": now, "checks": {}, "codes": []} if recover else None
            result = observer.run_once(config, now=now, probe=lambda *_: payload, emit=emit)
            return result, result["hosts"][host["host"]]["unverified"]
        if mode == "watchdog":
            result = observer.run_watchdog(config, now=now, emit=emit)
            return result, result["incidents"].get("observer_stale")
        if mode == "sentinel":
            result = supervisor.run_sentinel(config, now=now, emit=emit, observe_remote=unavailable)
            return result, result["incidents"].get("remote_observation_unavailable")
        result = supervisor.run_once(
            config, now=now, probe=lambda *_: {"ok": recover},
            maintenance=lambda: maintenance, restart=lambda: restarts.append(now), emit=emit,
        )
        return result, result["incident_id"]

    result, opened = cycle(101)

    assert emitted[0] == event
    restart_eligible = mode == "service" and not maintenance and not recover
    assert restarts == ([101] if restart_eligible and not near_capacity else [])
    if near_capacity:
        assert [item["event_id"] for item in emitted] == [event["event_id"]]
        assert opened == (incident_id if recover else None)
        assert result["transition_capacity_exhausted"] is True
    else:
        assert (opened is None) is recover
        assert len(emitted) == 2
        assert emitted[1]["kind"] == ("clear" if recover else "alert")
        if recover:
            assert emitted[1]["incident_id"] == incident_id
        assert not result.get("transition_capacity_exhausted", False)
    saved = supervisor.read_private(path)
    assert saved == result
    assert {key: saved["alerts"][0][key] for key in retained_before} == retained_before
    obligations = saved["alerts"] + saved["pending_events"]
    assert len([item for item in obligations if item["event_id"] == event["event_id"]]) == 1
    assert path.stat().st_size <= supervisor.PRIVATE_JSON_MAX_BYTES

    if near_capacity:
        emitted.clear()
        result, opened = cycle(102)
        assert result["transition_capacity_exhausted"] is not published
        if published:
            assert (opened is None) is recover
            assert len(emitted) == 1
            assert emitted[0]["event_id"] != event["event_id"]
            assert emitted[0]["kind"] == ("clear" if recover else "alert")
            if recover:
                assert emitted[0]["incident_id"] == incident_id
        else:
            assert opened == (incident_id if recover else None)
            assert emitted == [event]
        assert restarts == ([102] if published and restart_eligible else [])
        assert supervisor.read_private(path) == result


def test_legacy_service_without_counters_retries_fitting_pending_prefix(tmp_path, observer):
    supervisor = observer.supervisor
    directory = tmp_path / "state"
    supervisor.private_directory(directory)
    path = directory / "supervisor.json"
    state = supervisor.initial_state(100)
    del state["observation"]
    state["completed_at"] = 100
    state["pending_events"] = [
        {"event_id": str(index), "incident_id": "legacy", "kind": "alert",
         "reason": "existing_obligation", "created_at": 100}
        for index in range(2)
    ]
    state["legacy_metadata"] = ""
    size = len(supervisor._bounded_json_bytes(state, supervisor.PRIVATE_JSON_MAX_BYTES)) + 1
    state["legacy_metadata"] = "a" * (supervisor.PRIVATE_JSON_MAX_BYTES - 2500 - size)
    supervisor.write_private(path, state)
    events = []

    def emit(event):
        events.append(event)
        return {"published": True, "file": "event.json"}

    result = supervisor.run_once(
        {"state_dir": str(directory), "live_url": "http://127.0.0.1:1/"},
        now=101, probe=lambda *_: {"ok": True}, maintenance=lambda: True,
        restart=lambda: pytest.fail("healthy service restarted"), emit=emit,
    )
    assert [event["event_id"] for event in events] == ["0"]
    assert [event["event_id"] for event in result["pending_events"]] == ["1"]
    assert result["transition_capacity_exhausted"] is True
    assert result["legacy_metadata"] == state["legacy_metadata"]
    assert supervisor.read_private(path) == result


@pytest.mark.parametrize("oversized", [False, True])
def test_restart_result_bound_preserves_readable_reserved_state(tmp_path, observer, oversized):
    supervisor = observer.supervisor
    directory = tmp_path / "state"
    supervisor.private_directory(directory)
    path = directory / "supervisor.json"
    state = supervisor.initial_state(100)
    state["consecutive_failures"] = 2
    supervisor.write_private(path, state)
    details = "a" * (supervisor.MAX_RESTART_DETAILS_BYTES - 2 + int(oversized))
    events = []

    def emit(event):
        events.append(event)
        return {"published": True, "file": "event.json"}

    result = supervisor.run_once(
        {"state_dir": str(directory), "live_url": "http://127.0.0.1:1/"},
        now=101, probe=lambda *_: {"ok": False}, maintenance=lambda: False,
        restart=lambda: details, emit=emit,
    )
    assert result["restart_result"] == ("failed" if oversized else "command_succeeded")
    assert result.get("restart_details") == (None if oversized else details)
    assert result["restart_attempts"] == [101]
    assert len(events) == 1
    assert supervisor.read_private(path) == result


def test_full_legacy_state_is_preserved_when_degraded_flag_cannot_fit(tmp_path, observer):
    supervisor = observer.supervisor
    directory = tmp_path / "state"
    supervisor.private_directory(directory)
    path = directory / "supervisor.json"
    state = supervisor.initial_state(100)
    state["legacy_metadata"] = ""
    size = len(supervisor._bounded_json_bytes(state, supervisor.PRIVATE_JSON_MAX_BYTES)) + 1
    state["legacy_metadata"] = "a" * (supervisor.PRIVATE_JSON_MAX_BYTES - size)
    supervisor.write_private(path, state)
    original = path.read_bytes()
    with pytest.raises(supervisor.PublicationCapacityError, match="publication_capacity_exhausted"):
        supervisor.run_once(
            {"state_dir": str(directory), "live_url": "http://127.0.0.1:1/"}, now=101,
            probe=lambda *_: pytest.fail("unreserved probe"),
            restart=lambda: pytest.fail("unreserved restart"),
            emit=lambda _: pytest.fail("unreserved publication"), maintenance=lambda: True,
        )
    assert path.read_bytes() == original
    assert supervisor.read_private(path) == state


@pytest.mark.parametrize(("incident_open", "headroom"), [
    *[(False, size) for size in (1800, 1850, 1900, 1950, 2000, 2050, 2100, 2150, 2200)],
    *[(True, size) for size in (125, 150, 175, 200, 225, 250, 275, 300, 350, 400)],
])
def test_restart_result_cannot_consume_reserved_publication_space(
    tmp_path, observer, incident_open, headroom
):
    supervisor = observer.supervisor
    directory = tmp_path / "state"
    supervisor.private_directory(directory)
    path = directory / "supervisor.json"
    state = supervisor.initial_state(100)
    state.update(completed_at=100, consecutive_failures=2, legacy_metadata="")
    if incident_open:
        state["incident_id"] = "existing_incident"
    size = len(supervisor._bounded_json_bytes(state, supervisor.PRIVATE_JSON_MAX_BYTES)) + 1
    state["legacy_metadata"] = "a" * (supervisor.PRIVATE_JSON_MAX_BYTES - headroom - size)
    supervisor.write_private(path, state)
    restarts, events = [], []

    def restart():
        reserved = supervisor.read_private(path)
        assert reserved["restart_result"] == "reserved"
        assert reserved["restart_attempts"] == [101]
        restarts.append(101)
        return {"old_pid": 99998, "new_pid": 99999}

    def emit(event):
        events.append(event)
        return {"published": True, "file": "\x01" * 255}

    result = supervisor.run_once(
        {"state_dir": str(directory), "live_url": "http://127.0.0.1:1/"},
        now=101, probe=lambda *_: {"ok": False}, maintenance=lambda: False,
        restart=restart, emit=emit,
    )
    assert len(events) == (0 if incident_open else len(restarts))
    if restarts:
        assert result["restart_details"] == {"old_pid": 99998, "new_pid": 99999}
        assert result["pending_events"] == []
    else:
        assert result["transition_capacity_exhausted"] is True
        assert result["incident_id"] == ("existing_incident" if incident_open else None)
    assert supervisor.read_private(path) == result
