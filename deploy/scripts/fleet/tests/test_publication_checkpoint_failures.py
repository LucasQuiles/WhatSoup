"""State persistence failures cannot allow an unrecorded emitter invocation."""

from pathlib import Path
import tempfile

import pytest

from deploy.scripts.fleet.tests.test_monitor_publication_recovery import event, load


@pytest.mark.parametrize("failing_write", [1, 2])
def test_failed_checkpoint_never_republishes_an_attempt(monkeypatch, failing_write):
    supervisor = load("publication_checkpoint", "fleet/reliability_supervisor.py")
    with tempfile.TemporaryDirectory(prefix="publication-checkpoint-") as temporary:
        path = Path(temporary) / "supervisor.json"
        state = supervisor.initial_state(100)
        state["pending_events"] = [event()]
        supervisor.write_private(path, state)
        original = path.read_bytes()
        durable_write = supervisor.write_private
        writes = []
        calls = []

        def write(target, value):
            writes.append(target)
            if len(writes) == failing_write:
                raise OSError("synthetic disk failure")
            durable_write(target, value)

        def emit(item):
            calls.append(item["event_id"])
            saved = supervisor.read_private(path)
            assert saved["alerts"][0]["delivery"] == "publication_unknown"
            assert saved["pending_events"] == []
            return {"published": True, "file": "event.json"}

        with monkeypatch.context() as scoped:
            scoped.setattr(supervisor, "write_private", write)
            with pytest.raises(OSError, match="synthetic disk failure"):
                supervisor.publish_pending_events(state, 101, emit, path=path)
        assert calls == ([] if failing_write == 1 else [event()["event_id"]])
        if failing_write == 1:
            assert path.read_bytes() == original
        restarted = supervisor.read_private(path)
        supervisor.publish_pending_events(restarted, 102, emit, path=path)
        # Failed pre-call persistence may retry; failed acknowledgement saving may not.
        assert calls == [event()["event_id"]]
        assert restarted["alerts"][0]["delivery"] == (
            "locally_persisted" if failing_write == 1 else "publication_unknown")


@pytest.mark.parametrize("outcome", ["exception", "wrong_id"])
def test_untrusted_adapter_result_preserves_hold(outcome):
    supervisor = load("publication_bad_adapter", "fleet/reliability_supervisor.py")
    with tempfile.TemporaryDirectory(prefix="publication-adapter-") as temporary:
        path = Path(temporary) / "supervisor.json"
        state = supervisor.initial_state(100)
        state["pending_events"] = [event()]
        calls = []

        def emit(item):
            calls.append(item["event_id"])
            if outcome == "exception":
                raise TimeoutError("acknowledgement lost")
            return {"published": True, "event_id": event(2)["event_id"], "file": "other.json"}

        supervisor.publish_pending_events(state, 101, emit, path=path)
        restarted = supervisor.read_private(path)
        supervisor.publish_pending_events(restarted, 102, emit, path=path)
        assert calls == [event()["event_id"]]
        assert restarted["alerts"][0]["delivery"] == "publication_unknown"
        assert "published_at" not in restarted["alerts"][0]
        supervisor.write_private(path, {**restarted, "completed_at": 102})
        observed = supervisor.observe({"state_dir": temporary}, now=103)
        assert observed["publication_unknown"] == 1
        assert observed["monitoring_degraded"] is True


def test_held_and_confirmed_alerts_share_bounded_reconciliation():
    supervisor = load("publication_mixed_receipts", "fleet/reliability_supervisor.py")
    state = supervisor.initial_state(100)
    held = {**event(), "delivery": "publication_unknown"}
    pending = {**event(2), "delivery": "locally_persisted", "published_at": 100}
    state["alerts"] = [held, pending]
    queried = []

    def resolve(alerts):
        queried.extend(a["event_id"] for a in alerts)
        alerts[1].update(delivery="channel_delivered", delivery_receipt={"status": "sent", "audit_receipt": "proof"})
        return []

    result = supervisor.reconcile_alert_delivery({}, state, 101, resolve_delivery=resolve)
    assert queried == [event()["event_id"], event(2)["event_id"]]
    assert result["alerts"][0] == held
    assert result["alerts"][1]["delivery"] == "channel_delivered"
