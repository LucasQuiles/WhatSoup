"""An interrupted emitter call must never become an automatic second publication."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

import pytest
from hypothesis import example, given, settings, strategies as st


SCRIPTS = Path(__file__).resolve().parents[2]
FILENAMES = {"observer": "fleet-observer.json", "watchdog": "fleet-watchdog.json",
             "sentinel": "sentinel.json", "service": "supervisor.json"}
SNAPSHOT = {"supervisor": {"status": "fresh"}, "worker": {"status": "fresh"},
            "capabilities": {"status": "fresh", "token": {"ok": True}},
            "alerts": [], "delivery_resolution": [], "delivery_dropped_at": None}


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def event(index=1):
    return {"event_id": f"00000000-0000-4000-8000-{index:012d}",
            "incident_id": "00000000-0000-4000-8000-000000000099",
            "kind": "alert", "reason": "synthetic_retry", "instance": "synthetic",
            "created_at": 100, "severity": "critical", "publication": "not_attempted"}


def seed(root, mode, events):
    observer = load("publication_recovery_seed", "fleet/fleet_reliability_observer.py")
    supervisor = observer.supervisor
    directory = root / "monitor"
    supervisor.private_directory(directory)
    if mode == "observer":
        state = observer.initial_state(100)
    elif mode == "watchdog":
        state = {"schema_version": 1, "incidents": {}}
        heartbeat = observer.initial_state(100)
        heartbeat["completed_at"] = 100
        supervisor.write_private(directory / "fleet-observer.json", heartbeat)
    elif mode == "sentinel":
        state = {"incidents": {}, "counts": {}, "snapshot": SNAPSHOT}
    else:
        state = supervisor.initial_state(100)
        state.update(liveness={"ok": True}, maintenance=True)
    state.update(pending_events=events, alerts=[], completed_at=100)
    path = directory / FILENAMES[mode]
    supervisor.write_private(path, state)
    return path


def cycle(mode, directory, emit, *, delivery_command=None):
    observer = load("publication_recovery_cycle", "fleet/fleet_reliability_observer.py")
    supervisor = observer.supervisor
    config = {"state_dir": str(directory), "hosts": [], "instance": "synthetic",
              "probe_timeout_seconds": 1, "freshness_seconds": 1200,
              "live_url": "http://127.0.0.1:1/"}
    if delivery_command is not None:
        config["delivery_command"] = delivery_command
    if mode == "observer":
        return observer.run_once(config, now=101, emit=emit)
    if mode == "watchdog":
        return observer.run_watchdog(config, now=101, emit=emit)
    if mode == "sentinel":
        return supervisor.run_sentinel(config, now=101, emit=emit, observe_remote=lambda: SNAPSHOT)
    return supervisor.run_once(config, now=101, emit=emit,
                               probe=lambda *args: {"ok": True}, maintenance=lambda: True)


@pytest.mark.parametrize("mode", FILENAMES)
@pytest.mark.parametrize("crash_point", ["before_emit", "after_emit"])
def test_restart_holds_uncertain_publication_and_continues_other_work(mode, crash_point):
    with tempfile.TemporaryDirectory(prefix="monitor-crash-") as temporary:
        root = Path(temporary)
        path = seed(root, mode, [event()])
        outbox = root / "transport" / "outbox"
        env = {**os.environ, "BOT_ERRORS_STATE_DIR": str(outbox.parent),
               "BOT_ERRORS_OUTBOX_DIR": str(outbox), "BOT_ERRORS_INLINE_LOG_TAIL": "0",
               "PYTHONDONTWRITEBYTECODE": "1"}
        crashed = subprocess.run([sys.executable, __file__, mode, str(path.parent), crash_point],
                                 env=env, capture_output=True, text=True, timeout=30)
        assert crashed.returncode == 73, crashed.stderr
        persisted = json.loads(path.read_text())
        # The durable hold must exist even when the emitter has not run yet.
        assert persisted["pending_events"] == []
        assert [(a["event_id"], a["delivery"]) for a in persisted["alerts"]] == [
            (event()["event_id"], "publication_unknown")]
        with patch.dict(os.environ, env):
            dispatcher = load("publication_recovery_dispatcher", "bot-errors-dispatcher.py")
            paths = dispatcher.setup_dirs()
            if crash_point == "after_emit":
                dispatcher.claim(next(outbox.glob("*.json")), paths["processing"])
        # An independent event still progresses on the next process invocation.
        persisted["pending_events"] = [event(2)]
        supervisor = load("publication_recovery_supervisor", "fleet/reliability_supervisor.py")
        supervisor.write_private(path, persisted)
        resumed = subprocess.run([sys.executable, __file__, mode, str(path.parent), "resume"],
                                 env=env, capture_output=True, text=True, timeout=30)
        assert resumed.returncode == 0, resumed.stderr
        records = list(outbox.glob("*.json")) + list(paths["processing"].glob("*.processing"))
        ids = [json.loads(p.read_text())["id"] for p in records]
        assert ids.count(event()["event_id"]) == (1 if crash_point == "after_emit" else 0)
        assert ids.count(event(2)["event_id"]) == 1
        after = json.loads(path.read_text())
        assert after["pending_events"] == []
        assert after["alerts"][0]["delivery"] == "publication_unknown"
        assert "published_at" not in after["alerts"][0]
        assert after["alerts"][1]["delivery"] == "locally_persisted"
        assert supervisor.publication_status(after) == {
            "publication_unknown": 1, "monitoring_degraded": True}


@pytest.mark.parametrize("mode", FILENAMES)
def test_legacy_pending_events_are_held_without_guessing_the_previous_outcome(mode):
    with tempfile.TemporaryDirectory(prefix="monitor-legacy-") as temporary:
        legacy = event()
        del legacy["publication"]
        path = seed(Path(temporary), mode, [legacy, event(2)])
        calls = []

        def emit(item):
            calls.append(item["event_id"])
            return {"published": True, "file": "event.json"}

        result = cycle(mode, path.parent, emit)
        assert calls == [event(2)["event_id"]]
        assert result["alerts"][0]["delivery"] == "publication_unknown"
        assert result["alerts"][1]["delivery"] == "locally_persisted"


@pytest.mark.parametrize("receipt", [None, {"published": False}, {"published": True, "file": "x" * 256}])
def test_ambiguous_adapter_outcome_is_not_retried(receipt):
    with tempfile.TemporaryDirectory(prefix="monitor-outcome-") as temporary:
        path = seed(Path(temporary), "service", [event()])
        calls = []

        def emit(item):
            calls.append(item["event_id"])
            return receipt

        cycle("service", path.parent, emit)
        result = cycle("service", path.parent, emit)
        assert calls == [event()["event_id"]]
        assert result["alerts"][0]["delivery"] == "publication_unknown"


@pytest.mark.parametrize("status,expected", [("pending", "locally_persisted"),
    ("quarantined", "locally_persisted"), ("dead_lettered", "locally_persisted"),
    ("unobserved", "publication_unknown"), ("sent", "channel_delivered"),
    ("email_delivered", "channel_delivered")])
@settings(max_examples=4, deadline=5000)
@example(audit_text="proof")
@example(audit_text="")
@example(audit_text=" \t")
@given(audit_text=st.text(alphabet="abé\\\" \t", max_size=64))
def test_only_positive_receipt_evidence_resolves_the_hold(status, expected, audit_text):
    supervisor = load("publication_recovery_receipts", "fleet/reliability_supervisor.py")
    item = {**event(), "delivery": "publication_unknown"}
    payload = json.dumps({item["event_id"]: {"status": status, "audit_receipt": audit_text}})
    config = {"delivery_command": [sys.executable, "-c", "print(" + repr(payload) + ")"]}
    failures = supervisor.resolve_alert_delivery(config, [item])
    if expected == "channel_delivered" and not audit_text.strip():
        assert failures == [{"code": "invalid_output", "returncode": None}]
        assert item == {**event(), "delivery": "publication_unknown"}
    else:
        assert failures == []
        assert item["delivery"] == expected


@pytest.mark.parametrize("mode", FILENAMES)
def test_real_writer_persists_other_delivery_retries_while_publication_is_held(mode):
    with tempfile.TemporaryDirectory(prefix="monitor-reconciliation-") as temporary:
        root = Path(temporary)
        path = seed(root, mode, [event(3)])
        supervisor = load("publication_recovery_mixed", "fleet/reliability_supervisor.py")
        state = supervisor.read_private(path)
        state["alerts"] = [{**event(), "delivery": "publication_unknown"},
                           {**event(2), "delivery": "locally_persisted", "published_at": 100}]
        supervisor.write_private(path, state)
        responses = path.parent / "test-receipts.json"
        responses.write_text("{}")
        outbox = root / "transport" / "outbox"
        env = {**os.environ, "BOT_ERRORS_STATE_DIR": str(outbox.parent),
               "BOT_ERRORS_OUTBOX_DIR": str(outbox), "BOT_ERRORS_INLINE_LOG_TAIL": "0",
               "PYTHONDONTWRITEBYTECODE": "1"}
        for expected in ["locally_persisted", "channel_delivered"]:
            child = subprocess.run([sys.executable, __file__, mode, str(path.parent), "reconcile"],
                                   env=env, capture_output=True, text=True, timeout=30)
            assert child.returncode == 0, child.stderr
            saved = supervisor.read_private(path)
            assert saved["pending_events"] == []
            assert [(a["event_id"], a["delivery"]) for a in saved["alerts"]] == [
                (event()["event_id"], "publication_unknown"),
                (event(2)["event_id"], expected),
                (event(3)["event_id"], "locally_persisted")]
            responses.write_text(json.dumps({event(2)["event_id"]: {
                "status": "sent", "audit_receipt": "confirmed-delivery"}}))
        assert [json.loads(p.read_text())["id"] for p in outbox.glob("*.json")] == [event(3)["event_id"]]
        requests = [json.loads(line) for line in (path.parent / "test-requests.jsonl").read_text().splitlines()]
        assert requests == [[event()["event_id"], event(2)["event_id"]],
                            [event()["event_id"], event(2)["event_id"], event(3)["event_id"]]]
        assert saved["alerts"][1]["delivery_receipt"]["audit_receipt"] == "confirmed-delivery"


if __name__ == "__main__":
    mode, directory, crash_point = sys.argv[1:]
    supervisor = load("publication_recovery_child", "fleet/reliability_supervisor.py")

    def emit(item):
        if crash_point == "before_emit":
            os._exit(73)
        result = supervisor.publish_event({"instance": "synthetic", "emitter_command": [
            sys.executable, str(SCRIPTS / "bot-errors-emit.py")]}, item)
        assert result["published"], result
        if crash_point == "after_emit":
            os._exit(73)
        return result

    delivery_command = None
    if crash_point == "reconcile":
        code = (
            "import pathlib,json,sys; "
            f"p=pathlib.Path({directory!r}); "
            "f=(p/'test-requests.jsonl').open('a'); f.write(json.dumps(sys.argv[1:])+'\\n'); f.close(); "
            "print((p/'test-receipts.json').read_text())"
        )
        delivery_command = [sys.executable, "-c", code]
    cycle(mode, Path(directory), emit, delivery_command=delivery_command)
