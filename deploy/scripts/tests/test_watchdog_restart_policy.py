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

The decision tests exercise the *shipped* heredoc by extracting it from the
template and running it under python3. Launchd exit-policy tests render and run
the complete shell script with deterministic curl and launchctl stubs.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
import stat
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


def _extract_decision_block(expected_name: str = "test-agent") -> str:
    text = _TEMPLATE.read_text(encoding="utf-8")
    match = _HEREDOC_RE.search(text)
    assert match, "watchdog template must contain a `python3 - <<'PY'` block"
    return match.group(1).replace("BOT_NAME", expected_name)


def _run_decision(
    health: dict,
    http_status: int = 200,
    expected_name: str = "test-agent",
) -> int:
    """Run the shipped decision block with BOT_JSON=health; return exit code."""
    block = _extract_decision_block(expected_name)
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
    body = {
        "status": status,
        "instance": {"fallbackReason": None},
        "turn_capability": {
            "model_usable": True,
            "model_usable_stale": False,
            "model_usability_status": "usable",
        },
    }
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
        # Accepted drains classify unknown-quiescent (exit 4): no restart,
        # credential marker retained — a drain carries no credential evidence.
        assert _run_decision(self._body(), 503) == 4

    def test_engine_recovery_drain_no_restart(self):
        assert _run_decision(self._body("engine_recovery_required"), 503) == 4

    def test_matching_body_over_http_200_is_restart_worthy(self):
        assert _run_decision(self._body(), 200) != 0

    def test_inspection_body_for_another_instance_is_restart_worthy(self):
        body = self._body()
        body["instance"]["name"] = "other-agent"
        assert _run_decision(body, 503) != 0

    def test_boolean_reconnect_attempts_is_restart_worthy(self):
        body = self._body()
        body["whatsapp"]["connection"]["reconnect_attempts"] = False
        assert _run_decision(body, 503) != 0

    def test_float_reconnect_attempts_is_restart_worthy(self):
        body = self._body()
        body["whatsapp"]["connection"]["reconnect_attempts"] = 0.0
        assert _run_decision(body, 503) != 0

    def test_malformed_inspection_body_is_restart_worthy(self):
        cases = [
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
        ]
        for path, value in cases:
            body = self._body()
            target = body
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            assert _run_decision(body, 503) != 0, (
                f"malformed field must fail closed: path={path!r} value={value!r}"
            )

    def test_partial_inspection_body_is_restart_worthy(self):
        cases = [
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
        ]
        for path in cases:
            body = self._body()
            target = body
            for key in path[:-1]:
                target = target[key]
            del target[path[-1]]
            assert _run_decision(body, 503) != 0, (
                f"missing field must fail closed: path={path!r}"
            )


def _run_rendered_unreachable_watchdog(
    tmp_path: Path,
    *,
    bot_name: str,
    launchd_snapshot: str,
) -> str:
    home = tmp_path / "home"
    home.mkdir(parents=True)
    binroot = home / ".local" / "bin"
    binroot.mkdir(parents=True)
    calls = binroot / "launchctl.calls"

    rendered = (
        _TEMPLATE.read_text(encoding="utf-8")
        .replace("__HOME__", str(home))
        .replace("FLEET_PORT", "9998")
        .replace("BOT_PORT", "9999")
        .replace("BOT_NAME", bot_name)
        .replace("USERNAME", os.environ.get("USER", "tester"))
    )
    script = home / f"{bot_name}-watchdog"
    script.write_text(rendered, encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)

    curl = binroot / "curl"
    curl.write_text(
        "#!/bin/sh\n"
        'for arg in "$@"; do case "$arg" in\n'
        "  *9999/health) exit 7;;\n"
        "  *9998/*) printf 'ok'; exit 0;;\n"
        "esac; done\n"
        "exit 7\n",
        encoding="utf-8",
    )
    curl.chmod(0o755)

    launchctl = binroot / "launchctl"
    launchctl.write_text(
        "#!/bin/sh\n"
        f"printf '%s\\n' \"$*\" >> '{calls}'\n"
        "if [ \"$1\" = print ]; then\n"
        "  printf '%s\\n' \"$LAUNCHD_SNAPSHOT\"\n"
        "fi\n"
        "exit 0\n",
        encoding="utf-8",
    )
    launchctl.chmod(0o755)

    lock = Path(f"/tmp/com.whatsoup.{bot_name}-watchdog.lock")
    if lock.exists():
        shutil.rmtree(lock, ignore_errors=True)
    proc = subprocess.run(
        ["zsh", str(script)],
        env=dict(os.environ, HOME=str(home), LAUNCHD_SNAPSHOT=launchd_snapshot),
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert proc.returncode == 0, proc.stderr
    return calls.read_text(encoding="utf-8")


@pytest.mark.skipif(shutil.which("zsh") is None, reason="zsh not available")
class TestRenderedWatchdogLaunchdExitPolicy:
    def test_unreachable_bot_with_last_exit_78_is_not_kickstarted(self, tmp_path):
        calls = _run_rendered_unreachable_watchdog(
            tmp_path,
            bot_name="permanent-config-bot",
            launchd_snapshot="gui = {\n  state = stopped\n  last exit code = 78\n}",
        )
        bot_prints = [
            call for call in calls.splitlines()
            if call.startswith("print ") and "com.whatsoup.permanent-config-bot" in call
        ]
        assert len(bot_prints) == 2, (
            f"watchdog must inspect bot launchd state before restart policy: {calls!r}"
        )
        assert "kickstart" not in calls, (
            f"permanent launchd exit 78 must not be restarted: {calls!r}"
        )

    def test_unreachable_bot_with_non_78_exit_is_kickstarted(self, tmp_path):
        calls = _run_rendered_unreachable_watchdog(
            tmp_path,
            bot_name="transient-exit-bot",
            launchd_snapshot="gui = {\n  state = stopped\n  last exit code = 1\n}",
        )
        assert "kickstart -k" in calls, (
            f"transient unreachable bot must still be restarted: {calls!r}"
        )
        assert "com.whatsoup.transient-exit-bot" in calls

    def test_running_bot_with_stale_last_exit_78_is_kickstarted(self, tmp_path):
        calls = _run_rendered_unreachable_watchdog(
            tmp_path,
            bot_name="running-stale-exit-bot",
            launchd_snapshot="gui = {\n  state = running\n  last exit code = 78\n}",
        )
        assert "kickstart -k" in calls, (
            f"running state must not inherit a stale permanent-exit fence: {calls!r}"
        )
        assert "com.whatsoup.running-stale-exit-bot" in calls

    def test_clean_last_exit_status_78_is_not_kickstarted(self, tmp_path):
        calls = _run_rendered_unreachable_watchdog(
            tmp_path,
            bot_name="permanent-status-bot",
            launchd_snapshot="gui = {\n  state = stopped\n  last exit status = 78\n}",
        )
        assert "kickstart" not in calls, (
            f"clean stopped/status-78 snapshot must suppress restart: {calls!r}"
        )

    def test_exit_78_with_junk_suffix_is_kickstarted(self, tmp_path):
        calls = _run_rendered_unreachable_watchdog(
            tmp_path,
            bot_name="junk-exit-bot",
            launchd_snapshot="gui = {\n  state = stopped\n  last exit code = 78 garbage\n}",
        )
        assert "kickstart -k" in calls, (
            f"non-numeric exit value must not suppress restart: {calls!r}"
        )

    def test_duplicate_state_fields_are_kickstarted(self, tmp_path):
        calls = _run_rendered_unreachable_watchdog(
            tmp_path,
            bot_name="duplicate-state-bot",
            launchd_snapshot=(
                "gui = {\n  state = stopped\n  state = stopped\n"
                "  last exit code = 78\n}"
            ),
        )
        assert "kickstart -k" in calls, (
            f"duplicate state fields must not suppress restart: {calls!r}"
        )

    def test_conflicting_state_fields_are_kickstarted(self, tmp_path):
        calls = _run_rendered_unreachable_watchdog(
            tmp_path,
            bot_name="conflicting-state-bot",
            launchd_snapshot=(
                "gui = {\n  state = stopped\n  state = running\n"
                "  last exit code = 78\n}"
            ),
        )
        assert "kickstart -k" in calls, (
            f"conflicting state fields must not suppress restart: {calls!r}"
        )

    def test_duplicate_exit_fields_are_kickstarted(self, tmp_path):
        calls = _run_rendered_unreachable_watchdog(
            tmp_path,
            bot_name="duplicate-exit-bot",
            launchd_snapshot=(
                "gui = {\n  state = stopped\n  last exit code = 78\n"
                "  last exit code = 78\n}"
            ),
        )
        assert "kickstart -k" in calls, (
            f"duplicate exit fields must not suppress restart: {calls!r}"
        )

    def test_conflicting_exit_fields_are_kickstarted(self, tmp_path):
        calls = _run_rendered_unreachable_watchdog(
            tmp_path,
            bot_name="conflicting-exit-bot",
            launchd_snapshot=(
                "gui = {\n  state = stopped\n  last exit code = 1\n"
                "  last exit status = 78\n}"
            ),
        )
        assert "kickstart -k" in calls, (
            f"conflicting exit fields must not suppress restart: {calls!r}"
        )

    def test_malformed_or_missing_launchd_fields_are_kickstarted(self, tmp_path):
        cases = [
            ("missing-state", "gui = {\n  last exit code = 78\n}"),
            ("missing-exit", "gui = {\n  state = stopped\n}"),
            ("malformed-state", "gui = {\n  state =\n  last exit code = 78\n}"),
            ("malformed-exit", "gui = {\n  state = stopped\n  last exit code = nope\n}"),
        ]
        for label, snapshot in cases:
            calls = _run_rendered_unreachable_watchdog(
                tmp_path / label,
                bot_name=f"{label}-bot",
                launchd_snapshot=snapshot,
            )
            assert "kickstart -k" in calls, (
                f"{label} snapshot must not suppress restart: {calls!r}"
            )


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
        assert _run_decision(body) == 4

    def test_connecting_with_fresh_pong_no_restart(self):
        body = {
            "status": "degraded",
            "whatsapp": {
                "connected": False,
                "connection": {"state": "connecting", "last_pong_at": _iso_ago(30)},
            },
        }
        assert _run_decision(body) == 4

    def test_cooldown_with_fresh_pong_no_restart(self):
        body = {
            "status": "degraded",
            "whatsapp": {
                "connected": False,
                "connection": {"state": "cooldown", "last_pong_at": _iso_ago(60)},
            },
        }
        assert _run_decision(body) == 4

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
        # Terminal transport-auth states classify unknown-quiescent (exit 4):
        # no restart, and a credential marker survives the outage — a logout
        # says nothing about the provider credential.
        assert _run_decision(self._logged_out("serverside_logout_irreversible")) == 4

    def test_pairing_required_no_restart(self):
        assert _run_decision(self._logged_out("pairing_required")) == 4

    def test_local_corruption_unrestorable_no_restart(self):
        assert _run_decision(self._logged_out("local_corruption_unrestorable")) == 4

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
