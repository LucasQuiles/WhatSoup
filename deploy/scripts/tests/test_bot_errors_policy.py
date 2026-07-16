"""Tests for the BOT ERRORS monitoring-policy SSOT (lib/bot_errors_policy.py).

This module is the single place that defines the ``guiSessionExpected`` policy
vocabulary and, per policy value, its disposition across the four monitors
(GUI-session, collector, sentinel, daily-health) — the "define best_effort's
semantics in one place" deliverable for issue #1874.

Only the GUI-session monitor consumes ``guiSessionExpected`` at runtime; the
collector/sentinel/daily-health fields record DECLARED intent (see the module
docstring), so the consistency tests here are tied to reality where a runtime
signal exists (GUI exclusion, manifest ``collectorRemote``) and assert the
declared value otherwise.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import bot_errors_policy as policy  # noqa: E402

_MANIFEST = _TESTS_DIR.parents[1] / "bot-errors-expected-fleet.json"


def _load_manifest() -> dict:
    return json.loads(_MANIFEST.read_text(encoding="utf-8"))


# --- vocabulary -------------------------------------------------------------


def test_known_policies_are_the_four_canonical_values():
    assert policy.KNOWN_GUI_SESSION_POLICIES == frozenset({
        "always_aqua", "headless_ok", "not_applicable", "best_effort",
    })


def test_every_known_policy_has_a_disposition():
    assert set(policy.DISPOSITIONS) == set(policy.KNOWN_GUI_SESSION_POLICIES)


def test_excluding_policies_match_gui_exclude_dispositions():
    gui_excluded = {
        p for p, d in policy.DISPOSITIONS.items() if d.gui_session == policy.GUI_EXCLUDE
    }
    assert set(policy._EXCLUDING_POLICIES) == gui_excluded


# --- best_effort disposition (the #1874 policy) -----------------------------


def test_best_effort_disposition_excludes_gui_and_collector():
    d = policy.disposition_for("best_effort")
    assert d is not None
    assert d.gui_session == policy.GUI_EXCLUDE
    assert d.collector == policy.COLLECTOR_EXCLUDE
    assert d.sentinel == policy.SENTINEL_EXPECTED_INTERMITTENT
    assert d.daily_health == policy.DAILY_HEALTH_OPTIONAL


def test_always_aqua_disposition_is_fully_monitored():
    d = policy.disposition_for("always_aqua")
    assert d.gui_session == policy.GUI_MONITOR
    assert d.collector == policy.COLLECTOR_REMOTE_PROBE
    assert d.daily_health == policy.DAILY_HEALTH_REQUIRED


def test_headless_ok_is_gui_excluded_but_collector_active():
    # A relay host is legitimately GUI-excluded yet an active collector remote —
    # proves the disposition is per-axis, not a blanket exclude (guards against a
    # future "excluding policy => collector excluded" over-generalization).
    d = policy.disposition_for("headless_ok")
    assert d.gui_session == policy.GUI_EXCLUDE
    assert d.collector == policy.COLLECTOR_REMOTE_PROBE


# --- predicates -------------------------------------------------------------


def test_gui_session_excluded_predicate():
    assert policy.gui_session_excluded("best_effort") is True
    assert policy.gui_session_excluded("headless_ok") is True
    assert policy.gui_session_excluded("not_applicable") is True
    assert policy.gui_session_excluded("always_aqua") is False
    assert policy.gui_session_excluded("bogus") is False


def test_is_known():
    assert policy.is_known("best_effort") is True
    assert policy.is_known("typo") is False
    assert policy.is_known(None) is False


def test_disposition_for_unknown_returns_none():
    assert policy.disposition_for("typo") is None


# --- cross-monitor consistency (best_effort <-> collectorRemote) ------------


def test_consistency_flags_best_effort_with_collector_remote_true():
    fleet = {"hosts": [
        {"host": "napbox", "guiSessionExpected": "best_effort",
         "collectorRemote": True, "instances": []},
    ]}
    offenders = policy.best_effort_collector_consistency_errors(fleet)
    assert [o["host"] for o in offenders] == ["napbox"]


def test_consistency_ok_when_best_effort_is_collector_excluded():
    fleet = {"hosts": [
        {"host": "napbox", "guiSessionExpected": "best_effort",
         "collectorRemote": False, "instances": []},
    ]}
    assert policy.best_effort_collector_consistency_errors(fleet) == []


def test_tracked_manifest_has_no_policy_consistency_errors():
    # The checked-in SSOT must keep best_effort hosts collector-excluded so the
    # collector and GUI-session monitors agree (#1874 parity, at the manifest level).
    assert policy.best_effort_collector_consistency_errors(_load_manifest()) == []


def test_tracked_manifest_uses_only_known_policies():
    manifest = _load_manifest()
    declared: set[str] = set()
    for host_entry in manifest.get("hosts", []):
        if not isinstance(host_entry, dict):
            continue
        value = host_entry.get("guiSessionExpected")
        if isinstance(value, str):
            declared.add(value)
        for inst in host_entry.get("instances") or []:
            if isinstance(inst, dict) and isinstance(inst.get("guiSessionExpected"), str):
                declared.add(inst["guiSessionExpected"])
    assert declared, "manifest should declare policies"
    assert declared <= policy.KNOWN_GUI_SESSION_POLICIES
