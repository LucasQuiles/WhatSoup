from __future__ import annotations

import json
from dataclasses import FrozenInstanceError
from io import StringIO

import pytest
from qsesh.jsonio import dump_jsonl, dumps_json, load_json_object, write_stdout_document
from qsesh.model import (
    ArchiveRef,
    CanonicalEvent,
    CleanTurn,
    DistilledSession,
    EventKind,
    ExtractedSession,
    FileStamp,
    Harness,
    SourceCandidate,
    SourceSnapshot,
)


def make_candidate() -> SourceCandidate:
    return SourceCandidate(
        host_id="fixture-host",
        harness=Harness.CLAUDE,
        native_id="session-claude-001",
        source_key="source-claude-001",
        updated_at_us=1_767_341_045_000_000,
        file_stamp=FileStamp(device=1, inode=2, size=3, mtime_ns=4, ctime_ns=5),
    )


def make_snapshot() -> SourceSnapshot:
    return SourceSnapshot(
        candidate=make_candidate(),
        raw_bytes=b"{}\n",
        source_digest="a" * 64,
        schema_fingerprint="b" * 64,
        harness_version="1.0.0",
    )


def make_event(index: int = 0) -> CanonicalEvent:
    return CanonicalEvent(
        schema_version=1,
        event_index=index,
        kind=EventKind.USER_MSG,
        timestamp_utc="2026-01-02T08:04:05Z",
        text="USER_ALPHA",
        data={"nested": [None, True, 7, 1.5, "雪", {"ok": False}]},
        source_ref="line:1",
    )


def test_harness_and_event_kind_values_are_exact() -> None:
    assert [member.value for member in Harness] == ["claude", "codex", "opencode"]
    assert [member.value for member in EventKind] == [
        "session_meta",
        "user_msg",
        "assistant_msg",
        "reasoning",
        "tool_call",
        "tool_result",
        "skill_invocation",
        "subagent_activity",
        "compaction",
        "meta",
    ]
    assert Harness("claude") is Harness.CLAUDE
    assert EventKind("tool_call") is EventKind.TOOL_CALL


def test_every_binding_dataclass_is_frozen_and_slotted() -> None:
    event = make_event()
    turn = CleanTurn(
        turn_index=0,
        role="user",
        timestamp_utc="2026-01-02T08:04:05Z",
        text="USER_ALPHA",
    )
    instances = (
        FileStamp(device=1, inode=2, size=3, mtime_ns=4, ctime_ns=5),
        make_candidate(),
        make_snapshot(),
        event,
        ExtractedSession(snapshot=make_snapshot(), events=(event,)),
        turn,
        DistilledSession(
            record={"title": "USER_ALPHA"},
            turns=(turn,),
            tools=({"name": "mcp__fixture__lookup"},),
            skills=({"name": "brainstorming"},),
            files=({"path": "src/example.py"},),
            subagents=({"agent": "fixture-agent"},),
            compactions=({"event_index": 7},),
        ),
        ArchiveRef(
            relpath="archive/claude/session.jsonl.gz",
            sha256="c" * 64,
            source_digest="a" * 64,
            byte_count=17,
        ),
    )
    for instance in instances:
        assert not hasattr(instance, "__dict__")
        with pytest.raises((FrozenInstanceError, AttributeError, TypeError)):
            instance.unexpected = "mutation"  # type: ignore[attr-defined]


def test_file_stamp_and_count_fields_reject_bool_negative_and_wrong_types() -> None:
    invalid_builders = (
        lambda: FileStamp(device=True, inode=2, size=3, mtime_ns=4, ctime_ns=5),
        lambda: FileStamp(device=1, inode=2, size=-1, mtime_ns=4, ctime_ns=5),
        lambda: SourceCandidate(
            host_id="fixture-host",
            harness=Harness.CLAUDE,
            native_id="session-claude-001",
            source_key="source-claude-001",
            updated_at_us=False,
            file_stamp=None,
        ),
        lambda: CanonicalEvent(
            schema_version=True,
            event_index=0,
            kind=EventKind.META,
            timestamp_utc=None,
            text=None,
            data={},
            source_ref="line:1",
        ),
        lambda: CleanTurn(
            turn_index=-1,
            role="user",
            timestamp_utc=None,
            text="USER_ALPHA",
        ),
        lambda: ArchiveRef(
            relpath="archive/session.jsonl.gz",
            sha256="c" * 64,
            source_digest="a" * 64,
            byte_count=True,
        ),
    )
    for build in invalid_builders:
        with pytest.raises((TypeError, ValueError)):
            build()


def test_source_candidate_requires_enum_strings_and_optional_stamp() -> None:
    candidate = SourceCandidate(
        host_id="fixture-host",
        harness=Harness.OPENCODE,
        native_id="ses_opencode_001",
        source_key="source-opencode-001",
        updated_at_us=0,
        file_stamp=None,
    )
    assert candidate.harness is Harness.OPENCODE
    assert candidate.file_stamp is None
    with pytest.raises(TypeError):
        SourceCandidate(
            host_id="fixture-host",
            harness="opencode",  # type: ignore[arg-type]
            native_id="ses_opencode_001",
            source_key="source-opencode-001",
            updated_at_us=0,
            file_stamp=None,
        )


def test_source_snapshot_requires_bytes_candidate_and_optional_version() -> None:
    snapshot = SourceSnapshot(
        candidate=make_candidate(),
        raw_bytes=b"fixture",
        source_digest="a" * 64,
        schema_fingerprint="b" * 64,
        harness_version=None,
    )
    assert snapshot.raw_bytes == b"fixture"
    assert snapshot.harness_version is None
    with pytest.raises(TypeError):
        SourceSnapshot(
            candidate=make_candidate(),
            raw_bytes=bytearray(b"fixture"),  # type: ignore[arg-type]
            source_digest="a" * 64,
            schema_fingerprint="b" * 64,
            harness_version=None,
        )


def test_canonical_event_accepts_nested_json_and_rejects_invalid_values() -> None:
    event = make_event()
    assert event.data["nested"] == [None, True, 7, 1.5, "雪", {"ok": False}]
    invalid_values = (
        {"bad": float("nan")},
        {"bad": float("inf")},
        {"bad": {1: "non-string-key"}},
        {"bad": b"bytes"},
        {"bad": {"set"}},
    )
    for data in invalid_values:
        with pytest.raises((TypeError, ValueError)):
            CanonicalEvent(
                schema_version=1,
                event_index=0,
                kind=EventKind.META,
                timestamp_utc=None,
                text=None,
                data=data,  # type: ignore[arg-type]
                source_ref="line:1",
            )


def test_canonical_event_requires_enum_and_required_fields() -> None:
    with pytest.raises(TypeError):
        CanonicalEvent(  # type: ignore[call-arg]
            schema_version=1,
            event_index=0,
            kind=EventKind.META,
            timestamp_utc=None,
            text=None,
            data={},
        )
    with pytest.raises(TypeError):
        CanonicalEvent(
            schema_version=1,
            event_index=0,
            kind="meta",  # type: ignore[arg-type]
            timestamp_utc=None,
            text=None,
            data={},
            source_ref="line:1",
        )


def test_extracted_session_requires_contiguous_ordered_event_indices() -> None:
    session = ExtractedSession(
        snapshot=make_snapshot(),
        events=(make_event(0), make_event(1)),
    )
    assert [event.event_index for event in session.events] == [0, 1]
    for events in (
        (make_event(1),),
        (make_event(0), make_event(0)),
        (make_event(1), make_event(0)),
    ):
        with pytest.raises(ValueError):
            ExtractedSession(snapshot=make_snapshot(), events=events)
    with pytest.raises(TypeError):
        ExtractedSession(snapshot=make_snapshot(), events=[make_event()])  # type: ignore[arg-type]


def test_clean_turn_validates_role_text_timestamp_and_index() -> None:
    turn = CleanTurn(
        turn_index=0,
        role="assistant",
        timestamp_utc=None,
        text="ASSISTANT_BETA",
    )
    assert turn.role == "assistant"
    with pytest.raises(ValueError):
        CleanTurn(
            turn_index=0,
            role="system",  # type: ignore[arg-type]
            timestamp_utc=None,
            text="ASSISTANT_BETA",
        )


def test_distilled_session_validates_every_json_inventory() -> None:
    turn = CleanTurn(turn_index=0, role="user", timestamp_utc=None, text="USER_ALPHA")
    session = DistilledSession(
        record={"tokens": {"input": 7}, "cost": None},
        turns=(turn,),
        tools=({"count": 1},),
        skills=(),
        files=(),
        subagents=(),
        compactions=(),
    )
    assert session.record["tokens"] == {"input": 7}
    with pytest.raises(ValueError):
        DistilledSession(
            record={"cost": float("-inf")},
            turns=(turn,),
            tools=(),
            skills=(),
            files=(),
            subagents=(),
            compactions=(),
        )


def test_archive_ref_validates_nonempty_strings_and_byte_count() -> None:
    archive = ArchiveRef(
        relpath="archive/codex/session.jsonl.gz",
        sha256="c" * 64,
        source_digest="a" * 64,
        byte_count=0,
    )
    assert archive.byte_count == 0
    with pytest.raises(ValueError):
        ArchiveRef(relpath="", sha256="c" * 64, source_digest="a" * 64, byte_count=0)


def test_dumps_json_is_compact_sorted_unicode_and_has_no_lf() -> None:
    rendered = dumps_json({"z": "雪", "a": [True, None, 1, 1.5]})
    assert rendered == '{"a":[true,null,1,1.5],"z":"雪"}'
    assert "\n" not in rendered


def test_dumps_json_rejects_nonfinite_unserializable_and_non_string_keys() -> None:
    invalid_values = (
        {"bad": float("nan")},
        {"bad": float("inf")},
        {"bad": object()},
        {1: "bad-key"},
    )
    for value in invalid_values:
        with pytest.raises((TypeError, ValueError)):
            dumps_json(value)  # type: ignore[arg-type]


def test_json_values_reject_container_cycles_deterministically() -> None:
    cyclic_list: list[object] = []
    cyclic_list.append(cyclic_list)
    with pytest.raises(ValueError, match="cycle"):
        dumps_json(cyclic_list)  # type: ignore[arg-type]

    cyclic_object: dict[str, object] = {}
    cyclic_object["self"] = cyclic_object
    with pytest.raises(ValueError, match="cycle"):
        CanonicalEvent(
            schema_version=1,
            event_index=0,
            kind=EventKind.META,
            timestamp_utc=None,
            text=None,
            data=cyclic_object,  # type: ignore[arg-type]
            source_ref="line:1",
        )


def test_dump_jsonl_preserves_input_order_and_appends_one_lf_per_document() -> None:
    rendered = dump_jsonl(({"b": 2, "a": 1}, {"text": "雪"}))
    assert rendered == b'{"a":1,"b":2}\n{"text":"\xe9\x9b\xaa"}\n'
    assert rendered.count(b"\n") == 2
    assert dump_jsonl(()) == b""


def test_dump_jsonl_validates_all_documents_before_returning_bytes() -> None:
    with pytest.raises(ValueError):
        dump_jsonl(({"ok": 1}, {"bad": float("nan")}))


def test_load_json_object_accepts_utf8_bytes_and_text() -> None:
    expected = {"a": 1, "text": "雪"}
    assert load_json_object(b'{"text":"\xe9\x9b\xaa","a":1}') == expected
    assert load_json_object('{"a":1,"text":"雪"}') == expected


def test_canonical_json_roundtrip_preserves_nested_values() -> None:
    value = {"a": [None, True, 7, 1.5, "雪", {"ok": False}], "z": "last"}
    assert load_json_object(dumps_json(value)) == value


def test_load_json_object_rejects_duplicates_nonobjects_and_two_documents() -> None:
    invalid_documents = (
        '{"a":1,"a":2}',
        "[]",
        '{"a":1}\n{"b":2}',
        '{"bad":NaN}',
        '{"bad":Infinity}',
    )
    for document in invalid_documents:
        with pytest.raises((TypeError, ValueError, json.JSONDecodeError)):
            load_json_object(document)


def test_load_json_object_rejects_invalid_utf8() -> None:
    with pytest.raises(UnicodeDecodeError):
        load_json_object(b'{"bad":"\xff"}')


def test_only_write_stdout_document_emits_one_complete_stdout_document(
    capsys: pytest.CaptureFixture[str],
) -> None:
    dumps_json({"a": 1})
    dump_jsonl(({"a": 1},))
    load_json_object('{"a":1}')
    before = capsys.readouterr()
    assert before.out == ""
    assert before.err == ""

    result = write_stdout_document({"z": "雪", "a": 1})

    after = capsys.readouterr()
    assert result is None
    assert after.out == '{"a":1,"z":"雪"}\n'
    assert after.out.count("\n") == 1
    assert json.loads(after.out) == {"a": 1, "z": "雪"}
    assert after.err == ""


def test_write_stdout_document_validates_before_writing_any_bytes(
    capsys: pytest.CaptureFixture[str],
) -> None:
    invalid_documents = (
        [{"first": 1}, {"second": 2}],
        {"bad": float("nan")},
        {"bad": object()},
    )
    for document in invalid_documents:
        with pytest.raises((TypeError, ValueError)):
            write_stdout_document(document)  # type: ignore[arg-type]
        captured = capsys.readouterr()
        assert captured.out == ""
        assert captured.err == ""


def test_write_stdout_document_supports_an_injected_text_stream() -> None:
    stream = StringIO()
    result = write_stdout_document({"ok": True}, stdout=stream)
    assert result is None
    assert stream.getvalue() == '{"ok":true}\n'
