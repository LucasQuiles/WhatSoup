#!/usr/bin/env python3
"""External (off-GUI) GUI-session monitor for WhatSoup bot LaunchAgents.

The problem this defends against
--------------------------------
WhatSoup bots are per-user macOS GUI LaunchAgents. When a bot's user logs out of
the GUI (e.g. /dev/console owned by root at the login window), the bot drops AND
the in-GUI heartbeat watchdog dies in the same failure, so the outage is silent.

This monitor runs OFF the target host (over SSH) so it survives the bot user's
GUI logout. For each expected GUI-LaunchAgent host it determines the expected
bot user + agent label + uid from the SSOT (deploy/bot-errors-expected-fleet.json
and deploy/health-profiles/*.json), runs two read-only probes, and classifies
the session state:

  - ok                : console owner == bot user AND agent running
  - gui_session_absent: console owner != bot user / no Aqua session
  - agent_unloaded    : Aqua session present but agent not loaded/running
  - unreachable       : probe failed (SSH/transport)
  - inconclusive      : probe returned empty/garbage output (FAIL-CLOSED)

The probes it WOULD run per host (never executed in unit tests):
  ssh <host> stat -f %Su /dev/console                 -> console owner login
  ssh <host> launchctl print gui/<uid>/<label>        -> agent state

FAIL-CLOSED: unknown / empty / timeout / permission-denied probe results are
NEVER classified ``ok`` — they become ``unreachable`` or ``inconclusive``. A
BOT ERRORS event is emitted (via the existing bot-errors-emit.py outbox) for any
non-ok state, only after a configurable consecutive-failure threshold.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))


# --- classification states -------------------------------------------------

STATE_OK = "ok"
STATE_GUI_SESSION_ABSENT = "gui_session_absent"
STATE_AGENT_UNLOADED = "agent_unloaded"
STATE_UNREACHABLE = "unreachable"
STATE_INCONCLUSIVE = "inconclusive"

NON_OK_STATES = (
    STATE_GUI_SESSION_ABSENT,
    STATE_AGENT_UNLOADED,
    STATE_UNREACHABLE,
    STATE_INCONCLUSIVE,
)

# Distilled agent states (the host-iteration layer maps ``launchctl print``
# output into one of these before handing the probe to the classifier).
AGENT_STATE_RUNNING = "running"
AGENT_STATE_NOT_RUNNING = "not_running"  # loaded but not running (e.g. waiting)
AGENT_STATE_UNLOADED = "unloaded"       # ``Could not find service`` -> not loaded
KNOWN_AGENT_STATES = frozenset(
    {AGENT_STATE_RUNNING, AGENT_STATE_NOT_RUNNING, AGENT_STATE_UNLOADED}
)

# Console-owner values that are syntactically plausible login names. ``stat``
# emits a bare username; empty / whitespace / multi-token output is garbage.
_USERNAME_MAX_LEN = 32


def _is_known_console_owner(value: str) -> bool:
    if not value or len(value) > _USERNAME_MAX_LEN:
        return False
    # A real login name is a single shell-safe token (letters, digits, _, -, .).
    return all(ch.isalnum() or ch in "_-." for ch in value)


def _is_known_agent_state(value: str) -> bool:
    return value in KNOWN_AGENT_STATES


def classify_gui_session(*, expected_user, probe) -> str:
    """Classify GUI-session health from injected probe results (PURE).

    ``probe`` is a mapping with keys:
      console_owner : str | None  -- output of ``stat -f %Su /dev/console``
      agent_state   : str | None  -- distilled launchctl agent state
      console_ok    : bool        -- console probe transport succeeded
      agent_ok      : bool        -- agent probe transport succeeded
      error         : str | None  -- transport/error detail (optional)
    """
    console_owner = _norm(probe.get("console_owner"))
    agent_state = _norm(probe.get("agent_state"))
    expected = _norm(expected_user)

    # FAIL-CLOSED #1: an unknown expectation cannot be proven healthy.
    if not expected:
        return STATE_INCONCLUSIVE

    # FAIL-CLOSED #2: any transport failure on either probe is unreachable —
    # never ``ok``, even if the other probe happened to look fine.
    if not probe.get("console_ok", False) or not probe.get("agent_ok", False):
        return STATE_UNREACHABLE

    # FAIL-CLOSED #3: a transport-success probe with empty/garbage payload is
    # inconclusive (e.g. permission denied, truncated output) — never ``ok``.
    if not _is_known_console_owner(console_owner) or not _is_known_agent_state(agent_state):
        return STATE_INCONCLUSIVE

    # GUI session gone: the login-window owns the console (root) or some other
    # user is logged in — the bot user has no Aqua session, so the agent (and
    # its in-GUI watchdog) is dead.
    if console_owner != expected:
        return STATE_GUI_SESSION_ABSENT

    # Session present but the agent is not actually running.
    if agent_state != AGENT_STATE_RUNNING:
        return STATE_AGENT_UNLOADED

    return STATE_OK


def _norm(value) -> str:
    if value is None:
        return ""
    return str(value).strip()
