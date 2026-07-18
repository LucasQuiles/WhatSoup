from __future__ import annotations

import math
from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

type JsonScalar = None | bool | int | float | str
type JsonValue = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]


def validate_json_value(value: object, *, field: str = "value") -> None:
    _validate_json_value(value, field=field, active=set())


def _validate_json_value(value: object, *, field: str, active: set[int]) -> None:
    if value is None or isinstance(value, (bool, int, str)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{field} contains a non-finite float")
        return
    if isinstance(value, list):
        identity = id(value)
        if identity in active:
            raise ValueError(f"{field} contains a container cycle")
        active.add(identity)
        try:
            for index, item in enumerate(value):
                _validate_json_value(item, field=f"{field}[{index}]", active=active)
        finally:
            active.remove(identity)
        return
    if isinstance(value, dict):
        identity = id(value)
        if identity in active:
            raise ValueError(f"{field} contains a container cycle")
        active.add(identity)
        try:
            for key, item in value.items():
                if not isinstance(key, str):
                    raise TypeError(f"{field} contains a non-string object key")
                _validate_json_value(item, field=f"{field}.{key}", active=active)
        finally:
            active.remove(identity)
        return
    raise TypeError(f"{field} contains a non-JSON value")


def _require_nonnegative_int(name: str, value: object) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{name} must be an integer")
    if value < 0:
        raise ValueError(f"{name} must be nonnegative")


def _require_positive_int(name: str, value: object) -> None:
    _require_nonnegative_int(name, value)
    if value == 0:
        raise ValueError(f"{name} must be positive")


def _require_string(name: str, value: object, *, nonempty: bool = True) -> None:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    if nonempty and not value:
        raise ValueError(f"{name} must not be empty")


def _require_optional_string(name: str, value: object) -> None:
    if value is not None:
        _require_string(name, value)


class Harness(StrEnum):
    CLAUDE = "claude"
    CODEX = "codex"
    OPENCODE = "opencode"


class EventKind(StrEnum):
    SESSION_META = "session_meta"
    USER_MSG = "user_msg"
    ASSISTANT_MSG = "assistant_msg"
    REASONING = "reasoning"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    SKILL_INVOCATION = "skill_invocation"
    SUBAGENT_ACTIVITY = "subagent_activity"
    COMPACTION = "compaction"
    META = "meta"


@dataclass(frozen=True, slots=True)
class FileStamp:
    device: int
    inode: int
    size: int
    mtime_ns: int
    ctime_ns: int

    def __post_init__(self) -> None:
        for name in ("device", "inode", "size", "mtime_ns", "ctime_ns"):
            _require_nonnegative_int(name, getattr(self, name))


@dataclass(frozen=True, slots=True)
class SourceCandidate:
    host_id: str
    harness: Harness
    native_id: str
    source_key: str
    updated_at_us: int
    file_stamp: FileStamp | None

    def __post_init__(self) -> None:
        _require_string("host_id", self.host_id)
        if not isinstance(self.harness, Harness):
            raise TypeError("harness must be a Harness")
        _require_string("native_id", self.native_id)
        _require_string("source_key", self.source_key)
        _require_nonnegative_int("updated_at_us", self.updated_at_us)
        if self.file_stamp is not None and not isinstance(self.file_stamp, FileStamp):
            raise TypeError("file_stamp must be a FileStamp or None")


@dataclass(frozen=True, slots=True)
class SourceSnapshot:
    candidate: SourceCandidate
    raw_bytes: bytes
    source_digest: str
    schema_fingerprint: str
    harness_version: str | None

    def __post_init__(self) -> None:
        if not isinstance(self.candidate, SourceCandidate):
            raise TypeError("candidate must be a SourceCandidate")
        if not isinstance(self.raw_bytes, bytes):
            raise TypeError("raw_bytes must be bytes")
        _require_string("source_digest", self.source_digest)
        _require_string("schema_fingerprint", self.schema_fingerprint)
        _require_optional_string("harness_version", self.harness_version)


@dataclass(frozen=True, slots=True)
class CanonicalEvent:
    schema_version: int
    event_index: int
    kind: EventKind
    timestamp_utc: str | None
    text: str | None
    data: dict[str, JsonValue]
    source_ref: str

    def __post_init__(self) -> None:
        _require_positive_int("schema_version", self.schema_version)
        _require_nonnegative_int("event_index", self.event_index)
        if not isinstance(self.kind, EventKind):
            raise TypeError("kind must be an EventKind")
        _require_optional_string("timestamp_utc", self.timestamp_utc)
        if self.text is not None:
            _require_string("text", self.text, nonempty=False)
        if not isinstance(self.data, dict):
            raise TypeError("data must be a JSON object")
        validate_json_value(self.data, field="data")
        _require_string("source_ref", self.source_ref)


@dataclass(frozen=True, slots=True)
class ExtractedSession:
    snapshot: SourceSnapshot
    events: tuple[CanonicalEvent, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.snapshot, SourceSnapshot):
            raise TypeError("snapshot must be a SourceSnapshot")
        if not isinstance(self.events, tuple):
            raise TypeError("events must be a tuple")
        if not all(isinstance(event, CanonicalEvent) for event in self.events):
            raise TypeError("events must contain only CanonicalEvent values")
        indices = [event.event_index for event in self.events]
        if indices != list(range(len(self.events))):
            raise ValueError("event indices must be contiguous and ordered from zero")


@dataclass(frozen=True, slots=True)
class CleanTurn:
    turn_index: int
    role: Literal["user", "assistant"]
    timestamp_utc: str | None
    text: str

    def __post_init__(self) -> None:
        _require_nonnegative_int("turn_index", self.turn_index)
        if self.role not in {"user", "assistant"}:
            raise ValueError("role must be user or assistant")
        _require_optional_string("timestamp_utc", self.timestamp_utc)
        _require_string("text", self.text, nonempty=False)


@dataclass(frozen=True, slots=True)
class DistilledSession:
    record: dict[str, JsonValue]
    turns: tuple[CleanTurn, ...]
    tools: tuple[dict[str, JsonValue], ...]
    skills: tuple[dict[str, JsonValue], ...]
    files: tuple[dict[str, JsonValue], ...]
    subagents: tuple[dict[str, JsonValue], ...]
    compactions: tuple[dict[str, JsonValue], ...]

    def __post_init__(self) -> None:
        if not isinstance(self.record, dict):
            raise TypeError("record must be a JSON object")
        validate_json_value(self.record, field="record")
        if not isinstance(self.turns, tuple) or not all(
            isinstance(turn, CleanTurn) for turn in self.turns
        ):
            raise TypeError("turns must be a tuple of CleanTurn values")
        indices = [turn.turn_index for turn in self.turns]
        if indices != list(range(len(self.turns))):
            raise ValueError("turn indices must be contiguous and ordered from zero")
        for name in ("tools", "skills", "files", "subagents", "compactions"):
            values = getattr(self, name)
            if not isinstance(values, tuple) or not all(
                isinstance(value, dict) for value in values
            ):
                raise TypeError(f"{name} must be a tuple of JSON objects")
            for index, value in enumerate(values):
                validate_json_value(value, field=f"{name}[{index}]")


@dataclass(frozen=True, slots=True)
class ArchiveRef:
    relpath: str
    sha256: str
    source_digest: str
    byte_count: int

    def __post_init__(self) -> None:
        _require_string("relpath", self.relpath)
        _require_string("sha256", self.sha256)
        _require_string("source_digest", self.source_digest)
        _require_nonnegative_int("byte_count", self.byte_count)
