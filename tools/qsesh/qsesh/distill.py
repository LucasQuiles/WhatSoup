"""Single deterministic canonical-event distillation policy."""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import datetime, timezone

from .errors import QseshError
from .jsonio import dumps_json
from .metrics import inventory_counts, size_metrics
from .model import (
    CleanTurn,
    DistilledSession,
    EventKind,
    ExtractedSession,
    JsonValue,
)
from .qid import compute_identity

_SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}").fullmatch
_EDIT_TOOLS = frozenset({"apply_patch", "edit", "patch", "write"})
_FILE_KEYS = frozenset({"file", "file_path", "path"})


def _fail(phase: str) -> QseshError:
    return QseshError("QS-E-DISTILL", phase=phase)


def _exact_keys(
    value: dict[str, JsonValue],
    required: set[str],
    optional: set[str] | frozenset[str] = frozenset(),
    *,
    phase: str = "distill-event-data",
) -> None:
    keys = set(value)
    if not required <= keys or not keys <= required | optional:
        raise _fail(phase)


def _string(value: object, *, phase: str = "distill-event-data") -> str:
    if not isinstance(value, str) or not value:
        raise _fail(phase)
    return value


def _optional_string(value: object, *, phase: str = "distill-event-data") -> str | None:
    if value is None:
        return None
    return _string(value, phase=phase)


def _timestamp(value: object) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise _fail("distill-timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except (TypeError, ValueError, OverflowError) as error:
        raise _fail("distill-timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise _fail("distill-timestamp")
    timespec = "microseconds" if parsed.microsecond else "seconds"
    if parsed.isoformat(timespec=timespec).replace("+00:00", "Z") != value:
        raise _fail("distill-timestamp")
    return parsed


def _normalize_usage(data: dict[str, JsonValue]) -> dict[str, JsonValue]:
    _exact_keys(
        data,
        {"meta_type", "model", "source", "unit", "usage"},
        {"provider", "scope"},
        phase="distill-metric",
    )
    if data.get("meta_type") != "usage":
        raise _fail("distill-metric")
    values = data.get("usage")
    if not isinstance(values, dict) or not values:
        raise _fail("distill-metric")
    if any(
        not isinstance(key, str)
        or not key
        or isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        for key, value in values.items()
    ):
        raise _fail("distill-metric")
    scope = data.get("scope", "session")
    if scope not in {"message", "session"}:
        raise _fail("distill-metric")
    return {
        "model": _optional_string(data.get("model"), phase="distill-metric"),
        "provider": _optional_string(data.get("provider"), phase="distill-metric"),
        "scope": scope,
        "source": _string(data.get("source"), phase="distill-metric"),
        "unit": _string(data.get("unit"), phase="distill-metric"),
        "values": dict(values),
    }


def _normalize_cost(data: dict[str, JsonValue]) -> dict[str, JsonValue]:
    _exact_keys(
        data,
        {"cost", "meta_type", "model", "source", "unit"},
        {"provider", "scope"},
        phase="distill-metric",
    )
    value = data.get("cost")
    if (
        data.get("meta_type") != "cost"
        or isinstance(value, bool)
        or not isinstance(value, (int, float))
        or value < 0
    ):
        raise _fail("distill-metric")
    scope = data.get("scope", "session")
    if scope not in {"message", "session"}:
        raise _fail("distill-metric")
    return {
        "model": _optional_string(data.get("model"), phase="distill-metric"),
        "provider": _optional_string(data.get("provider"), phase="distill-metric"),
        "scope": scope,
        "source": _string(data.get("source"), phase="distill-metric"),
        "unit": _string(data.get("unit"), phase="distill-metric"),
        "value": value,
    }


def distill(
    extracted: ExtractedSession,
    *,
    source_pointer: str,
    raw_pointer: str,
    gzip_bytes: int,
) -> DistilledSession:
    if not isinstance(extracted, ExtractedSession):
        raise _fail("distill-input")
    if not isinstance(source_pointer, str) or not source_pointer:
        raise _fail("distill-pointer")
    if not isinstance(raw_pointer, str) or not raw_pointer:
        raise _fail("distill-pointer")
    events = extracted.events
    if not events:
        raise _fail("distill-session-meta")
    if [event.event_index for event in events] != list(range(len(events))):
        raise _fail("distill-event-order")
    if len({event.source_ref for event in events}) != len(events):
        raise _fail("distill-event-order")

    session_events = [event for event in events if event.kind is EventKind.SESSION_META]
    if len(session_events) != 1 or events[0] is not session_events[0]:
        raise _fail("distill-session-meta")
    session_data = session_events[0].data
    _exact_keys(
        session_data,
        {"project"},
        {"cwds", "git_branch", "harness_version", "model", "project_id", "title"},
        phase="distill-session-meta",
    )
    project = _string(session_data.get("project"), phase="distill-session-meta")
    # cwds: the ordered trail of working directories the session touched (modern
    # synthesized session-meta). Absent on legacy init-derived meta.
    cwds_value = session_data.get("cwds")
    if cwds_value is None:
        cwds: JsonValue = None
    else:
        if not isinstance(cwds_value, list) or not all(
            isinstance(item, str) and item for item in cwds_value
        ):
            raise _fail("distill-session-meta")
        cwds = list(cwds_value)
    git_branch = _optional_string(
        session_data.get("git_branch"), phase="distill-session-meta"
    )
    title = _optional_string(session_data.get("title"), phase="distill-session-meta")
    metadata_version = _optional_string(
        session_data.get("harness_version"), phase="distill-session-meta"
    )
    snapshot_version = extracted.snapshot.harness_version
    if (
        metadata_version is not None
        and snapshot_version is not None
        and metadata_version != snapshot_version
    ):
        raise _fail("distill-session-meta")
    harness_version = metadata_version or snapshot_version

    # Ordering/duration run over TIMED events only. Non-content records (control
    # metas, and modern synthesized-session-meta prefixes) legitimately carry no
    # timestamp; they must not gate the session clock. The timed subsequence must
    # still be monotonic, and a session with no timestamps at all is degenerate.
    timed = [
        (_timestamp(event.timestamp_utc), event.timestamp_utc)
        for event in events
        if event.timestamp_utc is not None
    ]
    if not timed:
        raise _fail("distill-timestamp")
    # Real session files are NOT strictly chronological (interleaved sidechains,
    # resumes, scheduled fires; 133/163 local sessions have inversions, up to
    # hours). So monotonicity is not required -- the session clock is the min/max
    # of observed timestamps, and duration their difference (never negative).
    earliest, started_at = min(timed, key=lambda item: item[0])
    latest, ended_at = max(timed, key=lambda item: item[0])
    assert started_at is not None and ended_at is not None
    duration = latest - earliest
    duration_us = (
        duration.days * 86_400 + duration.seconds
    ) * 1_000_000 + duration.microseconds

    event_counts: Counter[str] = Counter()
    meta_counts: Counter[str] = Counter()
    models: set[str] = set()
    clean_turns: list[CleanTurn] = []
    calls: dict[str, tuple[str, bool, dict[str, JsonValue]]] = {}
    results: set[str] = set()
    tool_groups: dict[tuple[str, bool], list[str]] = defaultdict(list)
    skill_counts: Counter[str] = Counter()
    subagent_counts: Counter[str] = Counter()
    subagent_sidechains: Counter[str] = Counter()
    file_counts: Counter[str] = Counter()
    compaction_indices: list[int] = []
    compaction_reasons: list[str] = []
    reported_usage: list[dict[str, JsonValue]] = []
    reported_costs: list[dict[str, JsonValue]] = []
    metric_keys: set[str] = set()

    session_model = session_data.get("model")
    if session_model is not None:
        models.add(_string(session_model, phase="distill-session-meta"))

    for event in events:
        event_counts[event.kind.value] += 1
        model = event.data.get("model")
        if model is not None:
            models.add(_string(model))

        if event.kind is EventKind.SESSION_META:
            continue
        if event.kind is EventKind.USER_MSG:
            _exact_keys(event.data, {"role"})
            if event.data.get("role") != "user" or event.text is None:
                raise _fail("distill-event-data")
            clean_turns.append(
                CleanTurn(
                    turn_index=len(clean_turns),
                    role="user",
                    timestamp_utc=event.timestamp_utc,
                    text=event.text,
                )
            )
            continue
        if event.kind is EventKind.ASSISTANT_MSG:
            _exact_keys(event.data, {"role"}, {"model", "provider"})
            if event.data.get("role") != "assistant" or event.text is None:
                raise _fail("distill-event-data")
            _optional_string(event.data.get("provider"))
            clean_turns.append(
                CleanTurn(
                    turn_index=len(clean_turns),
                    role="assistant",
                    timestamp_utc=event.timestamp_utc,
                    text=event.text,
                )
            )
            continue
        if event.kind is EventKind.REASONING:
            _exact_keys(event.data, set(), {"model", "provider"})
            if event.text is None:
                raise _fail("distill-event-data")
            _optional_string(event.data.get("provider"))
            continue
        if event.kind is EventKind.TOOL_CALL:
            _exact_keys(event.data, {"call_id", "input", "is_mcp", "name"})
            call_id = _string(event.data.get("call_id"))
            name = _string(event.data.get("name"))
            inputs = event.data.get("input")
            is_mcp = event.data.get("is_mcp")
            if (
                not isinstance(inputs, dict)
                or not isinstance(is_mcp, bool)
                or call_id in calls
            ):
                raise _fail("distill-tool-link")
            calls[call_id] = (name, is_mcp, inputs)
            tool_groups[(name, is_mcp)].append(call_id)
            if name.casefold() in _EDIT_TOOLS:
                targets = [
                    value
                    for key, value in inputs.items()
                    if key in _FILE_KEYS and isinstance(value, str) and value
                ]
                if len(targets) != 1:
                    raise _fail("distill-file-target")
                file_counts[targets[0]] += 1
            continue
        if event.kind is EventKind.TOOL_RESULT:
            _exact_keys(event.data, {"call_id", "result"})
            call_id = _string(event.data.get("call_id"))
            if call_id not in calls or call_id in results:
                raise _fail("distill-tool-link")
            results.add(call_id)
            continue
        if event.kind is EventKind.SKILL_INVOCATION:
            _exact_keys(event.data, {"name"}, {"role"})
            name = _string(event.data.get("name"))
            if _SAFE_NAME(name) is None:
                raise _fail("distill-event-data")
            role = event.data.get("role", "user")
            if role not in {"assistant", "user"}:
                raise _fail("distill-event-data")
            skill_counts[name] += 1
            clean_turns.append(
                CleanTurn(
                    turn_index=len(clean_turns),
                    role=role,
                    timestamp_utc=event.timestamp_utc,
                    text=f"invoked /{name}",
                )
            )
            continue
        if event.kind is EventKind.SUBAGENT_ACTIVITY:
            _exact_keys(event.data, {"agent"}, {"sidechain"})
            agent = _string(event.data.get("agent"))
            sidechain = event.data.get("sidechain", False)
            if not isinstance(sidechain, bool):
                raise _fail("distill-event-data")
            subagent_counts[agent] += 1
            subagent_sidechains[agent] += int(sidechain)
            continue
        if event.kind is EventKind.COMPACTION:
            if event.text is None:
                raise _fail("distill-event-data")
            if "trigger" in event.data:
                # Modern rich compaction: `trigger` is the reason label; the token
                # deltas (pre/post_tokens, duration_ms, ...) are preserved on the
                # canonical event. Rolling those into the distilled summary is a
                # follow-up; here they are validated and the trigger recorded.
                _exact_keys(
                    event.data,
                    {"trigger", "pre_tokens", "post_tokens", "duration_ms"},
                    {"cumulative_dropped_tokens"},
                )
                compaction_reasons.append(
                    _string(event.data.get("trigger"))
                )
            else:
                _exact_keys(event.data, set(), {"reason"})
                reason = event.data.get("reason")
                if reason is not None:
                    compaction_reasons.append(_string(reason))
            compaction_indices.append(event.event_index)
            continue
        if event.kind is not EventKind.META:
            raise _fail("distill-event-data")

        meta_type = event.data.get("meta_type")
        if meta_type == "usage":
            # No value-dedup: real sessions repeat identical token counts across
            # messages (legitimate), and usage is aggregated (summed) below.
            reported_usage.append(_normalize_usage(event.data))
            meta_counts["usage"] += 1
            continue
        if meta_type == "cost":
            value = _normalize_cost(event.data)
            key = dumps_json(value)
            if key in metric_keys:
                raise _fail("distill-metric")
            metric_keys.add(key)
            reported_costs.append(value)
            meta_counts["cost"] += 1
            continue
        if meta_type == "attachment":
            _exact_keys(event.data, {"file", "meta_type"})
            _string(event.data.get("file"))
            meta_counts["attachment"] += 1
            continue
        if meta_type == "model_fallback":
            _exact_keys(event.data, {"meta_type", "from_model", "to_model"})
            _string(event.data.get("from_model"))
            _string(event.data.get("to_model"))
            meta_counts["model_fallback"] += 1
            continue
        if meta_type == "image":
            _exact_keys(event.data, {"meta_type", "media_type"})
            _string(event.data.get("media_type"))
            meta_counts["image"] += 1
            continue
        # Passthrough metas: unknown top-level types and unknown system subtypes
        # ({raw_type} plus an optional {subtype}). Counted together as "unknown".
        _exact_keys(event.data, {"raw_type"}, {"subtype"})
        _string(event.data.get("raw_type"))
        _optional_string(event.data.get("subtype"))
        meta_counts["unknown"] += 1

    # Every result must reference a real call (no orphan results), but a call
    # MAY be unresolved: real/active sessions legitimately end with a few tool
    # calls whose results aren't written yet (observed at the tail of long
    # sessions). So require results ⊆ calls, not equality.
    if not results <= set(calls):
        raise _fail("distill-tool-link")

    tools = tuple(
        {
            "call_ids": call_ids,
            "count": len(call_ids),
            "is_mcp": is_mcp,
            "name": name,
        }
        for (name, is_mcp), call_ids in sorted(tool_groups.items())
    )
    skills = tuple(
        {"count": count, "name": name} for name, count in sorted(skill_counts.items())
    )
    files = tuple(
        {"count": count, "path": path} for path, count in sorted(file_counts.items())
    )
    subagents = tuple(
        {
            "agent": agent,
            "count": count,
            "sidechain_count": subagent_sidechains[agent],
        }
        for agent, count in sorted(subagent_counts.items())
    )
    compactions: tuple[dict[str, JsonValue], ...] = ()
    if compaction_indices:
        compactions = (
            {
                "count": len(compaction_indices),
                "event_indices": compaction_indices,
                "reasons": compaction_reasons,
            },
        )

    candidate = extracted.snapshot.candidate
    try:
        identity = compute_identity(
            candidate.host_id, candidate.harness.value, candidate.native_id
        )
    except QseshError as error:
        raise _fail("distill-identity") from error
    session_usage = [value for value in reported_usage if value["scope"] == "session"]
    session_costs = [value for value in reported_costs if value["scope"] == "session"]
    # token_totals: session-scope usage SUMMED per token dimension (a single
    # rollup), not a per-message list -- real sessions have hundreds of messages.
    token_totals: JsonValue = None
    if session_usage:
        summed: dict[str, int] = {}
        for value in session_usage:
            for name, count in value["values"].items():
                summed[name] = summed.get(name, 0) + count
        token_totals = dict(sorted(summed.items()))
    clean_user_count = sum(turn.role == "user" for turn in clean_turns)
    clean_assistant_count = sum(turn.role == "assistant" for turn in clean_turns)
    size = size_metrics(
        events, tuple(clean_turns), extracted.snapshot.raw_bytes, gzip_bytes
    )
    inventory = inventory_counts(tools, skills, files, subagents, compactions)
    record: dict[str, JsonValue] = {
        "compaction_count": len(compaction_indices),
        "cost_totals": session_costs or None,
        "cwds": cwds,
        "duration_us": duration_us,
        "ended_at_utc": ended_at,
        "event_counts": dict(sorted(event_counts.items())),
        "file_count": sum(file_counts.values()),
        "git_branch": git_branch,
        "harness": candidate.harness.value,
        "harness_version": harness_version,
        "host_id": candidate.host_id,
        "identity_digest": identity.digest.hex(),
        "inventory_counts": inventory,
        "meta_counts": dict(sorted(meta_counts.items())),
        "models": sorted(models),
        "native_id": candidate.native_id,
        "project": project,
        "qid": identity.qid,
        "raw_pointer": raw_pointer,
        "reported_costs": reported_costs,
        "reported_usage": reported_usage,
        "size_metrics": size,
        "skill_invocation_count": sum(skill_counts.values()),
        "source_digest": extracted.snapshot.source_digest,
        "source_pointer": source_pointer,
        "started_at_utc": started_at,
        "subagent_dispatch_count": sum(subagent_counts.values()),
        "title": title,
        "token_totals": token_totals,
        "tool_call_count": len(calls),
        "tool_result_count": len(results),
        "turn_counts": {
            "assistant": event_counts[EventKind.ASSISTANT_MSG.value],
            "clean": len(clean_turns),
            "clean_assistant": clean_assistant_count,
            "clean_user": clean_user_count,
            "reasoning": event_counts[EventKind.REASONING.value],
            "user": event_counts[EventKind.USER_MSG.value],
        },
    }
    return DistilledSession(
        record=record,
        turns=tuple(clean_turns),
        tools=tools,
        skills=skills,
        files=files,
        subagents=subagents,
        compactions=compactions,
    )
