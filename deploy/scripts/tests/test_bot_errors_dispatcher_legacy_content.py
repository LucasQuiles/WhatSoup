"""Dispatcher-side contract tests for legacy confined alert content (#2386).

Red-first. The dispatcher is a pure consumer: it cannot recover the tokens the
producer's confinement boundary destroyed, but it must stop rendering the
confinement envelope as a Python dict repr, stop baking that repr into escalation
prefixes and persisted incident state, keep storm grouping working across hosts,
count the legacy forms it sees, and quarantine a mapping it has no safe way to
render.

All fixtures are synthetic.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

DIGEST = "a1b2c3d4" + "e5f60789" * 7
CANONICAL = "TypeError - 54 chars - digest a1b2c3d4"
REPR_ALPHABETICAL = (
    "{'correlationDigest': '" + DIGEST + "', 'failureClass': 'TypeError', 'length': 54}"
)
REPR_FAILURE_CLASS_FIRST = (
    "{'failureClass': 'TypeError', 'length': 54, 'correlationDigest': '" + DIGEST + "'}"
)


def _load_module(extra_env: dict[str, str] | None = None):
    env_backup: dict[str, str | None] = {}
    if extra_env:
        for k, v in extra_env.items():
            env_backup[k] = os.environ.get(k)
            os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location("bot_errors_dispatcher", _SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
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


def legacy_object() -> dict[str, Any]:
    return {"failureClass": "TypeError", "length": 54, "correlationDigest": DIGEST}


def _make_event(**kwargs: Any) -> dict[str, Any]:
    base = {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "critical",
        "id": "evt-fixture-001",
        "source": "primary_model_unusable",
        "summary": legacy_object(),
        "evidence": legacy_object(),
        "machine": "fixture-host-a",
        "instance": "fixture-bot",
        "createdAt": "2026-09-01T00:00:00.000Z",
    }
    base.update(kwargs)
    return base


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def test_format_event_renders_legacy_object_summary_readably() -> None:
    text = _mod.format_event(_make_event())
    assert CANONICAL in text
    assert "correlationDigest" not in text
    assert "{'" not in text


def test_format_event_renders_baked_repr_summary_readably() -> None:
    event = _make_event(summary=REPR_ALPHABETICAL, evidence=REPR_FAILURE_CLASS_FIRST)
    text = _mod.format_event(event)
    assert "correlationDigest" not in text
    assert "{'" not in text


# ---------------------------------------------------------------------------
# Escalation prefixes must never bake a repr
# ---------------------------------------------------------------------------

def test_escalation_prefix_does_not_bake_repr() -> None:
    event = _make_event()
    record: dict[str, Any] = {"openedAt": 0, "physicalCandidateCount": 0}
    _mod.append_still_open_context(
        event, record, "fixture|key|primary_model_unusable", 1000, 3,
        escalated=True, digest=False,
    )
    assert event["summary"].startswith("ESCALATED still open: ")
    assert "{'" not in event["summary"]
    assert "correlationDigest" not in event["summary"]
    assert "{'" not in event["evidence"]
    assert CANONICAL in event["summary"]


def test_escalation_is_idempotent_against_canonical_summary() -> None:
    """The idempotence guards read the rendered text, so a second pass must not
    stack a second prefix."""
    event = _make_event()
    record: dict[str, Any] = {"openedAt": 0, "physicalCandidateCount": 0}
    key = "fixture|key|primary_model_unusable"
    _mod.append_still_open_context(event, record, key, 1000, 3, escalated=True, digest=False)
    first = event["summary"]
    _mod.append_still_open_context(event, record, key, 1000, 4, escalated=True, digest=False)
    assert event["summary"].count("ESCALATED still open:") == 1
    assert event["summary"] == first


def test_second_append_path_does_not_bake_repr() -> None:
    """append_clear_context is the second site that concatenates onto evidence."""
    event = _make_event(
        eventKind="incident_recovery", eventType="clear", severity="info",
        evidence=legacy_object(),
    )
    # append_clear_context returns early unless an open incident exists.
    incident_state = {
        "openIncidents": {
            _mod.incident_key(event): {
                "openedIso": "2026-09-01T00:00:00Z",
                "eventId": "evt-fixture-000",
                "suppressedCount": 2,
                "lastSeenIso": "2026-09-01T00:00:00Z",
            }
        }
    }
    _mod.append_clear_context(event, incident_state)
    assert isinstance(event["evidence"], str)
    assert "suppressed_duplicates=2" in event["evidence"], "the append path must have run"
    assert CANONICAL in event["evidence"]
    assert "{'" not in event["evidence"]
    assert "correlationDigest" not in event["evidence"]


# ---------------------------------------------------------------------------
# Persisted incident state
# ---------------------------------------------------------------------------

def test_persisted_last_summary_is_canonical_string() -> None:
    event = _make_event()
    incident_state: dict[str, Any] = {}
    _mod.mark_incident_sent(event, incident_state)
    records = incident_state.get("openIncidents") or {}
    assert records, "an alert must open an incident record"
    record = next(iter(records.values()))
    assert record["lastSummary"] == CANONICAL
    assert record["lastEvidence"] == CANONICAL
    assert "{'" not in record["lastSummary"]


def test_persisted_state_read_renders_historical_repr() -> None:
    """Rows already carrying a baked repr must render, including prefixed rows.

    stale_incident_event builds its title from record["lastSummary"], which is
    exactly where the recapture found persisted reprs.
    """
    record = {
        "lastSummary": "ESCALATED still open: " + REPR_ALPHABETICAL,
        "openedAt": 0,
        "lastSeenAt": 0,
        "status": "open",
    }
    rendered = _mod.alert_text(record.get("lastSummary"))
    assert rendered == "ESCALATED still open: " + CANONICAL
    assert "{'" not in rendered


def test_awaiting_physical_evidence_is_stored_readably() -> None:
    """physicalCandidateLastEvidence is one of the persisted fields the recapture
    found carrying the defect."""
    event = _make_event(
        source="whatsapp_device_bond_lost",
        evidence="classification: physical_intervention_required linked-device bond lost",
    )
    record: dict[str, Any] = {}
    _mod.update_awaiting_physical_tracking(event, record, 1000)
    assert "{'" not in record.get("physicalCandidateLastEvidence", "")

    repr_event = _make_event(
        source="whatsapp_device_bond_lost",
        evidence=(
            "classification: physical_intervention_required linked-device bond lost "
            + REPR_ALPHABETICAL
        ),
    )
    repr_record: dict[str, Any] = {}
    _mod.update_awaiting_physical_tracking(repr_event, repr_record, 1000)
    stored = repr_record.get("physicalCandidateLastEvidence", "")
    assert stored, "the physical-candidate path must have stored evidence"
    assert "{'" not in stored
    assert "correlationDigest" not in stored


# ---------------------------------------------------------------------------
# Storm grouping
# ---------------------------------------------------------------------------

def test_storm_fingerprint_collapses_across_hosts_for_legacy_objects() -> None:
    """Two hosts, one confinement envelope: the collapse must fire.

    Against a raw repr the fingerprints differed only by the un-substituted host
    token, so cross-host storm collapse stopped firing entirely.
    """
    first = _make_event(machine="fixture-host-a", instance="fixture-bot")
    second = _make_event(machine="fixture-host-b", instance="fixture-bot")
    assert _mod.storm_fingerprint(first) == _mod.storm_fingerprint(second)
    # Equality alone is satisfied by two identical reprs. The fingerprint must
    # also be the readable canonical form, not a baked repr.
    assert "{'" not in _mod.storm_fingerprint(first)
    assert "correlationdigest" not in _mod.storm_fingerprint(first).lower()


def test_recovery_normalized_summary_matches_across_forms() -> None:
    """Alert/recovery pairing must match whether the producer sent the mapping or
    the baked repr."""
    as_object = _make_event(summary=legacy_object())
    as_repr = _make_event(summary=REPR_FAILURE_CLASS_FIRST)
    assert _mod.recovery_normalized_summary(as_object) == _mod.recovery_normalized_summary(as_repr)
    # And against the OTHER key order, which a matcher pinned to one order misses.
    as_alt_repr = _make_event(summary=REPR_ALPHABETICAL)
    assert _mod.recovery_normalized_summary(as_object) == _mod.recovery_normalized_summary(as_alt_repr)
    assert "{'" not in _mod.recovery_normalized_summary(as_object)


# ---------------------------------------------------------------------------
# Telemetry
# ---------------------------------------------------------------------------

def test_telemetry_counts_object_and_repr_separately() -> None:
    """One event can carry both forms. Each counter increments at most once, and
    the two are never summed."""
    event = _make_event(summary=legacy_object(), evidence=REPR_ALPHABETICAL)
    incident_state: dict[str, Any] = {}
    _mod.record_legacy_alert_content(event, incident_state)
    counters = incident_state["legacyAlertContent"]
    assert counters["queueLegacyObject"] == 1
    assert counters["queueBakedRepr"] == 1
    assert counters["queueUnrenderable"] == 0
    assert counters["lastLegacySource"] == "primary_model_unusable"
    assert counters["lastLegacyIso"]
    assert counters["lastLegacyAt"] > 0


def test_telemetry_counts_one_per_counter_per_event() -> None:
    """Both fields carrying the SAME form still increments that counter once."""
    event = _make_event(summary=legacy_object(), evidence=legacy_object())
    incident_state: dict[str, Any] = {}
    _mod.record_legacy_alert_content(event, incident_state)
    counters = incident_state["legacyAlertContent"]
    assert counters["queueLegacyObject"] == 1
    assert counters["queueBakedRepr"] == 0


def test_telemetry_does_not_count_plain_strings() -> None:
    event = _make_event(summary="plain operator text", evidence="more operator text")
    incident_state: dict[str, Any] = {}
    _mod.record_legacy_alert_content(event, incident_state)
    counters = incident_state.get("legacyAlertContent", {})
    assert counters.get("queueLegacyObject", 0) == 0
    assert counters.get("queueBakedRepr", 0) == 0
    assert counters.get("queueUnrenderable", 0) == 0


def test_telemetry_accumulates_across_events() -> None:
    incident_state: dict[str, Any] = {}
    _mod.record_legacy_alert_content(_make_event(summary=legacy_object(), evidence=""), incident_state)
    _mod.record_legacy_alert_content(_make_event(summary=legacy_object(), evidence=""), incident_state)
    assert incident_state["legacyAlertContent"]["queueLegacyObject"] == 2


# ---------------------------------------------------------------------------
# Quarantine
# ---------------------------------------------------------------------------

def test_unrenderable_mapping_event_is_quarantined(tmp_path: Path) -> None:
    outbox = tmp_path / "outbox"
    quarantine = tmp_path / "quarantine"
    outbox.mkdir(mode=0o700)
    quarantine.mkdir(mode=0o700)
    event = _make_event(summary={"failureClass": "TypeError", "note": "unexpected"})
    path = outbox / "evt-fixture-001.json"
    path.write_text(json.dumps(event), encoding="utf-8")

    assert _mod.load_valid_event_or_quarantine(path, quarantine) is None
    landed = list(quarantine.iterdir())
    assert len(landed) == 1
    assert "unrenderable_alert_content" in landed[0].name


def test_legacy_shaped_mapping_event_is_not_quarantined(tmp_path: Path) -> None:
    outbox = tmp_path / "outbox"
    quarantine = tmp_path / "quarantine"
    outbox.mkdir(mode=0o700)
    quarantine.mkdir(mode=0o700)
    path = outbox / "evt-fixture-002.json"
    path.write_text(json.dumps(_make_event()), encoding="utf-8")

    assert _mod.load_valid_event_or_quarantine(path, quarantine) is not None
    assert list(quarantine.iterdir()) == []


# ---------------------------------------------------------------------------
# Blast-radius guard
# ---------------------------------------------------------------------------

def test_truncate_still_stringifies_raw_error() -> None:
    """truncate is the shared primitive; funnelling it through alert_text would
    replace operator-visible error text with the sentinel."""
    class FixtureError(Exception):
        def __str__(self) -> str:
            return "fixture transport failure"

    assert _mod.truncate(FixtureError(), 200) == "fixture transport failure"
    assert _mod.truncate({"unexpected": "mapping"}, 200) == "{'unexpected': 'mapping'}"
    assert _mod.truncate(None, 200) == ""
    assert "[unrenderable alert content]" not in _mod.truncate({"a": 1}, 200)


def test_manifest_entry_renders_legacy_content() -> None:
    event = _make_event()
    entry = _mod.manifest_entry(Path("/fixture/outbox/evt-fixture-001.json"), event)
    assert "{'" not in entry["summary"]
    assert "{'" not in entry["evidence"]
    assert CANONICAL in entry["summary"]


def test_dead_letter_crumb_summary_does_not_bake_repr() -> None:
    """A dead-letter crumb is a persisted artifact that can carry the legacy form.

    queue_dead_letter_meta_alert reads the oldest crumb's embedded event summary and
    interpolates it into a NEWLY MINTED meta-alert's evidence, so an unrouted read
    here re-creates the defect downstream of every other fix in this change.
    """
    rendered = _mod.alert_text(legacy_object())
    event = _mod.dead_letter_meta_event(
        {"dead_letter": Path("/fixture/state/dead-letter")}, 3, rendered
    )
    assert "{\'" not in event["evidence"]
    assert "correlationDigest" not in event["evidence"]
    assert CANONICAL in event["evidence"]


def test_no_unrouted_alert_content_reads_remain_in_dispatcher() -> None:
    """Coverage assertion over the whole dispatcher, not a sample.

    The invariant this change establishes is that EVERY alert-content read goes
    through the alert_text funnel. Per-site tests can only prove the sites someone
    thought to list; this scans the file so a site nobody listed still fails. It is
    what catches a read like the dead-letter crumb's, which no design document
    enumerated.

    `truncate`/`redact` are deliberately excluded from the funnel and are guarded
    separately by test_truncate_still_stringifies_raw_error.
    """
    source = _SCRIPT.read_text(encoding="utf-8")
    unrouted = []
    for number, line in enumerate(source.splitlines(), 1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        # A raw stringify of an alert-content field, in any container.
        for field in ("summary", "evidence"):
            if f'.get("{field}")' not in line:
                continue
            if "str(" not in line:
                continue
            # Allow the persisted-state field names, which are distinct keys.
            if any(
                other in line
                for other in ("lastSummary", "lastEvidence", "SuppressedClear",
                              "SuppressedSymptom", "physicalCandidate")
            ):
                continue
            unrouted.append(f"{number}: {stripped}")
    assert not unrouted, (
        "alert-content reads must go through event_text/alert_text; unrouted:\n"
        + "\n".join(unrouted)
    )
