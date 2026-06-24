"""Regression tests for the watchdog bot-health restart policy.

The watchdog (deploy/templates/watchdog-script.sh) restarts an instance via
`launchctl kickstart -k` when its embedded health-decision Python block exits
non-zero. The policy must restart only on genuine *liveness* failures the
restart can fix — health endpoint unreachable, WhatsApp disconnected, stale
pong — and must NOT restart an instance that is merely ``degraded`` while still
connected and serving.

A ``degraded`` status driven by ``binary-model-probe-failed`` (the claude-cli
startup model probe failing) is a provider/auth condition that a restart cannot
resolve. Restarting on it produced a ~6-minute restart loop on eh-bot (mini4):
each kickstart reset the cold-start clock and re-fired instance_unreachable /
outbound_quarantined / primary_model_unusable alerts. These tests pin the
policy so degraded-but-connected never triggers a restart, while real liveness
failures still do.

The tests exercise the *shipped* heredoc logic by extracting it from the
template and running it under python3 — no duplicated decision code.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest


def _iso_ago(seconds: float) -> str:
    """An ISO-8601 UTC timestamp `seconds` in the past (for pong-age fixtures)."""
    return (
        dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=seconds)
    ).strftime("%Y-%m-%dT%H:%M:%S%z")

_TEMPLATE = (
    Path(__file__).resolve().parents[2] / "templates" / "watchdog-script.sh"
)

# Matches the embedded `python3 - <<'PY' ... PY` heredoc that decides restart.
# The opening line may carry a trailing `|| restart_label ...`, so consume the
# rest of that line before the heredoc body.
_HEREDOC_RE = re.compile(r"python3 - <<'PY'[^\n]*\n(.*?)\nPY$", re.DOTALL | re.MULTILINE)


def _extract_decision_block() -> str:
    text = _TEMPLATE.read_text(encoding="utf-8")
    match = _HEREDOC_RE.search(text)
    assert match, "watchdog template must contain a `python3 - <<'PY'` block"
    return match.group(1)


def _run_decision(health: dict) -> int:
    """Run the shipped decision block with BOT_JSON=health; return exit code."""
    block = _extract_decision_block()
    env = dict(os.environ, BOT_JSON=json.dumps(health))
    proc = subprocess.run(
        [sys.executable, "-c", block],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return proc.returncode


_CONNECTED = {
    "whatsapp": {"connected": True, "connection": {"state": "connected"}},
}


def _health(status: str, **overrides) -> dict:
    body = {"status": status}
    body.update(_CONNECTED)
    if overrides:
        body.update(overrides)
    return body


class TestNoRestartWhenConnected:
    def test_healthy_connected_no_restart(self):
        assert _run_decision(_health("healthy")) == 0

    def test_degraded_but_connected_no_restart(self):
        # The headline regression: model-probe degraded must not restart.
        assert _run_decision(_health("degraded")) == 0


class TestRestartOnLivenessFailure:
    def test_unhealthy_status_restarts(self):
        assert _run_decision(_health("unhealthy")) != 0

    def test_disconnected_without_pong_evidence_restarts(self):
        # Disconnected + recovering state but NO pong to prove progress: the
        # policy fails closed and restarts. Liveness cannot be established, so a
        # kick is the safe action. (Formerly test_disconnected_restarts_even_if_degraded.)
        body = {
            "status": "degraded",
            "whatsapp": {
                "connected": False,
                "connection": {"state": "connecting"},
            },
        }
        assert _run_decision(body) != 0

    def test_disconnected_non_recovering_state_restarts_even_with_fresh_pong(self):
        # A non-recovering state (close/disconnected) is NOT exempt: even a fresh
        # pong does not excuse a hung/closed connection.
        body = {
            "status": "degraded",
            "whatsapp": {
                "connected": False,
                "connection": {"state": "close", "last_pong_at": _iso_ago(5)},
            },
        }
        assert _run_decision(body) != 0

    def test_recovering_with_stale_pong_restarts(self):
        # Disconnected + reconnecting but the last pong is ancient: the session is
        # not actually making progress, so restart is still warranted.
        body = {
            "status": "degraded",
            "whatsapp": {
                "connected": False,
                "connection": {
                    "state": "reconnecting",
                    "last_pong_at": "2000-01-01T00:00:00Z",
                },
            },
        }
        assert _run_decision(body) != 0

    def test_unparseable_pong_fails_closed_and_restarts(self):
        # A malformed pong timestamp must not silently pass; it fails closed.
        body = {
            "status": "degraded",
            "whatsapp": {
                "connected": False,
                "connection": {"state": "reconnecting", "last_pong_at": "not-a-date"},
            },
        }
        assert _run_decision(body) != 0


class TestRecoveringConnectionNoRestart:
    """The Lane 0b headline: a disconnected-but-actively-recovering bot with a
    fresh pong is making progress on its own. Restarting it interrupts the
    reconnect, resets the cold-start clock, and replays the startup notification
    — a self-sustaining restart loop (observed on rb-bot/mini7). Such a bot must
    NOT be restarted; its only restart paths are a stale pong or a hard status."""

    def test_reconnecting_with_fresh_pong_no_restart(self):
        body = {
            "status": "degraded",
            "whatsapp": {
                "connected": False,
                "connection": {"state": "reconnecting", "last_pong_at": _iso_ago(10)},
            },
        }
        assert _run_decision(body) == 0

    def test_connecting_with_fresh_pong_no_restart(self):
        body = {
            "status": "degraded",
            "whatsapp": {
                "connected": False,
                "connection": {"state": "connecting", "last_pong_at": _iso_ago(30)},
            },
        }
        assert _run_decision(body) == 0

    def test_cooldown_with_fresh_pong_no_restart(self):
        body = {
            "status": "degraded",
            "whatsapp": {
                "connected": False,
                "connection": {"state": "cooldown", "last_pong_at": _iso_ago(60)},
            },
        }
        assert _run_decision(body) == 0

    def test_bad_connection_state_restarts(self):
        body = {
            "status": "degraded",
            "whatsapp": {
                "connected": True,
                "connection": {"state": "close"},
            },
        }
        assert _run_decision(body) != 0

    def test_stale_pong_restarts(self):
        body = {
            "status": "degraded",
            "whatsapp": {
                "connected": True,
                "connection": {
                    "state": "connected",
                    "last_pong_at": "2000-01-01T00:00:00Z",
                },
            },
        }
        assert _run_decision(body) != 0


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
