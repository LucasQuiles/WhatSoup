"""Tests for F10 (Pattern E — SSOT requested_action).

Design: docs/superpowers/specs/2026-06-16-bot-errors-noise-reduction-design.md
§9 Pattern E + §10 C4.

The live noise symptom: a stale/synthetic digest carried TWO contradictory
requested_action fields — an inner one baked into the evidence string
(`requested_action=Q verify...`) and the top-level one rendered by
format_event (`requested_action: none — informational`). format_event must be
the SOLE source of the requested_action; the baked inner copies are removed.

Precedence (single source of truth), derived from the event's real state:
  1. awaiting-physical / device-bond-lost  -> physical action (human)
  2. physical-intervention candidate        -> physical candidate action
  3. explicit operatorAction (criticalAsset)-> that action
  4. severity == info                        -> "none — informational"
  5. non-info stale context                  -> stale verify action
  6. otherwise                               -> "Q investigate, remediate..."

The reorder fixes a second latent bug: an info-severity event that DOES carry a
real operatorAction (e.g. an awaiting_physical stale digest) previously rendered
"none" because `severity == info` was checked first.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_f10", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_mod = _load_module()
format_event = _mod.format_event
stale_incident_event = _mod.stale_incident_event
append_still_open_context = _mod.append_still_open_context
physical_action_text = _mod.physical_action_text


def _count(substr: str, text: str) -> int:
    return text.count(substr)


# ---------------------------------------------------------------------------
# T1: stale info digest renders exactly one requested_action, no inner copy
# ---------------------------------------------------------------------------

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
    # current far in the future so quiet_seconds >> INCIDENT_STALE_SECONDS
    event = stale_incident_event(
        "host-a|instance-x|runtime-agent-failure:claude-cli:provider_auth_required",
        record,
        2_000_000,
    )
    assert event is not None
    # No inner baked action in the evidence string.
    assert "requested_action=" not in str(event.get("evidence") or "")
    text = format_event(event)
    # Exactly one rendered requested_action line.
    assert _count("requested_action:", text) == 1
    assert "requested_action=" not in text
    assert "none — informational" in text


# ---------------------------------------------------------------------------
# T2: info severity + real operatorAction surfaces the action, not "none"
#     (the awaiting_physical false-negative guard)
# ---------------------------------------------------------------------------

def test_info_event_with_operator_action_surfaces_action():
    event = {
        "eventType": "alert",
        "severity": "info",
        "summary": "Still-open digest, awaiting physical action: bond lost",
        "machine": "host-a",
        "instance": "instance-x",
        "source": "whatsapp_device_bond_lost",
        "evidence": "incident_stale=true\nincident_status=awaiting_physical",
        "criticalAsset": {
            "asset": {"kind": "whatsapp_linked_device", "instance": "instance-x", "owner": "whatsoup"},
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
    # The real action must show, NOT the informational "none".
    assert "none — informational" not in text


# ---------------------------------------------------------------------------
# T3: ordinary critical event keeps the investigate action, single field
# ---------------------------------------------------------------------------

def test_critical_event_keeps_investigate_action():
    event = {
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


# ---------------------------------------------------------------------------
# T4: append_still_open_context no longer bakes requested_action= into evidence
# ---------------------------------------------------------------------------

def test_still_open_context_no_inner_action():
    event = {
        "eventType": "alert",
        "severity": "critical",
        "summary": "persistent incident",
        "machine": "host-a",
        "instance": "instance-z",
        "source": "some_source",
        "evidence": "base_line=1",
    }
    open_record = {"status": "open", "openedAt": 1_000_000, "openedIso": "2026-06-11T00:00:00Z"}
    append_still_open_context(event, open_record, "host-a|instance-z|some_source", 1_100_000, 80, True)
    assert "requested_action=" not in str(event.get("evidence") or "")
    text = format_event(event)
    assert _count("requested_action:", text) == 1
