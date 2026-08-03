"""Rendered-watchdog final-log ladder and credential-tiering tests.

The TS suite (tests/deploy/watchdog-credential-dead.test.ts) proves the
embedded decision block's exits and statically pins the shell wiring, and
test_watchdog_terminal_logout_e2e.py proves the marker state machine
behaviorally — but neither reads the watchdog's own log. These tests render
the shipped template and run the whole script under zsh with deterministic
curl/launchctl stubs, pinning the FINAL LOG contract
(docs/superpowers/specs/2026-08-03-watchdog-auth-required-contract-design.md):

- the last log line per cycle is one machine-readable state chosen by an
  upgrade-only ladder: CREDENTIAL-DEAD > RESTARTED/RESTART-SUPPRESSED >
  CREDENTIAL-UNKNOWN > ok;
- exit 3 ends on CREDENTIAL-DEAD; a fleet-console restart in the same cycle
  must not overwrite it;
- exits 4/5 end on CREDENTIAL-UNKNOWN only when a marker is present or a
  fallback window is active (exit 5); a quiescent unknown stays "ok";
- restart-worthy cycles end on RESTARTED (kickstart fired) or
  RESTART-SUPPRESSED (cooldown / permanent launchd stop), never "ok", while
  the script's own exit status stays 0.

Skipped where zsh is unavailable (CI installs zsh in quality.yml).
"""

from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import stat
import subprocess
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(shutil.which("zsh") is None, reason="zsh not available")

_TEMPLATE = Path(__file__).resolve().parents[2] / "templates" / "watchdog-script.sh"


def _iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _liveness_ok(**extra) -> str:
    """A liveness-passing authenticated health body, as single-line JSON."""
    body = {
        "status": "healthy",
        "whatsapp": {
            "connected": True,
            "connection": {
                "state": "connected",
                "last_pong_at": _iso_now(),
                "auth_failure_class": "none",
            },
        },
    }
    body.update(extra)
    return json.dumps(body)


def _dead_body() -> str:
    return _liveness_ok(
        turn_capability={"model_usability_status": "credential-unavailable"},
    )


def _unknown_body() -> str:
    return _liveness_ok()  # liveness passes; zero credential evidence -> exit 4


def _fallback_unknown_body() -> str:
    return _liveness_ok(
        instance={"fallbackReason": "usage-limit"},
        turn_capability={
            "model_usable": None,
            "model_usable_stale": True,
            "model_usability_status": "usable",
        },
    )


def _recovered_body() -> str:
    return _liveness_ok(
        instance={"fallbackReason": None},
        turn_capability={
            "model_usable": True,
            "model_usable_stale": False,
            "model_usability_status": "usable",
        },
    )


class Harness:
    """Rendered watchdog + curl/launchctl stubs in an isolated HOME.

    Mirrors the stub pattern of test_watchdog_terminal_logout_e2e.py: the
    template hardcodes PATH with $HOME_DIR/.local/bin first, so stubs must
    live there. Bot names must be unique per test (the /tmp lock is named
    after the bot; xdist would otherwise cross-collide).
    """

    def __init__(self, tmp_path: Path, bot_name: str, bot_body: str, fleet_ok: bool = True):
        self.bot_name = bot_name
        self.home = tmp_path / "home"
        self.home.mkdir(parents=True)
        self.log_dir = self.home / "Library" / "Logs" / "whatsoup"
        self.log_dir.mkdir(parents=True)
        self.log = self.log_dir / f"{bot_name}-watchdog.log"
        self.marker = self.log_dir / f"{bot_name}-credential-dead.marker"
        binroot = self.home / ".local" / "bin"
        binroot.mkdir(parents=True)
        self.calls = binroot / "launchctl.calls"

        rendered = (
            _TEMPLATE.read_text(encoding="utf-8")
            .replace("__HOME__", str(self.home))
            .replace("FLEET_PORT", "9998")
            .replace("BOT_PORT", "9999")
            .replace("BOT_NAME", bot_name)
            .replace("USERNAME", os.environ.get("USER", "tester"))
        )
        self.script = self.home / f"{bot_name}-watchdog"
        self.script.write_text(rendered, encoding="utf-8")
        self.script.chmod(self.script.stat().st_mode | stat.S_IEXEC)
        self.write_curl_stub(bot_body, fleet_ok)

        lc = binroot / "launchctl"
        lc.write_text(
            "#!/bin/sh\n"
            f"echo \"$@\" >> '{self.calls}'\n"
            "exit 0\n",
            encoding="utf-8",
        )
        lc.chmod(0o755)

    def write_curl_stub(self, bot_body: str, fleet_ok: bool = True, bot_unreachable: bool = False):
        bot_line = "exit 7" if bot_unreachable else f"printf '%s\\n200' '{bot_body}'; exit 0"
        fleet_line = "printf 'ok\\n200'; exit 0" if fleet_ok else "exit 7"
        curl = self.home / ".local" / "bin" / "curl"
        curl.write_text(
            "#!/bin/sh\n"
            'for a in "$@"; do case "$a" in\n'
            f"  *9999/health) {bot_line};;\n"
            f"  *9998/*) {fleet_line};;\n"
            "esac; done\n"
            "printf '\\n000'; exit 7\n",
            encoding="utf-8",
        )
        curl.chmod(0o755)

    def seed_restart_stamp(self, job_label: str):
        """Arm the 5-minute restart cooldown for a launchd label."""
        (self.log_dir / f"{job_label}.last-restart").write_text(
            str(int(time.time())), encoding="utf-8"
        )

    def run(self) -> subprocess.CompletedProcess:
        lock = Path(f"/tmp/com.whatsoup.{self.bot_name}-watchdog.lock")
        if lock.exists():
            shutil.rmtree(lock, ignore_errors=True)
        return subprocess.run(
            ["zsh", str(self.script)],
            env=dict(os.environ, HOME=str(self.home)),
            capture_output=True,
            text=True,
            timeout=20,
        )

    def final_log_state(self) -> str:
        """The state token of the LAST log line (lines are '<iso-ts> <state>')."""
        lines = [ln for ln in self.log.read_text(encoding="utf-8").splitlines() if ln.strip()]
        assert lines, "watchdog log is empty"
        return lines[-1].split(" ", 1)[1]

    def launchctl_calls(self) -> str:
        return self.calls.read_text(encoding="utf-8") if self.calls.exists() else ""


def test_dead_final_log_is_credential_dead_no_restart(tmp_path):
    h = Harness(tmp_path, "tier-dead-bot", _dead_body())
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert h.marker.exists(), "exit 3 must create the credential marker"
    assert h.final_log_state() == "CREDENTIAL-DEAD"
    assert "kickstart" not in h.launchctl_calls()


def test_unknown_quiescent_without_marker_logs_ok(tmp_path):
    h = Harness(tmp_path, "tier-quiet-bot", _unknown_body())
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert not h.marker.exists(), "unknown must not create a marker"
    assert h.final_log_state() == "ok"
    assert "kickstart" not in h.launchctl_calls()


def test_unknown_with_marker_present_logs_credential_unknown_and_retains_marker(tmp_path):
    h = Harness(tmp_path, "tier-marked-bot", _unknown_body())
    h.marker.touch()
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert h.marker.exists(), "unknown must retain an existing marker"
    assert h.final_log_state() == "CREDENTIAL-UNKNOWN"
    assert "kickstart" not in h.launchctl_calls()


def test_unknown_with_active_fallback_logs_credential_unknown_without_marker(tmp_path):
    h = Harness(tmp_path, "tier-fallback-bot", _fallback_unknown_body())
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert not h.marker.exists(), "exit 5 must not create a marker"
    assert h.final_log_state() == "CREDENTIAL-UNKNOWN"
    assert "kickstart" not in h.launchctl_calls()


def test_recovered_clears_marker_and_logs_ok(tmp_path):
    h = Harness(tmp_path, "tier-recover-bot", _recovered_body())
    h.marker.touch()
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert not h.marker.exists(), "affirmative recovery must clear the marker"
    assert h.final_log_state() == "ok"


def test_unreachable_bot_final_log_is_restarted(tmp_path):
    h = Harness(tmp_path, "tier-unreach-bot", _unknown_body())
    h.write_curl_stub("", bot_unreachable=True)
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert "kickstart -k" in h.launchctl_calls()
    assert h.final_log_state() == "RESTARTED"


def test_cooldown_suppressed_restart_final_log_is_restart_suppressed(tmp_path):
    h = Harness(tmp_path, "tier-cooldown-bot", _unknown_body())
    h.write_curl_stub("", bot_unreachable=True)
    h.seed_restart_stamp("com.whatsoup.tier-cooldown-bot")
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert "kickstart" not in h.launchctl_calls()
    assert h.final_log_state() == "RESTART-SUPPRESSED"


def test_fleet_console_down_final_log_is_restarted(tmp_path):
    h = Harness(tmp_path, "tier-fleetdown-bot", _recovered_body(), fleet_ok=False)
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert "com.whatsoup.whatsoup-fleet" in h.launchctl_calls()
    assert h.final_log_state() == "RESTARTED"


def test_credential_dead_outranks_fleet_restart(tmp_path):
    # The fleet check runs AFTER the bot verdict; the ladder must keep
    # CREDENTIAL-DEAD on the final line even when the fleet console restarts.
    h = Harness(tmp_path, "tier-dead-fleetdown-bot", _dead_body(), fleet_ok=False)
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert h.final_log_state() == "CREDENTIAL-DEAD"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
