"""Versioned BOT ERRORS queue-event envelope validation and normalization."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

try:  # imported as ``lib.bot_errors_envelope`` by every deploy script
    from lib.bot_errors_redaction import legacy_confined_to_text
except ImportError:  # loaded by file path, without the package context
    from bot_errors_redaction import legacy_confined_to_text


SCHEMA_VERSION = 2
LEGACY_SCHEMA_VERSION = 1
EVENT_KINDS = ("incident_alert", "incident_recovery", "observation")
EVENT_TYPES = ("alert", "clear", "observation")
LEGACY_EVENT_TYPES = ("alert", "clear")
SEVERITIES = ("critical", "error", "warning", "info")
INCIDENT_SEVERITIES = frozenset(("critical", "error", "warning"))


class EnvelopeError(ValueError):
    """A bounded reason why a queue event is not safe to consume."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class EventClassification:
    """The one semantic interpretation available to queue consumers."""

    kind: str
    event_type: str
    severity: str
    schema_version: int
    legacy: bool


def _required_string(event: Mapping[str, Any], field: str, missing_code: str) -> str:
    value = event.get(field)
    if not isinstance(value, str) or not value.strip():
        raise EnvelopeError(missing_code)
    return value.strip().lower()


def _schema_version(event: Mapping[str, Any]) -> int:
    value = event.get("schemaVersion")
    if value is None:
        raise EnvelopeError("missing_schema_version")
    if isinstance(value, bool) or not isinstance(value, int):
        raise EnvelopeError("unsupported_schema_version")
    if value not in {LEGACY_SCHEMA_VERSION, SCHEMA_VERSION}:
        raise EnvelopeError("unsupported_schema_version")
    return value


def _classify_legacy_pair(event_type: str, severity: str) -> tuple[str, str, str]:
    if event_type not in LEGACY_EVENT_TYPES:
        raise EnvelopeError("unknown_event_type")
    if severity not in SEVERITIES:
        raise EnvelopeError("unknown_severity")
    if event_type == "alert" and severity in INCIDENT_SEVERITIES:
        return "incident_alert", "alert", severity
    if event_type == "alert" and severity == "info":
        return "observation", "observation", "info"
    if event_type == "clear" and severity == "info":
        return "incident_recovery", "clear", "info"
    raise EnvelopeError("invalid_kind_severity")


def _classify_v2_pair(event_type: str, severity: str) -> tuple[str, str, str]:
    if event_type not in EVENT_TYPES:
        raise EnvelopeError("unknown_event_type")
    if severity not in SEVERITIES:
        raise EnvelopeError("unknown_severity")
    if event_type == "alert" and severity in INCIDENT_SEVERITIES:
        return "incident_alert", "alert", severity
    if event_type == "clear" and severity == "info":
        return "incident_recovery", "clear", "info"
    if event_type == "observation" and severity == "info":
        return "observation", "observation", "info"
    raise EnvelopeError("invalid_kind_severity")


def _classify_v2(event: Mapping[str, Any]) -> EventClassification:
    kind = _required_string(event, "eventKind", "missing_event_kind")
    if kind not in EVENT_KINDS:
        raise EnvelopeError("unknown_event_kind")
    event_type = _required_string(event, "eventType", "missing_event_type")
    severity = _required_string(event, "severity", "missing_severity")
    expected_kind, canonical_event_type, canonical_severity = _classify_v2_pair(event_type, severity)
    if kind != expected_kind:
        raise EnvelopeError("invalid_kind_severity")
    return EventClassification(kind, canonical_event_type, canonical_severity, SCHEMA_VERSION, False)


ALERT_CONTENT_FIELDS = ("summary", "evidence")


def _require_renderable_alert_content(event: Mapping[str, Any]) -> None:
    """Reject a mapping the consumer has no safe way to render (#2386).

    `summary` and `evidence` are operator-visible text. The one non-string value
    a consumer can render is the legacy confinement envelope, whose exact
    three-key shape carries a failure class, a length, and a digest. Any other
    mapping would have to be stringified to be displayed, which is precisely how
    Python dict reprs were baked into WhatsApp messages and persisted incident
    state. Quarantine it instead: `load_valid_event_or_quarantine` already routes
    `EnvelopeError` to the quarantine directory, so no new plumbing is needed.

    A string is always accepted here -- rendering it is the reader's job, not the
    envelope's -- and so is an absent field.

    The rule is deliberately SYMMETRIC across types. An earlier version rejected
    only non-legacy mappings, which let a list, an int, a bool or a float pass
    classification and reach the reader, where it rendered as the sentinel. That is
    the same "no safe way to render this" condition arriving by a different type,
    so it gets the same fail-closed answer instead of a silently degraded alert.

    Booleans are intentionally unrenderable, not an oversight: a read-only survey
    of the live sent corpus (9,221 events, full coverage, zero parse failures)
    found zero events carrying a boolean in either field, so nothing in the estate
    relies on one being rendered, and a producer that starts emitting one is
    reporting a bug rather than an alert.
    """
    for field in ALERT_CONTENT_FIELDS:
        value = event.get(field)
        if value is None or isinstance(value, str):
            continue
        if isinstance(value, Mapping) and legacy_confined_to_text(dict(value)) is not None:
            continue
        raise EnvelopeError("unrenderable_alert_content")


def classify_event(event: Mapping[str, Any]) -> EventClassification:
    """Classify a supported v1 or v2 event without mutating the input."""

    version = _schema_version(event)
    if version == SCHEMA_VERSION:
        classification = _classify_v2(event)
        _require_renderable_alert_content(event)
        return classification

    if "eventKind" in event:
        raise EnvelopeError("unexpected_legacy_event_kind")
    event_type = _required_string(event, "eventType", "missing_event_type")
    severity = _required_string(event, "severity", "missing_severity")
    kind, canonical_event_type, canonical_severity = _classify_legacy_pair(event_type, severity)
    _require_renderable_alert_content(event)
    return EventClassification(kind, canonical_event_type, canonical_severity, LEGACY_SCHEMA_VERSION, True)


def normalize_event(event: Mapping[str, Any]) -> dict[str, Any]:
    """Return a schema-v2 copy of a valid queue event."""

    classification = classify_event(event)
    normalized = dict(event)
    normalized.update(
        {
            "schemaVersion": SCHEMA_VERSION,
            "eventKind": classification.kind,
            "eventType": classification.event_type,
            "severity": classification.severity,
        }
    )
    return normalized


def new_event_fields(event_type: str, severity: str) -> dict[str, Any]:
    """Build strict schema-v2 envelope fields for a newly emitted event."""

    pair = _classify_v2_pair(event_type.strip().lower(), severity.strip().lower())
    kind, canonical_event_type, canonical_severity = pair
    return {
        "schemaVersion": SCHEMA_VERSION,
        "eventKind": kind,
        "eventType": canonical_event_type,
        "severity": canonical_severity,
    }
