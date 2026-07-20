"""Deterministic size-reduction and inventory metrics for qSesh sessions."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable

from .errors import QseshError
from .jsonio import dumps_json
from .model import CanonicalEvent, CleanTurn, EventKind, JsonValue

# v2 (2026-07-19, T0-approved locked-semantic change): tool payloads are measured
# as plain text rather than through JSON escaping, so the `line` dimension counts
# the lines a payload actually carries. Values differ from v1 for any session
# containing tool calls or tool results.
METRICS_VERSION = "qsesh-metrics-v2"

# `\w` resolves against the RUNNING interpreter's Unicode database, which this
# constant does not pin: a codepoint assigned in Unicode 16.0 counts as a word
# character on a 16.0 interpreter and as punctuation on a 15.0 one. Measured:
# "\U00010D4A\U00010D4B\U00010D4C" -> py3.14/unidata-16 word=1,token=1 versus
# py3.12/unidata-15 word=0,token=3.
#
# Stdlib offers no way to freeze that table, so counts cannot be made
# version-independent without vendoring one. Instead the version each record was
# counted under travels WITH the record, making a mixed-version corpus detectable
# rather than silently summable. Callers aggregating across hosts must group on
# it. This mitigates the divergence; it does not eliminate it.
UNICODE_VERSION = unicodedata.unidata_version

_WORD_PATTERN = re.compile(r"\w+")
_TOKEN_PATTERN = re.compile(r"\w+|[^\w\s]", re.UNICODE)


def _fail(phase: str) -> QseshError:
    return QseshError("QS-E-DISTILL", phase=phase)


def _zero_counts() -> dict[str, int]:
    return {"char": 0, "line": 0, "word": 0, "token": 0}


def count_text(text: str) -> dict[str, int]:
    return {
        "char": len(text),
        "line": len(text.splitlines()),
        "word": len(_WORD_PATTERN.findall(text)),
        "token": len(_TOKEN_PATTERN.findall(text)),
    }


def _render_session_meta(event: CanonicalEvent) -> str:
    return event.text or ""


def _render_user_msg(event: CanonicalEvent) -> str:
    if event.text is None:
        raise _fail("metrics-render-user-msg")
    return event.text


def _render_assistant_msg(event: CanonicalEvent) -> str:
    if event.text is None:
        raise _fail("metrics-render-assistant-msg")
    return event.text


def _render_reasoning(event: CanonicalEvent) -> str:
    if event.text is None:
        raise _fail("metrics-render-reasoning")
    return event.text


def _json_text(value: JsonValue) -> str:
    """Render a JSON value as plain text, preserving real newlines.

    `dumps_json` escapes embedded newlines into the two-character sequence
    ``\\n``, which `str.splitlines()` never splits — so measuring a tool payload
    through it collapsed every payload to one line and made the `line` reduction
    ratio meaningless. This renders the same content as text so that all four
    content dimensions are measured on the characters the payload actually
    carries.

    Deterministic by construction: mappings emit their keys in sorted order,
    matching `dumps_json(sort_keys=True)`.
    """
    if isinstance(value, str):
        return value
    if value is None or isinstance(value, (bool, int, float)):
        return dumps_json(value)
    if isinstance(value, list):
        return "\n".join(_json_text(item) for item in value)
    if isinstance(value, dict):
        return "\n".join(f"{key}: {_json_text(value[key])}" for key in sorted(value))
    raise _fail("metrics-render-json-text")


def _render_tool_call(event: CanonicalEvent) -> str:
    name = event.data.get("name")
    if not isinstance(name, str):
        raise _fail("metrics-render-tool-call")
    tool_input = event.data.get("input")
    if not isinstance(tool_input, dict):
        raise _fail("metrics-render-tool-call")
    return name + "\n" + _json_text(tool_input)


def _render_tool_result(event: CanonicalEvent) -> str:
    if "result" not in event.data:
        raise _fail("metrics-render-tool-result")
    return _json_text(event.data["result"])


def _render_skill_invocation(event: CanonicalEvent) -> str:
    name = event.data.get("name")
    if not isinstance(name, str) or not name:
        raise _fail("metrics-render-skill-invocation")
    return "invoked /" + name


def _render_subagent_activity(event: CanonicalEvent) -> str:
    agent = event.data.get("agent")
    if not isinstance(agent, str):
        raise _fail("metrics-render-subagent-activity")
    return agent + "\n" + (event.text or "")


def _render_compaction(event: CanonicalEvent) -> str:
    return event.text or ""


def _render_meta(event: CanonicalEvent) -> str:
    return event.text or ""


_RENDERERS: dict[EventKind, Callable[[CanonicalEvent], str]] = {
    EventKind.SESSION_META: _render_session_meta,
    EventKind.USER_MSG: _render_user_msg,
    EventKind.ASSISTANT_MSG: _render_assistant_msg,
    EventKind.REASONING: _render_reasoning,
    EventKind.TOOL_CALL: _render_tool_call,
    EventKind.TOOL_RESULT: _render_tool_result,
    EventKind.SKILL_INVOCATION: _render_skill_invocation,
    EventKind.SUBAGENT_ACTIVITY: _render_subagent_activity,
    EventKind.COMPACTION: _render_compaction,
    EventKind.META: _render_meta,
}


def render_event(event: CanonicalEvent) -> str:
    try:
        renderer = _RENDERERS[event.kind]
    except KeyError:
        raise _fail("metrics-render-kind") from None
    return renderer(event)


def size_metrics(
    events: tuple[CanonicalEvent, ...],
    clean_turns: tuple[CleanTurn, ...],
    raw_source_bytes: bytes,
    gzip_bytes: int,
) -> dict[str, JsonValue]:
    if not isinstance(raw_source_bytes, bytes):
        raise _fail("metrics-raw-source")
    if (
        isinstance(gzip_bytes, bool)
        or not isinstance(gzip_bytes, int)
        or gzip_bytes < 0
    ):
        raise _fail("metrics-raw-source")
    # gzip_bytes is caller-supplied from an archive publication receipt (CQ-11):
    # the metrics layer cannot derive it and must not recompress. It CAN reject a
    # value that is physically impossible for the raw payload beside it — a real
    # gzip stream never exceeds its input by more than framing plus a bounded
    # per-block stored overhead. Anything past that is a bad receipt (the goldens'
    # placeholder 128 against a 0-byte payload was exactly this) and fails closed
    # rather than being written as truth. Upper bound only: a legitimately small
    # compressed size (including 0 for empty input) is never floored.
    gzip_ceiling = len(raw_source_bytes) + (len(raw_source_bytes) >> 10) + 64
    if gzip_bytes > gzip_ceiling:
        raise _fail("metrics-gzip-implausible")

    content_by_kind = {kind.value: _zero_counts() for kind in EventKind}
    content_original = _zero_counts()
    for event in events:
        counts = count_text(render_event(event))
        bucket = content_by_kind[event.kind.value]
        for dimension, value in counts.items():
            bucket[dimension] += value
            content_original[dimension] += value

    content_clean = _zero_counts()
    for turn in clean_turns:
        for dimension, value in count_text(turn.text).items():
            content_clean[dimension] += value

    return {
        "metrics_version": METRICS_VERSION,
        "unicode_version": UNICODE_VERSION,
        "content_original": content_original,
        "content_clean": content_clean,
        "content_by_kind": content_by_kind,
        "raw_source": {
            "bytes": len(raw_source_bytes),
            "gzip_bytes": gzip_bytes,
            "line": len(raw_source_bytes.splitlines()),
        },
    }


def inventory_counts(
    tools: tuple[dict[str, JsonValue], ...],
    skills: tuple[dict[str, JsonValue], ...],
    files: tuple[dict[str, JsonValue], ...],
    subagents: tuple[dict[str, JsonValue], ...],
    compactions: tuple[dict[str, JsonValue], ...],
) -> dict[str, JsonValue]:
    native_unique = native_total = 0
    mcp_unique = mcp_total = 0
    servers: set[str] = set()
    for tool in tools:
        count = tool["count"]
        if tool["is_mcp"] is False:
            native_unique += 1
            native_total += count
        elif tool["is_mcp"] is True:
            mcp_unique += 1
            mcp_total += count
            parts = tool["name"].split("__")
            if len(parts) < 3 or not parts[1] or not parts[2]:
                raise _fail("metrics-mcp-name")
            servers.add(parts[1])
        else:
            raise _fail("metrics-inventory-is-mcp")

    return {
        "metrics_version": METRICS_VERSION,
        "native_tools": {"unique": native_unique, "total": native_total},
        "mcp_tools": {"unique": mcp_unique, "total": mcp_total},
        "mcp_servers": {"unique": len(servers), "total": mcp_total},
        "skills": {
            "unique": len(skills),
            "total": sum(item["count"] for item in skills),
        },
        "subagents": {
            "unique": len(subagents),
            "total": sum(item["count"] for item in subagents),
        },
        "files": {
            "unique": len(files),
            "total": sum(item["count"] for item in files),
        },
        "compactions": {
            "unique": len(compactions),
            "total": sum(item["count"] for item in compactions),
        },
    }
