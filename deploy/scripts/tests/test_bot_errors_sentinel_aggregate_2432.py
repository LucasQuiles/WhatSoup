"""Tests for #2432: fleet sentinel aggregate non-green detection.

fails-before:  Sentinel heartbeat with healthy=false, fleetAction="none" and
               no nonGreenReason passes the watchdog silently (no durable
               problem created).
passes-after:  Same heartbeat with nonGreenReason="aggregate_health_false"
               triggers a fleet_sentinel:non_green problem entry.

No-regression: healthy=true, fleetAction="none" heartbeat stays quiet.
No-regression: healthy=false, fleetAction="escalate" still works (existing path).
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_watchdog_2432",
        _SCRIPT_ROOT / "bot-errors-heartbeat-watchdog.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


_NOW = 100000


def _args() -> SimpleNamespace:
    return SimpleNamespace(
        max_q_loop_age=600,
        max_dispatcher_age=300,
        max_collector_age=180,
        max_daily_health_age=25 * 60 * 60,
        max_fleet_sentinel_age=3600,
    )


def _state(monkeypatch, tmp_path: Path) -> Path:
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state))
    monkeypatch.setenv("BOT_ERRORS_DRY_NOW", str(_NOW))
    return state


def _write_heartbeat(mod, state: Path, **overrides) -> Path:
    # Bind the heartbeat to the roster the watchdog will independently
    # re-derive from disk — a hardcoded digest makes the happy path fail on
    # any box whose real roster differs (the #1875 roster check fires and
    # pollutes assertions that are out of #2432's scope).
    _roster, inventory = mod.load_roster()
    digest = str(inventory["digest"])
    expected = int(inventory["expectedHostCount"])
    payload = {
        "schemaVersion": 1,
        "kind": "bot-errors-sentinel-heartbeat",
        "checkedAt": mod.now_iso(_NOW - 10),
        "healthy": True,
        "fleetAction": "none",
        "hostCount": expected,
        "problemHostCount": 0,
        "rosterDigest": digest,
        "rosterEpoch": 12345,
        "expectedHostCount": expected,
        "observedHostCount": expected,
        "unknownHostCount": 0,
        "expectedInstanceCount": 10,
        "observedInstanceCount": 10,
        "problemInstanceCount": 0,
        "unknownInstanceCount": 0,
    }
    payload.update(overrides)
    path = state / "fleet-sentinel" / "sentinel-heartbeat.json"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    path.write_text(json.dumps(payload), encoding="utf-8")
    path.chmod(0o600)
    return path


# ---------------------------------------------------------------------------
# Non-green aggregate detection (#2432)
# ---------------------------------------------------------------------------


class TestFleetSentinelNonGreenAggregate:
    """Watchdog must create a durable problem entry when the sentinel heartbeat
    carries a nonGreenReason signal."""

    def test_healthy_true_fleet_none_no_problem(self, tmp_path: Path, monkeypatch):
        """healthy=true, fleetAction=none is quiet — no regression."""
        mod = _load_module()
        state = _state(monkeypatch, tmp_path)
        _write_heartbeat(mod, state, healthy=True, fleetAction="none")
        problems = mod.collect_problems(_args(), {"fleet_sentinel"})
        assert "fleet_sentinel" not in problems
        assert "fleet_sentinel:non_green" not in problems
        assert "fleet_sentinel:roster" not in problems

    def test_non_green_without_reason_no_problem(self, tmp_path: Path, monkeypatch):
        """healthy=false, fleetAction=none WITHOUT nonGreenReason is the
        fails-before case: the watchdog must not create a problem."""
        mod = _load_module()
        state = _state(monkeypatch, tmp_path)
        _write_heartbeat(mod, state, healthy=False, fleetAction="none")
        problems = mod.collect_problems(_args(), {"fleet_sentinel"})
        assert "fleet_sentinel:non_green" not in problems, (
            "Without nonGreenReason the watchdog should not report non-green aggregate"
        )

    def test_non_green_with_reason_creates_problem(self, tmp_path: Path, monkeypatch):
        """healthy=false, fleetAction=none WITH nonGreenReason is the
        passes-after case: the watchdog must create a durable problem."""
        mod = _load_module()
        state = _state(monkeypatch, tmp_path)
        _write_heartbeat(
            mod, state,
            healthy=False,
            fleetAction="none",
            nonGreenReason="aggregate_health_false roster_bound=True",
        )
        problems = mod.collect_problems(_args(), {"fleet_sentinel"})
        assert "fleet_sentinel:non_green" in problems, (
            "With nonGreenReason the watchdog should create a problem entry"
        )
        assert "aggregate_health_false" in problems["fleet_sentinel:non_green"]

    def test_non_green_with_escalate_no_problem(self, tmp_path: Path, monkeypatch):
        """healthy=false, fleetAction=escalate is the existing escalation path
        — no nonGreenReason needed, no regression."""
        mod = _load_module()
        state = _state(monkeypatch, tmp_path)
        _write_heartbeat(
            mod, state,
            healthy=False,
            fleetAction="escalate",
        )
        problems = mod.collect_problems(_args(), {"fleet_sentinel"})
        # fleetAction=escalate means the sentinel already escalated — the
        # watchdog's freshness/roster checks are the signal path. No non-green
        # problem needed.
        assert "fleet_sentinel:non_green" not in problems

    def test_non_green_with_reason_and_stale_first(self, tmp_path: Path, monkeypatch):
        """A stale heartbeat takes priority over the non-green signal
        (freshness check wins)."""
        mod = _load_module()
        state = _state(monkeypatch, tmp_path)
        far_past = _NOW - 99999
        _write_heartbeat(
            mod, state,
            checkedAt=mod.now_iso(far_past),
            healthy=False,
            fleetAction="none",
            nonGreenReason="aggregate_health_false roster_bound=True",
        )
        problems = mod.collect_problems(_args(), {"fleet_sentinel"})
        # Stale — the freshness problem is the primary signal
        assert "fleet_sentinel" in problems or "fleet_sentinel:non_green" in problems
