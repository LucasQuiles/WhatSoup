"""T12 Claude parse-only extractor contracts."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path

import pytest
from qsesh.errors import QseshError
from qsesh.jsonio import dump_jsonl
from qsesh.model import Harness, SourceCandidate, SourceSnapshot
from qsesh.extractors.base import normalize_timestamp
from qsesh.extractors.claude import (
    CLAUDE_OBSERVED_SCHEMA_FINGERPRINT,
    CLAUDE_SNAPSHOT_FINGERPRINT,
    ClaudeExtractor,
)

FIXTURES = Path(__file__).parent / "fixtures/claude"
SESSION = FIXTURES / "session.json"
GOLDEN = FIXTURES / "canonical-events.jsonl"


def _snapshot(
    raw: bytes | None = None, *, fingerprint: str = CLAUDE_SNAPSHOT_FINGERPRINT
) -> SourceSnapshot:
    payload = SESSION.read_bytes() if raw is None else raw
    return SourceSnapshot(
        candidate=SourceCandidate(
            host_id="host-test-001",
            harness=Harness.CLAUDE,
            native_id="session-claude-001",
            source_key="claude-fixture",
            updated_at_us=1,
            file_stamp=None,
        ),
        raw_bytes=payload,
        source_digest=hashlib.blake2b(payload, digest_size=32).hexdigest(),
        schema_fingerprint=fingerprint,
        harness_version=None,
    )


def _rows() -> list[dict[str, object]]:
    return [json.loads(line) for line in SESSION.read_text().splitlines()]


def _snapshot_rows(rows: list[dict[str, object]]) -> SourceSnapshot:
    return _snapshot(dump_jsonl(rows))


def _render_events(snapshot: SourceSnapshot) -> bytes:
    extracted = ClaudeExtractor().extract(snapshot)
    rows = [
        {
            "data": event.data,
            "event_index": event.event_index,
            "kind": event.kind.value,
            "source_ref": event.source_ref,
            "text": event.text,
            "timestamp_utc": event.timestamp_utc,
        }
        for event in extracted.events
    ]
    return dump_jsonl(rows)


def _expect_schema_error(snapshot: SourceSnapshot) -> QseshError:
    with pytest.raises(QseshError) as caught:
        ClaudeExtractor().extract(snapshot)
    assert caught.value.code == "QS-E-SOURCE-SCHEMA"
    assert "USER_ALPHA" not in str(caught.value)
    return caught.value


def test_approved_fixture_matches_hand_authored_golden_byte_for_byte() -> None:
    snapshot = _snapshot()
    extracted = ClaudeExtractor().extract(snapshot)

    assert extracted.snapshot is snapshot
    assert _render_events(snapshot) == GOLDEN.read_bytes()
    assert [event.event_index for event in extracted.events] == list(range(12))
    assert [event.source_ref for event in extracted.events] == [
        "line:1",
        "line:2/content:0",
        "line:3/content:0",
        "line:3/content:1",
        "line:3/content:2",
        "line:3/usage",
        "line:4/content:0",
        "line:5",
        "line:6",
        "line:7",
        "line:8",
        "line:9",
    ]


def test_t06_semantic_events_remain_an_ordered_minimum_beneath_usage_enrichment() -> (
    None
):
    expected = json.loads((FIXTURES / "expected-semantics.json").read_text())["events"]
    actual = []
    for event in ClaudeExtractor().extract(_snapshot()).events:
        if event.kind.value == "meta" and event.data.get("meta_type") == "usage":
            continue
        actual.append(
            {
                "data": event.data,
                "event_index": len(actual),
                "kind": event.kind.value,
                "source_ref": event.source_ref,
                "text": event.text,
                "timestamp_utc": event.timestamp_utc,
            }
        )
    assert actual == expected


def test_reported_usage_is_preserved_with_source_unit_and_model() -> None:
    event = ClaudeExtractor().extract(_snapshot()).events[5]
    assert event.kind.value == "meta"
    assert event.source_ref == "line:3/usage"
    assert event.data == {
        "meta_type": "usage",
        "model": "fixture-model",
        "source": "claude",
        "unit": "tokens",
        "usage": {
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "input_tokens": 7,
            "output_tokens": 11,
        },
    }


def test_missing_usage_is_truthfully_absent_not_synthesized() -> None:
    rows = _rows()
    del rows[2]["message"]["usage"]
    events = ClaudeExtractor().extract(_snapshot_rows(rows)).events
    assert len(events) == 11
    assert not any(event.data.get("meta_type") == "usage" for event in events)


@pytest.mark.parametrize(
    "usage",
    [
        {"input_tokens": 7},
        {
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "input_tokens": True,
            "output_tokens": 11,
        },
        {
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "input_tokens": -1,
            "output_tokens": 11,
        },
    ],
)
def test_partial_wrong_type_or_negative_usage_is_rejected(usage: object) -> None:
    rows = _rows()
    rows[2]["message"]["usage"] = usage
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "claude-usage"


def test_schema_registry_binds_unclassified_snapshot_to_observed_contract() -> None:
    assert CLAUDE_SNAPSHOT_FINGERPRINT == "unclassified-jsonl-v1"
    assert CLAUDE_OBSERVED_SCHEMA_FINGERPRINT == (
        "3b974511186301c11dd9c67a724b8e83fc6b4a42f9fb1029c0dd9b9b1603eaf3"
    )
    assert (
        _expect_schema_error(_snapshot(fingerprint="unknown-jsonl-v2")).phase
        == "claude-schema-fingerprint"
    )


def test_source_digest_mismatch_is_rejected_before_any_row_dispatch() -> None:
    snapshot = replace(_snapshot(), source_digest="0" * 64)
    assert _expect_schema_error(snapshot).phase == "extractor-source-digest"


@pytest.mark.parametrize(
    "raw",
    [
        (FIXTURES / "malformed.json").read_bytes(),
        b"{}",
        b"\n",
        b'{"type":"user","type":"assistant"}\n',
        b'{"type":NaN}\n',
    ],
)
def test_malformed_incomplete_blank_duplicate_and_nonfinite_json_quarantine_whole_session(
    raw: bytes,
) -> None:
    assert _expect_schema_error(_snapshot(raw)).phase == "extractor-jsonl"


@pytest.mark.parametrize(
    "timestamp",
    ["2026-01-02T08:04:06", "not-a-time", 1, None],
)
def test_invalid_or_naive_timestamp_is_rejected(timestamp: object) -> None:
    rows = _rows()
    rows[1]["timestamp"] = timestamp
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "extractor-timestamp"


def test_timestamp_offset_normalizes_once_to_utc() -> None:
    assert normalize_timestamp("2026-01-02T03:04:05-05:00") == ("2026-01-02T08:04:05Z")
    assert normalize_timestamp("2026-01-02T08:04:05.123456Z") == (
        "2026-01-02T08:04:05.123456Z"
    )


@pytest.mark.parametrize("mutation", ["missing", "duplicate"])
def test_missing_or_duplicate_tool_call_id_rejects_all_events(mutation: str) -> None:
    rows = _rows()
    content = rows[2]["message"]["content"]
    tool = content[2]
    if mutation == "missing":
        del tool["id"]
    else:
        content.append(dict(tool))
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "claude-tool-call"


@pytest.mark.parametrize("mutation", ["missing", "unknown", "duplicate"])
def test_tool_result_requires_one_prior_unconsumed_call_id(mutation: str) -> None:
    rows = _rows()
    result = rows[3]["message"]["content"][0]
    if mutation == "missing":
        del result["tool_use_id"]
    elif mutation == "unknown":
        result["tool_use_id"] = "tool-unknown"
    else:
        rows[3]["message"]["content"].append(dict(result))
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "claude-tool-result"


def test_command_message_collapses_to_skill_without_user_prose() -> None:
    events = ClaudeExtractor().extract(_snapshot()).events
    skill = events[7]
    assert skill.kind.value == "skill_invocation"
    assert skill.data == {"name": "brainstorming"}
    assert skill.text is None
    assert all(event.text != "/brainstorming" for event in events)


def test_malformed_command_contract_is_rejected() -> None:
    rows = _rows()
    rows[4]["message"]["content"] = "/different"
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "claude-command"


def test_sidechain_is_one_subagent_event_not_assistant_prose() -> None:
    events = ClaudeExtractor().extract(_snapshot()).events
    event = events[8]
    assert event.kind.value == "subagent_activity"
    assert event.data == {"agent": "fixture-agent", "sidechain": True}
    assert event.text == "ASSISTANT_BETA"


def test_sidechain_without_agent_is_rejected() -> None:
    rows = _rows()
    del rows[5]["agent"]
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "claude-sidechain"


def test_compaction_preserves_reason_and_text_without_distilling() -> None:
    event = ClaudeExtractor().extract(_snapshot()).events[9]
    assert event.kind.value == "compaction"
    assert event.data == {"reason": "fixture-limit"}
    assert event.text == "REASONING_GAMMA"


def test_compaction_without_reason_is_rejected() -> None:
    rows = _rows()
    rows[6]["compact_metadata"] = {}
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "claude-compaction"


def test_attachment_and_approved_unknown_row_are_nonlossy_meta_events() -> None:
    events = ClaudeExtractor().extract(_snapshot()).events
    assert events[10].data == {"file": "fixture.txt", "meta_type": "attachment"}
    assert events[11].data == {"raw_type": "fixture_unknown"}
    assert events[10].text is None and events[11].text is None


def test_attachment_without_file_name_is_rejected() -> None:
    rows = _rows()
    del rows[7]["attachments"][0]["name"]
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "claude-attachment"


def test_unsafe_unknown_row_type_is_rejected() -> None:
    rows = _rows()
    rows[8]["type"] = "../../private"
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "claude-row-type"


def test_text_is_preserved_exactly_without_normalization() -> None:
    rows = _rows()
    rows[1]["message"]["content"][0]["text"] = "  α\nβ  "
    events = ClaudeExtractor().extract(_snapshot_rows(rows)).events
    assert events[1].text == "  α\nβ  "


def test_foreign_harness_and_candidate_identity_mismatch_are_rejected() -> None:
    snapshot = _snapshot()
    foreign = replace(
        snapshot,
        candidate=replace(snapshot.candidate, harness=Harness.CODEX),
    )
    assert _expect_schema_error(foreign).phase == "claude-harness"

    rows = _rows()
    rows[0]["uuid"] = "session-other"
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "claude-session-identity"


def test_production_extractor_is_parse_only_and_has_no_policy_or_store_imports() -> (
    None
):
    package = Path(__file__).parents[1] / "qsesh/extractors"
    source = (package / "claude.py").read_text() + (package / "base.py").read_text()
    assert "qsesh.distill" not in source
    assert "qsesh.store" not in source
    assert "qsesh.archive" not in source
    assert "sqlite3" not in source
