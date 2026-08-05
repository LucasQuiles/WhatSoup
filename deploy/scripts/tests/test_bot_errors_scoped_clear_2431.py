"""Discriminating tests for #2431: incident-clear constrained to evaluated instance set.

fails-before:  an incident for a non-evaluated local_health instance is cleared
               by reconcile's sweep (set(open_incidents) - set(problems)).
passes-after:  the same incident survives reconcile because evaluated_instances
               excludes that instance name, and the clear path skips it.
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-heartbeat-watchdog.py"


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_watchdog_scoped_clear_2431",
        _SCRIPT,
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# Evaluated-instance scope guard
# ---------------------------------------------------------------------------


class TestIncidentNonEvaluatedInstanceSurvivesSweep:
    """An incident for a local_health instance NOT in the evaluated set must
    survive reconcile's sweep. Without the #2431 fix, the clear path iterates
    set(open_incidents) - set(problems) and clears incidents regardless of
    whether the instance was evaluated. With the fix, evaluated_instances
    constrains the clear path."""

    def _make_state_with_incident(self, mod, key: str) -> dict:
        return {
            "version": 2,
            "open": {
                key: {
                    "firstSeenAt": "2026-08-04T10:00:00Z",
                    "lastSeenAt": "2026-08-04T10:05:00Z",
                    "lastNotifiedAt": "2026-08-04T10:00:00Z",
                    "lastEvidence": "local health probe failed: instance=removed-instance",
                    "suppressed": 3,
                    "ageSeconds": 1200,
                },
            },
            "pendingStale": {},
            "recentlyRecovered": {},
            "logs": {},
        }

    def test_incident_for_nonevaluated_instance_is_not_cleared(self, monkeypatch, tmp_path):
        """An incident whose instance was not evaluated survives the sweep.

        The incident key IS in active scope (prefixes includes local_health:)
        and IS in set(open_incidents) - set(problems). Without the #2431
        guard (evaluated_instances check) it would enter the recovery/clear
        path. With the guard it survives because the instance was not evaluated.
        """
        mod = _load_module()
        incident_key = "local_health:removed-instance"
        state = self._make_state_with_incident(mod, incident_key)

        monkeypatch.setattr(mod, "state_root", lambda: tmp_path)
        monkeypatch.setattr(mod, "load_state", lambda: state)
        got_save = []
        monkeypatch.setattr(mod, "save_state", lambda s: got_save.append(s))

        # The removed instance was NOT evaluated. A problem exists for a
        # different instance ("active-instance") so "local_health:" is an
        # active prefix. The removed-instance's incident is in
        # set(open_incidents) - set(problems) AND key_in_active_scope passes
        # — ONLY the #2431 evaluated_instances guard can save it.
        problems: dict[str, str] = {
            "local_health:active-instance": "local health probe failed: instance=active-instance",
        }
        prefixes = ["q_loop", "local_health:"]

        evaluated = {"active-instance", "other-instance"}
        mod.reconcile(problems, prefixes, evaluated)

        saved = got_save[0] if got_save else state
        assert incident_key in saved["open"], (
            f"Incident {incident_key} was cleared despite its instance "
            f"not being in the evaluated set {evaluated}. "
            f"key_in_active_scope={mod.key_in_active_scope(incident_key, prefixes)} "
            f"must be True for the #2431 guard to be the sole protector."
        )
        # Double-check: the incident IS in active scope
        assert mod.key_in_active_scope(incident_key, prefixes), (
            f"Test invariant broken: {incident_key} must be in active scope "
            f"with prefixes={prefixes}"
        )

    def test_incident_for_evaluated_healthy_instance_can_be_cleared(self, monkeypatch, tmp_path):
        """An incident whose instance WAS evaluated and is now healthy enters
        the recovery path as expected — the fix must not block legitimate clears."""
        mod = _load_module()
        incident_key = "local_health:active-instance"
        state = self._make_state_with_incident(mod, incident_key)

        monkeypatch.setattr(mod, "state_root", lambda: tmp_path)
        monkeypatch.setattr(mod, "load_state", lambda: state)
        got_save = []
        monkeypatch.setattr(mod, "save_state", lambda s: got_save.append(s))

        # No local_health problems — instance is healthy (no problem generated)
        problems: dict[str, str] = {"q_loop": "q-loop heartbeat stale: age_seconds=999 max=600 detail=test"}
        prefixes = ["q_loop", "local_health:"]

        # The evaluated_instances includes "active-instance"
        evaluated = {"active-instance", "other-instance"}
        mod.reconcile(problems, prefixes, evaluated)

        # The incident for active-instance should enter recovery (not immediately cleared).
        # It should still be in open with recoveryObservations.
        saved = got_save[0] if got_save else state
        assert incident_key in saved["open"], (
            f"Incident {incident_key} should still be in open_incidents "
            f"(entering recovery, not swept)"
        )
        assert isinstance(saved["open"][incident_key], dict), "incident should be a dict"
        assert "recoveryObservations" in saved["open"][incident_key], (
            "incident should have recoveryObservations in the recovery path"
        )
