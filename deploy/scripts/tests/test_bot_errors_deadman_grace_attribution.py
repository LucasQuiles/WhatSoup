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

"Continuously" needs a liveness record, and the record must not forgive the
deadman's own absence. The streak persists the epoch of the last graced check
(``graceStreakSeenAt``) and the host boot identity that observed it
(``graceStreakBootId``, clock-independent: Linux boot_id, macOS kern.boottime).
Grace observed on the same boot is continuous whatever the gap between checks:
a dispatcher that is still in its restart window after the deadman was starved
for an hour had that hour to complete a cycle and did not. Only a different
boot (an actual reboot) re-seeds, because the previous grace belonged to a
process the boot itself ended. Forgiving any gap re-seeded on every check when
the deadman ran less often than the limit, and a real restart loop under a
starved timer stayed silent forever.

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


# --- streak continuity: bound to the host boot, not to the gap between checks --


def test_grace_streak_continues_across_a_long_gap_on_the_same_boot(health_check):
    """The deadman was starved for 8h on the same boot: grace at both ends with the
    dispatcher still in its restart window is a loop, and the gap is reported."""
    now = 200_000
    state = {"graceStreakSince": now - 8 * 3600, "graceStreakSeenAt": now - 8 * 3600, "graceStreakBootId": "boot-A"}
    assert health_check._note_grace_streak(state, True, now, "boot-A") == (8 * 3600, True, 8 * 3600)
    assert state["graceStreakSeenAt"] == now and state["graceStreakSince"] == now - 8 * 3600


def test_grace_streak_reseeds_after_a_reboot(health_check):
    """A different boot identity: the process the previous grace belonged to is gone."""
    now = 200_000
    state = {"graceStreakSince": now - 8 * 3600, "graceStreakSeenAt": now - 8 * 3600, "graceStreakBootId": "boot-A"}
    assert health_check._note_grace_streak(state, True, now, "boot-B") == (0, True, None)
    assert state["graceStreakSince"] == now and state["graceStreakSeenAt"] == now and state["graceStreakBootId"] == "boot-B"


def test_grace_streak_continues_at_the_timer_cadence(health_check):
    now = 200_000
    state = {"graceStreakSince": now - 900, "graceStreakSeenAt": now - 300, "graceStreakBootId": "boot-A"}
    assert health_check._note_grace_streak(state, True, now, "boot-A") == (900, True, 300)


def test_grace_streak_with_unknown_host_boot_continues(health_check):
    """Boot identity unavailable: continuity cannot be disproved, and a missed
    alarm is the worse error, so the streak continues."""
    now = 200_000
    state = {"graceStreakSince": now - 900, "graceStreakSeenAt": now - 300, "graceStreakBootId": "boot-A"}
    assert health_check._note_grace_streak(state, True, now, None) == (900, True, 300)


def test_grace_streak_without_a_liveness_record_is_reseeded(health_check):
    now = 200_000
    state = {"graceStreakSince": now - 900}
    assert health_check._note_grace_streak(state, True, now, "boot-A") == (0, True, None)
    assert state["graceStreakSince"] == now and state["graceStreakSeenAt"] == now and state["graceStreakBootId"] == "boot-A"


def test_grace_streak_without_a_boot_record_is_reseeded(health_check):
    now = 200_000
    state = {"graceStreakSince": now - 900, "graceStreakSeenAt": now - 300}
    assert health_check._note_grace_streak(state, True, now, "boot-A") == (0, True, None)


@pytest.mark.parametrize("bad_seen", [True, 0, -5, 200_001])
def test_grace_streak_rejects_a_corrupt_seen_epoch(health_check, bad_seen):
    now = 200_000
    state = {"graceStreakSince": now - 900, "graceStreakSeenAt": bad_seen, "graceStreakBootId": "boot-A"}
    assert health_check._note_grace_streak(state, True, now, "boot-A") == (0, True, None)
    assert state["graceStreakSeenAt"] == now and type(state["graceStreakSeenAt"]) is int


def test_grace_streak_lapse_clears_every_field(health_check):
    state = {"graceStreakSince": 100, "graceStreakSeenAt": 400, "graceStreakBootId": "boot-A"}
    assert health_check._note_grace_streak(state, False, 500, "boot-A") == (0, True, None)
    assert not any(k.startswith("graceStreak") for k in state)


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

    def advance(seconds: int) -> None:
        clock["now"] += seconds

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

    return SimpleNamespace(mod=mod, svc=svc, boot=boot, cycle_completed=cycle_completed, state_written=state_written, state_removed=state_removed, advance=advance, run=run, members=members, deadman_state=deadman_state)


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
    not manufacture an enormous streak; it resets and is persisted as an int."""
    for bad in (True, 0, -5):
        (tmp_path / "deadman-state.json").write_text(json.dumps({"schemaVersion": 1, "incidents": {}, "graceStreakSince": bad, "graceStreakSeenAt": 100_000, "graceStreakBootId": "boot-A"}))
        (tmp_path / "deadman-state.json").chmod(0o600)  # durable_json refuses group/other-readable targets
        env.svc["status"] = "active"
        env.svc["ages"] = (10, 10)
        assert env.run() == 0, bad
        assert "state_missing" not in env.members()
        saved = json.loads((tmp_path / "deadman-state.json").read_text())
        assert saved["graceStreakSince"] == 100_000 and type(saved["graceStreakSince"]) is int


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
    past the old limit) re-seeded the streak on every check, so a dispatcher
    restarting forever on the same boot with an incomplete state was never
    reported. Same boot, grace at both ends, cycle still incomplete: report."""
    env.svc["status"] = "active"
    env.svc["ages"] = (2, 2)
    env.state_written(120, {"time": env.mod.epoch_to_iso(100_000)})
    assert env.run(max_state_age=30, restart_grace=30) == 0
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
    assert env.run() == 2
    assert env.members() == {"state_missing"}


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
    env.advance(300)
    env.cycle_completed(5)
    assert env.run() == 0
    assert "lastCheckGapSeconds" not in env.deadman_state()  # cleared once the cadence is back


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
# value, so the coupling is implicit; this pins it so lengthening the timer
# without passing the flag (which would re-seed the streak on every check and
# silence state_missing/cycle_incomplete for good) fails the suite.
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
