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


# --- timestamp-optional for non-content control records (real modern sessions) ---
# Modern Claude sessions interleave metadata/control records (mode, last-prompt,
# permission-mode, ai-title, ...) that carry NO `timestamp` field. These are not
# conversational content and must not gate extraction; content records
# (system/user/assistant) still require a timestamp.
_CONTROL_ROWS = [
    {"type": "mode", "mode": "normal", "sessionId": "session-claude-001"},
    {
        "type": "last-prompt",
        "leafUuid": "de4eebbf-daef-4019-8765-71726e69a7d4",
        "sessionId": "session-claude-001",
    },
    {
        "type": "permission-mode",
        "permissionMode": "auto",
        "sessionId": "session-claude-001",
    },
    {"type": "ai-title", "aiTitle": "some title", "sessionId": "session-claude-001"},
]


def test_control_record_without_timestamp_extracts_as_meta() -> None:
    rows = _rows()
    rows.append(dict(_CONTROL_ROWS[0]))  # `mode`, no timestamp field
    events = ClaudeExtractor().extract(_snapshot_rows(rows)).events
    meta = [
        e for e in events if e.kind.value == "meta" and e.data.get("raw_type") == "mode"
    ]
    assert len(meta) == 1
    assert meta[0].timestamp_utc is None


def test_all_untimed_control_types_extract_without_error() -> None:
    rows = _rows()
    for control in _CONTROL_ROWS:
        rows.append(dict(control))
    events = ClaudeExtractor().extract(_snapshot_rows(rows)).events
    raw_types = {
        e.data.get("raw_type")
        for e in events
        if e.kind.value == "meta" and e.data.get("raw_type") is not None
    }
    assert {"mode", "last-prompt", "permission-mode", "ai-title"} <= raw_types


def test_content_record_still_requires_timestamp() -> None:
    # Guard preserved: a user (content) record missing its timestamp is still
    # rejected -- the leniency is scoped to non-content control records only.
    rows = _rows()
    user_row = next(r for r in rows if r.get("type") == "user")
    user_row.pop("timestamp", None)
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "extractor-timestamp"


# --- usage: tolerate unknown keys, extract only the known token counts ---
# Real modern usage objects carry keys beyond the four token counts
# (cache_creation, inference_geo, service_tier, speed, server_tool_use,
# iterations). Policy: require + extract the four known counts; ignore extras.
_KNOWN_USAGE = {
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "input_tokens",
    "output_tokens",
}
_REAL_USAGE_EXTRAS = {
    "cache_creation": {"ephemeral_5m_input_tokens": 3},
    "inference_geo": "us",
    "service_tier": "standard",
    "speed": "fast",
    "server_tool_use": {"web_search_requests": 0},
    "iterations": 1,
}


def _assistant_usage(rows: list[dict[str, object]]) -> dict[str, object]:
    row = next(r for r in rows if r.get("type") == "assistant")
    return row["message"]["usage"]


def test_usage_with_unknown_keys_extracts_known_counts_only() -> None:
    rows = _rows()
    usage = _assistant_usage(rows)
    usage.update(_REAL_USAGE_EXTRAS)  # 4 known + 6 real-world extras
    events = ClaudeExtractor().extract(_snapshot_rows(rows)).events
    meta = next(
        e
        for e in events
        if e.kind.value == "meta" and e.data.get("meta_type") == "usage"
    )
    assert set(meta.data["usage"]) == _KNOWN_USAGE  # extras dropped, known kept


def test_usage_missing_a_known_key_still_rejects() -> None:
    rows = _rows()
    del _assistant_usage(rows)["input_tokens"]
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "claude-usage"


def test_usage_known_key_wrong_type_still_rejects() -> None:
    rows = _rows()
    _assistant_usage(rows)["output_tokens"] = "not-an-int"
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "claude-usage"


# --- unknown system subtypes fall through to META (real modern sessions) ---
# Real sessions carry system records with subtypes the extractor doesn't model
# (turn_duration, stop_hook_summary, scheduled_task_fire, local_command,
# model_fallback, ...). These must fall through to META like unknown top-level
# types, not reject; init/compact_boundary/attachment keep their handling.
def _system_row(subtype: str, *, ts: str = "2026-01-02T08:05:00Z") -> dict:
    return {
        "type": "system",
        "subtype": subtype,
        "timestamp": ts,
        "parentUuid": "p",
        "isSidechain": False,
        "content": "x",
    }


def test_unknown_system_subtype_falls_through_to_meta() -> None:
    rows = _rows()
    rows.append(_system_row("turn_duration"))
    events = ClaudeExtractor().extract(_snapshot_rows(rows)).events
    meta = [
        e
        for e in events
        if e.kind.value == "meta" and e.data.get("subtype") == "turn_duration"
    ]
    assert len(meta) == 1
    assert meta[0].data.get("raw_type") == "system"


def test_multiple_unknown_system_subtypes_all_extract() -> None:
    rows = _rows()
    for st in (
        "stop_hook_summary",
        "scheduled_task_fire",
        "local_command",
        "model_fallback",
        "agents_killed",
    ):
        rows.append(_system_row(st))
    events = ClaudeExtractor().extract(_snapshot_rows(rows)).events
    subtypes = {
        e.data.get("subtype")
        for e in events
        if e.kind.value == "meta" and e.data.get("raw_type") == "system"
    }
    assert {
        "stop_hook_summary",
        "scheduled_task_fire",
        "local_command",
        "model_fallback",
        "agents_killed",
    } <= subtypes


# --- compaction: modern camelCase compactMetadata with rich token deltas ---
# Real sessions use `compactMetadata` (camelCase) carrying trigger + token
# deltas; the legacy `compact_metadata` (snake, {reason}) path is unchanged.
def _modern_compaction_row(*, ts: str = "2026-01-02T08:06:00Z", **overrides) -> dict:
    cm = {
        "trigger": "manual",
        "preTokens": 120000,
        "postTokens": 8000,
        "durationMs": 745402,
        "preservedMessages": {"count": 3},
        "preservedSegment": {"start": 1},
        "preCompactDiscoveredTools": ["Read"],
        "cumulativeDroppedTokens": 5000,
    }
    cm.update(overrides)
    return {
        "type": "system",
        "subtype": "compact_boundary",
        "timestamp": ts,
        "content": "Conversation compacted",
        "compactMetadata": cm,
        "cwd": "p",
        "uuid": "cmp-modern",
    }


def test_modern_compaction_captures_trigger_and_token_deltas() -> None:
    rows = _rows()
    rows.append(_modern_compaction_row())
    events = ClaudeExtractor().extract(_snapshot_rows(rows)).events
    comp = [
        e
        for e in events
        if e.kind.value == "compaction" and e.data.get("trigger") == "manual"
    ]
    assert len(comp) == 1
    d = comp[0].data
    assert d["pre_tokens"] == 120000
    assert d["post_tokens"] == 8000
    assert d["duration_ms"] == 745402
    assert d["cumulative_dropped_tokens"] == 5000
    assert comp[0].text == "Conversation compacted"


def test_modern_compaction_optional_cumulative_dropped_absent() -> None:
    rows = _rows()
    row = _modern_compaction_row()
    del row["compactMetadata"]["cumulativeDroppedTokens"]
    rows.append(row)
    events = ClaudeExtractor().extract(_snapshot_rows(rows)).events
    comp = next(
        e
        for e in events
        if e.kind.value == "compaction" and e.data.get("trigger") == "manual"
    )
    assert "cumulative_dropped_tokens" not in comp.data


def test_modern_compaction_bad_token_type_rejects() -> None:
    rows = _rows()
    rows.append(_modern_compaction_row(preTokens="lots"))
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "claude-compaction"


def test_legacy_snake_compaction_still_reason_only() -> None:
    # The committed fixture uses compact_metadata (snake) {reason}; unchanged.
    events = ClaudeExtractor().extract(_snapshot()).events
    comp = [e for e in events if e.kind.value == "compaction"]
    assert len(comp) == 1
    assert comp[0].data == {"reason": "fixture-limit"}


# --- server tools + fallback + image blocks (real modern content) ---
def _asst_row(blocks: list, *, uuid: str, ts: str = "2026-01-02T08:07:00Z") -> dict:
    return {
        "type": "assistant",
        "cwd": "p",
        "isSidechain": False,
        "parentUuid": "x",
        "timestamp": ts,
        "uuid": uuid,
        "message": {"role": "assistant", "model": "fixture-model", "content": blocks},
    }


def _user_row(blocks: list, *, uuid: str, ts: str = "2026-01-02T08:07:30Z") -> dict:
    return {
        "type": "user",
        "cwd": "p",
        "parentUuid": "x",
        "timestamp": ts,
        "uuid": uuid,
        "message": {"role": "user", "content": blocks},
    }


def test_server_tool_use_models_as_tool_call() -> None:
    rows = _rows()
    rows.append(
        _asst_row(
            [
                {
                    "type": "server_tool_use",
                    "id": "srvtoolu_1",
                    "name": "advisor",
                    "input": {"q": "x"},
                }
            ],
            uuid="a-srv",
        )
    )
    events = ClaudeExtractor().extract(_snapshot_rows(rows)).events
    call = next(
        e
        for e in events
        if e.kind.value == "tool_call" and e.data.get("call_id") == "srvtoolu_1"
    )
    assert call.data["name"] == "advisor"
    assert call.data["input"] == {"q": "x"}
    assert call.data["is_mcp"] is False


def test_advisor_tool_result_pairs_across_messages() -> None:
    rows = _rows()
    rows.append(
        _asst_row(
            [
                {
                    "type": "server_tool_use",
                    "id": "srvtoolu_2",
                    "name": "advisor",
                    "input": {},
                }
            ],
            uuid="a-call",
        )
    )
    rows.append(
        _asst_row(
            [
                {
                    "type": "advisor_tool_result",
                    "tool_use_id": "srvtoolu_2",
                    "content": {"text": "advice"},
                }
            ],
            uuid="a-res",
            ts="2026-01-02T08:08:00Z",
        )
    )
    events = ClaudeExtractor().extract(_snapshot_rows(rows)).events
    res = next(
        e
        for e in events
        if e.kind.value == "tool_result" and e.data.get("call_id") == "srvtoolu_2"
    )
    assert res.data["result"] == {"text": "advice"}


def test_advisor_tool_result_without_prior_call_rejects() -> None:
    rows = _rows()
    rows.append(
        _asst_row(
            [
                {
                    "type": "advisor_tool_result",
                    "tool_use_id": "srvtoolu_missing",
                    "content": {"text": "x"},
                }
            ],
            uuid="a-orphan",
        )
    )
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "claude-tool-result"


def test_fallback_block_models_as_meta() -> None:
    rows = _rows()
    rows.append(
        _asst_row(
            [
                {
                    "type": "fallback",
                    "from": {"model": "claude-fable-5"},
                    "to": {"model": "claude-opus-4-8"},
                }
            ],
            uuid="a-fb",
        )
    )
    events = ClaudeExtractor().extract(_snapshot_rows(rows)).events
    meta = next(
        e
        for e in events
        if e.kind.value == "meta" and e.data.get("meta_type") == "model_fallback"
    )
    assert meta.data["from_model"] == "claude-fable-5"
    assert meta.data["to_model"] == "claude-opus-4-8"


def test_image_block_in_user_content_models_as_meta() -> None:
    rows = _rows()
    rows.append(
        _user_row(
            [
                {
                    "type": "image",
                    "source": {
                        "data": "AAAA",
                        "media_type": "image/png",
                        "type": "base64",
                    },
                }
            ],
            uuid="u-img",
        )
    )
    events = ClaudeExtractor().extract(_snapshot_rows(rows)).events
    meta = next(
        e
        for e in events
        if e.kind.value == "meta" and e.data.get("meta_type") == "image"
    )
    assert meta.data["media_type"] == "image/png"
    assert "data" not in meta.data  # base64 payload not embedded


# --- synthesized SESSION_META for modern sessions (no init record) ---
# Modern sessions have no system/init record, so the extractor synthesizes a
# SESSION_META as the first event, recording the ordered trail of cwds the
# session touched. Legacy sessions (with an init record) are unchanged.
_TS = "2026-01-02T08:04:06Z"


def _modern_rows() -> list[dict]:
    return [
        {"type": "mode", "mode": "normal", "sessionId": "s", "cwd": "proj-A"},
        {
            "type": "user",
            "cwd": "proj-A",
            "timestamp": _TS,
            "uuid": "u1",
            "parentUuid": None,
            "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]},
        },
        {
            "type": "assistant",
            "cwd": "proj-B",
            "timestamp": _TS,
            "uuid": "a1",
            "parentUuid": "u1",
            "isSidechain": False,
            "message": {
                "role": "assistant",
                "model": "m",
                "content": [{"type": "text", "text": "hello"}],
            },
        },
        {"type": "ai-title", "aiTitle": "My Session", "sessionId": "s"},
    ]


def test_modern_session_synthesizes_session_meta_first() -> None:
    events = ClaudeExtractor().extract(_snapshot_rows(_modern_rows())).events
    assert events[0].kind.value == "session_meta"
    d = events[0].data
    assert d["project"] == "proj-A"
    assert d["cwds"] == ["proj-A", "proj-B"]  # ordered trail, distinct
    assert d["title"] == "My Session"


def test_modern_session_has_exactly_one_session_meta() -> None:
    events = ClaudeExtractor().extract(_snapshot_rows(_modern_rows())).events
    assert sum(1 for e in events if e.kind.value == "session_meta") == 1


def test_legacy_init_session_not_double_synthesized() -> None:
    # The committed fixture HAS an init record -> exactly one SESSION_META,
    # from init, at events[0]. No synthesis.
    events = ClaudeExtractor().extract(_snapshot()).events
    metas = [e for e in events if e.kind.value == "session_meta"]
    assert len(metas) == 1
    assert events[0] is metas[0]
    assert "cwds" not in metas[0].data  # legacy path unchanged
