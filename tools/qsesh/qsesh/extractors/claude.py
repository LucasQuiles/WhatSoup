"""Parse Claude JSONL rows into the shared canonical event vocabulary."""

from __future__ import annotations

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


def _compaction_int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _schema("claude-compaction")
    return value


def _modern_compaction_data(metadata: dict[str, JsonValue]) -> dict[str, JsonValue]:
    """Rich metadata from a modern ``compactMetadata`` (camelCase) object.

    Captures the stable scalar signal -- trigger + token deltas + duration --
    which is what compaction-cost metrics need. The variable nested fields
    (``preservedMessages`` / ``preservedSegment`` / ``preCompactDiscoveredTools``)
    are deliberately not embedded, to keep the canonical event schema-stable as
    the source format evolves (same discipline as unknown usage keys).
    """
    data: dict[str, JsonValue] = {
        "trigger": _string(metadata.get("trigger"), phase="claude-compaction"),
        "pre_tokens": _compaction_int(metadata.get("preTokens")),
        "post_tokens": _compaction_int(metadata.get("postTokens")),
        "duration_ms": _compaction_int(metadata.get("durationMs")),
    }
    if "cumulativeDroppedTokens" in metadata:
        data["cumulative_dropped_tokens"] = _compaction_int(
            metadata.get("cumulativeDroppedTokens")
        )
    return data


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
        # Modern sessions carry no system/init record, so the init handler never
        # emits a SESSION_META. Synthesize one (as the first event) from the
        # session's scattered identity fields so the stream keeps the anchor the
        # distiller requires. Legacy sessions (with init) are left untouched.
        if not self._has_init(rows, snapshot):
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
    def _has_init(
        rows: tuple[dict[str, JsonValue], ...], snapshot: SourceSnapshot
    ) -> bool:
        native_id = snapshot.candidate.native_id
        return any(
            row.get("type") == "system"
            and row.get("subtype") == "init"
            and row.get("uuid") == native_id
            for row in rows
        )

    @staticmethod
    def _synthesize_session_meta(
        rows: tuple[dict[str, JsonValue], ...], builder: EventBuilder
    ) -> None:
        cwds: list[str] = []
        git_branch: str | None = None
        version: str | None = None
        title: str | None = None
        start_ts: str | None = None
        for row in rows:
            cwd = row.get("cwd")
            if isinstance(cwd, str) and cwd and cwd not in cwds:
                cwds.append(cwd)
            if start_ts is None and isinstance(row.get("timestamp"), str):
                try:
                    start_ts = normalize_timestamp(row.get("timestamp"))
                except QseshError:
                    start_ts = None
            if git_branch is None and isinstance(row.get("gitBranch"), str):
                git_branch = row.get("gitBranch")
            if (
                version is None
                and isinstance(row.get("version"), str)
                and row["version"]
            ):
                version = row.get("version")
            if title is None:
                if row.get("type") == "ai-title" and isinstance(
                    row.get("aiTitle"), str
                ):
                    title = row.get("aiTitle")
                elif row.get("type") == "custom-title" and isinstance(
                    row.get("customTitle"), str
                ):
                    title = row.get("customTitle")
        if not cwds:
            raise _schema("claude-session-identity")
        # project = the session's starting directory; cwds = the full ordered
        # trail of directories it touched (sessions routinely span several).
        data: dict[str, JsonValue] = {"project": cwds[0], "cwds": cwds}
        if git_branch is not None:
            data["git_branch"] = git_branch
        if version is not None:
            data["harness_version"] = version
        if title is not None:
            data["title"] = title
        builder.add(
            EventKind.SESSION_META,
            timestamp_utc=start_ts,
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
        if not isinstance(raw_type, str) or _SAFE_KIND(raw_type) is None:
            raise _schema("claude-row-type")
        source_line = f"line:{line_index}"

        # Content records require a timestamp (strict). Non-content control
        # records fall through to META, where an absent timestamp is tolerated
        # (optional_timestamp) so modern sessions -- which interleave untimed
        # mode/last-prompt/permission-mode/ai-title records -- extract cleanly.
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
            text = _string(
                row.get("content"), phase="claude-compaction", allow_empty=True
            )
            modern = row.get("compactMetadata")
            if isinstance(modern, dict):
                data = _modern_compaction_data(modern)
            else:
                # Legacy schema: compact_metadata (snake) with a single reason.
                legacy = _object(row.get("compact_metadata"), phase="claude-compaction")
                data = {
                    "reason": _string(legacy.get("reason"), phase="claude-compaction")
                }
            builder.add(
                EventKind.COMPACTION,
                timestamp_utc=timestamp,
                text=text,
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
        # Unknown system subtype (turn_duration, stop_hook_summary,
        # scheduled_task_fire, model_fallback, ...): fall through to META like an
        # unknown top-level type rather than reject. Record the subtype when it
        # is a safe identifier so inventory can see it.
        builder.add(
            EventKind.META,
            timestamp_utc=timestamp,
            text=None,
            data={
                "raw_type": "system",
                "subtype": (
                    subtype
                    if isinstance(subtype, str) and _SAFE_KIND(subtype) is not None
                    else None
                ),
            },
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
            # `image` blocks carry a base64 payload; record as META with the
            # media type only -- the payload itself is never embedded.
            if part_type == "image":
                source = _object(part.get("source"), phase="claude-image")
                builder.add(
                    EventKind.META,
                    timestamp_utc=timestamp,
                    text=None,
                    data={
                        "meta_type": "image",
                        "media_type": _string(
                            source.get("media_type"), phase="claude-image"
                        ),
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
            # `server_tool_use` (server-side tool calls: advisor, web search) is
            # structurally identical to `tool_use`; model both as TOOL_CALL.
            if part_type in ("tool_use", "server_tool_use"):
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
            # `advisor_tool_result` is the paired result of a `server_tool_use`
            # call; it arrives in a later assistant message. Same pairing
            # discipline as native tool_result (in user messages).
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
            # `fallback` is a model-switch marker (from -> to); record as META.
            if part_type == "fallback":
                from_model = _object(part.get("from"), phase="claude-fallback")
                to_model = _object(part.get("to"), phase="claude-fallback")
                builder.add(
                    EventKind.META,
                    timestamp_utc=timestamp,
                    text=None,
                    data={
                        "meta_type": "model_fallback",
                        "from_model": _string(
                            from_model.get("model"), phase="claude-fallback"
                        ),
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
            allowed = {
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
                "input_tokens",
                "output_tokens",
            }
            # Require and validate the known token counts; tolerate unknown keys
            # (real usage carries cache_creation/service_tier/speed/... and the
            # set keeps growing). Only the known counts enter the canonical event
            # -- unknowns are ignored so output stays stable across versions.
            if not allowed <= set(usage) or any(
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
                    "usage": {key: usage[key] for key in allowed},
                },
                source_ref=f"line:{line_index}/usage",
            )
