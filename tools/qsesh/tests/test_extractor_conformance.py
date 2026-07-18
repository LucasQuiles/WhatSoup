"""Cross-harness join contract for the three parse-only extractors."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path

import pytest
from qsesh.errors import QseshError
from qsesh.extractors.base import normalize_timestamp
from qsesh.extractors.claude import ClaudeExtractor
from qsesh.extractors.codex import CodexExtractor
from qsesh.extractors.opencode import OpenCodeExtractor
from qsesh.jsonio import dump_jsonl
from qsesh.model import EventKind, Harness, SourceCandidate, SourceSnapshot

FIXTURES = Path(__file__).parent / "fixtures"


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
            source_key=f"{harness.value}-conformance",
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


CASES = (
    (
        "claude",
        ClaudeExtractor(),
        _snapshot(
            Harness.CLAUDE,
            "session-claude-001",
            (FIXTURES / "claude/session.json").read_bytes(),
            "unclassified-jsonl-v1",
            None,
        ),
    ),
    (
        "codex",
        CodexExtractor(),
        _snapshot(
            Harness.CODEX,
            "session-codex-001",
            (FIXTURES / "codex/session.json").read_bytes(),
            "unclassified-jsonl-v1",
            None,
        ),
    ),
    (
        "opencode",
        OpenCodeExtractor(),
        _snapshot(
            Harness.OPENCODE,
            "ses_opencode_001",
            _opencode_raw(),
            "opencode-export-jsonl-v1",
            "1.17.15",
        ),
    ),
)


@pytest.mark.parametrize(("_name", "extractor", "snapshot"), CASES)
def test_each_harness_emits_the_complete_shared_event_vocabulary(
    _name: str, extractor: object, snapshot: SourceSnapshot
) -> None:
    events = extractor.extract(snapshot).events
    assert [event.event_index for event in events] == list(range(len(events)))
    assert {event.kind for event in events} == set(EventKind)
    assert all(event.schema_version == 1 for event in events)
    assert len({event.source_ref for event in events}) == len(events)


@pytest.mark.parametrize(("_name", "extractor", "snapshot"), CASES)
def test_shared_prose_and_utc_contract_is_identical(
    _name: str, extractor: object, snapshot: SourceSnapshot
) -> None:
    events = extractor.extract(snapshot).events
    by_kind = {kind: [] for kind in EventKind}
    for event in events:
        by_kind[event.kind].append(event)
        assert event.timestamp_utc is not None
        assert normalize_timestamp(event.timestamp_utc) == event.timestamp_utc
    assert [event.text for event in by_kind[EventKind.USER_MSG]] == ["USER_ALPHA"]
    assert [event.text for event in by_kind[EventKind.ASSISTANT_MSG]] == [
        "ASSISTANT_BETA"
    ]
    assert [event.text for event in by_kind[EventKind.REASONING]] == ["REASONING_GAMMA"]


@pytest.mark.parametrize(("name", "extractor", "snapshot"), CASES)
def test_unknown_fingerprint_has_one_content_safe_quarantine_shape(
    name: str, extractor: object, snapshot: SourceSnapshot
) -> None:
    with pytest.raises(QseshError) as caught:
        extractor.extract(replace(snapshot, schema_fingerprint="unknown-v2"))
    assert caught.value.code == "QS-E-SOURCE-SCHEMA"
    assert caught.value.phase == f"{name}-schema-fingerprint"
    assert "USER_ALPHA" not in str(caught.value)


def test_reported_metric_differences_are_preserved_without_cross_harness_filling() -> (
    None
):
    metrics: dict[str, list[dict[str, object]]] = {}
    for name, extractor, snapshot in CASES:
        metrics[name] = [
            event.data
            for event in extractor.extract(snapshot).events
            if event.data.get("meta_type") in {"usage", "cost"}
        ]
    assert [event["meta_type"] for event in metrics["claude"]] == ["usage"]
    assert metrics["codex"] == []
    assert [event["meta_type"] for event in metrics["opencode"]] == [
        "usage",
        "cost",
        "usage",
        "cost",
    ]
    assert all(
        event["source"] in {"claude", "opencode"}
        for event in metrics["claude"] + metrics["opencode"]
    )
    assert all(
        "unit" in event and "model" in event
        for event in metrics["claude"] + metrics["opencode"]
    )


def test_joined_extractors_have_no_distillation_storage_or_source_adapter_imports() -> (
    None
):
    root = Path(__file__).parents[1] / "qsesh/extractors"
    source = "\n".join(
        (root / name).read_text()
        for name in ("base.py", "claude.py", "codex.py", "opencode.py")
    )
    for forbidden in (
        "qsesh.archive",
        "qsesh.distill",
        "qsesh.sources",
        "qsesh.store",
        "sqlite3",
    ):
        assert forbidden not in source
