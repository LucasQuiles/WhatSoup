"""Tests for dead-host backoff (Task 3) in bot-errors-collector.

TDD: written BEFORE implementation. Verifies:
- consecutiveFailures threshold triggers backoff after 3 failures
- SSH attempts are spaced per 5m/15m/60m schedule (not called inside window)
- relay_host_down emitted exactly once at state ENTRY (across many cycles)
- relay_host_recovered emitted exactly once on first success after down
- backoff state persists across save_state/load_state (no re-emit on restart)
- per-attempt enqueue_meta_alert NOT called while host is in down state
- live host alongside dead host keeps polling every cycle
- skipped-backoff hosts counted in remotesSkippedBackoff, not in failed/isolatedFailures
"""
from __future__ import annotations

import contextlib
import importlib.util
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch, MagicMock

import pytest

# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-collector.py"


def _load_module(extra_env: dict[str, str] | None = None):
    """Load the collector module with env vars active during exec_module."""
    env_backup: dict[str, str | None] = {}
    if extra_env:
        for k, v in extra_env.items():
            env_backup[k] = os.environ.get(k)
            os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location("bot_errors_collector", _SCRIPT)
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    finally:
        if extra_env:
            for k, orig in env_backup.items():
                if orig is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

@pytest.fixture()
def tmp_state(tmp_path: Path):
    """Isolated state root with required subdirectories."""
    state_dir = tmp_path / "bot-errors"
    outbox_dir = tmp_path / "outbox"
    state_dir.mkdir(mode=0o700)
    outbox_dir.mkdir(mode=0o700)
    return state_dir, outbox_dir


@contextlib.contextmanager
def _env(state_dir: Path, outbox_dir: Path):
    """Context manager that keeps BOT_ERRORS_* env vars active during test body.

    The collector reads BOT_ERRORS_STATE_DIR and BOT_ERRORS_OUTBOX_DIR at call
    time (not import time), so the env vars must be active during run_once execution.
    """
    env_map = {
        "BOT_ERRORS_STATE_DIR": str(state_dir),
        "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
        "BOT_ERRORS_TAILSCALE_STATUS_COMMAND": "",
    }
    backup = {k: os.environ.get(k) for k in env_map}
    for k, v in env_map.items():
        os.environ[k] = v
    try:
        yield
    finally:
        for k, orig in backup.items():
            if orig is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = orig


def _load_mod_with_dirs(state_dir: Path, outbox_dir: Path):
    """Load collector module with env vars set (env vars are also restored afterward)."""
    return _load_module(extra_env={
        "BOT_ERRORS_STATE_DIR": str(state_dir),
        "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
        "BOT_ERRORS_TAILSCALE_STATUS_COMMAND": "",
    })


def _run_once_defaults(mod, remotes: list[str], **kwargs):
    defaults = dict(
        best_effort_remotes=set(),
        max_events=5,
        timeout=5,
        lease_seconds=30,
        remote_sla=9999,
        alert_cooldown=900,
        recovery_successes=2,
    )
    defaults.update(kwargs)
    return mod.run_once(remotes, **defaults)


def _all_outbox_events(outbox_dir: Path) -> list[dict[str, Any]]:
    events = []
    for p in sorted(outbox_dir.glob("*.json")):
        try:
            ev = json.loads(p.read_text())
        except Exception:
            continue
        events.append(ev)
    return events


def _outbox_by_source(outbox_dir: Path) -> dict[str, list[dict[str, Any]]]:
    by_source: dict[str, list[dict[str, Any]]] = {}
    for ev in _all_outbox_events(outbox_dir):
        s = ev.get("source", "_unknown")
        by_source.setdefault(s, []).append(ev)
    return by_source


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

    clock = [1_000_000]

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh_json_lines), \
         patch.object(mod, "time") as mock_time, \
         patch.object(mod, "remote_failure_context", return_value=([], {})):
        mock_time.time.side_effect = lambda: float(clock[0])
        mock_time.strftime = time.strftime
        mock_time.gmtime = time.gmtime

        # Cycles 1-2: below threshold
        for i in range(2):
            _run_once_defaults(mod, [remote])
            clock[0] += 30

        # No relay_host_down yet
        events_before = _outbox_by_source(outbox_dir)
        assert "relay_host_down" not in events_before

        # Cycle 3: threshold crossed → emit relay_host_down
        _run_once_defaults(mod, [remote])
        clock[0] += 30

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
            clock[0] += 30

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
    clock = [2_000_000]

    def fake_ssh_fail(h, script, args, timeout):
        raise RuntimeError("timeout")

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh_fail), \
         patch.object(mod, "time") as mock_time, \
         patch.object(mod, "remote_failure_context", return_value=([], {})):
        mock_time.time.side_effect = lambda: float(clock[0])
        mock_time.strftime = time.strftime
        mock_time.gmtime = time.gmtime

        schedule = mod.RELAY_BACKOFF_SCHEDULE_S  # [300, 900, 3600]

        # Cycle 1: 1 failure
        _run_once_defaults(mod, [remote])
        state = mod.load_state()
        assert state["remotes"][remote].get("consecutiveFailures", 0) == 1
        clock[0] += 30

        # Cycle 2: 2 failures
        _run_once_defaults(mod, [remote])
        state = mod.load_state()
        assert state["remotes"][remote].get("consecutiveFailures", 0) == 2
        clock[0] += 30

        # Cycle 3: 3rd failure — enters backoff, scheduleIndex=0 → 300s delay
        attempt_time = clock[0]
        _run_once_defaults(mod, [remote])
        state = mod.load_state()
        rr = state["remotes"][remote]
        assert rr.get("consecutiveFailures", 0) >= 3
        assert rr.get("downEventEmitted") is True
        # nextAttemptAt should be ~attempt_time + 300
        assert rr.get("nextAttemptAt") == pytest.approx(attempt_time + schedule[0], abs=2)
        clock[0] += 30

        # Cycles inside 300s window: skipped
        inside_window_calls = []

        def fake_ssh_record(h, s, a, t):
            inside_window_calls.append(h)
            raise RuntimeError("timeout")

        with patch.object(mod, "ssh_json_lines", side_effect=fake_ssh_record):
            # Stay well within 300s window
            for _ in range(5):
                _run_once_defaults(mod, [remote])
                clock[0] += 30
        assert inside_window_calls == [], f"ssh called inside window: {inside_window_calls}"

        # Advance past first window (300s), trigger 4th attempt → scheduleIndex=1 → 900s
        clock[0] = attempt_time + schedule[0] + 1

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
        assert rr.get("nextAttemptAt") == pytest.approx(clock[0] + schedule[1], abs=2)

        # No additional relay_host_down events (still exactly 1)
        evs = _outbox_by_source(outbox_dir)
        assert len(evs.get("relay_host_down", [])) == 1


# ---------------------------------------------------------------------------
# Test 3: recovery — relay_host_recovered emitted once, state reset
# ---------------------------------------------------------------------------

def test_relay_host_recovered_and_reset(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    host = "deadhost"
    clock = [3_000_000]
    failing = [True]

    def fake_ssh(h, script, args, timeout):
        if failing[0] and h == host:
            raise RuntimeError("timeout")
        return []

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh), \
         patch.object(mod, "time") as mock_time, \
         patch.object(mod, "remote_failure_context", return_value=([], {})):
        mock_time.time.side_effect = lambda: float(clock[0])
        mock_time.strftime = time.strftime
        mock_time.gmtime = time.gmtime

        # Drive to down state (3 failures)
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock[0] += 30

        evs = _outbox_by_source(outbox_dir)
        assert len(evs.get("relay_host_down", [])) == 1

        state = mod.load_state()
        rr = state["remotes"][remote]
        next_attempt = rr.get("nextAttemptAt", 0)

        # Advance past backoff window and switch to success
        clock[0] = next_attempt + 1
        failing[0] = False

        _run_once_defaults(mod, [remote])
        # relay_host_recovered should be emitted
        evs = _outbox_by_source(outbox_dir)
        assert len(evs.get("relay_host_recovered", [])) == 1

        # State reset
        state = mod.load_state()
        rr = state["remotes"][remote]
        assert rr.get("consecutiveFailures", 0) == 0
        assert rr.get("backoffScheduleIndex", 0) == 0
        assert rr.get("downEventEmitted", False) is False
        next_at = rr.get("nextAttemptAt")
        assert next_at is None or next_at == 0

        # Running more successful cycles should NOT emit more relay_host_recovered
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock[0] += 30
        evs = _outbox_by_source(outbox_dir)
        assert len(evs.get("relay_host_recovered", [])) == 1


# ---------------------------------------------------------------------------
# Test 4: restart persistence — no re-emit of relay_host_down after restart
# ---------------------------------------------------------------------------

def test_restart_does_not_reemit_host_down(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    remote = "deadhost:/srv/whatsoup/bot-errors"
    clock = [4_000_000]

    def fake_fail(h, script, args, timeout):
        raise RuntimeError("timeout")

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_fail), \
         patch.object(mod, "time") as mock_time, \
         patch.object(mod, "remote_failure_context", return_value=([], {})):
        mock_time.time.side_effect = lambda: float(clock[0])
        mock_time.strftime = time.strftime
        mock_time.gmtime = time.gmtime

        # Bring host to down state
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock[0] += 30

    evs_before = _outbox_by_source(outbox_dir)
    assert len(evs_before.get("relay_host_down", [])) == 1

    # Simulate restart: load fresh module instance, same state files
    mod2 = _load_mod_with_dirs(state_dir, outbox_dir)

    # After restart, still in backoff — should skip without re-emitting relay_host_down
    clock2 = [clock[0]]
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
             patch.object(mod2, "time") as mock_time2, \
             patch.object(mod2, "remote_failure_context", return_value=([], {})):
            mock_time2.time.side_effect = lambda: float(clock2[0])
            mock_time2.strftime = time.strftime
            mock_time2.gmtime = time.gmtime

            # Stay within backoff window
            for _ in range(5):
                _run_once_defaults(mod2, [remote])
                clock2[0] += 30

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
    clock = [5_000_000]

    def fake_fail(h, script, args, timeout):
        raise RuntimeError("timeout")

    meta_alert_calls: list[tuple[str, str]] = []

    def patched_enqueue(r, source, summary, evidence, state, cooldown, extra_diagnostics=None):
        meta_alert_calls.append((r, source))

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_fail), \
         patch.object(mod, "enqueue_meta_alert", side_effect=patched_enqueue), \
         patch.object(mod, "time") as mock_time, \
         patch.object(mod, "remote_failure_context", return_value=([], {})):
        mock_time.time.side_effect = lambda: float(clock[0])
        mock_time.strftime = time.strftime
        mock_time.gmtime = time.gmtime

        # Cycles 1-3: drive to down state (alert calls allowed pre-threshold)
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock[0] += 30

        meta_alert_calls.clear()  # reset after threshold crossed

        # Cycles 4-12: all inside first backoff window, should be skipped
        for _ in range(9):
            _run_once_defaults(mod, [remote])
            clock[0] += 30

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
    clock = [6_000_000]

    live_call_count = [0]

    def fake_ssh(h, script, args, timeout):
        if h == "deadhost":
            raise RuntimeError("timeout")
        live_call_count[0] += 1
        return []

    N = 10
    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh), \
         patch.object(mod, "time") as mock_time, \
         patch.object(mod, "remote_failure_context", return_value=([], {})):
        mock_time.time.side_effect = lambda: float(clock[0])
        mock_time.strftime = time.strftime
        mock_time.gmtime = time.gmtime

        for i in range(N):
            _run_once_defaults(mod, [dead_remote, live_remote])
            clock[0] += 30

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
    clock = [7_000_000]

    def fake_fail(h, s, a, t):
        raise RuntimeError("timeout")

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_fail), \
         patch.object(mod, "time") as mock_time, \
         patch.object(mod, "remote_failure_context", return_value=([], {})):
        mock_time.time.side_effect = lambda: float(clock[0])
        mock_time.strftime = time.strftime
        mock_time.gmtime = time.gmtime

        # Drive to backoff (3 failures)
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock[0] += 30

        # Now in backoff window — next cycle should be skipped with NO SSH attempt.
        ssh_calls_on_skip = [0]

        def fake_fail_counted(h, s, a, t):
            ssh_calls_on_skip[0] += 1
            raise RuntimeError("timeout")

        with patch.object(mod, "ssh_json_lines", side_effect=fake_fail_counted):
            result = _run_once_defaults(mod, [remote])
        clock[0] += 30

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
    clock = [8_000_000]
    failing = [True]

    def fake_ssh(h, script, args, timeout):
        if failing[0]:
            raise RuntimeError("timeout")
        return []

    with _env(state_dir, outbox_dir), \
         patch.object(mod, "ssh_json_lines", side_effect=fake_ssh), \
         patch.object(mod, "time") as mock_time, \
         patch.object(mod, "remote_failure_context", return_value=([], {})):
        mock_time.time.side_effect = lambda: float(clock[0])
        mock_time.strftime = time.strftime
        mock_time.gmtime = time.gmtime

        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock[0] += 30

        down_evs = _outbox_by_source(outbox_dir).get("relay_host_down", [])
        assert len(down_evs) == 1
        assert down_evs[0]["severity"] == "warning"

        # Advance past window, recover
        state = mod.load_state()
        next_attempt = state["remotes"][remote].get("nextAttemptAt", 0)
        clock[0] = next_attempt + 1
        failing[0] = False
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
    clock = [9_000_000]
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
         patch.object(mod, "time") as mock_time, \
         patch.object(mod, "remote_failure_context", return_value=([], {})):
        mock_time.time.side_effect = lambda: float(clock[0])
        mock_time.strftime = time.strftime
        mock_time.gmtime = time.gmtime

        # Drive to down state (both calls failing).
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock[0] += 30
        assert len(_outbox_by_source(outbox_dir).get("relay_host_down", [])) == 1
        rr = mod.load_state()["remotes"][remote]
        assert rr.get("downEventEmitted") is True

        # Advance past backoff window; switch to split-success (outbox OK, writefail FAIL).
        clock[0] = int(rr.get("nextAttemptAt") or 0) + 1
        phase[0] = "split"
        _run_once_defaults(mod, [remote])

        # Recovery MUST fire even though the writefail harvest failed.
        rec = _outbox_by_source(outbox_dir).get("relay_host_recovered", [])
        assert len(rec) == 1, "outbox-claim success must emit relay_host_recovered"

        # Backoff state fully reset (no livelock): consecutiveFailures back to 0,
        # down flag cleared, so a healthy outbox no longer triggers the skip path.
        rr2 = mod.load_state()["remotes"][remote]
        assert rr2.get("consecutiveFailures", 0) == 0
        assert rr2.get("downEventEmitted", False) is False
        assert rr2.get("backoffScheduleIndex", 0) == 0

        # Running more split-success cycles must NOT re-down or re-storm:
        # consecutiveFailures stays 0 (writefail failure alone does not re-arm backoff)
        # and relay_host_down is not re-emitted.
        for _ in range(3):
            _run_once_defaults(mod, [remote])
            clock[0] += 30
        assert len(_outbox_by_source(outbox_dir).get("relay_host_down", [])) == 1
        assert mod.load_state()["remotes"][remote].get("consecutiveFailures", 0) == 0
