"""Tests for orphan-clear suppression.

A clear event with no matching open incident should be suppressed (not sent
to WhatsApp). Previously, ``is_recovery_dedupe_candidate`` bypassed this guard
for ALL clear events, making it dead code.

Scope:
  - Clear with no open incident for the key → suppressed.
  - Clear with a matching open incident → sent (returns None).
  - Daily-health clear that recovers daily-health-fail incidents → sent even
    without an exact key match (prefiltered by daily_health_clear_candidate_keys).
"""
from __future__ import annotations

import importlib.util
import time
from pathlib import Path
from typing import Any

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


def _make_clear_event(
    machine: str,
    instance: str,
    source: str,
    created_at_epoch: int | None = None,
) -> dict[str, Any]:
    if created_at_epoch is None:
        created_at_epoch = int(time.time())
    return {
        "schemaVersion": 1,
        "id": f"clear-{created_at_epoch}",
        "eventType": "clear",
        "severity": "info",
        "source": source,
        "instance": instance,
        "machine": machine,
        "summary": f"alert source cleared: {source}",
        "evidence": f"repair_lane:{instance}",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(created_at_epoch)),
    }


def _empty_incident_state() -> dict[str, Any]:
    return {
        "version": 1,
        "openIncidents": {},
        "lastSentAt": {},
    }


class TestOrphanClearSuppression:
    """Clear events with no open incident must be suppressed."""

    def test_clear_no_open_incident_is_suppressed(self):
        """The core fix: a clear with no matching open incident is suppressed."""
        event = _make_clear_event("host-a", "inst-x", "outbound_quarantined")
        state = _empty_incident_state()

        reason = _mod.should_suppress_send(event, state)
        assert reason is not None
        assert "no open incident" in reason

    def test_clear_with_open_incident_is_sent(self):
        """A clear that matches an open incident passes through (returns None)."""
        now = int(time.time())
        key = "host-a|inst-x|outbound_quarantined"
        state = _empty_incident_state()
        state["openIncidents"][key] = {
            "status": "open",
            "eventCreatedAtEpoch": now - 60,
            "openedAt": now - 60,
            "openedIso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 60)),
            "suppressedCount": 0,
        }

        event = _make_clear_event("host-a", "inst-x", "outbound_quarantined", now)

        reason = _mod.should_suppress_send(event, state)
        assert reason is None

    def test_orphan_clear_health_body_degraded(self):
        """Specifically test the health_body_degraded orphan clear pattern."""
        event = _make_clear_event("host-a", "q", "health_body_degraded")
        state = _empty_incident_state()

        reason = _mod.should_suppress_send(event, state)
        assert reason is not None
        assert "no open incident" in reason

    def test_orphan_clear_instance_logged_out(self):
        """Specifically test the instance_logged_out orphan clear pattern."""
        event = _make_clear_event("host-b", "personal", "instance_logged_out")
        state = _empty_incident_state()

        reason = _mod.should_suppress_send(event, state)
        assert reason is not None
        assert "no open incident" in reason

    def test_orphan_clear_does_not_create_incident(self):
        """Suppressed orphan clears must not mutate incident_state."""
        event = _make_clear_event("host-a", "inst-x", "outbound_quarantined")
        state = _empty_incident_state()

        _mod.should_suppress_send(event, state)
        assert state["openIncidents"] == {}
