"""Rendered-watchdog final-log ladder and credential-tiering tests.

The TS suite (tests/deploy/watchdog-credential-dead.test.ts) proves the
embedded decision block's exits and statically pins the shell wiring, and
test_watchdog_terminal_logout_e2e.py proves the marker state machine
behaviorally — but neither reads the watchdog's own log. These tests render
the shipped template and run the whole script under zsh with deterministic
curl/launchctl stubs, pinning the FINAL LOG contract
(docs/superpowers/specs/2026-08-03-watchdog-auth-required-contract-design.md):

- the last log line per cycle is one machine-readable state chosen by an
  upgrade-only ladder: CREDENTIAL-DEAD > RESTARTED/RESTART-SUPPRESSED/
  RESTART-FAILED > CREDENTIAL-UNKNOWN > ok;
- exit 3 ends on CREDENTIAL-DEAD; a fleet-console restart in the same cycle
  must not overwrite it;
- exits 4/5 end on CREDENTIAL-UNKNOWN only when a marker is present or a
  fallback window is active (exit 5); a quiescent unknown stays "ok";
- restart-worthy cycles end on RESTARTED (kickstart returned success),
  RESTART-FAILED (kickstart rejected; cooldown left unarmed), or
  RESTART-SUPPRESSED (cooldown / permanent launchd stop / concurrent-restart
  mutex), never "ok"; clean and suppressed paths exit 0, while a rejected
  kickstart or failed cooldown-stamp write exits nonzero.

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
_VALID_TOKEN = "a" * 64


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
    live there. The single-instance lock lives in the isolated LOG_DIR, so
    tests never collide; bot names stay unique for log readability.
    """

    def __init__(self, tmp_path: Path, bot_name: str, bot_body: str, fleet_ok: bool = True):
        self.bot_name = bot_name
        self.home = tmp_path / "home"
        self.home.mkdir(parents=True)
        self.log_dir = self.home / "Library" / "Logs" / "whatsoup"
        self.log_dir.mkdir(parents=True)
        self.log = self.log_dir / f"{bot_name}-watchdog.log"
        self.marker = self.log_dir / f"{bot_name}-credential-dead.marker"
        self.token_file = (
            self.home / ".config" / "whatsoup" / "instances" / bot_name / "tokens.env"
        )
        self.token_file.parent.mkdir(parents=True)
        self.write_token_file()
        binroot = self.home / ".local" / "bin"
        binroot.mkdir(parents=True)
        self.calls = binroot / "launchctl.calls"
        self.curl_argv = binroot / "curl.argv"
        self.curl_config = binroot / "curl.config"

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
        self.write_launchctl_stub()

    def write_token_file(self, contents: str | None = None, mode: int = 0o600):
        self.token_file.write_text(
            contents if contents is not None else f"WHATSOUP_HEALTH_TOKEN={_VALID_TOKEN}\n",
            encoding="utf-8",
        )
        self.token_file.chmod(mode)

    def write_launchctl_stub(
        self,
        kickstart_rc: int = 0,
        print_body: str = "",
        print_rc: int = 0,
        bootstrap_rc: int = 0,
        make_log_readonly_on_print: bool = False,
    ):
        """Record every call; `print` emits print_body, `kickstart` exits kickstart_rc."""
        lc = self.home / ".local" / "bin" / "launchctl"
        readonly_line = (
            f"  chmod 400 '{self.log}'\n" if make_log_readonly_on_print else ""
        )
        lc.write_text(
            "#!/bin/sh\n"
            f"echo \"$@\" >> '{self.calls}'\n"
            'if [ "$1" = print ]; then\n'
            f"  printf '%s\\n' '{print_body}'\n"
            f"{readonly_line}"
            f"  exit {print_rc}\n"
            "fi\n"
            'if [ "$1" = bootstrap ]; then\n'
            f"  exit {bootstrap_rc}\n"
            "fi\n"
            'if [ "$1" = kickstart ]; then\n'
            f"  exit {kickstart_rc}\n"
            "fi\n"
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
            f"printf '%s\\n' \"$@\" >> '{self.curl_argv}'\n"
            "read_config=0\n"
            "previous=''\n"
            'for a in "$@"; do\n'
            '  [ "$previous" = "--config" ] && [ "$a" = "-" ] && read_config=1\n'
            '  previous="$a"\n'
            "done\n"
            f"[ \"$read_config\" -eq 1 ] && cat >> '{self.curl_config}'\n"
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

    def make_lock(self, pid: int | None, age_seconds: int = 0) -> Path:
        """Pre-create the single-instance lock, optionally pid-stamped and aged."""
        lock = self.log_dir / f"{self.bot_name}-watchdog.lock"
        lock.mkdir()
        if pid is not None:
            (lock / "pid").write_text(str(pid), encoding="utf-8")
        if age_seconds:
            old = time.time() - age_seconds
            os.utime(lock, (old, old))
        return lock

    def run(self) -> subprocess.CompletedProcess:
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
    assert stat.S_IMODE(h.marker.stat().st_mode) == 0o600
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
    h.marker.chmod(0o644)  # Legacy touch-created markers remain upgrade-compatible.
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert h.marker.exists(), "unknown must retain an existing marker"
    assert h.final_log_state() == "CREDENTIAL-UNKNOWN"
    assert "kickstart" not in h.launchctl_calls()


def test_unknown_rejects_group_writable_marker(tmp_path):
    h = Harness(tmp_path, "tier-writable-marker-bot", _unknown_body())
    h.marker.touch()
    h.marker.chmod(0o620)
    proc = h.run()
    assert proc.returncode != 0
    assert h.marker.exists()
    assert h.final_log_state() == "ERROR"
    assert "kickstart" not in h.launchctl_calls()


def test_unknown_with_active_fallback_logs_credential_unknown_without_marker(tmp_path):
    h = Harness(tmp_path, "tier-fallback-bot", _fallback_unknown_body())
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert not h.marker.exists(), "exit 5 must not create a marker"
    assert h.final_log_state() == "CREDENTIAL-UNKNOWN"
    assert "kickstart" not in h.launchctl_calls()


def test_unknown_fallback_with_marker_present_logs_credential_unknown_and_retains_marker(tmp_path):
    # Marker-table row: marker present + active fallback window (exit 5).
    h = Harness(tmp_path, "tier-marked-fallback-bot", _fallback_unknown_body())
    h.marker.touch()
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert h.marker.exists(), "exit 5 must retain an existing marker"
    assert h.final_log_state() == "CREDENTIAL-UNKNOWN"
    assert "kickstart" not in h.launchctl_calls()


def test_permanent_stop_final_log_is_restart_suppressed(tmp_path):
    # launchd reports a clean stopped/exit-78 snapshot: kickstart must be
    # suppressed AND the cycle must end on exactly RESTART-SUPPRESSED.
    h = Harness(tmp_path, "tier-permstop-bot", _unknown_body())
    h.write_curl_stub("", bot_unreachable=True)
    h.write_launchctl_stub(
        print_body="gui = {\n  state = stopped\n  last exit code = 78\n}"
    )
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert "kickstart" not in h.launchctl_calls()
    log_text = h.log.read_text(encoding="utf-8")
    assert "restart suppressed after permanent launchd exit code 78" in log_text
    assert h.final_log_state() == "RESTART-SUPPRESSED"


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


def test_kickstart_failure_final_log_is_restart_failed(tmp_path):
    # A restart that launchctl rejected must not be reported as RESTARTED,
    # and must not arm the cooldown (the next cycle should retry, not sit
    # suppressed for 5 minutes on a restart that never happened).
    h = Harness(tmp_path, "tier-kickfail-bot", _unknown_body())
    h.write_curl_stub("", bot_unreachable=True)
    h.write_launchctl_stub(kickstart_rc=1)
    proc = h.run()
    assert proc.returncode != 0, "a failed restart is an operational failure; exit nonzero"
    assert "kickstart -k" in h.launchctl_calls(), "the restart must at least be attempted"
    log_text = h.log.read_text(encoding="utf-8")
    assert "ERROR: kickstart failed" in log_text
    assert h.final_log_state() == "RESTART-FAILED"
    stamp = h.log_dir / "com.whatsoup.tier-kickfail-bot.last-restart"
    assert not stamp.exists(), "a failed kickstart must not arm the restart cooldown"


def test_cooldown_stamp_write_failure_logs_error_after_successful_kickstart(tmp_path):
    # The stamp path is a directory: the write fails, but the restart itself
    # succeeded — final state stays RESTARTED and the failure is surfaced as
    # an ERROR line instead of silently repeating the restart every cycle.
    h = Harness(tmp_path, "tier-stampfail-bot", _unknown_body())
    h.write_curl_stub("", bot_unreachable=True)
    (h.log_dir / "com.whatsoup.tier-stampfail-bot.last-restart").mkdir()
    proc = h.run()
    assert proc.returncode != 0, "an unarmed cooldown is an operational failure; exit nonzero"
    assert "kickstart -k" in h.launchctl_calls()
    log_text = h.log.read_text(encoding="utf-8")
    assert "ERROR: failed to write restart cooldown stamp" in log_text
    assert h.final_log_state() == "RESTARTED"


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


def test_marker_create_failure_keeps_credential_dead_final_and_exits_nonzero(tmp_path):
    # The old `touch` path followed this dangling symlink and created target.
    h = Harness(tmp_path, "tier-mkfail-bot", _dead_body())
    target_dir = h.home / "attacker-controlled"
    target_dir.mkdir()
    target = target_dir / "marker-target"
    h.marker.symlink_to(target)
    proc = h.run()
    assert proc.returncode != 0, "marker create failure must exit nonzero"
    assert h.marker.is_symlink(), "unsafe marker path must be retained for inspection"
    assert not target.exists(), "marker creation must never follow a symlink"
    log_text = h.log.read_text(encoding="utf-8")
    assert "ERROR: failed to create credential marker" in log_text
    assert h.final_log_state() == "CREDENTIAL-DEAD", (
        "an I/O error must not mask the credential verdict"
    )
    assert "kickstart" not in h.launchctl_calls()


def test_marker_clear_failure_reports_error_final_and_exits_nonzero(tmp_path):
    # A directory is not a valid marker and must never be removed recursively.
    h = Harness(tmp_path, "tier-rmfail-bot", _recovered_body())
    h.marker.mkdir()
    (h.marker / "keep").touch()
    proc = h.run()
    assert proc.returncode != 0, "marker clear failure must exit nonzero"
    assert h.marker.exists(), "failed clear must leave the marker for the next cycle"
    log_text = h.log.read_text(encoding="utf-8")
    assert "ERROR: failed to clear credential marker" in log_text
    assert h.final_log_state() == "ERROR"
    assert "kickstart" not in h.launchctl_calls()


def test_recovery_refuses_dangling_marker_symlink_and_reports_error(tmp_path):
    h = Harness(tmp_path, "tier-rmsymlink-bot", _recovered_body())
    target = h.home / "attacker-controlled" / "marker-target"
    target.parent.mkdir()
    h.marker.symlink_to(target)
    proc = h.run()
    assert proc.returncode != 0
    assert h.marker.is_symlink(), "clear must not unlink an unsafe marker path"
    assert not target.exists()
    assert "ERROR: failed to clear credential marker" in h.log.read_text(encoding="utf-8")
    assert h.final_log_state() == "ERROR"
    assert "kickstart" not in h.launchctl_calls()


def test_unknown_refuses_unsafe_marker_path_instead_of_treating_it_as_absent(tmp_path):
    h = Harness(tmp_path, "tier-unsafe-unknown-bot", _unknown_body())
    target = h.home / "attacker-controlled" / "marker-target"
    target.parent.mkdir()
    h.marker.symlink_to(target)
    proc = h.run()
    assert proc.returncode != 0
    assert h.marker.is_symlink()
    assert not target.exists()
    assert "ERROR: unsafe credential marker" in h.log.read_text(encoding="utf-8")
    assert h.final_log_state() == "ERROR"
    assert "kickstart" not in h.launchctl_calls()


def test_concurrent_fleet_restart_is_suppressed_by_mutex(tmp_path):
    # Every bot watchdog shares the fleet label's cooldown stamp; the
    # check/kickstart critical section must be serialized so same-cadence
    # watchdogs cannot double-kick the fleet console.
    h = Harness(tmp_path, "tier-fleetmutex-bot", _recovered_body(), fleet_ok=False)
    holder = subprocess.Popen(["sleep", "30"])
    try:
        rlock = h.log_dir / "com.whatsoup.whatsoup-fleet.restart.lock"
        rlock.mkdir()
        (rlock / "pid").write_text(str(holder.pid), encoding="utf-8")
        proc = h.run()
        assert proc.returncode == 0, proc.stderr
        assert "kickstart" not in h.launchctl_calls()
        assert "restart already in progress" in h.log.read_text(encoding="utf-8")
        assert h.final_log_state() == "RESTART-SUPPRESSED"
    finally:
        holder.kill()
        holder.wait()


def test_stale_fleet_restart_mutex_is_reclaimed(tmp_path):
    h = Harness(tmp_path, "tier-fleetreclaim-bot", _recovered_body(), fleet_ok=False)
    done = subprocess.Popen(["true"])
    done.wait()
    rlock = h.log_dir / "com.whatsoup.whatsoup-fleet.restart.lock"
    rlock.mkdir()
    (rlock / "pid").write_text(str(done.pid), encoding="utf-8")
    old = time.time() - 3600
    os.utime(rlock, (old, old))
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert "reclaiming stale" in h.log.read_text(encoding="utf-8")
    assert "kickstart -k" in h.launchctl_calls()
    assert h.final_log_state() == "RESTARTED"


def test_garbage_cooldown_stamp_is_ignored_and_logged(tmp_path):
    # A corrupted stamp must not wedge the cooldown check; it reads as
    # unarmed, gets logged, and the restart proceeds.
    h = Harness(tmp_path, "tier-badstamp-bot", _unknown_body())
    h.write_curl_stub("", bot_unreachable=True)
    (h.log_dir / "com.whatsoup.tier-badstamp-bot.last-restart").write_text(
        "not a number\n", encoding="utf-8"
    )
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert "kickstart -k" in h.launchctl_calls()
    log_text = h.log.read_text(encoding="utf-8")
    assert "ignoring unparseable restart cooldown stamp" in log_text
    assert h.final_log_state() == "RESTARTED"


def test_log_open_failure_exits_nonzero_before_acting(tmp_path):
    # If the log cannot be opened, no final state line can ever be written —
    # the watchdog must fail loudly at entry, not run silently unobservable.
    h = Harness(tmp_path, "tier-logfail-bot", _unknown_body())
    h.log.mkdir()
    proc = h.run()
    assert proc.returncode != 0, "an unloggable watchdog run must not report success"
    assert "cannot open log file" in proc.stderr
    assert not h.calls.exists(), "must exit before touching launchd"


def test_live_lock_exits_quietly_with_log_line(tmp_path):
    h = Harness(tmp_path, "tier-heldlock-bot", _unknown_body())
    holder = subprocess.Popen(["sleep", "30"])
    try:
        h.make_lock(pid=holder.pid)
        proc = h.run()
        assert proc.returncode == 0, proc.stderr
        assert "another watchdog invocation is running" in h.log.read_text(encoding="utf-8")
        assert not h.calls.exists(), "a held lock must skip the whole cycle"
    finally:
        holder.kill()
        holder.wait()


def test_stale_lock_with_dead_holder_is_reclaimed(tmp_path):
    # A SIGKILLed prior invocation must not disable the watchdog forever.
    h = Harness(tmp_path, "tier-stalelock-bot", _unknown_body())
    done = subprocess.Popen(["true"])
    done.wait()
    h.make_lock(pid=done.pid, age_seconds=3600)
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    log_text = h.log.read_text(encoding="utf-8")
    assert "reclaiming stale" in log_text
    assert h.final_log_state() == "ok"


def test_lock_without_pid_ages_out_and_is_reclaimed(tmp_path):
    # Crash window: lock dir exists but the pid stamp never landed. It must
    # be reclaimable once aged, not held forever.
    h = Harness(tmp_path, "tier-agedlock-bot", _unknown_body())
    h.make_lock(pid=None, age_seconds=3600)
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    assert "reclaiming stale" in h.log.read_text(encoding="utf-8")
    assert h.final_log_state() == "ok"


@pytest.mark.parametrize(
    ("bot_body", "bot_name"),
    [
        ("", "tier-empty-body-bot"),
        ("not-json", "tier-malformed-json-bot"),
        (json.dumps(["healthy"]), "tier-array-body-bot"),
        (
            json.dumps({"status": "healthy", "whatsapp": []}),
            "tier-whatsapp-array-bot",
        ),
        (
            json.dumps(
                {
                    "status": "healthy",
                    "whatsapp": {"connected": True, "connection": []},
                }
            ),
            "tier-connection-array-bot",
        ),
        (
            json.dumps({"status": "healthy", "whatsapp": {"connected": True}}),
            "tier-missing-connection-bot",
        ),
        (
            json.dumps(
                {
                    "status": "unhealthy",
                    "whatsapp": {
                        "connected": False,
                        "connection": {
                            "state": "close",
                            "last_pong_at": None,
                            "auth_failure_class": "none",
                        },
                    },
                    "instance": {"fallbackReason": None},
                    "turn_capability": ["malformed"],
                }
            ),
            "tier-malformed-capability-liveness-bot",
        ),
    ],
)
def test_untrusted_health_shapes_are_health_unknown_without_restart(
    tmp_path, bot_body, bot_name
):
    h = Harness(tmp_path, bot_name, bot_body)
    h.marker.touch()
    proc = h.run()
    assert proc.returncode == 2
    assert h.final_log_state() == "HEALTH-UNKNOWN"
    assert "kickstart" not in h.launchctl_calls()
    assert h.marker.exists(), "untrusted health evidence must retain the prior marker"


def test_duplicate_turn_capability_is_health_unknown_and_retains_marker(tmp_path):
    bot_body = (
        '{"status":"healthy","whatsapp":{"connected":true,"connection":'
        '{"state":"connected","auth_failure_class":"none"}},'
        '"instance":{"fallbackReason":null},'
        '"turn_capability":{"model_usability_status":"credential-unavailable"},'
        '"turn_capability":{"model_usable":true,"model_usable_stale":false,'
        '"model_usability_status":"usable"}}'
    )
    h = Harness(tmp_path, "tier-duplicate-body-bot", bot_body)
    h.marker.touch()
    proc = h.run()
    assert proc.returncode == 2
    assert h.final_log_state() == "HEALTH-UNKNOWN"
    assert "kickstart" not in h.launchctl_calls()
    assert h.marker.exists()


def test_oversized_health_body_is_health_unknown_before_python(tmp_path):
    h = Harness(
        tmp_path,
        "tier-oversized-body-bot",
        _liveness_ok(padding="x" * 65536),
    )
    proc = h.run()
    assert proc.returncode == 2
    assert h.final_log_state() == "HEALTH-UNKNOWN"
    assert "kickstart" not in h.launchctl_calls()


def test_future_success_cannot_supersede_current_auth_error(tmp_path):
    body = json.loads(_recovered_body())
    body["turn_capability"].update(
        {
            "last_successful_turn_at": "2100-01-01T00:00:00Z",
            "last_turn_error_at": _iso_now(),
            "last_turn_error_class": "auth-required",
        }
    )
    h = Harness(tmp_path, "tier-future-success-bot", json.dumps(body))
    h.marker.touch()
    proc = h.run()
    assert proc.returncode == 2
    assert h.final_log_state() == "HEALTH-UNKNOWN"
    assert "kickstart" not in h.launchctl_calls()
    assert h.marker.exists()


def test_future_pong_is_health_unknown_not_fresh_recovery(tmp_path):
    body = json.loads(_recovered_body())
    body["whatsapp"] = {
        "connected": False,
        "connection": {
            "state": "reconnecting",
            "last_pong_at": "2100-01-01T00:00:00Z",
            "auth_failure_class": "none",
        },
    }
    h = Harness(tmp_path, "tier-future-pong-bot", json.dumps(body))
    proc = h.run()
    assert proc.returncode == 2
    assert h.final_log_state() == "HEALTH-UNKNOWN"
    assert "kickstart" not in h.launchctl_calls()


@pytest.mark.parametrize(
    "token_contents",
    [
        None,
        f'WHATSOUP_HEALTH_TOKEN="{_VALID_TOKEN}"\n',
        (
            f"WHATSOUP_HEALTH_TOKEN={_VALID_TOKEN}\n"
            f"WHATSOUP_HEALTH_TOKEN={'b' * 64}\n"
        ),
    ],
)
def test_missing_or_malformed_token_is_health_unknown_without_bot_curl(
    tmp_path, token_contents
):
    h = Harness(tmp_path, "tier-invalid-token-bot", _recovered_body())
    if token_contents is None:
        h.token_file.unlink()
    else:
        h.write_token_file(token_contents)
    h.marker.touch()
    proc = h.run()
    assert proc.returncode == 2
    assert h.final_log_state() == "HEALTH-UNKNOWN"
    argv_text = h.curl_argv.read_text(encoding="utf-8")
    assert "9999/health" not in argv_text
    assert "--config" not in argv_text
    assert "kickstart" not in h.launchctl_calls()
    assert h.marker.exists()


def test_non_private_token_file_is_health_unknown(tmp_path):
    h = Harness(tmp_path, "tier-token-mode-bot", _recovered_body())
    h.write_token_file(mode=0o644)
    proc = h.run()
    assert proc.returncode == 2
    assert h.final_log_state() == "HEALTH-UNKNOWN"
    assert "9999/health" not in h.curl_argv.read_text(encoding="utf-8")


def test_symlink_token_file_is_health_unknown_without_bot_curl(tmp_path):
    h = Harness(tmp_path, "tier-token-symlink-bot", _recovered_body())
    target = h.token_file.with_name("real-token.env")
    target.write_text(f"WHATSOUP_HEALTH_TOKEN={_VALID_TOKEN}\n", encoding="utf-8")
    target.chmod(0o600)
    h.token_file.unlink()
    h.token_file.symlink_to(target)
    proc = h.run()
    assert proc.returncode == 2
    assert h.final_log_state() == "HEALTH-UNKNOWN"
    argv_text = h.curl_argv.read_text(encoding="utf-8")
    assert "9999/health" not in argv_text
    assert "--config" not in argv_text


def test_group_writable_token_directory_is_health_unknown(tmp_path):
    h = Harness(tmp_path, "tier-token-parent-mode-bot", _recovered_body())
    h.token_file.parent.chmod(0o770)
    try:
        proc = h.run()
    finally:
        h.token_file.parent.chmod(0o700)
    assert proc.returncode == 2
    assert h.final_log_state() == "HEALTH-UNKNOWN"
    argv_text = h.curl_argv.read_text(encoding="utf-8")
    assert "9999/health" not in argv_text
    assert "--config" not in argv_text


def test_valid_token_uses_curl_config_stdin_without_argv_or_environment_leak(tmp_path):
    h = Harness(tmp_path, "tier-token-transport-bot", _recovered_body())
    proc = h.run()
    assert proc.returncode == 0, proc.stderr
    argv_text = h.curl_argv.read_text(encoding="utf-8")
    assert "--config" in argv_text
    assert _VALID_TOKEN not in argv_text
    assert "Authorization" not in argv_text
    assert "-H" not in argv_text.splitlines()
    assert f"Authorization: Bearer {_VALID_TOKEN}" in h.curl_config.read_text(
        encoding="utf-8"
    )


def test_future_cooldown_stamp_does_not_suppress_restart_and_exits_nonzero(tmp_path):
    h = Harness(tmp_path, "tier-future-stamp-bot", _unknown_body())
    h.write_curl_stub("", bot_unreachable=True)
    stamp = h.log_dir / "com.whatsoup.tier-future-stamp-bot.last-restart"
    stamp.write_text("4102444800\n", encoding="utf-8")
    proc = h.run()
    assert proc.returncode != 0
    assert "kickstart -k" in h.launchctl_calls()
    assert h.final_log_state() == "RESTARTED"
    assert int(stamp.read_text(encoding="utf-8")) < 4102444800


def test_future_cooldown_with_failed_kickstart_is_restart_failed(tmp_path):
    h = Harness(tmp_path, "tier-future-stamp-kickfail-bot", _unknown_body())
    h.write_curl_stub("", bot_unreachable=True)
    h.write_launchctl_stub(kickstart_rc=1)
    stamp = h.log_dir / "com.whatsoup.tier-future-stamp-kickfail-bot.last-restart"
    stamp.write_text("4102444800\n", encoding="utf-8")
    proc = h.run()
    assert proc.returncode != 0
    assert "kickstart -k" in h.launchctl_calls()
    assert h.final_log_state() == "RESTART-FAILED"
    assert stamp.read_text(encoding="utf-8") == "4102444800\n"


def test_bootstrap_failure_is_nonzero_and_not_final_ok(tmp_path):
    h = Harness(tmp_path, "tier-bootstrap-fail-bot", _recovered_body())
    h.write_launchctl_stub(print_rc=1, bootstrap_rc=1)
    proc = h.run()
    assert proc.returncode != 0
    assert h.final_log_state() == "ERROR"
    assert "bootstrap" in h.launchctl_calls()


def test_log_rotation_failure_is_nonzero_and_observable(tmp_path):
    h = Harness(tmp_path, "tier-rotation-fail-bot", _recovered_body())
    h.log.write_text("x" * 1048600, encoding="utf-8")
    tail = h.home / ".local" / "bin" / "tail"
    tail.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
    tail.chmod(0o755)
    proc = h.run()
    assert proc.returncode != 0
    assert "rotation" in h.log.read_text(encoding="utf-8").lower()
    assert h.final_log_state() == "ERROR"


def test_post_preflight_log_append_failure_is_nonzero_and_visible_on_stderr(tmp_path):
    if os.geteuid() == 0:
        pytest.skip("root can append despite the permission fixture")
    h = Harness(tmp_path, "tier-log-append-fail-bot", _recovered_body())
    h.write_launchctl_stub(make_log_readonly_on_print=True)
    try:
        proc = h.run()
    finally:
        h.log.chmod(0o600)
    assert proc.returncode != 0
    assert "failed to append to log" in proc.stderr


def test_fleet_kickstart_failure_is_restart_failed_without_cooldown(tmp_path):
    h = Harness(tmp_path, "tier-fleet-kickfail-bot", _recovered_body(), fleet_ok=False)
    h.write_launchctl_stub(kickstart_rc=1)
    proc = h.run()
    assert proc.returncode != 0
    assert h.final_log_state() == "RESTART-FAILED"
    assert "com.whatsoup.whatsoup-fleet" in h.launchctl_calls()
    stamp = h.log_dir / "com.whatsoup.whatsoup-fleet.last-restart"
    assert not stamp.exists()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
