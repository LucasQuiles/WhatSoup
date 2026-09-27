"""The heartbeat watchdog's health-profile loader fails closed.

Before: ``load_json`` swallowed every read or parse error and returned None, so
a missing, unreadable or invalid profile made expected_local_instances()
return [] and every per-service check watched nothing while staying green.

Now the profile resolves through ``lib/fleet_config.py``
(BOT_ERRORS_HEALTH_PROFILE -> ~/.config/whatsoup/health-profile.json -> tracked
deploy/health-profiles/<host>.json). A failure raises FleetConfigError, and
run_once() exits 2 with one configuration_error line before opening state
whenever a profile-based check is selected.

HOME, REPO_ROOT and the hostname are pinned to temp values and the synthetic
host ``host-a`` so neither real private files nor tracked profiles are read.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]

_PROFILE_CHECKS = ["local_services", "local_instance_health", "wedge_signature", "turn_failure_rate"]


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_heartbeat_watchdog_profile",
        _SCRIPT_ROOT / "bot-errors-heartbeat-watchdog.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def mod(monkeypatch, tmp_path: Path):
    module = _load_module()
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("BOT_ERRORS_HEALTH_PROFILE", raising=False)
    monkeypatch.setattr(module, "REPO_ROOT", tmp_path / "repo")
    monkeypatch.setattr(module.socket, "gethostname", lambda: "host-a.example")
    return module


def _private(tmp_path: Path) -> Path:
    return tmp_path / "home" / ".config" / "whatsoup" / "health-profile.json"


def _tracked(tmp_path: Path) -> Path:
    return tmp_path / "repo" / "deploy" / "health-profiles" / "host-a.json"


def _profile(*names: str) -> dict:
    return {
        "role": "bot-host",
        "instances": [
            {"name": name, "expected": "always_on", "service": f"svc-{name}"} for name in names
        ],
    }


def _write(path: Path, payload) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = payload if isinstance(payload, str) else json.dumps(payload)
    path.write_text(text, encoding="utf-8")
    return path


def _names(mod) -> list[str]:
    return [item["name"] for item in mod.expected_local_instances()]


def _run_once_refused(mod, monkeypatch, checks: str, capsys) -> tuple[str, str]:
    monkeypatch.setenv("BOT_ERRORS_WATCHDOG_CHECKS", checks)
    session = mock.Mock(side_effect=AssertionError("state opened with no usable profile"))
    monkeypatch.setattr(mod, "open_watchdog_state_session", session)
    assert mod.run_once(SimpleNamespace()) == 2
    session.assert_not_called()
    captured = capsys.readouterr()
    assert json.loads(captured.out)["verdict"] == "configuration_error"
    return captured.err, captured.out


# ---------------------------------------------------------------------------
# Resolution order
# ---------------------------------------------------------------------------

def test_private_profile_present_is_used(mod, tmp_path: Path):
    _write(_private(tmp_path), _profile("private-a"))
    _write(_tracked(tmp_path), _profile("tracked-a"))

    assert _names(mod) == ["private-a"]
    assert mod.health_profile_path() == _private(tmp_path)


def test_private_missing_uses_tracked_copy(mod, tmp_path: Path):
    _write(_tracked(tmp_path), _profile("tracked-a"))

    assert _names(mod) == ["tracked-a"]
    assert mod.health_profile_path() == _tracked(tmp_path)


def test_env_profile_wins(mod, tmp_path: Path, monkeypatch):
    env_file = _write(tmp_path / "env-profile.json", _profile("env-a"))
    _write(_private(tmp_path), _profile("private-a"))
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(env_file))

    assert _names(mod) == ["env-a"]


# ---------------------------------------------------------------------------
# Fail closed
# ---------------------------------------------------------------------------

def test_no_profile_anywhere_raises_instead_of_expecting_nothing(mod, tmp_path: Path):
    with pytest.raises(mod.FleetConfigError) as info:
        mod.expected_local_instances()

    message = str(info.value)
    assert "health profile missing" in message
    assert str(_private(tmp_path)) in message
    assert str(_tracked(tmp_path)) in message
    assert "resolver order: 1) env BOT_ERRORS_HEALTH_PROFILE 2) private" in message
    # Evidence text keeps its old value and never raises.
    assert mod.health_profile_path() == _tracked(tmp_path)


@pytest.mark.parametrize("check", _PROFILE_CHECKS)
def test_run_once_exits_2_when_profile_missing(mod, tmp_path: Path, monkeypatch, capsys, check):
    err, _ = _run_once_refused(mod, monkeypatch, check, capsys)

    lines = err.strip().splitlines()
    assert len(lines) == 1
    assert lines[0].startswith("configuration_error: health profile missing")
    assert str(_private(tmp_path)) in lines[0]
    assert str(_tracked(tmp_path)) in lines[0]
    assert "resolver order:" in lines[0]


def test_env_set_to_missing_file_fails_without_falling_through(mod, tmp_path: Path, monkeypatch, capsys):
    _write(_private(tmp_path), _profile("private-a"))
    _write(_tracked(tmp_path), _profile("tracked-a"))
    missing = tmp_path / "gone.json"
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(missing))

    err, _ = _run_once_refused(mod, monkeypatch, "local_services", capsys)

    assert f"health profile missing: {missing}" in err
    assert "BOT_ERRORS_HEALTH_PROFILE is set, so later sources were not tried" in err


def test_invalid_json_private_fails(mod, tmp_path: Path, monkeypatch, capsys):
    _write(_private(tmp_path), "{not json")
    _write(_tracked(tmp_path), _profile("tracked-a"))

    err, _ = _run_once_refused(mod, monkeypatch, "local_instance_health", capsys)

    assert "health profile is not valid JSON" in err
    assert str(_private(tmp_path)) in err


def test_invalid_json_env_file_fails(mod, tmp_path: Path, monkeypatch, capsys):
    bad = _write(tmp_path / "bad.json", "[")
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(bad))

    err, _ = _run_once_refused(mod, monkeypatch, "local_services", capsys)

    assert "is not valid JSON" in err


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads mode-000 files")
def test_unreadable_private_fails(mod, tmp_path: Path, monkeypatch, capsys):
    private = _write(_private(tmp_path), _profile("private-a"))
    _write(_tracked(tmp_path), _profile("tracked-a"))
    private.chmod(0)
    try:
        err, _ = _run_once_refused(mod, monkeypatch, "local_services", capsys)
    finally:
        private.chmod(0o600)

    assert "unreadable (PermissionError)" in err


def test_checks_without_profile_do_not_resolve_it(mod, monkeypatch):
    """q_loop-only runs must not start failing because this host has no profile."""
    monkeypatch.setenv("BOT_ERRORS_WATCHDOG_CHECKS", "q_loop,dispatcher")
    monkeypatch.setattr(
        mod, "expected_local_services", mock.Mock(side_effect=AssertionError("profile resolved"))
    )
    reached = RuntimeError("reached state session")
    monkeypatch.setattr(mod, "open_watchdog_state_session", mock.Mock(side_effect=reached))

    with pytest.raises(RuntimeError, match="reached state session"):
        mod.run_once(SimpleNamespace())
