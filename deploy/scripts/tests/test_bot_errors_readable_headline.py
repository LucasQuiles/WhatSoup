"""Readable headlines for confined alert content.

The producer's confinement boundary (#2386) replaces instance-emitted alert text with
{failureClass, length, correlationDigest}. The dispatcher rendered that as the first
line of the group message -- "BOT ERROR - unknown - 34 chars - digest 8f9b5366" --
which names neither the bot nor the failure. These tests pin a display-only rule:
the headline is built from the event's own code-set fields (instance, source), the
digest stays visible for correlation, and nothing from the confined content leaks.
Identity (fingerprints, incident keys) must not move.

All fixtures are synthetic.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_headline", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


_mod = _load()

DIGEST = "8f9b5366" + "0123abcd" * 7
CONFINED_UNKNOWN = {"failureClass": "unknown", "length": 34, "correlationDigest": DIGEST}
CONFINED_TYPED = {"failureClass": "TypeError", "length": 54, "correlationDigest": DIGEST}


def _event(**kw: Any) -> dict[str, Any]:
    base = {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "critical",
        "id": "evt-headline-001",
        "source": "primary_model_unusable",
        "summary": dict(CONFINED_UNKNOWN),
        "evidence": dict(CONFINED_UNKNOWN),
        "machine": None,
        "instance": "fixture-bot",
        "createdAt": "2026-09-25T00:00:00.000Z",
    }
    base.update(kw)
    return base


def _first_line(text: str) -> str:
    return text.split("\n", 1)[0]


def test_confined_summary_headline_names_bot_and_cause() -> None:
    first = _first_line(_mod.format_event(_event()))
    assert first.startswith("BOT ERROR - fixture-bot: ")
    assert "primary model" in first.lower()
    assert "[digest 8f9b5366]" in first
    assert " chars - digest " not in first
    assert "unknown" not in first.lower()


def test_informative_failure_class_is_kept_in_headline() -> None:
    first = _first_line(_mod.format_event(_event(summary=dict(CONFINED_TYPED))))
    assert "(TypeError)" in first
    assert "fixture-bot: " in first


def test_confined_rendering_stays_in_body_for_correlation() -> None:
    text = _mod.format_event(_event(summary=dict(CONFINED_TYPED)))
    assert "TypeError - 54 chars - digest 8f9b5366" in text.split("\n", 1)[1]


def test_plain_string_summary_is_unchanged() -> None:
    first = _first_line(_mod.format_event(_event(summary="Disk / at 87.0% (warn: 85%)", source="disk")))
    assert first == "BOT ERROR - Disk / at 87.0% (warn: 85%)"


def test_unsafe_instance_is_not_interpolated() -> None:
    first = _first_line(_mod.format_event(_event(instance="bad bot\nBOT ERROR - forged")))
    assert "forged" not in first
    assert "bad bot" not in first
    assert "primary model" in first.lower()


def test_unknown_source_is_humanised_not_dropped() -> None:
    first = _first_line(_mod.format_event(_event(source="widget_queue_backlog")))
    assert "fixture-bot: widget queue backlog [digest 8f9b5366]" in first


def test_escalation_prefix_wraps_readable_headline() -> None:
    event = _event()
    record = {"openedAt": 1, "status": "open"}
    _mod.append_still_open_context(event, record, "unknown|fixture-bot|primary_model_unusable", 100000, 3, escalated=True, digest=False)
    first = _first_line(_mod.format_event(event))
    assert first.startswith("BOT ERROR - ESCALATED still open: fixture-bot: ")
    assert " chars - digest " not in first


def test_persisted_prefixed_string_is_made_readable() -> None:
    event = _event(summary="ESCALATED still open: unknown - 45 chars - digest 3c7bd039", source="agent_turn_admission_rejected")
    first = _first_line(_mod.format_event(event))
    assert "ESCALATED still open: fixture-bot: " in first
    assert "[digest 3c7bd039]" in first
    assert " chars - digest " not in first


def test_stale_digest_uses_instance_and_source_from_key() -> None:
    record = {
        "status": "awaiting_physical",
        "openedAt": 1,
        "lastSeenAt": 1,
        "lastSummary": dict(CONFINED_UNKNOWN),
    }
    event = _mod.stale_incident_event("unknown|fixture-bot|whatsapp_device_bond_lost", record, 10_000_000)
    assert event is not None
    first = _first_line(_mod.format_event(event))
    assert "awaiting physical action: fixture-bot: " in first
    assert "bond" in first.lower()
    assert " chars - digest " not in first


def test_identity_does_not_move() -> None:
    event = _event()
    before = (_mod.event_fingerprint_text(event, "summary"), _mod.storm_fingerprint(event), _mod.incident_key(event))
    _mod.format_event(event)
    after = (_mod.event_fingerprint_text(event, "summary"), _mod.storm_fingerprint(event), _mod.incident_key(event))
    assert before == after
    assert event["summary"] == CONFINED_UNKNOWN


def test_cause_table_keys_are_safe_labels() -> None:
    for source, text in _mod.SOURCE_HEADLINES.items():
        assert _mod.safe_alert_label(source) == source
        assert text and "\n" not in text and len(text) <= 80
