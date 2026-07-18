"""T14 OpenCode canonical-export extractor contracts."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path

import pytest
from qsesh.errors import QseshError
from qsesh.extractors.opencode import (
    OPENCODE_OBSERVED_SCHEMA_FINGERPRINT,
    OPENCODE_SNAPSHOT_FINGERPRINT,
    OpenCodeExtractor,
)
from qsesh.jsonio import dump_jsonl
from qsesh.model import Harness, SourceCandidate, SourceSnapshot

FIXTURES = Path(__file__).parent / "fixtures/opencode"
SESSION = FIXTURES / "session.json"
GOLDEN = FIXTURES / "canonical-events.jsonl"


def _export() -> dict[str, object]:
    return json.loads(SESSION.read_text())


def _canonical_rows(export: dict[str, object] | None = None) -> list[dict[str, object]]:
    value = _export() if export is None else export
    rows: list[dict[str, object]] = [
        {"kind": "session", "schema_version": 1, "value": value["info"]}
    ]
    for message_index, message in enumerate(value["messages"]):
        rows.append(
            {
                "kind": "message",
                "message_index": message_index,
                "schema_version": 1,
                "value": message["info"],
            }
        )
        for part_index, part in enumerate(message["parts"]):
            rows.append(
                {
                    "kind": "part",
                    "message_index": message_index,
                    "part_index": part_index,
                    "schema_version": 1,
                    "value": part,
                }
            )
    return rows


def _snapshot(
    raw: bytes | None = None,
    *,
    fingerprint: str = OPENCODE_SNAPSHOT_FINGERPRINT,
    harness_version: str | None = "1.17.15",
) -> SourceSnapshot:
    payload = dump_jsonl(_canonical_rows()) if raw is None else raw
    return SourceSnapshot(
        candidate=SourceCandidate(
            host_id="host-test-001",
            harness=Harness.OPENCODE,
            native_id="ses_opencode_001",
            source_key="opencode-cli-v1",
            updated_at_us=1,
            file_stamp=None,
        ),
        raw_bytes=payload,
        source_digest=hashlib.blake2b(payload, digest_size=32).hexdigest(),
        schema_fingerprint=fingerprint,
        harness_version=harness_version,
    )


def _snapshot_rows(rows: list[dict[str, object]]) -> SourceSnapshot:
    return _snapshot(dump_jsonl(rows))


def _snapshot_export(export: dict[str, object]) -> SourceSnapshot:
    return _snapshot_rows(_canonical_rows(export))


def _render_events(snapshot: SourceSnapshot) -> bytes:
    return dump_jsonl(
        {
            "data": event.data,
            "event_index": event.event_index,
            "kind": event.kind.value,
            "source_ref": event.source_ref,
            "text": event.text,
            "timestamp_utc": event.timestamp_utc,
        }
        for event in OpenCodeExtractor().extract(snapshot).events
    )


def _expect_schema_error(snapshot: SourceSnapshot) -> QseshError:
    with pytest.raises(QseshError) as caught:
        OpenCodeExtractor().extract(snapshot)
    assert caught.value.code == "QS-E-SOURCE-SCHEMA"
    assert "USER_ALPHA" not in str(caught.value)
    return caught.value


def test_approved_fixture_matches_enriched_golden_byte_for_byte() -> None:
    snapshot = _snapshot()
    extracted = OpenCodeExtractor().extract(snapshot)

    assert extracted.snapshot is snapshot
    assert _render_events(snapshot) == GOLDEN.read_bytes()
    assert [event.event_index for event in extracted.events] == list(range(15))
    assert [event.source_ref for event in extracted.events] == [
        "info",
        "info/usage",
        "info/cost",
        "messages:0/parts:0",
        "messages:1/info/usage",
        "messages:1/info/cost",
        "messages:1/parts:0",
        "messages:1/parts:1",
        "messages:1/parts:2/state:input",
        "messages:1/parts:2/state:output",
        "messages:1/parts:3",
        "messages:1/parts:4",
        "messages:1/parts:5",
        "messages:1/parts:6",
        "messages:1/parts:7",
    ]


def test_t11_canonical_raw_rows_have_exact_order_and_indices() -> None:
    rows = _canonical_rows()
    assert [row["kind"] for row in rows] == [
        "session",
        "message",
        "part",
        "message",
        "part",
        "part",
        "part",
        "part",
        "part",
        "part",
        "part",
        "part",
    ]
    assert [row["message_index"] for row in rows if row["kind"] == "message"] == [0, 1]
    assert [row["part_index"] for row in rows if row["kind"] == "part"] == list(
        range(1)
    ) + list(range(8))


def test_t06_semantics_are_an_ordered_minimum_beneath_reported_metadata() -> None:
    expected = json.loads((FIXTURES / "expected-semantics.json").read_text())["events"]
    actual_events = [
        event
        for event in OpenCodeExtractor().extract(_snapshot()).events
        if event.data.get("meta_type") not in {"usage", "cost"}
    ]
    assert len(actual_events) == len(expected)
    for index, (actual, minimum) in enumerate(
        zip(actual_events, expected, strict=True)
    ):
        assert actual.event_index >= index
        assert actual.kind.value == minimum["kind"]
        assert actual.source_ref == minimum["source_ref"]
        assert actual.text == minimum["text"]
        assert actual.timestamp_utc == minimum["timestamp_utc"]
        for key, value in minimum["data"].items():
            assert actual.data[key] == value


def test_schema_registry_binds_t11_jsonl_to_observed_export_contract() -> None:
    assert OPENCODE_SNAPSHOT_FINGERPRINT == "opencode-export-jsonl-v1"
    assert OPENCODE_OBSERVED_SCHEMA_FINGERPRINT == (
        "5a6076f647ae5fcc6ba74d82940712985341e3d803b649e65e29824c35e46721"
    )
    assert (
        _expect_schema_error(_snapshot(fingerprint="opencode-export-jsonl-v2")).phase
        == "opencode-schema-fingerprint"
    )


def test_source_digest_harness_and_harness_version_are_bound() -> None:
    assert (
        _expect_schema_error(replace(_snapshot(), source_digest="0" * 64)).phase
        == "extractor-source-digest"
    )
    foreign = replace(
        _snapshot(),
        candidate=replace(_snapshot().candidate, harness=Harness.CODEX),
    )
    assert _expect_schema_error(foreign).phase == "opencode-harness"
    assert (
        _expect_schema_error(_snapshot(harness_version="1.17.16")).phase
        == "opencode-harness-version"
    )


@pytest.mark.parametrize(
    "raw",
    [
        (FIXTURES / "malformed.json").read_bytes(),
        b"{}",
        b"\n",
        b'{"kind":"session","kind":"part"}\n',
        b'{"kind":NaN}\n',
    ],
)
def test_malformed_incomplete_blank_duplicate_and_nonfinite_json_quarantine_whole_session(
    raw: bytes,
) -> None:
    assert _expect_schema_error(_snapshot(raw)).phase == "extractor-jsonl"


@pytest.mark.parametrize("mutation", ["missing", "extra", "version"])
def test_canonical_session_row_has_exact_envelope(mutation: str) -> None:
    rows = _canonical_rows()
    if mutation == "missing":
        del rows[0]["value"]
    elif mutation == "extra":
        rows[0]["extra"] = "USER_ALPHA"
    else:
        rows[0]["schema_version"] = 2
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "opencode-row-schema"


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "after-message"])
def test_session_row_is_exactly_once_and_first(mutation: str) -> None:
    rows = _canonical_rows()
    if mutation == "missing":
        rows.pop(0)
    elif mutation == "duplicate":
        rows.insert(1, dict(rows[0]))
    else:
        rows[0], rows[1] = rows[1], rows[0]
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "opencode-row-order"


@pytest.mark.parametrize("row_kind", [None, 1, "../../private", "unknown"])
def test_canonical_row_kind_is_required_safe_and_allowlisted(row_kind: object) -> None:
    rows = _canonical_rows()
    rows[1]["kind"] = row_kind
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "opencode-row-kind"


@pytest.mark.parametrize("mutation", ["gap", "repeat", "part-before-message"])
def test_message_and_part_indices_preserve_export_order(mutation: str) -> None:
    rows = _canonical_rows()
    if mutation == "gap":
        rows[3]["message_index"] = 2
    elif mutation == "repeat":
        rows[5]["part_index"] = 0
    else:
        rows[1], rows[2] = rows[2], rows[1]
    assert _expect_schema_error(_snapshot_rows(rows)).phase == "opencode-row-order"


@pytest.mark.parametrize("mutation", ["id", "version", "time", "keys"])
def test_session_info_has_exact_identity_version_time_and_allowed_fields(
    mutation: str,
) -> None:
    export = _export()
    info = export["info"]
    if mutation == "id":
        info["id"] = "ses_other"
    elif mutation == "version":
        info["version"] = "1.17.16"
    elif mutation == "time":
        info["time"] = {"created": "bad", "updated": 1}
    else:
        info["extra"] = "USER_ALPHA"
    assert (
        _expect_schema_error(_snapshot_export(export)).phase == "opencode-session-info"
    )


@pytest.mark.parametrize("created", [True, -1, "bad", None])
def test_epoch_milliseconds_are_nonnegative_integers(created: object) -> None:
    export = _export()
    export["messages"][0]["info"]["time"]["created"] = created
    assert (
        _expect_schema_error(_snapshot_export(export)).phase == "opencode-message-info"
    )


def test_epoch_milliseconds_normalize_to_utc_without_local_timezone() -> None:
    events = OpenCodeExtractor().extract(_snapshot()).events
    assert events[0].timestamp_utc == "2026-01-02T08:04:05Z"
    assert events[3].timestamp_utc == "2026-01-02T08:04:06Z"
    assert events[6].timestamp_utc == "2026-01-02T08:04:07Z"


@pytest.mark.parametrize(
    "mutation", ["session", "message", "parent", "part-message", "part-session"]
)
def test_message_and_part_identity_links_are_exact(mutation: str) -> None:
    export = _export()
    if mutation == "session":
        export["messages"][0]["info"]["sessionID"] = "ses_other"
    elif mutation == "message":
        export["messages"][1]["info"]["id"] = export["messages"][0]["info"]["id"]
    elif mutation == "parent":
        export["messages"][1]["info"]["parentID"] = "message-other"
    elif mutation == "part-message":
        export["messages"][1]["parts"][0]["messageID"] = "message-other"
    else:
        export["messages"][1]["parts"][0]["sessionID"] = "ses_other"
    assert _expect_schema_error(_snapshot_export(export)).phase == "opencode-identity"


def test_optional_synthetic_user_text_marker_must_be_boolean() -> None:
    export = _export()
    export["messages"][0]["parts"][0]["synthetic"] = "true"
    assert _expect_schema_error(_snapshot_export(export)).phase == "opencode-text"


@pytest.mark.parametrize("mutation", ["role", "keys", "time"])
def test_message_info_role_keys_and_time_are_exact(mutation: str) -> None:
    export = _export()
    info = export["messages"][0]["info"]
    if mutation == "role":
        info["role"] = "system"
    elif mutation == "keys":
        info["extra"] = "USER_ALPHA"
    else:
        info["time"] = {}
    assert (
        _expect_schema_error(_snapshot_export(export)).phase == "opencode-message-info"
    )


def test_session_and_message_reported_usage_and_cost_keep_scope_source_unit_model() -> (
    None
):
    events = OpenCodeExtractor().extract(_snapshot()).events
    assert events[1].data == {
        "meta_type": "usage",
        "model": None,
        "provider": None,
        "scope": "session",
        "source": "opencode",
        "unit": "tokens",
        "usage": {"input": 7, "output": 11},
    }
    assert events[2].data == {
        "cost": 0,
        "meta_type": "cost",
        "model": None,
        "provider": None,
        "scope": "session",
        "source": "opencode",
        "unit": "opencode_native",
    }
    assert events[4].data["model"] == "fixture-model"
    assert events[4].data["provider"] == "fixture-provider"
    assert events[4].data["scope"] == "message"
    assert events[5].data["cost"] == 0


def test_missing_usage_and_cost_are_absent_not_synthesized() -> None:
    export = _export()
    for info in (export["info"], export["messages"][1]["info"]):
        del info["tokens"]
        del info["cost"]
    events = OpenCodeExtractor().extract(_snapshot_export(export)).events
    assert len(events) == 11
    assert not any(event.data.get("meta_type") in {"usage", "cost"} for event in events)


def test_partial_reported_tokens_are_preserved_without_filling_missing_fields() -> None:
    export = _export()
    export["info"]["tokens"] = {"input": 7}
    usage = OpenCodeExtractor().extract(_snapshot_export(export)).events[1]
    assert usage.data["usage"] == {"input": 7}


@pytest.mark.parametrize(
    "tokens",
    [{}, {"input": True}, {"input": -1}, {"input": 1, "other": 2}, "bad"],
)
def test_invalid_token_shapes_are_rejected(tokens: object) -> None:
    export = _export()
    export["info"]["tokens"] = tokens
    assert _expect_schema_error(_snapshot_export(export)).phase == "opencode-usage"


@pytest.mark.parametrize("cost", [True, -1, "bad", {}, []])
def test_invalid_cost_values_are_rejected(cost: object) -> None:
    export = _export()
    export["info"]["cost"] = cost
    assert _expect_schema_error(_snapshot_export(export)).phase == "opencode-cost"


def test_reasoning_and_assistant_prose_keep_model_provider_and_separate_kinds() -> None:
    events = OpenCodeExtractor().extract(_snapshot()).events
    assert events[6].kind.value == "reasoning"
    assert events[6].data == {"model": "fixture-model", "provider": "fixture-provider"}
    assert events[7].kind.value == "assistant_msg"
    assert events[7].data == {
        "model": "fixture-model",
        "provider": "fixture-provider",
        "role": "assistant",
    }


@pytest.mark.parametrize("mutation", ["type", "id", "message", "session", "duplicate"])
def test_part_envelope_and_ids_are_exact(mutation: str) -> None:
    export = _export()
    part = export["messages"][1]["parts"][0]
    if mutation == "type":
        part["type"] = "other"
    elif mutation == "id":
        del part["id"]
    elif mutation == "message":
        del part["messageID"]
    elif mutation == "session":
        del part["sessionID"]
    else:
        part["id"] = export["messages"][0]["parts"][0]["id"]
    phase = "opencode-part-type" if mutation == "type" else "opencode-identity"
    assert _expect_schema_error(_snapshot_export(export)).phase == phase


@pytest.mark.parametrize(
    "mutation", ["state-keys", "status", "input", "output", "tool"]
)
def test_generic_tool_state_is_exact_and_completed(mutation: str) -> None:
    export = _export()
    part = export["messages"][1]["parts"][2]
    if mutation == "state-keys":
        part["state"]["extra"] = "USER_ALPHA"
    elif mutation == "status":
        part["state"]["status"] = "pending"
    elif mutation == "input":
        part["state"]["input"] = "bad"
    elif mutation == "output":
        part["state"]["output"] = 1
    else:
        part["tool"] = "../../private"
    assert _expect_schema_error(_snapshot_export(export)).phase == "opencode-tool"


def test_generic_tool_emits_linked_call_then_result_and_mcp_flag() -> None:
    events = OpenCodeExtractor().extract(_snapshot()).events
    assert events[8].data == {
        "call_id": "part-opencode-004",
        "input": {"file": "src/example.py"},
        "is_mcp": True,
        "name": "mcp__fixture__lookup",
    }
    assert events[9].data == {"call_id": "part-opencode-004", "result": "USER_ALPHA"}


@pytest.mark.parametrize("mutation", ["state", "name", "unsafe", "extra"])
def test_skill_tool_requires_exact_completed_safe_name(mutation: str) -> None:
    export = _export()
    part = export["messages"][1]["parts"][3]
    if mutation == "state":
        part["state"]["status"] = "pending"
    elif mutation == "name":
        del part["state"]["input"]["name"]
    elif mutation == "unsafe":
        part["state"]["input"]["name"] = "../../private"
    else:
        part["state"]["input"]["extra"] = "USER_ALPHA"
    assert _expect_schema_error(_snapshot_export(export)).phase == "opencode-skill"


@pytest.mark.parametrize("mutation", ["agent", "unsafe", "prompt", "extra"])
def test_subtask_requires_exact_safe_agent_and_prompt(mutation: str) -> None:
    export = _export()
    part = export["messages"][1]["parts"][4]
    if mutation == "agent":
        del part["agent"]
    elif mutation == "unsafe":
        part["agent"] = "../../private"
    elif mutation == "prompt":
        part["prompt"] = 1
    else:
        part["extra"] = "USER_ALPHA"
    assert _expect_schema_error(_snapshot_export(export)).phase == "opencode-subagent"


def test_skill_subagent_compaction_file_and_unknown_are_typed_without_policy() -> None:
    events = OpenCodeExtractor().extract(_snapshot()).events
    assert events[10].kind.value == "skill_invocation"
    assert events[10].data == {"name": "brainstorming"}
    assert events[11].kind.value == "subagent_activity"
    assert events[11].data == {"agent": "fixture-agent"}
    assert events[11].text == "USER_ALPHA"
    assert events[12].kind.value == "compaction"
    assert events[13].data == {"file": "fixture.txt", "meta_type": "attachment"}
    assert events[14].data == {"raw_type": "fixture_unknown"}


@pytest.mark.parametrize("mutation", ["compaction", "file", "unknown"])
def test_tail_part_shapes_are_exact(mutation: str) -> None:
    export = _export()
    indices = {"compaction": 5, "file": 6, "unknown": 7}
    part = export["messages"][1]["parts"][indices[mutation]]
    part["extra"] = "USER_ALPHA"
    assert (
        _expect_schema_error(_snapshot_export(export)).phase == f"opencode-{mutation}"
    )


def test_user_and_assistant_text_are_preserved_exactly() -> None:
    export = _export()
    export["messages"][0]["parts"][0]["text"] = "  α\nβ  "
    export["messages"][1]["parts"][1]["text"] = "  γ\nδ  "
    events = OpenCodeExtractor().extract(_snapshot_export(export)).events
    assert events[3].text == "  α\nβ  "
    assert events[7].text == "  γ\nδ  "


def test_production_extractor_is_parse_only_and_never_imports_source_or_sql() -> None:
    source = (Path(__file__).parents[1] / "qsesh/extractors/opencode.py").read_text()
    assert "qsesh.sources" not in source
    assert "qsesh.distill" not in source
    assert "qsesh.store" not in source
    assert "qsesh.archive" not in source
    assert "sqlite3" not in source
