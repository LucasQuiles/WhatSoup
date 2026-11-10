"""Each monitor owns durable receipts and a bounded lookup cycle."""

import importlib.util
import json
from pathlib import Path
import sys

import pytest

from test_service_delivery_reconciliation import alert, load_supervisor, service


def load_observer():
    path = Path(__file__).resolve().parents[1] / "fleet_reliability_observer.py"
    spec = importlib.util.spec_from_file_location("monitor_reconciliation_observer", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def seed_monitor(service, kind, alerts):
    supervisor, config, _, responses, requests = service
    config.update(hosts=[], instance="fleet-test", freshness_seconds=1200)
    directory = Path(config["state_dir"])
    observer_state = load_observer().initial_state(100)
    observer_state["completed_at"] = 100
    supervisor.write_private(directory / "fleet-observer.json", observer_state)
    if kind == "observer":
        path, state = directory / "fleet-observer.json", observer_state
    else:
        path = directory / ("fleet-watchdog.json" if kind == "watchdog" else "sentinel.json")
        state = {"schema_version": 1, "incidents": {}, "counts": {},
                 "alerts": [], "pending_events": [], "completed_at": 100}
    state["alerts"] = alerts
    supervisor.write_private(path, state)
    return config, path, responses, requests


def run_monitor(kind, config, now):
    def emit(_):
        pytest.fail("healthy monitor created an incident")

    if kind == "observer":
        return load_observer().run_once(config, now=now, emit=emit)
    if kind == "watchdog":
        return load_observer().run_watchdog(config, now=now, emit=emit)
    return load_supervisor().run_sentinel(
        config, now=now, emit=emit, observe_remote=lambda: {
            "supervisor": {"status": "fresh"}, "worker": {"status": "fresh"},
            "capabilities": {"status": "fresh", "token": {"ok": True}},
            "alerts": [], "delivery_resolution": [],
        },
    )


@pytest.mark.parametrize("kind", ["observer", "watchdog", "sentinel"])
def test_monitor_lookup_is_one_batch_and_resumes_after_restart(service, kind):
    config, path, responses, requests = seed_monitor(service, kind, [alert(i) for i in range(130)])
    first = run_monitor(kind, config, 101)
    assert [len(json.loads(line)) for line in requests.read_text().splitlines()] == [128]
    assert [(a["event_id"], a["delivery"]) for a in first["alerts"]] == [(alert(i)["event_id"], "locally_persisted") for i in range(130)]
    responses.write_text(json.dumps({alert(i)["event_id"]: {"status": "sent", "audit_receipt": "proof"}
                                     for i in (128, 129)}))
    second = run_monitor(kind, config, 102)
    assert [json.loads(line) for line in requests.read_text().splitlines()] == [
        [alert(i)["event_id"] for i in range(128)], [alert(i)["event_id"] for i in (128, 129)]
    ]
    assert [a["delivery"] for a in second["alerts"][-2:]] == ["channel_delivered"] * 2
    assert load_supervisor().read_private(path) == second
    run_monitor(kind, config, 103)
    assert json.loads(requests.read_text().splitlines()[-1]) == [alert(i)["event_id"] for i in range(128)]


def test_watchdog_reads_observer_receipts_without_independent_confirmation(service):
    config, path, responses, requests = seed_monitor(service, "watchdog", [alert(0)])
    supervisor = load_supervisor()
    observer_path = path.with_name("fleet-observer.json")
    observer = supervisor.read_private(observer_path)
    observer["alerts"] = [alert(1)]
    supervisor.write_private(observer_path, observer)
    original = observer_path.read_bytes()
    responses.write_text(json.dumps({alert(i)["event_id"]: {"status": "sent", "audit_receipt": "proof"}
                                     for i in (0, 1)}))
    result = run_monitor("watchdog", config, 101)
    assert [json.loads(line) for line in requests.read_text().splitlines()] == [[alert(0)["event_id"]]]
    assert result["alerts"][0]["delivery"] == "channel_delivered"
    assert supervisor.read_private(path) == result
    assert observer_path.read_bytes() == original


@pytest.mark.parametrize("kind", ["observer", "watchdog", "sentinel"])
def test_monitor_preserves_unfitting_receipt_and_reports_capacity(service, kind):
    config, path, responses, requests = seed_monitor(service, kind, [alert(0)])
    supervisor = load_supervisor()
    state = supervisor.read_private(path)
    state["legacy_metadata"] = ""
    size = len(supervisor._bounded_json_bytes(state, supervisor.PRIVATE_JSON_MAX_BYTES)) + 1
    state["legacy_metadata"] = "a" * (supervisor.PRIVATE_JSON_MAX_BYTES - 2500 - size)
    supervisor.write_private(path, state)
    responses.write_text(json.dumps({alert(0)["event_id"]: {"status": "sent", "audit_receipt": "a" * 3500}}))
    result = run_monitor(kind, config, 101)
    assert result["alerts"][0]["delivery"] == "locally_persisted"
    assert "delivery_receipt" not in result["alerts"][0]
    assert supervisor.delivery_failures(result) == [{"code": "state_capacity_exhausted", "returncode": None}]
    assert result["transition_capacity_exhausted"] is True
    assert result["legacy_metadata"] == state["legacy_metadata"]
    assert supervisor.read_private(path) == result


@pytest.mark.parametrize("kind", ["observer", "watchdog"])
def test_monitor_annotations_cannot_overflow_preserved_legacy_alerts(service, kind):
    config, path, _, requests = seed_monitor(service, kind, [alert(i) for i in range(130)])
    supervisor = load_supervisor()
    state = supervisor.read_private(path)
    state["legacy_metadata"] = ""
    size = len(supervisor._bounded_json_bytes(state, supervisor.PRIVATE_JSON_MAX_BYTES)) + 1
    state["legacy_metadata"] = "a" * (supervisor.PRIVATE_JSON_MAX_BYTES - 1000 - size)
    supervisor.write_private(path, state)
    result = run_monitor(kind, config, 101)
    assert result["alerts"] == state["alerts"]
    assert result["legacy_metadata"] == state["legacy_metadata"]
    assert result["transition_capacity_exhausted"] is True
    assert supervisor.read_private(path) == result
    assert [len(json.loads(line)) for line in requests.read_text().splitlines()] == [128]
