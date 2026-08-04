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

import datetime as dt
import os
import json
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
_DEAD_PROVIDER_BODY = json.dumps({
    "status": "degraded",
    "instance": {"effectiveProvider": "opencode-cli", "fallbackReason": "auth-required"},
    "whatsapp": {"connected": True, "connection": {"state": "connected"}},
    "turn_capability": {
        "model_usable": None,
        "model_usable_stale": True,
        "model_usability_status": "usable",
        "last_turn_error_class": "auth-required",
    },
})
_RECOVERED_PROVIDER_BODY = json.dumps({
    "status": "healthy",
    # Recovery (the only marker-clearing exit) additionally requires FRESH evidence.
    "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    "instance": {"effectiveProvider": "claude-cli", "fallbackReason": None},
    "whatsapp": {"connected": True, "connection": {"state": "connected"}},
    "turn_capability": {
        "model_usable": True,
        "model_usable_stale": False,
        "model_usability_status": "usable",
        "last_turn_error_class": None,
    },
})
_UNKNOWN_PROVIDER_BODY = json.dumps({
    "status": "healthy",
    "instance": {"effectiveProvider": "claude-cli", "fallbackReason": None},
    "whatsapp": {"connected": True, "connection": {"state": "connected"}},
    "turn_capability": {
        "model_usable": None,
        "model_usable_stale": True,
        "model_usability_status": "usable",
        "last_turn_error_class": None,
    },
})


def _render(home: Path, bot_name: str, bot_port: str = "9999", fleet_port: str = "9998") -> Path:
    text = _TEMPLATE.read_text(encoding="utf-8")
    rendered = (
        text.replace("__HOME__", str(home))
        .replace("FLEET_PORT", fleet_port)
        .replace("BOT_PORT", bot_port)
        .replace("BOT_NAME", bot_name)
        .replace("USERNAME", os.environ.get("USER", "tester"))
    )
    # __HOME__ substitution already sets HOME_DIR (template: HOME_DIR="__HOME__").
    script = home / f"{bot_name}-watchdog"
    script.write_text(rendered, encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


def _make_stubs(home: Path, bot_body: str, bot_http: str = "503") -> Path:
    # The watchdog hardcodes its own PATH with $HOME_DIR/.local/bin FIRST (a
    # determinism guard), so injected stubs must live there — a tmp PATH entry
    # would be ignored and the script would hit real curl/launchctl.
    binroot = home / ".local" / "bin"
    binroot.mkdir(parents=True, exist_ok=True)
    calls = binroot / "launchctl.calls"
    # Stub curl. The bot-health endpoint simulates HTTP 503-with-body. Crucially
    # the stub HONORS --fail: real `curl --fail` discards a 503 body and exits 22,
    # so if the watchdog ever regresses to --fail this stub reproduces that and the
    # no-kickstart test fails (a true falsifier, not theater). Fleet -> 200.
    curl = binroot / "curl"
    curl.write_text(
        "#!/bin/sh\n"
        "has_fail=false\n"
        'for a in "$@"; do [ "$a" = "--fail" ] && has_fail=true; done\n'
        'for a in "$@"; do case "$a" in\n'
        "  *9999/health) $has_fail && exit 22; "
        f"printf '%s\\n{bot_http}' '{bot_body}'; exit 0;;\n"
        "  *9998/*) printf 'ok\\n200'; exit 0;;\n"
        "esac; done\n"
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


def _run_with_state(
    tmp_path: Path,
    bot_body: str,
    bot_name: str,
    *,
    bot_http: str = "503",
    marker_setup: str = "absent",
) -> tuple[str, bool, int, int | None]:
    home = tmp_path / "home"
    home.mkdir()
    token_file = home / ".config" / "whatsoup" / "instances" / bot_name / "tokens.env"
    token_file.parent.mkdir(parents=True)
    token_file.write_text(
        f"WHATSOUP_HEALTH_TOKEN={'a' * 64}\n",
        encoding="utf-8",
    )
    token_file.chmod(0o600)
    script = _render(home, bot_name)
    calls = _make_stubs(home, bot_body, bot_http)
    marker = home / "Library" / "Logs" / "whatsoup" / f"{bot_name}-credential-dead.marker"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker_mtime_before = None
    if marker_setup == "file":
        marker.write_text("existing", encoding="utf-8")
        os.utime(marker, ns=(1_000_000_000, 1_000_000_000))
        marker_mtime_before = marker.stat().st_mtime_ns
    elif marker_setup == "directory":
        marker.mkdir()
    elif marker_setup == "dangling-symlink":
        marker.symlink_to(home / "missing-parent" / "marker")
    elif marker_setup != "absent":
        raise AssertionError(f"unsupported marker setup: {marker_setup}")
    env = dict(os.environ, HOME=str(home))
    proc = subprocess.run(
        ["zsh", str(script)], env=env, capture_output=True, text=True, timeout=20
    )
    calls_text = calls.read_text(encoding="utf-8") if calls.exists() else ""
    marker_present = marker.exists() or marker.is_symlink()
    marker_mtime_after = marker.stat().st_mtime_ns if marker.is_file() else None
    if marker_mtime_before is not None and marker_mtime_after is None:
        marker_mtime_after = -1
    return calls_text, marker_present, proc.returncode, marker_mtime_after


def _run(tmp_path: Path, bot_body: str, bot_name: str) -> str:
    calls, _, _, _ = _run_with_state(tmp_path, bot_body, bot_name)
    return calls


def test_logged_out_503_does_not_kickstart_bot(tmp_path):
    calls = _run(tmp_path, _LOGGED_OUT_BODY, "term-bot")
    # Prove the script reached the health check (ensure_loaded -> `launchctl print`)
    # before concluding "no kickstart" — else an early exit passes vacuously.
    assert "print" in calls, f"watchdog never reached launchctl; calls:\n{calls!r}"
    assert "kickstart" not in calls or "com.whatsoup.term-bot" not in calls, (
        f"logged-out bot must not be kickstarted; launchctl calls were:\n{calls}"
    )


def test_logged_out_503_multiline_body_does_not_kickstart(tmp_path):
    # A pretty-printed 503 body (internal newlines) must still parse + suppress
    # through the bash ${bot_resp%$'\\n'*} body extraction.
    import json
    body = json.dumps(json.loads(_LOGGED_OUT_BODY), indent=2)
    calls = _run(tmp_path, body, "term-ml-bot")
    assert "print" in calls, f"watchdog never reached launchctl; calls:\n{calls!r}"
    assert "kickstart" not in calls or "com.whatsoup.term-ml-bot" not in calls, (
        f"multiline logged-out body must not kickstart; calls:\n{calls}"
    )


def test_crashed_503_still_kickstarts_bot(tmp_path):
    calls = _run(tmp_path, _CRASHED_BODY, "crash-bot")
    assert "print" in calls, f"watchdog never reached launchctl; calls:\n{calls!r}"
    # Guard against over-suppression: a non-terminal 503 still restarts.
    assert "kickstart" in calls and "com.whatsoup.crash-bot" in calls, (
        f"crashed (non-terminal) bot must still be kickstarted; calls were:\n{calls}"
    )


@pytest.mark.parametrize("marker_setup", ["absent", "file"])
def test_dead_provider_creates_or_retains_marker_without_restart(tmp_path, marker_setup):
    calls, marker_present, rc, marker_mtime = _run_with_state(
        tmp_path,
        _DEAD_PROVIDER_BODY,
        f"dead-{marker_setup}-bot",
        bot_http="200",
        marker_setup=marker_setup,
    )
    assert rc == 0
    assert marker_present
    assert "kickstart" not in calls
    if marker_setup == "file":
        assert marker_mtime == 1_000_000_000


@pytest.mark.parametrize(
    ("body", "marker_setup", "expected_present"),
    [
        (_RECOVERED_PROVIDER_BODY, "absent", False),
        (_RECOVERED_PROVIDER_BODY, "file", False),
        (_UNKNOWN_PROVIDER_BODY, "absent", False),
        (_UNKNOWN_PROVIDER_BODY, "file", True),
        (_LOGGED_OUT_BODY, "file", True),
    ],
)
def test_marker_state_machine_preserves_only_nonrecovery_states(
    tmp_path, body, marker_setup, expected_present
):
    http = "503" if body == _LOGGED_OUT_BODY else "200"
    calls, marker_present, rc, _ = _run_with_state(
        tmp_path,
        body,
        f"state-{marker_setup}-{abs(hash(body))}-bot",
        bot_http=http,
        marker_setup=marker_setup,
    )
    assert rc == 0
    assert marker_present is expected_present
    assert "kickstart" not in calls


def test_marker_create_failure_is_nonzero(tmp_path):
    calls, marker_present, rc, _ = _run_with_state(
        tmp_path,
        _DEAD_PROVIDER_BODY,
        "marker-create-fail-bot",
        bot_http="200",
        marker_setup="dangling-symlink",
    )
    assert rc != 0
    assert marker_present
    assert "kickstart" not in calls


def test_marker_remove_failure_is_nonzero(tmp_path):
    calls, marker_present, rc, _ = _run_with_state(
        tmp_path,
        _RECOVERED_PROVIDER_BODY,
        "marker-remove-fail-bot",
        bot_http="200",
        marker_setup="directory",
    )
    assert rc != 0
    assert marker_present
    assert "kickstart" not in calls


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
