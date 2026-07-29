"""Regression tests: q-loop usage-window capacity must not page as critical.

Root cause being fixed: the q-loop supervisor check raised a single
``q_loop:supervisor`` problem for ANY phase that starts with
``q_unavailable_``, and ``reconcile`` then assigned it ``critical`` (new
incident) or ``critical``-when-escalated (renotify). One such phase,
``q_unavailable_session_limit`` (the claude-cli usage-window cap), is a
self-recovering capacity condition whose only remediation is to wait for the
window to reset. Paging it critical is the broken-alert anti-pattern.

These tests assert:
  (a) ``q_unavailable_session_limit`` (and other usage/rate capacity reasons)
      do NOT yield a critical/paging supervisor problem -- they yield a
      distinct, info/warning-class incident with recovery semantics, and
      ``reconcile`` never escalates them to ``critical``.
  (b) Genuine supervisor failure phases (crash / socket timeout) STILL yield
      the critical ``q_loop:supervisor`` problem and remain escalatable.
  (c) The stale-supervisor-heartbeat age check (key ``q_loop``) is unchanged
      and still fires critical for a true supervisor outage.
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest


_SCRIPT_ROOT = Path(__file__).resolve().parents[1]

# Incident keys (must match the module's classification scheme).
CAPACITY_KEY = "q_loop:supervisor:capacity"
SUPERVISOR_KEY = "q_loop:supervisor"


def _write_private_json(path: Path, payload: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    path.write_text(json.dumps(payload), encoding="utf-8")
    path.chmod(0o600)
    return path


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_heartbeat_watchdog",
        _SCRIPT_ROOT / "bot-errors-heartbeat-watchdog.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _watchdog_args(max_q_loop_age: int = 600):
    return SimpleNamespace(
        max_q_loop_age=max_q_loop_age,
        max_dispatcher_age=300,
        max_collector_age=180,
        max_daily_health_age=25 * 60 * 60,
        max_fleet_sentinel_age=2700,
    )


def _private_state(monkeypatch, tmp_path: Path) -> Path:
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state))
    monkeypatch.setenv("BOT_ERRORS_WATCHDOG_CHECKS", "q_loop")
    monkeypatch.setenv("BOT_ERRORS_DRY_NOW", "100000")
    return state


def _write_q_loop_state(mod, state: Path, monkeypatch, **fields) -> Path:
    target = state / "q-loop" / "state.json"
    monkeypatch.setenv("BOT_ERRORS_Q_LOOP_STATE", str(target))
    payload = {"updated_at": 100000}
    payload.update(fields)
    _write_private_json(target, payload)
    return target


def _events(outbox: Path) -> list[dict]:
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(outbox.glob("*.json"))]


# ---------------------------------------------------------------------------
# (a) capacity classification at detection time
# ---------------------------------------------------------------------------

CAPACITY_REASONS = [
    "session_limit",
    "rate_limit",
    "usage_limit",
]


@pytest.mark.parametrize("reason", CAPACITY_REASONS)
def test_capacity_phase_is_not_supervisor_failure(tmp_path, monkeypatch, reason):
    mod = _load_module()
    state = _private_state(monkeypatch, tmp_path)
    _write_q_loop_state(
        mod,
        state,
        monkeypatch,
        phase=f"q_unavailable_{reason}",
        last_q_unavailable_at=99940,
        last_q_unavailable_reason=reason,
    )

    problems = mod.collect_problems(_watchdog_args(), {"q_loop"})

    # No genuine-supervisor-failure problem must be raised for a capacity phase.
    assert SUPERVISOR_KEY not in problems
    # A distinct capacity-class incident is raised instead, with recovery wording.
    assert CAPACITY_KEY in problems
    evidence = problems[CAPACITY_KEY]
    assert "usage-window capacity" in evidence
    assert "self-recovers when window resets" in evidence
    assert reason in evidence


def test_is_capacity_phase_classifier():
    mod = _load_module()
    assert mod.is_capacity_supervisor_reason("session_limit") is True
    assert mod.is_capacity_supervisor_reason("rate_limit") is True
    assert mod.is_capacity_supervisor_reason("usage_limit") is True
    # Genuine failures are not capacity.
    assert mod.is_capacity_supervisor_reason("socket_timeout") is False
    assert mod.is_capacity_supervisor_reason("crash") is False
    assert mod.is_capacity_supervisor_reason("stale_heartbeat") is False
    assert mod.is_capacity_supervisor_reason("") is False


def test_capacity_new_incident_event_is_warning_not_critical(tmp_path, monkeypatch):
    mod = _load_module()
    state = _private_state(monkeypatch, tmp_path)
    outbox = tmp_path / "outbox"
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(outbox))

    written = mod.reconcile(
        {CAPACITY_KEY: "q-loop at usage-window capacity; self-recovers when window resets reason=session_limit"},
        ["q_loop"],
    )

    assert len(written) == 1
    events = _events(outbox)
    assert len(events) == 1
    assert events[0]["severity"] == "warning"
    assert events[0]["alertSource"] == CAPACITY_KEY


def test_capacity_incident_never_escalates_to_critical(tmp_path, monkeypatch):
    """Even when aged past the escalate threshold, capacity stays warning."""
    mod = _load_module()
    state = _private_state(monkeypatch, tmp_path)
    outbox = tmp_path / "outbox"
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(outbox))
    # Force renotify immediately and escalate by age.
    monkeypatch.setenv("BOT_ERRORS_WATCHDOG_RENOTIFY_SECONDS", "1")
    monkeypatch.setenv("BOT_ERRORS_WATCHDOG_ESCALATE_SECONDS", "1")

    # Seed an already-open, already-aged capacity incident.
    state_dir = state
    watchdog_state = mod.watchdog_state_path()
    _write_private_json(
        watchdog_state,
        {
            "open": {
                CAPACITY_KEY: {
                    "firstSeenAt": "1970-01-01T00:00:10Z",
                    "lastSeenAt": "1970-01-01T00:00:10Z",
                    "lastNotifiedAt": "1970-01-01T00:00:10Z",
                    "lastEvidence": "old",
                    "suppressed": 5,
                    "ageSeconds": 999999,
                }
            }
        },
    )

    written = mod.reconcile(
        {CAPACITY_KEY: "q-loop at usage-window capacity; self-recovers when window resets reason=session_limit"},
        ["q_loop"],
    )

    assert len(written) == 1
    events = _events(outbox)
    assert events[0]["severity"] == "warning"
    # Must not be a paging force-notify escalation.
    assert "critical" not in events[0]["severity"]


# ---------------------------------------------------------------------------
# (b) genuine supervisor failure stays critical
# ---------------------------------------------------------------------------

def test_genuine_supervisor_failure_phase_stays_critical(tmp_path, monkeypatch):
    mod = _load_module()
    state = _private_state(monkeypatch, tmp_path)
    target = _write_q_loop_state(
        mod,
        state,
        monkeypatch,
        phase="q_unavailable_socket_timeout",
        last_q_unavailable_at=99940,
        last_q_unavailable_reason="socket_timeout",
    )

    problems = mod.collect_problems(_watchdog_args(), {"q_loop"})

    assert CAPACITY_KEY not in problems
    assert SUPERVISOR_KEY in problems
    assert problems[SUPERVISOR_KEY] == (
        "q-loop supervisor unavailable: phase=q_unavailable_socket_timeout "
        "reason=socket_timeout age_seconds=60 last_q_unavailable_at=99940 "
        f"detail={target} updated_at=100000"
    )


def test_genuine_supervisor_new_incident_is_critical(tmp_path, monkeypatch):
    mod = _load_module()
    state = _private_state(monkeypatch, tmp_path)
    outbox = tmp_path / "outbox"
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(outbox))

    written = mod.reconcile(
        {SUPERVISOR_KEY: "q-loop supervisor unavailable: phase=q_unavailable_socket_timeout"},
        ["q_loop"],
    )

    events = _events(outbox)
    assert events[0]["severity"] == "critical"
    assert events[0]["alertSource"] == SUPERVISOR_KEY


def test_genuine_supervisor_escalates_to_critical_on_renotify(tmp_path, monkeypatch):
    mod = _load_module()
    state = _private_state(monkeypatch, tmp_path)
    outbox = tmp_path / "outbox"
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(outbox))
    monkeypatch.setenv("BOT_ERRORS_WATCHDOG_RENOTIFY_SECONDS", "1")
    monkeypatch.setenv("BOT_ERRORS_WATCHDOG_ESCALATE_SECONDS", "1")
    _write_private_json(
        mod.watchdog_state_path(),
        {
            "open": {
                SUPERVISOR_KEY: {
                    "firstSeenAt": "1970-01-01T00:00:10Z",
                    "lastSeenAt": "1970-01-01T00:00:10Z",
                    "lastNotifiedAt": "1970-01-01T00:00:10Z",
                    "lastEvidence": "old",
                    "suppressed": 5,
                    "ageSeconds": 999999,
                }
            }
        },
    )

    written = mod.reconcile(
        {SUPERVISOR_KEY: "q-loop supervisor unavailable: phase=q_unavailable_socket_timeout"},
        ["q_loop"],
    )

    events = _events(outbox)
    assert events[0]["severity"] == "critical"


# ---------------------------------------------------------------------------
# (c) stale-supervisor-heartbeat age check unchanged (true outage -> critical)
# ---------------------------------------------------------------------------

def test_stale_q_loop_heartbeat_still_critical(tmp_path, monkeypatch):
    """A true supervisor outage (no recent heartbeat) still raises q_loop critical."""
    mod = _load_module()
    state = _private_state(monkeypatch, tmp_path)
    # updated_at far in the past -> age exceeds max_q_loop_age.
    target = _write_q_loop_state(
        mod,
        state,
        monkeypatch,
        updated_at=10,
        phase="q_unavailable_session_limit",
        last_q_unavailable_at=5,
        last_q_unavailable_reason="session_limit",
    )

    problems = mod.collect_problems(_watchdog_args(max_q_loop_age=600), {"q_loop"})

    # Stale-heartbeat outage must still be reported under the q_loop key.
    assert "q_loop" in problems
    assert "stale" in problems["q_loop"]
    # And the capacity incident is still raised (phase is capacity) but NOT as
    # a genuine supervisor failure.
    assert SUPERVISOR_KEY not in problems
    assert CAPACITY_KEY in problems


def test_capacity_phase_does_not_suppress_q_loop_freshness(tmp_path, monkeypatch):
    """When the heartbeat is fresh, a capacity phase yields no stale q_loop problem."""
    mod = _load_module()
    state = _private_state(monkeypatch, tmp_path)
    _write_q_loop_state(
        mod,
        state,
        monkeypatch,
        updated_at=100000,
        phase="q_unavailable_session_limit",
        last_q_unavailable_at=99980,
        last_q_unavailable_reason="session_limit",
    )

    problems = mod.collect_problems(_watchdog_args(), {"q_loop"})

    assert "q_loop" not in problems
    assert CAPACITY_KEY in problems
