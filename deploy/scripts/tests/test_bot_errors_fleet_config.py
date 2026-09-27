"""Tests for lib/fleet_config.py, the one resolver for health profiles and the roster.

Order under test: env var -> private ~/.config/whatsoup file -> tracked repo
copy -> fail. Only absence moves resolution on; a set env var or an existing
private file that cannot be read fails instead of falling through. HOME points
at a temp dir so the host's real private files are never read.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest

_LIB = Path(__file__).resolve().parents[1] / "lib" / "fleet_config.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("fleet_config", _LIB)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


@pytest.fixture
def home(monkeypatch, tmp_path: Path) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    for name in (_mod.HEALTH_PROFILE_ENV, _mod.ROSTER_ENV, _mod.GUI_ROSTER_ENV):
        monkeypatch.delenv(name, raising=False)
    return home


def _write(path: Path, payload) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _private_profile(home: Path) -> Path:
    return home / ".config" / "whatsoup" / "health-profile.json"


def _tracked_profile(tmp_path: Path) -> Path:
    return tmp_path / "repo" / "deploy" / "health-profiles" / "host-a.json"


def test_private_paths_follow_home(home: Path):
    assert _mod.private_health_profile_path() == _private_profile(home)
    assert _mod.private_roster_path() == home / ".config" / "whatsoup" / "bot-errors-expected-fleet.json"


def test_tracked_paths_are_repo_relative(tmp_path: Path):
    repo = tmp_path / "repo"
    assert _mod.tracked_health_profile_path(repo, "host-a") == _tracked_profile(tmp_path)
    assert _mod.tracked_roster_path(repo) == repo / "deploy" / "bot-errors-expected-fleet.json"


def test_private_profile_present_wins_over_tracked(home: Path, tmp_path: Path):
    _write(_private_profile(home), {"role": "relay"})
    tracked = _write(_tracked_profile(tmp_path), {"role": "leaf"})

    resolved = _mod.resolve_health_profile(tracked)

    assert resolved.source == _mod.SOURCE_PRIVATE
    assert resolved.path == _private_profile(home)
    assert _mod.read_json_object(resolved) == {"role": "relay"}


def test_private_missing_uses_tracked(home: Path, tmp_path: Path):
    tracked = _write(_tracked_profile(tmp_path), {"role": "leaf"})

    resolved = _mod.resolve_health_profile(tracked)

    assert resolved.source == _mod.SOURCE_TRACKED
    assert _mod.read_json_object(resolved) == {"role": "leaf"}


def test_both_missing_fails_naming_paths_and_order(home: Path, tmp_path: Path):
    tracked = _tracked_profile(tmp_path)

    with pytest.raises(_mod.FleetConfigError) as info:
        _mod.resolve_health_profile(tracked)

    message = str(info.value)
    assert "health profile missing" in message
    assert str(_private_profile(home)) in message
    assert str(tracked) in message
    assert (
        f"resolver order: 1) env BOT_ERRORS_HEALTH_PROFILE 2) private {_private_profile(home)} "
        f"3) tracked {tracked}"
    ) in message
    assert "\n" not in message
    assert info.value.path == _private_profile(home)


def test_env_set_to_missing_file_does_not_fall_through(home: Path, tmp_path: Path, monkeypatch):
    _write(_private_profile(home), {"role": "relay"})
    tracked = _write(_tracked_profile(tmp_path), {"role": "leaf"})
    missing = tmp_path / "gone" / "profile.json"
    monkeypatch.setenv(_mod.HEALTH_PROFILE_ENV, str(missing))

    resolved = _mod.resolve_health_profile(tracked)
    assert resolved.source == _mod.SOURCE_ENV
    with pytest.raises(_mod.FleetConfigError) as info:
        _mod.read_json_object(resolved)

    message = str(info.value)
    assert f"health profile missing: {missing}" in message
    assert "BOT_ERRORS_HEALTH_PROFILE is set, so later sources were not tried" in message
    assert "resolver order: 1) env BOT_ERRORS_HEALTH_PROFILE" in message


def test_env_path_is_expanded(home: Path, tmp_path: Path, monkeypatch):
    target = _write(home / "profiles" / "host-a.json", {"role": "relay"})
    monkeypatch.setenv(_mod.HEALTH_PROFILE_ENV, "  ~/profiles/host-a.json  ")

    resolved = _mod.resolve_health_profile(_tracked_profile(tmp_path))

    assert resolved.path == target
    assert resolved.env_raw == "~/profiles/host-a.json"


def test_invalid_json_private_does_not_fall_through(home: Path, tmp_path: Path):
    private = _private_profile(home)
    private.parent.mkdir(parents=True)
    private.write_text("{not json", encoding="utf-8")
    tracked = _write(_tracked_profile(tmp_path), {"role": "leaf"})

    resolved = _mod.resolve_health_profile(tracked)
    with pytest.raises(_mod.FleetConfigError) as info:
        _mod.read_json_object(resolved)

    message = str(info.value)
    assert "is not valid JSON" in message
    assert "the private file exists, so the tracked copy was not tried" in message


def test_non_object_json_fails(home: Path, tmp_path: Path):
    tracked = _tracked_profile(tmp_path)
    tracked.parent.mkdir(parents=True)
    tracked.write_text("[1, 2]", encoding="utf-8")

    with pytest.raises(_mod.FleetConfigError, match="is not a JSON object") as info:
        _mod.read_json_object(_mod.resolve_health_profile(tracked))
    assert "BOT_ERRORS_HEALTH_PROFILE is unset and the private file is absent" in str(info.value)


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads mode-000 files")
def test_unreadable_private_does_not_fall_through(home: Path, tmp_path: Path):
    private = _write(_private_profile(home), {"role": "relay"})
    tracked = _write(_tracked_profile(tmp_path), {"role": "leaf"})
    private.chmod(0)
    try:
        with pytest.raises(_mod.FleetConfigError, match=r"unreadable \(PermissionError\)"):
            _mod.read_json_object(_mod.resolve_health_profile(tracked))
    finally:
        private.chmod(0o600)


def test_dangling_private_symlink_is_selected_and_fails(home: Path, tmp_path: Path):
    private = _private_profile(home)
    private.parent.mkdir(parents=True)
    private.symlink_to(tmp_path / "nowhere.json")
    tracked = _write(_tracked_profile(tmp_path), {"role": "leaf"})

    resolved = _mod.resolve_health_profile(tracked)

    assert resolved.source == _mod.SOURCE_PRIVATE
    with pytest.raises(_mod.FleetConfigError, match="health profile missing"):
        _mod.read_json_object(resolved)


def test_roster_resolves_env_then_private_then_tracked(home: Path, tmp_path: Path, monkeypatch):
    repo = tmp_path / "repo"
    tracked = _write(repo / "deploy" / "bot-errors-expected-fleet.json", {"hosts": ["tracked"]})
    assert _mod.resolve_roster(repo).path == tracked

    private = _write(_mod.private_roster_path(), {"hosts": ["private"]})
    assert _mod.resolve_roster(repo).path == private

    env_file = _write(tmp_path / "env-roster.json", {"hosts": ["env"]})
    monkeypatch.setenv(_mod.ROSTER_ENV, str(env_file))
    assert _mod.resolve_roster(repo).path == env_file
    # Each consumer keeps its own env name; the other one is not consulted.
    assert _mod.resolve_roster(repo, _mod.GUI_ROSTER_ENV).path == private


def test_roster_both_missing_fails(home: Path, tmp_path: Path):
    with pytest.raises(_mod.FleetConfigError) as info:
        _mod.resolve_roster(tmp_path / "repo", _mod.GUI_ROSTER_ENV)
    message = str(info.value)
    assert message.startswith("fleet roster missing: BOT_ERRORS_EXPECTED_FLEET is unset")
    assert "resolver order: 1) env BOT_ERRORS_EXPECTED_FLEET 2) private" in message
