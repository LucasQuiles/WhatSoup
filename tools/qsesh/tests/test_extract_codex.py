"""T13 Codex parse-only extractor contracts."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path

import pytest
from qsesh.errors import QseshError
from qsesh.extractors.base import normalize_timestamp
from qsesh.extractors.codex import (
    CODEX_OBSERVED_SCHEMA_FINGERPRINT,
    CODEX_SNAPSHOT_FINGERPRINT,
    CodexExtractor,
)
from qsesh.jsonio import dump_jsonl
from qsesh.model import Harness, SourceCandidate, SourceSnapshot

FIXTURES = Path(__file__).parent / "fixtures/codex"
SESSION = FIXTURES / "session.json"
GOLDEN = FIXTURES / "canonical-events.jsonl"


def _snapshot(
    raw: bytes | None = None, *, fingerprint: str = CODEX_SNAPSHOT_FINGERPRINT
) -> SourceSnapshot:
    payload = SESSION.read_bytes() if raw is None else raw
    return SourceSnapshot(
        candidate=SourceCandidate(
            host_id="host-test-001",
            harness=Harness.CODEX,
            native_id="session-codex-001",
            source_key="codex-fixture",
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
    extracted = CodexExtractor().extract(snapshot)
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
        CodexExtractor().extract(snapshot)
    assert caught.value.code == "QS-E-SOURCE-SCHEMA"
    assert "USER_ALPHA" not in str(caught.value)
    return caught.value


def test_approved_fixture_matches_hand_authored_golden_byte_for_byte() -> None:
    snapshot = _snapshot()
    extracted = CodexExtractor().extract(snapshot)

    assert extracted.snapshot is snapshot
    assert _render_events(snapshot) == GOLDEN.read_bytes()
    assert [event.event_index for event in extracted.events] == list(range(11))
    assert [event.source_ref for event in extracted.events] == [
        "line:1",
        "line:2",
        "line:3/summary:0",
        "line:4/content:0",
        "line:5",
        "line:6",
        "line:7",
        "line:8",
        "line:9",
        "line:10",
        "line:11",
    ]


def test_t06_semantic_manifest_is_the_exact_canonical_sequence() -> None:
    expected = json.loads((FIXTURES / "expected-semantics.json").read_text())["events"]
    actual = [json.loads(line) for line in _render_events(_snapshot()).splitlines()]
    assert actual == expected


def test_schema_registry_binds_jsonl_snapshot_to_observed_contract() -> None:
    assert CODEX_SNAPSHOT_FINGERPRINT == "unclassified-jsonl-v1"
    assert CODEX_OBSERVED_SCHEMA_FINGERPRINT == (
        "d60edba4b9c2f506e0dc6c2f9fb3d4fdea57253a2ab9109d85a876dab71f9b12"
    )
    assert _expect_schema_error(_snapshot(fingerprint="unknown-jsonl-v2")).phase == "codex-schema-fingerprint"


def test_source_digest_mismatch_is_rejected_before_dispatch() -> None:
    assert _expect_schema_error(replace(_snapshot(), source_digest="0" * 64)).phase == "extractor-source-digest"


@pytest.mark.parametrize(
    "raw",
    [
        (FIXTURES / "malformed.json").read_bytes(),
        b"{}",
        b"\n",
        b'{"type":"event_msg","type":"response_item"}\n',
        b'{"type":NaN}\n',
    ],
)
def test_malformed_incomplete_blank_duplicate_and_nonfinite_json_quarantine_whole_session(
    raw: bytes,
) -> None:
    assert _expect_schema_error(_snapshot(raw)).phase == "extractor-jsonl"


@pytest.mark.parametrize("timestamp", ["2026-01-02T08:04:06", "bad", 1, None])
def test_invalid_or_naive_timestamp_is_rejected(timestamp: object) -> None:
    rows = _rows()
    rows[1]["timestamp"] = timestamp
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "extractor-timestamp"


def test_timestamp_offset_uses_only_the_shared_normalizer() -> None:
    assert normalize_timestamp("2026-01-02T03:04:05-05:00") == ("2026-01-02T08:04:05Z")
    assert CodexExtractor().extract(_snapshot()).events[0].timestamp_utc == (
        "2026-01-02T08:04:05Z"
    )


@pytest.mark.parametrize("mutation", ["missing", "extra"])
def test_top_level_keys_are_exact_for_every_row(mutation: str) -> None:
    rows = _rows()
    if mutation == "missing":
        del rows[1]["payload"]
    else:
        rows[1]["extra"] = "USER_ALPHA"
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "codex-row-keys"


@pytest.mark.parametrize("raw_type", [None, 1, "../../private", "unknown_top"])
def test_top_level_type_is_required_safe_and_allowlisted(raw_type: object) -> None:
    rows = _rows()
    rows[1]["type"] = raw_type
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "codex-row-type"


@pytest.mark.parametrize("mutation", ["id", "session_id", "model", "cwd", "extra"])
def test_session_metadata_has_exact_identity_and_string_contract(mutation: str) -> None:
    rows = _rows()
    payload = rows[0]["payload"]
    if mutation == "extra":
        payload["extra"] = "USER_ALPHA"
    elif mutation in {"id", "session_id"}:
        payload[mutation] = "session-other"
    else:
        payload[mutation] = 1
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "codex-session-meta"


@pytest.mark.parametrize(
    ("mutation", "phase"),
    [
        ("keys", "codex-user-message"),
        ("type", "codex-payload-type"),
        ("message", "codex-user-message"),
    ],
)
def test_user_message_payload_contract_is_exact(mutation: str, phase: str) -> None:
    rows = _rows()
    payload = rows[1]["payload"]
    if mutation == "keys":
        payload["extra"] = "USER_ALPHA"
    elif mutation == "type":
        payload["type"] = "other"
    else:
        payload["message"] = 1
    assert _expect_schema_error(_snapshot_rows(rows)).phase == phase


@pytest.mark.parametrize("raw_summary", [[], {}, [{"type": "other", "text": "x"}]])
def test_reasoning_summary_requires_typed_ordered_items(raw_summary: object) -> None:
    rows = _rows()
    rows[2]["payload"]["summary"] = raw_summary
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "codex-reasoning"


def test_reasoning_stays_reasoning_and_never_becomes_assistant_prose() -> None:
    events = CodexExtractor().extract(_snapshot()).events
    assert events[2].kind.value == "reasoning"
    assert events[2].text == "REASONING_GAMMA"
    assert [event.text for event in events if event.kind.value == "assistant_msg"] == [
        "ASSISTANT_BETA"
    ]


@pytest.mark.parametrize("mutation", ["role", "content", "part_type", "extra"])
def test_assistant_message_and_content_keys_are_exact(mutation: str) -> None:
    rows = _rows()
    payload = rows[3]["payload"]
    if mutation == "role":
        payload["role"] = "user"
    elif mutation == "content":
        payload["content"] = []
    elif mutation == "part_type":
        payload["content"][0]["type"] = "input_text"
    else:
        payload["content"][0]["extra"] = "USER_ALPHA"
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "codex-assistant-message"


@pytest.mark.parametrize(
    "arguments",
    ["[]", "{", '{"file":"src/example.py","file":"other"}', '{"file":NaN}'],
)
def test_tool_arguments_must_be_a_strict_json_object(arguments: str) -> None:
    rows = _rows()
    rows[4]["payload"]["arguments"] = arguments
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "codex-tool-call"


@pytest.mark.parametrize("mutation", ["missing", "duplicate"])
def test_tool_calls_require_unique_nonempty_call_ids(mutation: str) -> None:
    rows = _rows()
    if mutation == "missing":
        del rows[4]["payload"]["call_id"]
    else:
        rows.insert(5, dict(rows[4]))
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "codex-tool-call"


@pytest.mark.parametrize("mutation", ["missing", "unknown", "duplicate"])
def test_tool_results_require_one_prior_unconsumed_call(mutation: str) -> None:
    rows = _rows()
    result = rows[5]["payload"]
    if mutation == "missing":
        del result["call_id"]
    elif mutation == "unknown":
        result["call_id"] = "tool-unknown"
    else:
        rows.insert(6, dict(rows[5]))
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "codex-tool-result"


@pytest.mark.parametrize(
    "arguments", ["{}", '{"name":"../../private"}', '{"name":"brainstorming","x":1}']
)
def test_skill_call_requires_exact_safe_name_argument(arguments: str) -> None:
    rows = _rows()
    rows[6]["payload"]["arguments"] = arguments
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "codex-skill"


def test_skill_is_not_counted_as_a_generic_tool_call() -> None:
    events = CodexExtractor().extract(_snapshot()).events
    assert events[6].kind.value == "skill_invocation"
    assert events[6].data == {"name": "brainstorming"}
    assert [
        event.data.get("call_id") for event in events if event.kind.value == "tool_call"
    ] == ["tool-codex-001"]


@pytest.mark.parametrize(
    "arguments",
    [
        "{}",
        '{"agent":"fixture-agent"}',
        '{"prompt":"USER_ALPHA"}',
        '{"agent":"../../private","prompt":"USER_ALPHA"}',
        '{"agent":"fixture-agent","prompt":"USER_ALPHA","x":1}',
    ],
)
def test_subagent_call_requires_exact_agent_and_prompt(arguments: str) -> None:
    rows = _rows()
    rows[7]["payload"]["arguments"] = arguments
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "codex-subagent"


def test_subagent_call_is_one_activity_not_assistant_or_tool_prose() -> None:
    event = CodexExtractor().extract(_snapshot()).events[7]
    assert event.kind.value == "subagent_activity"
    assert event.data == {"agent": "fixture-agent"}
    assert event.text == "USER_ALPHA"


@pytest.mark.parametrize("summary", [[], {}, [{"type": "other", "text": "x"}]])
def test_compaction_requires_typed_ordered_summary(summary: object) -> None:
    rows = _rows()
    rows[8]["payload"]["summary"] = summary
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "codex-compaction"


@pytest.mark.parametrize("mutation", ["attachment_type", "id", "extra"])
def test_attachment_payload_contract_is_exact(mutation: str) -> None:
    rows = _rows()
    attachment = rows[9]["payload"]["attachment"]
    if mutation == "attachment_type":
        attachment["type"] = "url"
    elif mutation == "id":
        attachment["id"] = 1
    else:
        attachment["extra"] = "USER_ALPHA"
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "codex-attachment"


def test_approved_safe_unknown_payload_is_a_content_free_meta_event() -> None:
    event = CodexExtractor().extract(_snapshot()).events[10]
    assert event.kind.value == "meta"
    assert event.data == {"raw_type": "fixture_unknown"}
    assert event.text is None


@pytest.mark.parametrize("payload_type", [None, 1, "../../private"])
def test_unknown_payload_type_must_still_be_a_safe_discriminator(
    payload_type: object,
) -> None:
    rows = _rows()
    rows[10]["payload"]["type"] = payload_type
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "codex-payload-type"


def test_missing_cost_and_token_fields_remain_absent_without_synthesis() -> None:
    events = CodexExtractor().extract(_snapshot()).events
    assert not any(event.data.get("meta_type") == "usage" for event in events)
    assert all(
        "cost" not in event.data and "tokens" not in event.data for event in events
    )


def test_text_is_preserved_exactly_without_normalization() -> None:
    rows = _rows()
    rows[1]["payload"]["message"] = "  α\nβ  "
    assert CodexExtractor().extract(_snapshot_rows(rows)).events[1].text == "  α\nβ  "


def test_foreign_harness_is_rejected() -> None:
    snapshot = _snapshot()
    foreign = replace(
        snapshot, candidate=replace(snapshot.candidate, harness=Harness.CLAUDE)
    )
    assert _expect_schema_error(foreign).phase == "codex-harness"


def test_production_extractor_is_parse_only_and_uses_shared_timestamp_helper() -> None:
    package = Path(__file__).parents[1] / "qsesh/extractors"
    source = (package / "codex.py").read_text()
    assert "normalize_timestamp(" in source
    assert "qsesh.distill" not in source
    assert "qsesh.store" not in source
    assert "qsesh.archive" not in source
    assert "sqlite3" not in source
