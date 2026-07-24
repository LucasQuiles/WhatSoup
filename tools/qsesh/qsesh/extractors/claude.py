"""Parse Claude JSONL rows into the shared canonical event vocabulary."""

from __future__ import annotations

import base64
import binascii
import re
from types import MappingProxyType

from qsesh.errors import QseshError
from qsesh.model import EventKind, ExtractedSession, Harness, JsonValue, SourceSnapshot

from .base import (
    EventBuilder,
    normalize_timestamp,
    optional_timestamp,
    parse_jsonl_objects,
)

CLAUDE_SNAPSHOT_FINGERPRINT = "unclassified-jsonl-v1"
CLAUDE_OBSERVED_SCHEMA_FINGERPRINT = (
    "3b974511186301c11dd9c67a724b8e83fc6b4a42f9fb1029c0dd9b9b1603eaf3"
)
ACCEPTED_CLAUDE_FINGERPRINTS = MappingProxyType(
    {CLAUDE_SNAPSHOT_FINGERPRINT: CLAUDE_OBSERVED_SCHEMA_FINGERPRINT}
)

_SAFE_KIND = re.compile(r"[A-Za-z][A-Za-z0-9._-]{0,63}").fullmatch
_SKILL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}").fullmatch
_IMAGE_MEDIA_TYPE = re.compile(r"image/[A-Za-z0-9][A-Za-z0-9.+-]{0,63}").fullmatch
CLAUDE_OBSERVED_MODERN_CONTROL_TYPES = frozenset(
    {
        "agent-name",
        "ai-title",
        "attachment",
        "custom-title",
        "last-prompt",
        "mode",
        "permission-mode",
        "pr-link",
        "queue-operation",
        "relocated",
        "worktree-state",
    }
)
CLAUDE_OBSERVED_MODERN_SYSTEM_SUBTYPES = frozenset(
    {
        "agents_killed",
        "informational",
        "local_command",
        "model_consent_fallback",
        "model_fallback",
        "model_refusal_fallback",
        "model_refusal_no_fallback",
        "scheduled_task_fire",
        "stop_hook_summary",
        "turn_duration",
    }
)
CLAUDE_SANITIZED_FIXTURE_CONTROL_TYPES = frozenset({"fixture_unknown"})
CLAUDE_ACCEPTED_CONTROL_TYPES = (
    CLAUDE_OBSERVED_MODERN_CONTROL_TYPES | CLAUDE_SANITIZED_FIXTURE_CONTROL_TYPES
)
_USAGE_KEYS = (
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "input_tokens",
    "output_tokens",
)


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


def _nonnegative_int(value: object, *, phase: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _schema(phase)
    return value


def _modern_compaction_data(
    metadata: dict[str, JsonValue],
) -> dict[str, JsonValue]:
    data: dict[str, JsonValue] = {
        "duration_ms": _nonnegative_int(
            metadata.get("durationMs"), phase="claude-compaction"
        ),
        "post_tokens": _nonnegative_int(
            metadata.get("postTokens"), phase="claude-compaction"
        ),
        "pre_tokens": _nonnegative_int(
            metadata.get("preTokens"), phase="claude-compaction"
        ),
        "trigger": _string(metadata.get("trigger"), phase="claude-compaction"),
    }
    if "cumulativeDroppedTokens" in metadata:
        data["cumulative_dropped_tokens"] = _nonnegative_int(
            metadata.get("cumulativeDroppedTokens"),
            phase="claude-compaction",
        )
    return data


def _image_media_type(source_value: object) -> str:
    source = _object(source_value, phase="claude-image")
    if source.get("type") != "base64":
        raise _schema("claude-image")
    media_type = _string(source.get("media_type"), phase="claude-image")
    if _IMAGE_MEDIA_TYPE(media_type) is None:
        raise _schema("claude-image")
    payload = _string(source.get("data"), phase="claude-image")
    try:
        encoded = payload.encode("ascii")
        base64.b64decode(encoded, validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as error:
        raise _schema("claude-image") from error
    return media_type


class ClaudeExtractor:
    def extract(self, snapshot: SourceSnapshot) -> ExtractedSession:
        if snapshot.candidate.harness is not Harness.CLAUDE:
            raise _schema("claude-harness")
        if snapshot.schema_fingerprint not in ACCEPTED_CLAUDE_FINGERPRINTS:
            raise _schema("claude-schema-fingerprint")
        rows = parse_jsonl_objects(snapshot)
        has_init = self._has_init(rows)
        self._validate_session_ids(
            rows, snapshot, require_content_identity=not has_init
        )
        builder = EventBuilder()
        tool_calls: set[str] = set()
        tool_results: set[str] = set()
        if not has_init:
            self._synthesize_session_meta(rows, builder)
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

    @staticmethod
    def _validate_session_ids(
        rows: tuple[dict[str, JsonValue], ...],
        snapshot: SourceSnapshot,
        *,
        require_content_identity: bool,
    ) -> None:
        native_id = snapshot.candidate.native_id
        for row in rows:
            if (
                require_content_identity
                and row.get("type") in {"user", "assistant"}
                and "sessionId" not in row
            ):
                raise _schema("claude-session-identity")
            if "sessionId" not in row:
                continue
            session_id = row.get("sessionId")
            if (
                not isinstance(session_id, str)
                or not session_id
                or session_id != native_id
            ):
                raise _schema("claude-session-identity")

    @staticmethod
    def _has_init(rows: tuple[dict[str, JsonValue], ...]) -> bool:
        return any(
            row.get("type") == "system" and row.get("subtype") == "init" for row in rows
        )

    @staticmethod
    def _synthesize_session_meta(
        rows: tuple[dict[str, JsonValue], ...],
        builder: EventBuilder,
    ) -> None:
        content_rows = [row for row in rows if row.get("type") in {"user", "assistant"}]
        if not content_rows:
            raise _schema("claude-session-meta")
        project_value = next(
            (
                row.get("cwd")
                for row in content_rows
                if isinstance(row.get("cwd"), str) and row.get("cwd")
            ),
            None,
        )
        project = _string(project_value, phase="claude-session-meta")
        timestamp = next(
            normalize_timestamp(row.get("timestamp"))
            for row in rows
            if row.get("timestamp") is not None
        )
        data: dict[str, JsonValue] = {"project": project}

        for source_key, target_key in (
            ("gitBranch", "git_branch"),
            ("version", "harness_version"),
        ):
            values = [row[source_key] for row in rows if source_key in row]
            if values:
                data[target_key] = _string(
                    values[0],
                    phase="claude-session-meta",
                )

        titles = [
            row.get("aiTitle")
            for row in rows
            if row.get("type") == "ai-title" and "aiTitle" in row
        ]
        titles.extend(
            row.get("customTitle")
            for row in rows
            if row.get("type") == "custom-title" and "customTitle" in row
        )
        if titles:
            data["title"] = _string(titles[0], phase="claude-session-meta")

        builder.add(
            EventKind.SESSION_META,
            timestamp_utc=timestamp,
            text=None,
            data=data,
            source_ref="synthetic:session",
        )

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
        if (
            not isinstance(raw_type, str)
            or _SAFE_KIND(raw_type) is None
            or raw_type
            not in {"assistant", "system", "user"} | CLAUDE_ACCEPTED_CONTROL_TYPES
        ):
            raise _schema("claude-row-type")
        source_line = f"line:{line_index}"

        if raw_type == "system":
            self._system(
                row,
                source_line=source_line,
                timestamp=normalize_timestamp(row.get("timestamp")),
                snapshot=snapshot,
                builder=builder,
            )
            return
        if raw_type == "user":
            self._user(
                row,
                line_index=line_index,
                timestamp=normalize_timestamp(row.get("timestamp")),
                builder=builder,
                tool_calls=tool_calls,
                tool_results=tool_results,
            )
            return
        if raw_type == "assistant":
            self._assistant(
                row,
                line_index=line_index,
                timestamp=normalize_timestamp(row.get("timestamp")),
                builder=builder,
                tool_calls=tool_calls,
                tool_results=tool_results,
            )
            return
        builder.add(
            EventKind.META,
            timestamp_utc=optional_timestamp(row.get("timestamp")),
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
            modern = row.get("compactMetadata")
            if modern is not None:
                data = _modern_compaction_data(
                    _object(modern, phase="claude-compaction")
                )
            else:
                metadata = _object(
                    row.get("compact_metadata"), phase="claude-compaction"
                )
                data = {
                    "reason": _string(metadata.get("reason"), phase="claude-compaction")
                }
            builder.add(
                EventKind.COMPACTION,
                timestamp_utc=timestamp,
                text=_string(
                    row.get("content"), phase="claude-compaction", allow_empty=True
                ),
                data=data,
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
        if (
            not isinstance(subtype, str)
            or _SAFE_KIND(subtype) is None
            or subtype not in CLAUDE_OBSERVED_MODERN_SYSTEM_SUBTYPES
        ):
            raise _schema("claude-system-subtype")
        builder.add(
            EventKind.META,
            timestamp_utc=timestamp,
            text=None,
            data={"raw_type": "system", "subtype": subtype},
            source_ref=source_line,
        )

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
            if part_type == "image":
                builder.add(
                    EventKind.META,
                    timestamp_utc=timestamp,
                    text=None,
                    data={
                        "media_type": _image_media_type(part.get("source")),
                        "meta_type": "image",
                    },
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
        tool_results: set[str],
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
            if part_type in {"server_tool_use", "tool_use"}:
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
            if part_type == "advisor_tool_result":
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
            if part_type == "fallback":
                from_model = _object(part.get("from"), phase="claude-fallback")
                to_model = _object(part.get("to"), phase="claude-fallback")
                builder.add(
                    EventKind.META,
                    timestamp_utc=timestamp,
                    text=None,
                    data={
                        "from_model": _string(
                            from_model.get("model"), phase="claude-fallback"
                        ),
                        "meta_type": "model_fallback",
                        "to_model": _string(
                            to_model.get("model"), phase="claude-fallback"
                        ),
                    },
                    source_ref=source_ref,
                )
                continue
            raise _schema("claude-assistant-content")
        usage_value = message.get("usage")
        if usage_value is not None:
            usage = _object(usage_value, phase="claude-usage")
            if not set(_USAGE_KEYS) <= set(usage) or any(
                isinstance(usage[key], bool)
                or not isinstance(usage[key], int)
                or usage[key] < 0
                for key in _USAGE_KEYS
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
                    "usage": {key: usage[key] for key in _USAGE_KEYS},
                },
                source_ref=f"line:{line_index}/usage",
            )
