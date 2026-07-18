"""T15 single cross-harness distillation policy contracts."""

from __future__ import annotations

import hashlib
import json
import random
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
    assert actual == expected
    assert golden_path.read_text().endswith("\n")
    assert dumps_json(expected) == dumps_json(actual)


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
        ("negative-duration", "distill-timestamp-order"),
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
    elif mutation == "negative-duration":
        events[-1] = replace(events[-1], timestamp_utc="2026-01-02T08:04:04Z")
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
