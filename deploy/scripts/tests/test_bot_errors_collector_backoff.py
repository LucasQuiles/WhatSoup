"""Tests for dead-host backoff (Task 3) in bot-errors-collector.

TDD: written BEFORE implementation. Verifies:
- consecutiveFailures threshold triggers backoff after 3 failures
- SSH attempts are spaced per 5m/15m/60m schedule (not called inside window)
- relay_host_down emitted exactly once at state ENTRY (across many cycles)
- relay_host_recovered emitted after consecutive successes, not after one flapping success
- backoff state persists across save_state/load_state (no re-emit on restart)
- per-attempt enqueue_meta_alert NOT called while host is in down state
- live host alongside dead host keeps polling every cycle
- skipped-backoff hosts counted in remotesSkippedBackoff, not in failed/isolatedFailures
"""
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Shared module loader / tmp_state fixture / env-scoping / run_once defaults /
# outbox inspection helpers -- extracted to conftest.py (HD-11b review battery
# 3) after being byte-for-byte duplicated across this file,
# test_bot_errors_collector_reachability.py, and
# test_bot_errors_collector_capture_escalation.py. tmp_state itself needs no
# import -- pytest resolves it from conftest.py as a fixture by parameter
# name, mode-independent.
#
# The plain (non-fixture) helpers below are loaded via importlib rather than
# `from conftest import ...`: this repo's collector test suites run under
# `--import-mode=importlib` (see deploy/scripts/run-sentinel-tests.sh), which
# deliberately does NOT add the test directory to sys.path -- a bare
# `from conftest import X` raises ModuleNotFoundError under that mode (found
# + verified during HD-11b review; RED-proven by running with
# --import-mode=importlib before this fix). Loading conftest.py by file path
# mirrors the same spec_from_file_location pattern already used to load the
# hyphenated bot-errors-collector.py module itself, so it works identically
# under every pytest import mode.
_CONFTEST_PATH = Path(__file__).resolve().parent / "conftest.py"
_conftest_spec = importlib.util.spec_from_file_location("bot_errors_collector_test_conftest", _CONFTEST_PATH)
_conftest = importlib.util.module_from_spec(_conftest_spec)  # type: ignore[arg-type]
_conftest_spec.loader.exec_module(_conftest)  # type: ignore[union-attr]

_env = _conftest._env
_load_mod_with_dirs = _conftest._load_mod_with_dirs
_run_once_defaults = _conftest._run_once_defaults
FakeCollectorClock = _conftest.FakeCollectorClock
_patched_collector_clock = _conftest._patched_collector_clock
_all_outbox_events = _conftest._all_outbox_events
_outbox_by_source = _conftest._outbox_by_source

# ---------------------------------------------------------------------------
# Constants / module-level assertions
# ---------------------------------------------------------------------------

def test_backoff_constants_present():
    state_dir = Path(tempfile.mkdtemp())
    outbox_dir = Path(tempfile.mkdtemp())
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    assert mod.RELAY_BACKOFF_FAILURE_THRESHOLD == 3
    assert mod.RELAY_BACKOFF_SCHEDULE_S == [300, 900, 3600]


# ---------------------------------------------------------------------------
# Test 0a/0b: reachability preflight — an already-offline Tailscale peer should
# not trigger redundant SSH/writefail probes on the same collector cycle.
# ---------------------------------------------------------------------------

def test_ssh_json_lines_preflight_skips_subprocess_when_tailscale_offline(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    with patch.object(mod, "preflight_remote_unreachable", return_value={"status": "found", "online": False}), \
         patch.object(mod.subprocess, "run") as run:
        with pytest.raises(RuntimeError, match="preflight skipped ssh deadhost: tailscale_offline"):
            mod.ssh_json_lines("deadhost", "print('unused')", [], 5)

    run.assert_not_called()


def test_unreachable_outbox_failure_skips_writefail_harvest(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    ssh_calls: list[str] = []

    def fake_ssh_json_lines(h, script, args, timeout):
        ssh_calls.append(script)
        raise RuntimeError("preflight skipped ssh deadhost: tailscale_offline")

    reachability = {"reachabilityDiagnosis": "tailscale_offline", "tailscale": {"status": "found", "online": False}}

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh_json_lines), \
         patch.object(mod, "remote_failure_context", return_value=(["reachabilityDiagnosis=tailscale_offline"], reachability)):
        result = _run_once_defaults(mod, [remote])

    assert ssh_calls == [mod.REMOTE_CLAIM_SCRIPT]
    assert result.get("failed") == 1
    assert result.get("isolatedFailures") == 1

    logs = (state_dir / "logs" / "collector.jsonl").read_text()
    assert '"type": "remote_writefail_claim_skipped_unreachable"' in logs
    assert '"reason": "tailscale_offline"' in logs


# ---------------------------------------------------------------------------
# Test 1: threshold crossing — exactly one relay_host_down, SSH skipped in window
# ---------------------------------------------------------------------------

def test_relay_host_down_emitted_exactly_once(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    host = "deadhost"
    ssh_call_count = [0]

    def fake_ssh_json_lines(h, script, args, timeout):
        ssh_call_count[0] += 1
        if h == host:
            raise RuntimeError("ssh: connect to host deadhost port 22: Connection timed out")
        return []

    clock = FakeCollectorClock(1_000_000)

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh_json_lines), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):

        # Cycles 1-2: below threshold
        for i in range(2):
            _run_once_defaults(mod, [remote])
            clock.advance(30)

        # No relay_host_down yet
        events_before = _outbox_by_source(outbox_dir)
        assert "relay_host_down" not in events_before

        # Cycle 3: threshold crossed → emit relay_host_down
        _run_once_defaults(mod, [remote])
        clock.advance(30)

        events_after = _outbox_by_source(outbox_dir)
        assert "relay_host_down" in events_after
        assert len(events_after["relay_host_down"]) == 1

        # Persist state — verify downEventEmitted stored
        state = mod.load_state()
        rr = state["remotes"][remote]
        assert rr.get("consecutiveFailures", 0) >= mod.RELAY_BACKOFF_FAILURE_THRESHOLD
        assert rr.get("downEventEmitted") is True

        # Cycles 4–8: all inside backoff window; SSH should NOT be called for deadhost
        ssh_before = ssh_call_count[0]
        # Stay well inside first 5-minute window (300s); only advance by 30s each
        for i in range(5):
            _run_once_defaults(mod, [remote])
            clock.advance(30)

        # ssh_json_lines should NOT have been called while window is active
        assert ssh_call_count[0] == ssh_before, (
            f"ssh_json_lines was called {ssh_call_count[0] - ssh_before} extra times while in backoff window"
        )

        # relay_host_down still exactly 1
        all_evs = _outbox_by_source(outbox_dir)
        assert len(all_evs.get("relay_host_down", [])) == 1


# ---------------------------------------------------------------------------
# Test 2: backoff schedule — nextAttemptAt reflects schedule steps
# ---------------------------------------------------------------------------

def test_backoff_schedule_nextAttemptAt(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(2_000_000)

    def fake_ssh_fail(h, script, args, timeout):
        raise RuntimeError("timeout")

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh_fail), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):

        schedule = mod.RELAY_BACKOFF_SCHEDULE_S  # [300, 900, 3600]

        # Cycle 1: 1 failure
        _run_once_defaults(mod, [remote])
        state = mod.load_state()
        assert state["remotes"][remote].get("consecutiveFailures", 0) == 1
        clock.advance(30)

        # Cycle 2: 2 failures
        _run_once_defaults(mod, [remote])
        state = mod.load_state()
        assert state["remotes"][remote].get("consecutiveFailures", 0) == 2
        clock.advance(30)

        # Cycle 3: 3rd failure — enters backoff, scheduleIndex=0 → 300s delay
        attempt_time = clock.now
        _run_once_defaults(mod, [remote])
        state = mod.load_state()
        rr = state["remotes"][remote]
        assert rr.get("consecutiveFailures", 0) >= 3
        assert rr.get("downEventEmitted") is True
        # nextAttemptAt should be ~attempt_time + 300
        assert rr.get("nextAttemptAt") == pytest.approx(attempt_time + schedule[0], abs=2)
        clock.advance(30)

        # Cycles inside 300s window: skipped
        inside_window_calls = []

        def fake_ssh_record(h, s, a, t):
            inside_window_calls.append(h)
            raise RuntimeError("timeout")

        with patch.object(mod, "ssh_json_lines", side_effect=fake_ssh_record):
            # Stay well within 300s window
            for _ in range(5):
                _run_once_defaults(mod, [remote])
                clock.advance(30)
        assert inside_window_calls == [], f"ssh called inside window: {inside_window_calls}"

        # Advance past first window (300s), trigger 4th attempt → scheduleIndex=1 → 900s
        clock.set(attempt_time + schedule[0] + 1)

        fail_calls_2 = [0]

        def fake_fail_again(h, s, a, t):
            fail_calls_2[0] += 1
            raise RuntimeError("timeout")

        with patch.object(mod, "ssh_json_lines", side_effect=fake_fail_again):
            _run_once_defaults(mod, [remote])
        # Both outbox-claim and writefail-claim attempt SSH, so expect >= 1 calls
        assert fail_calls_2[0] >= 1, "SSH attempt must be made when backoff window expires"
        state = mod.load_state()
        rr = state["remotes"][remote]
        # After a retry-fail, scheduleIndex moves to 1 → nextAttemptAt += 900
        assert rr.get("nextAttemptAt") == pytest.approx(clock.now + schedule[1], abs=2)

        # No additional relay_host_down events (still exactly 1)
        evs = _outbox_by_source(outbox_dir)
        assert len(evs.get("relay_host_down", [])) == 1


def test_backoff_window_boundary_is_deterministic(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(8_000_000)
    ssh_calls: list[int] = []

    def fake_fail(h, script, args, timeout):
        ssh_calls.append(clock.now)
        raise RuntimeError("timeout")

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_fail), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock.advance(30)

        state = mod.load_state()
        next_attempt_at = int(state["remotes"][remote]["nextAttemptAt"])
        calls_before_window_checks = len(ssh_calls)

        clock.set(next_attempt_at - 1)
        _run_once_defaults(mod, [remote])
        assert len(ssh_calls) == calls_before_window_checks

        clock.set(next_attempt_at)
        _run_once_defaults(mod, [remote])
        assert len(ssh_calls) > calls_before_window_checks


# ---------------------------------------------------------------------------
# Test 3: recovery — relay_host_recovered emitted once, state reset
# ---------------------------------------------------------------------------

def test_relay_host_recovered_and_reset(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    host = "deadhost"
    clock = FakeCollectorClock(3_000_000)
    failing = [True]

    def fake_ssh(h, script, args, timeout):
        if failing[0] and h == host:
            raise RuntimeError("timeout")
        return []

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):

        # Drive to down state (3 failures)
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock.advance(30)

        evs = _outbox_by_source(outbox_dir)
        assert len(evs.get("relay_host_down", [])) == 1

        state = mod.load_state()
        rr = state["remotes"][remote]
        next_attempt = rr.get("nextAttemptAt", 0)

        # Advance past backoff window and switch to success
        clock.set(next_attempt + 1)
        failing[0] = False

        _run_once_defaults(mod, [remote])
        # First success is only recovery evidence; do not clear a flapping host yet.
        evs = _outbox_by_source(outbox_dir)
        assert len(evs.get("relay_host_recovered", [])) == 0
        state = mod.load_state()
        rr = state["remotes"][remote]
        assert rr.get("downEventEmitted") is True
        assert rr.get("outboxRecoveryConsecutiveSuccesses") == 1

        clock.advance(30)
        _run_once_defaults(mod, [remote])
        # relay_host_recovered should be emitted after the configured threshold.
        evs = _outbox_by_source(outbox_dir)
        assert len(evs.get("relay_host_recovered", [])) == 1

        # State reset
        state = mod.load_state()
        rr = state["remotes"][remote]
        assert rr.get("consecutiveFailures", 0) == 0
        assert rr.get("backoffScheduleIndex", 0) == 0
        assert rr.get("downEventEmitted", False) is False
        assert rr.get("outboxRecoveryConsecutiveSuccesses", 0) == 0
        next_at = rr.get("nextAttemptAt")
        assert next_at is None or next_at == 0

        # Running more successful cycles should NOT emit more relay_host_recovered
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock.advance(30)
        evs = _outbox_by_source(outbox_dir)
        assert len(evs.get("relay_host_recovered", [])) == 1


# ---------------------------------------------------------------------------
# Test 4: restart persistence — no re-emit of relay_host_down after restart
# ---------------------------------------------------------------------------

def test_restart_does_not_reemit_host_down(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(4_000_000)

    def fake_fail(h, script, args, timeout):
        raise RuntimeError("timeout")

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_fail), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):

        # Bring host to down state
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock.advance(30)

    evs_before = _outbox_by_source(outbox_dir)
    assert len(evs_before.get("relay_host_down", [])) == 1

    # Simulate restart: load fresh module instance, same state files
    mod2 = _load_mod_with_dirs(state_dir, outbox_dir)

    # After restart, still in backoff — should skip without re-emitting relay_host_down
    clock2 = FakeCollectorClock(clock.now)
    ssh_calls_after = [0]

    def fake_fail2(h, s, a, t):
        ssh_calls_after[0] += 1
        raise RuntimeError("timeout")

    with _env(state_dir, outbox_dir):
        # Verify state round-trips backoff fields
        state = mod2.load_state()
        rr = state["remotes"].get(remote, {})
        assert rr.get("consecutiveFailures", 0) >= 3
        assert rr.get("downEventEmitted") is True

        with patch.object(mod2, "ssh_json_lines", side_effect=fake_fail2), \
             patch.object(mod2, "remote_failure_context", return_value=([], {})), \
             _patched_collector_clock(mod2, clock2):

            # Stay within backoff window
            for _ in range(5):
                _run_once_defaults(mod2, [remote])
                clock2.advance(30)

    evs_after = _outbox_by_source(outbox_dir)
    assert len(evs_after.get("relay_host_down", [])) == 1, (
        "relay_host_down must not be re-emitted after restart"
    )
    assert ssh_calls_after[0] == 0, "ssh must not be called while in backoff window after restart"


# ---------------------------------------------------------------------------
# Test 5: no-storm — per-attempt meta-alerts suppressed while down
# ---------------------------------------------------------------------------

def test_no_per_attempt_meta_alerts_while_down(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(5_000_000)

    def fake_fail(h, script, args, timeout):
        raise RuntimeError("timeout")

    meta_alert_calls: list[tuple[str, str]] = []

    def patched_enqueue(r, source, summary, evidence, state, cooldown, extra_diagnostics=None, **kwargs):
        meta_alert_calls.append((r, source))

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_fail), \
         patch.object(mod, "enqueue_meta_alert", side_effect=patched_enqueue), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):

        # Cycles 1-3: drive to down state (alert calls allowed pre-threshold)
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock.advance(30)

        meta_alert_calls.clear()  # reset after threshold crossed

        # Cycles 4-12: all inside first backoff window, should be skipped
        for _ in range(9):
            _run_once_defaults(mod, [remote])
            clock.advance(30)

        # No meta-alerts should have been enqueued while host is down and inside window
        assert meta_alert_calls == [], (
            f"enqueue_meta_alert called while host down/in-window: {meta_alert_calls}"
        )


# ---------------------------------------------------------------------------
# Test 6: live host unaffected by dead host (runs every cycle)
# ---------------------------------------------------------------------------

def test_live_host_unaffected_by_dead_host(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    dead_remote = "deadhost:/srv/whatsoup/bot-errors"
    live_remote = "livehost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(6_000_000)

    live_call_count = [0]

    def fake_ssh(h, script, args, timeout):
        if h == "deadhost":
            raise RuntimeError("timeout")
        live_call_count[0] += 1
        return []

    N = 10
    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):

        for i in range(N):
            _run_once_defaults(mod, [dead_remote, live_remote])
            clock.advance(30)

    # livehost should have been called in every cycle
    # Each cycle = 2 calls for livehost (outbox claim + writefail claim)
    assert live_call_count[0] >= N, (
        f"livehost ssh only called {live_call_count[0]} times across {N} cycles"
    )


# ---------------------------------------------------------------------------
# Test 7: remotesSkippedBackoff counted; failed/isolatedFailures NOT incremented
# ---------------------------------------------------------------------------

def test_skipped_backoff_not_counted_as_failure(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(7_000_000)

    def fake_fail(h, s, a, t):
        raise RuntimeError("timeout")

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_fail), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):

        # Drive to backoff (3 failures)
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock.advance(30)

        # Now in backoff window — next cycle should be skipped with NO SSH attempt.
        ssh_calls_on_skip = [0]

        def fake_fail_counted(h, s, a, t):
            ssh_calls_on_skip[0] += 1
            raise RuntimeError("timeout")

        with patch.object(mod, "ssh_json_lines", side_effect=fake_fail_counted):
            result = _run_once_defaults(mod, [remote])
        clock.advance(30)

    # Skipped cycle: no SSH, failed=0, isolatedFailures=0, remotesSkippedBackoff>=1.
    assert ssh_calls_on_skip[0] == 0, (
        f"ssh_json_lines was called {ssh_calls_on_skip[0]} times on a skipped-backoff cycle"
    )
    assert result.get("failed", 0) == 0
    assert result.get("isolatedFailures", 0) == 0
    assert result.get("remotesSkippedBackoff", 0) >= 1


# ---------------------------------------------------------------------------
# Test 8: relay_host_down severity=warning, relay_host_recovered severity=info
# ---------------------------------------------------------------------------

def test_event_severities(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = FakeCollectorClock(8_000_000)
    failing = [True]

    def fake_ssh(h, script, args, timeout):
        if failing[0]:
            raise RuntimeError("timeout")
        return []

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):

        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock.advance(30)

        down_evs = _outbox_by_source(outbox_dir).get("relay_host_down", [])
        assert len(down_evs) == 1
        assert down_evs[0]["severity"] == "warning"

        # Advance past window; first success is evidence, second clears recovery.
        state = mod.load_state()
        next_attempt = state["remotes"][remote].get("nextAttemptAt", 0)
        clock.set(next_attempt + 1)
        failing[0] = False
        _run_once_defaults(mod, [remote])

        rec_evs = _outbox_by_source(outbox_dir).get("relay_host_recovered", [])
        assert len(rec_evs) == 0

        clock.advance(30)
        _run_once_defaults(mod, [remote])

        rec_evs = _outbox_by_source(outbox_dir).get("relay_host_recovered", [])
        assert len(rec_evs) == 1
        assert rec_evs[0]["severity"] == "info"


# ---------------------------------------------------------------------------
# Test 9: split success — outbox claim OK but writefail harvest FAILS must still
# recover (relay_host_recovered + full backoff reset), keyed on outbox
# reachability. Guards against a half-up host being pinned in down state forever
# and re-storming through the writefail surface.
# ---------------------------------------------------------------------------

def test_recovery_on_outbox_success_despite_writefail_failure(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    host = "deadhost"
    clock = FakeCollectorClock(9_000_000)
    # Phase control: "down" = both calls fail; "split" = outbox ok, writefail fails.
    phase = ["down"]

    def fake_ssh(h, script, args, timeout):
        if h != host:
            return []
        if phase[0] == "down":
            raise RuntimeError("timeout")
        # split phase: the FIRST call per remote is the outbox claim (succeeds),
        # the SECOND is the writefail-harvest claim (fails).
        if script is mod.REMOTE_WRITEFAIL_CLAIM_SCRIPT:
            raise RuntimeError("writefail harvest path broken")
        return []

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh), \
         patch.object(mod, "remote_failure_context", return_value=([], {})), \
         _patched_collector_clock(mod, clock):

        # Drive to down state (both calls failing).
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock.advance(30)
        assert len(_outbox_by_source(outbox_dir).get("relay_host_down", [])) == 1
        rr = mod.load_state()["remotes"][remote]
        assert rr.get("downEventEmitted") is True

        # Advance past backoff window; switch to split-success (outbox OK, writefail FAIL).
        clock.set(int(rr.get("nextAttemptAt") or 0) + 1)
        phase[0] = "split"
        _run_once_defaults(mod, [remote])

        # First split-success is not enough to clear a flapping host.
        rec = _outbox_by_source(outbox_dir).get("relay_host_recovered", [])
        assert len(rec) == 0
        rr_pending = mod.load_state()["remotes"][remote]
        assert rr_pending.get("downEventEmitted") is True
        assert rr_pending.get("outboxRecoveryConsecutiveSuccesses") == 1

        clock.advance(30)
        _run_once_defaults(mod, [remote])

        # Recovery MUST fire after the threshold even though the writefail harvest failed.
        rec = _outbox_by_source(outbox_dir).get("relay_host_recovered", [])
        assert len(rec) == 1, "outbox-claim success streak must emit relay_host_recovered"

        # Backoff state fully reset (no livelock): consecutiveFailures back to 0,
        # down flag cleared, so a healthy outbox no longer triggers the skip path.
        rr2 = mod.load_state()["remotes"][remote]
        assert rr2.get("consecutiveFailures", 0) == 0
        assert rr2.get("downEventEmitted", False) is False
        assert rr2.get("backoffScheduleIndex", 0) == 0
        assert rr2.get("outboxRecoveryConsecutiveSuccesses", 0) == 0

        # Running more split-success cycles must NOT re-down or re-storm:
        # consecutiveFailures stays 0 (writefail failure alone does not re-arm backoff)
        # and relay_host_down is not re-emitted.
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock.advance(30)
        assert len(_outbox_by_source(outbox_dir).get("relay_host_down", [])) == 1
        assert mod.load_state()["remotes"][remote].get("consecutiveFailures", 0) == 0
