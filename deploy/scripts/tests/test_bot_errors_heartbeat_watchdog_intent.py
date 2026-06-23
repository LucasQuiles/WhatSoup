"""Planned-vs-crash service intent coverage for heartbeat watchdog services."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-heartbeat-watchdog.py"

_ENV_KEYS = [
    "BOT_ERRORS_WATCHDOG_INTENT_DETECTION",
    "BOT_ERRORS_RESTART_GRACE_SECONDS",
    "BOT_ERRORS_DRY_SERVICE_INTENT",
    "BOT_ERRORS_DRY_SERVICE_STATES",
]


@pytest.fixture(autouse=True)
def _clean_env():
    saved = {key: os.environ.get(key) for key in _ENV_KEYS}
    for key in _ENV_KEYS:
        os.environ.pop(key, None)
    yield
    for key, value in saved.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_watchdog_intent", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


_SERVICE = "sample-unit.service"


def _with_one_service(mod):
    mod.expected_local_services = lambda: [{"name": "line-alpha", "service": _SERVICE}]
    mod.health_profile_path = lambda: "/tmp/profile.json"


def test_classify_active_is_not_a_problem():
    mod = _load_module()

    cls, detail = mod.classify_service_intent(
        {"ActiveState": "active", "SubState": "running", "Result": "success"},
        45.0,
        100.0,
    )

    assert cls == "active"
    assert "ActiveState=active" in detail


def test_classify_clean_stop_is_planned():
    mod = _load_module()

    cls, detail = mod.classify_service_intent(
        {
            "ActiveState": "inactive",
            "SubState": "dead",
            "Result": "success",
            "ExecMainStatus": "0",
        },
        45.0,
        100.0,
    )

    assert cls == "planned"
    assert "clean stop" in detail


def test_classify_failed_is_crash():
    mod = _load_module()

    cls, detail = mod.classify_service_intent(
        {
            "ActiveState": "failed",
            "SubState": "failed",
            "Result": "exit-code",
            "ExecMainStatus": "1",
        },
        45.0,
        100.0,
    )

    assert cls == "crash"
    assert "Result=exit-code" in detail


def test_classify_unclean_inactive_is_crash():
    mod = _load_module()

    cls, detail = mod.classify_service_intent(
        {
            "ActiveState": "inactive",
            "SubState": "dead",
            "Result": "signal",
            "ExecMainStatus": "143",
        },
        45.0,
        100.0,
    )

    assert cls == "crash"
    assert "unclean stop" in detail or "Result=signal" in detail


def test_classify_oom_kill_result_is_crash():
    mod = _load_module()

    cls, _detail = mod.classify_service_intent(
        {"ActiveState": "inactive", "SubState": "dead", "Result": "oom-kill"},
        45.0,
        100.0,
    )

    assert cls == "crash"


def test_classify_activating_within_grace_holds():
    mod = _load_module()

    cls, detail = mod.classify_service_intent(
        {
            "ActiveState": "activating",
            "SubState": "start",
            "StateChangeTimestampMonotonic": "90000000",
        },
        45.0,
        100.0,
    )

    assert cls == "activating_grace"
    assert "restart in flight" in detail


def test_classify_activating_past_grace_is_crash():
    mod = _load_module()

    cls, detail = mod.classify_service_intent(
        {
            "ActiveState": "activating",
            "SubState": "start",
            "StateChangeTimestampMonotonic": "10000000",
        },
        45.0,
        100.0,
    )

    assert cls == "crash"
    assert "stalled" in detail


def test_classify_activating_unknown_elapsed_holds():
    mod = _load_module()

    cls, detail = mod.classify_service_intent(
        {"ActiveState": "activating", "SubState": "start"},
        45.0,
        100.0,
    )

    assert cls == "activating_grace"
    assert "elapsed=unknown" in detail


def test_classify_unknown_state_fails_closed_to_crash():
    mod = _load_module()

    cls, _detail = mod.classify_service_intent({"ActiveState": "", "Result": ""}, 45.0, 100.0)

    assert cls == "crash"


def test_classify_probe_error_fails_closed_to_crash():
    mod = _load_module()

    cls, detail = mod.classify_service_intent({"_showError": "failed to connect"}, 45.0, 100.0)

    assert cls == "crash"
    assert "probe_error" in detail


def test_activating_elapsed_parses_microseconds():
    mod = _load_module()

    assert mod.activating_elapsed_seconds(
        {"StateChangeTimestampMonotonic": "50000000"},
        100.0,
    ) == pytest.approx(50.0)


def test_activating_elapsed_missing_zero_or_garbage_is_none():
    mod = _load_module()

    assert mod.activating_elapsed_seconds({}, 100.0) is None
    assert mod.activating_elapsed_seconds({"StateChangeTimestampMonotonic": "0"}, 100.0) is None
    assert mod.activating_elapsed_seconds({"StateChangeTimestampMonotonic": "bad"}, 100.0) is None


def test_planned_stop_is_not_a_problem(capsys):
    mod = _load_module()
    _with_one_service(mod)
    os.environ["BOT_ERRORS_DRY_SERVICE_INTENT"] = json.dumps({
        _SERVICE: {
            "ActiveState": "inactive",
            "SubState": "dead",
            "Result": "success",
            "ExecMainStatus": "0",
        }
    })

    problems = mod.local_service_problems()

    assert problems == {}
    assert "intent-skip" in capsys.readouterr().err


def test_crash_is_a_problem():
    mod = _load_module()
    _with_one_service(mod)
    os.environ["BOT_ERRORS_DRY_SERVICE_INTENT"] = json.dumps({
        _SERVICE: {
            "ActiveState": "failed",
            "SubState": "failed",
            "Result": "exit-code",
            "ExecMainStatus": "1",
        }
    })

    problems = mod.local_service_problems()

    assert f"local_service:{_SERVICE}" in problems
    assert "intent=crash" in problems[f"local_service:{_SERVICE}"]


def test_activating_within_grace_is_not_a_problem():
    mod = _load_module()
    _with_one_service(mod)
    mod.monotonic_now_seconds = lambda: 100.0
    os.environ["BOT_ERRORS_RESTART_GRACE_SECONDS"] = "45"
    os.environ["BOT_ERRORS_DRY_SERVICE_INTENT"] = json.dumps({
        _SERVICE: {
            "ActiveState": "activating",
            "SubState": "start",
            "StateChangeTimestampMonotonic": "90000000",
        }
    })

    assert mod.local_service_problems() == {}


def test_activating_past_grace_is_a_problem():
    mod = _load_module()
    _with_one_service(mod)
    mod.monotonic_now_seconds = lambda: 100.0
    os.environ["BOT_ERRORS_RESTART_GRACE_SECONDS"] = "45"
    os.environ["BOT_ERRORS_DRY_SERVICE_INTENT"] = json.dumps({
        _SERVICE: {
            "ActiveState": "activating",
            "SubState": "start",
            "StateChangeTimestampMonotonic": "10000000",
        }
    })

    problems = mod.local_service_problems()

    assert f"local_service:{_SERVICE}" in problems


def test_intent_probe_exception_fails_closed():
    mod = _load_module()
    _with_one_service(mod)
    os.environ["BOT_ERRORS_DRY_SERVICE_INTENT"] = json.dumps({
        _SERVICE: {"ActiveState": "failed", "Result": "exit-code"}
    })

    def boom(_service):
        raise RuntimeError("systemctl exploded")

    mod.service_intent_properties = boom

    problems = mod.local_service_problems()

    assert f"local_service:{_SERVICE}" in problems
    assert "intent check failed" in problems[f"local_service:{_SERVICE}"]


def test_gate_off_falls_back_to_legacy_is_active():
    mod = _load_module()
    _with_one_service(mod)
    os.environ["BOT_ERRORS_WATCHDOG_INTENT_DETECTION"] = "0"
    mod.local_service_status = lambda _service: "active"

    assert mod.local_service_problems() == {}

    mod.local_service_status = lambda _service: "inactive"
    problems = mod.local_service_problems()

    assert f"local_service:{_SERVICE}" in problems
    assert "local service inactive" in problems[f"local_service:{_SERVICE}"]


def test_legacy_dry_states_channel_still_wins():
    mod = _load_module()
    _with_one_service(mod)
    os.environ["BOT_ERRORS_DRY_SERVICE_STATES"] = json.dumps({_SERVICE: "active"})
    os.environ["BOT_ERRORS_DRY_SERVICE_INTENT"] = json.dumps({
        _SERVICE: {"ActiveState": "failed", "Result": "exit-code"}
    })

    assert mod.local_service_problems() == {}


def test_intent_detection_enabled_default_and_overrides():
    mod = _load_module()

    assert mod.intent_detection_enabled() is True
    os.environ["BOT_ERRORS_WATCHDOG_INTENT_DETECTION"] = "0"
    assert mod.intent_detection_enabled() is False
    os.environ["BOT_ERRORS_WATCHDOG_INTENT_DETECTION"] = "off"
    assert mod.intent_detection_enabled() is False
    os.environ["BOT_ERRORS_WATCHDOG_INTENT_DETECTION"] = "1"
    assert mod.intent_detection_enabled() is True


def test_restart_grace_parses_and_clamps():
    mod = _load_module()

    assert mod.restart_grace_seconds() == pytest.approx(45.0)
    os.environ["BOT_ERRORS_RESTART_GRACE_SECONDS"] = "90"
    assert mod.restart_grace_seconds() == pytest.approx(90.0)
    os.environ["BOT_ERRORS_RESTART_GRACE_SECONDS"] = "-5"
    assert mod.restart_grace_seconds() == 0.0
    os.environ["BOT_ERRORS_RESTART_GRACE_SECONDS"] = "bad"
    assert mod.restart_grace_seconds() == pytest.approx(45.0)
