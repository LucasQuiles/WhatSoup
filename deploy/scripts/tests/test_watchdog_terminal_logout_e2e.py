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
import shlex
import shutil
import stat
import subprocess
import sys
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
def _recovered_body() -> str:
    # Recovery (the only marker-clearing exit) additionally requires FRESH
    # evidence: the watchdog rejects generated_at older than 60 seconds. The
    # timestamp must therefore be stamped when the consuming test RUNS, never
    # at module scope — a module-level constant ages during collection and the
    # preceding subprocess-heavy tests, and flips recovery to unknown once the
    # import-to-execution gap crosses the freshness window.
    return json.dumps({
        "status": "healthy",
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


_REPO_EMITTER = Path(__file__).resolve().parents[1] / "bot-errors-emit.py"


def _render(
    home: Path,
    bot_name: str,
    bot_port: str = "9999",
    fleet_port: str = "9998",
    emitter: Path = _REPO_EMITTER,
) -> Path:
    text = _TEMPLATE.read_text(encoding="utf-8")
    rendered = (
        text.replace("__BOT_ERRORS_EMIT__", str(emitter))
        .replace("__HOME__", str(home))
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
    env = dict(os.environ, HOME=str(home), BOT_ERRORS_OUTBOX_DIR=str(tmp_path / "outbox"),
               BOT_ERRORS_STATE_DIR=str(tmp_path / "bot-errors-state"))
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
    ("body_source", "marker_setup", "expected_present"),
    [
        # The recovered rows pass the FACTORY, not its result: parametrize
        # decorators evaluate at import, so calling it here would re-create
        # the stale-timestamp defect this indirection exists to prevent.
        (_recovered_body, "absent", False),
        (_recovered_body, "file", False),
        (_UNKNOWN_PROVIDER_BODY, "absent", False),
        (_UNKNOWN_PROVIDER_BODY, "file", True),
        (_LOGGED_OUT_BODY, "file", True),
    ],
)
def test_marker_state_machine_preserves_only_nonrecovery_states(
    tmp_path, body_source, marker_setup, expected_present
):
    body = body_source() if callable(body_source) else body_source
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
        _recovered_body(),
        "marker-remove-fail-bot",
        bot_http="200",
        marker_setup="directory",
    )
    assert rc != 0
    assert marker_present
    assert "kickstart" not in calls


# --- CREDENTIAL-DEAD paging -------------------------------------------------
# The watchdog used to only log CREDENTIAL-DEAD and touch a marker, so a dead
# provider credential paged nobody for hours. It now writes ONE BOT ERRORS alert
# per dead episode to the durable outbox through the shipped emitter
# (deploy/scripts/bot-errors-emit.py) and ONE clear on recovery. A `.paged`
# stamp, written only after the emitter accepted the page, carries the
# transition state across runs; it also counts consecutive failed clears so a
# clear that can never land is abandoned after a bound instead of logging ERROR
# forever.

_REPO_ROOT = Path(__file__).resolve().parents[3]
_REGISTRY = _REPO_ROOT / "src" / "lib" / "fault-taxonomy-registry.json"
_PAGE_SOURCE = "provider_credential_dead"


class _PagingHost:
    def __init__(self, tmp_path: Path, bot_name: str) -> None:
        self.bot = bot_name
        self.home = tmp_path / "home"
        self.home.mkdir()
        token_file = self.home / ".config" / "whatsoup" / "instances" / bot_name / "tokens.env"
        token_file.parent.mkdir(parents=True)
        token_file.write_text(f"WHATSOUP_HEALTH_TOKEN={'a' * 64}\n", encoding="utf-8")
        token_file.chmod(0o600)
        # The emitter path is baked at render time (render-watchdog.py);
        # tests swap what lives at that path instead of setting any env.
        self.emitter = tmp_path / "release" / "deploy" / "scripts" / "bot-errors-emit.py"
        self.emitter.parent.mkdir(parents=True)
        self.stub_calls = tmp_path / "emit.calls"
        self.script = _render(self.home, bot_name, emitter=self.emitter)
        self.logs = self.home / "Library" / "Logs" / "whatsoup"
        self.logs.mkdir(parents=True, exist_ok=True)
        self.marker = self.logs / f"{bot_name}-credential-dead.marker"
        self.stamp = self.logs / f"{bot_name}-credential-dead.paged"
        self.recovered = self.logs / f"{bot_name}-credential-dead.recovered"
        self.outbox = tmp_path / "bot-errors-state" / "outbox"
        self.state = tmp_path / "bot-errors-state"

    def use_real_emitter(self) -> None:
        self.remove_emitter()
        self.emitter.symlink_to(_REPO_EMITTER)

    def use_stub_emitter(self, rc: int) -> None:
        self.remove_emitter()
        self.emitter.write_text(
            "import sys\n"
            f"with open({str(self.stub_calls)!r}, 'a', encoding='utf-8') as fh:\n"
            "    fh.write(' '.join(sys.argv[1:]) + '\\n')\n"
            f"raise SystemExit({rc})\n",
            encoding="utf-8",
        )

    def remove_emitter(self) -> None:
        if self.emitter.exists() or self.emitter.is_symlink():
            self.emitter.unlink()

    def run(self, body: str, http: str = "200") -> subprocess.CompletedProcess:
        _make_stubs(self.home, body, http)
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("BOT_ERRORS_", "WHATSOUP_"))
        }
        env.update(
            HOME=str(self.home),
            BOT_ERRORS_STATE_DIR=str(self.state),
            BOT_ERRORS_OUTBOX_DIR=str(self.outbox),
        )
        return subprocess.run(
            ["zsh", str(self.script)], env=env, capture_output=True, text=True, timeout=30
        )

    def events(self) -> list[dict]:
        if not self.outbox.is_dir():
            return []
        found = [json.loads(p.read_text(encoding="utf-8")) for p in self.outbox.glob("*.json")]
        return sorted(found, key=lambda event: (event["createdAt"], event["eventType"] != "alert"))

    def stub_argv(self) -> list[str]:
        if not self.stub_calls.exists():
            return []
        return [line for line in self.stub_calls.read_text(encoding="utf-8").splitlines() if line]

    def log_text(self) -> str:
        return (self.logs / f"{self.bot}-watchdog.log").read_text(encoding="utf-8")


def test_credential_dead_pages_once_and_clears_once_through_the_durable_outbox(tmp_path):
    host = _PagingHost(tmp_path, "page-bot")
    host.use_real_emitter()

    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    events = host.events()
    assert len(events) == 1, events
    alert = events[0]
    assert alert["eventType"] == "alert"
    assert alert["severity"] == "critical"
    assert alert["instance"] == "page-bot"
    assert alert["source"] == _PAGE_SOURCE
    assert host.marker.exists() and host.stamp.exists()

    assert host.run(_recovered_body()).returncode == 0
    events = host.events()
    assert len(events) == 2, events
    clear = [event for event in events if event["eventType"] == "clear"]
    assert len(clear) == 1, events
    # The clear must key to the SAME incident: machine|instance|source.
    assert clear[0]["instance"] == "page-bot"
    assert clear[0]["source"] == _PAGE_SOURCE
    assert clear[0]["machine"] == alert["machine"]
    assert not host.marker.exists() and not host.stamp.exists()

    assert host.run(_recovered_body()).returncode == 0
    assert len(host.events()) == 2


def test_credential_dead_before_upgrade_still_pages(tmp_path):
    # A host that was already dead (marker present) when this shipped has no
    # stamp; it must page on its next dead cycle, not stay silent forever.
    host = _PagingHost(tmp_path, "predead-bot")
    host.use_real_emitter()
    host.marker.write_text("existing", encoding="utf-8")
    host.marker.chmod(0o600)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    assert [event["eventType"] for event in host.events()] == ["alert"]
    assert host.stamp.exists()


def test_failed_page_leaves_no_stamp_and_retries_next_cycle(tmp_path):
    host = _PagingHost(tmp_path, "pagefail-bot")
    host.use_stub_emitter(rc=1)
    proc = host.run(_DEAD_PROVIDER_BODY)
    assert proc.returncode != 0
    assert not host.stamp.exists()
    assert "ERROR: CREDENTIAL-DEAD page failed" in host.log_text()
    argv = host.stub_argv()
    assert len(argv) == 1, argv
    assert "--instance pagefail-bot" in argv[0]
    assert f"--source {_PAGE_SOURCE}" in argv[0]
    assert "--severity critical" in argv[0]

    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    assert len(host.stub_argv()) == 2  # the failed attempt plus the retry
    assert host.stamp.exists()


def test_missing_emitter_is_an_error_detailed_once_per_episode_and_pages_when_it_appears(tmp_path):
    host = _PagingHost(tmp_path, "noemitter-bot")
    for _ in range(3):
        assert host.run(_DEAD_PROVIDER_BODY).returncode != 0
    assert host.marker.exists()
    assert not host.stamp.exists()
    log_text = host.log_text()
    assert log_text.count("ERROR: BOT ERRORS emitter") == 1
    assert "WARN: BOT ERRORS emitter" not in log_text
    assert log_text.count("CREDENTIAL-DEAD not paged") == 1

    # The once-per-episode WARN must not suppress the page itself.
    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    assert host.stamp.exists()
    assert len(host.stub_argv()) == 1

    # Recovery ends the episode; the next episode warns again.
    assert host.run(_recovered_body()).returncode == 0
    assert not host.stamp.exists()
    host.remove_emitter()
    assert host.run(_DEAD_PROVIDER_BODY).returncode != 0
    assert host.run(_DEAD_PROVIDER_BODY).returncode != 0
    assert host.log_text().count("CREDENTIAL-DEAD not paged") == 2


def test_failed_clear_is_retried_then_abandoned_after_three_attempts(tmp_path):
    host = _PagingHost(tmp_path, "clearfail-bot")
    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    assert host.stamp.exists()

    host.use_stub_emitter(rc=1)
    for attempt in (1, 2):
        proc = host.run(_recovered_body())
        assert proc.returncode != 0, attempt
        assert host.stamp.exists(), attempt
    assert host.log_text().count("ERROR: CREDENTIAL-RECOVERED clear failed") == 2

    proc = host.run(_recovered_body())
    assert proc.returncode == 0
    assert not host.stamp.exists()
    log_text = host.log_text()
    assert "WARN: CREDENTIAL-RECOVERED clear failed 3 consecutive times" in log_text
    assert log_text.count("ERROR: CREDENTIAL-RECOVERED clear failed") == 2

    clears = [line for line in host.stub_argv() if line.startswith("--clear")]
    assert len(clears) == 3, host.stub_argv()
    assert all("--instance clearfail-bot" in line for line in clears)
    assert all(f"--source {_PAGE_SOURCE}" in line for line in clears)

    # Abandoned means abandoned: no further clear attempts.
    assert host.run(_recovered_body()).returncode == 0
    assert len(host.stub_argv()) == 4


def test_a_successful_clear_resets_the_failure_count(tmp_path):
    host = _PagingHost(tmp_path, "clearreset-bot")
    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    host.use_stub_emitter(rc=1)
    assert host.run(_recovered_body()).returncode != 0
    assert host.run(_recovered_body()).returncode != 0
    host.use_stub_emitter(rc=0)
    assert host.run(_recovered_body()).returncode == 0
    assert not host.stamp.exists()

    # A new episode starts from zero: two more failures still retry.
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    host.use_stub_emitter(rc=1)
    assert host.run(_recovered_body()).returncode != 0
    assert host.run(_recovered_body()).returncode != 0
    assert host.stamp.exists()


def test_missing_emitter_on_recovery_abandons_the_clear_after_three_cycles(tmp_path):
    host = _PagingHost(tmp_path, "clearmissing-bot")
    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    host.remove_emitter()
    for attempt in (1, 2):
        assert host.run(_recovered_body()).returncode == 0, attempt
        assert host.stamp.exists(), attempt
    assert host.run(_recovered_body()).returncode == 0
    assert not host.stamp.exists()
    log_text = host.log_text()
    assert "WARN: CREDENTIAL-RECOVERED clear failed 3 consecutive times" in log_text
    assert "ERROR: CREDENTIAL-RECOVERED" not in log_text


def test_recovery_without_a_page_sends_no_clear(tmp_path):
    host = _PagingHost(tmp_path, "quiet-bot")
    host.use_stub_emitter(rc=0)
    assert host.run(_recovered_body()).returncode == 0
    assert host.stub_argv() == []


def test_page_source_is_a_registered_bot_errors_source():
    template = _TEMPLATE.read_text(encoding="utf-8")
    assert f'CRED_ALERT_SOURCE="{_PAGE_SOURCE}"' in template
    registry = json.loads(_REGISTRY.read_text(encoding="utf-8"))
    entry = registry["sourceDispositions"][_PAGE_SOURCE]
    assert entry["owner"] == "deploy/templates/watchdog-script.sh"
    assert entry["test"] == "deploy/scripts/tests/test_watchdog_terminal_logout_e2e.py"
    # Not a WhatsApp-health recovery source: a daily-health WhatsApp recovery
    # must never close a provider-credential incident.
    assert "whatsapp" not in entry["disposition"]


def test_corrupt_clear_count_is_treated_as_the_cap(tmp_path):
    host = _PagingHost(tmp_path, "corruptcount-bot")
    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    host.stamp.write_text("not-a-number\n", encoding="utf-8")
    host.use_stub_emitter(rc=1)
    proc = host.run(_recovered_body())
    assert proc.returncode == 0
    assert not host.stamp.exists()
    log_text = host.log_text()
    assert "WARN: unreadable clear-failure count" in log_text
    assert "ERROR: cannot count failed clears" not in log_text


def test_negative_clear_count_is_treated_as_the_cap(tmp_path):
    # A negative count would otherwise defer the three-attempt cap by up to
    # a million failed clears.
    host = _PagingHost(tmp_path, "negcount-bot")
    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    host.stamp.write_text("-1000000\n", encoding="utf-8")
    host.use_stub_emitter(rc=1)
    assert host.run(_recovered_body()).returncode == 0
    assert not host.stamp.exists()
    assert "WARN: unreadable clear-failure count" in host.log_text()


def test_stamp_left_from_a_recovered_episode_does_not_suppress_the_next_page(tmp_path):
    # Recovery removed the marker and its clear was accepted, but the stamp
    # survived (its removal failed, or the process died first). The next
    # episode must still page.
    host = _PagingHost(tmp_path, "stalestamp-bot")
    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    assert host.run(_recovered_body()).returncode == 0
    assert not host.marker.exists() and not host.stamp.exists()
    assert not host.recovered.exists()
    # Recovery writes the flag before it clears; a stamp that then survives
    # leaves both files behind.
    for path in (host.stamp, host.recovered):
        path.write_text("", encoding="utf-8")
        path.chmod(0o600)

    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    alerts = [line for line in host.stub_argv() if not line.startswith("--clear")]
    assert len(alerts) == 2, host.stub_argv()
    assert "left from a previous episode" in host.log_text()
    assert host.marker.exists() and host.stamp.exists()
    assert not host.recovered.exists()

    # Within one episode the stamp still suppresses repeats.
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    assert len([line for line in host.stub_argv() if not line.startswith("--clear")]) == 2


def test_death_right_after_a_failed_clear_pages_the_new_episode(tmp_path):
    host = _PagingHost(tmp_path, "redeath-bot")
    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    host.use_stub_emitter(rc=1)
    assert host.run(_recovered_body()).returncode != 0
    assert host.stamp.exists() and not host.marker.exists()

    assert host.recovered.exists()

    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    alerts = [line for line in host.stub_argv() if not line.startswith("--clear")]
    assert len(alerts) == 2, host.stub_argv()
    assert host.stamp.exists()
    assert not host.recovered.exists()


def test_a_current_episode_stamp_without_the_recovery_flag_still_suppresses(tmp_path):
    # Control: with no recovery in between, the stamp is this episode's and
    # repeated dead cycles must not page again, whatever the marker's state.
    host = _PagingHost(tmp_path, "curstamp-bot")
    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    host.marker.unlink()
    for _ in range(3):
        assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    alerts = [line for line in host.stub_argv() if not line.startswith("--clear")]
    assert len(alerts) == 1, host.stub_argv()


def test_recovery_flag_is_removed_once_the_stamp_is_gone(tmp_path):
    host = _PagingHost(tmp_path, "flagclean-bot")
    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    host.use_stub_emitter(rc=1)
    assert host.run(_recovered_body()).returncode != 0
    assert host.recovered.exists() and host.stamp.exists()
    host.use_stub_emitter(rc=0)
    assert host.run(_recovered_body()).returncode == 0
    assert not host.stamp.exists() and not host.recovered.exists()


def _alerts(host: _PagingHost) -> list[str]:
    return [line for line in host.stub_argv() if not line.startswith("--clear")]


def _run_with_failing_clear(host: _PagingHost, suffix: str, body: str) -> subprocess.CompletedProcess:
    # The watchdog puts $HOME/.local/bin first on PATH, so this python3 wrapper
    # intercepts the marker helper and fails only `clear` of files ending in
    # `suffix`; every other python3 call runs normally.
    wrapper = host.home / ".local" / "bin" / "python3"
    wrapper.parent.mkdir(parents=True, exist_ok=True)
    wrapper.write_text(
        "#!/bin/sh\n"
        f'if [ "$2" = "clear" ]; then case "$3" in *{suffix}) exit 2;; esac; fi\n'
        f'exec {shlex.quote(sys.executable)} "$@"\n',
        encoding="utf-8",
    )
    wrapper.chmod(0o755)
    try:
        return host.run(body)
    finally:
        wrapper.unlink()


def test_failed_stale_stamp_removal_is_retried_and_then_pages(tmp_path):
    # The stamp of a recovered episode could not be removed. The flag must
    # survive that failure so the next cycle retries and pages; dropping it
    # would turn the stale stamp into permanent suppression.
    host = _PagingHost(tmp_path, "staleretry-bot")
    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    host.marker.unlink()
    host.recovered.write_text("", encoding="utf-8")
    host.recovered.chmod(0o600)

    proc = _run_with_failing_clear(host, ".paged", _DEAD_PROVIDER_BODY)
    assert proc.returncode != 0
    assert "failed to drop stale credential page stamp" in host.log_text()
    assert host.stamp.exists() and host.recovered.exists()
    assert len(_alerts(host)) == 1, host.stub_argv()

    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    assert len(_alerts(host)) == 2, host.stub_argv()
    assert host.stamp.exists() and not host.recovered.exists()


def test_recovery_that_cannot_record_its_flag_changes_nothing(tmp_path):
    # The flag is written before the dead marker goes. When it cannot be
    # written, the marker, the stamp and the open page all stay, so no state
    # exists in which a stamp has lost both its marker and its flag.
    host = _PagingHost(tmp_path, "flagfail-bot")
    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    host.recovered.symlink_to(tmp_path / "missing" / "flag")

    proc = host.run(_recovered_body())
    assert proc.returncode != 0
    assert "failed to record recovery flag" in host.log_text()
    assert host.marker.exists() and host.stamp.exists()
    assert [line for line in host.stub_argv() if line.startswith("--clear")] == []

    host.recovered.unlink()
    assert host.run(_recovered_body()).returncode == 0
    assert not host.marker.exists() and not host.stamp.exists()
    assert not host.recovered.exists()


def test_crash_after_recording_the_flag_still_pages_the_next_episode(tmp_path):
    # State consumption, not ordering: seeds the state a recovery leaves when
    # it dies right after writing the flag (stamp, flag and marker) and checks
    # that a new dead episode pages. The ordering that guarantees this state
    # is covered by test_recovery_that_cannot_record_its_flag_changes_nothing.
    host = _PagingHost(tmp_path, "flagcrash-bot")
    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    host.recovered.write_text("", encoding="utf-8")
    host.recovered.chmod(0o600)

    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    assert len(_alerts(host)) == 2, host.stub_argv()
    assert not host.recovered.exists()


def test_leftover_flag_without_a_stamp_pages_once(tmp_path):
    # Recovery died after removing the stamp but before removing the flag.
    # The next episode pages once; the fresh stamp must not be read as stale.
    host = _PagingHost(tmp_path, "flagonly-bot")
    host.use_stub_emitter(rc=0)
    host.recovered.write_text("", encoding="utf-8")
    host.recovered.chmod(0o600)

    for _ in range(3):
        assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    assert len(_alerts(host)) == 1, host.stub_argv()
    assert host.stamp.exists() and not host.recovered.exists()


def test_failed_leftover_flag_removal_defers_the_page_without_a_duplicate(tmp_path):
    # Paging while a flag cannot be removed would write a stamp beside it, and
    # the next cycle would read that stamp as stale and page again.
    host = _PagingHost(tmp_path, "flagstuck-bot")
    host.use_stub_emitter(rc=0)
    host.recovered.write_text("", encoding="utf-8")
    host.recovered.chmod(0o600)

    proc = _run_with_failing_clear(host, ".recovered", _DEAD_PROVIDER_BODY)
    assert proc.returncode != 0
    assert "page deferred to next cycle" in host.log_text()
    assert _alerts(host) == []
    assert host.recovered.exists() and not host.stamp.exists()

    for _ in range(3):
        assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    assert len(_alerts(host)) == 1, host.stub_argv()
    assert host.stamp.exists() and not host.recovered.exists()


def test_failed_flag_removal_after_a_stale_stamp_defers_the_page_without_a_duplicate(tmp_path):
    host = _PagingHost(tmp_path, "stalestuck-bot")
    host.use_stub_emitter(rc=0)
    assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    host.recovered.write_text("", encoding="utf-8")
    host.recovered.chmod(0o600)

    proc = _run_with_failing_clear(host, ".recovered", _DEAD_PROVIDER_BODY)
    assert proc.returncode != 0
    assert "page deferred to next cycle" in host.log_text()
    assert len(_alerts(host)) == 1, host.stub_argv()
    assert host.recovered.exists() and not host.stamp.exists()

    for _ in range(3):
        assert host.run(_DEAD_PROVIDER_BODY).returncode == 0
    assert len(_alerts(host)) == 2, host.stub_argv()
    assert host.stamp.exists() and not host.recovered.exists()


def test_unsafe_page_stamp_on_recovery_is_an_error(tmp_path):
    host = _PagingHost(tmp_path, "unsafestamp-bot")
    host.use_stub_emitter(rc=0)
    host.stamp.symlink_to(tmp_path / "elsewhere")
    proc = host.run(_recovered_body())
    assert proc.returncode != 0
    assert "ERROR: unsafe credential page stamp" in host.log_text()
    assert host.stub_argv() == []


def test_production_render_bakes_the_release_emitter_and_pages_without_env(tmp_path):
    # The production shape: render-watchdog.py renders from a release tree and
    # bakes that release's emitter; launchd sets no BOT_ERRORS_* variables.
    render_tool = Path(__file__).resolve().parents[1] / "render-watchdog.py"
    home = tmp_path / "home"
    home.mkdir()
    token_file = home / ".config" / "whatsoup" / "instances" / "prod-bot" / "tokens.env"
    token_file.parent.mkdir(parents=True)
    token_file.write_text(f"WHATSOUP_HEALTH_TOKEN={'a' * 64}\n", encoding="utf-8")
    token_file.chmod(0o600)
    script = home / "prod-bot-watchdog"
    proc = subprocess.run(
        [sys.executable, str(render_tool), "render", "--template", str(_TEMPLATE),
         "--bot-name", "prod-bot", "--bot-port", "9999", "--fleet-port", "9998",
         "--home", str(home), "--out", str(script)],
        capture_output=True, text=True, timeout=20,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    rendered = script.read_text(encoding="utf-8")
    assert f'BOT_ERRORS_EMIT="{_REPO_EMITTER}"' in rendered
    assert "BOT_ERRORS_REPO_ROOT" not in rendered
    script.chmod(0o755)
    _make_stubs(home, _DEAD_PROVIDER_BODY, "200")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("BOT_ERRORS_", "WHATSOUP_"))}
    # Only the outbox location is redirected, so the test never writes a live
    # outbox; nothing tells the watchdog where the emitter is.
    env.update(HOME=str(home), BOT_ERRORS_OUTBOX_DIR=str(tmp_path / "outbox"))
    run = subprocess.run(["zsh", str(script)], env=env, capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stderr
    events = [json.loads(p.read_text(encoding="utf-8")) for p in (tmp_path / "outbox").glob("*.json")]
    assert [(e["eventType"], e["instance"], e["source"]) for e in events] == [
        ("alert", "prod-bot", _PAGE_SOURCE)
    ]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
