"""Tests for the external (off-GUI) GUI-session monitor.

Context (the outage this defends against)
------------------------------------------
WhatSoup bots are per-user macOS GUI LaunchAgents. When a bot's user logs out
of the GUI (e.g. /dev/console owned by root at loginwindow), the bot
drops AND the in-GUI watchdog dies in the same failure, so the outage is
silent. This monitor runs OFF the target host (over SSH) and classifies, per
expected GUI-LaunchAgent host, whether the bot user's Aqua session and agent
are present.

These tests exercise the REAL classification + threshold logic with INJECTED
probe results (no live SSH, no mocking of the function under test), per the
project's writing-fail-closed-gates and test-integrity discipline.

Module loader mirrors test_bot_errors_collector_reachability.py.
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from typing import Any

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-gui-session-monitor.py"


def _load_module(extra_env: dict[str, str] | None = None):
    env_backup: dict[str, str | None] = {}
    if extra_env:
        for k, v in extra_env.items():
            env_backup[k] = os.environ.get(k)
            os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location("bot_errors_gui_session_monitor", _SCRIPT)
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        assert spec and spec.loader
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    finally:
        if extra_env:
            for k, orig in env_backup.items():
                if orig is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig


@pytest.fixture(scope="module")
def mod():
    return _load_module()


# ---------------------------------------------------------------------------
# probe-result data structure (injected; never live SSH in tests)
# ---------------------------------------------------------------------------


def _probe(
    *,
    console_owner: Any,
    agent_state: Any,
    console_ok: bool = True,
    agent_ok: bool = True,
    error: str | None = None,
) -> Any:
    """Build a GuiProbeResult-like dict with the injected probe outputs."""
    return {
        "console_owner": console_owner,
        "agent_state": agent_state,
        "console_ok": console_ok,
        "agent_ok": agent_ok,
        "error": error,
    }


# ---------------------------------------------------------------------------
# Test 1: ok — console owner == bot user AND agent running
# ---------------------------------------------------------------------------


def test_classify_ok_when_owner_matches_and_agent_running(mod):
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(console_owner="botuser", agent_state="running"),
    )
    assert result == "ok"


def test_classify_ok_generalizes_to_any_matching_user(mod):
    # Forces the classifier away from any hardcoded username.
    result = mod.classify_gui_session(
        expected_user="ana-bot",
        probe=_probe(console_owner="ana-bot", agent_state="running"),
    )
    assert result == "ok"


# ---------------------------------------------------------------------------
# Test 3: gui_session_absent — console owned by login window (root)
# ---------------------------------------------------------------------------


def test_classify_gui_session_absent_when_console_is_root(mod):
    # The real-world outage shape: /dev/console owned by root at loginwindow.
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(console_owner="root", agent_state="running"),
    )
    assert result == "gui_session_absent"


def test_classify_gui_session_absent_when_other_user_logged_in(mod):
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(console_owner="someoneelse", agent_state="running"),
    )
    assert result == "gui_session_absent"


# ---------------------------------------------------------------------------
# Test 4: agent_unloaded — session present, agent not loaded/running
# ---------------------------------------------------------------------------


def test_classify_agent_unloaded_when_agent_unloaded(mod):
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(console_owner="botuser", agent_state="unloaded"),
    )
    assert result == "agent_unloaded"


def test_classify_agent_unloaded_when_agent_loaded_but_not_running(mod):
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(console_owner="botuser", agent_state="not_running"),
    )
    assert result == "agent_unloaded"


# ---------------------------------------------------------------------------
# Test 5: unreachable — transport failure on either probe (FAIL-CLOSED)
# ---------------------------------------------------------------------------


def test_classify_unreachable_when_console_probe_failed(mod):
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(
            console_owner=None,
            agent_state="running",
            console_ok=False,
            error="ssh: connect to host ... Operation timed out",
        ),
    )
    assert result == "unreachable"


def test_classify_unreachable_when_agent_probe_failed(mod):
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(
            console_owner="botuser",
            agent_state=None,
            agent_ok=False,
            error="ssh: connect to host ... Connection refused",
        ),
    )
    assert result == "unreachable"


def test_unreachable_never_ok_even_if_visible_fields_look_healthy(mod):
    # Defends against masking: a partial success must NEVER read as ok.
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(
            console_owner="botuser",
            agent_state="running",
            agent_ok=False,
        ),
    )
    assert result != "ok"
    assert result == "unreachable"


# ---------------------------------------------------------------------------
# Test 6: inconclusive — empty / garbage probe payload (FAIL-CLOSED)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "console_owner,agent_state",
    [
        ("", "running"),                       # empty console owner
        ("   ", "running"),                    # whitespace console owner
        ("Password:", "running"),              # garbage (permission prompt)
        ("a b c", "running"),                  # multi-token garbage
        ("botuser", ""),                       # empty agent state
        ("botuser", "Could not find service"), # raw launchctl error, not distilled
        ("botuser", "garbage"),                # unknown agent token
    ],
)
def test_classify_inconclusive_on_garbage_payload(mod, console_owner, agent_state):
    result = mod.classify_gui_session(
        expected_user="botuser",
        probe=_probe(console_owner=console_owner, agent_state=agent_state),
    )
    assert result != "ok"
    assert result == "inconclusive"


def test_classify_inconclusive_when_expected_user_unknown(mod):
    # Cannot prove health against an unknown expectation.
    result = mod.classify_gui_session(
        expected_user="",
        probe=_probe(console_owner="botuser", agent_state="running"),
    )
    assert result != "ok"
    assert result == "inconclusive"
