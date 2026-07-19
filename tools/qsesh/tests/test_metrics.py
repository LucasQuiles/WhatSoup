from __future__ import annotations

from types import SimpleNamespace

import pytest
from qsesh.errors import QseshError
from qsesh.jsonio import dumps_json
from qsesh.metrics import (
    METRICS_VERSION,
    count_text,
    inventory_counts,
    render_event,
    size_metrics,
)
from qsesh.model import CanonicalEvent, CleanTurn, EventKind


def make_event(
    kind: EventKind,
    *,
    text: str | None = None,
    data: dict[str, object] | None = None,
    index: int = 0,
) -> CanonicalEvent:
    return CanonicalEvent(
        schema_version=1,
        event_index=index,
        kind=kind,
        timestamp_utc=None,
        text=text,
        data={} if data is None else data,
        source_ref="line:1",
    )


# --- count_text: exact regex semantics, proven against hard-coded vectors ---


def test_count_text_ascii_words_and_punctuation() -> None:
    # "a, b.\nc" -> chars a,',',' ',b,'.','\n',c (7); 2 lines; words a/b/c (3);
    # tokens a , b . c (5) -- punctuation is its own token, whitespace is not.
    assert count_text("a, b.\nc") == {"char": 7, "line": 2, "word": 3, "token": 5}


def test_count_text_cjk_without_spaces_is_one_word_and_one_token() -> None:
    # Adjacent CJK codepoints are all \w, so \w+ merges them into a single run.
    assert count_text("雪国") == {"char": 2, "line": 1, "word": 1, "token": 1}


def test_count_text_cjk_with_space_splits_into_two_words() -> None:
    assert count_text("雪 国") == {"char": 3, "line": 1, "word": 2, "token": 2}


def test_count_text_combining_mark_is_not_a_word_character() -> None:
    # "e" + U+0301 (combining acute accent) + "clair": the combining mark is
    # not \w, so it breaks the word run and becomes its own token.
    text = "éclair"
    assert count_text(text) == {"char": 7, "line": 1, "word": 2, "token": 3}


def test_count_text_multiline_counts_lines_and_words_per_splitlines() -> None:
    assert count_text("ab\ncd\nef") == {"char": 8, "line": 3, "word": 3, "token": 3}


def test_count_text_trailing_newline_does_not_add_an_extra_line() -> None:
    assert count_text("ab\n") == {"char": 3, "line": 1, "word": 1, "token": 1}


def test_count_text_emoji_is_a_token_but_not_a_word_character() -> None:
    assert count_text("hi \U0001f389!") == {
        "char": 5,
        "line": 1,
        "word": 1,
        "token": 3,
    }


def test_count_text_empty_string_is_all_zero() -> None:
    assert count_text("") == {"char": 0, "line": 0, "word": 0, "token": 0}


# --- render_event: one exact-string test per kind ---


def test_render_session_meta_uses_text_or_empty_string() -> None:
    assert render_event(make_event(EventKind.SESSION_META, text="v1")) == "v1"
    assert render_event(make_event(EventKind.SESSION_META, text=None)) == ""


def test_render_user_msg_uses_text_verbatim() -> None:
    event = make_event(EventKind.USER_MSG, text="hello there")
    assert render_event(event) == "hello there"


def test_render_assistant_msg_uses_text_verbatim() -> None:
    event = make_event(EventKind.ASSISTANT_MSG, text="hi back")
    assert render_event(event) == "hi back"


def test_render_reasoning_uses_text_verbatim() -> None:
    event = make_event(EventKind.REASONING, text="thinking it through")
    assert render_event(event) == "thinking it through"


def test_render_tool_call_joins_name_and_dumps_json_input() -> None:
    event = make_event(
        EventKind.TOOL_CALL,
        data={"name": "edit", "input": {"path": "a.py", "line": 3}},
    )
    expected = "edit\n" + dumps_json({"path": "a.py", "line": 3})
    assert render_event(event) == expected
    assert render_event(event) == 'edit\n{"line":3,"path":"a.py"}'


def test_render_tool_result_dumps_json_result() -> None:
    event = make_event(EventKind.TOOL_RESULT, data={"result": {"ok": True, "code": 0}})
    assert render_event(event) == dumps_json({"ok": True, "code": 0})
    assert render_event(event) == '{"code":0,"ok":true}'


def test_render_skill_invocation_prefixes_invoked_slash() -> None:
    event = make_event(EventKind.SKILL_INVOCATION, data={"name": "brainstorming"})
    assert render_event(event) == "invoked /brainstorming"


def test_render_subagent_activity_joins_agent_and_text_or_empty() -> None:
    with_text = make_event(
        EventKind.SUBAGENT_ACTIVITY, text="did the thing", data={"agent": "guppy"}
    )
    assert render_event(with_text) == "guppy\ndid the thing"
    without_text = make_event(
        EventKind.SUBAGENT_ACTIVITY, text=None, data={"agent": "guppy"}
    )
    assert render_event(without_text) == "guppy\n"


def test_render_compaction_uses_text_or_empty_string() -> None:
    assert render_event(make_event(EventKind.COMPACTION, text="compacted")) == (
        "compacted"
    )
    assert render_event(make_event(EventKind.COMPACTION, text=None)) == ""


def test_render_meta_uses_text_or_empty_string() -> None:
    assert render_event(make_event(EventKind.META, text="note")) == "note"
    assert render_event(make_event(EventKind.META, text=None)) == ""


# --- render_event: fail-closed per-kind rejections ---


def test_render_user_msg_none_text_fails_closed() -> None:
    with pytest.raises(QseshError) as excinfo:
        render_event(make_event(EventKind.USER_MSG, text=None))
    assert excinfo.value.code == "QS-E-DISTILL"


def test_render_assistant_msg_none_text_fails_closed() -> None:
    with pytest.raises(QseshError) as excinfo:
        render_event(make_event(EventKind.ASSISTANT_MSG, text=None))
    assert excinfo.value.code == "QS-E-DISTILL"


def test_render_reasoning_none_text_fails_closed() -> None:
    with pytest.raises(QseshError) as excinfo:
        render_event(make_event(EventKind.REASONING, text=None))
    assert excinfo.value.code == "QS-E-DISTILL"


def test_render_tool_call_missing_or_non_dict_input_fails_closed() -> None:
    missing_input = make_event(EventKind.TOOL_CALL, data={"name": "edit"})
    with pytest.raises(QseshError) as excinfo:
        render_event(missing_input)
    assert excinfo.value.code == "QS-E-DISTILL"

    non_dict_input = make_event(
        EventKind.TOOL_CALL, data={"name": "edit", "input": "not-a-dict"}
    )
    with pytest.raises(QseshError) as excinfo:
        render_event(non_dict_input)
    assert excinfo.value.code == "QS-E-DISTILL"


def test_render_tool_call_non_str_or_missing_name_fails_closed() -> None:
    non_str_name = make_event(EventKind.TOOL_CALL, data={"name": 7, "input": {}})
    with pytest.raises(QseshError) as excinfo:
        render_event(non_str_name)
    assert excinfo.value.code == "QS-E-DISTILL"

    missing_name = make_event(EventKind.TOOL_CALL, data={"input": {}})
    with pytest.raises(QseshError) as excinfo:
        render_event(missing_name)
    assert excinfo.value.code == "QS-E-DISTILL"


def test_render_tool_result_missing_result_fails_closed() -> None:
    with pytest.raises(QseshError) as excinfo:
        render_event(make_event(EventKind.TOOL_RESULT, data={}))
    assert excinfo.value.code == "QS-E-DISTILL"


def test_render_skill_invocation_missing_or_empty_or_non_str_name_fails_closed() -> (
    None
):
    for data in ({}, {"name": ""}, {"name": 5}):
        with pytest.raises(QseshError) as excinfo:
            render_event(make_event(EventKind.SKILL_INVOCATION, data=data))
        assert excinfo.value.code == "QS-E-DISTILL"


def test_render_subagent_activity_missing_or_non_str_agent_fails_closed() -> None:
    for data in ({}, {"agent": 5}):
        with pytest.raises(QseshError) as excinfo:
            render_event(make_event(EventKind.SUBAGENT_ACTIVITY, text="x", data=data))
        assert excinfo.value.code == "QS-E-DISTILL"


def test_render_event_unknown_kind_fails_closed() -> None:
    # EventKind is a closed 10-member enum, so this branch is unreachable via a
    # real CanonicalEvent (construction validates kind is an EventKind member).
    # Prove the defensive default branch by duck-typing a stand-in whose .kind
    # is not present in the internal dispatch table.
    stand_in = SimpleNamespace(kind="not-a-real-kind", text=None, data={})
    with pytest.raises(QseshError) as excinfo:
        render_event(stand_in)  # type: ignore[arg-type]
    assert excinfo.value.code == "QS-E-DISTILL"


# --- size_metrics ---


def test_size_metrics_content_by_kind_has_all_ten_kinds_zeroed_when_absent() -> None:
    result = size_metrics((), (), b"", 0)
    assert set(result["content_by_kind"]) == {member.value for member in EventKind}
    for bucket in result["content_by_kind"].values():
        assert bucket == {"char": 0, "line": 0, "word": 0, "token": 0}


def test_size_metrics_content_original_equals_sum_of_content_by_kind() -> None:
    events = (
        make_event(EventKind.USER_MSG, text="hi", index=0),
        make_event(EventKind.ASSISTANT_MSG, text="there!", index=1),
    )
    result = size_metrics(events, (), b"", 0)
    by_kind = result["content_by_kind"]
    for dimension in ("char", "line", "word", "token"):
        expected = sum(bucket[dimension] for bucket in by_kind.values())
        assert result["content_original"][dimension] == expected
    assert by_kind["user_msg"] == count_text("hi")
    assert by_kind["assistant_msg"] == count_text("there!")


def test_size_metrics_content_clean_sums_turns_with_no_separator() -> None:
    turns = (
        CleanTurn(turn_index=0, role="user", timestamp_utc=None, text="ab"),
        CleanTurn(turn_index=1, role="assistant", timestamp_utc=None, text="cd"),
    )
    result = size_metrics((), turns, b"", 0)
    # "ab" + "cd" joined with a separator would be char=5; the contract
    # requires the per-turn sum, not a joined string, so char must be 4.
    assert result["content_clean"] == {"char": 4, "line": 2, "word": 2, "token": 2}


def test_size_metrics_empty_clean_turn_contributes_zero() -> None:
    turns = (
        CleanTurn(turn_index=0, role="user", timestamp_utc=None, text="ab"),
        CleanTurn(turn_index=1, role="assistant", timestamp_utc=None, text=""),
        CleanTurn(turn_index=2, role="user", timestamp_utc=None, text="cd"),
    )
    result = size_metrics((), turns, b"", 0)
    assert result["content_clean"] == {"char": 4, "line": 2, "word": 2, "token": 2}


def test_size_metrics_raw_source_uses_bytes_splitlines_without_decoding() -> None:
    # Deliberately invalid UTF-8; must be handled via bytes.splitlines(), never
    # decoded, and must not raise.
    raw = b"\xff\xfe\nabc"
    result = size_metrics((), (), raw, 5)
    assert result["raw_source"] == {
        "bytes": len(raw),
        "gzip_bytes": 5,
        "line": len(raw.splitlines()),
    }
    assert result["raw_source"]["line"] == 2


def test_size_metrics_gzip_bytes_threaded_through_unchanged() -> None:
    result = size_metrics((), (), b"data", 42)
    assert result["raw_source"]["gzip_bytes"] == 42


def test_size_metrics_reports_metrics_version() -> None:
    result = size_metrics((), (), b"", 0)
    assert result["metrics_version"] == METRICS_VERSION


def test_size_metrics_rejects_negative_or_bool_gzip_bytes() -> None:
    for bad_gzip_bytes in (-1, True, False):
        with pytest.raises(QseshError) as excinfo:
            size_metrics((), (), b"", bad_gzip_bytes)
        assert excinfo.value.code == "QS-E-DISTILL"


def test_size_metrics_rejects_non_bytes_raw_source() -> None:
    with pytest.raises(QseshError) as excinfo:
        size_metrics((), (), "not-bytes", 0)  # type: ignore[arg-type]
    assert excinfo.value.code == "QS-E-DISTILL"


# --- inventory_counts ---


def test_inventory_counts_splits_native_and_mcp_tools() -> None:
    tools = (
        {"call_ids": ["c1", "c2"], "count": 2, "is_mcp": False, "name": "edit"},
        {"call_ids": ["c3"], "count": 1, "is_mcp": False, "name": "read"},
        {
            "call_ids": ["c4", "c5", "c6"],
            "count": 3,
            "is_mcp": True,
            "name": "mcp__pinecone__search-records",
        },
        {
            "call_ids": ["c7"],
            "count": 1,
            "is_mcp": True,
            "name": "mcp__pinecone__list-indexes",
        },
        {
            "call_ids": ["c8", "c9"],
            "count": 2,
            "is_mcp": True,
            "name": "mcp__email__email_send",
        },
    )
    result = inventory_counts(tools, (), (), (), ())
    assert result["native_tools"] == {"unique": 2, "total": 3}
    assert result["mcp_tools"] == {"unique": 3, "total": 6}
    assert result["mcp_servers"] == {"unique": 2, "total": 6}
    assert result["mcp_servers"]["total"] == result["mcp_tools"]["total"]

    controlled_total_calls = sum(tool["count"] for tool in tools)
    assert (
        result["native_tools"]["total"] + result["mcp_tools"]["total"]
        == controlled_total_calls
    )


def test_inventory_counts_malformed_mcp_name_too_few_parts_fails_closed() -> None:
    tools = ({"call_ids": ["c1"], "count": 1, "is_mcp": True, "name": "mcp__badonly"},)
    with pytest.raises(QseshError) as excinfo:
        inventory_counts(tools, (), (), (), ())
    assert excinfo.value.code == "QS-E-DISTILL"


def test_inventory_counts_malformed_mcp_name_empty_server_segment_fails_closed() -> (
    None
):
    tools = ({"call_ids": ["c1"], "count": 1, "is_mcp": True, "name": "mcp____tool"},)
    with pytest.raises(QseshError) as excinfo:
        inventory_counts(tools, (), (), (), ())
    assert excinfo.value.code == "QS-E-DISTILL"


def test_inventory_counts_malformed_mcp_name_empty_tool_segment_fails_closed() -> None:
    tools = ({"call_ids": ["c1"], "count": 1, "is_mcp": True, "name": "mcp__srv__"},)
    with pytest.raises(QseshError) as excinfo:
        inventory_counts(tools, (), (), (), ())
    assert excinfo.value.code == "QS-E-DISTILL"


def test_inventory_counts_non_boolean_is_mcp_fails_closed() -> None:
    # is_mcp must be exactly True or False (identity, not truthiness). Anything
    # else -- None, a truthy int, a string -- must fail closed rather than be
    # silently dropped, which would break the conservation invariant
    # native_tools.total + mcp_tools.total == total tool-call count.
    for bad_is_mcp in (None, 1, "true"):
        tools = (
            {"call_ids": ["c1"], "count": 1, "is_mcp": bad_is_mcp, "name": "edit"},
        )
        with pytest.raises(QseshError) as excinfo:
            inventory_counts(tools, (), (), (), ())
        assert excinfo.value.code == "QS-E-DISTILL"
        assert excinfo.value.phase == "metrics-inventory-is-mcp"


def test_inventory_counts_skills_files_subagents_compactions() -> None:
    skills = (
        {"count": 2, "name": "brainstorming"},
        {"count": 1, "name": "tdd"},
    )
    files = ({"count": 4, "path": "a.py"},)
    subagents = ({"agent": "guppy", "count": 2, "sidechain_count": 1},)
    compactions = ({"count": 1, "event_indices": [3], "reasons": ["manual"]},)

    result = inventory_counts((), skills, files, subagents, compactions)
    assert result["skills"] == {"unique": 2, "total": 3}
    assert result["files"] == {"unique": 1, "total": 4}
    assert result["subagents"] == {"unique": 1, "total": 2}
    assert result["compactions"] == {"unique": 1, "total": 1}
    for category in (
        "native_tools",
        "mcp_tools",
        "mcp_servers",
        "skills",
        "subagents",
        "files",
        "compactions",
    ):
        assert 0 <= result[category]["unique"] <= result[category]["total"]


def test_inventory_counts_empty_inventories_are_all_zero() -> None:
    result = inventory_counts((), (), (), (), ())
    for category in (
        "native_tools",
        "mcp_tools",
        "mcp_servers",
        "skills",
        "subagents",
        "files",
        "compactions",
    ):
        assert result[category] == {"unique": 0, "total": 0}
    assert result["metrics_version"] == METRICS_VERSION


def test_inventory_counts_compactions_zero_or_one_record() -> None:
    result_zero = inventory_counts((), (), (), (), ())
    assert result_zero["compactions"] == {"unique": 0, "total": 0}
    result_one = inventory_counts(
        (), (), (), (), ({"count": 1, "event_indices": [0], "reasons": []},)
    )
    assert result_one["compactions"] == {"unique": 1, "total": 1}
