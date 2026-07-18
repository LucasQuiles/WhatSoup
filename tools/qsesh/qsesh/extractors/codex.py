"""Parse Codex JSONL rows into the shared canonical event vocabulary."""

from __future__ import annotations

import re
from types import MappingProxyType

from qsesh.errors import QseshError
from qsesh.jsonio import load_json_object
from qsesh.model import EventKind, ExtractedSession, Harness, JsonValue, SourceSnapshot

from .base import EventBuilder, normalize_timestamp, parse_jsonl_objects

CODEX_SNAPSHOT_FINGERPRINT = "unclassified-jsonl-v1"
CODEX_OBSERVED_SCHEMA_FINGERPRINT = (
    "d60edba4b9c2f506e0dc6c2f9fb3d4fdea57253a2ab9109d85a876dab71f9b12"
)
ACCEPTED_CODEX_FINGERPRINTS = MappingProxyType(
    {CODEX_SNAPSHOT_FINGERPRINT: CODEX_OBSERVED_SCHEMA_FINGERPRINT}
)

_SAFE_KIND = re.compile(r"[A-Za-z][A-Za-z0-9._-]{0,63}").fullmatch
_SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}").fullmatch
_TOP_LEVEL_TYPES = frozenset({"event_msg", "response_item", "session_meta"})


def _schema(phase: str) -> QseshError:
    return QseshError("QS-E-SOURCE-SCHEMA", phase=phase)


def _exact_keys(value: dict[str, JsonValue], expected: set[str], *, phase: str) -> None:
    if set(value) != expected:
        raise _schema(phase)


def _string(value: object, *, phase: str, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        raise _schema(phase)
    return value


def _object(value: object, *, phase: str) -> dict[str, JsonValue]:
    if not isinstance(value, dict):
        raise _schema(phase)
    return value


def _array(value: object, *, phase: str) -> list[JsonValue]:
    if not isinstance(value, list):
        raise _schema(phase)
    return value


def _arguments(value: object, *, phase: str) -> dict[str, JsonValue]:
    raw = _string(value, phase=phase)
    try:
        return load_json_object(raw)
    except (TypeError, ValueError, UnicodeError) as error:
        raise _schema(phase) from error


class CodexExtractor:
    def extract(self, snapshot: SourceSnapshot) -> ExtractedSession:
        if snapshot.candidate.harness is not Harness.CODEX:
            raise _schema("codex-harness")
        if snapshot.schema_fingerprint not in ACCEPTED_CODEX_FINGERPRINTS:
            raise _schema("codex-schema-fingerprint")
        rows = parse_jsonl_objects(snapshot)
        builder = EventBuilder()
        all_calls: set[str] = set()
        tool_calls: set[str] = set()
        tool_results: set[str] = set()
        for line_index, row in enumerate(rows, start=1):
            self._dispatch(
                row,
                line_index=line_index,
                snapshot=snapshot,
                builder=builder,
                all_calls=all_calls,
                tool_calls=tool_calls,
                tool_results=tool_results,
            )
        return builder.finish(snapshot)

    def _dispatch(
        self,
        row: dict[str, JsonValue],
        *,
        line_index: int,
        snapshot: SourceSnapshot,
        builder: EventBuilder,
        all_calls: set[str],
        tool_calls: set[str],
        tool_results: set[str],
    ) -> None:
        _exact_keys(row, {"payload", "timestamp", "type"}, phase="codex-row-keys")
        raw_type = row.get("type")
        if (
            not isinstance(raw_type, str)
            or _SAFE_KIND(raw_type) is None
            or raw_type not in _TOP_LEVEL_TYPES
        ):
            raise _schema("codex-row-type")
        timestamp = normalize_timestamp(row.get("timestamp"))
        payload = _object(row.get("payload"), phase="codex-payload")
        source_line = f"line:{line_index}"

        if raw_type == "session_meta":
            self._session_meta(
                payload,
                source_line=source_line,
                timestamp=timestamp,
                snapshot=snapshot,
                builder=builder,
            )
            return

        payload_type = payload.get("type")
        if not isinstance(payload_type, str) or _SAFE_KIND(payload_type) is None:
            raise _schema("codex-payload-type")
        if raw_type == "event_msg":
            self._event_message(
                payload,
                payload_type=payload_type,
                source_line=source_line,
                timestamp=timestamp,
                builder=builder,
            )
            return
        self._response_item(
            payload,
            payload_type=payload_type,
            line_index=line_index,
            timestamp=timestamp,
            builder=builder,
            all_calls=all_calls,
            tool_calls=tool_calls,
            tool_results=tool_results,
        )

    def _session_meta(
        self,
        payload: dict[str, JsonValue],
        *,
        source_line: str,
        timestamp: str,
        snapshot: SourceSnapshot,
        builder: EventBuilder,
    ) -> None:
        phase = "codex-session-meta"
        _exact_keys(payload, {"cwd", "id", "model", "session_id"}, phase=phase)
        identity = snapshot.candidate.native_id
        if payload.get("id") != identity or payload.get("session_id") != identity:
            raise _schema(phase)
        builder.add(
            EventKind.SESSION_META,
            timestamp_utc=timestamp,
            text=None,
            data={
                "model": _string(payload.get("model"), phase=phase),
                "project": _string(payload.get("cwd"), phase=phase),
            },
            source_ref=source_line,
        )

    def _event_message(
        self,
        payload: dict[str, JsonValue],
        *,
        payload_type: str,
        source_line: str,
        timestamp: str,
        builder: EventBuilder,
    ) -> None:
        if payload_type == "user_message":
            phase = "codex-user-message"
            _exact_keys(payload, {"message", "type"}, phase=phase)
            builder.add(
                EventKind.USER_MSG,
                timestamp_utc=timestamp,
                text=_string(payload.get("message"), phase=phase, allow_empty=True),
                data={"role": "user"},
                source_ref=source_line,
            )
            return
        if payload_type == "attachment":
            phase = "codex-attachment"
            _exact_keys(payload, {"attachment", "type"}, phase=phase)
            attachment = _object(payload.get("attachment"), phase=phase)
            _exact_keys(attachment, {"id", "type"}, phase=phase)
            if attachment.get("type") != "file":
                raise _schema(phase)
            builder.add(
                EventKind.META,
                timestamp_utc=timestamp,
                text=None,
                data={
                    "file": _string(attachment.get("id"), phase=phase),
                    "meta_type": "attachment",
                },
                source_ref=source_line,
            )
            return
        raise _schema("codex-payload-type")

    def _response_item(
        self,
        payload: dict[str, JsonValue],
        *,
        payload_type: str,
        line_index: int,
        timestamp: str,
        builder: EventBuilder,
        all_calls: set[str],
        tool_calls: set[str],
        tool_results: set[str],
    ) -> None:
        if payload_type == "reasoning":
            self._summary_events(
                payload,
                phase="codex-reasoning",
                kind=EventKind.REASONING,
                line_index=line_index,
                timestamp=timestamp,
                builder=builder,
            )
            return
        if payload_type == "compaction":
            self._summary_events(
                payload,
                phase="codex-compaction",
                kind=EventKind.COMPACTION,
                line_index=line_index,
                timestamp=timestamp,
                builder=builder,
            )
            return
        if payload_type == "message":
            self._assistant_message(
                payload,
                line_index=line_index,
                timestamp=timestamp,
                builder=builder,
            )
            return
        if payload_type == "function_call":
            self._function_call(
                payload,
                source_line=f"line:{line_index}",
                timestamp=timestamp,
                builder=builder,
                all_calls=all_calls,
                tool_calls=tool_calls,
            )
            return
        if payload_type == "function_call_output":
            self._function_result(
                payload,
                source_line=f"line:{line_index}",
                timestamp=timestamp,
                builder=builder,
                tool_calls=tool_calls,
                tool_results=tool_results,
            )
            return
        if payload_type == "fixture_unknown":
            phase = "codex-unknown-payload"
            _exact_keys(payload, {"message", "type"}, phase=phase)
            _string(payload.get("message"), phase=phase, allow_empty=True)
            builder.add(
                EventKind.META,
                timestamp_utc=timestamp,
                text=None,
                data={"raw_type": payload_type},
                source_ref=f"line:{line_index}",
            )
            return
        raise _schema("codex-payload-type")

    def _summary_events(
        self,
        payload: dict[str, JsonValue],
        *,
        phase: str,
        kind: EventKind,
        line_index: int,
        timestamp: str,
        builder: EventBuilder,
    ) -> None:
        _exact_keys(payload, {"summary", "type"}, phase=phase)
        summary = _array(payload.get("summary"), phase=phase)
        if not summary:
            raise _schema(phase)
        for summary_index, raw_item in enumerate(summary):
            item = _object(raw_item, phase=phase)
            _exact_keys(item, {"text", "type"}, phase=phase)
            if item.get("type") != "summary_text":
                raise _schema(phase)
            builder.add(
                kind,
                timestamp_utc=timestamp,
                text=_string(item.get("text"), phase=phase, allow_empty=True),
                data={},
                source_ref=(
                    f"line:{line_index}"
                    if kind is EventKind.COMPACTION and len(summary) == 1
                    else f"line:{line_index}/summary:{summary_index}"
                ),
            )

    def _assistant_message(
        self,
        payload: dict[str, JsonValue],
        *,
        line_index: int,
        timestamp: str,
        builder: EventBuilder,
    ) -> None:
        phase = "codex-assistant-message"
        _exact_keys(payload, {"content", "role", "type"}, phase=phase)
        if payload.get("role") != "assistant":
            raise _schema(phase)
        content = _array(payload.get("content"), phase=phase)
        if not content:
            raise _schema(phase)
        for content_index, raw_part in enumerate(content):
            part = _object(raw_part, phase=phase)
            _exact_keys(part, {"text", "type"}, phase=phase)
            if part.get("type") != "output_text":
                raise _schema(phase)
            builder.add(
                EventKind.ASSISTANT_MSG,
                timestamp_utc=timestamp,
                text=_string(part.get("text"), phase=phase, allow_empty=True),
                data={"role": "assistant"},
                source_ref=f"line:{line_index}/content:{content_index}",
            )

    def _function_call(
        self,
        payload: dict[str, JsonValue],
        *,
        source_line: str,
        timestamp: str,
        builder: EventBuilder,
        all_calls: set[str],
        tool_calls: set[str],
    ) -> None:
        _exact_keys(
            payload,
            {"arguments", "call_id", "name", "type"},
            phase="codex-tool-call",
        )
        name = _string(payload.get("name"), phase="codex-tool-call")
        call_id = _string(payload.get("call_id"), phase="codex-tool-call")
        if _SAFE_NAME(name) is None or call_id in all_calls:
            raise _schema("codex-tool-call")
        all_calls.add(call_id)

        if name == "Skill":
            arguments = _arguments(payload.get("arguments"), phase="codex-skill")
            _exact_keys(arguments, {"name"}, phase="codex-skill")
            skill = _string(arguments.get("name"), phase="codex-skill")
            if _SAFE_NAME(skill) is None:
                raise _schema("codex-skill")
            builder.add(
                EventKind.SKILL_INVOCATION,
                timestamp_utc=timestamp,
                text=None,
                data={"name": skill},
                source_ref=source_line,
            )
            return

        if name == "spawn_agent":
            arguments = _arguments(payload.get("arguments"), phase="codex-subagent")
            _exact_keys(arguments, {"agent", "prompt"}, phase="codex-subagent")
            agent = _string(arguments.get("agent"), phase="codex-subagent")
            if _SAFE_NAME(agent) is None:
                raise _schema("codex-subagent")
            builder.add(
                EventKind.SUBAGENT_ACTIVITY,
                timestamp_utc=timestamp,
                text=_string(
                    arguments.get("prompt"), phase="codex-subagent", allow_empty=True
                ),
                data={"agent": agent},
                source_ref=source_line,
            )
            return

        arguments = _arguments(payload.get("arguments"), phase="codex-tool-call")
        tool_calls.add(call_id)
        builder.add(
            EventKind.TOOL_CALL,
            timestamp_utc=timestamp,
            text=None,
            data={
                "call_id": call_id,
                "input": arguments,
                "is_mcp": name.startswith("mcp__"),
                "name": name,
            },
            source_ref=source_line,
        )

    def _function_result(
        self,
        payload: dict[str, JsonValue],
        *,
        source_line: str,
        timestamp: str,
        builder: EventBuilder,
        tool_calls: set[str],
        tool_results: set[str],
    ) -> None:
        phase = "codex-tool-result"
        _exact_keys(payload, {"call_id", "output", "type"}, phase=phase)
        call_id = _string(payload.get("call_id"), phase=phase)
        if call_id not in tool_calls or call_id in tool_results:
            raise _schema(phase)
        output = payload.get("output")
        if not isinstance(output, (str, dict, list)):
            raise _schema(phase)
        tool_results.add(call_id)
        builder.add(
            EventKind.TOOL_RESULT,
            timestamp_utc=timestamp,
            text=None,
            data={"call_id": call_id, "result": output},
            source_ref=source_line,
        )
