"""Tests for Pattern B (Part 1) — planned-vs-crash intent detection.

Root cause of false-positive lifecycle alerts: the watchdog used a bare
``systemctl is-active`` check, which cannot distinguish a deliberate
``systemctl stop`` (or an in-flight restart) from a crash — both read
"not active" and both paged. A planned shutdown should never trigger an alert.

Fix: query the structured systemd exit context
(Result/ActiveState/SubState/ExecMainStatus) and classify intent —
clean stop -> planned (log only), restart-in-flight within grace -> hold,
crash/failed/stalled -> alert as before. Fail-closed: any ambiguity, probe
error, or unknown state classifies as a crash so a real outage is never lost.

Covered:
- classify_service_intent: active / planned / crash / unclean-stop / activating
  (within grace, stalled past grace, unknown elapsed) / unknown / probe-error.
- activating_elapsed_seconds parsing (valid / missing / zero / garbage).
- local_service_problems: planned + grace are NOT problems; crash IS; intent
  check exception is fail-closed; gate-off falls back to legacy is-active.
- env knob parsing/clamping for grace and the detection gate.
"""
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
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    for k in _ENV_KEYS:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_watchdog_intent", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# Neutral fixture unit — avoids real instance labels and address-shaped tokens
# (the publication guard reads local-part-then-domain patterns as personal
# emails, so templated systemd unit names like the at-sign form trip it).
_SVC = "sample-unit.service"


def _with_one_service(mod):
    mod.expected_local_services = lambda: [{"name": "sample", "service": _SVC}]  # type: ignore[attr-defined]
    mod.health_profile_path = lambda: "/tmp/profile.json"  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# classify_service_intent
# ---------------------------------------------------------------------------

def test_classify_active_is_not_a_problem():
    mod = _load()
    cls, _detail = mod.classify_service_intent(
        {"ActiveState": "active", "SubState": "running", "Result": "success"}, 45.0, 100.0
    )
    assert cls == "active"


def test_classify_clean_stop_is_planned():
    mod = _load()
    cls, detail = mod.classify_service_intent(
        {"ActiveState": "inactive", "SubState": "dead", "Result": "success", "ExecMainStatus": "0"},
        45.0,
        100.0,
    )
    assert cls == "planned"
    assert "clean stop" in detail


def test_classify_failed_is_crash():
    mod = _load()
    cls, _detail = mod.classify_service_intent(
        {"ActiveState": "failed", "SubState": "failed", "Result": "exit-code", "ExecMainStatus": "1"},
        45.0,
        100.0,
    )
    assert cls == "crash"


def test_classify_unclean_inactive_is_crash():
    # inactive but Result != success -> the unit died, not a planned stop.
    mod = _load()
    cls, detail = mod.classify_service_intent(
        {"ActiveState": "inactive", "SubState": "dead", "Result": "signal", "ExecMainStatus": "143"},
        45.0,
        100.0,
    )
    assert cls == "crash"
    assert "unclean stop" in detail or "Result=signal" in detail


def test_classify_oom_kill_result_is_crash():
    mod = _load()
    cls, _detail = mod.classify_service_intent(
        {"ActiveState": "inactive", "SubState": "dead", "Result": "oom-kill"}, 45.0, 100.0
    )
    assert cls == "crash"


def test_classify_activating_within_grace_holds():
    mod = _load()
    # state changed 10s ago (monotonic_now=100, ts=90_000_000us); grace 45s.
    cls, _detail = mod.classify_service_intent(
        {"ActiveState": "activating", "SubState": "start", "StateChangeTimestampMonotonic": "90000000"},
        45.0,
        100.0,
    )
    assert cls == "activating_grace"


def test_classify_activating_past_grace_is_crash():
    mod = _load()
    # state changed 90s ago; grace 45s -> restart stalled -> crash.
    cls, detail = mod.classify_service_intent(
        {"ActiveState": "activating", "SubState": "start", "StateChangeTimestampMonotonic": "10000000"},
        45.0,
        100.0,
    )
    assert cls == "crash"
    assert "stalled" in detail


def test_classify_activating_unknown_elapsed_holds():
    # No usable timestamp -> cannot prove it is stalled -> hold (do not page).
    mod = _load()
    cls, _detail = mod.classify_service_intent(
        {"ActiveState": "activating", "SubState": "start"}, 45.0, 100.0
    )
    assert cls == "activating_grace"


def test_classify_unknown_state_fails_closed_to_crash():
    mod = _load()
    cls, _detail = mod.classify_service_intent({"ActiveState": "", "Result": ""}, 45.0, 100.0)
    assert cls == "crash"


def test_classify_probe_error_fails_closed_to_crash():
    mod = _load()
    cls, detail = mod.classify_service_intent(
        {"_showError": "Failed to connect to bus"}, 45.0, 100.0
    )
    assert cls == "crash"
    assert "probe_error" in detail


# ---------------------------------------------------------------------------
# activating_elapsed_seconds
# ---------------------------------------------------------------------------

def test_activating_elapsed_parses_microseconds():
    mod = _load()
    assert mod.activating_elapsed_seconds({"StateChangeTimestampMonotonic": "50000000"}, 100.0) == pytest.approx(50.0)


def test_activating_elapsed_missing_or_garbage_is_none():
    mod = _load()
    assert mod.activating_elapsed_seconds({}, 100.0) is None
    assert mod.activating_elapsed_seconds({"StateChangeTimestampMonotonic": "0"}, 100.0) is None
    assert mod.activating_elapsed_seconds({"StateChangeTimestampMonotonic": "notanint"}, 100.0) is None


# ---------------------------------------------------------------------------
# local_service_problems integration
# ---------------------------------------------------------------------------

def test_planned_stop_is_not_a_problem(capsys):
    mod = _load()
    _with_one_service(mod)
    os.environ["BOT_ERRORS_DRY_SERVICE_INTENT"] = json.dumps(
        {_SVC: {"ActiveState": "inactive", "SubState": "dead", "Result": "success", "ExecMainStatus": "0"}}
    )
    problems = mod.local_service_problems()
    assert problems == {}
    assert "intent-skip" in capsys.readouterr().err  # planned skip is logged


def test_crash_is_a_problem():
    mod = _load()
    _with_one_service(mod)
    os.environ["BOT_ERRORS_DRY_SERVICE_INTENT"] = json.dumps(
        {_SVC: {"ActiveState": "failed", "SubState": "failed", "Result": "exit-code", "ExecMainStatus": "1"}}
    )
    problems = mod.local_service_problems()
    assert f"local_service:{_SVC}" in problems
    assert "intent=crash" in problems[f"local_service:{_SVC}"]


def test_activating_within_grace_is_not_a_problem():
    mod = _load()
    _with_one_service(mod)
    mod.monotonic_now_seconds = lambda: 100.0  # type: ignore[attr-defined]
    os.environ["BOT_ERRORS_RESTART_GRACE_SECONDS"] = "45"
    os.environ["BOT_ERRORS_DRY_SERVICE_INTENT"] = json.dumps(
        {_SVC: {"ActiveState": "activating", "SubState": "start", "StateChangeTimestampMonotonic": "90000000"}}
    )
    assert mod.local_service_problems() == {}


def test_activating_past_grace_is_a_problem():
    mod = _load()
    _with_one_service(mod)
    mod.monotonic_now_seconds = lambda: 100.0  # type: ignore[attr-defined]
    os.environ["BOT_ERRORS_RESTART_GRACE_SECONDS"] = "45"
    os.environ["BOT_ERRORS_DRY_SERVICE_INTENT"] = json.dumps(
        {_SVC: {"ActiveState": "activating", "SubState": "start", "StateChangeTimestampMonotonic": "10000000"}}
    )
    problems = mod.local_service_problems()
    assert f"local_service:{_SVC}" in problems


def test_intent_probe_exception_fails_closed():
    mod = _load()
    _with_one_service(mod)

    def boom(_service):
        raise RuntimeError("systemctl exploded")

    mod.service_intent_properties = boom  # type: ignore[attr-defined]
    problems = mod.local_service_problems()
    assert f"local_service:{_SVC}" in problems
    assert "intent check failed" in problems[f"local_service:{_SVC}"]


def test_gate_off_falls_back_to_legacy_is_active():
    mod = _load()
    _with_one_service(mod)
    os.environ["BOT_ERRORS_WATCHDOG_INTENT_DETECTION"] = "0"
    # Legacy path consults local_service_status; stub it to report active.
    mod.local_service_status = lambda _service: "active"  # type: ignore[attr-defined]
    assert mod.local_service_problems() == {}
    mod.local_service_status = lambda _service: "inactive"  # type: ignore[attr-defined]
    problems = mod.local_service_problems()
    assert f"local_service:{_SVC}" in problems
    assert "local service inactive" in problems[f"local_service:{_SVC}"]


def test_legacy_dry_states_channel_still_wins():
    mod = _load()
    _with_one_service(mod)
    os.environ["BOT_ERRORS_DRY_SERVICE_STATES"] = json.dumps({_SVC: "active"})
    # Even with a crash in the intent channel, the legacy string channel wins.
    os.environ["BOT_ERRORS_DRY_SERVICE_INTENT"] = json.dumps(
        {_SVC: {"ActiveState": "failed", "Result": "exit-code"}}
    )
    assert mod.local_service_problems() == {}


# ---------------------------------------------------------------------------
# config parsing
# ---------------------------------------------------------------------------

def test_intent_detection_enabled_default_and_overrides():
    mod = _load()
    assert mod.intent_detection_enabled() is True
    os.environ["BOT_ERRORS_WATCHDOG_INTENT_DETECTION"] = "0"
    assert mod.intent_detection_enabled() is False
    os.environ["BOT_ERRORS_WATCHDOG_INTENT_DETECTION"] = "off"
    assert mod.intent_detection_enabled() is False
    os.environ["BOT_ERRORS_WATCHDOG_INTENT_DETECTION"] = "1"
    assert mod.intent_detection_enabled() is True


def test_restart_grace_parses_and_clamps():
    mod = _load()
    assert mod.restart_grace_seconds() == pytest.approx(45.0)
    os.environ["BOT_ERRORS_RESTART_GRACE_SECONDS"] = "90"
    assert mod.restart_grace_seconds() == pytest.approx(90.0)
    os.environ["BOT_ERRORS_RESTART_GRACE_SECONDS"] = "-5"
    assert mod.restart_grace_seconds() == 0.0
    os.environ["BOT_ERRORS_RESTART_GRACE_SECONDS"] = "bad"
    assert mod.restart_grace_seconds() == pytest.approx(45.0)
