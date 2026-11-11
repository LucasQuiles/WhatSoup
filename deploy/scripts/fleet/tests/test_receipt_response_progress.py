"""Large valid receipts must not permanently stall a bounded writer."""

import json
import sys

import pytest
from hypothesis import example, given, settings, strategies as st

from deploy.scripts.fleet.tests.test_monitor_delivery_reconciliation import run_monitor, seed_monitor
from deploy.scripts.fleet.tests.test_service_delivery_reconciliation import (
    alert, cycle, load_supervisor, service, temporary_service,
)


@pytest.mark.parametrize("kind", ["service", "observer", "watchdog", "sentinel"])
@pytest.mark.parametrize("command_rejects", [False, True], ids=["output-limit", "command-limit"])
@settings(max_examples=4, deadline=5000)
@example(receipt_size=3500)
@given(receipt_size=st.integers(min_value=3000, max_value=3900))
def test_large_valid_receipts_make_progress_after_batch_reduction(kind, command_rejects, receipt_size):
    with temporary_service() as service:
        supervisor, config, path, responses, requests = service
        if kind == "service":
            state = supervisor.initial_state(100)
            state["alerts"] = [alert(i) for i in range(24)]
            supervisor.write_private(path, state)
        else:
            config, path, responses, requests = seed_monitor(service, kind, [alert(i) for i in range(24)])
        receipt = {"status": "sent", "audit_receipt": "a" * receipt_size}
        responses.write_text(json.dumps({alert(i)["event_id"]: receipt for i in range(24)}))
        if command_rejects:
            config["delivery_command"] = [sys.executable, "-c", (
                "import json,pathlib,sys; "
                f"f=pathlib.Path({str(requests)!r}).open('a'); "
                "f.write(json.dumps(sys.argv[1:])+'\\n'); f.close(); "
                f"receipts=json.loads(pathlib.Path({str(responses)!r}).read_text()); "
                "output=json.dumps({k:receipts[k] for k in sys.argv[1:]}); "
                "sys.exit(1) if len(output.encode())>65535 else print(output)"
            )]
        for now in (101, 102, 103):
            result = (cycle(load_supervisor(), config, now) if kind == "service"
                      else run_monitor(kind, config, now))
            assert supervisor.read_private(path) == result
            assert {a["event_id"] for a in result["alerts"]} == {alert(i)["event_id"] for i in range(24)}
        assert [len(json.loads(line)) for line in requests.read_text().splitlines()] == [24, 12, 12]
        assert all(a["delivery"] == "channel_delivered" and a["delivery_receipt"] == receipt
                   for a in result["alerts"])


def test_every_valid_batch_limit_bounds_queries_and_preserves_progress(monkeypatch):
    supervisor = load_supervisor()
    queries = []

    def resolve(_, batch):
        queries.append([a["event_id"] for a in batch])

    monkeypatch.setattr(supervisor, "_resolve_batch", resolve)
    for limit in range(1, 129):
        queries.clear()
        state = supervisor.initial_state(100)
        state.update(delivery_batch_limit=limit, alerts=[alert(i) for i in range(259)])
        for now in (101, 102):
            state = supervisor.reconcile_alert_delivery({"delivery_command": ["unused"]}, state, now)
            state = json.loads(json.dumps(state))
        assert len(queries) == 2
        assert all(0 < len(batch) <= limit for batch in queries)
        assert len(set(queries[0]) | set(queries[1])) == 2 * limit
        assert state["alerts"] == [alert(i) for i in range(259)]
