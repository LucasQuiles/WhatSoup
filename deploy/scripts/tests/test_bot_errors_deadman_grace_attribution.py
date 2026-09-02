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

``state_missing`` and ``cycle_incomplete`` have no cycle timestamp to attribute
against: a restart legitimately follows an arbitrarily old heartbeat (the
downtime before it was already reported as ``service_inactive``), and
``tests/scripts/bot-errors-health-check.test.ts`` pins that a stale heartbeat
is graced inside a fresh restart window. There the only evidence of a restart
loop is grace itself persisting across checks, so both branches are bounded by
the persisted grace streak (``_grace_still_credible``): grace that has been
continuously active for longer than ``max_state_age`` is a loop, not a fresh
start.

"Continuously" is measured as the sum of the intervals the deadman actually
observed, on a since-boot monotonic clock (Linux CLOCK_BOOTTIME, macOS
CLOCK_MONOTONIC), tied to a clock-independent boot identity (Linux boot_id,
macOS kern.bootsessionuuid). A backwards wall-clock step is therefore neither a
re-seed nor a corrupt record: with the monotonic clock the interval is exact,
and without it the wall interval is clamped at zero. A single interval longer
than twice the timer cadence (a suspend, a stopped timer) credits nothing, so
the first check after it cannot page a dispatcher that has only had seconds;
consecutive long intervals each credit the cap, so a deadman that keeps
running late still reports a restart loop within a few checks instead of
re-seeding forever. Only a different boot identity re-seeds: the boot ended
the process the previous grace belonged to.

A gap longer than twice the timer interval (``--check-interval``, default 300
= ``OnUnitActiveSec=5m``) is not silently absorbed: it is persisted as
``lastCheckGapSeconds`` and printed as ``check_gap_seconds=`` on the grace line,
so a starved or stopped deadman timer is visible as its own signal.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from hypothesis import HealthCheck, given
from hypothesis import settings as hypothesis_settings
from hypothesis import strategies as st

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


# --- the streak bound used by the branches that have no cycle timestamp -------


def test_grace_is_credible_on_the_first_graced_check(health_check):
    assert health_check._grace_still_credible("service_uptime_seconds=2", 0, 30) is True


def test_grace_stays_credible_up_to_max_state_age_of_streak(health_check):
    assert health_check._grace_still_credible("service_uptime_seconds=10", 180, 180) is True


def test_grace_is_not_credible_once_the_streak_outlives_max_state_age(health_check):
    assert health_check._grace_still_credible("service_uptime_seconds=10", 181, 180) is False


def test_no_grace_is_never_credible(health_check):
    assert health_check._grace_still_credible(None, 0, 180) is False


# --- streak accumulation: observed intervals on the boot's monotonic clock -------

_CAP = 600  # 2 x the default check interval


def _record(now=200_000, *, since=None, seen=None, boot="boot-A", mono=1000, acc=0, forgiven=False):
    return {
        "graceStreakSince": now - 900 if since is None else since,
        "graceStreakSeenAt": now - 300 if seen is None else seen,
        "graceStreakBootId": boot,
        "graceStreakSeenMonotonic": mono,
        "graceStreakAccumulated": acc,
        "graceStreakGapForgiven": forgiven,
    }


def test_grace_streak_accumulates_an_observed_interval_at_the_timer_cadence(health_check):
    now = 200_000
    state = _record(now, mono=1000, acc=600)
    assert health_check._note_grace_streak(state, True, now, "boot-A", 1300, _CAP) == (900, True, 300)
    assert state["graceStreakSeenMonotonic"] == 1300 and state["graceStreakSeenAt"] == now
    assert state["graceStreakAccumulated"] == 900 and state["graceStreakGapForgiven"] is False


def test_grace_streak_forgives_a_single_long_gap_but_reports_it(health_check):
    """One 8h interval the deadman did not observe credits nothing (a suspend or a
    stopped timer is not observed grace) but is still returned as the gap."""
    now = 200_000
    state = _record(now, mono=1000, acc=300)
    assert health_check._note_grace_streak(state, True, now, "boot-A", 1000 + 8 * 3600, _CAP) == (300, True, 8 * 3600)
    assert state["graceStreakGapForgiven"] is True


def test_grace_streak_credits_consecutive_long_gaps_at_the_cap(health_check):
    """A second long interval in a row means the cadence is starved, not paused:
    each credits the cap, so a restart loop is reported within a few checks."""
    now = 200_000
    state = _record(now, mono=1000, acc=300, forgiven=True)
    assert health_check._note_grace_streak(state, True, now, "boot-A", 1601, _CAP) == (900, True, 601)
    assert state["graceStreakGapForgiven"] is True


def test_grace_streak_forgiveness_resets_after_a_normal_interval(health_check):
    now = 200_000
    state = _record(now, mono=1000, acc=300, forgiven=True)
    assert health_check._note_grace_streak(state, True, now, "boot-A", 1300, _CAP) == (600, True, 300)
    assert state["graceStreakGapForgiven"] is False


def test_grace_streak_uses_the_monotonic_clock_when_the_wall_clock_steps_back(health_check):
    """Wall clock stepped back 5000s between checks; the monotonic clock says 300s."""
    now = 200_000
    state = _record(now, seen=now + 5000, mono=1000, acc=0)
    assert health_check._note_grace_streak(state, True, now, "boot-A", 1300, _CAP) == (300, True, 300)


def test_grace_streak_clamps_a_backwards_wall_step_without_a_monotonic_clock(health_check):
    """No monotonic clock: a backwards step is a zero-length interval, never a re-seed."""
    now = 200_000
    state = _record(now, seen=now + 5000, mono=None, acc=300)
    assert health_check._note_grace_streak(state, True, now, "boot-A", None, _CAP) == (300, True, 0)
    assert state["graceStreakAccumulated"] == 300 and state["graceStreakSince"] == now - 900


def test_grace_streak_falls_back_to_wall_time_when_the_monotonic_clock_is_unavailable_now(health_check):
    now = 200_000
    state = _record(now, mono=1000, acc=0)
    assert health_check._note_grace_streak(state, True, now, "boot-A", None, _CAP) == (300, True, 300)


def test_grace_streak_reseeds_after_a_reboot(health_check):
    now = 200_000
    state = _record(now, mono=90_000, acc=5000)
    assert health_check._note_grace_streak(state, True, now, "boot-B", 20, _CAP) == (0, True, None)
    assert state["graceStreakSince"] == now and state["graceStreakSeenAt"] == now
    assert state["graceStreakBootId"] == "boot-B" and state["graceStreakSeenMonotonic"] == 20
    assert state["graceStreakAccumulated"] == 0 and state["graceStreakGapForgiven"] is False


def test_grace_streak_with_unknown_host_boot_continues(health_check):
    """Boot identity unavailable now: continuity cannot be disproved and a missed
    alarm is the worse error, so the streak continues."""
    now = 200_000
    state = _record(now, mono=1000, acc=0)
    assert health_check._note_grace_streak(state, True, now, None, 1300, _CAP) == (300, True, 300)


def test_grace_streak_seeded_without_a_boot_identity_still_continues(health_check):
    """A record seeded while the identity was unknown must not re-seed on every check."""
    now = 200_000
    state = {}
    assert health_check._note_grace_streak(state, True, now - 300, None, 1000, _CAP) == (0, True, None)
    assert health_check._note_grace_streak(state, True, now, "boot-A", 1300, _CAP) == (300, True, 300)
    assert state["graceStreakBootId"] == "boot-A"


def test_grace_streak_without_a_complete_record_is_reseeded(health_check):
    now = 200_000
    for partial in ({"graceStreakSince": now - 900}, {"graceStreakSince": now - 900, "graceStreakSeenAt": now - 300, "graceStreakBootId": "boot-A"}):
        state = dict(partial)
        assert health_check._note_grace_streak(state, True, now, "boot-A", 1300, _CAP) == (0, True, None)
        assert state["graceStreakAccumulated"] == 0


@given(bad=st.one_of(st.booleans(), st.integers(max_value=0)))
@hypothesis_settings(max_examples=60, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
def test_grace_streak_rejects_a_corrupt_epoch_in_either_field(health_check, bad):
    """bool passes isinstance int; zero and negatives are not epochs. Either field
    corrupt re-seeds; the other field is valid so the rejection is isolated."""
    now = 200_000
    for field in ("graceStreakSince", "graceStreakSeenAt"):
        state = _record(now)
        state[field] = bad
        assert health_check._note_grace_streak(state, True, now, "boot-A", 1300, _CAP) == (0, True, None)
        assert state[field] == now and type(state[field]) is int


def test_grace_streak_lapse_clears_every_field(health_check):
    state = _record(200_000)
    assert health_check._note_grace_streak(state, False, 200_000, "boot-A", 1300, _CAP) == (0, True, None)
    assert not any(k.startswith("graceStreak") for k in state)


# --- the host clocks the streak is measured on --------------------------------


def test_host_boot_id_prefers_the_dry_override(health_check, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_DRY_HOST_BOOT_ID", "dry-boot")
    assert health_check._host_boot_id() == "dry-boot"
    monkeypatch.setenv("BOT_ERRORS_DRY_HOST_BOOT_ID", "")
    assert health_check._host_boot_id() is None


def test_host_boot_id_reads_the_macos_boot_session_uuid(health_check, monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_DRY_HOST_BOOT_ID", raising=False)
    monkeypatch.setattr(health_check, "HOST_PLATFORM", "darwin")
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return SimpleNamespace(stdout="1D89CD9D-C880-41A9-823E-FC91AFD6ACB5\n", returncode=0)

    monkeypatch.setattr(health_check.subprocess, "run", fake_run)
    assert health_check._host_boot_id() == "bootsession:1D89CD9D-C880-41A9-823E-FC91AFD6ACB5"
    assert calls == [["sysctl", "-n", "kern.bootsessionuuid"]]


def test_host_boot_id_reads_the_linux_boot_id(health_check, monkeypatch, tmp_path):
    monkeypatch.delenv("BOT_ERRORS_DRY_HOST_BOOT_ID", raising=False)
    monkeypatch.setattr(health_check, "HOST_PLATFORM", "linux")
    boot_file = tmp_path / "boot_id"
    boot_file.write_text("5b0a4a3e-1f7d-4e5e-9c0a-2c1d7c9b6f3a\n")
    monkeypatch.setattr(health_check, "_LINUX_BOOT_ID_PATH", boot_file)
    assert health_check._host_boot_id() == "boot_id:5b0a4a3e-1f7d-4e5e-9c0a-2c1d7c9b6f3a"
    boot_file.unlink()
    assert health_check._host_boot_id() is None


def test_host_monotonic_seconds_prefers_the_dry_override_and_survives_failure(health_check, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_DRY_HOST_MONOTONIC_SECONDS", "1234.9")
    assert health_check._host_monotonic_seconds() == 1234
    monkeypatch.setenv("BOT_ERRORS_DRY_HOST_MONOTONIC_SECONDS", "junk")
    assert health_check._host_monotonic_seconds() is None
    monkeypatch.delenv("BOT_ERRORS_DRY_HOST_MONOTONIC_SECONDS")
    monkeypatch.setattr(health_check.time, "clock_gettime", lambda _clock: (_ for _ in ()).throw(OSError("no clock")))
    assert health_check._host_monotonic_seconds() is None


def test_host_monotonic_seconds_is_a_since_boot_clock(health_check, monkeypatch):
    """Not vacuous for availability: on a platform that exposes the boot clock
    the value must be a positive int, and only a platform without it may
    return None."""
    monkeypatch.delenv("BOT_ERRORS_DRY_HOST_MONOTONIC_SECONDS", raising=False)
    import time as _time

    clock_name = "CLOCK_MONOTONIC" if health_check.HOST_PLATFORM == "darwin" else "CLOCK_BOOTTIME"
    value = health_check._host_monotonic_seconds()
    if hasattr(_time, clock_name):
        assert isinstance(value, int) and value > 0
    else:
        assert value is None


def test_host_monotonic_seconds_rejects_a_malformed_dry_override(health_check, monkeypatch):
    """A dry override is a test knob; a bad one must degrade to the wall-clock
    fallback, never crash the deadman or poison the record (a negative value
    would classify the next record as corrupt and refuse grace)."""
    for bad in ("inf", "-inf", "nan", "-5", "1e400", ""):
        monkeypatch.setenv("BOT_ERRORS_DRY_HOST_MONOTONIC_SECONDS", bad)
        assert health_check._host_monotonic_seconds() is None, bad


# ---------------------------------------------------------------------------
# End-to-end: drive deadman() itself, so the live call site is what is tested.
# Reverting deadman() to the unconditional ``if not grace_reason`` (keeping the
# helpers) fails the two restart-loop tests and the grace-decided test below;
# the helper tests above cannot see that revert.
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
    boot = {"id": "boot-A"}
    monkeypatch.setattr(mod, "_host_boot_id", lambda: boot["id"])
    mono = {"now": 500_000}
    monkeypatch.setattr(mod, "_host_monotonic_seconds", lambda: mono["now"])
    clock = {"now": 100_000}
    monkeypatch.setattr(mod, "current_epoch", lambda: clock["now"])
    monkeypatch.setattr(mod, "send_direct", _Direct())
    monkeypatch.setattr(mod, "email_fallback_outcome", _Email())

    def cycle_completed(seconds_ago: int) -> None:
        dispatcher_state.write_text(json.dumps({"cycleCompletedAt": mod.epoch_to_iso(clock["now"] - seconds_ago)}))

    def state_written(seconds_ago: int, payload: dict | None = None) -> None:
        """Write a state file whose mtime is ``seconds_ago`` on the fixture clock (no cycleCompletedAt by default)."""
        dispatcher_state.write_text(json.dumps(payload or {}))
        stamp = clock["now"] - seconds_ago
        os.utime(dispatcher_state, (stamp, stamp))

    def advance(seconds: int, wall: int | None = None) -> None:
        """Advance the monotonic clock by ``seconds`` and the wall clock by ``wall``
        (default: the same), so a wall-clock step can be simulated."""
        if mono["now"] is not None:
            mono["now"] += seconds
        clock["now"] += seconds if wall is None else wall

    def run(max_state_age: int = 180, restart_grace: int = 30, check_interval: int | None = None) -> int:
        kwargs = {} if check_interval is None else {"check_interval": check_interval}
        return mod.deadman(max_state_age=max_state_age, restart_grace=restart_grace, cooldown_seconds=300, **kwargs)

    def deadman_state() -> dict:
        path = tmp_path / "deadman-state.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def members() -> set[str]:
        path = tmp_path / "deadman-state.json"
        if not path.exists():
            return set()
        record = json.loads(path.read_text(encoding="utf-8")).get("episode")
        return set(record["members"]) if isinstance(record, dict) else set()

    def state_removed() -> None:
        if dispatcher_state.exists():
            dispatcher_state.unlink()

    return SimpleNamespace(mod=mod, svc=svc, boot=boot, mono=mono, clock=clock, cycle_completed=cycle_completed, state_written=state_written, state_removed=state_removed, advance=advance, run=run, members=members, deadman_state=deadman_state)


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
    """The case grace exists for: just restarted, first cycle not yet complete.

    The cycle age (35s) is past the staleness threshold (20s here) so the
    decision is made by grace, not by the threshold: a restart 10s ago plus a
    30s grace window explains 35s of staleness. At the shipped flags
    (``--max-state-age 180``, grace 30) grace requires an age at or under 30
    while staleness starts at 181, so no input reaches this branch in
    production; the threshold is lowered here to exercise the code path.
    """
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    env.cycle_completed(35)  # > 20 (stale) and <= 10 + 30 (explained by the restart)
    assert env.run(max_state_age=20) == 0
    assert "cycle_stale" not in env.members()


def test_deadman_reports_when_grace_is_ignored_for_a_stale_cycle(env):
    """Same shape as above with the restart too old to explain the staleness."""
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    env.cycle_completed(41)  # > 10 + 30: the restart no longer explains it
    assert env.run(max_state_age=20) == 2
    assert env.members() == {"cycle_stale"}


def test_deadman_reports_a_stale_cycle_with_no_grace_at_all(env):
    env.svc["status"] = "active"
    env.svc["ages"] = (600, 600)
    env.cycle_completed(600)
    assert env.run() == 2
    assert env.members() == {"cycle_stale"}


def test_deadman_graces_a_stale_heartbeat_inside_a_fresh_restart_window(env):
    """The contract tests/scripts/bot-errors-health-check.test.ts pins ("graces a
    stale dispatcher heartbeat when service uptime is inside restart grace"): a
    120s-old state file with no cycleCompletedAt, 2s after a restart, at the
    flags that test uses. The heartbeat predates the restart, but a restart
    legitimately follows an old heartbeat; bounding this branch by the restart
    age reported it and broke that test in CI."""
    env.svc["status"] = "active"
    env.svc["ages"] = (2, 2)
    env.state_written(120, {"time": env.mod.epoch_to_iso(100_000)})
    assert env.run(max_state_age=30, restart_grace=30) == 0
    assert "cycle_incomplete" not in env.members()


def test_deadman_graces_a_stale_heartbeat_for_a_transitional_unit(env):
    """Same contract for the state-change-age clock (unit activating, 2s in)."""
    env.svc["status"] = "activating"
    env.svc["ages"] = (None, 2)
    env.state_written(120, {"time": env.mod.epoch_to_iso(100_000)})
    assert env.run(max_state_age=30, restart_grace=30) == 0
    assert "cycle_incomplete" not in env.members()


def test_deadman_reports_an_incomplete_state_once_grace_outlives_the_threshold(env):
    """A state file without cycleCompletedAt (a cycle that never finished) is
    excused by a restart window, but a window that stays open for longer than
    max_state_age is a restart loop: uptime 10s on every check, state never
    completing, must be reported once the streak passes the threshold."""
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    env.state_written(100)
    assert env.run() == 0  # first graced check: indistinguishable from a fresh start
    assert "cycle_incomplete" not in env.members()
    env.advance(200)  # > max_state_age 180 of continuous grace
    env.state_written(300)
    assert env.run() == 2
    assert env.members() == {"cycle_incomplete"}


def test_deadman_reports_an_incomplete_state_with_no_grace_at_all(env):
    env.svc["status"] = "active"
    env.svc["ages"] = (600, 600)
    env.state_written(100)
    assert env.run() == 2
    assert env.members() == {"cycle_incomplete"}


def test_deadman_excuses_an_incomplete_state_the_restart_explains(env):
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    env.state_written(35)
    assert env.run() == 0
    assert "cycle_incomplete" not in env.members()


def test_deadman_reports_missing_state_once_grace_outlives_the_threshold(env):
    """No state file, uptime always 10s: the first check is a plausible fresh
    start, but grace that stays continuously active longer than max_state_age
    is a restart loop that never wrote state."""
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    assert env.run() == 0
    assert "state_missing" not in env.members()
    env.advance(200)  # > max_state_age 180 of continuous grace
    assert env.run() == 2
    assert env.members() == {"state_missing"}


def test_deadman_grace_streak_resets_when_grace_lapses(env, tmp_path):
    """The persisted streak must start at the first graced check, clear when
    grace lapses, and re-seed at the next graced check. Asserted on the
    persisted field, so removing the reset fails this test."""
    state_path = tmp_path / "deadman-state.json"

    def persisted():
        return json.loads(state_path.read_text()).get("graceStreakSince")

    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    assert env.run() == 0
    assert persisted() == 100_000  # seeded at the first graced check
    env.advance(100)
    env.svc["ages"] = (600, 600)  # grace lapses: a long-running unit with a fresh cycle
    env.cycle_completed(5)
    assert env.run() == 0
    assert persisted() is None  # cleared and persisted
    env.advance(300)  # longer than max_state_age since the first seed
    env.svc["ages"] = (10, 10)  # grace again: the streak must restart now, not resume
    env.state_removed()  # no state file: only the streak can decide state_missing
    assert env.run() == 0
    assert persisted() == 100_400
    assert "state_missing" not in env.members()


def test_deadman_grace_streak_rejects_bool_zero_and_negative_epochs(env, tmp_path):
    """A corrupt graceStreakSince (bool passes isinstance int; zero; negative) must
    not manufacture an enormous streak. It is re-seeded as an int, but the check
    that found it refuses grace: a continuity record this process did not write
    validly cannot vouch for a fresh restart, and re-seeding to zero would make
    grace credible again for a whole max_state_age (the gate's finding)."""
    for bad in (True, 0, -5):
        (tmp_path / "deadman-state.json").write_text(json.dumps({"schemaVersion": 1, "incidents": {}, "graceStreakSince": bad, "graceStreakSeenAt": 100_000, "graceStreakBootId": "boot-A", "graceStreakSeenMonotonic": 500_000, "graceStreakAccumulated": 0, "graceStreakGapForgiven": False}))
        (tmp_path / "deadman-state.json").chmod(0o600)  # durable_json refuses group/other-readable targets
        env.svc["status"] = "active"
        env.svc["ages"] = (10, 10)
        assert env.run() == 2, bad
        assert env.members() == {"state_missing"}, bad
        saved = json.loads((tmp_path / "deadman-state.json").read_text())
        assert saved["graceStreakSince"] == 100_000 and type(saved["graceStreakSince"]) is int
        assert saved["episode"]["members"]["state_missing"]["detail"]["grace_refused"] == "corrupt_streak_record"
        (tmp_path / "deadman-state.json").unlink()


def test_deadman_graces_again_once_the_corrupt_record_is_re_seeded(env, tmp_path):
    """Refusing grace on a corrupt record is a one-check verdict: the re-seeded
    valid record vouches normally on the next check, so a genuinely fresh
    restart is graced again rather than paged on every check."""
    (tmp_path / "deadman-state.json").write_text(json.dumps({"schemaVersion": 1, "incidents": {}, "graceStreakSince": True, "graceStreakSeenAt": 100_000, "graceStreakBootId": "boot-A", "graceStreakSeenMonotonic": 500_000, "graceStreakAccumulated": 0, "graceStreakGapForgiven": False}))
    (tmp_path / "deadman-state.json").chmod(0o600)
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    assert env.run() == 2
    assert env.members() == {"state_missing"}
    env.advance(30)
    env.svc["ages"] = (10, 10)
    assert env.run() == 0
    assert "state_missing" not in env.members()


def test_deadman_still_re_seeds_a_partial_record_silently(env, tmp_path):
    """A record missing fields is an upgrade or a first run, not corruption:
    it re-seeds and grace stays credible, exactly as before."""
    (tmp_path / "deadman-state.json").write_text(json.dumps({"schemaVersion": 1, "incidents": {}, "graceStreakSince": 100_000, "graceStreakSeenAt": 100_000}))
    (tmp_path / "deadman-state.json").chmod(0o600)
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    assert env.run() == 0
    assert "state_missing" not in env.members()
    assert env.deadman_state()["graceStreakAccumulated"] == 0


def test_grace_streak_record_state_distinguishes_absent_partial_valid_and_corrupt(health_check):
    valid = {"graceStreakSince": 1, "graceStreakSeenAt": 1, "graceStreakBootId": "b", "graceStreakSeenMonotonic": 0, "graceStreakAccumulated": 0, "graceStreakGapForgiven": False}
    assert health_check._grace_streak_record_state({}) == "absent"
    assert health_check._grace_streak_record_state({"graceStreakSince": 1}) == "partial"
    assert health_check._grace_streak_record_state(dict(valid)) == "valid"
    assert health_check._grace_streak_record_state({**valid, "graceStreakSeenMonotonic": None}) == "valid"
    for field, bad in (("graceStreakSince", True), ("graceStreakSince", 0), ("graceStreakSeenAt", -1), ("graceStreakBootId", 7), ("graceStreakSeenMonotonic", "x"), ("graceStreakAccumulated", -1), ("graceStreakGapForgiven", "no")):
        assert health_check._grace_streak_record_state({**valid, field: bad}) == "corrupt", (field, bad)


def test_deadman_does_not_page_a_fresh_restart_after_a_reboot(env):
    """The record left by a graced check before a reboot belongs to a process the
    boot ended: a genuinely fresh restart afterwards (uptime 2s, 120s-old
    heartbeat, no cycleCompletedAt) is graced, not paged."""
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    assert env.run() == 0  # seeds the streak on boot-A
    env.advance(8 * 3600)
    env.boot["id"] = "boot-B"  # the host rebooted
    env.svc["ages"] = (2, 2)
    env.state_written(120, {"time": env.mod.epoch_to_iso(100_000)})
    assert env.run() == 0
    assert "cycle_incomplete" not in env.members()


def test_deadman_reports_a_restart_loop_even_when_its_own_checks_are_starved(env):
    """The regression the cross-model review found: checks 601s apart (every gap
    past the cadence) must not re-seed forever. The first long gap is forgiven
    (it could be a suspend); the second in a row credits the cap, so the loop
    is reported on the third check and stays reported."""
    env.svc["status"] = "active"
    env.svc["ages"] = (2, 2)
    env.state_written(120, {"time": env.mod.epoch_to_iso(100_000)})
    assert env.run(max_state_age=30, restart_grace=30) == 0
    env.advance(601)
    env.state_written(120, {"time": env.mod.epoch_to_iso(100_000)})
    assert env.run(max_state_age=30, restart_grace=30) == 0  # one long gap: forgiven
    for _ in range(2):
        env.advance(601)
        env.state_written(120, {"time": env.mod.epoch_to_iso(100_000)})
        assert env.run(max_state_age=30, restart_grace=30) == 2
        assert env.members() == {"cycle_incomplete"}


def test_deadman_reports_a_missing_state_loop_even_when_its_own_checks_are_starved(env):
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    assert env.run() == 0
    env.advance(601)
    assert env.run() == 0
    env.advance(601)
    assert env.run() == 2
    assert env.members() == {"state_missing"}


def test_deadman_does_not_page_on_the_first_check_after_a_suspend(env):
    """The mirror of the starved-cadence case: one 8h absence on the same boot
    (suspend, stopped timer) credits nothing, so a dispatcher that has only had
    seconds since resume is graced; it is reported one normal interval later if
    its cycle is still incomplete."""
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    assert env.run() == 0
    env.advance(8 * 3600)
    env.svc["ages"] = (2, 2)
    env.state_written(120, {"time": env.mod.epoch_to_iso(100_000)})
    assert env.run() == 0
    assert "cycle_incomplete" not in env.members()
    env.advance(300)
    env.state_written(420, {"time": env.mod.epoch_to_iso(100_000)})
    assert env.run() == 2
    assert env.members() == {"cycle_incomplete"}


def test_deadman_survives_a_backwards_wall_clock_step(env):
    """A recurring backwards wall-clock step must not re-seed the streak: the
    interval is read from the monotonic clock. On the pushed head this stayed
    silent forever."""
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    env.state_written(100)
    assert env.run() == 0
    for _ in range(2):
        env.advance(300, wall=-5000)  # monotonic +300, wall -5000
        env.state_written(100)
    assert env.run() == 2
    assert env.members() == {"cycle_incomplete"}


def test_deadman_survives_a_backwards_wall_clock_step_without_a_monotonic_clock(env):
    env.mono["now"] = None
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    env.state_written(100)
    assert env.run() == 0
    env.advance(0, wall=-5000)  # backwards step: a zero-length interval, no re-seed
    env.state_written(100)
    assert env.run() == 0
    assert env.deadman_state()["graceStreakAccumulated"] == 0
    env.advance(0, wall=300)
    env.state_written(100)
    assert env.run() == 2  # the record survived the step, so the next interval counts
    assert env.members() == {"cycle_incomplete"}


def test_deadman_reports_an_observation_gap_instead_of_absorbing_it(env, capsys):
    """A same-boot gap longer than twice the timer interval is a signal about the
    deadman itself: persisted and printed, never silently forgiven."""
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    env.cycle_completed(5)
    assert env.run() == 0
    assert "lastCheckGapSeconds" not in env.deadman_state()
    env.advance(700)
    env.cycle_completed(5)
    assert env.run() == 0
    assert env.deadman_state()["lastCheckGapSeconds"] == 700
    assert "check_gap_seconds=700" in capsys.readouterr().out
    gap_seen_at = env.mod.epoch_to_iso(env.clock["now"])
    assert env.deadman_state()["lastCheckGapAt"] == gap_seen_at
    env.advance(300)
    env.cycle_completed(5)
    assert env.run() == 0
    # The last gap is a durable record of the deadman's own absence: a check at
    # the normal cadence must not erase it (it was write-only otherwise).
    assert env.deadman_state()["lastCheckGapSeconds"] == 700
    assert env.deadman_state()["lastCheckGapAt"] == gap_seen_at
    assert "check_gap_seconds" not in capsys.readouterr().out
    env.advance(1_000)
    env.cycle_completed(5)
    assert env.run() == 0
    assert env.deadman_state()["lastCheckGapSeconds"] == 1_000  # only the next gap replaces it
    assert env.deadman_state()["lastCheckGapAt"] == env.mod.epoch_to_iso(env.clock["now"])


def test_deadman_observation_gap_threshold_follows_check_interval(env, capsys):
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    env.cycle_completed(5)
    assert env.run(check_interval=900) == 0
    env.advance(700)
    env.cycle_completed(5)
    assert env.run(check_interval=900) == 0  # 700 <= 2 x 900: not a gap at that cadence
    assert "lastCheckGapSeconds" not in env.deadman_state()
    assert "check_gap_seconds" not in capsys.readouterr().out


def test_deadman_still_reports_an_incomplete_state_loop_at_the_timer_cadence(env):
    """Checks 300s apart (OnUnitActiveSec=5m) stay continuous at the default
    limit, so the loop is reported on the second check."""
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    env.state_written(100)
    assert env.run() == 0
    env.advance(300)
    env.state_written(400)
    assert env.run() == 2
    assert env.members() == {"cycle_incomplete"}


# ---------------------------------------------------------------------------
# The gap limit is derived from --check-interval, whose default must equal the
# cadence the shipped schedulers actually run at. The shipped units pass no
# value, so the coupling is implicit; this pins it so changing the timer
# without changing the default cannot make the observation-gap threshold and
# late-interval credit cap drift from the cadence that actually invokes it.
# ---------------------------------------------------------------------------

_DEPLOY = Path(__file__).resolve().parents[2]


_SYSTEMD_UNITS = {
    "s": 1, "sec": 1, "second": 1, "seconds": 1,
    "m": 60, "min": 60, "minute": 60, "minutes": 60,
    "h": 3600, "hr": 3600, "hour": 3600, "hours": 3600,
    "d": 86400, "day": 86400, "days": 86400,
}


def _systemd_seconds(value: str) -> int:
    """Parse the systemd time-span forms a timer here could plausibly use (5m, 300s,
    5min, 1h, 2m30s, 5minutes...). An unknown unit fails the test by name rather than
    by KeyError so a rewrite in a valid-but-unlisted spelling is diagnosed, not buried."""
    total = 0
    matched = 0
    if re.search(r"[A-Z]", value):
        # systemd time units are lowercase; an uppercase unit makes the file unloadable.
        pytest.fail(f"uppercase time unit in {value!r}: systemd would not load this timer")
    if not re.fullmatch(r"(\s*\d+\s*[a-z]*)+\s*", value):
        # The whole value must be number-unit pairs: leading junk or a separator
        # systemd rejects was silently skipped by the scan below.
        pytest.fail(f"partially parseable systemd time span {value!r}: systemd would not load this timer")
    for number, unit in re.findall(r"(\d+)\s*([a-z]*)", value.strip()):
        unit_key = unit or "s"
        if unit_key not in _SYSTEMD_UNITS:
            pytest.fail(f"unknown systemd time unit {unit!r} in {value!r}; extend _SYSTEMD_UNITS")
        total += int(number) * _SYSTEMD_UNITS[unit_key]
        matched += 1
    assert matched, f"no duration found in {value!r}"
    return total


def _deadman_plist_block(installer: str) -> str:
    """The heredoc that write_plist emits for the deadman agent, bounded by the next
    write_plist call so another block's keys can never be read as the deadman's."""
    start = installer.index('write_plist "$deadman_label"')
    nxt = installer.find("write_plist ", start + 1)
    return installer[start: nxt if nxt != -1 else len(installer)]


def _on_unit_active_values(timer_text: str) -> list[str]:
    """Every OnUnitActiveSec assignment, read the way systemd's parser reads it:
    continuation lines (a trailing backslash) are joined first, whitespace around
    the key and the '=' is stripped, and the value runs to end of line (there are
    no inline comments)."""
    joined = re.sub(r"[ \t]*\\\n\s*", " ", timer_text)
    return [v.strip() for v in re.findall(r"^\s*OnUnitActiveSec\s*=(.*)$", joined, re.M)]


def test_timer_pin_joins_continuation_lines():
    """systemd concatenates a line ending in a backslash with the next one, so
    'OnUnitActiveSec=5m \\' + '10m' is the single value '5m 10m' (900s)."""
    assert _on_unit_active_values("[Timer]\nOnUnitActiveSec=5m \\\n10m\n") == ["5m 10m"]
    assert _systemd_seconds("5m 10m") == 900
    assert _on_unit_active_values("OnUnitActiveSec =15m\nOnUnitActiveSec=5m\n") == ["15m", "5m"]


def test_default_check_interval_matches_the_systemd_timer_cadence(health_check):
    timer = (_DEPLOY / "bot-errors-deadman.timer").read_text(encoding="utf-8")
    values = _on_unit_active_values(timer)
    assert values, "bot-errors-deadman.timer has no OnUnitActiveSec"
    for value in values:
        # An empty assignment resets the setting: the timer would lose its repeat trigger.
        assert value, "bot-errors-deadman.timer has an empty OnUnitActiveSec assignment (resets the cadence)"
        if ";" in value or "#" in value:
            pytest.fail(f"inline comment in OnUnitActiveSec value {value!r}: systemd has no inline comments; the unit would not load")
    # systemd honours the LAST assignment in the file, so an appended override is the
    # value that runs; every assignment must agree so no reading of the file is wrong.
    assert all(_systemd_seconds(v) == health_check.DEADMAN_CHECK_INTERVAL_SECONDS for v in values), values


def test_default_check_interval_matches_the_launchd_deadman_agent_cadence(health_check):
    installer = (_DEPLOY / "scripts" / "install-bot-errors-launchd.sh").read_text(encoding="utf-8")
    block = _deadman_plist_block(installer)
    match = re.search(r"<key>StartInterval</key><integer>(\d+)</integer>", block)
    assert match, "deadman launchd agent has no StartInterval"
    assert int(match.group(1)) == health_check.DEADMAN_CHECK_INTERVAL_SECONDS


def test_launchd_deadman_agent_does_not_override_check_interval_inconsistently(health_check):
    """The macOS agent takes its arguments from the plist's ProgramArguments, not the
    systemd unit; an explicit --check-interval there must match the timer too."""
    installer = (_DEPLOY / "scripts" / "install-bot-errors-launchd.sh").read_text(encoding="utf-8")
    block = _deadman_plist_block(installer)
    assert "<string>--deadman</string>" in block
    match = re.search(r"<string>--check-interval</string>\s*<string>(\d+)</string>", block)
    if match:
        assert int(match.group(1)) == health_check.DEADMAN_CHECK_INTERVAL_SECONDS


def test_systemd_duration_parser_covers_the_plausible_spellings():
    assert [_systemd_seconds(v) for v in ("5m", "300s", "5min", "1h", "2m30s", "300", "5minutes", "1hr", "1h30min")] == [
        300, 300, 300, 3600, 150, 300, 300, 3600, 5400
    ]
    with pytest.raises(pytest.fail.Exception):
        _systemd_seconds("5fortnights")
    with pytest.raises(pytest.fail.Exception):
        _systemd_seconds("5M")  # uppercase unit: systemd would refuse to load the timer


def test_shipped_deadman_service_does_not_override_check_interval_inconsistently(health_check):
    """If the unit ever passes --check-interval explicitly it must still match the timer."""
    service = (_DEPLOY / "bot-errors-deadman.service").read_text(encoding="utf-8")
    exec_line = next(line for line in service.splitlines() if line.startswith("ExecStart="))
    assert "--deadman" in exec_line
    match = re.search(r"--check-interval[= ](\d+)", exec_line)
    if match:
        assert int(match.group(1)) == health_check.DEADMAN_CHECK_INTERVAL_SECONDS


def test_cli_default_check_interval_is_the_shared_constant(health_check):
    """The argparse default and the deadman() signature default must be the constant the
    coupling tests above pin, not a second literal that can drift on its own."""
    import inspect

    assert inspect.signature(health_check.deadman).parameters["check_interval"].default == health_check.DEADMAN_CHECK_INTERVAL_SECONDS
    source = inspect.getsource(health_check.main) if hasattr(health_check, "main") else _SCRIPT.read_text(encoding="utf-8")
    assert re.search(r'"--check-interval",\s*type=int,\s*default=DEADMAN_CHECK_INTERVAL_SECONDS', source), "argparse default is not the shared constant"


def test_deadman_observation_gap_line_reads_the_durable_record(health_check):
    """The daily check renders the last observed gap while it is younger than the
    window, omits it afterwards, and never hides a malformed stamp."""
    at = health_check.epoch_to_iso(100_000)
    record = {"lastCheckGapSeconds": 700, "lastCheckGapAt": at}
    assert health_check.deadman_observation_gap_line(record, 100_600) == f"deadman_last_observation_gap: seconds=700 at={at} age_seconds=600"
    assert health_check.deadman_observation_gap_line(record, 100_000 + 86_400) is not None
    assert health_check.deadman_observation_gap_line(record, 100_000 + 86_401) is None
    # A stamp from the future (a forward clock step) is rendered, not hidden: the
    # record is real and the negative age is the honest description of it.
    assert health_check.deadman_observation_gap_line(record, 99_000) == f"deadman_last_observation_gap: seconds=700 at={at} age_seconds=-1000"
    assert health_check.deadman_observation_gap_line({}, 100_600) is None
    assert health_check.deadman_observation_gap_line({"lastCheckGapSeconds": 700}, 100_600) is None
    assert health_check.deadman_observation_gap_line({"lastCheckGapSeconds": True, "lastCheckGapAt": at}, 100_600) is None
    assert health_check.deadman_observation_gap_line({"lastCheckGapSeconds": 0, "lastCheckGapAt": at}, 100_600) is None
    malformed = health_check.deadman_observation_gap_line({"lastCheckGapSeconds": 700, "lastCheckGapAt": "not-a-time"}, 100_600)
    assert malformed is not None and "age_seconds=unparseable" in malformed


def test_daily_renders_the_last_observation_gap_from_the_deadman_record(env, capsys, monkeypatch):
    """End to end: a gap the deadman persisted shows up on the next daily run."""
    env.svc["status"] = "active"
    env.svc["ages"] = (10, 10)
    env.cycle_completed(5)
    assert env.run() == 0
    env.advance(700)
    env.cycle_completed(5)
    assert env.run() == 0
    capsys.readouterr()
    lines = env.mod.deadman_observation_gap_inventory()
    assert lines == [f"deadman_last_observation_gap: seconds=700 at={env.mod.epoch_to_iso(env.clock['now'])} age_seconds=0"]
    env.advance(86_401)
    assert env.mod.deadman_observation_gap_inventory() == []
    import inspect

    assert "deadman_observation_gap_inventory()" in inspect.getsource(env.mod.daily), "daily() must render the record"


def test_systemd_seconds_rejects_partially_parsed_values():
    """The cadence pin must read the whole value: leading junk or a separator
    systemd would reject was silently skipped by the number-unit scan."""
    assert _systemd_seconds("5m") == 300 and _systemd_seconds("2m30s") == 150 and _systemd_seconds("5m 10m") == 900
    for bad in ("abc5m", "5m;10m", "5m,10m", "5 m x 10m"):
        with pytest.raises(pytest.fail.Exception):
            _systemd_seconds(bad)


def test_deadman_reports_a_restart_loop_across_repeated_reboots(env):
    """Bench finding: every boot-identity change re-seeds the streak. What that
    means in practice: within each boot the loop is reported once the streak
    outgrows max_state_age, and only a host that reboots faster than
    max_state_age (180s at the shipped flags) stays silent. Boot A -> B -> C at
    a 300s cadence reports in every boot; at a 100s cadence it does not, which
    is the documented residual (a host rebooting every 100s cannot run a
    5-minute timer either)."""
    env.svc["status"] = "active"
    env.svc["ages"] = (2, 2)
    for boot in ("boot-A", "boot-B", "boot-C"):
        env.boot["id"] = boot
        env.state_written(120, {"time": env.mod.epoch_to_iso(100_000)})
        assert env.run() == 0, boot  # first check after the (re)boot: a fresh restart is graced
        env.advance(300)
        env.state_written(120, {"time": env.mod.epoch_to_iso(100_000)})
        assert env.run() == 2, boot  # second check: the streak within this boot outgrew max_state_age
        assert "cycle_incomplete" in env.members()
        env.advance(300)
    for boot in ("boot-D", "boot-E", "boot-F"):
        env.boot["id"] = boot
        env.state_written(120, {"time": env.mod.epoch_to_iso(100_000)})
        assert env.run() == 0, boot
        env.advance(100)  # faster than max_state_age: the residual
    assert env.run() == 0

