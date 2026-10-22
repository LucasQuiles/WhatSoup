"""BOT ERRORS producers stamp a configured, stable machine identity.

The dispatcher keys incidents on ``machine|instance|source``. Producers used to
stamp the live hostname, and a host without a fixed hostname changes name with
its network: one condition opened one incident per name, and a clear or a
maintenance window under one name never reached the other. Every producer now
stamps ``event_machine()`` from ``lib/bot_errors_envelope.py``. The first
non-blank source wins:

- ``BOT_ERRORS_MACHINE`` in the process environment, stripped;
- the same key in the BOT ERRORS env file (``BOT_ERRORS_ENV_FILE``, else
  ``~/.config/whatsoup/bot-errors.env``), read with the launchd installers'
  awk rules, stripped;
- otherwise ``socket.gethostname()``, unchanged.

Each producer case pins the live hostname to one invented name, configures a
different one and asserts the configured name in the test body. Fixture names
are invented (``host-a.example``, ``host-b.example``, ``stable-a``). HOME, the
env file, the state root and the outbox are temp paths, and the provenance
probes that would inspect the real host are stubbed.
"""
from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from hypothesis import HealthCheck, example, given, settings
from hypothesis import strategies as st

_SCRIPTS = Path(__file__).resolve().parents[1]
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

MACHINE_ENV = "BOT_ERRORS_MACHINE"
ENV_FILE_ENV = "BOT_ERRORS_ENV_FILE"
LIVE_A = "host-a.example"
LIVE_B = "host-b.example"
CONFIGURED = "stable-a"

# Whitespace that str.strip() removes. "\n" is left out of the file values so
# each written value stays on its own line.
_BLANK_CHARS = " \t\n\r\x0b\x0c"
_FILE_BLANK_CHARS = " \t\r\x0b\x0c"

# Each example only sets the environment or rewrites the temp env file before
# it reads, so examples share nothing through the function-scoped fixtures.
_blank_properties = settings(
    max_examples=40, deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)


def _load(filename: str) -> Any:
    name = "machine_identity_" + filename.removesuffix(".py").replace("-", "_")
    spec = importlib.util.spec_from_file_location(name, _SCRIPTS / filename)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _envelope() -> Any:
    return importlib.import_module("lib.bot_errors_envelope")


def _live(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    monkeypatch.setattr(socket, "gethostname", lambda: name)


def _env_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, text: str) -> Path:
    """Point BOT_ERRORS_ENV_FILE at a temp env file holding ``text``."""
    path = tmp_path / "bot-errors.env"
    path.write_text(text, encoding="utf-8")
    monkeypatch.setenv(ENV_FILE_ENV, str(path))
    return path


def _emit_args(event_type: str = "alert") -> argparse.Namespace:
    return argparse.Namespace(
        event_type=event_type,
        clear=event_type == "clear",
        event_id=None,
        severity="critical" if event_type == "alert" else None,
        instance="inst-a",
        source="src-a",
        summary="machine identity probe",
        evidence="probe",
        evidence_file=None,
        log_hint=None,
        diagnostic=None,
        critical_asset_json=None,
        print_path=False,
    )


def _emit_under(monkeypatch: pytest.MonkeyPatch, emit: Any, live: str, event_type: str = "alert") -> dict[str, Any]:
    _live(monkeypatch, live)
    return emit.build_event(_emit_args(event_type))


@pytest.fixture(autouse=True)
def state_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """No configured identity, live hostname LIVE_A, temp HOME, state and outbox.

    HOME is a fresh temp directory, so the default env file does not exist.
    """
    monkeypatch.delenv(MACHINE_ENV, raising=False)
    monkeypatch.delenv(ENV_FILE_ENV, raising=False)
    home = tmp_path / "home"
    home.mkdir()
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    (state / "outbox").mkdir(mode=0o700)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(state / "outbox"))
    _live(monkeypatch, LIVE_A)
    return state


# ---------------------------------------------------------------------------
# The helper
# ---------------------------------------------------------------------------


def test_configured_name_replaces_the_live_hostname(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    assert _envelope().event_machine() == CONFIGURED


def test_unset_falls_back_to_the_live_hostname_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    # No case folding and no domain stripping: a host that never sets the
    # variable must keep the incident keys it already has.
    _live(monkeypatch, "Host-A.Example")
    assert _envelope().event_machine() == "Host-A.Example"


@_blank_properties
@given(blank=st.text(alphabet=_BLANK_CHARS, max_size=6))
@example(blank="")
@example(blank="   ")
@example(blank="\t\n")
def test_blank_configuration_falls_back_to_the_live_hostname(monkeypatch: pytest.MonkeyPatch, blank: str) -> None:
    monkeypatch.setenv(MACHINE_ENV, blank)
    assert _envelope().event_machine() == LIVE_A


def test_configured_name_is_stripped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MACHINE_ENV, "  stable-a \n")
    assert _envelope().event_machine() == CONFIGURED


def test_configuration_is_read_on_every_call(monkeypatch: pytest.MonkeyPatch) -> None:
    event_machine = _envelope().event_machine
    assert event_machine() == LIVE_A
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    assert event_machine() == CONFIGURED
    monkeypatch.delenv(MACHINE_ENV)
    assert event_machine() == LIVE_A


# ---------------------------------------------------------------------------
# The env file, for launch paths that do not load it into their environment
# ---------------------------------------------------------------------------


def test_emitter_takes_the_name_from_the_env_file_when_the_environment_lacks_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _env_file(monkeypatch, tmp_path, f"BOT_ERRORS_MACHINE={CONFIGURED}\n")
    event = _load("bot-errors-emit.py").build_event(_emit_args())
    assert event["machine"] == CONFIGURED


def test_alert_and_clear_under_two_live_hostnames_share_one_key_from_the_env_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The per-bot watchdog's credential page: its LaunchAgent sets no
    # environment, so the name comes from the file, and the clear must reach
    # the incident the alert opened.
    _env_file(monkeypatch, tmp_path, f"BOT_ERRORS_MACHINE={CONFIGURED}\n")
    emit = _load("bot-errors-emit.py")
    dispatcher = _load("bot-errors-dispatcher.py")
    alert = _emit_under(monkeypatch, emit, LIVE_A)
    clear = _emit_under(monkeypatch, emit, LIVE_B, "clear")
    assert clear["eventType"] == "clear"
    assert dispatcher.incident_key(alert) == f"{CONFIGURED}|inst-a|src-a"
    assert dispatcher.incident_key(clear) == f"{CONFIGURED}|inst-a|src-a"


def test_default_env_file_is_bot_errors_env_under_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    default = tmp_path / "home" / ".config" / "whatsoup" / "bot-errors.env"
    default.parent.mkdir(parents=True)
    default.write_text(f"BOT_ERRORS_MACHINE={CONFIGURED}\n", encoding="utf-8")
    assert _envelope().event_machine() == CONFIGURED
    # Empty means the default too, as ${BOT_ERRORS_ENV_FILE:-...} does in the installers.
    monkeypatch.setenv(ENV_FILE_ENV, "")
    assert _envelope().event_machine() == CONFIGURED


def test_environment_wins_over_the_env_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _env_file(monkeypatch, tmp_path, "BOT_ERRORS_MACHINE=stable-file\n")
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    assert _envelope().event_machine() == CONFIGURED


def test_blank_environment_falls_through_to_the_env_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _env_file(monkeypatch, tmp_path, f"BOT_ERRORS_MACHINE={CONFIGURED}\n")
    monkeypatch.setenv(MACHINE_ENV, "   ")
    assert _envelope().event_machine() == CONFIGURED


def test_last_env_file_match_wins(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _env_file(monkeypatch, tmp_path, "BOT_ERRORS_MACHINE=stable-first\nOTHER=1\nBOT_ERRORS_MACHINE=stable-a\n")
    assert _envelope().event_machine() == CONFIGURED


def test_commented_indented_and_other_keys_are_skipped(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _env_file(
        monkeypatch,
        tmp_path,
        "# BOT_ERRORS_MACHINE=stable-comment\n"
        "  #BOT_ERRORS_MACHINE=stable-comment\n"
        "  BOT_ERRORS_MACHINE=stable-indented\n"
        "XBOT_ERRORS_MACHINE=stable-prefixed\n"
        "BOT_ERRORS_MACHINE_ID=stable-longer-key\n",
    )
    assert _envelope().event_machine() == LIVE_A


@_blank_properties
@given(blank=st.text(alphabet=_FILE_BLANK_CHARS, max_size=6))
@example(blank="")
@example(blank="  \t")
def test_blank_env_file_value_falls_through(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, blank: str) -> None:
    _env_file(monkeypatch, tmp_path, f"BOT_ERRORS_MACHINE={blank}\n")
    assert _envelope().event_machine() == LIVE_A


def test_last_env_file_match_wins_even_when_blank(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # As in the awk: a blank last match overrides an earlier value.
    _env_file(monkeypatch, tmp_path, "BOT_ERRORS_MACHINE=stable-a\nBOT_ERRORS_MACHINE=\n")
    assert _envelope().event_machine() == LIVE_A


def test_lone_carriage_return_does_not_end_a_line(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # awk ends a record at "\n" only, so this whole line is one comment and the
    # key after the lone "\r" is never seen.
    path = tmp_path / "bot-errors.env"
    path.write_bytes(b"# ignored\rBOT_ERRORS_MACHINE=stable-b\n")
    monkeypatch.setenv(ENV_FILE_ENV, str(path))
    assert _envelope().configured_machine() is None
    assert _envelope().event_machine() == LIVE_A


def test_missing_env_file_falls_through(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv(ENV_FILE_ENV, str(tmp_path / "absent.env"))
    assert _envelope().configured_machine() is None
    assert _envelope().event_machine() == LIVE_A


def test_directory_env_file_falls_through(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv(ENV_FILE_ENV, str(tmp_path))
    assert _envelope().event_machine() == LIVE_A


def test_unreadable_env_file_falls_through(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # A permission error from the read itself. Raised by a stub, so the result
    # does not depend on the test user's privileges.
    _env_file(monkeypatch, tmp_path, f"BOT_ERRORS_MACHINE={CONFIGURED}\n")

    def denied(self: Path) -> bytes:
        raise PermissionError(13, "Permission denied", str(self))

    monkeypatch.setattr(Path, "read_bytes", denied)
    assert _envelope().event_machine() == LIVE_A


def _release_fifo_reader(fifo: Path) -> None:
    """Open and close the FIFO for writing, so a reader blocked on it sees EOF."""
    try:
        fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
    except OSError:
        return
    os.close(fd)


def test_fifo_env_file_falls_through_without_blocking(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # Only a regular file is read, as the installers' [[ -f ]] guard does:
    # opening a FIFO for reading would block until a writer appears. The read
    # runs in a thread joined with a timeout, so this test cannot hang.
    fifo = tmp_path / "bot-errors.env"
    os.mkfifo(fifo)
    monkeypatch.setenv(ENV_FILE_ENV, str(fifo))
    event_machine = _envelope().event_machine
    results: list[str] = []
    reader = threading.Thread(target=lambda: results.append(event_machine()), daemon=True)
    reader.start()
    reader.join(timeout=5)
    blocked = reader.is_alive()
    if blocked:
        _release_fifo_reader(fifo)
        reader.join(timeout=5)
    assert not blocked
    assert results == [LIVE_A]


def test_quoted_env_file_value_is_taken_raw(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # Like the installers' awk, and unlike systemd's EnvironmentFile=, quotes are kept.
    _env_file(monkeypatch, tmp_path, 'BOT_ERRORS_MACHINE="stable-a"\n')
    assert _envelope().event_machine() == '"stable-a"'


def test_env_file_value_is_stripped(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _env_file(monkeypatch, tmp_path, "BOT_ERRORS_MACHINE=  stable-a \r\n")
    assert _envelope().event_machine() == CONFIGURED


def test_env_file_is_read_on_every_call(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    path = _env_file(monkeypatch, tmp_path, f"BOT_ERRORS_MACHINE={CONFIGURED}\n")
    event_machine = _envelope().event_machine
    assert event_machine() == CONFIGURED
    path.write_text("BOT_ERRORS_MACHINE=stable-b\n", encoding="utf-8")
    assert event_machine() == "stable-b"
    path.unlink()
    assert event_machine() == LIVE_A


# ---------------------------------------------------------------------------
# The incident key across a hostname change
# ---------------------------------------------------------------------------


def test_two_live_hostnames_share_one_incident_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    emit = _load("bot-errors-emit.py")
    dispatcher = _load("bot-errors-dispatcher.py")
    first = _emit_under(monkeypatch, emit, LIVE_A)
    second = _emit_under(monkeypatch, emit, LIVE_B)
    assert dispatcher.incident_key(first) == f"{CONFIGURED}|inst-a|src-a"
    assert dispatcher.incident_key(second) == f"{CONFIGURED}|inst-a|src-a"
    assert dispatcher.incident_scope(first) == f"{CONFIGURED}|inst-a"
    assert dispatcher.incident_scope(second) == f"{CONFIGURED}|inst-a"


def test_control_unset_keeps_one_incident_per_live_hostname(monkeypatch: pytest.MonkeyPatch) -> None:
    # Negative control: passes before and after the change. Without the
    # variable the live hostname still keys the incident, so the two names
    # stay two incidents; the fix is opt-in per host.
    emit = _load("bot-errors-emit.py")
    dispatcher = _load("bot-errors-dispatcher.py")
    first = _emit_under(monkeypatch, emit, LIVE_A)
    second = _emit_under(monkeypatch, emit, LIVE_B)
    assert dispatcher.incident_key(first) == f"{LIVE_A}|inst-a|src-a"
    assert dispatcher.incident_key(second) == f"{LIVE_B}|inst-a|src-a"


def test_default_maintenance_window_covers_events_under_another_live_hostname(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    cli = _load("bot-errors-maintenance.py")
    assert cli.main(["open", "inst-a", "30m"]) == 0
    assert list(cli.load_windows()) == [f"{CONFIGURED}|inst-a"]

    event = _emit_under(monkeypatch, _load("bot-errors-emit.py"), LIVE_B)
    dispatcher = _load("bot-errors-dispatcher.py")
    assert dispatcher.active_maintenance_window(event) == f"planned maintenance for {CONFIGURED}|inst-a"

    capsys.readouterr()
    assert cli.main(["close", "inst-a"]) == 0
    assert json.loads(capsys.readouterr().out) == {"closed": f"{CONFIGURED}|inst-a", "existed": True}
    assert cli.load_windows() == {}


# ---------------------------------------------------------------------------
# Every producer stamps the configured name
# ---------------------------------------------------------------------------


def test_emit_stamps_the_configured_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    event = _load("bot-errors-emit.py").build_event(_emit_args())
    assert event["machine"] == CONFIGURED


def test_runner_stamps_the_configured_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    runner = _load("bot-errors-runner.py")
    monkeypatch.setattr(runner, "safe_observer_provenance", lambda *args: {})
    monkeypatch.setattr(runner, "safe_target_provenance", lambda *args: {})
    monkeypatch.setattr(runner, "safe_release_divergence", lambda *args: {})
    args = runner.parse_args(["--instance", "inst-a", "--source", "src-a", "--summary", "probe", "--", "true"])
    event = runner.build_failure_event(args, ["true"], 1, 5, "", "", "exit_code")
    assert event["machine"] == CONFIGURED


def test_tree_provenance_stamps_the_configured_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    event = _load("bot-errors-tree-provenance.py").build_outbox_event("probe", "probe", "warning")
    assert event["machine"] == CONFIGURED


def test_health_check_event_stamps_the_configured_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    health = _load("bot-errors-health-check.py")
    monkeypatch.setattr(health, "safe_observer_provenance", lambda *args: {})
    path = health.outbox_event("probe", "probe", severity="warning", source="src-a")
    event = json.loads(Path(path).read_text(encoding="utf-8"))
    assert event["machine"] == CONFIGURED


def test_deadman_pages_name_the_configured_machine(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    health = _load("bot-errors-health-check.py")
    episode = {"episodeId": "episode-a", "revision": 1, "onset": {}, "members": {}}
    onset = health._deadman_onset_text(episode, 600).splitlines()
    recovery = health._deadman_recovery_text(episode).splitlines()
    assert f"  > machine: {CONFIGURED}" in onset
    assert f"  > machine: {CONFIGURED}" in recovery


def test_heartbeat_watchdog_stamps_the_configured_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    path = _load("bot-errors-heartbeat-watchdog.py").outbox_event("probe", "probe", "warning", "probe_check")
    event = json.loads(Path(path).read_text(encoding="utf-8"))
    assert event["machine"] == CONFIGURED


def test_collector_stamps_the_configured_name_at_every_emit_site(
    monkeypatch: pytest.MonkeyPatch, state_dir: Path
) -> None:
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    collector = _load("bot-errors-collector.py")
    state: dict[str, Any] = {}
    # First page, then the still-open renotify (cooldown 0), then the recovery.
    collector.enqueue_meta_alert("host-b", "collector-probe", "probe", "probe", state, 0)
    collector.enqueue_meta_alert("host-b", "collector-probe", "probe", "probe", state, 0)
    collector.enqueue_meta_recovery("host-b", "collector-probe", "probe recovered", "probe", state)
    collector.enqueue_writefail_ack_failure(
        "host-b",
        "remote-root",
        {"payload": "{}", "claim": "claim-a", "name": "name-a"},
        "ack_failed",
        state_dir / "local-copy.json",
        RuntimeError("probe"),
        state,
        0,
    )
    collector._emit_collector_outbox_event(
        "host-b", "collector-probe-transition", "alert", "critical", "probe", "probe", "probe_transition"
    )
    events = [json.loads(path.read_text(encoding="utf-8")) for path in sorted((state_dir / "outbox").glob("*.json"))]
    assert len(events) == 5
    assert [event["machine"] for event in events] == [CONFIGURED] * 5


def test_dispatcher_meta_events_stamp_the_configured_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    dispatcher = _load("bot-errors-dispatcher.py")
    paths = dispatcher.setup_dirs()
    orphan_record = {
        "receiptId": "receipt-a",
        "revision": 1,
        "severity": "critical",
        "fingerprint": "fingerprint-a",
        "windowStartEpoch": 1000,
        "windowEndEpoch": 1600,
        "collapsedEvents": 3,
        "affectedHosts": 1,
        "adoptions": 0,
    }
    machines = {
        "dead_letter": dispatcher.dead_letter_meta_event(paths, 1, "probe")["machine"],
        "storm_receipt_orphan": dispatcher.storm_receipt_orphan_event(orphan_record)["machine"],
        "test_provenance": dispatcher.test_provenance_meta_event(paths, 1, 60)["machine"],
        "unrenderable": dispatcher.unrenderable_meta_event({"identity": "identity-a"}, 1)["machine"],
    }
    assert machines == {
        "dead_letter": CONFIGURED,
        "storm_receipt_orphan": CONFIGURED,
        "test_provenance": CONFIGURED,
        "unrenderable": CONFIGURED,
    }


def test_credential_meta_alert_keeps_the_configured_machine_when_hostname_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    dispatcher = _load("bot-errors-dispatcher.py")
    sent: list[str] = []
    monkeypatch.setattr(dispatcher, "send_whatsapp", lambda text, **kwargs: sent.append(text))

    for live in (LIVE_A, LIVE_B):
        _live(monkeypatch, live)
        assert dispatcher.credential_meta_alert(
            "credential-repage-state-lost", "Credential state could not be verified", time.monotonic() + 5,
        ) is not None

    assert len(sent) == 2
    assert all(CONFIGURED in text for text in sent)
    assert all(live not in text for text in sent for live in (LIVE_A, LIVE_B))


def test_dispatcher_poison_page_names_the_configured_machine(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    dispatcher = _load("bot-errors-dispatcher.py")
    paths = dispatcher.setup_dirs()
    poison = paths["processing"] / "poison.json"
    poison.write_text("{not json", encoding="utf-8")
    rendered: list[dict[str, Any]] = []
    real_format_event = dispatcher.format_event

    def capture(event: dict[str, Any]) -> str:
        rendered.append(dict(event))
        return real_format_event(event)

    monkeypatch.setattr(dispatcher, "format_event", capture)
    monkeypatch.setattr(dispatcher, "send_whatsapp", lambda *args, **kwargs: None)
    dispatcher.quarantine_poison(poison, paths["quarantine"], "probe")
    assert [event["machine"] for event in rendered] == [CONFIGURED]


def test_dispatcher_state_records_the_configured_name(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    dispatcher = _load("bot-errors-dispatcher.py")
    paths = dispatcher.setup_dirs()
    dispatcher.record_state(paths)
    assert json.loads(paths["state"].read_text(encoding="utf-8"))["machine"] == CONFIGURED


# Host tools the health check can run. Each is shadowed by a stub that does
# nothing and fails, so the --daily run below reads no service manager,
# keychain, clock, process table or console state of the host it runs on.
_HOST_TOOL_STUBS = (
    "defaults", "launchctl", "ps", "secret-tool", "security", "sntp", "stat",
    "sysctl", "systemctl", "systemsetup", "timedatectl",
)


def test_daily_report_names_the_configured_machine(tmp_path: Path) -> None:
    # The sandbox of the daily-health rendering drill: dry platform probes, an
    # explicit profile, a temp HOME and XDG roots, a send capture file and no
    # email fallback, plus the host-tool stubs first on PATH. The assertion
    # names only the configured machine, never the host's own name.
    state = tmp_path / "daily-state"
    home = tmp_path / "daily-home"
    home.mkdir()
    stubs = tmp_path / "host-tool-stubs"
    stubs.mkdir()
    for tool in _HOST_TOOL_STUBS:
        (stubs / tool).write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        (stubs / tool).chmod(0o755)
    env = {
        "PATH": f"{stubs}:/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": str(home),
        "TMPDIR": str(tmp_path),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local/share"),
        "XDG_STATE_HOME": str(home / ".local/state"),
        "PYTHONDONTWRITEBYTECODE": "1",
        MACHINE_ENV: CONFIGURED,
        "BOT_ERRORS_STATE_DIR": str(state),
        "BOT_ERRORS_OUTBOX_DIR": str(state / "outbox"),
        "BOT_ERRORS_DRY_SEND_CAPTURE": str(tmp_path / "sent.log"),
        "BOT_ERRORS_EMAIL_FALLBACK": str(tmp_path / "absent-email-fallback"),
        "BOT_ERRORS_DRY_SYS_PLATFORM": "linux",
        "BOT_ERRORS_DRY_PLATFORM_SYSTEM": "Linux",
        "BOT_ERRORS_DRY_PLATFORM": "linux",
        "BOT_ERRORS_DRY_PLATFORM_RELEASE": "6.0.0-probe",
        "BOT_ERRORS_DRY_CLOCK_STATUS": "synced",
        "BOT_ERRORS_DRY_DISK_FREE_BYTES": str(10 * 1024 ** 3),
        "BOT_ERRORS_DRY_DISK_TOTAL_BYTES": str(100 * 1024 ** 3),
        "BOT_ERRORS_DRY_UPTIME_SECONDS": "3600",
        "BOT_ERRORS_HEALTH_PROFILE_JSON": json.dumps({
            "role": "bot-host", "expectDispatcher": False, "expectQLoop": False,
            "expectPersonalSocket": False, "expectPersonalTools": False,
            "expectConfigInventory": False, "expectPluginInventory": False,
        }),
    }
    daily = subprocess.run(
        [sys.executable, str(_SCRIPTS / "bot-errors-health-check.py"), "--daily"],
        env=env, capture_output=True, text=True, timeout=60, check=False,
    )
    assert daily.returncode == 0, daily.stderr
    evidence = [json.loads(path.read_text(encoding="utf-8"))["evidence"] for path in (state / "outbox").glob("*.json")]
    machine_lines = [line for text in evidence for line in text.splitlines() if line.startswith("machine: ")]
    assert machine_lines == [f"machine: {CONFIGURED}"]


# ---------------------------------------------------------------------------
# The watchdog's daily-health source for this host
# ---------------------------------------------------------------------------


def _daily_health_watchdog(monkeypatch: pytest.MonkeyPatch) -> Any:
    """The watchdog checking this host and one collector host, with no events."""
    for name in (
        "BOT_ERRORS_DAILY_HEALTH_HOSTS",
        "BOT_ERRORS_LOCAL_DAILY_HEALTH_HOSTS",
        "BOT_ERRORS_DRY_DAILY_HEALTH_AGE_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)
    watchdog = _load("bot-errors-heartbeat-watchdog.py")
    monkeypatch.setattr(watchdog, "collector_configured_hosts", lambda: ["relay-remote"])
    monkeypatch.setattr(watchdog, "optional_daily_health_hosts", lambda: [])
    monkeypatch.setattr(watchdog, "collector_reachability_evidence", lambda host: "")
    return watchdog


def _local_daily_health_keys(monkeypatch: pytest.MonkeyPatch, watchdog: Any, live: str) -> set[str]:
    _live(monkeypatch, live)
    args = argparse.Namespace(max_daily_health_age=3600)
    return set(watchdog.collect_problems(args, checks={"daily_health"})) - {"daily_health:relay-remote"}


def test_two_live_hostnames_share_one_daily_health_source_when_configured(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Configured through the env file, so the source goes through
    # configured_machine() rather than a second read of the environment.
    _env_file(monkeypatch, tmp_path, f"BOT_ERRORS_MACHINE={CONFIGURED}\n")
    watchdog = _daily_health_watchdog(monkeypatch)
    assert _local_daily_health_keys(monkeypatch, watchdog, LIVE_A) == {f"daily_health:{CONFIGURED}"}
    assert _local_daily_health_keys(monkeypatch, watchdog, LIVE_B) == {f"daily_health:{CONFIGURED}"}


def test_control_unset_daily_health_source_keeps_the_lookup_name(monkeypatch: pytest.MonkeyPatch) -> None:
    # Passes before and after the change. Unset, the key is still the
    # normalized lookup name, not the raw hostname, so no open daily-health
    # incident moves at deploy.
    watchdog = _daily_health_watchdog(monkeypatch)
    assert _local_daily_health_keys(monkeypatch, watchdog, "Host-A.Example") == {"daily_health:host-a"}


def test_control_daily_health_lookups_keep_the_lookup_name(monkeypatch: pytest.MonkeyPatch, state_dir: Path) -> None:
    # Passes before and after the change. With a name configured, the ledger
    # and the tracked profile are still looked up by the live lookup name: a
    # fresh ledger entry under it keeps this host out of the problems.
    monkeypatch.setenv(MACHINE_ENV, CONFIGURED)
    watchdog = _daily_health_watchdog(monkeypatch)
    # The ledger shape test_bot_errors_daily_health_freshness_ledger.py writes.
    ledger = {
        "version": 1,
        "openIncidents": {},
        "lastSentAt": {},
        "dailyHealthFreshness": {"host-a": {"lastSeenAt": int(time.time())}},
    }
    (state_dir / watchdog.INCIDENT_STATE).write_text(json.dumps(ledger), encoding="utf-8")
    assert _local_daily_health_keys(monkeypatch, watchdog, LIVE_A) == set()
    assert watchdog.tracked_health_profile() == watchdog.tracked_health_profile_path(watchdog.REPO_ROOT, "host-a")
