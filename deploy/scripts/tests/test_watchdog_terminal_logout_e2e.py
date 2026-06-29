"""End-to-end regression test for the watchdog terminal-loggedOut behavior.

The decision-logic unit tests in test_watchdog_restart_policy.py prove the
embedded Python returns "no restart" for terminal auth failures. But that logic
only runs if the body actually REACHES it. A logged-out bot returns HTTP 503
*with* the body — and the watchdog previously fetched health with `curl --fail`,
which discards the body on 503 and falls into the "health endpoint unreachable
-> restart" path, restart-looping the dead bot.

This test renders the shipped template, stubs `curl` (returns the real 503
logged-out body) and `launchctl` (records every call), runs the whole script,
and asserts the bot was NEVER kickstarted. It pins the body-capture wiring, not
just the decision logic.

Skipped where zsh is unavailable (the template is `#!/bin/zsh`); the decision
logic itself is covered portably by test_watchdog_restart_policy.py.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(shutil.which("zsh") is None, reason="zsh not available")

_TEMPLATE = Path(__file__).resolve().parents[2] / "templates" / "watchdog-script.sh"

# Real ml-bot/mini8 logged-out health body shape (HTTP 503): status unhealthy,
# disconnected, serverside_logout_irreversible / 401. A restart cannot fix it.
_LOGGED_OUT_BODY = (
    '{"status":"unhealthy","whatsapp":{"connected":false,'
    '"connection":{"state":"disconnected",'
    '"auth_failure_class":"serverside_logout_irreversible","last_status_code":401}}}'
)
# A genuinely crashed bot (503, non-terminal) MUST still restart.
_CRASHED_BODY = (
    '{"status":"unhealthy","whatsapp":{"connected":false,'
    '"connection":{"state":"close","auth_failure_class":"none"}}}'
)


def _render(home: Path, bot_port: str = "9999", fleet_port: str = "9998") -> Path:
    text = _TEMPLATE.read_text(encoding="utf-8")
    rendered = (
        text.replace("__HOME__", str(home))
        .replace("BOT_PORT", bot_port)
        .replace("FLEET_PORT", fleet_port)
        .replace("BOT_NAME", "test-bot")
        .replace("USERNAME", os.environ.get("USER", "tester"))
    )
    # The template hardcodes HOME_DIR=/Users/rachel via NODE_BIN/HOME lines that
    # survive token substitution only through __HOME__; force HOME_DIR to our tmp.
    rendered = rendered.replace('HOME_DIR="/Users/rachel"', f'HOME_DIR="{home}"')
    script = home / "test-bot-watchdog"
    script.write_text(rendered, encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


def _make_stubs(home: Path, bot_body: str) -> Path:
    # The watchdog hardcodes its own PATH with $HOME_DIR/.local/bin FIRST (a
    # determinism guard), so injected stubs must live there — a tmp PATH entry
    # would be ignored and the script would hit real curl/launchctl.
    binroot = home / ".local" / "bin"
    binroot.mkdir(parents=True, exist_ok=True)
    calls = binroot / "launchctl.calls"
    # Stub curl: bot health -> body + "\n503" (no --fail in caller); fleet -> "\n200".
    curl = binroot / "curl"
    curl.write_text(
        "#!/bin/sh\n"
        "for a in \"$@\"; do case \"$a\" in *9999/health) "
        f"printf '%s\\n503' '{bot_body}'; exit 0;; "
        "*9998/*) printf 'ok'; exit 0;; esac; done\n"
        "printf '\\n000'; exit 7\n",
        encoding="utf-8",
    )
    curl.chmod(0o755)
    # Stub launchctl: record every call; 'print' reports loaded (exit 0).
    lc = binroot / "launchctl"
    lc.write_text(
        "#!/bin/sh\n"
        f"echo \"$@\" >> '{calls}'\n"
        "case \"$1\" in print) exit 0;; *) exit 0;; esac\n",
        encoding="utf-8",
    )
    lc.chmod(0o755)
    return calls


def _run(tmp_path: Path, bot_body: str) -> str:
    home = tmp_path / "home"
    home.mkdir()
    script = _render(home)
    calls = _make_stubs(home, bot_body)
    # The script's single-instance lock is a fixed /tmp path keyed on BOT_NAME;
    # clear any residue from a prior run so the script doesn't early-exit.
    lock = Path("/tmp/com.whatsoup.test-bot-watchdog.lock")
    if lock.exists():
        try:
            lock.rmdir()
        except OSError:
            shutil.rmtree(lock, ignore_errors=True)
    env = dict(os.environ, HOME=str(home))
    subprocess.run(["zsh", str(script)], env=env, capture_output=True, text=True, timeout=20)
    return calls.read_text(encoding="utf-8") if calls.exists() else ""


def test_logged_out_503_does_not_kickstart_bot(tmp_path):
    calls = _run(tmp_path, _LOGGED_OUT_BODY)
    # The body reached the decision block and the terminal branch declined to
    # restart: no kickstart of the bot label anywhere in the launchctl calls.
    assert "kickstart" not in calls or "com.whatsoup.test-bot" not in calls, (
        f"logged-out bot must not be kickstarted; launchctl calls were:\n{calls}"
    )


def test_crashed_503_still_kickstarts_bot(tmp_path):
    calls = _run(tmp_path, _CRASHED_BODY)
    # Guard against over-suppression: a non-terminal 503 still restarts.
    assert "kickstart" in calls and "com.whatsoup.test-bot" in calls, (
        f"crashed (non-terminal) bot must still be kickstarted; calls were:\n{calls}"
    )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
