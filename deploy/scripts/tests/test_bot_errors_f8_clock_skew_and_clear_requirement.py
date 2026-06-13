"""Tests for F8: clearRequirement skew tolerance + advisory enforcement.

TDD — written against the designed contract:
- Clear with createdAt 30s before incident open is ACCEPTED (within 60s CLOCK_SKEW_TOLERANCE).
- Clear with createdAt 90s before incident open is still REJECTED (outside tolerance).
- clearRequirement mismatch appends a note to close notification evidence.
- Any clear still closes the incident regardless of clearRequirement match.
"""
from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load_module(extra_env: dict[str, str] | None = None):
    env_backup = {}
    if extra_env:
        for k, v in extra_env.items():
            env_backup[k] = os.environ.get(k)
            os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location("bot_errors_dispatcher", _SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        if extra_env:
            for k, orig in env_backup.items():
                if orig is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig


_mod = _load_module()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_incident_state(
    incident_key: str,
    event_created_at_epoch: int,
    clear_requirement: str | None = None,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "status": "open",
        "eventCreatedAtEpoch": event_created_at_epoch,
        "openedAt": event_created_at_epoch,
        "openedIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(event_created_at_epoch)),
        "suppressedCount": 0,
    }
    if clear_requirement:
        record["clearRequirement"] = clear_requirement
    return {
        "version": 1,
        "openIncidents": {incident_key: record},
        "lastSentAt": {},
    }


def _make_clear_event(
    machine: str,
    instance: str,
    source: str,
    created_at_epoch: int,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "id": f"clear-{created_at_epoch}",
        "eventType": "clear",
        "severity": "info",
        "source": source,
        "instance": instance,
        "machine": machine,
        "summary": f"Recovery from {source}",
        "evidence": "system recovered",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(created_at_epoch)),
    }


# ---------------------------------------------------------------------------
# F8-a: clock skew tolerance — 60s window
# ---------------------------------------------------------------------------

class TestClockSkewTolerance:
    def test_clear_30s_before_open_is_accepted(self):
        """Clear with createdAt 30s before incident open is accepted (within 60s tolerance)."""
        mod = _load_module()
        now = int(time.time())
        incident_open_epoch = now  # incident opened at "now"
        clear_epoch = now - 30    # clear arrived 30s before open (within 60s)

        incident_key = "nucles|ana-bot|socket_down"
        incident_state = _make_incident_state(incident_key, incident_open_epoch)

        clear_event = _make_clear_event("nucles", "ana-bot", "socket_down", clear_epoch)

        reason = mod.should_suppress_send(clear_event, incident_state)
        assert reason is None, (
            f"Clear 30s before open should be accepted with 60s tolerance, "
            f"but got suppression: {reason!r}"
        )

    def test_clear_90s_before_open_is_rejected(self):
        """Clear with createdAt 90s before incident open is still rejected (outside tolerance)."""
        mod = _load_module()
        now = int(time.time())
        incident_open_epoch = now
        clear_epoch = now - 90  # 90s before open, outside 60s tolerance

        incident_key = "nucles|ana-bot|socket_down"
        incident_state = _make_incident_state(incident_key, incident_open_epoch)

        clear_event = _make_clear_event("nucles", "ana-bot", "socket_down", clear_epoch)

        reason = mod.should_suppress_send(clear_event, incident_state)
        assert reason is not None, (
            "Clear 90s before open should be rejected (outside 60s tolerance)"
        )
        assert "predates" in reason or "stale" in reason or "suppress" in reason.lower(), (
            f"Suppression reason should mention predates/stale, got: {reason!r}"
        )

    def test_clear_at_exact_tolerance_boundary_is_accepted(self):
        """Clear exactly at the tolerance boundary (60s before) should be accepted."""
        mod = _load_module()
        now = int(time.time())
        incident_open_epoch = now
        clear_epoch = now - 60  # Exactly at the boundary

        incident_key = "nucles|ana-bot|socket_down"
        incident_state = _make_incident_state(incident_key, incident_open_epoch)

        clear_event = _make_clear_event("nucles", "ana-bot", "socket_down", clear_epoch)

        reason = mod.should_suppress_send(clear_event, incident_state)
        # At exactly tolerance, should be accepted (created >= opened - tolerance)
        assert reason is None, (
            f"Clear exactly at tolerance boundary should be accepted, got: {reason!r}"
        )

    def test_clock_skew_constant_is_60(self):
        """CLOCK_SKEW_TOLERANCE_SECONDS constant should be 60."""
        mod = _load_module()
        assert hasattr(mod, "CLOCK_SKEW_TOLERANCE_SECONDS"), (
            "Module must define CLOCK_SKEW_TOLERANCE_SECONDS"
        )
        assert mod.CLOCK_SKEW_TOLERANCE_SECONDS == 60, (
            f"CLOCK_SKEW_TOLERANCE_SECONDS should be 60, got {mod.CLOCK_SKEW_TOLERANCE_SECONDS}"
        )

    def test_clear_after_open_is_always_accepted(self):
        """Clear that arrives after incident open is always accepted regardless of tolerance."""
        mod = _load_module()
        now = int(time.time())
        incident_open_epoch = now - 300  # incident opened 5 min ago
        clear_epoch = now               # clear arrives now (after open)

        incident_key = "nucles|ana-bot|socket_down"
        incident_state = _make_incident_state(incident_key, incident_open_epoch)

        clear_event = _make_clear_event("nucles", "ana-bot", "socket_down", clear_epoch)

        reason = mod.should_suppress_send(clear_event, incident_state)
        assert reason is None, (
            f"Clear after open should always be accepted, got: {reason!r}"
        )


# ---------------------------------------------------------------------------
# F8-b: clearRequirement advisory note in close notification
# ---------------------------------------------------------------------------

class TestClearRequirementAdvisory:
    def test_mismatch_note_appears_in_evidence_when_source_does_not_satisfy(self):
        """When clear source doesn't match clearRequirement, clearRequirement_mismatch note appended."""
        mod = _load_module()
        now = int(time.time())
        incident_open_epoch = now - 300

        incident_key = "nucles|ana-bot|daily-health:whatsapp_device_bond_lost"
        # clearRequirement says "physical_confirmation_required"
        clear_requirement = "physical_confirmation_required"
        incident_state = _make_incident_state(incident_key, incident_open_epoch, clear_requirement)

        # Clear comes from "socket_up" which doesn't match the requirement
        clear_event = {
            "schemaVersion": 1,
            "id": "clear-mismatch",
            "eventType": "clear",
            "severity": "info",
            "source": "daily-health",
            "alertSource": "whatsapp_device_bond_lost",
            "instance": "ana-bot",
            "machine": "nucles",
            "summary": "Recovery",
            "evidence": "system ok",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        }

        mod.append_clear_context(clear_event, incident_state)
        evidence = clear_event.get("evidence", "")
        assert "clearRequirement_mismatch" in evidence, (
            f"clearRequirement_mismatch note must appear in evidence when source doesn't match; "
            f"got: {evidence!r}"
        )

    def test_mismatch_note_absent_when_source_satisfies_requirement(self):
        """When clear source satisfies clearRequirement, no mismatch note added."""
        mod = _load_module()
        now = int(time.time())
        incident_open_epoch = now - 300

        incident_key = "nucles|ana-bot|daily-health:whatsapp_device_bond_lost"
        # clearRequirement mentions "physical_confirmation" and source will satisfy it
        clear_requirement = "manual_physical_confirmation"
        incident_state = _make_incident_state(incident_key, incident_open_epoch, clear_requirement)

        # Clear source explicitly contains the required keyword
        clear_event = {
            "schemaVersion": 1,
            "id": "clear-match",
            "eventType": "clear",
            "severity": "info",
            "source": "manual_physical_confirmation",
            "instance": "ana-bot",
            "machine": "nucles",
            "summary": "Manual relink complete",
            "evidence": "physical action taken",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        }

        mod.append_clear_context(clear_event, incident_state)
        evidence = clear_event.get("evidence", "")
        assert "clearRequirement_mismatch" not in evidence, (
            f"clearRequirement_mismatch must NOT appear when source satisfies requirement; "
            f"got: {evidence!r}"
        )

    def test_clear_still_closes_incident_despite_mismatch(self, tmp_path):
        """A clear with clearRequirement mismatch still closes the incident."""
        state_dir = tmp_path / "state"
        mod = _load_module({"BOT_ERRORS_STATE_DIR": str(state_dir)})
        paths = mod.setup_dirs()

        now = int(time.time())
        incident_open_epoch = now - 300
        incident_key = "nucles|ana-bot|socket_down"
        clear_requirement = "physical_confirmation_required"
        incident_state = _make_incident_state(incident_key, incident_open_epoch, clear_requirement)

        clear_event: dict[str, Any] = {
            "schemaVersion": 1,
            "id": "clear-close-test",
            "eventType": "clear",
            "severity": "info",
            "source": "socket_down",
            "instance": "ana-bot",
            "machine": "nucles",
            "summary": "Socket recovered",
            "evidence": "connection restored",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        }

        # Check that incident is cleared (mark_incident_sent removes it from openIncidents)
        mod.mark_incident_sent(clear_event, incident_state)
        open_incidents = incident_state.get("openIncidents", {})
        assert incident_key not in open_incidents, (
            f"Incident should be closed even if clearRequirement mismatch; "
            f"openIncidents still has key: {incident_key}"
        )

    def test_no_clear_requirement_produces_no_mismatch_note(self):
        """No clearRequirement stored → no mismatch note ever added."""
        mod = _load_module()
        now = int(time.time())
        incident_open_epoch = now - 300

        incident_key = "nucles|ana-bot|socket_down"
        incident_state = _make_incident_state(incident_key, incident_open_epoch, clear_requirement=None)

        clear_event = {
            "schemaVersion": 1,
            "id": "clear-no-req",
            "eventType": "clear",
            "severity": "info",
            "source": "socket_down",
            "instance": "ana-bot",
            "machine": "nucles",
            "summary": "Recovery",
            "evidence": "system ok",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        }

        mod.append_clear_context(clear_event, incident_state)
        evidence = clear_event.get("evidence", "")
        assert "clearRequirement_mismatch" not in evidence, (
            f"No clearRequirement → no mismatch note; got: {evidence!r}"
        )
