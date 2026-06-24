"""Tests for load_health_profile() script-relative fallback.

Regression coverage for the fleet-wide false-critical daily-health storm
(2026-06-23): a stale baked ``BOT_ERRORS_HEALTH_PROFILE`` env path (plist baked
for a checkout location that no longer exists) caused load_health_profile() to
silently fall back to ``DEFAULT_HEALTH_PROFILE`` (role=central), so relay/leaf
hosts failed every central-only check. The fix self-heals from the in-repo
per-host profile (``REPO_ROOT/deploy/health-profiles/<host>.json``) before
defaulting to role=central.

Loads bot-errors-health-check.py via importlib (hyphen in filename prevents
normal import).
"""
from __future__ import annotations

import importlib.util
import json
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
def _clear_profile_env(monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_HEALTH_PROFILE", raising=False)
    monkeypatch.delenv("BOT_ERRORS_HEALTH_PROFILE_JSON", raising=False)


def _write_profile(path: Path, role: str = "relay") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"role": role, "expectDispatcher": False}), encoding="utf-8")
    return path


def _point_fallback_at(monkeypatch, path: Path | None):
    """Force script_relative_profile_path() to a known location (or a missing one)."""
    target = path if path is not None else Path("/nonexistent/health-profiles/none.json")
    monkeypatch.setattr(_mod, "script_relative_profile_path", lambda: target)


# ---------------------------------------------------------------------------
# Explicit env path
# ---------------------------------------------------------------------------

def test_valid_env_path_loads_without_fallback(monkeypatch, tmp_path):
    prof = _write_profile(tmp_path / "host.json", role="relay")
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(prof))
    _point_fallback_at(monkeypatch, None)  # fallback must NOT be consulted

    result = _mod.load_health_profile()

    assert result["role"] == "relay"
    assert result["_explicitProfile"] is True
    assert result["_profilePath"] == str(prof)
    assert "profileFallback" not in result
    assert "profileLoadError" not in result


def test_stale_env_path_recovers_from_fallback(monkeypatch, tmp_path):
    """The storm case: baked env path is gone, in-repo per-host profile exists."""
    stale = tmp_path / "stale" / "missing.json"  # does not exist
    fallback = _write_profile(tmp_path / "repo" / "leaf.json", role="leaf")
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(stale))
    _point_fallback_at(monkeypatch, fallback)

    result = _mod.load_health_profile()

    assert result["role"] == "leaf"  # NOT role=central
    assert result["_explicitProfile"] is True
    assert result["_profilePath"] == str(fallback)
    assert "profileFallback" in result
    assert str(stale) in result["profileFallback"]
    assert "profileLoadError" not in result  # self-healed: no FAIL line


def test_stale_env_path_and_no_fallback_reports_error(monkeypatch, tmp_path):
    stale = tmp_path / "missing.json"
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(stale))
    _point_fallback_at(monkeypatch, None)

    result = _mod.load_health_profile()

    assert "profileLoadError" in result
    assert str(stale) in result["profileLoadError"]
    assert result["_explicitProfile"] is True
    assert result["role"] == "central"  # DEFAULT_HEALTH_PROFILE


# ---------------------------------------------------------------------------
# No explicit env
# ---------------------------------------------------------------------------

def test_no_env_recovers_from_fallback(monkeypatch, tmp_path):
    fallback = _write_profile(tmp_path / "relay.json", role="relay")
    _point_fallback_at(monkeypatch, fallback)

    result = _mod.load_health_profile()

    assert result["role"] == "relay"
    assert result["_explicitProfile"] is True
    assert result["_profilePath"] == str(fallback)
    assert "profileFallback" in result
    assert "profileLoadError" not in result


def test_no_env_no_fallback_defaults_to_central(monkeypatch):
    _point_fallback_at(monkeypatch, None)

    result = _mod.load_health_profile()

    assert result["role"] == "central"
    assert result["_explicitProfile"] is False
    assert "profileLoadError" not in result  # absence of a profile is not a failure
    assert "profileFallback" not in result


# ---------------------------------------------------------------------------
# JSON env wins; malformed inputs
# ---------------------------------------------------------------------------

def test_json_env_wins_and_skips_fallback(monkeypatch, tmp_path):
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE_JSON", json.dumps({"role": "relay"}))
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(tmp_path / "ignored.json"))
    _point_fallback_at(monkeypatch, None)  # must not be consulted

    result = _mod.load_health_profile()

    assert result["role"] == "relay"
    assert result["_explicitProfile"] is True
    assert "profileFallback" not in result


def test_invalid_json_env_reports_error(monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE_JSON", "{not json")

    result = _mod.load_health_profile()

    assert "profileLoadError" in result
    assert result["_explicitProfile"] is True


def test_env_profile_not_object_reports_error(monkeypatch, tmp_path):
    bad = tmp_path / "list.json"
    bad.write_text("[1, 2, 3]", encoding="utf-8")
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(bad))
    fallback = _write_profile(tmp_path / "leaf.json", role="leaf")
    _point_fallback_at(monkeypatch, fallback)

    # A non-object env profile is a read failure -> self-heal from fallback.
    result = _mod.load_health_profile()

    assert result["role"] == "leaf"
    assert "profileFallback" in result


# ---------------------------------------------------------------------------
# host_profile_name normalization
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "hostname,expected",
    [
        ("Alpha", "alpha"),
        ("node5", "node5"),
        ("NODE5.local", "node5"),
        ("box-7.example.lan", "box-7"),
    ],
)
def test_host_profile_name_normalizes(monkeypatch, hostname, expected):
    monkeypatch.setattr(_mod.socket, "gethostname", lambda: hostname)
    assert _mod.host_profile_name() == expected
