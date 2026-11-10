"""Publication must not precede proof that its receipt can be persisted."""

import importlib.util
import json
import sys
from pathlib import Path

import pytest


@pytest.fixture
def observer():
    source = Path(__file__).resolve().parents[1] / "fleet_reliability_observer.py"
    spec = importlib.util.spec_from_file_location("publication_capacity_observer", source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("mode", ["observer", "watchdog", "sentinel", "service"])
@pytest.mark.parametrize("near_capacity", [False, True])
@pytest.mark.parametrize("filename", ["x" * 240, "é" * 120 + ".json"], ids=["ascii", "unicode"])
def test_capacity_is_checked_before_publication(
    tmp_path, observer, mode, near_capacity, filename
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
    event = {
        "event_id": "00000000-0000-4000-8000-000000000001",
        "publication": "not_attempted",
        "incident_id": "00000000-0000-4000-8000-000000000002",
        "kind": "alert",
        "reason": "fleet_synthetic",
        "host": "synthetic",
        "instance": "operations",
        "created_at": 100,
        "severity": "critical",
    }
    snapshot = {
        "supervisor": {"status": "fresh"},
        "worker": {"status": "fresh"},
        "capabilities": {"status": "fresh", "token": {"ok": True}},
        "alerts": [],
        "delivery_resolution": [],
        "delivery_dropped_at": None,
    }
    if mode == "service":
        state = supervisor.initial_state(100)
        state.update(liveness={"ok": True}, maintenance=True)
    elif mode == "watchdog":
        state = {"schema_version": 1, "incidents": {}}
        heartbeat = observer.initial_state(100)
        heartbeat["completed_at"] = 100
        supervisor.write_private(directory / "fleet-observer.json", heartbeat)
    elif mode == "sentinel":
        state = {"incidents": {}, "counts": {}, "snapshot": snapshot}
    else:
        state = observer.initial_state(100)
    legacy = {
        "event_id": "00000000-0000-4000-8000-000000000003",
        "published_at": 100,
        "delivery": "channel_delivered",
        "delivery_stale": False,
        "delivery_receipt": {"status": "sent", "audit_receipt": ""},
    }
    state.update(
        completed_at=100,
        pending_events=[event],
        alerts=[legacy],
        delivery_resolution={
            "checked_at": 100,
            "failures": [],
            "consecutive_failed_cycles": 0,
        },
    )
    if near_capacity:
        overhead = len(supervisor._bounded_json_bytes(state, supervisor.PRIVATE_JSON_MAX_BYTES)) + 1
        legacy["delivery_receipt"]["audit_receipt"] = "a" * (
            supervisor.PRIVATE_JSON_MAX_BYTES - 100 - overhead
        )
    supervisor.write_private(path, state)
    config = {
        "state_dir": str(directory),
        "hosts": [],
        "instance": "operations",
        "probe_timeout_seconds": 1,
        "freshness_seconds": 1200,
    }
    published = []

    def emit(item):
        published.append(item["event_id"])
        artifact = tmp_path / ("publication-" + str(len(published)))
        artifact.write_text(json.dumps(item))
        return {"published": True, "file": filename}

    def cycle(now):
        if mode == "observer":
            return observer.run_once(config, now=now, emit=emit)
        if mode == "watchdog":
            return observer.run_watchdog(config, now=now, emit=emit)
        if mode == "sentinel":
            return supervisor.run_sentinel(
                config, now=now, emit=emit, observe_remote=lambda: snapshot
            )
        return supervisor.run_once(
            {**config, "live_url": "http://127.0.0.1:1/"},
            now=now,
            emit=emit,
            probe=lambda *args: {"ok": True},
            maintenance=lambda: True,
        )

    for now in [100, 101]:
        if near_capacity:
            with pytest.raises(supervisor.PublicationCapacityError, match="publication_capacity_exhausted"):
                cycle(now)
            assert published == []
            assert list(tmp_path.glob("publication-*")) == []
        else:
            cycle(now)
            assert published == [event["event_id"]]
        saved = supervisor.read_private(path)
        assert saved["alerts"][0] == legacy
        assert saved["pending_events"] == ([event] if near_capacity else [])
        if not near_capacity:
            assert saved["alerts"][1]["file"] == filename
        assert path.stat().st_size <= supervisor.PRIVATE_JSON_MAX_BYTES


@pytest.mark.parametrize(("headroom", "outcomes"), [(2000, [True]), (3500, [False, True])])
def test_capacity_allows_an_ordered_prefix_and_preserves_the_rest(
    tmp_path, observer, headroom, outcomes
):
    supervisor = observer.supervisor
    state = supervisor.initial_state(100)
    events = [
        {"event_id": str(index), "incident_id": "incident", "kind": "alert",
         "reason": "capacity", "created_at": 100, "publication": "not_attempted"}
        for index in range(3)
    ]
    state["pending_events"] = events.copy()
    state["legacy_receipt"] = ""
    size = len(supervisor._bounded_json_bytes(state, supervisor.PRIVATE_JSON_MAX_BYTES)) + 1
    state["legacy_receipt"] = "a" * (supervisor.PRIVATE_JSON_MAX_BYTES - headroom - size)
    emitted = []

    def emit(event):
        emitted.append(event["event_id"])
        return {"published": outcomes[len(emitted) - 1], "file": "event.json"}

    supervisor.publish_pending_events(state, 100, emit, path=tmp_path / "state.json")
    assert emitted == [event["event_id"] for event in events[:len(outcomes)]]
    assert [(event["event_id"], event["delivery"]) for event in state["alerts"]] == [
        (event["event_id"], "locally_persisted" if success else "publication_unknown")
        for event, success in zip(events, outcomes)]
    assert state["pending_events"] == events[len(outcomes):]
    state["completed_at"] = 100
    supervisor.write_private(tmp_path / "state.json", state)
    saved = supervisor.read_private(tmp_path / "state.json")
    assert saved == state
    assert len(saved["alerts"]) + len(saved["pending_events"]) == len(events)


def test_emitter_cannot_mutate_the_reserved_event(observer, tmp_path):
    supervisor = observer.supervisor
    event = {"event_id": "preserved", "details": {"reason": "original"}, "publication": "not_attempted"}
    state = {"pending_events": [event], "alerts": []}

    def emit(item):
        item["details"]["reason"] = "changed"
        item["unbounded"] = "a" * supervisor.PRIVATE_JSON_MAX_BYTES
        return {"published": True, "file": "event.json"}

    supervisor.publish_pending_events(state, 100, emit, path=tmp_path / "state.json")
    assert state["pending_events"] == []
    assert state["alerts"] == [{
        "event_id": "preserved", "details": {"reason": "original"},
        "published_at": 100, "delivery": "locally_persisted", "file": "event.json",
    }]


@pytest.mark.parametrize(
    ("output", "accepted"),
    [
        ("/tmp/" + "x" * 255 + "\n", True),
        ("/tmp/" + "x" * 256 + "\n", False),
        ("/tmp/" + "é" * 125 + ".json\n", True),
        ("/tmp/" + "é" * 126 + ".json\n", False),
        ("/" + "x/" * 2044 + "a.json\n", True),
        ("/" + "x/" * 2044 + "ab.json\n", False),
        ("\n", False),
    ],
    ids=["filename-limit", "filename-over", "unicode-limit", "unicode-over",
         "path-limit", "path-over", "empty"],
)
def test_emitter_receipt_output_has_encoded_byte_limits(observer, output, accepted):
    event = {"event_id": "bounded-output", "incident_id": "incident",
             "reason": "capacity", "kind": "alert"}
    receipt = observer.supervisor.publish_event(
        {"emitter_command": [sys.executable, "-c", "import sys; sys.stdout.write(" + repr(output) + ")"],
         "instance": "operations"},
        event,
    )
    assert receipt["published"] is accepted
    if accepted:
        assert receipt["file"] == Path(output.strip()).name
    else:
        assert receipt == {"published": False}
