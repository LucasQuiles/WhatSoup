"""Tests for HD-11b collector capture-failure escalation.

TDD: written BEFORE implementation. Verifies:
- two consecutive outbox-claim failures at the default threshold (2, env-tunable
  via BOT_ERRORS_COLLECTOR_FAILURE_ESCALATE_THRESHOLD) emit exactly one
  collector_remote_unreachable alert, naming the remote, its failure count, its
  last error class, and its last-success age
- further failures past the threshold do NOT re-emit (anti-noise; one open
  incident per remote, no collector-side re-emission loop)
- the next successful collection after escalation emits exactly one typed
  eventType="clear", and a subsequent re-failure past threshold escalates again
  (episode reset, not a one-shot-forever guard)
- threshold=1 and threshold=0 (clamped to 1, matching default_recovery_successes'
  precedent) edge cases
- escalation state (captureFailureEscalated) round-trips across a simulated
  collector restart (fresh module load against the same state dir) with no
  double-emission
- collector_remote_unreachable is genuinely independent of relay_host_down:
  with defaults (escalate threshold=2 < RELAY_BACKOFF_FAILURE_THRESHOLD=3) the
  escalation fires a full cycle before backoff/down does
- two different remotes failing past threshold produce two DISTINCT escalation
  events (no incident-key collision / cross-remote false-clear risk)
"""
from __future__ import annotations

import contextlib
import time
from unittest.mock import patch

# Shared module loader / tmp_state fixture / env-scoping / run_once defaults /
# outbox inspection helpers -- extracted to conftest.py (HD-11b review battery
# 3) after being byte-for-byte duplicated across this file,
# test_bot_errors_collector_backoff.py, and
# test_bot_errors_collector_reachability.py. tmp_state itself needs no import
# -- pytest resolves it from conftest.py by fixture-parameter name.
#
# _patched_collector_clock is intentionally NOT imported from conftest --
# this file's version additionally mocks time.time_ns() (see docstring
# below), which is genuinely test-specific and kept local rather than folded
# into the shared base version other collector test files use.
from conftest import (
    _env,
    _load_mod_with_dirs,
    _run_once_defaults,
    _all_outbox_events,
    _outbox_by_source,
    FakeCollectorClock,
)


@contextlib.contextmanager
def _patched_collector_clock(mod, clock: FakeCollectorClock):
    # time.time_ns() feeds emit_collector_capture_escalation_event's event id,
    # which in turn is the tail of the outbox filename local_outbox_path()
    # builds -- and _outbox_by_source() (imported above) sorts by filename to
    # recover emission order. Left unmocked, every call returns the same
    # memoized MagicMock repr (identical across the whole test), so two
    # events sharing source/instance/remote (e.g. two
    # collector_remote_unreachable alerts either side of a clear) can't be
    # told apart by filename order even though they were emitted at
    # genuinely different simulated times. A monotonic counter tied to the
    # fake clock keeps ids -- and therefore file/emission order -- faithful
    # to simulated time.
    _time_ns_counter = [0]

    def _fake_time_ns() -> int:
        _time_ns_counter[0] += 1
        return int(clock.now * 1_000_000_000) + _time_ns_counter[0]

    with patch.object(mod, "time") as mock_time:
        mock_time.time.side_effect = clock.time
        mock_time.time_ns.side_effect = _fake_time_ns
        mock_time.strftime = time.strftime
        mock_time.gmtime = time.gmtime
        yield


ESCALATION_SOURCE = "collector_remote_unreachable"


def _fail_ssh(error: str = "ssh: connect to host deadhost port 22: Connection timed out"):
    def fake(h, script, args, timeout):
        raise RuntimeError(error)
    return fake


# ---------------------------------------------------------------------------
# Constants present
# ---------------------------------------------------------------------------

def test_escalation_threshold_default_is_two(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    assert mod.collector_failure_escalate_threshold() == 2


# ---------------------------------------------------------------------------
# Test 1: exactly one escalation at default threshold, fields correct
# ---------------------------------------------------------------------------

def test_two_failures_emit_exactly_one_escalation_with_fields(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(1_000_000)

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=_fail_ssh()), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):

        # Failure 1: below threshold, no escalation yet
        _run_once_defaults(mod, [remote])
        clock.advance(30)
        events = _outbox_by_source(outbox_dir)
        assert ESCALATION_SOURCE not in events

        # Failure 2: threshold crossed
        _run_once_defaults(mod, [remote])
        clock.advance(30)

    events = _outbox_by_source(outbox_dir)
    assert len(events.get(ESCALATION_SOURCE, [])) == 1
    ev = events[ESCALATION_SOURCE][0]
    assert ev["eventType"] == "alert"
    assert ev["severity"] == "warning"
    assert ev["instance"] == "bot-errors-collector"
    diag = ev["diagnostics"]
    assert diag["remote"] == remote
    assert diag["consecutiveFailures"] == 2
    assert diag["thresholdConfigured"] == 2
    assert diag["errorClass"] == "ssh_failure"
    # Never succeeded before this remote's first failure -> explicit null, not omitted.
    assert "lastSuccessAgeSeconds" in diag
    assert diag["lastSuccessAgeSeconds"] is None


# ---------------------------------------------------------------------------
# Test 2: anti-noise — further failures do not re-emit
# ---------------------------------------------------------------------------

def test_further_failures_do_not_reemit(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(1_000_000)

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=_fail_ssh()), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):
        for _ in range(6):
            _run_once_defaults(mod, [remote])
            clock.advance(30)

        # load_state() must run inside _env's scope: BOT_ERRORS_STATE_DIR is
        # only set for the duration of the with-block, and load_state() reads
        # state_root() from the environment at call time, not from tmp_state.
        state = mod.load_state()
        assert state["remotes"][remote].get("captureFailureEscalated") is True

    events = _outbox_by_source(outbox_dir)
    assert len(events.get(ESCALATION_SOURCE, [])) == 1


# ---------------------------------------------------------------------------
# Test 3: recovery clears, and a fresh episode escalates again
# ---------------------------------------------------------------------------

def test_recovery_emits_one_clear_and_reescalates_on_new_episode(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    host = "deadhost"
    clock = FakeCollectorClock(1_000_000)
    failing = [True]

    def fake_ssh(h, script, args, timeout):
        if failing[0] and h == host:
            raise RuntimeError("timeout")
        return []

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):

        # Two failures -> escalate
        for _ in range(2):
            _run_once_defaults(mod, [remote])
            clock.advance(30)
        events = _outbox_by_source(outbox_dir)
        assert len(events.get(ESCALATION_SOURCE, [])) == 1

        # One success -> clear (literal next success, not gated by recovery_successes)
        failing[0] = False
        _run_once_defaults(mod, [remote])
        clock.advance(30)

        events = _outbox_by_source(outbox_dir)
        by_type = [e["eventType"] for e in events[ESCALATION_SOURCE]]
        assert by_type == ["alert", "clear"]
        clear_ev = events[ESCALATION_SOURCE][1]
        assert clear_ev["severity"] == "info"
        assert clear_ev["diagnostics"]["remote"] == remote

        state = mod.load_state()
        assert state["remotes"][remote].get("captureFailureEscalated") is False

        # New failure episode -> escalates again (not a one-shot-forever guard)
        failing[0] = True
        for _ in range(2):
            _run_once_defaults(mod, [remote])
            clock.advance(30)

    events = _outbox_by_source(outbox_dir)
    alerts = [e for e in events[ESCALATION_SOURCE] if e["eventType"] == "alert"]
    assert len(alerts) == 2


# ---------------------------------------------------------------------------
# Test 3b: a flap through the backoff threshold re-escalates BY DESIGN.
#
# escalate threshold (2) < RELAY_BACKOFF_FAILURE_THRESHOLD (3), and the clear
# fires on a single successful collection (the contract's literal "next
# successful collection"), while backoff recovery separately requires
# recovery_successes (default 2) consecutive successes before
# consecutiveFailures resets. So a fail x3 / success x1 / fail x1 sequence
# clears and then re-opens the escalation, while relay_host_down (gated on
# the N-successes backoff recovery) stays open across the same flap.
#
# This asymmetry is intentional (boterr-lead ruling, HD-11b review): the two
# signals have different thresholds and different confirmation semantics by
# design, so they are expected to behave differently on a flap. The signal is
# per-transition-honest (alert on each new failure episode, clear on each
# real recovery) rather than flap-suppressing; a genuinely flapping remote is
# bounded dispatcher-side by the existing flap-storm machinery
# (BOT_ERRORS_FLAP_TRIP_THRESHOLD/_WINDOW_SECONDS, default 5 trips/600s ->
# storm collapse), not by holding this event open across a real recovery.
# ---------------------------------------------------------------------------

def test_flap_through_backoff_reescalates_by_design(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    host = "deadhost"
    clock = FakeCollectorClock(1_000_000)
    failing = [True]

    def fake_ssh(h, script, args, timeout):
        if failing[0] and h == host:
            raise RuntimeError("timeout")
        return []

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):

        # fail x3: crosses BOTH thresholds -- escalation alert (at failure 2)
        # and relay_host_down (at failure 3, backoff engages).
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock.advance(30)
        events = _outbox_by_source(outbox_dir)
        assert len(events.get(ESCALATION_SOURCE, [])) == 1
        assert events[ESCALATION_SOURCE][0]["eventType"] == "alert"
        assert len(events.get("relay_host_down", [])) == 1

        state = mod.load_state()
        rr = state["remotes"][remote]
        assert rr.get("consecutiveFailures") == 3
        assert rr.get("downEventEmitted") is True

        # Clear the backoff window before the success attempt, otherwise the
        # dead-host backoff guard skips the remote and ssh_json_lines is
        # never called (same reasoning as test_escalation_state_survives_restart).
        clock.advance(400)

        # success x1: a single successful collection genuinely resolves the
        # capture failure for that moment -- the escalation clears. This is
        # NOT enough successes (recovery_successes default 2) to reset
        # consecutiveFailures/downEventEmitted, so relay_host_down stays open.
        failing[0] = False
        _run_once_defaults(mod, [remote])
        clock.advance(30)

        events = _outbox_by_source(outbox_dir)
        types = [e["eventType"] for e in events[ESCALATION_SOURCE]]
        assert types == ["alert", "clear"], "a real successful collection must clear the escalation"
        assert len(events.get("relay_host_down", [])) == 1, "one success is not enough to recover backoff"

        state = mod.load_state()
        rr = state["remotes"][remote]
        assert rr.get("captureFailureEscalated") is False
        assert rr.get("consecutiveFailures") == 3, "backoff recovery needs recovery_successes, not just 1"
        assert rr.get("downEventEmitted") is True

        # fail x1 more: a genuinely new failure episode -> escalation
        # re-alerts (by design, per the docstring above). relay_host_down
        # does NOT re-fire -- its own down-state guard survives the flap.
        failing[0] = True
        _run_once_defaults(mod, [remote])
        clock.advance(30)

    events = _outbox_by_source(outbox_dir)
    alert_types = [e["eventType"] for e in events[ESCALATION_SOURCE]]
    assert alert_types == ["alert", "clear", "alert"], (
        "collector_remote_unreachable is intentionally per-transition-honest: "
        "it re-alerts on a genuinely new failure episode even mid-flap"
    )
    assert len(events.get("relay_host_down", [])) == 1, (
        "relay_host_down is gated on N-successes recovery and correctly does "
        "NOT re-fire mid-flap -- this asymmetry with the escalation signal is "
        "intentional, not a bug"
    )


# ---------------------------------------------------------------------------
# Test 4/5: threshold edges
# ---------------------------------------------------------------------------

def test_threshold_one_escalates_on_first_failure(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(
        state_dir, outbox_dir,
        extra_env={"BOT_ERRORS_COLLECTOR_FAILURE_ESCALATE_THRESHOLD": "1"},
    )
    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(1_000_000)

    with _env(state_dir, outbox_dir, extra={"BOT_ERRORS_COLLECTOR_FAILURE_ESCALATE_THRESHOLD": "1"}), \
         patch.object(mod, "ssh_json_lines", side_effect=_fail_ssh()), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):
        _run_once_defaults(mod, [remote])

    events = _outbox_by_source(outbox_dir)
    assert len(events.get(ESCALATION_SOURCE, [])) == 1
    assert events[ESCALATION_SOURCE][0]["diagnostics"]["consecutiveFailures"] == 1


def test_threshold_zero_clamps_to_one(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(
        state_dir, outbox_dir,
        extra_env={"BOT_ERRORS_COLLECTOR_FAILURE_ESCALATE_THRESHOLD": "0"},
    )
    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(1_000_000)

    with _env(state_dir, outbox_dir, extra={"BOT_ERRORS_COLLECTOR_FAILURE_ESCALATE_THRESHOLD": "0"}):
        # collector_failure_escalate_threshold() reads the env at call time
        # (not at module-load time) -- must run inside _env's scope.
        assert mod.collector_failure_escalate_threshold() == 1

    with _env(state_dir, outbox_dir, extra={"BOT_ERRORS_COLLECTOR_FAILURE_ESCALATE_THRESHOLD": "0"}), \
         patch.object(mod, "ssh_json_lines", side_effect=_fail_ssh()), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):
        _run_once_defaults(mod, [remote])

    events = _outbox_by_source(outbox_dir)
    assert len(events.get(ESCALATION_SOURCE, [])) == 1
    assert events[ESCALATION_SOURCE][0]["diagnostics"]["thresholdConfigured"] == 1


# ---------------------------------------------------------------------------
# Test 6: state round-trip across a simulated restart
# ---------------------------------------------------------------------------

def test_escalation_state_survives_restart(tmp_state):
    state_dir, outbox_dir = tmp_state
    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(1_000_000)

    mod1 = _load_mod_with_dirs(state_dir, outbox_dir)
    with _env(state_dir, outbox_dir), \
         patch.object(mod1, "ssh_json_lines", side_effect=_fail_ssh()), \
         patch.object(mod1, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod1, clock):
        for _ in range(2):
            _run_once_defaults(mod1, [remote])
            clock.advance(30)

    events = _outbox_by_source(outbox_dir)
    assert len(events.get(ESCALATION_SOURCE, [])) == 1

    # Simulate a collector restart: fresh module load, same state dir.
    mod2 = _load_mod_with_dirs(state_dir, outbox_dir)
    with _env(state_dir, outbox_dir):
        # load_state() reads state_root() from the environment at call time;
        # must run inside _env's scope, not against whatever BOT_ERRORS_STATE_DIR
        # (if any) happens to be set to outside this test.
        state = mod2.load_state()
        assert state["remotes"][remote].get("captureFailureEscalated") is True

    with _env(state_dir, outbox_dir), \
         patch.object(mod2, "ssh_json_lines", side_effect=_fail_ssh()), \
         patch.object(mod2, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod2, clock):
        # Further failure post-restart must NOT double-emit. This is the 3rd
        # consecutive failure overall (2 from mod1 + 1 here), which also
        # crosses RELAY_BACKOFF_FAILURE_THRESHOLD (3) -- a second, independent
        # signal (relay_host_down) is expected to fire here; that's the
        # distinctness this packet is built on, not a conflict.
        _run_once_defaults(mod2, [remote])
        events = _outbox_by_source(outbox_dir)
        assert len(events.get(ESCALATION_SOURCE, [])) == 1

        # Clear the backoff window (300s schedule[0]) before the success
        # attempt, otherwise the dead-host backoff guard skips the remote
        # entirely and ssh_json_lines is never even called.
        clock.advance(400)

        # Success post-restart must still clear correctly.
        with patch.object(mod2, "ssh_json_lines", return_value=[]):
            _run_once_defaults(mod2, [remote])

    events = _outbox_by_source(outbox_dir)
    types = [e["eventType"] for e in events[ESCALATION_SOURCE]]
    assert types == ["alert", "clear"]


# ---------------------------------------------------------------------------
# Regression: a long remote string must not truncate two distinct escalation
# events onto the same outbox filename.
#
# local_outbox_path() builds the outbox filename from safe_segment(event_id),
# which silently truncates to 80 chars. emit_collector_capture_escalation_event
# embeds the remote in event_id for traceability; if the remote is long and
# the uniqueness-critical fields (time_ns, pid) are placed AFTER it in the
# string, truncation can erase them entirely -- two genuinely different
# events for the same remote then compute the IDENTICAL filename, and the
# second atomic_write_json silently overwrites the first (event loss). Caught
# during HD-11b review; fixed by ordering time_ns/pid before the remote (and
# before event_type, so filename sort order also stays chronological). This
# test uses a remote long enough that the old (remote-first) ordering would
# have collided, to keep the fix load-bearing rather than incidental.
# ---------------------------------------------------------------------------

def test_long_remote_name_does_not_collide_or_misorder_events(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    long_host = "a" * 40
    remote = f"{long_host}:/srv/whatsoup/bot-errors/very/long/nested/path/for/this/instance"
    assert len(remote) > 80, "test remote must be long enough to have collided under the old ordering"
    clock = FakeCollectorClock(1_000_000)
    failing = [True]

    def fake_ssh(h, script, args, timeout):
        if failing[0] and h == long_host:
            raise RuntimeError("timeout")
        return []

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):
        # fail x2 -> alert
        for _ in range(2):
            _run_once_defaults(mod, [remote])
            clock.advance(30)
        # success x1 -> clear. This remote never crossed
        # RELAY_BACKOFF_FAILURE_THRESHOLD (only 2 failures), so was_down was
        # never True and recovered_from_down is unconditionally True on this
        # single success -- consecutiveFailures fully resets to 0 here (existing
        # collector behavior, not new). A fresh episode below therefore needs
        # 2 more failures, same as the initial escalation, not 1.
        failing[0] = False
        _run_once_defaults(mod, [remote])
        clock.advance(30)
        # fail x2 -> second alert (fresh episode)
        failing[0] = True
        for _ in range(2):
            _run_once_defaults(mod, [remote])
            clock.advance(30)

    outbox_files = sorted(outbox_dir.glob("*.json"))
    escalation_files = [p for p in outbox_files if ESCALATION_SOURCE in p.name]
    # Three genuinely distinct events must produce three distinct files, not
    # fewer (no silent overwrite from a filename collision).
    assert len(escalation_files) == 3, (
        f"expected 3 distinct escalation event files, got {len(escalation_files)}: "
        f"{[p.name for p in escalation_files]}"
    )

    events = _outbox_by_source(outbox_dir)
    assert [e["eventType"] for e in events[ESCALATION_SOURCE]] == ["alert", "clear", "alert"]
    for ev in events[ESCALATION_SOURCE]:
        assert ev["diagnostics"]["remote"] == remote


# ---------------------------------------------------------------------------
# Test 7 (load-bearing distinctness proof): independent of relay_host_down
# ---------------------------------------------------------------------------

def test_escalation_independent_of_relay_host_down(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    assert mod.RELAY_BACKOFF_FAILURE_THRESHOLD == 3
    assert mod.collector_failure_escalate_threshold() == 2

    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(1_000_000)

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=_fail_ssh()), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):

        # 2 failures: escalation present, backoff/down NOT yet.
        for _ in range(2):
            _run_once_defaults(mod, [remote])
            clock.advance(30)
        events = _outbox_by_source(outbox_dir)
        assert len(events.get(ESCALATION_SOURCE, [])) == 1
        assert "relay_host_down" not in events

        # 3rd failure: both present.
        _run_once_defaults(mod, [remote])
        clock.advance(30)

    events = _outbox_by_source(outbox_dir)
    assert len(events.get(ESCALATION_SOURCE, [])) == 1
    assert len(events.get("relay_host_down", [])) == 1


# ---------------------------------------------------------------------------
# Test 8: two remotes do not collide (no cross-remote false-clear risk)
# ---------------------------------------------------------------------------

def test_two_remotes_produce_distinct_escalation_events(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote_a = "hosta:/srv/whatsoup/bot-errors"
    remote_b = "hostb:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(1_000_000)

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=_fail_ssh()), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):
        for _ in range(2):
            _run_once_defaults(mod, [remote_a, remote_b])
            clock.advance(30)

    events = _outbox_by_source(outbox_dir)
    alerts = events.get(ESCALATION_SOURCE, [])
    assert len(alerts) == 2
    remotes_seen = {e["diagnostics"]["remote"] for e in alerts}
    assert remotes_seen == {remote_a, remote_b}
    # incident_source qualification (dispatcher.py:769-778) relies on machine +
    # instance + diagnostics.remote all matching between an alert and its clear;
    # confirm both events carry the fields that qualification depends on.
    for ev in alerts:
        assert ev["instance"] == "bot-errors-collector"
        assert isinstance(ev["diagnostics"].get("remote"), str) and ev["diagnostics"]["remote"]


# ---------------------------------------------------------------------------
# exit_code_for_result unaffected
# ---------------------------------------------------------------------------

def test_exit_code_unaffected_by_escalation(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(1_000_000)

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=_fail_ssh()), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):
        result = _run_once_defaults(mod, [remote])
        clock.advance(30)
        result2 = _run_once_defaults(mod, [remote])

    # A single hard remote, always failing, with zero hard successes -> exit 1,
    # same as it would be with no escalation feature at all (behavior unchanged).
    assert mod.exit_code_for_result(result2) == 1
