"""T15 single cross-harness distillation policy contracts."""

from __future__ import annotations

import copy
import hashlib
import json
import random
import unicodedata
from dataclasses import replace
from pathlib import Path

import pytest
from qsesh.distill import distill
from qsesh.errors import QseshError
from qsesh.extractors.claude import ClaudeExtractor
from qsesh.extractors.codex import CodexExtractor
from qsesh.extractors.opencode import OpenCodeExtractor
from qsesh.jsonio import dump_jsonl, dumps_json
from qsesh.model import (
    CanonicalEvent,
    DistilledSession,
    EventKind,
    ExtractedSession,
    Harness,
    SourceCandidate,
    SourceSnapshot,
)

FIXTURES = Path(__file__).parent / "fixtures"
SOURCE_POINTER = "source-pointer-test"
RAW_POINTER = "raw-pointer-test"
_GZIP_BYTES = 128


def _snapshot(
    harness: Harness,
    native_id: str,
    raw: bytes,
    fingerprint: str,
    harness_version: str | None,
) -> SourceSnapshot:
    return SourceSnapshot(
        candidate=SourceCandidate(
            host_id="host-test-001",
            harness=harness,
            native_id=native_id,
            source_key=f"{harness.value}-distill",
            updated_at_us=1,
            file_stamp=None,
        ),
        raw_bytes=raw,
        source_digest=hashlib.blake2b(raw, digest_size=32).hexdigest(),
        schema_fingerprint=fingerprint,
        harness_version=harness_version,
    )


def _opencode_raw() -> bytes:
    exported = json.loads((FIXTURES / "opencode/session.json").read_text())
    rows = [{"kind": "session", "schema_version": 1, "value": exported["info"]}]
    for message_index, message in enumerate(exported["messages"]):
        rows.append(
            {
                "kind": "message",
                "message_index": message_index,
                "schema_version": 1,
                "value": message["info"],
            }
        )
        rows.extend(
            {
                "kind": "part",
                "message_index": message_index,
                "part_index": part_index,
                "schema_version": 1,
                "value": part,
            }
            for part_index, part in enumerate(message["parts"])
        )
    return dump_jsonl(rows)


def _cases() -> dict[str, ExtractedSession]:
    claude_raw = (FIXTURES / "claude/session.json").read_bytes()
    codex_raw = (FIXTURES / "codex/session.json").read_bytes()
    open_raw = _opencode_raw()
    return {
        "claude": ClaudeExtractor().extract(
            _snapshot(
                Harness.CLAUDE,
                "session-claude-001",
                claude_raw,
                "unclassified-jsonl-v1",
                None,
            )
        ),
        "codex": CodexExtractor().extract(
            _snapshot(
                Harness.CODEX,
                "session-codex-001",
                codex_raw,
                "unclassified-jsonl-v1",
                None,
            )
        ),
        "opencode": OpenCodeExtractor().extract(
            _snapshot(
                Harness.OPENCODE,
                "ses_opencode_001",
                open_raw,
                "opencode-export-jsonl-v1",
                "1.17.15",
            )
        ),
    }


def _distilled(extracted: ExtractedSession) -> DistilledSession:
    return distill(
        extracted,
        source_pointer=SOURCE_POINTER,
        raw_pointer=RAW_POINTER,
        gzip_bytes=_GZIP_BYTES,
    )


def _document(value: DistilledSession) -> dict[str, object]:
    return {
        "compactions": list(value.compactions),
        "files": list(value.files),
        "record": value.record,
        "skills": list(value.skills),
        "subagents": list(value.subagents),
        "tools": list(value.tools),
        "turns": [
            {
                "role": turn.role,
                "text": turn.text,
                "timestamp_utc": turn.timestamp_utc,
                "turn_index": turn.turn_index,
            }
            for turn in value.turns
        ],
    }


@pytest.mark.parametrize("harness", ["claude", "codex", "opencode"])
def test_each_harness_matches_its_independently_authored_distilled_golden(
    harness: str,
) -> None:
    actual = _document(_distilled(_cases()[harness]))
    golden_path = FIXTURES / harness / "distilled.json"
    expected = json.loads(golden_path.read_text())

    # `unicode_version` reports the interpreter's Unicode database and is
    # runtime-dependent BY DESIGN (py3.12 -> 15.0.0, py3.14 -> 16.0.0), so it
    # cannot be pinned by a golden that must match on both. Drop it from BOTH
    # sides — never from one — and assert it separately below.
    actual_cmp = copy.deepcopy(actual)
    expected_cmp = copy.deepcopy(expected)
    actual_cmp["record"]["size_metrics"].pop("unicode_version")
    expected_cmp["record"]["size_metrics"].pop("unicode_version")

    assert actual_cmp == expected_cmp
    assert golden_path.read_text().endswith("\n")
    assert dumps_json(expected_cmp) == dumps_json(actual_cmp)

    # The excluded field still has to be right, just not golden-pinned.
    assert actual["record"]["size_metrics"]["unicode_version"] == (
        unicodedata.unidata_version
    )


@pytest.mark.parametrize("harness", ["claude", "codex", "opencode"])
def test_size_and_inventory_metrics_are_wired_into_the_record(harness: str) -> None:
    extracted = _cases()[harness]
    result = _distilled(extracted)
    record = result.record

    size = record["size_metrics"]
    inventory = record["inventory_counts"]
    assert isinstance(size, dict)
    assert isinstance(inventory, dict)
    assert size["metrics_version"] == "qsesh-metrics-v2"
    assert inventory["metrics_version"] == "qsesh-metrics-v2"
    assert size["metrics_version"] == inventory["metrics_version"]

    assert (
        inventory["native_tools"]["total"] + inventory["mcp_tools"]["total"]
        == record["tool_call_count"]
    )

    for dimension in ("char", "line", "word", "token"):
        assert size["content_original"][dimension] == sum(
            kind_counts[dimension] for kind_counts in size["content_by_kind"].values()
        )

    assert size["raw_source"]["gzip_bytes"] == _GZIP_BYTES
    assert size["raw_source"]["bytes"] == len(extracted.snapshot.raw_bytes)

    new_keys = {"size_metrics", "inventory_counts"}
    live = {key: value for key, value in record.items() if key not in new_keys}
    golden_record = json.loads((FIXTURES / harness / "distilled.json").read_text())[
        "record"
    ]
    golden = {key: value for key, value in golden_record.items() if key not in new_keys}
    assert live == golden

    assert not hasattr(result, "size_metrics")
    assert not hasattr(result, "inventory_counts")


@pytest.mark.parametrize("harness", ["claude", "codex", "opencode"])
def test_clean_transcript_is_only_main_prose_plus_collapsed_skill_marker(
    harness: str,
) -> None:
    turns = _distilled(_cases()[harness]).turns
    assert [(turn.role, turn.text) for turn in turns] == [
        ("user", "USER_ALPHA"),
        ("assistant", "ASSISTANT_BETA"),
        ("user", "invoked /brainstorming"),
    ]
    assert [turn.turn_index for turn in turns] == [0, 1, 2]


def test_reasoning_subagent_tool_attachment_and_meta_content_never_leak_into_turns() -> (
    None
):
    extracted = _cases()["claude"]
    replacements = {
        EventKind.REASONING: "REASONING_SECRET",
        EventKind.SUBAGENT_ACTIVITY: "SUBAGENT_SECRET",
        EventKind.COMPACTION: "COMPACTION_SECRET",
    }
    events = []
    for event in extracted.events:
        data = dict(event.data)
        text = replacements.get(event.kind, event.text)
        if event.kind is EventKind.TOOL_RESULT:
            data["result"] = "TOOL_RESULT_SECRET"
        if data.get("meta_type") == "attachment":
            data["file"] = "ATTACHMENT_SECRET"
        events.append(replace(event, data=data, text=text))
    result = _distilled(replace(extracted, events=tuple(events)))
    rendered = dumps_json(_document(result))
    for forbidden in (
        "REASONING_SECRET",
        "SUBAGENT_SECRET",
        "COMPACTION_SECRET",
        "TOOL_RESULT_SECRET",
        "ATTACHMENT_SECRET",
    ):
        assert forbidden not in dumps_json(
            [
                {
                    "role": turn.role,
                    "text": turn.text,
                    "timestamp": turn.timestamp_utc,
                }
                for turn in result.turns
            ]
        )
    assert RAW_POINTER in rendered


@pytest.mark.parametrize("harness", ["claude", "codex", "opencode"])
def test_inventories_and_record_counts_reconcile_every_stripped_kind(
    harness: str,
) -> None:
    result = _distilled(_cases()[harness])
    assert result.tools[0]["count"] == 1
    assert result.tools[0]["is_mcp"] is True
    assert result.skills == ({"count": 1, "name": "brainstorming"},)
    assert result.files == ()
    assert result.subagents[0]["agent"] == "fixture-agent"
    assert result.subagents[0]["count"] == 1
    assert result.compactions[0]["count"] == 1
    assert result.record["event_counts"]["reasoning"] == 1
    assert result.record["event_counts"]["tool_result"] == 1
    assert result.record["meta_counts"]["attachment"] == 1
    assert result.record["meta_counts"]["unknown"] == 1
    assert sum(result.record["event_counts"].values()) == len(_cases()[harness].events)


def test_edit_write_patch_targets_are_the_only_file_inventory_sources() -> None:
    extracted = _cases()["codex"]
    events = list(extracted.events)
    tool_index = next(
        index for index, event in enumerate(events) if event.kind is EventKind.TOOL_CALL
    )
    tool = events[tool_index]
    events[tool_index] = replace(
        tool,
        data={
            "call_id": tool.data["call_id"],
            "input": {"file_path": "src/example.py"},
            "is_mcp": False,
            "name": "Edit",
        },
    )
    result = _distilled(replace(extracted, events=tuple(events)))
    assert result.files == ({"count": 1, "path": "src/example.py"},)


@pytest.mark.parametrize("inputs", [{}, {"file": "a", "path": "b"}])
def test_editing_tool_requires_exactly_one_recognized_file_target(
    inputs: dict[str, object],
) -> None:
    extracted = _cases()["codex"]
    events = list(extracted.events)
    index = next(
        index for index, event in enumerate(events) if event.kind is EventKind.TOOL_CALL
    )
    data = dict(events[index].data)
    data.update({"input": inputs, "is_mcp": False, "name": "Write"})
    events[index] = replace(events[index], data=data)
    with pytest.raises(QseshError) as caught:
        _distilled(replace(extracted, events=tuple(events)))
    assert caught.value.code == "QS-E-DISTILL"
    assert caught.value.phase == "distill-file-target"


def test_models_and_reported_metrics_are_truthful_without_cross_scope_double_count() -> (
    None
):
    results = {name: _distilled(value) for name, value in _cases().items()}
    assert all(
        value.record["models"] == ["fixture-model"] for value in results.values()
    )
    assert len(results["claude"].record["reported_usage"]) == 1
    assert results["codex"].record["reported_usage"] == []
    assert results["codex"].record["token_totals"] is None
    assert len(results["opencode"].record["reported_usage"]) == 2
    assert len(results["opencode"].record["token_totals"]) == 1
    assert results["opencode"].record["token_totals"][0]["scope"] == "session"
    assert len(results["opencode"].record["reported_costs"]) == 2
    assert len(results["opencode"].record["cost_totals"]) == 1
    assert all(
        value["unit"] != "usd" for value in results["opencode"].record["reported_costs"]
    )


def test_source_and_raw_pointers_are_consumed_exactly_not_derived_as_paths() -> None:
    record = _distilled(_cases()["codex"]).record
    assert record["source_pointer"] == SOURCE_POINTER
    assert record["raw_pointer"] == RAW_POINTER
    assert "/" not in record["source_pointer"]
    assert "/" not in record["raw_pointer"]
    for source_pointer, raw_pointer in (("", RAW_POINTER), (SOURCE_POINTER, "")):
        with pytest.raises(QseshError) as caught:
            distill(
                _cases()["codex"],
                source_pointer=source_pointer,
                raw_pointer=raw_pointer,
                gzip_bytes=_GZIP_BYTES,
            )
        assert caught.value.code == "QS-E-DISTILL"
        assert caught.value.phase == "distill-pointer"


def _reindex(events: list[CanonicalEvent]) -> tuple[CanonicalEvent, ...]:
    return tuple(
        replace(event, event_index=index) for index, event in enumerate(events)
    )


@pytest.mark.parametrize(
    ("mutation", "phase"),
    [
        ("missing-session", "distill-session-meta"),
        ("duplicate-session", "distill-session-meta"),
        ("missing-project", "distill-session-meta"),
        ("version-mismatch", "distill-session-meta"),
        ("duplicate-source-ref", "distill-event-order"),
        ("duplicate-call", "distill-tool-link"),
        ("unknown-result", "distill-tool-link"),
        ("missing-result", "distill-tool-link"),
        ("duplicate-result", "distill-tool-link"),
        ("negative-count", "distill-event-data"),
        ("duplicate-metric", "distill-metric"),
    ],
)
def test_invalid_canonical_invariants_fail_as_one_typed_distill_error(
    mutation: str, phase: str
) -> None:
    extracted = _cases()["claude"]
    events = list(extracted.events)
    if mutation == "missing-session":
        events.pop(0)
    elif mutation == "duplicate-session":
        events.insert(1, replace(events[0], source_ref="duplicate-session"))
    elif mutation == "missing-project":
        events[0] = replace(events[0], data={"git_branch": "fixture-branch"})
    elif mutation == "version-mismatch":
        malformed = replace(
            extracted,
            snapshot=replace(extracted.snapshot, harness_version="other"),
        )
        with pytest.raises(QseshError) as caught:
            _distilled(malformed)
        assert caught.value.code == "QS-E-DISTILL"
        assert caught.value.phase == phase
        return
    elif mutation == "duplicate-source-ref":
        events[1] = replace(events[1], source_ref=events[0].source_ref)
    elif mutation == "duplicate-call":
        skill_index = next(
            index
            for index, event in enumerate(events)
            if event.kind is EventKind.SKILL_INVOCATION
        )
        call = next(event for event in events if event.kind is EventKind.TOOL_CALL)
        events[skill_index] = replace(
            call,
            event_index=skill_index,
            source_ref=events[skill_index].source_ref,
            timestamp_utc=events[skill_index].timestamp_utc,
        )
    elif mutation == "unknown-result":
        result_index = next(
            index
            for index, event in enumerate(events)
            if event.kind is EventKind.TOOL_RESULT
        )
        events[result_index] = replace(
            events[result_index], data={"call_id": "unknown", "result": "x"}
        )
    elif mutation == "missing-result":
        events = [event for event in events if event.kind is not EventKind.TOOL_RESULT]
    elif mutation == "duplicate-result":
        result = next(event for event in events if event.kind is EventKind.TOOL_RESULT)
        events.insert(
            result.event_index + 1,
            replace(result, source_ref=f"{result.source_ref}/duplicate"),
        )
    elif mutation == "negative-count":
        call_index = next(
            index
            for index, event in enumerate(events)
            if event.kind is EventKind.TOOL_CALL
        )
        data = dict(events[call_index].data)
        data["count"] = -1
        events[call_index] = replace(events[call_index], data=data)
    else:
        metric = next(
            event for event in events if event.data.get("meta_type") == "usage"
        )
        events.insert(
            metric.event_index + 1,
            replace(metric, source_ref=f"{metric.source_ref}/duplicate"),
        )
    malformed = replace(extracted, events=_reindex(events))
    with pytest.raises(QseshError) as caught:
        _distilled(malformed)
    assert caught.value.code == "QS-E-DISTILL"
    assert caught.value.phase == phase
    assert "USER_ALPHA" not in str(caught.value)


def test_valid_inversion_derives_start_end_duration_from_min_max_observations() -> None:
    # Append-ordered sessions can legitimately carry a later event bearing an
    # earlier timestamp; the session clock envelope is min/max over timed
    # observations, and canonical source order must survive untouched.
    extracted = _cases()["claude"]
    baseline = _distilled(extracted)
    events = list(extracted.events)
    events[-1] = replace(events[-1], timestamp_utc="2026-01-02T08:04:04Z")

    result = _distilled(replace(extracted, events=tuple(events)))

    assert result.record["started_at_utc"] == "2026-01-02T08:04:04Z"
    assert result.record["ended_at_utc"] == "2026-01-02T08:04:12Z"
    assert result.record["duration_us"] == 8_000_000
    envelope = {"started_at_utc", "ended_at_utc", "duration_us"}
    assert {k: v for k, v in result.record.items() if k not in envelope} == {
        k: v for k, v in baseline.record.items() if k not in envelope
    }
    assert result.turns == baseline.turns
    assert result.tools == baseline.tools


def test_subsecond_adjacent_inversion_inside_the_envelope_changes_nothing() -> None:
    extracted = _cases()["claude"]
    baseline = _distilled(extracted)
    events = list(extracted.events)
    result_index = next(
        index
        for index, event in enumerate(events)
        if event.kind is EventKind.TOOL_RESULT
    )
    events[result_index] = replace(
        events[result_index], timestamp_utc="2026-01-02T08:04:06.500000Z"
    )

    result = _distilled(replace(extracted, events=tuple(events)))

    assert result.record == baseline.record
    assert result.turns == baseline.turns
    assert result.tools == baseline.tools


def test_reordered_event_data_is_stable_but_reordered_events_are_rejected() -> None:
    extracted = _cases()["opencode"]
    reversed_data = tuple(
        replace(event, data=dict(reversed(tuple(event.data.items()))))
        for event in extracted.events
    )
    assert _distilled(replace(extracted, events=reversed_data)) == _distilled(extracted)

    shuffled = list(extracted.events)
    random.Random(20260717).shuffle(shuffled)
    malformed = replace(extracted, events=tuple(extracted.events))
    object.__setattr__(malformed, "events", tuple(shuffled))
    with pytest.raises(QseshError) as caught:
        _distilled(malformed)
    assert caught.value.code == "QS-E-DISTILL"
    assert caught.value.phase == "distill-event-order"


def test_distiller_has_one_event_dispatcher_and_no_harness_policy_branch() -> None:
    source = (Path(__file__).parents[1] / "qsesh/distill.py").read_text()
    assert "EventKind" in source
    assert "Harness." not in source
    assert "if harness" not in source
    assert "match harness" not in source
    assert "qsesh.extractors" not in source
    assert "qsesh.store" not in source
    assert "qsesh.archive" not in source


def test_modern_claude_distills_without_widening_record_contract() -> None:
    rows = [
        {
            "type": "mode",
            "mode": "normal",
            "sessionId": "modern-session-001",
        },
        {
            "type": "user",
            "cwd": "project-modern",
            "gitBranch": "main",
            "sessionId": "modern-session-001",
            "timestamp": "2026-01-02T08:05:00Z",
            "uuid": "modern-user-001",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": "AAAA",
                        },
                    },
                    {"type": "text", "text": "USER_MODERN"},
                ],
            },
        },
        {
            "type": "assistant",
            "cwd": "project-modern",
            "sessionId": "modern-session-001",
            "timestamp": "2026-01-02T08:05:01Z",
            "uuid": "modern-assistant-001",
            "isSidechain": False,
            "message": {
                "role": "assistant",
                "model": "fixture-model",
                "usage": {
                    "cache_creation_input_tokens": 1,
                    "cache_read_input_tokens": 2,
                    "input_tokens": 3,
                    "output_tokens": 4,
                    "service_tier": "standard",
                },
                "content": [
                    {"type": "text", "text": "ASSISTANT_MODERN"},
                    {
                        "type": "fallback",
                        "from": {"model": "fixture-old"},
                        "to": {"model": "fixture-new"},
                    },
                ],
            },
        },
        {
            "type": "system",
            "subtype": "turn_duration",
            "timestamp": "2026-01-02T08:05:02Z",
        },
        {
            "type": "system",
            "subtype": "compact_boundary",
            "timestamp": "2026-01-02T08:05:03Z",
            "content": "Conversation compacted",
            "compactMetadata": {
                "trigger": "manual",
                "preTokens": 100,
                "postTokens": 10,
                "durationMs": 5,
            },
        },
        {
            "type": "ai-title",
            "aiTitle": "Modern Session",
            "sessionId": "modern-session-001",
        },
    ]
    raw = dump_jsonl(rows)
    extracted = ClaudeExtractor().extract(
        _snapshot(
            Harness.CLAUDE,
            "modern-session-001",
            raw,
            "unclassified-jsonl-v1",
            None,
        )
    )
    result = _distilled(extracted)
    legacy_record = _distilled(_cases()["claude"]).record

    assert set(result.record) == set(legacy_record)
    assert "cwds" not in result.record
    assert result.record["project"] == "project-modern"
    assert result.record["title"] == "Modern Session"
    assert result.record["token_totals"] == [
        {
            "model": "fixture-model",
            "provider": None,
            "scope": "session",
            "source": "claude",
            "unit": "tokens",
            "values": {
                "cache_creation_input_tokens": 1,
                "cache_read_input_tokens": 2,
                "input_tokens": 3,
                "output_tokens": 4,
            },
        }
    ]
    assert result.record["meta_counts"] == {
        "image": 1,
        "model_fallback": 1,
        "unknown": 3,
        "usage": 1,
    }
    assert result.compactions[0]["reasons"] == ["manual"]


def test_modern_session_meta_uses_first_timed_source_row_without_reversing_order() -> (
    None
):
    rows = [
        {
            "type": "system",
            "subtype": "attachment",
            "sessionId": "modern-session-001",
            "timestamp": "2026-01-02T08:04:59Z",
            "attachments": [{"name": "before.txt"}],
        },
        {
            "type": "user",
            "cwd": "project-modern",
            "sessionId": "modern-session-001",
            "timestamp": "2026-01-02T08:05:00Z",
            "uuid": "modern-user-001",
            "message": {"role": "user", "content": "USER_MODERN"},
        },
        {
            "type": "assistant",
            "cwd": "project-modern",
            "sessionId": "modern-session-001",
            "timestamp": "2026-01-02T08:05:01Z",
            "uuid": "modern-assistant-001",
            "isSidechain": False,
            "message": {
                "role": "assistant",
                "model": "fixture-model",
                "content": [{"type": "text", "text": "ASSISTANT_MODERN"}],
            },
        },
    ]
    raw = dump_jsonl(rows)
    extracted = ClaudeExtractor().extract(
        _snapshot(
            Harness.CLAUDE,
            "modern-session-001",
            raw,
            "unclassified-jsonl-v1",
            None,
        )
    )

    result = _distilled(extracted)

    assert extracted.events[0].timestamp_utc == "2026-01-02T08:04:59Z"
    assert result.record["started_at_utc"] == "2026-01-02T08:04:59Z"
