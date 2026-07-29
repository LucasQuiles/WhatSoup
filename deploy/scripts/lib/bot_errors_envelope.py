"""Versioned BOT ERRORS queue-event envelope validation and normalization."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


SCHEMA_VERSION = 2
LEGACY_SCHEMA_VERSION = 1
EVENT_KINDS = frozenset(("incident_alert", "incident_recovery", "observation"))
EVENT_TYPES = frozenset(("alert", "clear", "observation"))
SEVERITIES = frozenset(("critical", "error", "warning", "info"))
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
    if event_type not in EVENT_TYPES:
        raise EnvelopeError("unknown_event_type")
    if severity not in SEVERITIES:
        raise EnvelopeError("unknown_severity")
    if event_type == "alert" and severity in INCIDENT_SEVERITIES:
        return "incident_alert", "alert", severity
    if event_type == "alert" and severity == "info":
        return "observation", "observation", "info"
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
    if event_type not in EVENT_TYPES:
        raise EnvelopeError("unknown_event_type")
    if severity not in SEVERITIES:
        raise EnvelopeError("unknown_severity")

    expected = {
        "incident_alert": ("alert", INCIDENT_SEVERITIES),
        "incident_recovery": ("clear", frozenset(("info",))),
        "observation": ("observation", frozenset(("info",))),
    }[kind]
    if event_type != expected[0] or severity not in expected[1]:
        raise EnvelopeError("invalid_kind_severity")
    return EventClassification(kind, event_type, severity, SCHEMA_VERSION, False)


def classify_event(event: Mapping[str, Any]) -> EventClassification:
    """Classify a supported v1 or v2 event without mutating the input."""

    version = _schema_version(event)
    if version == SCHEMA_VERSION:
        return _classify_v2(event)

    event_type = _required_string(event, "eventType", "missing_event_type")
    severity = _required_string(event, "severity", "missing_severity")
    kind, canonical_event_type, canonical_severity = _classify_legacy_pair(event_type, severity)
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

    pair = _classify_legacy_pair(event_type.strip().lower(), severity.strip().lower())
    if event_type.strip().lower() == "alert" and severity.strip().lower() == "info":
        raise EnvelopeError("invalid_kind_severity")
    kind, canonical_event_type, canonical_severity = pair
    return {
        "schemaVersion": SCHEMA_VERSION,
        "eventKind": kind,
        "eventType": canonical_event_type,
        "severity": canonical_severity,
    }
