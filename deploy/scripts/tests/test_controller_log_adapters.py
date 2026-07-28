from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
from types import ModuleType

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_ROOT))

from lib.controller_log import ControllerLogContext


def load_script(filename: str) -> ModuleType:
    module_name = f"controller_log_adapter_{filename.replace('-', '_').replace('.', '_')}"
    spec = importlib.util.spec_from_file_location(module_name, _SCRIPT_ROOT / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def deterministic_context(component: str) -> ControllerLogContext:
    ids = iter((f"{component}-run", f"{component}-bootstrap", f"{component}-cycle"))
    context = ControllerLogContext(
        component,
        now=lambda: "2026-07-28T12:00:00Z",
        id_factory=lambda: next(ids),
    )
    context.begin_cycle()
    return context


def assert_v1(record: dict, component: str, record_kind: str) -> None:
    assert record["schemaVersion"] == 1
    assert record["component"] == component
    assert record["recordKind"] == record_kind
    assert record["type"] == record_kind
    assert record["runId"] == f"{component}-run"
    assert record["cycleId"] == f"{component}-cycle"
    assert record["durabilityClass"] == "diagnostic_best_effort"
    assert "kind" not in record
    assert "ts" not in record
    assert set(record["details"]).isdisjoint(
        {"eventId", "incident_key", "path", "error", "body", "sender", "remote"}
    )


def test_five_controller_adapters_emit_one_envelope(monkeypatch, tmp_path: Path) -> None:
    cases = [
        ("bot-errors-q-loop.py", "q_loop", "log_event", ("poll_failed", {"error": "private", "count": 1})),
        (
            "bot-errors-heartbeat-watchdog.py",
            "heartbeat_watchdog",
            "append_log",
            ("recovery_pending", {"source": "private", "count": 2}),
        ),
        (
            "bot-errors-collector.py",
            "collector",
            "append_log",
            ({"type": "relay_failed", "remote": "private", "failed": 3},),
        ),
        (
            "bot-errors-health-check.py",
            "deadman",
            "append_deadman_log",
            ({"type": "deadman_recovery", "incident_key": "private", "suppressed": 4},),
        ),
    ]

    for filename, component, function_name, args in cases:
        module = load_script(filename)
        module.CONTROLLER_LOG_CONTEXT = deterministic_context(component)
        captured = []
        monkeypatch.setattr(module, "append_private_jsonl", lambda path, record: captured.append((path, record)))
        getattr(module, function_name)(*args)
        assert len(captured) == 1
        assert_v1(captured[0][1], component, args[0] if isinstance(args[0], str) else args[0]["type"])

    dispatcher = load_script("bot-errors-dispatcher.py")
    dispatcher.CONTROLLER_LOG_CONTEXT = deterministic_context("dispatcher")
    captured = []
    monkeypatch.setattr(dispatcher, "append_private_jsonl", lambda path, record: captured.append((path, record)))
    paths = {"logs": tmp_path}
    dispatcher.append_dispatch_log(
        paths,
        {
            "type": "sent",
            "eventId": "private",
            "path": "/private",
            "attempts": 2,
        },
    )
    assert len(captured) == 1
    assert_v1(captured[0][1], "dispatcher", "sent")
    assert captured[0][1]["details"] == {"attempts": 2}


def test_q_loop_activity_log_is_metadata_only(monkeypatch) -> None:
    module = load_script("bot-errors-q-loop.py")
    module.CONTROLLER_LOG_CONTEXT = deterministic_context("q_loop")
    captured = []
    monkeypatch.setattr(module, "append_private_jsonl", lambda path, record: captured.append(record))

    module.append_activity(
        {
            "pk": 123,
            "role": "q",
            "sender": "private sender",
            "body": "private message body",
        }
    )

    assert len(captured) == 1
    assert_v1(captured[0], "q_loop", "activity_observed")
    assert captured[0]["details"] == {
        "bodyLengthBucket": "1_64",
        "role": "q",
    }


def test_deadman_saves_recovery_before_diagnostic_append(monkeypatch, tmp_path: Path) -> None:
    module = load_script("bot-errors-health-check.py")
    (tmp_path / "dispatcher-state.json").write_text("{}")
    socket_path = tmp_path / "socket"
    socket_path.write_text("")
    module.SOCKET_PATH = str(socket_path)
    monkeypatch.setattr(module, "state_root", lambda: tmp_path)
    monkeypatch.setattr(module, "service_is_active", lambda _service: "active")
    monkeypatch.setattr(module, "service_restart_ages", lambda _service: (600, 600))
    monkeypatch.setattr(module, "current_epoch", lambda: 1_000)

    state = {
        "schemaVersion": 1,
        "incidents": {
            "synthetic": {
                "status": "open",
                "problems": [],
                "suppressed": 0,
            }
        },
    }
    monkeypatch.setattr(module, "load_deadman_state", lambda: state)
    events = []

    def save_deadman_state(_state: dict) -> None:
        events.append("save")

    def fail_diagnostic_append(_path: Path, record: dict) -> None:
        events.append(f"log:{record['recordKind']}")
        raise OSError("private diagnostic failure")

    monkeypatch.setattr(module, "save_deadman_state", save_deadman_state)
    monkeypatch.setattr(module, "append_private_jsonl", fail_diagnostic_append)
    monkeypatch.setattr(module, "controller_log_fallback", lambda line: events.append("fallback"))
    monkeypatch.setattr(module, "send_direct", lambda _text: events.append("send"))

    assert module.deadman(max_state_age=180, restart_grace=30, cooldown_seconds=300) == 0
    assert state["incidents"]["synthetic"]["status"] == "resolved"
    assert events.index("send") < events.index("save") < events.index("log:deadman_recovery")

    assert module.deadman(max_state_age=180, restart_grace=30, cooldown_seconds=300) == 0
    assert events.count("send") == 1


def test_identical_append_failure_policy_across_all_five_adapters(
    monkeypatch,
    tmp_path: Path,
) -> None:
    cases = [
        ("bot-errors-q-loop.py", "q_loop", "log_event", ("poll_failed", {"count": 1})),
        (
            "bot-errors-heartbeat-watchdog.py",
            "heartbeat_watchdog",
            "append_log",
            ("recovery_pending", {"count": 1}),
        ),
        (
            "bot-errors-collector.py",
            "collector",
            "append_log",
            ({"type": "relay_failed", "failed": 1},),
        ),
        (
            "bot-errors-health-check.py",
            "deadman",
            "append_deadman_log",
            ({"type": "deadman_recovery", "suppressed": 1},),
        ),
    ]

    for filename, component, function_name, args in cases:
        module = load_script(filename)
        module.CONTROLLER_LOG_CONTEXT = deterministic_context(component)
        health = []
        fallback = []
        monkeypatch.setattr(
            module,
            "append_private_jsonl",
            lambda _path, _record: (_ for _ in ()).throw(PermissionError("private")),
        )
        monkeypatch.setattr(module, "persist_controller_log_health", health.append)
        monkeypatch.setattr(module, "controller_log_fallback", fallback.append)
        assert getattr(module, function_name)(*args) == "diagnostic_degraded"
        assert health[-1]["status"] == "degraded"
        assert health[-1]["failureClass"] == "permission_denied"
        assert len(fallback) == 1

    dispatcher = load_script("bot-errors-dispatcher.py")
    dispatcher.CONTROLLER_LOG_CONTEXT = deterministic_context("dispatcher")
    health = []
    fallback = []
    monkeypatch.setattr(
        dispatcher,
        "append_private_jsonl",
        lambda _path, _record: (_ for _ in ()).throw(PermissionError("private")),
    )
    monkeypatch.setattr(
        dispatcher,
        "persist_controller_log_health",
        lambda _paths, record: health.append(record),
    )
    monkeypatch.setattr(dispatcher, "controller_log_fallback", fallback.append)
    assert dispatcher.append_dispatch_log(
        {"root": tmp_path, "logs": tmp_path},
        {"type": "sent", "attempts": 1},
    ) == "diagnostic_degraded"
    assert health[-1]["status"] == "degraded"
    assert health[-1]["failureClass"] == "permission_denied"
    assert len(fallback) == 1


def test_dispatcher_sink_health_receipt_lands_on_a_real_filesystem(tmp_path: Path) -> None:
    """The dispatcher's sink-health receipt must actually be writable.

    Regression: `persist_controller_log_health` writes into a
    `controller-log-health/` directory that `setup_dirs()` does not create, and
    the dispatcher's `atomic_write_json` opened the temp file with
    O_CREAT|O_EXCL without first ensuring the parent — so every receipt raised
    FileNotFoundError and the compensating control silently did not exist.

    This test deliberately does NOT monkeypatch the writer. The sibling tests in
    this file patch `append_private_jsonl`, which is why they stayed green while
    the real write path could not run. Exercising the real filesystem is the
    whole point.
    """
    dispatcher = load_script("bot-errors-dispatcher.py")

    # Exactly the directories setup_dirs() pre-creates — controller-log-health
    # is deliberately absent, which is the production shape.
    for name in (
        "quarantine",
        "testleak",
        "writefail_recovered",
        "writefail_quarantine",
        "locks",
        "logs",
        "dead_letter",
    ):
        (tmp_path / name).mkdir(parents=True, exist_ok=True)

    receipt = tmp_path / "controller-log-health" / "dispatcher.json"
    assert not receipt.parent.exists()

    dispatcher.persist_controller_log_health({"root": tmp_path}, {"ok": True})

    assert receipt.exists(), "sink-health receipt was not written"
    # The private-mode contract must hold for the directory this now creates.
    assert oct(receipt.parent.stat().st_mode & 0o777) == "0o700"
    assert oct(receipt.stat().st_mode & 0o777) == "0o600"
