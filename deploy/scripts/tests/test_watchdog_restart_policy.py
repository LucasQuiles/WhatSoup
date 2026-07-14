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


def _run_decision(health: dict, http_status: int = 200) -> int:
    """Run the shipped decision block with BOT_JSON=health; return exit code."""
    block = _extract_decision_block()
    env = dict(os.environ, BOT_JSON=json.dumps(health), BOT_CODE=str(http_status))
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


class TestDatabaseCompatibilityDrainNoRestart:
    """A schema/recovery drain is intentionally alive for inspection. Restarting
    cannot change the binary/schema relationship and can destroy the very hot
    journal evidence that requires operator recovery, so the watchdog must
    recognize the explicit mode before applying generic liveness predicates."""

    @staticmethod
    def _body(reason: str = "future_schema") -> dict:
        return {
            "status": "unhealthy",
            "service_mode": "inspection_only",
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "instance": {
                "name": "test-agent",
                "pid": 123,
                "mode": "inspection_only",
                "socket_path": None,
            },
            "startup_block": {
                "code": reason,
                "retryable": False,
                "operator_action_required": True,
            },
            "whatsapp": {
                "connected": False,
                "account_jid": "not connected",
                "connection": {
                    "state": "not_started",
                    "reconnect_phase": None,
                    "reconnect_attempts": 0,
                    "last_disconnect_reason": "startup_schema_gate",
                    "last_status_code": None,
                    "auth_failure_class": "none",
                },
            },
            "sqlite": {
                "compatibility": reason,
                "schema_ready": False,
                "database_writes_allowed": False,
                "sql_inspection_available": reason == "future_schema",
                "artifact_inspection_available": True,
                "schema_migration_latest": 45 if reason == "future_schema" else None,
                "schema_migration_required": 44,
            },
            "admission": {
                "provider_turns": "blocked",
                "synthetic_turns": "blocked",
            },
            "runtime": {
                "agent": {
                    "started": False,
                    "admission": "blocked",
                    "reason": reason,
                },
            },
            "durability": None,
        }

    def test_future_schema_drain_no_restart(self):
        assert _run_decision(self._body(), 503) == 0

    def test_engine_recovery_drain_no_restart(self):
        assert _run_decision(self._body("engine_recovery_required"), 503) == 0

    def test_matching_body_over_http_200_is_restart_worthy(self):
        assert _run_decision(self._body(), 200) != 0

    @pytest.mark.parametrize(
        ("path", "value"),
        [
            (("status",), "degraded"),
            (("generated_at",), "not-a-date"),
            (("instance", "pid"), 0),
            (("instance", "mode"), "runtime"),
            (("service_mode",), "database_compatibility_drain"),
            (("startup_block", "code"), "unknown"),
            (("startup_block", "retryable"), True),
            (("startup_block", "operator_action_required"), False),
            (("sqlite", "compatibility"), "engine_recovery_required"),
            (("sqlite", "schema_ready"), True),
            (("sqlite", "database_writes_allowed"), True),
            (("sqlite", "schema_migration_latest"), 44),
            (("sqlite", "schema_migration_required"), 46),
            (("sqlite", "sql_inspection_available"), False),
            (("sqlite", "artifact_inspection_available"), False),
            (("admission", "provider_turns"), "open"),
            (("admission", "synthetic_turns"), "open"),
            (("runtime", "agent", "started"), True),
            (("runtime", "agent", "admission"), "open"),
            (("runtime", "agent", "reason"), "engine_recovery_required"),
            (("whatsapp", "connected"), True),
            (("whatsapp", "account_jid"), "present"),
            (("whatsapp", "connection", "state"), "connected"),
        ],
    )
    def test_malformed_inspection_body_is_restart_worthy(self, path, value):
        body = self._body()
        target = body
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
        assert _run_decision(body, 503) != 0

    @pytest.mark.parametrize(
        "path",
        [
            ("startup_block",),
            ("generated_at",),
            ("instance",),
            ("sqlite", "database_writes_allowed"),
            ("sqlite", "schema_migration_latest"),
            ("sqlite", "schema_migration_required"),
            ("admission", "provider_turns"),
            ("admission", "synthetic_turns"),
            ("runtime", "agent"),
            ("whatsapp", "connection"),
            ("durability",),
        ],
    )
    def test_partial_inspection_body_is_restart_worthy(self, path):
        body = self._body()
        target = body
        for key in path[:-1]:
            target = target[key]
        del target[path[-1]]
        assert _run_decision(body, 503) != 0


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


class TestTerminalAuthFailureNoRestart:
    """P1W-2: a terminal auth failure — server-side logout / device_removed,
    pairing required, or unrestorable local corruption — cannot be fixed by a
    restart. Kicking a logged-out bot only replays the cold-start burst against a
    dead bond (the mini8/ml-bot restart-loop risk). These states must NOT
    restart; the bot's own one-shot ``whatsapp_device_bond_lost`` alert already
    pages for human relink, so the watchdog stays silent (no duplicate page).

    The terminal classes mirror ``authFailureIsUnhealthy`` in src/core/health.ts
    (pairing_required / serverside_logout_irreversible / local_corruption_unrestorable),
    surfaced on the health body at ``whatsapp.connection.auth_failure_class``.
    """

    def _logged_out(self, auth_failure_class: str) -> dict:
        return {
            "status": "unhealthy",
            "whatsapp": {
                "connected": False,
                "connection": {
                    "state": "close",
                    "auth_failure_class": auth_failure_class,
                    "last_status_code": 401,
                },
            },
        }

    def test_serverside_logout_irreversible_no_restart(self):
        assert _run_decision(self._logged_out("serverside_logout_irreversible")) == 0

    def test_pairing_required_no_restart(self):
        assert _run_decision(self._logged_out("pairing_required")) == 0

    def test_local_corruption_unrestorable_no_restart(self):
        assert _run_decision(self._logged_out("local_corruption_unrestorable")) == 0

    def test_non_terminal_auth_failure_still_restarts_on_liveness(self):
        # Guard against over-suppression: a non-terminal class ('none') with a
        # hard-down connection must STILL restart — the terminal branch must not
        # swallow ordinary liveness failures.
        body = {
            "status": "unhealthy",
            "whatsapp": {
                "connected": False,
                "connection": {"state": "close", "auth_failure_class": "none"},
            },
        }
        assert _run_decision(body) != 0

    def test_missing_auth_failure_class_still_restarts_on_liveness(self):
        # Older/partial health bodies without the field behave exactly as before.
        body = {
            "status": "unhealthy",
            "whatsapp": {"connected": False, "connection": {"state": "close"}},
        }
        assert _run_decision(body) != 0

    def test_non_terminal_restorable_corruption_still_restarts(self):
        # local_corruption_restorable is NOT terminal (a restart can recover from
        # backup). It must fall through to liveness and restart — guards against a
        # copy-paste error adding it to TERMINAL_AUTH_FAILURES.
        body = {
            "status": "unhealthy",
            "whatsapp": {"connected": False,
                         "connection": {"state": "close",
                                        "auth_failure_class": "local_corruption_restorable"}},
        }
        assert _run_decision(body) != 0


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
