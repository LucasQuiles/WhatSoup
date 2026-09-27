"""Tests for load_health_profile() resolution and its fail-closed contract.

History: on 2026-06-23 a stale baked ``BOT_ERRORS_HEALTH_PROFILE`` path made
load_health_profile() fall back to ``DEFAULT_HEALTH_PROFILE`` (role=central), so
relay/leaf hosts failed every central-only check. The first fix self-healed
from the tracked per-host profile. Profiles are moving out of the public repo,
so that fallback chain became a way to silently check the wrong things. The
loader now resolves through ``lib/fleet_config.py``:

  BOT_ERRORS_HEALTH_PROFILE_JSON -> BOT_ERRORS_HEALTH_PROFILE
  -> ~/.config/whatsoup/health-profile.json -> tracked deploy/health-profiles/<host>.json

and any failure raises FleetConfigError; daily() then exits 2. A set env var
never self-heals from a later source, and a missing profile never becomes
role=central.

Loads bot-errors-health-check.py via importlib (hyphen in filename prevents
normal import). HOME points at a temp dir so real private files are never read.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    monkeypatch.delenv("BOT_ERRORS_HEALTH_PROFILE", raising=False)
    monkeypatch.delenv("BOT_ERRORS_HEALTH_PROFILE_JSON", raising=False)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))


def _private_path() -> Path:
    return Path(os.environ["HOME"]) / ".config" / "whatsoup" / "health-profile.json"


def _write_profile(path: Path, role: str = "relay") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"role": role, "expectDispatcher": False}), encoding="utf-8")
    return path


def _point_tracked_at(monkeypatch, path: Path | None):
    """Force script_relative_profile_path() to a known location (or a missing one)."""
    target = path if path is not None else Path("/nonexistent/health-profiles/none.json")
    monkeypatch.setattr(_mod, "script_relative_profile_path", lambda: target)
    return target


def _load_error() -> str:
    with pytest.raises(_mod.FleetConfigError) as info:
        _mod.load_health_profile()
    return str(info.value)


# ---------------------------------------------------------------------------
# Resolution order
# ---------------------------------------------------------------------------

def test_valid_env_path_loads_without_fallback(monkeypatch, tmp_path):
    prof = _write_profile(tmp_path / "host.json", role="relay")
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(prof))
    _point_tracked_at(monkeypatch, None)  # tracked copy must NOT be consulted

    result = _mod.load_health_profile()

    assert result["role"] == "relay"
    assert result["_explicitProfile"] is True
    assert result["_profilePath"] == str(prof)
    assert "profileFallback" not in result
    assert "profileLoadError" not in result


def test_private_profile_present_is_used(monkeypatch, tmp_path):
    private = _write_profile(_private_path(), role="relay")
    _point_tracked_at(monkeypatch, _write_profile(tmp_path / "repo" / "host-a.json", role="leaf"))

    result = _mod.load_health_profile()

    assert result["role"] == "relay"
    assert result["_explicitProfile"] is True
    assert result["_profilePath"] == str(private)
    assert "profileFallback" not in result


def test_private_missing_uses_tracked_copy(monkeypatch, tmp_path):
    tracked = _point_tracked_at(monkeypatch, _write_profile(tmp_path / "relay.json", role="relay"))

    result = _mod.load_health_profile()

    assert result["role"] == "relay"
    assert result["_explicitProfile"] is True
    assert result["_profilePath"] == str(tracked)
    # Same evidence text as before the resolver existed.
    assert result["profileFallback"] == f"no BOT_ERRORS_HEALTH_PROFILE set; recovered from {tracked}"


def test_json_env_wins_and_skips_files(monkeypatch, tmp_path):
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE_JSON", json.dumps({"role": "relay"}))
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(tmp_path / "ignored.json"))
    _point_tracked_at(monkeypatch, None)

    result = _mod.load_health_profile()

    assert result["role"] == "relay"
    assert result["_explicitProfile"] is True
    assert "profileFallback" not in result


# ---------------------------------------------------------------------------
# Fail closed: never role=central, never self-heal past a set env var
# ---------------------------------------------------------------------------

def test_no_profile_anywhere_fails_instead_of_role_central(monkeypatch):
    tracked = _point_tracked_at(monkeypatch, None)

    message = _load_error()

    assert "health profile missing" in message
    assert str(_private_path()) in message
    assert str(tracked) in message
    assert "resolver order: 1) env BOT_ERRORS_HEALTH_PROFILE 2) private" in message


def test_stale_env_path_fails_even_when_later_sources_exist(monkeypatch, tmp_path):
    """The 2026-06-23 storm input: the baked env path is gone. It must now fail
    loudly rather than self-heal from the private or tracked copy."""
    stale = tmp_path / "stale" / "missing.json"
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(stale))
    _write_profile(_private_path(), role="relay")
    _point_tracked_at(monkeypatch, _write_profile(tmp_path / "repo" / "leaf.json", role="leaf"))

    message = _load_error()

    assert f"health profile missing: {stale}" in message
    assert "BOT_ERRORS_HEALTH_PROFILE is set, so later sources were not tried" in message


def test_invalid_json_env_file_fails(monkeypatch, tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(bad))
    _point_tracked_at(monkeypatch, _write_profile(tmp_path / "leaf.json", role="leaf"))

    assert "is not valid JSON" in _load_error()


def test_env_profile_not_object_fails(monkeypatch, tmp_path):
    bad = tmp_path / "list.json"
    bad.write_text("[1, 2, 3]", encoding="utf-8")
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(bad))
    _point_tracked_at(monkeypatch, _write_profile(tmp_path / "leaf.json", role="leaf"))

    assert "is not a JSON object" in _load_error()


def test_invalid_json_private_does_not_fall_back_to_tracked(monkeypatch, tmp_path):
    private = _private_path()
    private.parent.mkdir(parents=True)
    private.write_text("{not json", encoding="utf-8")
    _point_tracked_at(monkeypatch, _write_profile(tmp_path / "leaf.json", role="leaf"))

    message = _load_error()

    assert "health profile is not valid JSON" in message
    assert str(private) in message


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads mode-000 files")
def test_unreadable_private_does_not_fall_back_to_tracked(monkeypatch, tmp_path):
    private = _write_profile(_private_path(), role="relay")
    _point_tracked_at(monkeypatch, _write_profile(tmp_path / "leaf.json", role="leaf"))
    private.chmod(0)
    try:
        assert "unreadable (PermissionError)" in _load_error()
    finally:
        private.chmod(0o600)


def test_invalid_json_env_inline_fails(monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE_JSON", "{not json")

    message = _load_error()

    assert "BOT_ERRORS_HEALTH_PROFILE_JSON" in message
    assert "is not valid JSON" in message
    assert "resolver order: 0) env BOT_ERRORS_HEALTH_PROFILE_JSON" in message


def test_non_object_env_inline_fails(monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE_JSON", "[1]")

    assert "is not a JSON object" in _load_error()


def test_daily_exits_2_before_any_probe_when_profile_missing(monkeypatch, capsys):
    _point_tracked_at(monkeypatch, None)

    def _no_probe(*_args, **_kwargs):
        raise AssertionError("daily() probed with no profile")

    monkeypatch.setattr(_mod, "tool_inventory", _no_probe)

    assert _mod.daily() == 2

    captured = capsys.readouterr()
    lines = captured.err.strip().splitlines()
    assert len(lines) == 1
    assert lines[0].startswith("bot-errors-health-check: fail-closed: health profile missing")
    assert "resolver order:" in lines[0]
    assert "role=central" not in captured.out


# ---------------------------------------------------------------------------
# host_profile_name normalization
# ---------------------------------------------------------------------------

def test_host_profile_name_normalizes(monkeypatch):
    """First DNS label, lowercased — matching the install scripts."""
    def check(hostname: str, expected: str) -> None:
        monkeypatch.setattr(_mod.socket, "gethostname", lambda: hostname)
        assert _mod.host_profile_name() == expected

    check("Alpha", "alpha")            # uppercase -> lowercase
    check("node5", "node5")            # already canonical
    check("NODE5.local", "node5")      # strips domain, lowercases
    check("box-7.example.lan", "box-7")  # multi-label domain, hyphen preserved
