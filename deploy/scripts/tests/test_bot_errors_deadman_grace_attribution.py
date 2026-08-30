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
explain: a restart ``service_uptime`` seconds ago accounts for staleness of
about that duration plus the grace window, and no more.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

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
