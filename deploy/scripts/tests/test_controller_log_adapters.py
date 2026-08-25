from __future__ import annotations

import ast
import importlib.util
from pathlib import Path
import sys
from types import ModuleType

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_ROOT))

from lib.controller_log import ControllerLogContext
from lib.bounded_jsonl import BoundedJsonlResult


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
        if filename == "bot-errors-heartbeat-watchdog.py":
            monkeypatch.setattr(
                module,
                "append_bounded_jsonl",
                lambda path, record, **_kwargs: captured.append((path, record)),
            )
            monkeypatch.setattr(
                module,
                "require_bounded_jsonl_commit",
                lambda _result: None,
            )
        else:
            monkeypatch.setattr(
                module,
                "append_private_jsonl",
                lambda path, record: captured.append((path, record)),
            )
        getattr(module, function_name)(*args)
        assert len(captured) == 1
        assert_v1(captured[0][1], component, args[0] if isinstance(args[0], str) else args[0]["type"])

    dispatcher = load_script("bot-errors-dispatcher.py")
    dispatcher.CONTROLLER_LOG_CONTEXT = deterministic_context("dispatcher")
    captured = []
    monkeypatch.setattr(
        dispatcher,
        "append_bounded_jsonl",
        lambda path, record, **_kwargs: captured.append((path, record)),
    )
    monkeypatch.setattr(dispatcher, "require_bounded_jsonl_commit", lambda _result: None)
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
        if filename == "bot-errors-heartbeat-watchdog.py":
            monkeypatch.setattr(
                module,
                "append_bounded_jsonl",
                lambda _path, _record, **_kwargs: (_ for _ in ()).throw(
                    PermissionError("private")
                ),
            )
        else:
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
        "append_bounded_jsonl",
        lambda _path, _record, **_kwargs: (_ for _ in ()).throw(PermissionError("private")),
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


def test_dispatcher_bounded_adapter_uses_one_exact_shared_publication(
    monkeypatch,
    tmp_path: Path,
) -> None:
    dispatcher = load_script("bot-errors-dispatcher.py")
    dispatcher.CONTROLLER_LOG_CONTEXT = deterministic_context("dispatcher")
    publication = object()
    calls = []
    consumed = []

    def append_bounded(path, record, *, component, max_bytes):
        calls.append({
            "path": path,
            "component": component,
            "max_bytes": max_bytes,
            "record_kind": record["recordKind"],
        })
        return publication

    monkeypatch.setattr(dispatcher, "append_bounded_jsonl", append_bounded, raising=False)
    monkeypatch.setattr(
        dispatcher,
        "require_bounded_jsonl_commit",
        consumed.append,
        raising=False,
    )
    monkeypatch.setattr(
        dispatcher,
        "append_private_jsonl",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("bounded dispatcher sink used append_private_jsonl")
        ),
    )

    result = dispatcher.append_dispatch_log(
        {"root": tmp_path, "logs": tmp_path},
        {"type": "sent", "attempts": 1},
    )

    assert result == "written"
    assert calls == [{
        "path": tmp_path / "dispatch.jsonl",
        "component": "dispatcher.dispatch_log",
        "max_bytes": dispatcher.MAX_DISPATCH_JSONL_BYTES,
        "record_kind": "sent",
    }]
    assert consumed == [publication]


def test_dispatcher_bounded_adapter_degrades_on_real_consumer_rejection(
    monkeypatch,
    tmp_path: Path,
) -> None:
    dispatcher = load_script("bot-errors-dispatcher.py")
    dispatcher.CONTROLLER_LOG_CONTEXT = deterministic_context("dispatcher")
    rejected = BoundedJsonlResult(
        component="dispatcher.dispatch_log",
        status="not_mutated",
        method="none",
        stage="lock",
        record_sha256="0" * 64,
        bytes_before=None,
        bytes_after=None,
        compacted=False,
        oversized_record=False,
        failure_class="lock_timeout",
    )
    monkeypatch.setattr(
        dispatcher,
        "append_bounded_jsonl",
        lambda *_args, **_kwargs: rejected,
        raising=False,
    )
    health = []
    fallback = []
    monkeypatch.setattr(
        dispatcher,
        "persist_controller_log_health",
        lambda _paths, record: health.append(record),
    )
    monkeypatch.setattr(dispatcher, "controller_log_fallback", fallback.append)

    result = dispatcher.append_dispatch_log(
        {"root": tmp_path, "logs": tmp_path},
        {"type": "sent", "attempts": 1},
    )

    assert result == "diagnostic_degraded"
    assert len(health) == 1
    assert health[0]["status"] == "degraded"
    assert health[0]["failureClass"] == "unexpected_error"
    assert len(fallback) == 1


def test_dispatcher_bounded_adapter_preserves_excluded_sinks_and_decorator_order() -> None:
    source = (_SCRIPT_ROOT / "bot-errors-dispatcher.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    functions = {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }

    run_once = functions["run_once"]
    decorator_text = "\n".join(ast.unparse(node) for node in run_once.decorator_list)
    assert "append_dispatch_log" in decorator_text
    run_once_text = ast.get_source_segment(source, run_once)
    assert run_once_text is not None
    assert run_once_text.index('paths["locks"] / "dispatcher.lock"') < run_once_text.index(
        "fcntl.flock"
    )

    state_projection = ast.get_source_segment(source, functions["project_dispatcher_state_mode"])
    assert state_projection is not None
    assert '"logs" / "dispatcher.jsonl"' in state_projection
    assert "append_private_jsonl(log_path, record)" in state_projection
    capture_functions = [
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and "append_private_jsonl(capture_path" in (ast.get_source_segment(source, node) or "")
    ]
    assert capture_functions == ["send_whatsapp"]

    bounded_callers = sorted({
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and any(
            isinstance(call, ast.Call)
            and isinstance(call.func, ast.Name)
            and call.func.id == "append_bounded_jsonl"
            for call in ast.walk(node)
        )
    })
    assert bounded_callers == ["append_dispatch_log"]


def test_watchdog_bounded_adapter_uses_one_exact_shared_publication(
    monkeypatch,
    tmp_path: Path,
) -> None:
    watchdog = load_script("bot-errors-heartbeat-watchdog.py")
    watchdog.CONTROLLER_LOG_CONTEXT = deterministic_context("heartbeat_watchdog")
    monkeypatch.setattr(watchdog, "state_root", lambda: tmp_path)
    publication = object()
    calls = []
    consumed = []

    def append_bounded(path, record, *, component, max_bytes):
        calls.append({
            "path": path,
            "component": component,
            "max_bytes": max_bytes,
            "record_kind": record["recordKind"],
        })
        return publication

    monkeypatch.setattr(watchdog, "append_bounded_jsonl", append_bounded, raising=False)
    monkeypatch.setattr(
        watchdog,
        "require_bounded_jsonl_commit",
        consumed.append,
        raising=False,
    )
    monkeypatch.setattr(
        watchdog,
        "append_private_jsonl",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("bounded watchdog sink used append_private_jsonl")
        ),
    )

    result = watchdog.append_log("recovery_pending", {"count": 1})

    assert result == "written"
    assert calls == [{
        "path": tmp_path / "logs" / "heartbeat-watchdog.jsonl",
        "component": "heartbeat_watchdog.heartbeat_log",
        "max_bytes": watchdog.MAX_HEARTBEAT_JSONL_BYTES,
        "record_kind": "recovery_pending",
    }]
    assert consumed == [publication]


def test_watchdog_bounded_adapter_degrades_on_real_consumer_rejection(
    monkeypatch,
    tmp_path: Path,
) -> None:
    watchdog = load_script("bot-errors-heartbeat-watchdog.py")
    watchdog.CONTROLLER_LOG_CONTEXT = deterministic_context("heartbeat_watchdog")
    monkeypatch.setattr(watchdog, "state_root", lambda: tmp_path)
    rejected = BoundedJsonlResult(
        component="heartbeat_watchdog.heartbeat_log",
        status="not_mutated",
        method="none",
        stage="lock",
        record_sha256="0" * 64,
        bytes_before=None,
        bytes_after=None,
        compacted=False,
        oversized_record=False,
        failure_class="lock_timeout",
    )
    monkeypatch.setattr(
        watchdog,
        "append_bounded_jsonl",
        lambda *_args, **_kwargs: rejected,
        raising=False,
    )
    health = []
    fallback = []
    monkeypatch.setattr(watchdog, "persist_controller_log_health", health.append)
    monkeypatch.setattr(watchdog, "controller_log_fallback", fallback.append)

    result = watchdog.append_log("recovery_pending", {"count": 1})

    assert result == "diagnostic_degraded"
    assert len(health) == 1
    assert health[0]["status"] == "degraded"
    assert health[0]["failureClass"] == "unexpected_error"
    assert len(fallback) == 1


def test_watchdog_bounded_adapter_preserves_state_sink_and_decorator_funnel() -> None:
    source = (_SCRIPT_ROOT / "bot-errors-heartbeat-watchdog.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    functions = {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }

    session = functions["open_watchdog_state_session"]
    decorator_text = "\n".join(ast.unparse(node) for node in session.decorator_list)
    assert "append_log" in decorator_text
    state_projection = ast.get_source_segment(source, functions["project_watchdog_state_mode"])
    assert state_projection is not None
    assert '"logs" / "watchdog.jsonl"' in state_projection
    assert "append_private_jsonl(log_path, record)" in state_projection

    bounded_callers = sorted({
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and any(
            isinstance(call, ast.Call)
            and isinstance(call.func, ast.Name)
            and call.func.id == "append_bounded_jsonl"
            for call in ast.walk(node)
        )
    })
    assert bounded_callers == ["append_log"]
