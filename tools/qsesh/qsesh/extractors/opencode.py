"""Parse T11 OpenCode canonical export JSONL into canonical events."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import MappingProxyType

from qsesh.errors import QseshError
from qsesh.model import EventKind, ExtractedSession, Harness, JsonValue, SourceSnapshot

from .base import EventBuilder, normalize_timestamp, parse_jsonl_objects

OPENCODE_SNAPSHOT_FINGERPRINT = "opencode-export-jsonl-v1"
OPENCODE_OBSERVED_SCHEMA_FINGERPRINT = (
    "5a6076f647ae5fcc6ba74d82940712985341e3d803b649e65e29824c35e46721"
)
ACCEPTED_OPENCODE_FINGERPRINTS = MappingProxyType(
    {OPENCODE_SNAPSHOT_FINGERPRINT: OPENCODE_OBSERVED_SCHEMA_FINGERPRINT}
)
OPENCODE_HARNESS_VERSION = "1.17.15"

_SAFE_KIND = re.compile(r"[A-Za-z][A-Za-z0-9._-]{0,63}").fullmatch
_SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}").fullmatch
_ROW_KINDS = frozenset({"message", "part", "session"})
_PART_TYPES = frozenset(
    {"compaction", "file", "fixture_unknown", "reasoning", "subtask", "text", "tool"}
)


@dataclass(frozen=True, slots=True)
class _MessageContext:
    index: int
    message_id: str
    role: str
    timestamp: str
    model: str | None
    provider: str | None


def _schema(phase: str) -> QseshError:
    return QseshError("QS-E-SOURCE-SCHEMA", phase=phase)


def _exact_keys(value: dict[str, JsonValue], expected: set[str], *, phase: str) -> None:
    if set(value) != expected:
        raise _schema(phase)


def _allowed_keys(
    value: dict[str, JsonValue],
    required: set[str],
    optional: set[str],
    *,
    phase: str,
) -> None:
    keys = set(value)
    if not required <= keys or not keys <= required | optional:
        raise _schema(phase)


def _string(value: object, *, phase: str, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        raise _schema(phase)
    return value


def _object(value: object, *, phase: str) -> dict[str, JsonValue]:
    if not isinstance(value, dict):
        raise _schema(phase)
    return value


def _nonnegative_int(value: object, *, phase: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _schema(phase)
    return value


def _timestamp_ms(value: object, *, phase: str) -> str:
    milliseconds = _nonnegative_int(value, phase=phase)
    try:
        parsed = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(
            milliseconds=milliseconds
        )
    except OverflowError as error:
        raise _schema(phase) from error
    return normalize_timestamp(parsed.isoformat())


def _time_created(value: object, *, phase: str) -> str:
    time_value = _object(value, phase=phase)
    _exact_keys(time_value, {"created"}, phase=phase)
    return _timestamp_ms(time_value.get("created"), phase=phase)


def _tokens(value: object) -> dict[str, JsonValue]:
    phase = "opencode-usage"
    raw = _object(value, phase=phase)
    if not raw or not set(raw) <= {"input", "output"}:
        raise _schema(phase)
    for item in raw.values():
        _nonnegative_int(item, phase=phase)
    return dict(raw)


def _cost(value: object) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise _schema("opencode-cost")
    return value


class OpenCodeExtractor:
    def extract(self, snapshot: SourceSnapshot) -> ExtractedSession:
        if snapshot.candidate.harness is not Harness.OPENCODE:
            raise _schema("opencode-harness")
        if snapshot.schema_fingerprint not in ACCEPTED_OPENCODE_FINGERPRINTS:
            raise _schema("opencode-schema-fingerprint")
        if snapshot.harness_version != OPENCODE_HARNESS_VERSION:
            raise _schema("opencode-harness-version")
        rows = parse_jsonl_objects(snapshot)
        if self._kind(rows[0]) != "session":
            raise _schema("opencode-row-order")

        builder = EventBuilder()
        self._session(rows[0], snapshot=snapshot, builder=builder)
        next_message_index = 0
        next_part_index = 0
        context: _MessageContext | None = None
        message_ids: set[str] = set()
        part_ids: set[str] = set()

        for row in rows[1:]:
            kind = self._kind(row)
            if kind == "session":
                raise _schema("opencode-row-order")
            if kind == "message":
                context = self._message(
                    row,
                    expected_index=next_message_index,
                    session_id=snapshot.candidate.native_id,
                    prior_message_ids=message_ids,
                    builder=builder,
                )
                message_ids.add(context.message_id)
                next_message_index += 1
                next_part_index = 0
                continue
            if kind != "part":
                raise _schema("opencode-row-kind")
            if context is None:
                raise _schema("opencode-row-order")
            self._part(
                row,
                context=context,
                expected_part_index=next_part_index,
                session_id=snapshot.candidate.native_id,
                part_ids=part_ids,
                builder=builder,
            )
            next_part_index += 1
        if next_message_index == 0:
            raise _schema("opencode-row-order")
        return builder.finish(snapshot)

    @staticmethod
    def _kind(row: dict[str, JsonValue]) -> str:
        kind = row.get("kind")
        if (
            not isinstance(kind, str)
            or _SAFE_KIND(kind) is None
            or kind not in _ROW_KINDS
        ):
            raise _schema("opencode-row-kind")
        return kind

    def _session(
        self,
        row: dict[str, JsonValue],
        *,
        snapshot: SourceSnapshot,
        builder: EventBuilder,
    ) -> None:
        phase = "opencode-row-schema"
        _exact_keys(row, {"kind", "schema_version", "value"}, phase=phase)
        if row.get("kind") != "session" or row.get("schema_version") != 1:
            raise _schema(phase)
        info_phase = "opencode-session-info"
        info = _object(row.get("value"), phase=info_phase)
        _allowed_keys(
            info,
            {"directory", "id", "projectID", "time", "title", "version"},
            {"cost", "tokens"},
            phase=info_phase,
        )
        if (
            info.get("id") != snapshot.candidate.native_id
            or info.get("version") != snapshot.harness_version
        ):
            raise _schema(info_phase)
        time_value = _object(info.get("time"), phase=info_phase)
        _exact_keys(time_value, {"created", "updated"}, phase=info_phase)
        timestamp = _timestamp_ms(time_value.get("created"), phase=info_phase)
        _timestamp_ms(time_value.get("updated"), phase=info_phase)
        builder.add(
            EventKind.SESSION_META,
            timestamp_utc=timestamp,
            text=None,
            data={
                "harness_version": _string(info.get("version"), phase=info_phase),
                "project": _string(info.get("directory"), phase=info_phase),
                "project_id": _string(info.get("projectID"), phase=info_phase),
                "title": _string(info.get("title"), phase=info_phase, allow_empty=True),
            },
            source_ref="info",
        )
        self._metrics(
            info,
            timestamp=timestamp,
            source_ref="info",
            scope="session",
            model=None,
            provider=None,
            builder=builder,
        )

    def _message(
        self,
        row: dict[str, JsonValue],
        *,
        expected_index: int,
        session_id: str,
        prior_message_ids: set[str],
        builder: EventBuilder,
    ) -> _MessageContext:
        phase = "opencode-row-schema"
        _exact_keys(
            row,
            {"kind", "message_index", "schema_version", "value"},
            phase=phase,
        )
        if row.get("schema_version") != 1:
            raise _schema(phase)
        if row.get("message_index") != expected_index:
            raise _schema("opencode-row-order")
        info_phase = "opencode-message-info"
        info = _object(row.get("value"), phase=info_phase)
        role = info.get("role")
        common = {"id", "role", "sessionID", "time"}
        if role == "user":
            _exact_keys(info, common, phase=info_phase)
            model = provider = None
        elif role == "assistant":
            _allowed_keys(
                info,
                common | {"agent", "modelID", "parentID", "providerID"},
                {"cost", "tokens"},
                phase=info_phase,
            )
            model = _string(info.get("modelID"), phase=info_phase)
            provider = _string(info.get("providerID"), phase=info_phase)
            _string(info.get("agent"), phase=info_phase)
            parent = _string(info.get("parentID"), phase=info_phase)
            if parent not in prior_message_ids:
                raise _schema("opencode-identity")
        else:
            raise _schema(info_phase)
        message_id = _string(info.get("id"), phase=info_phase)
        if info.get("sessionID") != session_id or message_id in prior_message_ids:
            raise _schema("opencode-identity")
        timestamp = _time_created(info.get("time"), phase=info_phase)
        context = _MessageContext(
            index=expected_index,
            message_id=message_id,
            role=role,
            timestamp=timestamp,
            model=model,
            provider=provider,
        )
        self._metrics(
            info,
            timestamp=timestamp,
            source_ref=f"messages:{expected_index}/info",
            scope="message",
            model=model,
            provider=provider,
            builder=builder,
        )
        return context

    @staticmethod
    def _metrics(
        value: dict[str, JsonValue],
        *,
        timestamp: str,
        source_ref: str,
        scope: str,
        model: str | None,
        provider: str | None,
        builder: EventBuilder,
    ) -> None:
        if "tokens" in value:
            builder.add(
                EventKind.META,
                timestamp_utc=timestamp,
                text=None,
                data={
                    "meta_type": "usage",
                    "model": model,
                    "provider": provider,
                    "scope": scope,
                    "source": "opencode",
                    "unit": "tokens",
                    "usage": _tokens(value["tokens"]),
                },
                source_ref=f"{source_ref}/usage",
            )
        if "cost" in value:
            builder.add(
                EventKind.META,
                timestamp_utc=timestamp,
                text=None,
                data={
                    "cost": _cost(value["cost"]),
                    "meta_type": "cost",
                    "model": model,
                    "provider": provider,
                    "scope": scope,
                    "source": "opencode",
                    "unit": "opencode_native",
                },
                source_ref=f"{source_ref}/cost",
            )

    def _part(
        self,
        row: dict[str, JsonValue],
        *,
        context: _MessageContext,
        expected_part_index: int,
        session_id: str,
        part_ids: set[str],
        builder: EventBuilder,
    ) -> None:
        phase = "opencode-row-schema"
        _exact_keys(
            row,
            {"kind", "message_index", "part_index", "schema_version", "value"},
            phase=phase,
        )
        if row.get("schema_version") != 1:
            raise _schema(phase)
        if (
            row.get("message_index") != context.index
            or row.get("part_index") != expected_part_index
        ):
            raise _schema("opencode-row-order")
        part = _object(row.get("value"), phase="opencode-part")
        part_type = part.get("type")
        if (
            not isinstance(part_type, str)
            or _SAFE_KIND(part_type) is None
            or part_type not in _PART_TYPES
        ):
            raise _schema("opencode-part-type")
        part_id = part.get("id")
        if (
            not isinstance(part_id, str)
            or not part_id
            or part_id in part_ids
            or part.get("messageID") != context.message_id
            or part.get("sessionID") != session_id
        ):
            raise _schema("opencode-identity")
        part_ids.add(part_id)
        source_ref = f"messages:{context.index}/parts:{expected_part_index}"

        if part_type in {"text", "reasoning", "compaction"}:
            self._text_part(
                part,
                part_type=part_type,
                context=context,
                source_ref=source_ref,
                builder=builder,
            )
            return
        if part_type == "tool":
            self._tool_part(
                part,
                context=context,
                source_ref=source_ref,
                builder=builder,
            )
            return
        if part_type == "subtask":
            self._subtask_part(
                part,
                context=context,
                source_ref=source_ref,
                builder=builder,
            )
            return
        if part_type == "file":
            self._file_part(
                part,
                context=context,
                source_ref=source_ref,
                builder=builder,
            )
            return
        self._unknown_part(
            part,
            context=context,
            source_ref=source_ref,
            builder=builder,
        )

    @staticmethod
    def _text_part(
        part: dict[str, JsonValue],
        *,
        part_type: str,
        context: _MessageContext,
        source_ref: str,
        builder: EventBuilder,
    ) -> None:
        phase = f"opencode-{part_type}"
        required = {"id", "messageID", "sessionID", "text", "type"}
        if context.role == "user" and part_type == "text":
            _allowed_keys(part, required, {"synthetic"}, phase=phase)
            if "synthetic" in part and not isinstance(part["synthetic"], bool):
                raise _schema(phase)
        else:
            _exact_keys(part, required, phase=phase)
        text = _string(part.get("text"), phase=phase, allow_empty=True)
        if part_type == "text":
            kind = (
                EventKind.USER_MSG
                if context.role == "user"
                else EventKind.ASSISTANT_MSG
            )
            data: dict[str, JsonValue] = {"role": context.role}
            if context.role == "assistant":
                data.update({"model": context.model, "provider": context.provider})
        elif part_type == "reasoning":
            if context.role != "assistant":
                raise _schema(phase)
            kind = EventKind.REASONING
            data = {"model": context.model, "provider": context.provider}
        else:
            if context.role != "assistant":
                raise _schema(phase)
            kind = EventKind.COMPACTION
            data = {}
        builder.add(
            kind,
            timestamp_utc=context.timestamp,
            text=text,
            data=data,
            source_ref=source_ref,
        )

    @staticmethod
    def _tool_part(
        part: dict[str, JsonValue],
        *,
        context: _MessageContext,
        source_ref: str,
        builder: EventBuilder,
    ) -> None:
        if context.role != "assistant":
            raise _schema("opencode-tool")
        _exact_keys(
            part,
            {"id", "messageID", "sessionID", "state", "tool", "type"},
            phase="opencode-tool",
        )
        name = _string(part.get("tool"), phase="opencode-tool")
        state = _object(part.get("state"), phase="opencode-tool")
        if name == "skill":
            phase = "opencode-skill"
            _exact_keys(state, {"input", "status"}, phase=phase)
            if state.get("status") != "completed":
                raise _schema(phase)
            inputs = _object(state.get("input"), phase=phase)
            _exact_keys(inputs, {"name"}, phase=phase)
            skill = _string(inputs.get("name"), phase=phase)
            if _SAFE_NAME(skill) is None:
                raise _schema(phase)
            builder.add(
                EventKind.SKILL_INVOCATION,
                timestamp_utc=context.timestamp,
                text=None,
                data={"name": skill},
                source_ref=source_ref,
            )
            return
        phase = "opencode-tool"
        if _SAFE_NAME(name) is None:
            raise _schema(phase)
        _exact_keys(state, {"input", "output", "status"}, phase=phase)
        if state.get("status") != "completed":
            raise _schema(phase)
        inputs = _object(state.get("input"), phase=phase)
        output = state.get("output")
        if not isinstance(output, (str, dict, list)):
            raise _schema(phase)
        call_id = _string(part.get("id"), phase=phase)
        builder.add(
            EventKind.TOOL_CALL,
            timestamp_utc=context.timestamp,
            text=None,
            data={
                "call_id": call_id,
                "input": inputs,
                "is_mcp": name.startswith("mcp__"),
                "name": name,
            },
            source_ref=f"{source_ref}/state:input",
        )
        builder.add(
            EventKind.TOOL_RESULT,
            timestamp_utc=context.timestamp,
            text=None,
            data={"call_id": call_id, "result": output},
            source_ref=f"{source_ref}/state:output",
        )

    @staticmethod
    def _subtask_part(
        part: dict[str, JsonValue],
        *,
        context: _MessageContext,
        source_ref: str,
        builder: EventBuilder,
    ) -> None:
        phase = "opencode-subagent"
        if context.role != "assistant":
            raise _schema(phase)
        _exact_keys(
            part,
            {"agent", "id", "messageID", "prompt", "sessionID", "type"},
            phase=phase,
        )
        agent = _string(part.get("agent"), phase=phase)
        if _SAFE_NAME(agent) is None:
            raise _schema(phase)
        builder.add(
            EventKind.SUBAGENT_ACTIVITY,
            timestamp_utc=context.timestamp,
            text=_string(part.get("prompt"), phase=phase, allow_empty=True),
            data={"agent": agent},
            source_ref=source_ref,
        )

    @staticmethod
    def _file_part(
        part: dict[str, JsonValue],
        *,
        context: _MessageContext,
        source_ref: str,
        builder: EventBuilder,
    ) -> None:
        phase = "opencode-file"
        _exact_keys(
            part,
            {"file", "id", "messageID", "sessionID", "type"},
            phase=phase,
        )
        file_value = _object(part.get("file"), phase=phase)
        _exact_keys(file_value, {"name"}, phase=phase)
        builder.add(
            EventKind.META,
            timestamp_utc=context.timestamp,
            text=None,
            data={
                "file": _string(file_value.get("name"), phase=phase),
                "meta_type": "attachment",
            },
            source_ref=source_ref,
        )

    @staticmethod
    def _unknown_part(
        part: dict[str, JsonValue],
        *,
        context: _MessageContext,
        source_ref: str,
        builder: EventBuilder,
    ) -> None:
        phase = "opencode-unknown"
        _exact_keys(
            part,
            {"id", "messageID", "sessionID", "text", "type"},
            phase=phase,
        )
        _string(part.get("text"), phase=phase, allow_empty=True)
        builder.add(
            EventKind.META,
            timestamp_utc=context.timestamp,
            text=None,
            data={"raw_type": "fixture_unknown"},
            source_ref=source_ref,
        )
