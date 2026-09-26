"""Owned debug browsers are not "unattended".

The alert host runs a deliberate keep-alive CDP Chrome for a scheduled
watcher (``--remote-debugging-port`` plus a dedicated ``--user-data-dir``,
ppid 1 by design). The browser_debug check reported it as an unattended
session. BOT_ERRORS_WATCHDOG_BROWSER_DEBUG_OWNED
lists user-data-dir paths whose owner keeps them alive on purpose; those roots
are excluded. Unknown debug browsers still warn, and an empty value keeps the
old behaviour.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-heartbeat-watchdog.py"
OWNED_PROFILE = "/srv/operator/.cache/chrome-keepalive-debug"
OTHER_PROFILE = "/tmp/playwright-profile-xyz"
ENV = "BOT_ERRORS_WATCHDOG_BROWSER_DEBUG_OWNED"


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_heartbeat_watchdog_browser_owned", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _hash(profile: str) -> str:
    return hashlib.sha256(profile.encode("utf-8")).hexdigest()[:12]


def _row(pid: int, profile: str, port: int) -> dict:
    return {
        "pid": pid,
        "ageSeconds": 40_000,
        "rssMb": 900,
        "processCount": 9,
        "debugPort": port,
        "controllerConnections": 0,
        "profileHash": _hash(profile),
    }


@pytest.fixture
def mod(monkeypatch):
    monkeypatch.delenv(ENV, raising=False)
    monkeypatch.setenv(
        "BOT_ERRORS_DRY_BROWSER_DEBUG_SNAPSHOT",
        json.dumps([_row(100, OWNED_PROFILE, 9334), _row(200, OTHER_PROFILE, 9444)]),
    )
    return _load()


def test_empty_env_keeps_todays_behaviour(mod, monkeypatch):
    monkeypatch.setenv(ENV, "")
    problems = mod.browser_debug_problems()
    assert set(problems) == {f"browser_debug:{_hash(OWNED_PROFILE)}", f"browser_debug:{_hash(OTHER_PROFILE)}"}


def test_unset_env_keeps_todays_behaviour(mod):
    problems = mod.browser_debug_problems()
    assert f"browser_debug:{_hash(OWNED_PROFILE)}" in problems
    assert f"browser_debug:{_hash(OTHER_PROFILE)}" in problems


def test_allowlisted_profile_produces_no_incident(mod, monkeypatch):
    monkeypatch.setenv(ENV, OWNED_PROFILE)
    problems = mod.browser_debug_problems()
    assert f"browser_debug:{_hash(OWNED_PROFILE)}" not in problems
    assert f"browser_debug:{_hash(OTHER_PROFILE)}" in problems
    assert "unattended" in problems[f"browser_debug:{_hash(OTHER_PROFILE)}"]


def test_list_tolerates_spaces_and_trailing_slash(mod, monkeypatch):
    monkeypatch.setenv(ENV, f" {OTHER_PROFILE}/ , {OWNED_PROFILE} ,")
    assert mod.browser_debug_problems() == {}


def test_non_allowlisted_profile_still_warns(mod, monkeypatch):
    monkeypatch.setenv(ENV, "/srv/operator/.cache/some-other-owned-profile")
    problems = mod.browser_debug_problems()
    assert len(problems) == 2


def test_allowlisted_profile_with_unknown_visibility_is_not_a_per_profile_incident(monkeypatch):
    row = _row(100, OWNED_PROFILE, 9334)
    row["controllerConnections"] = None
    monkeypatch.setenv("BOT_ERRORS_DRY_BROWSER_DEBUG_SNAPSHOT", json.dumps([row]))
    monkeypatch.setenv(ENV, OWNED_PROFILE)
    assert _load().browser_debug_problems() == {}


def test_live_snapshot_allowlist_matches_user_data_dir(monkeypatch):
    from unittest.mock import patch

    mod = _load()
    monkeypatch.delenv("BOT_ERRORS_DRY_BROWSER_DEBUG_SNAPSHOT", raising=False)
    monkeypatch.setenv(ENV, OWNED_PROFILE)
    records = {
        100: {"pid": 100, "ppid": 1, "ageSeconds": 40_000.0, "rssMb": 900.0,
              "args": ["/opt/google/chrome/chrome", "--remote-debugging-port=9334",
                       f"--user-data-dir={OWNED_PROFILE}"]},
        200: {"pid": 200, "ppid": 1, "ageSeconds": 40_000.0, "rssMb": 900.0,
              "args": ["/opt/google/chrome/chrome", "--remote-debugging-port=9444",
                       f"--user-data-dir={OTHER_PROFILE}"]},
    }
    with (
        patch.object(mod, "_proc_processes", return_value=(records, None)),
        patch.object(mod, "_established_debug_connections", return_value=({9334: 0, 9444: 0}, None)),
    ):
        problems = mod.browser_debug_problems()
    assert set(problems) == {f"browser_debug:{_hash(OTHER_PROFILE)}"}
