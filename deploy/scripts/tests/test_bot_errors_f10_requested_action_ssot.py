"""F10 / Pattern E coverage for requested_action as a single source of truth.

Stale and synthetic digests must not carry an inner ``requested_action=`` line
inside evidence while also rendering the top-level ``requested_action:`` line.
The dispatcher's ``format_event`` path is the only rendered requested-action
source.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_f10", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()
format_event = _mod.format_event
stale_incident_event = _mod.stale_incident_event
append_still_open_context = _mod.append_still_open_context
physical_action_text = _mod.physical_action_text


def _count(substr: str, text: str) -> int:
    return text.count(substr)


def test_stale_info_event_has_single_requested_action():
    record = {
        "status": "stale",
        "openedAt": 1_000_000,
        "openedIso": "2026-06-11T07:30:29Z",
        "lastSeenAt": 1_000_100,
        "lastSeenIso": "2026-06-11T08:44:25Z",
        "lastSummary": "Agent runtime failure: provider_auth_required",
        "suppressedCount": 11,
    }

    event = stale_incident_event(
        "host-a|instance-x|runtime-agent-failure:provider_auth_required",
        record,
        2_000_000,
    )

    assert event is not None
    assert "requested_action=" not in str(event.get("evidence") or "")
    text = format_event(event)
    assert _count("requested_action:", text) == 1
    assert "requested_action=" not in text
    assert "none — informational" in text


def test_info_event_with_operator_action_surfaces_action():
    event = {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "info",
        "summary": "Still-open digest, awaiting physical action: bond lost",
        "machine": "host-a",
        "instance": "instance-x",
        "source": "whatsapp_device_bond_lost",
        "evidence": "incident_stale=true\nincident_status=awaiting_physical",
        "criticalAsset": {
            "asset": {
                "kind": "whatsapp_linked_device",
                "instance": "instance-x",
                "owner": "whatsoup",
            },
            "failure": {
                "code": "DEVICE_BOND_LOST",
                "domain": "account_linkage",
                "recoverability": "manual_relink_required",
                "confidence": "confirmed",
                "operatorAction": physical_action_text(),
                "clearRequirement": "operator re-links the device",
            },
        },
    }

    text = format_event(event)

    assert _count("requested_action:", text) == 1
    assert "none — informational" not in text
    assert physical_action_text() in text


def test_critical_event_keeps_investigate_action():
    event = {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "critical",
        "summary": "whatsoup health degraded",
        "machine": "host-b",
        "instance": "instance-y",
        "source": "health_body_degraded",
        "evidence": "Health body reports status=degraded",
    }

    text = format_event(event)

    assert _count("requested_action:", text) == 1
    assert "Q investigate, remediate" in text


def test_still_open_context_has_no_inner_requested_action():
    event = {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "critical",
        "summary": "persistent incident",
        "machine": "host-a",
        "instance": "instance-z",
        "source": "some_source",
        "evidence": "base_line=1",
    }
    open_record = {
        "status": "open",
        "openedAt": 1_000_000,
        "openedIso": "2026-06-11T00:00:00Z",
    }

    append_still_open_context(event, open_record, "host-a|instance-z|some_source", 1_100_000, 80, True)
    text = format_event(event)

    assert "requested_action=" not in str(event.get("evidence") or "")
    assert _count("requested_action:", text) == 1
