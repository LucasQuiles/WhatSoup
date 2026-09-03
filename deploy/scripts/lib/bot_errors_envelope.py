"""Versioned BOT ERRORS queue-event envelope validation and normalization."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

try:  # imported as ``lib.bot_errors_envelope`` by every deploy script
    from lib.bot_errors_redaction import (
        has_malformed_legacy_confined_repr,
        is_renderable_unconfined_mapping,
        legacy_confined_to_text,
    )
except ImportError:  # loaded by file path, without the package context
    from bot_errors_redaction import (
        has_malformed_legacy_confined_repr,
        is_renderable_unconfined_mapping,
        legacy_confined_to_text,
    )


SCHEMA_VERSION = 2
LEGACY_SCHEMA_VERSION = 1
EVENT_KINDS = ("incident_alert", "incident_recovery", "observation")
EVENT_TYPES = ("alert", "clear", "observation")
LEGACY_EVENT_TYPES = ("alert", "clear")
SEVERITIES = ("critical", "error", "warning", "info")
INCIDENT_SEVERITIES = frozenset(("critical", "error", "warning"))


class EnvelopeError(ValueError):
    """A bounded reason why a queue event is not safe to consume.

    ``kind`` and ``severity`` are populated only when classification had ALREADY
    validated them before the failure was raised, which is the case for
    ``unrenderable_alert_content``: the header is sound, the alert content is not.
    They are canonical values from a closed set, never raw event text, so a
    consumer can report what class of alert it dropped without echoing content.
    Both are empty when the failure happened before or during header validation.
    """

    def __init__(self, code: str, *, kind: str = "", severity: str = "") -> None:
        self.code = code
        self.kind = kind
        self.severity = severity
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
    _require_renderable_alert_content_classified(event, expected_kind, canonical_severity)
    return EventClassification(kind, canonical_event_type, canonical_severity, SCHEMA_VERSION, False)


ALERT_CONTENT_FIELDS = ("summary", "evidence")


def _require_renderable_alert_content(event: Mapping[str, Any]) -> None:
    """Reject a value the consumer has no safe way to render (#2386).

    `summary` and `evidence` are operator-visible text. Two non-string values are
    renderable, and the difference between them is what the value CLAIMS to be:

    * the legacy confinement envelope, whose exact three-key shape carries a
      failure class, a length and a digest. A mapping wearing those exact three
      keys claims to be one, so it is validated on the envelope's own terms and
      quarantined when it fails them. That rule is unchanged.
    * any OTHER mapping, which never claimed to be an envelope. It renders as a
      synthesised confinement string -- a fixed class token, the length of a
      canonical serialisation, and a digest of it. No key and no value crosses
      the boundary, so the metadata-only contract holds for a mapping the
      producer did not confine exactly as it holds for one the producer did.

    A string is always accepted here -- rendering it is the reader's job, not the
    envelope's -- and so is an absent field.

    The rule stays SYMMETRIC for every other type. A list, an int, a bool or a
    float has no key-value structure to project into bounded metadata, so it is
    still fail-closed rather than silently degraded to the sentinel.

    Booleans are intentionally unrenderable, not an oversight: a read-only survey
    of the live sent corpus (9,221 events, full coverage, zero parse failures)
    found zero events carrying a boolean in either field, so nothing in the estate
    relies on one being rendered, and a producer that starts emitting one is
    reporting a bug rather than an alert. That survey remains true, and its SCOPE
    is now stated with it: it asked which fields carried a BOOLEAN. It did not ask
    which carried a mapping, and the paragraph below is what happened because the
    answer to the second question was assumed rather than measured.

    THE SCOPE CORRECTION (r18, live defect of 2026-09-03T10:25:36Z). An earlier
    version of this rule quarantined every non-envelope mapping, on the stated
    premise that "the one non-string value a consumer can render is the legacy
    confinement envelope" and that a survey of the live sent corpus supported it.
    That survey was run for BOOLEANS. The same corpus carries 54 delivered events
    whose `evidence` is a plain diagnostic mapping, spanning 30 producer
    identities, 14 machines and 12 instances, continuously from 2026-07-04. Those
    producers live outside this repository and pinned themselves to the schema-v1
    contract, in which `evidence` was free-form, two months before this rule
    narrowed it. Failing them closed did not close a content channel: it deleted
    an entire producer family's alerts, and their recoveries with them.
    """
    for field in ALERT_CONTENT_FIELDS:
        value = event.get(field)
        if value is None:
            continue
        if isinstance(value, str):
            # #2386: a string is normally the reader's job, but a string that IS
            # this envelope's repr with values outside the bounds is confined
            # material, not prose. Accepting it kept an invalid failure class and
            # a digest-shaped field inside a routable incident alert, which is
            # the content channel this issue closes. Ordinary text, including
            # text carrying a VALID envelope repr, is unaffected.
            if has_malformed_legacy_confined_repr(value):
                raise EnvelopeError("unrenderable_alert_content")
            continue
        if isinstance(value, Mapping):
            if legacy_confined_to_text(dict(value)) is not None:
                continue
            # Not an envelope and not claiming to be one: the reader synthesises
            # a confinement string for it. `is_renderable_unconfined_mapping` is
            # the SAME predicate the renderer uses, minus the digest, so a value
            # accepted here is always one `alert_text` can render -- accepted and
            # renderable never diverge.
            if is_renderable_unconfined_mapping(value):
                continue
        raise EnvelopeError("unrenderable_alert_content")


def _require_renderable_alert_content_classified(
    event: Mapping[str, Any], kind: str, severity: str
) -> None:
    """Validate alert content, tagging the failure with the validated header.

    An `incident_recovery` is EXEMPT, and the exemption is the whole point of
    knowing the kind before the content is checked.

    A clear carries no operator-visible content obligation beyond its identity:
    its job is to close an open incident. Its body renders as the existing
    sentinel when there is nothing safe to show, which costs an operator nothing.
    Quarantining it costs the incident: the recovery is never re-read and never
    re-delivered, so the incident it was closing stays open forever, renotifying
    as live indefinitely. That is a stuck-incident class with no operator surface
    at all, and it is strictly worse than an unrendered clear body.

    Observed live on 2026-09-03: one quarantined clear left the incident it was
    closing permanently open, with nothing anywhere that could close it.
    """
    if kind == "incident_recovery":
        return
    try:
        _require_renderable_alert_content(event)
    except EnvelopeError as exc:
        raise EnvelopeError(exc.code, kind=kind, severity=severity) from None


def classify_event(event: Mapping[str, Any]) -> EventClassification:
    """Classify a supported v1 or v2 event without mutating the input."""

    version = _schema_version(event)
    if version == SCHEMA_VERSION:
        return _classify_v2(event)

    if "eventKind" in event:
        raise EnvelopeError("unexpected_legacy_event_kind")
    event_type = _required_string(event, "eventType", "missing_event_type")
    severity = _required_string(event, "severity", "missing_severity")
    kind, canonical_event_type, canonical_severity = _classify_legacy_pair(event_type, severity)
    _require_renderable_alert_content_classified(event, kind, canonical_severity)
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
