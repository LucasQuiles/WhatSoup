import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from hypothesis import given, strategies as st


SCRIPT = Path(__file__).resolve().parents[1] / "reliability_supervisor.py"


def load_module():
    spec = importlib.util.spec_from_file_location("reliability_supervisor", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@given(audit=st.one_of(st.none(), st.booleans(), st.integers(), st.lists(st.text())))
def test_unaudited_success_does_not_partially_update_a_delivery_batch(audit):
    supervisor = load_module()
    identifiers = [f"00000000-0000-4000-8000-{index:012d}" for index in range(2)]
    receipts = {
        identifiers[0]: {"status": "sent", "audit_receipt": "valid-receipt"},
        identifiers[1]: {"status": "email_delivered", "audit_receipt": audit},
    }
    code = "import sys; sys.stdout.write(" + repr(json.dumps(receipts)) + ")"
    alerts = [{"event_id": identifier, "delivery": "published"} for identifier in identifiers]
    assert supervisor.resolve_alert_delivery({"delivery_command": [sys.executable, "-c", code]}, alerts) == [
        {"code": "invalid_output", "returncode": None}
    ]
    assert alerts == [{"event_id": identifier, "delivery": "published"} for identifier in identifiers]


def test_missing_audit_receipt_cannot_claim_delivery():
    supervisor = load_module()
    identifier = "00000000-0000-4000-8000-000000000032"
    code = "import sys; sys.stdout.write(" + repr(json.dumps({identifier: {"status": "sent"}})) + ")"
    alert = {"event_id": identifier, "delivery": "published"}
    assert supervisor.resolve_alert_delivery({"delivery_command": [sys.executable, "-c", code]}, [alert]) == [
        {"code": "invalid_output", "returncode": None}
    ]
    assert alert == {"event_id": identifier, "delivery": "published"}


@pytest.mark.parametrize("status", ["sent", "email_delivered"])
@pytest.mark.parametrize("extra_bytes", [0, 1])
def test_receipt_storage_budget_preserves_exact_evidence_or_refuses_whole_batch(status, extra_bytes):
    supervisor = load_module()
    identifiers = [f"00000000-0000-4000-8000-{index:012d}" for index in range(2)]
    receipt = {"status": status, "audit_receipt": "", "sent_at": "é\n😀", "extension": [True, 3]}
    overhead = len(json.dumps(receipt, sort_keys=True).encode())
    receipt["audit_receipt"] = "a" * (4096 - overhead + extra_bytes)
    receipts = {identifiers[0]: {"status": "sent", "audit_receipt": "short"}, identifiers[1]: receipt}
    code = "import sys; sys.stdout.write(" + repr(json.dumps(receipts)) + ")"
    alerts = [{"event_id": identifier, "delivery": "published"} for identifier in identifiers]
    failures = supervisor.resolve_alert_delivery({"delivery_command": [sys.executable, "-c", code]}, alerts)
    if extra_bytes:
        assert failures == [{"code": "invalid_output", "returncode": None}]
        assert alerts == [{"event_id": identifier, "delivery": "published"} for identifier in identifiers]
    else:
        assert failures == []
        assert alerts[1]["delivery_receipt"] == receipt
        assert all(alert["delivery"] == "channel_delivered" for alert in alerts)


def test_nonfinite_receipt_metadata_cannot_poison_saved_state():
    supervisor = load_module()
    identifier = "00000000-0000-4000-8000-000000000034"
    receipt = {"status": "sent", "audit_receipt": "valid-receipt", "sent_at": float("nan")}
    code = "import sys; sys.stdout.write(" + repr(json.dumps({identifier: receipt})) + ")"
    alert = {"event_id": identifier, "delivery": "published"}
    assert supervisor.resolve_alert_delivery({"delivery_command": [sys.executable, "-c", code]}, [alert]) == [
        {"code": "invalid_output", "returncode": None}
    ]
    assert alert == {"event_id": identifier, "delivery": "published"}


@pytest.mark.parametrize("receipt_bytes, cycles", [(4096, 128), (40000, 30)])
def test_repeated_delivery_receipts_leave_readable_state(tmp_path, monkeypatch, receipt_bytes, cycles):
    supervisor = load_module()
    receipt = {"status": "sent", "audit_receipt": ""}
    receipt["audit_receipt"] = "a" * (receipt_bytes - len(json.dumps(receipt, sort_keys=True).encode()))

    def command(arguments, timeout, *, max_stdout):
        output = json.dumps({arguments[-1]: receipt}).encode()
        assert len(output) <= max_stdout
        return subprocess.CompletedProcess(arguments, 0, output, b"")

    monkeypatch.setattr(supervisor, "run_command", command)
    state = {"schema_version": 1, "alerts": []}
    path = tmp_path / "state.json"
    for index in range(cycles):
        alert = {"event_id": f"00000000-0000-4000-8000-{index:012d}", "published_at": 100, "delivery": "published"}
        failure = supervisor.resolve_alert_delivery({"delivery_command": ["synthetic"]}, [alert])
        if receipt_bytes > 4096:
            assert failure == [{"code": "invalid_output", "returncode": None}]
            assert alert["delivery"] == "published"
            assert "delivery_receipt" not in alert
        else:
            assert failure == []
            assert alert["delivery_receipt"] == receipt
        state["alerts"].append(alert)
        state["alerts"], dropped = supervisor.retain_alerts(state["alerts"], 101)
        assert dropped == 0
        supervisor.write_private(path, state)
        assert supervisor.read_private(path) == state
    assert len(state["alerts"]) == cycles
    assert path.stat().st_size < 600000


@given(status=st.one_of(st.lists(st.integers()), st.dictionaries(st.text(), st.integers())))
def test_non_string_receipt_status_stays_unresolved(status):
    supervisor = load_module()
    identifier = "00000000-0000-4000-8000-000000000033"
    code = "import sys; sys.stdout.write(" + repr(json.dumps({identifier: {"status": status}})) + ")"
    alert = {"event_id": identifier, "delivery": "published"}
    assert supervisor.resolve_alert_delivery({"delivery_command": [sys.executable, "-c", code]}, [alert]) == []
    assert alert == {"event_id": identifier, "delivery": "published"}


@pytest.mark.parametrize("descriptor", [1, 2], ids=["stdout", "stderr"])
def test_command_output_limit_stops_and_reaps_child(tmp_path, monkeypatch, descriptor):
    supervisor = load_module()
    completed = tmp_path / "all-output-written"
    command = [sys.executable, "-c", """
import os, pathlib, sys
for _ in range(64):
    os.write(int(sys.argv[1]), b'x' * 65536)
pathlib.Path(sys.argv[2]).write_text('completed')
""", str(descriptor), str(completed)]
    started = []
    original = subprocess.Popen

    def spawn(*args, **kwargs):
        process = original(*args, **kwargs)
        started.append(process)
        return process

    monkeypatch.setattr(subprocess, "Popen", spawn)
    with pytest.raises(supervisor.StateError, match="output_oversized"):
        supervisor.run_command(command, 5)
    assert not completed.exists()
    assert len(started) == 1 and started[0].returncode is not None
    assert started[0].stdout.closed and started[0].stderr.closed


def test_command_preserves_one_mib_stdout_and_both_pipe_bytes():
    supervisor = load_module()
    command = [sys.executable, "-c", """
import os
for _ in range(256):
    os.write(1, b'o' * 4096)
    os.write(2, b'e' * 256)
raise SystemExit(7)
"""]
    result = supervisor.run_command(command, 5)
    assert result.returncode == 7
    assert result.stdout == b'o' * (1024 * 1024)
    assert result.stderr == b'e' * 65536


@pytest.mark.parametrize("close_pipes", [False, True])
def test_command_timeout_reaps_direct_child_and_closes_pipes(monkeypatch, close_pipes):
    supervisor = load_module()
    code = "import os, time; " + ("os.close(1); os.close(2); " if close_pipes else "") + "time.sleep(15)"
    started = []
    original = subprocess.Popen

    def spawn(*args, **kwargs):
        process = original(*args, **kwargs)
        started.append(process)
        return process

    monkeypatch.setattr(subprocess, "Popen", spawn)
    with pytest.raises(subprocess.TimeoutExpired):
        supervisor.run_command([sys.executable, "-c", code], 0.3)
    assert len(started) == 1 and started[0].returncode is not None
    assert started[0].stdout.closed and started[0].stderr.closed


def test_publishing_oversized_output_retains_failure_without_raw_bytes(tmp_path):
    supervisor = load_module()
    marker = tmp_path / "all-output-written"
    command = [sys.executable, "-c", """
import os, pathlib, sys
for _ in range(64):
    os.write(2, b'private-diagnostic-' * 4096)
pathlib.Path(sys.argv[1]).write_text('completed')
print('/synthetic/accepted.json')
""", str(marker)]
    result = supervisor.publish_event({"emitter_command": command, "instance": "synthetic"}, {
        "kind": "alert", "reason": "synthetic_failure", "event_id": "synthetic-event", "incident_id": "synthetic-incident",
    })
    assert result == {"published": False}
    assert not marker.exists()


@pytest.mark.parametrize("descriptor", [1, 2], ids=["stdout", "stderr"])
def test_delivery_output_limit_keeps_alert_unresolved(tmp_path, descriptor):
    supervisor = load_module()
    marker = tmp_path / "all-output-written"
    identifier = "11111111-1111-1111-1111-111111111111"
    receipt = json.dumps({identifier: {"status": "sent", "audit_receipt": "synthetic"}})
    code = f"""import os, pathlib
for _ in range(64):
    os.write({descriptor}, b' ' * 65536)
pathlib.Path({str(marker)!r}).write_text('completed')
print({receipt!r})
"""
    alert = {"event_id": identifier, "delivery": "pending"}
    result = supervisor.resolve_alert_delivery({"delivery_command": [sys.executable, "-c", code]}, [alert])
    assert result == [{"code": "output_oversized", "returncode": None}]
    assert alert == {"event_id": identifier, "delivery": "pending"}
    assert not marker.exists()


@pytest.mark.parametrize("size", [65535, 65536])
def test_delivery_preserves_output_boundary(size):
    supervisor = load_module()
    identifier = "11111111-1111-1111-1111-111111111111"
    receipt = json.dumps({identifier: {"status": "sent", "audit_receipt": "synthetic"}})
    code = f"import os; raw={receipt.encode()!r}; os.write(1, raw+b' '*({size}-len(raw)))"
    alert = {"event_id": identifier, "delivery": "pending"}
    result = supervisor.resolve_alert_delivery({"delivery_command": [sys.executable, "-c", code]}, [alert])
    if size == 65535:
        assert result == []
        assert alert["delivery"] == "channel_delivered"
    else:
        assert result == [{"code": "output_oversized", "returncode": None}]
        assert alert["delivery"] == "pending"


@pytest.mark.parametrize("timeout", [0, -1, float("inf"), float("nan")])
def test_command_refuses_invalid_timeout_before_spawn(monkeypatch, timeout):
    supervisor = load_module()

    def refuse_spawn(*args, **kwargs):
        pytest.fail("invalid timeout started a child")

    monkeypatch.setattr(subprocess, "Popen", refuse_spawn)
    with pytest.raises(supervisor.StateError, match="command_timeout_invalid"):
        supervisor.run_command([sys.executable, "-c", "pass"], timeout)


@pytest.mark.parametrize("size", [1024 * 1024, 1024 * 1024 + 1])
def test_remote_observation_preserves_size_boundary_and_failure_code(size):
    supervisor = load_module()
    code = f"import os; os.write(1, b'{{}}'+b' '*({size}-2))"
    config = {"observe_command": [sys.executable, "-c", code]}
    if size == 1024 * 1024:
        assert supervisor.remote_observation(config) == {"delivery_resolution": []}
    else:
        with pytest.raises(supervisor.StateError, match="^remote_observation_failed$"):
            supervisor.remote_observation(config)


@pytest.fixture
def supervisor():
    return load_module()


@pytest.fixture
def config(tmp_path):
    return {
        "state_dir": str(tmp_path / "state"),
        "live_url": "http://127.0.0.1:10000/live",
        "instance": "test-bot",
        "controller_lock": str(tmp_path / "controller.lock"),
        "restart_command": ["/bin/false"],
        "emitter_command": ["/bin/false"],
        "startup_grace_seconds": 120,
        "legacy_sent_items_probe": True,
    }


def harness(supervisor, config, now, healthy, restarts, events, maintenance=False):
    return supervisor.run_once(
        config,
        now=now,
        probe=lambda url, timeout: {
            "ok": healthy,
            "code": "ok" if healthy else "timeout",
            "latency_ms": 1,
        },
        restart=lambda: restarts.append(now),
        emit=lambda event: (
            events.append(event) or {"published": True, "event_id": event["event_id"]}
        ),
        maintenance=lambda: maintenance,
    )


def test_running_but_hung_service_restarts_after_three_probes(supervisor, config):
    restarts, events = [], []
    for now in [0, 30, 60]:
        harness(supervisor, config, now, False, restarts, events)
    assert restarts == [60]
    assert len([e for e in events if e["kind"] == "alert"]) == 1
    harness(supervisor, config, 90, False, restarts, events)
    assert restarts == [60]
    result = harness(supervisor, config, 100, True, restarts, events)
    assert result["consecutive_failures"] == 0
    assert [e["kind"] for e in events] == ["alert", "clear"]


def test_service_retains_undelivered_history_across_cycles(supervisor, config):
    directory = Path(config["state_dir"])
    supervisor.private_directory(directory)
    path = directory / "supervisor.json"
    waiting = _undelivered(0, 200)
    terminal = [
        {**item, "delivery": "channel_delivered"}
        for item in _undelivered(0, 200)
    ]
    state = supervisor.initial_state(0)
    state["alerts"] = waiting + terminal
    supervisor.write_private(path, state)
    restarts, events = [], []

    for now in (2 * 86400, 2 * 86400 + 60):
        result = harness(supervisor, config, now, True, restarts, events)
        assert result["alerts"] == waiting + terminal[-128:]
        assert supervisor.read_private(path)["alerts"] == result["alerts"]

    assert restarts == []
    assert events == []


def test_restart_budget_survives_supervisor_process_recreation(supervisor, config):
    restarts, events = [], []
    for now in [0, 30, 60, 181, 211, 241, 362, 392, 422, 452]:
        harness(supervisor, config, now, False, restarts, events)
    assert len(restarts) == 2
    harness(load_module(), config, 500, False, restarts, events)
    assert len(restarts) == 2
    assert any(e["reason"] == "restart_budget_exhausted" for e in events)


def test_maintenance_prevents_restart_without_claiming_recovery(supervisor, config):
    restarts, events = [], []
    for now in [0, 30, 60, 90]:
        state = harness(
            supervisor, config, now, False, restarts, events, maintenance=True
        )
    assert restarts == []
    assert state["liveness"]["ok"] is False
    assert state["maintenance"] is True
    assert not any(e["kind"] == "clear" for e in events)


def test_restart_reservation_is_durable_before_external_action(supervisor, config):
    restarts, events = [], []
    for now in [0, 30]:
        harness(supervisor, config, now, False, restarts, events)

    def crash_during_restart():
        state = json.loads((Path(config["state_dir"]) / "supervisor.json").read_text())
        assert state["restart_attempts"] == [60]
        raise RuntimeError("sensitive error must not be logged")

    state = supervisor.run_once(
        config,
        now=60,
        probe=lambda *_: {"ok": False, "code": "timeout", "latency_ms": 1},
        restart=crash_during_restart,
        emit=lambda e: {"published": True, "event_id": e["event_id"]},
        maintenance=lambda: False,
    )
    assert state["restart_result"] == "failed"
    assert "sensitive" not in json.dumps(state)


def test_unavailable_emitter_holds_incident_without_republication(supervisor, config):
    for now in [0, 30, 60]:
        state = supervisor.run_once(
            config,
            now=now,
            probe=lambda *_: {"ok": False, "code": "timeout", "latency_ms": 1},
            restart=lambda: None,
            emit=lambda _: {"published": False},
            maintenance=lambda: True,
        )
    held_id = state["alerts"][0]["event_id"]
    events = []
    state = harness(supervisor, config, 90, False, [], events, maintenance=True)
    assert events == []
    assert state["pending_events"] == []
    assert state["alerts"][0]["event_id"] == held_id
    assert state["alerts"][0]["delivery"] == "publication_unknown"


def test_corrupt_state_cannot_reset_restart_budget(supervisor, config):
    directory = Path(config["state_dir"])
    directory.mkdir(mode=0o700)
    path = directory / "supervisor.json"
    path.write_text("broken")
    path.chmod(0o600)
    with pytest.raises(supervisor.StateError):
        harness(supervisor, config, 100, False, [], [])
    assert path.read_text() == "broken"


def test_status_reports_stale_heartbeat_and_does_not_expose_payloads(
    supervisor, config
):
    harness(supervisor, config, 100, True, [], [])
    status = supervisor.observe(config, now=201)
    assert status["supervisor"]["status"] == "stale"
    assert "restart_command" not in json.dumps(status)


def test_health_body_and_deadline_are_real_http_checks(supervisor):
    import http.server
    import threading
    import time

    # /stall holds the request open until the test is done, so the probe's
    # own socket timeout is what ends it.
    stall_released = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/stall":
                stall_released.wait(5)
                return
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status":"degraded"}')

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        assert supervisor.probe_liveness(base + "/live", 0.1)["ok"] is False
        started = time.monotonic()
        assert supervisor.probe_liveness(base + "/stall", 0.1)["code"] == "timeout"
        assert time.monotonic() - started < 0.3
    finally:
        stall_released.set()
        server.shutdown()
        server.server_close()


def test_state_files_are_private(supervisor, config):
    harness(supervisor, config, 100, True, [], [])
    path = Path(config["state_dir"]) / "supervisor.json"
    assert os.stat(path).st_mode & 0o777 == 0o600


@pytest.mark.parametrize("truncated", [False, True], ids=["complete", "truncated-chunk"])
def test_liveness_handles_a_truncated_chunked_response(supervisor, truncated):
    import http.server
    import threading

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            if truncated:
                self.wfile.write(b"20\r\n{\"status\":")
            else:
                body = b'{"status":"ok"}'
                self.wfile.write(f"{len(body):x}\r\n".encode() + body + b"\r\n0\r\n\r\n")
            self.wfile.flush()
            self.close_connection = True

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        result = supervisor.probe_liveness(f"http://127.0.0.1:{server.server_port}/live", 1)
        assert result["ok"] is (not truncated)
        assert result["code"] == ("invalid_response" if truncated else "ok")
        assert result["latency_ms"] >= 0
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize("reset", [False, True], ids=["complete", "body-read-reset"])
def test_liveness_handles_a_reset_during_response_read(supervisor, reset, monkeypatch):
    import http.client
    import socket
    import socketserver
    import struct
    import threading

    reading_body = threading.Event()
    read = http.client.HTTPResponse.read

    def read_body(response, amount=None):
        reading_body.set()
        return read(response, amount)

    monkeypatch.setattr(http.client.HTTPResponse, "read", read_body)

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.settimeout(2)
            self.request.recv(8192)
            body = b'{"status":"ok"}'
            length = 8192 if reset else len(body)
            self.request.sendall(
                b"HTTP/1.1 200 OK\r\nContent-Length: " + str(length).encode()
                + b"\r\nConnection: close\r\n\r\n" + body
            )
            if reset:
                # Synchronize the real socket reset with body reading, not a timer.
                assert reading_body.wait(timeout=2)
                self.request.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                # TCPServer otherwise calls shutdown(SHUT_WR), which can deliver EOF first.
                self.request.close()

    with socketserver.TCPServer(("127.0.0.1", 0), Handler) as server:
        server.timeout = 2
        thread = threading.Thread(target=server.handle_request)
        thread.start()
        try:
            result = supervisor.probe_liveness(f"http://127.0.0.1:{server.server_address[1]}/live", 2)
            assert reading_body.is_set()
            assert result["ok"] is (not reset)
            assert result["code"] == ("unavailable" if reset else "ok")
        finally:
            thread.join(timeout=3)
            assert not thread.is_alive()


def test_budget_alert_also_clears_when_broker_recovers(supervisor, config):
    events = []
    for now in [0, 30, 60, 181, 211, 241, 362, 392, 422]:
        harness(supervisor, config, now, False, [], events)
    harness(supervisor, config, 450, True, [], events)
    assert any(
        e["reason"] == "restart_budget_exhausted" and e["kind"] == "clear"
        for e in events
    )


def test_capability_failure_does_not_restart_live_broker(supervisor, config):
    restarts = []
    for now in [0, 30, 60]:
        harness(supervisor, config, now, True, restarts, [])
    assert restarts == []
    snapshot = {
        "supervisor": {"status": "fresh"},
        "worker": {"status": "fresh", "unknownCount": 0, "oldestQueuedAgeMs": 0},
        "capabilities": {"status": "fresh", "token": {"ok": False}},
    }
    assert "token_unavailable" in supervisor.sentinel_conditions(snapshot)


def test_missing_monitor_and_blocked_mail_are_independent_signals(supervisor):
    snapshot = {
        "supervisor": {"status": "stale"},
        "worker": {"status": "fresh", "unknownCount": 1, "oldestQueuedAgeMs": 901000},
        "capabilities": {"status": "stale"},
    }
    assert set(supervisor.sentinel_conditions(snapshot)) == {
        "supervisor_stale",
        "capability_probe_stale",
        "mail_outcome_unknown",
        "mail_queue_blocked",
    }


def test_sentinel_deduplicates_and_clears_persisted_incident(supervisor, config):
    bad = {
        "supervisor": {"status": "stale"},
        "worker": {"status": "fresh"},
        "capabilities": {"status": "fresh", "token": {"ok": True}},
    }
    good = {**bad, "supervisor": {"status": "fresh"}}
    events = []

    def emit(event):
        events.append(event)
        return {"published": True}

    for now in [0, 60, 120]:
        supervisor.run_sentinel(config, now=now, observe_remote=lambda: bad, emit=emit)
    supervisor.run_sentinel(config, now=180, observe_remote=lambda: good, emit=emit)
    assert [(e["kind"], e["reason"]) for e in events] == [
        ("alert", "supervisor_stale"),
        ("clear", "supervisor_stale"),
    ]


@pytest.mark.parametrize("count", [1, 128])
def test_sentinel_stores_local_receipts_once_and_preserves_remote_input(supervisor, config, count):
    directory = Path(config["state_dir"])
    supervisor.private_directory(directory)
    path = directory / "sentinel.json"
    receipt = {"status": "sent", "audit_receipt": ""}
    receipt["audit_receipt"] = "a" * (4096 - len(json.dumps(receipt, sort_keys=True).encode()))
    alerts = [{"event_id": f"00000000-0000-4000-8000-{index:012d}", "published_at": 100,
               "delivery": "channel_delivered", "delivery_receipt": receipt} for index in range(count)]
    supervisor.write_private(path, {"incidents": {}, "counts": {}, "pending_events": [], "alerts": alerts})
    remote = {"supervisor": {"status": "fresh"}, "worker": {"status": "fresh"},
              "capabilities": {"status": "fresh", "token": {"ok": True}},
              "alerts": [{"event_id": "remote-alert", "published_at": 100, "delivery": "channel_delivered"}],
              "remote_extension": {"opaque": ["preserve", {"value": 7}]}}
    original = json.loads(json.dumps(remote))
    emitted = []
    for now in [101, 102, 103]:
        result = supervisor.run_sentinel(config, now=now, observe_remote=lambda: remote,
                                         emit=lambda event: emitted.append(event))
        assert result["alerts"] == alerts
        assert result["snapshot"]["alerts"] == original["alerts"]
        assert result["snapshot"]["remote_extension"] == original["remote_extension"]
        assert supervisor.read_private(path) == result
        assert path.stat().st_size < 600000
        assert remote == original
    assert emitted == []


@pytest.mark.parametrize(("stale_source", "remote_has_alerts"), [("local", True), ("local", False), ("remote", True)])
@pytest.mark.parametrize("observation_failure", ["unavailable", "exception"])
@given(uncertain_cycles=st.integers(min_value=1, max_value=8))
def test_sentinel_combined_delivery_view_preserves_detection_and_recovery(
    stale_source, remote_has_alerts, observation_failure, uncertain_cycles
):
    supervisor = load_module()
    with TemporaryDirectory() as directory:
        config = {"state_dir": str(Path(directory) / "state"), "instance": "test-bot"}
        supervisor.private_directory(config["state_dir"])
        path = Path(config["state_dir"]) / "sentinel.json"
        alert = {"event_id": "unresolved-original", "published_at": 0, "delivery": "locally_persisted"}
        supervisor.write_private(path, {"incidents": {}, "counts": {}, "pending_events": [],
                                        "alerts": [alert] if stale_source == "local" else []})
        remote = {"supervisor": {"status": "fresh"}, "worker": {"status": "fresh"},
                  "capabilities": {"status": "fresh", "token": {"ok": True}},
                  "alerts": [alert] if stale_source == "remote" else []}
        if not remote_has_alerts:
            del remote["alerts"]
        events = []

        def emit(event):
            events.append(event)
            return {"published": True}

        for now in [1000, 1060]:
            result = supervisor.run_sentinel(config, now=now, observe_remote=lambda: remote, emit=emit)
        assert "alert_delivery_stale" in result["incidents"]

        def failed_observation():
            if observation_failure == "exception":
                raise OSError("synthetic observation failure")
            return {"status": "unavailable"}

        for cycle in range(uncertain_cycles):
            unavailable = supervisor.run_sentinel(config, now=1070 + cycle * 10,
                observe_remote=failed_observation, emit=emit)
            assert "alert_delivery_stale" in unavailable["incidents"]
            assert unavailable["snapshot"]["status"] == "unavailable"
            assert not any(event["kind"] == "clear" and event["reason"] == "alert_delivery_stale"
                           for event in events)
        if stale_source == "local":
            state = supervisor.read_private(path)
            state["alerts"][0]["delivery"] = "channel_delivered"
            supervisor.write_private(path, state)
        else:
            remote["alerts"][0]["delivery"] = "channel_delivered"
        result = supervisor.run_sentinel(config, now=1070 + uncertain_cycles * 10,
            observe_remote=lambda: remote, emit=emit)
        assert "alert_delivery_stale" not in result["incidents"]
        if stale_source == "local":
            assert supervisor.read_private(path)["alerts"][0]["delivery"] == "channel_delivered"
        assert [(event["kind"], event["reason"]) for event in events
                if event["reason"] == "alert_delivery_stale"] == [
            ("alert", "alert_delivery_stale"), ("clear", "alert_delivery_stale")]


def test_collector_ack_is_not_channel_delivery(supervisor):
    snapshot = {
        "supervisor": {"status": "fresh"},
        "worker": {"status": "fresh"},
        "capabilities": {"status": "fresh", "token": {"ok": True}},
        "alerts": [
            {"event_id": "a", "published_at": 0, "delivery": "collector_acknowledged"}
        ],
    }
    assert "alert_delivery_stale" in supervisor.sentinel_conditions(snapshot, now=901)
    snapshot["alerts"][0]["delivery"] = "channel_delivered"
    assert "alert_delivery_stale" not in supervisor.sentinel_conditions(
        snapshot, now=901
    )


def test_sentinel_monitors_delivery_of_its_own_alerts(supervisor, config):
    bad = {
        "supervisor": {"status": "stale"},
        "worker": {"status": "fresh"},
        "capabilities": {"status": "fresh", "token": {"ok": True}},
    }
    good = {**bad, "supervisor": {"status": "fresh"}}
    events = []

    def emit(event):
        events.append(event)
        return {"published": True, "file": event["event_id"] + ".json"}

    for now in [0, 60]:
        supervisor.run_sentinel(config, now=now, observe_remote=lambda: bad, emit=emit)
    for now in [1000, 1060]:
        result = supervisor.run_sentinel(
            config, now=now, observe_remote=lambda: good, emit=emit
        )
    assert "alert_delivery_stale" in result["incidents"]


def test_capability_telemetry_does_not_include_response_or_token(
    supervisor, monkeypatch
):
    import io

    class Response(io.BytesIO):
        status = 200

    class Opener:
        def open(self, request, timeout):
            assert request.headers["Authorization"] == "Bearer private-token"
            return Response(b'{"private":"message contents"}')

    monkeypatch.setattr(supervisor.urllib.request, "build_opener", lambda *_: Opener())
    telemetry, payload = supervisor.capability_request(
        "http://127.0.0.1/test", "private-token"
    )
    assert telemetry["ok"] is True
    assert payload["private"] == "message contents"
    assert "private" not in json.dumps(telemetry)
    assert telemetry["request_id"]


def test_missing_keychain_is_recorded_as_failed_capability(supervisor, config):
    config["mcp_config"] = str(Path(config["state_dir"]).parent / "missing.json")
    result = supervisor.run_capabilities(config)
    assert result["token"]["ok"] is False
    assert result["failed_probes"] == 1
    assert result["completed_at"] >= result["started_at"]


@pytest.mark.parametrize("available", [False, True])
def test_legacy_capability_resolves_credentials_through_path(supervisor, config, tmp_path, monkeypatch, available):
    import subprocess

    mcp = tmp_path / "mcp.json"
    mcp.write_text(json.dumps({"mcpServers": {"microsoft_365": {"env": {
        "MS365_AGENT365_BASE_URL": "http://127.0.0.1:10000",
        "MS365_AGENT365_KEYCHAIN_SERVICE": "synthetic-service",
        "MS365_AGENT365_KEYCHAIN_ACCOUNT": "synthetic-account",
        "MS365_AGENT365_KEYCHAIN": str(tmp_path / "synthetic.keychain"),
    }}}}))
    config["mcp_config"] = str(mcp)
    lookups, calls = [], []

    def locate(name):
        lookups.append(name)
        return "/synthetic/bin/security" if available else None

    def command(argv, timeout):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 1, b"", b"credential unavailable")

    monkeypatch.setattr(shutil, "which", locate)
    monkeypatch.setattr(supervisor, "run_command", command)
    result = supervisor.run_capabilities(config)
    assert lookups == ["security"]
    assert [call[0] for call in calls] == (["/synthetic/bin/security"] if available else [])
    assert result["token"] == {"ok": False, "code": "credential_unavailable"}


def test_readiness_failure_is_reported_independently_of_working_token(supervisor):
    snapshot = {
        "supervisor": {"status": "fresh"},
        "worker": {"status": "fresh"},
        "capabilities": {
            "status": "fresh",
            "token": {"ok": True},
            "mail": {"ok": True},
            "readiness": {"ok": False, "http_status": 503},
        },
    }
    assert supervisor.sentinel_conditions(snapshot) == ["broker_not_ready"]


@pytest.mark.parametrize("uncertain", ["stale", "missing", "unreachable"])
@given(uncertain_cycles=st.integers(min_value=1, max_value=20))
def test_readiness_incident_needs_fresh_positive_recovery(
    uncertain, uncertain_cycles
):
    supervisor = load_module()
    with TemporaryDirectory() as directory:
        config = {"state_dir": str(Path(directory) / "state"), "instance": "test-bot"}
        bad = {
            "supervisor": {"status": "fresh"},
            "worker": {"status": "fresh"},
            "capabilities": {
                "status": "fresh",
                "token": {"ok": True},
                "readiness": {"ok": False},
            },
        }
        events = []

        def emit(event):
            events.append(event)
            return {"published": True}

        for now in [0, 60]:
            supervisor.run_sentinel(config, now=now, observe_remote=lambda: bad, emit=emit)

        def observe_uncertain():
            if uncertain == "unreachable":
                raise OSError("remote offline")
            return {
                **bad,
                "capabilities": {
                    "status": "stale" if uncertain == "stale" else "fresh",
                    "token": {"ok": True},
                },
            }

        for cycle in range(uncertain_cycles):
            result = supervisor.run_sentinel(
                config, now=120 + cycle * 60, observe_remote=observe_uncertain, emit=emit
            )
            assert "broker_not_ready" in result["incidents"]
            assert not any(e["kind"] == "clear" for e in events)
        good = {**bad, "capabilities": {**bad["capabilities"], "readiness": {"ok": True}}}
        result = supervisor.run_sentinel(
            config, now=120 + uncertain_cycles * 60, observe_remote=lambda: good, emit=emit
        )
        assert "broker_not_ready" not in result["incidents"]
        # Repeated unreachable observations may also open their own transport incident.
        assert [(e["kind"], e["reason"]) for e in events if e["reason"] == "broker_not_ready"] == [
            ("alert", "broker_not_ready"),
            ("clear", "broker_not_ready"),
        ]


@pytest.mark.parametrize(
    ("reason", "surface", "evidence"),
    [
        ("token_unavailable", "capabilities", {"token": {"ok": True}}),
        ("mail_capability_unavailable", "capabilities", {"mail": {"ok": True}}),
        ("mail_outcome_unknown", "worker", {"unknownCount": 0}),
        ("mail_queue_blocked", "worker", {"oldestQueuedAgeMs": 0}),
    ],
)
def test_dependency_recovery_rejects_stale_positive_evidence(
    supervisor, reason, surface, evidence
):
    assert not supervisor.recovery_confirmed(reason, {}, now=100)
    assert not supervisor.recovery_confirmed(
        reason, {surface: {"status": "stale", **evidence}}, now=100
    )
    assert supervisor.recovery_confirmed(
        reason, {surface: {"status": "fresh", **evidence}}, now=100
    )


def test_cached_token_expiry_jitter_does_not_count_as_renewal(supervisor):
    assert not supervisor.token_renewed("2026-09-18T16:00:00Z", "2026-09-18T16:00:01Z")
    assert not supervisor.token_renewed("2026-09-18T16:00:00Z", "2026-09-18T15:59:59Z")
    assert supervisor.token_renewed("2026-09-18T16:00:00Z", "2026-09-18T17:00:00Z")
    assert not supervisor.token_renewed(None, "2026-09-18T17:00:00Z")


def test_connection_reset_is_a_transport_failure(supervisor, monkeypatch):
    class Opener:
        def open(self, request, timeout):
            raise ConnectionResetError("private provider details")

    monkeypatch.setattr(supervisor.urllib.request, "build_opener", lambda *_: Opener())
    telemetry, payload = supervisor.capability_request(
        "http://127.0.0.1/test", "secret"
    )
    assert telemetry["code"] == "transport_error"
    assert telemetry["ok"] is False
    assert payload == {}
    assert "private" not in json.dumps(telemetry)


def test_failed_probe_retains_last_successful_expiry(supervisor, config):
    directory = Path(config["state_dir"])
    supervisor.private_directory(directory)
    supervisor.write_private(
        directory / "capabilities.json",
        {
            "token": {"ok": True, "expires_at": "2026-09-18T16:00:00Z"},
            "token_renewals_observed": 2,
        },
    )
    config["mcp_config"] = str(directory / "missing.json")
    result = supervisor.run_capabilities(config)
    assert result["last_successful_token_expiry"] == "2026-09-18T16:00:00Z"
    assert result["token_renewals_observed"] == 2


def test_restart_cannot_race_an_active_cutover_controller(
    supervisor, config, monkeypatch
):
    import fcntl

    lock = Path(config["controller_lock"])
    lock.touch(mode=0o600)
    with lock.open("r+") as owner:
        fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        monkeypatch.setattr(
            supervisor,
            "run_command",
            lambda *_: pytest.fail("restart raced maintenance"),
        )
        with pytest.raises(BlockingIOError):
            supervisor.restart_service(config)


def test_runtime_maintenance_lease_does_not_block_coordinated_restart(
    supervisor, config, monkeypatch
):
    import fcntl
    import hashlib
    import subprocess

    controller = Path(config["controller_lock"])
    controller.touch(mode=0o600)
    runtime_lock = controller.with_name("maintenance.lock")
    runtime_lock.touch(mode=0o600)
    plist = controller.with_name("service.plist")
    plist.write_bytes(b"pinned-plist")
    config.update(
        plist_path=str(plist),
        plist_sha256=hashlib.sha256(plist.read_bytes()).hexdigest(),
        service_target="gui/502/com.synthetic.service",
        expected_program="/verified/python",
    )
    calls = []

    def command(argv, timeout):
        assert supervisor.maintenance_active(controller) is True
        calls.append(argv)
        return subprocess.CompletedProcess(
            argv, 0, b"program = /verified/python\npid = 12\n", b""
        )

    monkeypatch.setattr(supervisor, "run_command", command)
    with runtime_lock.open("r+") as runtime:
        fcntl.flock(runtime, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = supervisor.restart_service(config)
    assert len(calls) == 3
    assert result["old_pid"] == 12


def _undelivered(now, count=1):
    from uuid import uuid4

    return [
        {
            "event_id": str(uuid4()),
            "kind": "alert",
            "reason": "supervisor_stale",
            "created_at": now,
            "published_at": now,
            "delivery": "locally_persisted",
        }
        for _ in range(count)
    ]


@pytest.mark.parametrize(
    ("returncode", "stdout", "code"),
    [
        (1, b"", "nonzero_exit"),
        (0, b"not json", "invalid_output"),
        (0, b"[]", "invalid_output"),
        (0, b"{" + b" " * 70000 + b"}", "output_oversized"),
    ],
    ids=["nonzero", "not-json", "not-object", "oversized"],
)
def test_delivery_resolution_failure_returns_code_without_ids_or_output(
    supervisor, monkeypatch, returncode, stdout, code
):
    import subprocess

    alerts = _undelivered(0)
    monkeypatch.setattr(
        supervisor,
        "run_command",
        lambda argv, timeout, *, max_stdout: subprocess.CompletedProcess(
            argv, returncode, stdout, b""
        ),
    )
    failures = supervisor.resolve_alert_delivery(
        {"delivery_command": ["/bin/true"]}, alerts
    )
    assert failures == [
        {"code": code, "returncode": returncode if code == "nonzero_exit" else None}
    ]
    assert alerts[0]["delivery"] == "locally_persisted"


def test_delivery_resolution_ignores_malformed_receipts(supervisor, monkeypatch):
    import subprocess

    alerts = _undelivered(0, 2)
    receipts = {
        alerts[0]["event_id"]: "sent",
        alerts[1]["event_id"]: {"status": "sent", "audit_receipt": "valid-receipt"},
    }
    monkeypatch.setattr(
        supervisor,
        "run_command",
        lambda argv, timeout, *, max_stdout: subprocess.CompletedProcess(
            argv, 0, json.dumps(receipts).encode(), b""
        ),
    )
    failures = supervisor.resolve_alert_delivery(
        {"delivery_command": ["/bin/true"]}, alerts
    )
    assert failures == []
    assert [a["delivery"] for a in alerts] == ["locally_persisted", "channel_delivered"]


def _delivery_stub(tmp_path, *, fail):
    stub = tmp_path / "delivery-stub.py"
    stub.write_text(
        "import json, sys\n"
        "ids = sys.argv[1:]\n"
        f"if len(ids) > 128 or {fail!r}:\n"
        "    raise SystemExit(3)\n"
        "print(json.dumps({i: {'status': 'sent', 'audit_receipt': 'valid-receipt'} for i in ids}))\n"
    )
    return [sys.executable, str(stub)]


def test_sentinel_pages_and_clears_delivery_resolution_failure(
    supervisor, config, tmp_path
):
    bad = {
        "supervisor": {"status": "stale"},
        "worker": {"status": "fresh"},
        "capabilities": {"status": "fresh", "token": {"ok": True}},
    }
    good = {**bad, "supervisor": {"status": "fresh"}}
    events = []

    def emit(event):
        events.append(event)
        return {"published": True}

    config["delivery_command"] = _delivery_stub(tmp_path, fail=True)
    for now in [0, 60]:
        supervisor.run_sentinel(config, now=now, observe_remote=lambda: bad, emit=emit)
    for now in [120, 180]:
        result = supervisor.run_sentinel(
            config, now=now, observe_remote=lambda: dict(good), emit=emit
        )
    assert "alert_delivery_unresolved" in result["incidents"]
    config["delivery_command"] = _delivery_stub(tmp_path, fail=False)
    result = supervisor.run_sentinel(
        config, now=240, observe_remote=lambda: dict(good), emit=emit
    )
    assert "alert_delivery_unresolved" not in result["incidents"]
    assert [
        e["kind"] for e in events if e["reason"] == "alert_delivery_unresolved"
    ] == ["alert", "clear"]


def test_sentinel_keeps_undelivered_alerts_past_128_and_counts_drops(
    supervisor, config
):
    directory = Path(config["state_dir"])
    supervisor.private_directory(directory)
    alerts = _undelivered(0, 200)
    supervisor.write_private(
        directory / "sentinel.json",
        {"incidents": {}, "counts": {}, "pending_events": [], "alerts": alerts},
    )
    good = {
        "supervisor": {"status": "fresh"},
        "worker": {"status": "fresh"},
        "capabilities": {"status": "fresh", "token": {"ok": True}},
    }
    result = supervisor.run_sentinel(
        config, now=60, observe_remote=lambda: good, emit=lambda _: {}
    )
    assert [a["event_id"] for a in result["alerts"]] == [a["event_id"] for a in alerts]
    assert result.get("delivery_dropped", {}).get("total", 0) == 0


def test_sentinel_failed_lookup_never_ages_out_undelivered_alerts(
    supervisor, config, tmp_path
):
    directory = Path(config["state_dir"])
    supervisor.private_directory(directory)
    alerts = _undelivered(0, 3)
    supervisor.write_private(
        directory / "sentinel.json",
        {"incidents": {}, "counts": {}, "pending_events": [], "alerts": alerts},
    )
    config["delivery_command"] = _delivery_stub(tmp_path, fail=True)
    good = {
        "supervisor": {"status": "fresh"},
        "worker": {"status": "fresh"},
        "capabilities": {"status": "fresh", "token": {"ok": True}},
    }
    result = supervisor.run_sentinel(
        config, now=2 * 86400, observe_remote=lambda: dict(good), emit=lambda _: {}
    )
    assert len(result["alerts"]) == 3
    assert "delivery_dropped" not in result


def test_only_storm_collapse_is_a_terminal_dispatcher_disposition(
    supervisor, monkeypatch
):
    import subprocess

    statuses = [
        "storm_collapsed",
        "quarantined",
        "test_leak_dropped",
        "dead_lettered",
        "unobserved",
    ]
    alerts = _undelivered(0, len(statuses))
    receipts = {a["event_id"]: {"status": s} for a, s in zip(alerts, statuses)}
    monkeypatch.setattr(
        supervisor,
        "run_command",
        lambda argv, timeout, *, max_stdout: subprocess.CompletedProcess(
            argv, 0, json.dumps(receipts).encode(), b""
        ),
    )
    assert (
        supervisor.resolve_alert_delivery({"delivery_command": ["/bin/true"]}, alerts)
        == []
    )
    # Quarantined, test-leak and dead-lettered alerts may have reached no one:
    # they stay undelivered, page as stale, and age out counted.
    assert [a["delivery"] for a in alerts] == [
        "dispatcher_collapsed",
        *["locally_persisted"] * 4,
    ]
    assert "dispatcher_collapsed" in supervisor.TERMINAL_DELIVERY
    assert "dispatcher_quarantined" not in supervisor.TERMINAL_DELIVERY


def test_quarantined_alert_stays_undelivered_and_pages_stale(supervisor, monkeypatch):
    # The dispatcher pages for only one envelope error code and throttles that
    # meta-alert, so a quarantined alert may have reached no one.
    import subprocess

    alerts = _undelivered(0)
    receipts = {alerts[0]["event_id"]: {"status": "quarantined"}}
    monkeypatch.setattr(
        supervisor,
        "run_command",
        lambda argv, timeout, *, max_stdout: subprocess.CompletedProcess(
            argv, 0, json.dumps(receipts).encode(), b""
        ),
    )
    supervisor.resolve_alert_delivery({"delivery_command": ["/bin/true"]}, alerts)
    assert alerts[0]["delivery"] not in supervisor.TERMINAL_DELIVERY
    assert "alert_delivery_stale" in supervisor.sentinel_conditions(
        {"alerts": alerts}, now=901
    )
