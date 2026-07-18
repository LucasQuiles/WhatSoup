"""Parse Claude JSONL rows into the shared canonical event vocabulary."""

from __future__ import annotations

import re
from types import MappingProxyType

from qsesh.errors import QseshError
from qsesh.model import EventKind, ExtractedSession, Harness, JsonValue, SourceSnapshot

from .base import EventBuilder, normalize_timestamp, parse_jsonl_objects

CLAUDE_SNAPSHOT_FINGERPRINT = "unclassified-jsonl-v1"
CLAUDE_OBSERVED_SCHEMA_FINGERPRINT = (
    "3b974511186301c11dd9c67a724b8e83fc6b4a42f9fb1029c0dd9b9b1603eaf3"
)
ACCEPTED_CLAUDE_FINGERPRINTS = MappingProxyType(
    {CLAUDE_SNAPSHOT_FINGERPRINT: CLAUDE_OBSERVED_SCHEMA_FINGERPRINT}
)

_SAFE_KIND = re.compile(r"[A-Za-z][A-Za-z0-9._-]{0,63}").fullmatch
_SKILL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}").fullmatch


def _schema(phase: str) -> QseshError:
    return QseshError("QS-E-SOURCE-SCHEMA", phase=phase)


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


class ClaudeExtractor:
    def extract(self, snapshot: SourceSnapshot) -> ExtractedSession:
        if snapshot.candidate.harness is not Harness.CLAUDE:
            raise _schema("claude-harness")
        if snapshot.schema_fingerprint not in ACCEPTED_CLAUDE_FINGERPRINTS:
            raise _schema("claude-schema-fingerprint")
        rows = parse_jsonl_objects(snapshot)
        builder = EventBuilder()
        tool_calls: set[str] = set()
        tool_results: set[str] = set()
        for line_index, row in enumerate(rows, start=1):
            self._dispatch(
                row,
                line_index=line_index,
                snapshot=snapshot,
                builder=builder,
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
        tool_calls: set[str],
        tool_results: set[str],
    ) -> None:
        raw_type = row.get("type")
        if not isinstance(raw_type, str) or _SAFE_KIND(raw_type) is None:
            raise _schema("claude-row-type")
        timestamp = normalize_timestamp(row.get("timestamp"))
        source_line = f"line:{line_index}"

        if raw_type == "system":
            self._system(
                row,
                source_line=source_line,
                timestamp=timestamp,
                snapshot=snapshot,
                builder=builder,
            )
            return
        if raw_type == "user":
            self._user(
                row,
                line_index=line_index,
                timestamp=timestamp,
                builder=builder,
                tool_calls=tool_calls,
                tool_results=tool_results,
            )
            return
        if raw_type == "assistant":
            self._assistant(
                row,
                line_index=line_index,
                timestamp=timestamp,
                builder=builder,
                tool_calls=tool_calls,
            )
            return
        builder.add(
            EventKind.META,
            timestamp_utc=timestamp,
            text=None,
            data={"raw_type": raw_type},
            source_ref=source_line,
        )

    def _system(
        self,
        row: dict[str, JsonValue],
        *,
        source_line: str,
        timestamp: str,
        snapshot: SourceSnapshot,
        builder: EventBuilder,
    ) -> None:
        subtype = row.get("subtype")
        if subtype == "init":
            if row.get("uuid") != snapshot.candidate.native_id:
                raise _schema("claude-session-identity")
            builder.add(
                EventKind.SESSION_META,
                timestamp_utc=timestamp,
                text=None,
                data={
                    "git_branch": _string(
                        row.get("gitBranch"), phase="claude-session-meta"
                    ),
                    "harness_version": _string(
                        row.get("version"), phase="claude-session-meta"
                    ),
                    "project": _string(row.get("cwd"), phase="claude-session-meta"),
                },
                source_ref=source_line,
            )
            return
        if subtype == "compact_boundary":
            metadata = _object(row.get("compact_metadata"), phase="claude-compaction")
            builder.add(
                EventKind.COMPACTION,
                timestamp_utc=timestamp,
                text=_string(
                    row.get("content"), phase="claude-compaction", allow_empty=True
                ),
                data={
                    "reason": _string(metadata.get("reason"), phase="claude-compaction")
                },
                source_ref=source_line,
            )
            return
        if subtype == "attachment":
            attachments = _array(row.get("attachments"), phase="claude-attachment")
            if not attachments:
                raise _schema("claude-attachment")
            for index, raw_attachment in enumerate(attachments):
                attachment = _object(raw_attachment, phase="claude-attachment")
                reference = (
                    source_line
                    if len(attachments) == 1
                    else f"{source_line}/attachment:{index}"
                )
                builder.add(
                    EventKind.META,
                    timestamp_utc=timestamp,
                    text=None,
                    data={
                        "file": _string(
                            attachment.get("name"), phase="claude-attachment"
                        ),
                        "meta_type": "attachment",
                    },
                    source_ref=reference,
                )
            return
        raise _schema("claude-system-subtype")

    def _user(
        self,
        row: dict[str, JsonValue],
        *,
        line_index: int,
        timestamp: str,
        builder: EventBuilder,
        tool_calls: set[str],
        tool_results: set[str],
    ) -> None:
        message = _object(row.get("message"), phase="claude-user-message")
        if message.get("role") != "user":
            raise _schema("claude-user-message")
        content = message.get("content")
        if row.get("userType") == "command":
            command = _string(row.get("command"), phase="claude-command")
            if _SKILL(command) is None or content != f"/{command}":
                raise _schema("claude-command")
            builder.add(
                EventKind.SKILL_INVOCATION,
                timestamp_utc=timestamp,
                text=None,
                data={"name": command},
                source_ref=f"line:{line_index}",
            )
            return
        if isinstance(content, str):
            builder.add(
                EventKind.USER_MSG,
                timestamp_utc=timestamp,
                text=content,
                data={"role": "user"},
                source_ref=f"line:{line_index}",
            )
            return
        parts = _array(content, phase="claude-user-message")
        if not parts:
            raise _schema("claude-user-message")
        for content_index, raw_part in enumerate(parts):
            part = _object(raw_part, phase="claude-user-message")
            source_ref = f"line:{line_index}/content:{content_index}"
            part_type = part.get("type")
            if part_type == "text":
                builder.add(
                    EventKind.USER_MSG,
                    timestamp_utc=timestamp,
                    text=_string(
                        part.get("text"),
                        phase="claude-user-message",
                        allow_empty=True,
                    ),
                    data={"role": "user"},
                    source_ref=source_ref,
                )
                continue
            if part_type == "tool_result":
                call_id = _string(part.get("tool_use_id"), phase="claude-tool-result")
                if call_id not in tool_calls or call_id in tool_results:
                    raise _schema("claude-tool-result")
                tool_results.add(call_id)
                result = part.get("content")
                if not isinstance(result, (str, dict, list)):
                    raise _schema("claude-tool-result")
                builder.add(
                    EventKind.TOOL_RESULT,
                    timestamp_utc=timestamp,
                    text=None,
                    data={"call_id": call_id, "result": result},
                    source_ref=source_ref,
                )
                continue
            raise _schema("claude-user-content")

    def _assistant(
        self,
        row: dict[str, JsonValue],
        *,
        line_index: int,
        timestamp: str,
        builder: EventBuilder,
        tool_calls: set[str],
    ) -> None:
        message = _object(row.get("message"), phase="claude-assistant-message")
        if message.get("role") != "assistant":
            raise _schema("claude-assistant-message")
        parts = _array(message.get("content"), phase="claude-assistant-message")
        if not parts:
            raise _schema("claude-assistant-message")
        if row.get("isSidechain") is True:
            agent = _string(row.get("agent"), phase="claude-sidechain")
            text_parts = [
                _string(
                    _object(part, phase="claude-sidechain").get("text"),
                    phase="claude-sidechain",
                    allow_empty=True,
                )
                for part in parts
                if isinstance(part, dict) and part.get("type") == "text"
            ]
            if len(text_parts) != len(parts):
                raise _schema("claude-sidechain")
            builder.add(
                EventKind.SUBAGENT_ACTIVITY,
                timestamp_utc=timestamp,
                text="".join(text_parts),
                data={"agent": agent, "sidechain": True},
                source_ref=f"line:{line_index}",
            )
            return
        if row.get("isSidechain") not in (False, None):
            raise _schema("claude-sidechain")
        model = _string(message.get("model"), phase="claude-assistant-message")
        for content_index, raw_part in enumerate(parts):
            part = _object(raw_part, phase="claude-assistant-message")
            source_ref = f"line:{line_index}/content:{content_index}"
            part_type = part.get("type")
            if part_type == "thinking":
                builder.add(
                    EventKind.REASONING,
                    timestamp_utc=timestamp,
                    text=_string(
                        part.get("thinking"),
                        phase="claude-assistant-message",
                        allow_empty=True,
                    ),
                    data={"model": model},
                    source_ref=source_ref,
                )
                continue
            if part_type == "text":
                builder.add(
                    EventKind.ASSISTANT_MSG,
                    timestamp_utc=timestamp,
                    text=_string(
                        part.get("text"),
                        phase="claude-assistant-message",
                        allow_empty=True,
                    ),
                    data={"model": model, "role": "assistant"},
                    source_ref=source_ref,
                )
                continue
            if part_type == "tool_use":
                call_id = _string(part.get("id"), phase="claude-tool-call")
                name = _string(part.get("name"), phase="claude-tool-call")
                inputs = _object(part.get("input"), phase="claude-tool-call")
                if call_id in tool_calls:
                    raise _schema("claude-tool-call")
                tool_calls.add(call_id)
                builder.add(
                    EventKind.TOOL_CALL,
                    timestamp_utc=timestamp,
                    text=None,
                    data={
                        "call_id": call_id,
                        "input": inputs,
                        "is_mcp": name.startswith("mcp__"),
                        "name": name,
                    },
                    source_ref=source_ref,
                )
                continue
            raise _schema("claude-assistant-content")
        usage_value = message.get("usage")
        if usage_value is not None:
            usage = _object(usage_value, phase="claude-usage")
            allowed = {
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
                "input_tokens",
                "output_tokens",
            }
            if set(usage) != allowed or any(
                isinstance(usage[key], bool)
                or not isinstance(usage[key], int)
                or usage[key] < 0
                for key in allowed
            ):
                raise _schema("claude-usage")
            builder.add(
                EventKind.META,
                timestamp_utc=timestamp,
                text=None,
                data={
                    "meta_type": "usage",
                    "model": model,
                    "source": "claude",
                    "unit": "tokens",
                    "usage": dict(usage),
                },
                source_ref=f"line:{line_index}/usage",
            )
