"""Restart grace must not silence the deadman it exists to protect.

Deadman restart grace is keyed on *service uptime*, but the condition it
suppresses (``cycle_stale``) is measured on *state* age. Nothing connected the
two, so grace suppressed cycle staleness regardless of whether a restart could
account for it.

That gap is load-bearing rather than cosmetic: a dispatcher in a restart loop
satisfies ``service_uptime <= restart_grace`` on every check, so grace is
permanently active, ``cycle_stale`` is never raised, and an indefinitely broken
dispatcher keeps reporting ``deadman grace ok``. The alarm is silenced by the
exact symptom it exists to detect.

``_restart_explains_cycle_age`` bounds grace by what the restart can actually
explain: a restart ``restart_age`` seconds ago accounts for staleness of
about that duration plus the grace window, and no more. ``restart_age`` is
measured on the clock that granted grace (uptime for an active unit,
state-change age otherwise), and the end-to-end tests below drive ``deadman()``
itself so that reverting the call site fails the suite.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"


@pytest.fixture(scope="module")
def health_check():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check_grace", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_fresh_restart_explains_short_staleness(health_check):
    """The legitimate case grace was built for: just restarted, no cycle yet."""
    assert health_check._restart_explains_cycle_age(30, 20, 300) is True


def test_restart_explains_staleness_up_to_uptime_plus_grace(health_check):
    """Boundary: exactly uptime + grace is still attributable."""
    assert health_check._restart_explains_cycle_age(320, 20, 300) is True


def test_restart_does_not_explain_staleness_older_than_the_restart(health_check):
    """One second past the boundary is no longer attributable."""
    assert health_check._restart_explains_cycle_age(321, 20, 300) is False


def test_restart_loop_cannot_mask_an_indefinitely_stale_cycle(health_check):
    """The regression: uptime always under grace must not excuse hours of staleness.

    A dispatcher crash-looping every 10s has service_uptime <= restart_grace on
    every single check. Before this bound, that suppressed cycle_stale forever.
    """
    crash_loop_uptime = 10
    restart_grace = 300
    three_hours_stale = 3 * 60 * 60
    assert (
        health_check._restart_explains_cycle_age(
            three_hours_stale, crash_loop_uptime, restart_grace
        )
        is False
    )


def test_unknown_uptime_leaves_grace_intact(health_check):
    """Attribution impossible -> grace stands; never invent an alert from absence."""
    assert health_check._restart_explains_cycle_age(3600, None, 300) is True


# --- the decision itself, not just the helper -------------------------------
#
# The tests above cover _restart_explains_cycle_age's arithmetic. On their own
# they do NOT prove the helper is wired into the suppression decision: with the
# call site reverted to an unconditional `if not grace_reason`, all of them
# still passed. These exercise _cycle_stale_should_report, the predicate the
# call site actually evaluates, so removing the fix fails the suite.


def test_fresh_cycle_is_never_reported(health_check):
    assert (
        health_check._cycle_stale_should_report(10, 900, None, 5000, 300) is False
    )


def test_stale_cycle_without_grace_is_reported(health_check):
    assert (
        health_check._cycle_stale_should_report(3600, 900, None, 5000, 300) is True
    )


def test_stale_cycle_is_excused_when_the_restart_explains_it(health_check):
    """Just restarted, no cycle yet -- the case grace legitimately covers."""
    assert (
        health_check._cycle_stale_should_report(
            320, 300, "service_uptime_seconds=20", 20, 300
        )
        is False
    )


def test_restart_loop_cannot_suppress_the_stale_cycle_decision(health_check):
    """The regression, at the decision the call site evaluates.

    Crash-looping every 10s keeps grace_reason permanently set. Before the
    bound, this returned False forever and cycle_stale was never raised.
    """
    assert (
        health_check._cycle_stale_should_report(
            3 * 60 * 60, 900, "service_uptime_seconds=10", 10, 300
        )
        is True
    )


def test_unknown_restart_age_under_grace_still_suppresses(health_check):
    """Direct-caller contract only: ``deadman`` never passes None while grace is active.

    See ``test_deadman_reports_cycle_stale_when_the_unit_never_reenters_active``
    for the production shape, where the granting age is the state-change age.
    """
    assert (
        health_check._cycle_stale_should_report(
            3600, 900, "service_state_change_age_seconds=5", None, 300
        )
        is False
    )


# ---------------------------------------------------------------------------
# End-to-end: drive deadman() itself, so the live call site is what is tested.
# Reverting deadman() to the unconditional ``if not grace_reason`` (keeping the
# helpers) fails every test in this section; the helper tests above cannot see
# that revert.
# ---------------------------------------------------------------------------


class _Direct:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def __call__(self, text: str) -> None:
        self.calls.append(text)


class _Email:
    def __call__(self, subject: str, body: str) -> str:
        return "rejected"


@pytest.fixture()
def env(monkeypatch, tmp_path: Path) -> SimpleNamespace:
    spec = importlib.util.spec_from_file_location("bot_errors_health_check_grace_e2e", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, "state_root", lambda: tmp_path)
    dispatcher_state = tmp_path / mod.DISPATCHER_STATE
    socket_file = tmp_path / "personal.sock"
    socket_file.write_text("")
    monkeypatch.setattr(mod, "SOCKET_PATH", str(socket_file))
    svc = {"status": "active", "ages": (600, 600)}
    monkeypatch.setattr(mod, "service_is_active", lambda _service: svc["status"])
    monkeypatch.setattr(mod, "service_restart_ages", lambda _service: svc["ages"])
    clock = {"now": 100_000}
    monkeypatch.setattr(mod, "current_epoch", lambda: clock["now"])
    monkeypatch.setattr(mod, "send_direct", _Direct())
    monkeypatch.setattr(mod, "email_fallback_outcome", _Email())

    def cycle_completed(seconds_ago: int) -> None:
        dispatcher_state.write_text(json.dumps({"cycleCompletedAt": mod.epoch_to_iso(clock["now"] - seconds_ago)}))

    def run() -> int:
        return mod.deadman(max_state_age=180, restart_grace=30, cooldown_seconds=300)

    def members() -> set[str]:
        path = tmp_path / "deadman-state.json"
        if not path.exists():
            return set()
        record = json.loads(path.read_text(encoding="utf-8")).get("episode")
        return set(record["members"]) if isinstance(record, dict) else set()

    return SimpleNamespace(svc=svc, cycle_completed=cycle_completed, run=run, members=members)


def test_deadman_reports_cycle_stale_in_an_active_restart_loop(env):
    """Uptime 10s on every check (crash loop) must not excuse an hour of staleness."""
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    env.cycle_completed(3600)
    assert env.run() == 2
    assert env.members() == {"cycle_stale"}


def test_deadman_reports_cycle_stale_when_the_unit_never_reenters_active(env):
    """Grace granted from state-change age is bounded by that same age.

    A unit that fails before becoming active (bad EnvironmentFile, missing
    interpreter) has a fresh state change on every check and an unknown or
    stale ActiveEnter age. Bounding by uptime would have left both
    service_inactive and cycle_stale silent forever.
    """
    env.svc["status"] = "activating"
    env.svc["ages"] = (None, 5)
    env.cycle_completed(3600)
    assert env.run() == 2
    assert env.members() == {"cycle_stale"}


def test_deadman_keeps_grace_for_a_restart_that_explains_the_staleness(env):
    """The case grace exists for: just restarted, first cycle not yet complete."""
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    env.cycle_completed(35)  # <= 10 + 30
    assert env.run() == 0
    assert "cycle_stale" not in env.members()


def test_deadman_reports_a_stale_cycle_with_no_grace_at_all(env):
    env.svc["status"] = "active"
    env.svc["ages"] = (600, 600)
    env.cycle_completed(600)
    assert env.run() == 2
    assert env.members() == {"cycle_stale"}
