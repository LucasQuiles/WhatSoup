"""Shared parse-only extractor protocol and deterministic helpers."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Protocol

from qsesh.errors import QseshError
from qsesh.jsonio import load_json_object
from qsesh.model import (
    CanonicalEvent,
    EventKind,
    ExtractedSession,
    JsonValue,
    SourceSnapshot,
)


class Extractor(Protocol):
    def extract(self, snapshot: SourceSnapshot) -> ExtractedSession: ...


def optional_timestamp(value: object) -> str | None:
    if value is None:
        return None
    return normalize_timestamp(value)


def normalize_timestamp(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise QseshError("QS-E-SOURCE-SCHEMA", phase="extractor-timestamp")
    candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(candidate)
        offset = parsed.utcoffset()
    except (TypeError, ValueError, OverflowError) as error:
        raise QseshError("QS-E-SOURCE-SCHEMA", phase="extractor-timestamp") from error
    if parsed.tzinfo is None or offset is None:
        raise QseshError("QS-E-SOURCE-SCHEMA", phase="extractor-timestamp")
    normalized = parsed.astimezone(timezone.utc)
    timespec = "microseconds" if normalized.microsecond else "seconds"
    return normalized.isoformat(timespec=timespec).replace("+00:00", "Z")


def parse_jsonl_objects(snapshot: SourceSnapshot) -> tuple[dict[str, JsonValue], ...]:
    raw = snapshot.raw_bytes
    expected_digest = hashlib.blake2b(raw, digest_size=32).hexdigest()
    if snapshot.source_digest != expected_digest:
        raise QseshError("QS-E-SOURCE-SCHEMA", phase="extractor-source-digest")
    if not raw or not raw.endswith(b"\n"):
        raise QseshError("QS-E-SOURCE-SCHEMA", phase="extractor-jsonl")
    lines = raw.splitlines()
    if not lines:
        raise QseshError("QS-E-SOURCE-SCHEMA", phase="extractor-jsonl")
    rows: list[dict[str, JsonValue]] = []
    try:
        for line in lines:
            if not line:
                raise ValueError("blank JSONL row")
            rows.append(load_json_object(line))
    except (UnicodeError, TypeError, ValueError) as error:
        raise QseshError("QS-E-SOURCE-SCHEMA", phase="extractor-jsonl") from error
    return tuple(rows)


class EventBuilder:
    def __init__(self) -> None:
        self._events: list[CanonicalEvent] = []

    def add(
        self,
        kind: EventKind,
        *,
        timestamp_utc: str | None,
        text: str | None,
        data: dict[str, JsonValue],
        source_ref: str,
    ) -> None:
        self._events.append(
            CanonicalEvent(
                schema_version=1,
                event_index=len(self._events),
                kind=kind,
                timestamp_utc=timestamp_utc,
                text=text,
                data=data,
                source_ref=source_ref,
            )
        )

    def finish(self, snapshot: SourceSnapshot) -> ExtractedSession:
        return ExtractedSession(snapshot=snapshot, events=tuple(self._events))
