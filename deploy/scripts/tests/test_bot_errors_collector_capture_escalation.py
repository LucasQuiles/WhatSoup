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
import importlib.util
import os
import sys
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Module loader (mirrors test_bot_errors_collector_backoff.py style)
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


@pytest.fixture()
def tmp_state(tmp_path: Path):
    state_dir = tmp_path / "bot-errors"
    outbox_dir = tmp_path / "outbox"
    state_dir.mkdir(mode=0o700)
    outbox_dir.mkdir(mode=0o700)
    return state_dir, outbox_dir


@contextlib.contextmanager
def _env(state_dir: Path, outbox_dir: Path, extra: dict[str, str] | None = None):
    env_map = {
        "BOT_ERRORS_STATE_DIR": str(state_dir),
        "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
        "BOT_ERRORS_TAILSCALE_STATUS_COMMAND": "",
    }
    if extra:
        env_map.update(extra)
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


def _load_mod_with_dirs(state_dir: Path, outbox_dir: Path, extra_env: dict[str, str] | None = None):
    env = {
        "BOT_ERRORS_STATE_DIR": str(state_dir),
        "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
        "BOT_ERRORS_TAILSCALE_STATUS_COMMAND": "",
    }
    if extra_env:
        env.update(extra_env)
    return _load_module(extra_env=env)


class FakeCollectorClock:
    def __init__(self, start: int):
        self.now = start

    def time(self) -> float:
        return float(self.now)

    def advance(self, seconds: int) -> None:
        self.now += seconds

    def set(self, value: int) -> None:
        self.now = value


@contextlib.contextmanager
def _patched_collector_clock(mod, clock: FakeCollectorClock):
    with patch.object(mod, "time") as mock_time:
        mock_time.time.side_effect = clock.time
        mock_time.strftime = time.strftime
        mock_time.gmtime = time.gmtime
        yield


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
    import json

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
