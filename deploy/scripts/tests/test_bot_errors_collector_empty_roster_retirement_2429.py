"""#2429 remainder: retiring the LAST configured remote.

``prune_state_to_configured_remotes`` already dispositions every open record a
departed remote owned, but it runs inside ``_run_once_with_state`` and the
process never got there when the roster emptied: ``main()`` answered an empty
poll list with EX_USAGE (64) before opening the state session. Removing the
last remote therefore left its open alert bookkeeping, acknowledgement
membership and remote-record escalation flags in the ledger permanently, with
no ``configuration_retired`` disposition -- the one roster change the pruning
contract did not cover.

Contract pinned here:

- an EXPLICITLY declared empty roster (``--allow-empty-roster``) runs one
  state-only cycle: the departed remote's open records are dispositioned and
  the pruned ledger is saved, and the process exits 0;
- that cycle performs no remote, probe, claim or acknowledgement effect,
  because the cycle body is ``for remote in remotes`` and the roster is empty.
  It is not silent: each retired record's disposition is an info-severity
  observation the dispatcher delivers as a BOT INFO line, so a full retirement
  is one informational message per open record;
- the flag declares an EMPTY poll list, never a MISSING one: with the variable
  absent it stays on the fail-closed path, so a broken environment file cannot
  retire the ledger;
- an UNDECLARED empty roster is unchanged: a missing poll list, and a poll
  list variable that is present but empty, both still fail closed with 64 and
  leave the ledger byte-identical. Inconclusive configuration is not a
  decision to poll nothing;
- a declared empty roster is one-shot: ``--allow-empty-roster`` together with
  ``--daemon`` is refused at the usage boundary, above the state session, so
  the pair can never be parked in a unit and rewrite state on a restart loop.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

_CONFTEST_PATH = Path(__file__).resolve().parent / "conftest.py"
_conftest_spec = importlib.util.spec_from_file_location(
    "bot_errors_collector_test_conftest_2429_empty_roster", _CONFTEST_PATH
)
_conftest = importlib.util.module_from_spec(_conftest_spec)  # type: ignore[arg-type]
_conftest_spec.loader.exec_module(_conftest)  # type: ignore[union-attr]

_env = _conftest._env
_load_mod_with_dirs = _conftest._load_mod_with_dirs
_all_outbox_events = _conftest._all_outbox_events

# Reserved synthetic remote, matching the identity convention the sibling
# pruning-disposition suite uses. No fleet member is named in this file.
REMOTE = "h1.example"

# Every cycle in this suite runs with the poll-list variable explicitly empty
# so a value inherited from the host environment cannot decide the outcome.
_EMPTY_ROSTER_ENV = {"BOT_ERRORS_RELAY_REMOTES": ""}


def _no_remote_effects(stack: ExitStack, mod) -> tuple:
    """Fail every remote seam loudly, and hand back the seams for assertions.

    The declared-empty cycle must not reach any of these. A side effect rather
    than a benign return value means an accidental probe surfaces as an error
    instead of passing silently.
    """
    ssh = stack.enter_context(
        patch.object(mod, "ssh_json_lines", side_effect=AssertionError("empty-roster cycle probed a remote"))
    )
    preflight = stack.enter_context(
        patch.object(
            mod,
            "preflight_remote_unreachable",
            side_effect=AssertionError("empty-roster cycle probed a remote"),
        )
    )
    return ssh, preflight


def _failing_remote(stack: ExitStack, mod) -> None:
    """Make the seeding cycle's single remote fail, so it opens a real alert."""
    stack.enter_context(
        patch.object(mod, "preflight_remote_unreachable", return_value={"status": "found", "online": True})
    )
    stack.enter_context(patch.object(mod, "ssh_json_lines", side_effect=RuntimeError("synthetic transport failure")))
    stack.enter_context(patch.object(mod, "remote_failure_context", return_value=([], {})))


def _main(mod, argv: list[str]) -> int:
    with patch.object(sys, "argv", ["bot-errors-collector.py", *argv]):
        return mod.main()


def _event_files(outbox_dir: Path) -> set[Path]:
    return set(outbox_dir.glob("*.json"))


def _dispositions(outbox_dir: Path) -> list[dict]:
    found = []
    for event in _all_outbox_events(outbox_dir):
        diagnostics = event.get("diagnostics")
        if isinstance(diagnostics, dict) and diagnostics.get("disposition") == "configuration_retired":
            found.append(event)
    return found


def _seed_open_alert_through_a_real_cycle(mod, state_dir: Path) -> dict:
    """Cycle 1: one configured remote whose claim fails, opening a real alert.

    The state this suite retires is minted by the collector's own alerting
    path, not written by the test, so the retirement is proved against the
    ledger production actually produces.
    """
    with ExitStack() as stack:
        _failing_remote(stack, mod)
        _main(mod, ["--remote", REMOTE, "--alert-cooldown", "0"])
    state = json.loads((state_dir / "collector-state.json").read_text())
    assert state["configuredRemotes"] == [REMOTE]
    assert f"{REMOTE}:remote-claim-failed" in state["openAlerts"]
    assert f"{REMOTE}:remote-claim-failed" in state["alerts"]
    assert REMOTE in state["remotes"]
    return state


# --- RED: the last remote's open state was never dispositioned --------------


def test_removing_the_last_configured_remote_retires_its_open_alert(tmp_state):
    """End to end through main(): one remote, a cycle, no remotes, a cycle."""
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir, _EMPTY_ROSTER_ENV):
        mod = _load_mod_with_dirs(state_dir, outbox_dir, _EMPTY_ROSTER_ENV)
        _seed_open_alert_through_a_real_cycle(mod, state_dir)
        state_file = state_dir / "collector-state.json"
        before = state_file.read_bytes()
        assert _dispositions(outbox_dir) == []

        # Cycle 2: the operator has removed the last remote and says so.
        with ExitStack() as stack:
            _no_remote_effects(stack, mod)
            rc = _main(mod, ["--allow-empty-roster"])

        assert rc == 0
        emitted = _dispositions(outbox_dir)
        assert len(emitted) == 1
        disposition = emitted[0]
        assert disposition["source"] == "remote-claim-failed"
        assert disposition["eventType"] == "observation"
        assert disposition["diagnostics"]["dispositionStateLocation"] == mod.ALERT_STATE_OPEN_ALERTS
        assert disposition["diagnostics"]["priorStatus"] == "open"
        assert disposition["diagnostics"]["recoveryClaimed"] is False

        # The pruned ledger was saved, not just pruned in memory.
        assert state_file.read_bytes() != before
        saved = json.loads(state_file.read_text())
        assert saved["configuredRemotes"] == []
        assert saved["openAlerts"] == {}
        assert saved["alerts"] == {}
        assert saved["remotes"] == {}


def test_the_declared_empty_cycle_dispositions_acknowledgement_membership(tmp_state):
    """The ack bucket is digest-keyed, so no failing cycle can mint it here.

    It is seeded through the collector's own session writer -- the same route
    the sibling suite's cycle-level test uses -- because the retirement
    contract covers all three state locations, not only openAlerts.
    """
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir, _EMPTY_ROSTER_ENV):
        mod = _load_mod_with_dirs(state_dir, outbox_dir, _EMPTY_ROSTER_ENV)
        session = mod.open_collector_state_session()
        try:
            payload, capability = mod._load_collector_state_for_cycle(session)
            payload["remotes"] = {REMOTE: {}}
            payload["writefailAckFailures"] = {
                "digest-a": {"remote": REMOTE},
                "digest-b": {"remote": REMOTE},
            }
            mod.save_collector_state(session, payload, capability)
        finally:
            session.close()

        with ExitStack() as stack:
            _no_remote_effects(stack, mod)
            rc = _main(mod, ["--allow-empty-roster"])

        assert rc == 0
        emitted = _dispositions(outbox_dir)
        assert len(emitted) == 1
        diagnostics = emitted[0]["diagnostics"]
        assert emitted[0]["source"] == "remote-writefail-ack-failed"
        assert diagnostics["dispositionStateLocation"] == mod.ALERT_STATE_ACK_FAILURES
        # One disposition carrying the count, not one per digest-keyed record.
        assert diagnostics["retiredRecordCount"] == 2
        saved = json.loads((state_dir / "collector-state.json").read_text())
        assert saved["writefailAckFailures"] == {}


def test_the_declared_empty_cycle_performs_no_remote_effects(tmp_state):
    """No probe, claim or acknowledgement effect: the seams are never reached.

    "No effects" is scoped deliberately. The cycle DOES publish, one
    info-severity disposition per retired record, which the dispatcher
    delivers as a BOT INFO line. What it must not do is touch a remote.

    The outbox assertion is a whitelist over the events THIS cycle added, not
    a blacklist of a few known-bad types. Naming only the types the cycle must
    not mint would let an unforeseen envelope -- a new escalation tier, a
    recovery, a health record -- pass unnoticed, which is exactly the hole a
    "no effects" claim has to close. A delta is also required rather than
    merely tidy: the seeding cycle mints a critical ``alert`` envelope, so an
    assertion phrased over the whole outbox would trip on state this test did
    not create.
    """
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir, _EMPTY_ROSTER_ENV):
        mod = _load_mod_with_dirs(state_dir, outbox_dir, _EMPTY_ROSTER_ENV)
        _seed_open_alert_through_a_real_cycle(mod, state_dir)
        before = _event_files(outbox_dir)

        with ExitStack() as stack:
            ssh, preflight = _no_remote_effects(stack, mod)
            rc = _main(mod, ["--allow-empty-roster"])

        assert rc == 0
        assert ssh.call_count == 0
        assert preflight.call_count == 0

        added = sorted(_event_files(outbox_dir) - before)
        assert added, "the cycle published nothing, so the whitelist proves nothing"
        for path in added:
            event = json.loads(path.read_text())
            diagnostics = event.get("diagnostics") or {}
            assert event.get("eventType") == "observation", event.get("eventType")
            assert diagnostics.get("disposition") == "configuration_retired", diagnostics.get("disposition")
            assert diagnostics.get("recoveryClaimed") is False


# --- negative controls: an UNDECLARED empty roster is unchanged -------------


def test_a_missing_poll_list_still_fails_closed_with_no_state_effect(tmp_state, capsys):
    """Configuration missing is inconclusive, not a declared retirement."""
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir):
        mod = _load_mod_with_dirs(state_dir, outbox_dir)
        _seed_open_alert_through_a_real_cycle(mod, state_dir)
        state_file = state_dir / "collector-state.json"
        before = state_file.read_bytes()
        capsys.readouterr()

        # The poll-list variable is absent entirely for this cycle.
        with patch.dict("os.environ"):
            import os

            os.environ.pop("BOT_ERRORS_RELAY_REMOTES", None)
            with ExitStack() as stack:
                _no_remote_effects(stack, mod)
                rc = _main(mod, [])

        assert rc == 64
        assert "no remotes configured" in capsys.readouterr().err
        # Nothing loaded, nothing pruned, nothing saved, nothing published.
        assert state_file.read_bytes() == before
        assert _dispositions(outbox_dir) == []


def test_a_present_but_empty_poll_list_still_fails_closed(tmp_state, capsys):
    """Present-but-empty is the same inconclusive configuration, not a decision.

    This is the contract the TypeScript suite already pins for the spawned
    process; it is pinned here too because this change adds the one flag that
    is allowed to move it, and nothing else may.
    """
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir, _EMPTY_ROSTER_ENV):
        mod = _load_mod_with_dirs(state_dir, outbox_dir, _EMPTY_ROSTER_ENV)
        _seed_open_alert_through_a_real_cycle(mod, state_dir)
        state_file = state_dir / "collector-state.json"
        before = state_file.read_bytes()
        capsys.readouterr()

        with ExitStack() as stack:
            _no_remote_effects(stack, mod)
            rc = _main(mod, [])

        assert rc == 64
        assert "no remotes configured" in capsys.readouterr().err
        assert state_file.read_bytes() == before
        assert _dispositions(outbox_dir) == []


def test_a_configured_roster_is_unaffected_by_the_flag(tmp_state):
    """The flag permits an empty roster; it never suppresses a real one."""
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir, _EMPTY_ROSTER_ENV):
        mod = _load_mod_with_dirs(state_dir, outbox_dir, _EMPTY_ROSTER_ENV)
        with ExitStack() as stack:
            _failing_remote(stack, mod)
            rc = _main(mod, ["--remote", REMOTE, "--allow-empty-roster", "--alert-cooldown", "0"])

        # The remote was polled and failed, exactly as without the flag.
        assert rc == 1
        saved = json.loads((state_dir / "collector-state.json").read_text())
        assert saved["configuredRemotes"] == [REMOTE]
        assert f"{REMOTE}:remote-claim-failed" in saved["openAlerts"]
        assert _dispositions(outbox_dir) == []


def test_an_unregistered_key_still_fails_the_declared_empty_cycle_closed(tmp_state, capsys):
    """The empty roster retires everything, so it must still fail closed.

    An empty roster makes every bucket key a retiring key, which is the widest
    reach the validation pass ever has. It must not become the one path that
    prunes an unregistered source silently. Asserted at the process boundary,
    where main() turns the refusal into the estate's typed state exit and one
    bounded line -- a count and an opaque digest, never the key itself.
    """
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir, _EMPTY_ROSTER_ENV):
        mod = _load_mod_with_dirs(state_dir, outbox_dir, _EMPTY_ROSTER_ENV)
        session = mod.open_collector_state_session()
        try:
            payload, capability = mod._load_collector_state_for_cycle(session)
            payload["remotes"] = {REMOTE: {}}
            payload["openAlerts"] = {f"{REMOTE}:collector-disk-full": {"status": "open"}}
            mod.save_collector_state(session, payload, capability)
        finally:
            session.close()
        state_file = state_dir / "collector-state.json"
        before = state_file.read_bytes()
        capsys.readouterr()

        with ExitStack() as stack:
            _no_remote_effects(stack, mod)
            rc = _main(mod, ["--allow-empty-roster"])

        assert rc == mod.STATE_RECOVERY_REQUIRED_EXIT
        stderr = capsys.readouterr().err
        assert "unregistered_alert_source" in stderr
        assert "collector-disk-full" not in stderr
        assert state_file.read_bytes() == before
        assert _dispositions(outbox_dir) == []


def test_daemon_and_allow_empty_roster_are_mutually_exclusive(tmp_state, capsys):
    """A declared-empty retirement is one-shot and must never be a daemon.

    Parked in the unit's ExecStart the pair would look harmless while a roster
    existed, then degrade the moment it emptied: the process would succeed,
    exit, and be restarted on the service manager's schedule, rewriting state
    every cycle. The combination is refused at the usage boundary, above the
    state session, so the ledger is never opened.
    """
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir, _EMPTY_ROSTER_ENV):
        mod = _load_mod_with_dirs(state_dir, outbox_dir, _EMPTY_ROSTER_ENV)
        _seed_open_alert_through_a_real_cycle(mod, state_dir)
        state_file = state_dir / "collector-state.json"
        before = state_file.read_bytes()
        capsys.readouterr()

        with ExitStack() as stack:
            _no_remote_effects(stack, mod)
            daemon = stack.enter_context(
                patch.object(mod, "run_daemon", side_effect=AssertionError("refused combination daemonised"))
            )
            rc = _main(mod, ["--daemon", "--allow-empty-roster"])

        assert rc == 64
        stderr = capsys.readouterr().err
        assert "--allow-empty-roster" in stderr
        assert "--daemon" in stderr
        assert daemon.call_count == 0
        # Refused above the state session: nothing loaded, pruned, saved or published.
        assert state_file.read_bytes() == before
        assert _dispositions(outbox_dir) == []


def test_the_flag_does_not_declare_anything_when_the_variable_is_absent(tmp_state, capsys):
    """The flag declares an EMPTY poll list, not a MISSING one.

    Present-and-empty is an operator saying "poll nothing". Absent is the
    variable never having been set, or an environment file that failed to
    load -- inconclusive configuration that happens to look identical once
    the value is read with a default. The flag standing alone over an absent
    variable must therefore stay on the fail-closed path, or a broken
    environment file plus a parked flag would retire the whole ledger.
    """
    state_dir, outbox_dir = tmp_state
    with _env(state_dir, outbox_dir, _EMPTY_ROSTER_ENV):
        mod = _load_mod_with_dirs(state_dir, outbox_dir, _EMPTY_ROSTER_ENV)
        _seed_open_alert_through_a_real_cycle(mod, state_dir)
        state_file = state_dir / "collector-state.json"
        before = state_file.read_bytes()
        capsys.readouterr()

        with patch.dict("os.environ"):
            import os

            os.environ.pop("BOT_ERRORS_RELAY_REMOTES", None)
            with ExitStack() as stack:
                _no_remote_effects(stack, mod)
                rc = _main(mod, ["--allow-empty-roster"])

        assert rc == 64
        assert "no remotes configured" in capsys.readouterr().err
        assert state_file.read_bytes() == before
        assert _dispositions(outbox_dir) == []
