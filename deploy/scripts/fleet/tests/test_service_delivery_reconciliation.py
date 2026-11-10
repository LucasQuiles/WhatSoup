"""Service receipts must survive restart without unbounded lookup cycles."""

import importlib.util
import json
from pathlib import Path
import sys

import pytest


def load_supervisor():
    source = Path(__file__).resolve().parents[1] / "reliability_supervisor.py"
    spec = importlib.util.spec_from_file_location("service_reconciliation_supervisor", source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def alert(index):
    return {"event_id": f"00000000-0000-4000-8000-{index:012d}",
            "published_at": 100, "delivery": "locally_persisted", "file": "event.json"}


@pytest.fixture
def service(tmp_path):
    supervisor = load_supervisor()
    directory = tmp_path / "state"
    supervisor.private_directory(directory)
    responses = tmp_path / "responses.json"
    requests = tmp_path / "requests.jsonl"
    responses.write_text("{}")
    command = (
        "import json, pathlib, sys; "
        f"p=pathlib.Path({str(requests)!r}); "
        "f=p.open('a'); f.write(json.dumps(sys.argv[1:])+'\\n'); f.close(); "
        f"responses=json.loads(pathlib.Path({str(responses)!r}).read_text()); "
        "print(json.dumps({k:responses[k] for k in sys.argv[1:] if k in responses}))"
    )
    config = {"state_dir": str(directory), "live_url": "http://127.0.0.1:1/",
              "delivery_command": [sys.executable, "-c", command]}
    path = directory / "supervisor.json"
    return supervisor, config, path, responses, requests


def cycle(supervisor, config, now):
    return supervisor.run_once(
        config, now=now, probe=lambda *_: {"ok": True}, maintenance=lambda: True,
        restart=lambda: pytest.fail("healthy service restarted"),
        emit=lambda _: pytest.fail("receipt reconciliation re-emitted an old alert"),
    )


@pytest.mark.parametrize(("status", "expected"), [
    ("sent", "channel_delivered"), ("email_delivered", "channel_delivered"),
    ("suppressed", "dispatcher_suppressed"), ("storm_collapsed", "dispatcher_collapsed"),
])
def test_terminal_receipt_is_durable_and_not_requeried_after_restart(service, status, expected):
    supervisor, config, path, responses, requests = service
    original = alert(0)
    state = supervisor.initial_state(100)
    state["alerts"] = [original]
    supervisor.write_private(path, state)
    receipt = {"status": status, "audit_receipt": "exact audit evidence", "extra": "é"}
    responses.write_text(json.dumps({original["event_id"]: receipt}))
    result = cycle(supervisor, config, 101)
    assert result["alerts"][0]["delivery"] == expected
    assert result["alerts"][0]["event_id"] == original["event_id"]
    if expected == "channel_delivered":
        assert result["alerts"][0]["delivery_receipt"] == receipt
    assert supervisor.read_private(path) == result
    restarted = cycle(load_supervisor(), config, 102)
    assert restarted["alerts"][0] == result["alerts"][0]
    assert [json.loads(line) for line in requests.read_text().splitlines()] == [[original["event_id"]]]


def test_one_batch_per_cycle_resumes_after_restart_without_starving_later_alerts(service):
    supervisor, config, path, responses, requests = service
    state = supervisor.initial_state(100)
    state["alerts"] = [alert(index) for index in range(130)]
    supervisor.write_private(path, state)
    first = cycle(supervisor, config, 101)
    assert first["alerts"] == state["alerts"]
    responses.write_text(json.dumps({alert(i)["event_id"]: {"status": "sent", "audit_receipt": "proof"}
                                     for i in (128, 129)}))
    second = cycle(load_supervisor(), config, 102)
    queried = [json.loads(line) for line in requests.read_text().splitlines()]
    assert queried == [[alert(i)["event_id"] for i in range(128)],
                       [alert(i)["event_id"] for i in (128, 129)]]
    assert all(item["delivery"] == "locally_persisted" for item in second["alerts"][:128])
    assert all(item["delivery"] == "channel_delivered" for item in second["alerts"][128:])
    cycle(load_supervisor(), config, 103)
    assert json.loads(requests.read_text().splitlines()[-1]) == [alert(i)["event_id"] for i in range(128)]


def test_receipt_capacity_refusal_preserves_evidence_and_allows_smaller_terminal_update(service):
    supervisor, config, path, responses, requests = service
    state = supervisor.initial_state(100)
    state.update(completed_at=100, alerts=[alert(0), alert(1)], legacy_metadata="")
    size = len(supervisor._bounded_json_bytes(state, supervisor.PRIVATE_JSON_MAX_BYTES)) + 1
    state["legacy_metadata"] = "a" * (supervisor.PRIVATE_JSON_MAX_BYTES - 700 - size)
    supervisor.write_private(path, state)
    receipt = {"status": "sent", "audit_receipt": "a" * 3500}
    responses.write_text(json.dumps({alert(0)["event_id"]: receipt,
                                     alert(1)["event_id"]: {"status": "suppressed"}}))
    result = cycle(supervisor, config, 101)
    assert result["alerts"][0] == state["alerts"][0]
    assert result["alerts"][1]["delivery"] == "dispatcher_suppressed"
    assert result["legacy_metadata"] == state["legacy_metadata"]
    assert result["delivery_resolution"] == [{"code": "state_capacity_exhausted", "returncode": None}]
    assert supervisor.read_private(path) == result
    assert supervisor.observe(config, now=101)["delivery_resolution"] == result["delivery_resolution"]


def test_invalid_later_receipt_does_not_partially_confirm_a_batch(service):
    supervisor, config, path, responses, requests = service
    state = supervisor.initial_state(100)
    state["alerts"] = [alert(0), alert(1)]
    supervisor.write_private(path, state)
    responses.write_text(json.dumps({alert(0)["event_id"]: {"status": "sent", "audit_receipt": "proof"},
                                     alert(1)["event_id"]: {"status": "sent"}}))
    result = cycle(supervisor, config, 101)
    assert result["alerts"] == state["alerts"]
    assert result["delivery_resolution"] == [{"code": "invalid_output", "returncode": None}]
    assert supervisor.read_private(path) == result


def test_collector_acknowledgement_cannot_downgrade_terminal_delivery(service, tmp_path):
    supervisor, config, path, responses, requests = service
    state = supervisor.initial_state(100)
    state.update(completed_at=100, alerts=[{**alert(0), "delivery": "channel_delivered",
                                          "delivery_receipt": {"status": "sent", "audit_receipt": "proof"}}])
    supervisor.write_private(path, state)
    relay = tmp_path / "relay"
    (relay / "relayed").mkdir(parents=True)
    (relay / "relayed" / "event.json.1.relayed").write_text("ack")
    result = supervisor.observe({**config, "bot_errors_state_dir": str(relay)}, now=101)
    assert result["alerts"] == state["alerts"]
    assert supervisor.read_private(path) == state


def test_remote_observation_preserves_service_reconciliation_failure():
    supervisor = load_supervisor()
    snapshot = {"delivery_resolution": [{"code": "state_capacity_exhausted", "returncode": None}],
                "alerts": []}
    code = "print(" + repr(json.dumps(snapshot)) + ")"
    result = supervisor.remote_observation({"observe_command": [sys.executable, "-c", code]})
    assert result == snapshot


def test_remote_reader_cannot_publish_an_unpersisted_receipt(service):
    supervisor, config, path, responses, requests = service
    state = supervisor.initial_state(100)
    state["alerts"] = [alert(0)]
    supervisor.write_private(path, state)
    responses.write_text(json.dumps({alert(0)["event_id"]: {"status": "sent", "audit_receipt": "proof"}}))
    snapshot = {"alerts": [alert(0)], "delivery_resolution": []}
    config["observe_command"] = [sys.executable, "-c", "print(" + repr(json.dumps(snapshot)) + ")"]
    assert supervisor.remote_observation(config) == snapshot
    assert not requests.exists()
    assert supervisor.read_private(path) == state


@pytest.mark.parametrize("headroom", [1800, 2500])
def test_receipt_growth_cannot_take_space_reserved_for_pending_publication(service, capsys, headroom):
    supervisor, config, path, responses, requests = service
    state = supervisor.initial_state(100)
    event = {"event_id": "00000000-0000-4000-8000-000000000002",
             "incident_id": "existing_incident", "kind": "alert", "reason": "existing", "created_at": 100}
    state.update(completed_at=100, alerts=[alert(0)], pending_events=[event], legacy_metadata="")
    size = len(supervisor._bounded_json_bytes(state, supervisor.PRIVATE_JSON_MAX_BYTES)) + 1
    state["legacy_metadata"] = "a" * (supervisor.PRIVATE_JSON_MAX_BYTES - headroom - size)
    supervisor.write_private(path, state)
    responses.write_text(json.dumps({alert(0)["event_id"]: {"status": "sent", "audit_receipt": "a" * 2000}}))
    emitted = []

    def emit(item):
        emitted.append(item)
        return {"published": True, "file": "event.json"}

    result = supervisor.run_once(config, now=101, probe=lambda *_: {"ok": True},
                                 maintenance=lambda: True, emit=emit)
    assert emitted == [event]
    assert result["alerts"][0] == state["alerts"][0]
    assert result["pending_events"] == []
    if headroom == 2500:
        assert result["delivery_resolution"] == [{"code": "state_capacity_exhausted", "returncode": None}]
    else:
        assert '"code": "delivery_capacity_exhausted"' in capsys.readouterr().err
    assert supervisor.read_private(path) == result


def test_confirmed_receipt_is_saved_before_a_later_probe_failure(service):
    supervisor, config, path, responses, requests = service
    state = supervisor.initial_state(100)
    state["alerts"] = [alert(0)]
    supervisor.write_private(path, state)
    receipt = {"status": "sent", "audit_receipt": "proof"}
    responses.write_text(json.dumps({alert(0)["event_id"]: receipt}))

    def fail_probe(*_):
        raise OSError("synthetic probe failure")

    with pytest.raises(OSError, match="synthetic probe failure"):
        supervisor.run_once(config, now=101, probe=fail_probe, maintenance=lambda: True)
    saved = load_supervisor().read_private(path)
    assert saved["alerts"][0]["delivery_receipt"] == receipt
    assert saved["alerts"][0]["delivery"] == "channel_delivered"


def test_arriving_alerts_cannot_extend_a_retry_round_indefinitely(service):
    supervisor, config, path, responses, requests = service
    state = supervisor.initial_state(100)
    state["alerts"] = [alert(index) for index in range(130)]
    supervisor.write_private(path, state)
    receipts = {alert(i)["event_id"]: {"status": "sent", "audit_receipt": "proof"}
                for i in range(1, 600)}
    responses.write_text(json.dumps(receipts))
    for now in (101, 102):
        cycle(load_supervisor(), config, now)
        saved = supervisor.read_private(path)
        start = 200 + (now - 101) * 128
        saved["alerts"].extend(alert(index) for index in range(start, start + 128))
        supervisor.write_private(path, saved)
    cycle(load_supervisor(), config, 103)
    queried = [json.loads(line) for line in requests.read_text().splitlines()]
    assert all(len(batch) <= 128 for batch in queried)
    assert queried[1] == [alert(i)["event_id"] for i in (128, 129)]
    assert alert(0)["event_id"] in queried[2]
    unresolved = [a for a in supervisor.read_private(path)["alerts"] if a["event_id"] == alert(0)["event_id"]]
    assert unresolved == [alert(0)]


def test_receipt_storage_exhaustion_pauses_new_service_transitions(service):
    supervisor, config, path, responses, requests = service
    state = supervisor.initial_state(100)
    state.update(completed_at=100, alerts=[alert(0)], consecutive_failures=2, legacy_metadata="")
    size = len(supervisor._bounded_json_bytes(state, supervisor.PRIVATE_JSON_MAX_BYTES)) + 1
    state["legacy_metadata"] = "a" * (supervisor.PRIVATE_JSON_MAX_BYTES - 3000 - size)
    supervisor.write_private(path, state)
    responses.write_text(json.dumps({alert(0)["event_id"]: {"status": "sent", "audit_receipt": "a" * 3500}}))
    result = supervisor.run_once(
        config, now=101, probe=lambda *_: {"ok": False}, maintenance=lambda: False,
        restart=lambda: pytest.fail("restarted while receipt storage was exhausted"),
        emit=lambda _: pytest.fail("created an incident while receipt storage was exhausted"),
    )
    assert result["incident_id"] is None
    assert result["alerts"] == state["alerts"]
    assert result["pending_events"] == []
    assert result["transition_capacity_exhausted"] is True
    assert result["delivery_resolution"] == [{"code": "state_capacity_exhausted", "returncode": None}]
    assert supervisor.read_private(path) == result


def test_malformed_batch_advances_then_retries_without_losing_obligations(service):
    supervisor, config, path, responses, requests = service
    state = supervisor.initial_state(100)
    state["alerts"] = [alert(index) for index in range(130)]
    supervisor.write_private(path, state)
    receipts = {alert(i)["event_id"]: {"status": "sent", "audit_receipt": "proof"} for i in range(130)}
    receipts[alert(127)["event_id"]] = {"status": "sent"}
    responses.write_text(json.dumps(receipts))
    first = cycle(supervisor, config, 101)
    assert first["alerts"] == state["alerts"]
    assert first["delivery_resolution"] == [{"code": "invalid_output", "returncode": None}]
    second = cycle(load_supervisor(), config, 102)
    assert all(a["delivery"] == "locally_persisted" for a in second["alerts"][:128])
    assert all(a["delivery"] == "channel_delivered" for a in second["alerts"][128:])
    receipts[alert(127)["event_id"]] = {"status": "sent", "audit_receipt": "proof"}
    responses.write_text(json.dumps(receipts))
    third = cycle(load_supervisor(), config, 103)
    assert all(a["delivery"] == "channel_delivered" for a in third["alerts"])
    queried = [json.loads(line) for line in requests.read_text().splitlines()]
    assert queried == [[alert(i)["event_id"] for i in range(128)],
                       [alert(i)["event_id"] for i in (128, 129)],
                       [alert(i)["event_id"] for i in range(128)]]


def test_unrelated_batch_cannot_clear_known_capacity_failure(service):
    supervisor, config, path, responses, requests = service
    state = supervisor.initial_state(100)
    state.update(completed_at=100, alerts=[alert(i) for i in range(129)], legacy_metadata="")
    size = len(supervisor._bounded_json_bytes(state, supervisor.PRIVATE_JSON_MAX_BYTES)) + 1
    state["legacy_metadata"] = "a" * (supervisor.PRIVATE_JSON_MAX_BYTES - 3000 - size)
    supervisor.write_private(path, state)
    responses.write_text(json.dumps({alert(0)["event_id"]: {"status": "sent", "audit_receipt": "a" * 3500}}))
    first = cycle(supervisor, config, 101)
    assert first["transition_capacity_exhausted"] is True
    second = cycle(load_supervisor(), config, 102)
    assert second["transition_capacity_exhausted"] is True
    assert second["delivery_resolution"] == [{"code": "state_capacity_exhausted", "returncode": None}]
    responses.write_text(json.dumps({alert(0)["event_id"]: {"status": "sent", "audit_receipt": "proof"}}))
    third = cycle(load_supervisor(), config, 103)
    assert third["alerts"][0]["delivery"] == "channel_delivered"
    assert third["transition_capacity_exhausted"] is True
    fourth = cycle(load_supervisor(), config, 104)
    assert fourth["transition_capacity_exhausted"] is False
    assert fourth["delivery_resolution"] == []
