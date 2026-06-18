#!/usr/bin/env python3
"""Tests for cache_stable_prefix_auditor.

No pytest fixtures: each test builds its own tempfiles and uses manual setattr+try/finally
where it patches module state. Covers happy-path outcome shape, unhappy paths (malformed
capture / missing file / no-init / single-capture / malformed section artifact), a
determinism replay, and a CLI e2e subprocess covering the __main__ entrypoint.
"""
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cache_stable_prefix_auditor as probe  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "cache_stable_prefix_auditor.py"


def _init_line(model, perm, tools):
    return json.dumps({"type": "init", "model": model, "permissionMode": perm, "tools": tools})


def _write(tmp, name, text):
    path = Path(tmp) / name
    path.write_text(text, encoding="utf-8")
    return path


def test_happy_path_stable_captures_outcome_shape():
    with tempfile.TemporaryDirectory() as tmp:
        line = _init_line("claude-x", "default", ["Read", "Bash", "mcp__srv__do"])
        a = _write(tmp, "a.jsonl", line + "\n")
        b = _write(tmp, "b.jsonl", line + "\n")
        report = probe.build_report([a, b])
    assert report["schema"] == "agent-runtime-cache-stable-prefix-auditor"
    assert report["schema_version"] == "0.1"
    assert "redaction" in report
    assert report["capture_count"] == 2
    cap0 = report["captures"][0]
    assert cap0["parse_status"] == "ok"
    assert cap0["init_found"] is True
    assert cap0["tool_count"] == 3
    assert cap0["mcp_tool_count"] == 1
    assert cap0["core_tool_count"] == 2
    assert len(cap0["tool_name_hashes"]) == 3
    cross = report["cross_capture"]
    assert cross["model_churn"] is False
    assert cross["permission_churn"] is False
    assert cross["tool_set_churn"] is False
    assert cross["verdict"] == "init_surface_stable"
    assert cross["cache_stability_risk"] == "stable_across_captures"
    assert report["section_artifact_provided"] is False
    assert report["stats_capture_provided"] is False


def test_churn_carries_triggering_datum():
    with tempfile.TemporaryDirectory() as tmp:
        a = _write(tmp, "a.jsonl", _init_line("claude-x", "default", ["Read", "Bash"]) + "\n")
        b = _write(tmp, "b.jsonl", _init_line("claude-y", "plan", ["Read", "Edit"]) + "\n")
        report = probe.build_report([a, b])
    cross = report["cross_capture"]
    assert cross["model_churn"] is True
    assert cross["permission_churn"] is True
    assert cross["tool_set_churn"] is True
    # every churn flag carries its datum: the differing capture index and the hash sets
    assert cross["first_differing_capture_index"] == 1
    assert cross["added_tool_hashes"]  # Edit added
    assert cross["removed_tool_hashes"]  # Bash removed
    assert cross["verdict"] == "prefix_churn_detected"
    assert cross["cache_stability_risk"] == "churn_detected"


def test_section_artifact_mode_emits_offsets_and_volatility():
    with tempfile.TemporaryDirectory() as tmp:
        line = _init_line("claude-x", "default", ["Read"])
        a = _write(tmp, "a.jsonl", line + "\n")
        b = _write(tmp, "b.jsonl", line + "\n")
        artifact = {
            "sections": [
                {"name": "system", "content": "AAAA", "volatility_class": "stable",
                 "source_provenance": "caller_redacted"},
                {"name": "memory", "content": "BBBBBB", "volatility_class": "volatile",
                 "source_provenance": "caller_redacted"},
            ]
        }
        sec = _write(tmp, "sections.json", json.dumps(artifact))
        report = probe.build_report([a, b], section_path=sec)
    assert report["section_artifact_provided"] is True
    sa = report["section_artifact"]
    assert sa["section_artifact_status"] == "ok"
    assert sa["section_count"] == 2
    assert sa["sections"][0]["byte_count"] == 4
    assert sa["sections"][1]["canonical_offset"] == 4
    assert sa["volatile_section_names"] == ["memory"]
    assert "not_provider_prefix" in sa["offset_scope"]


def test_cache_report_from_stats_capture():
    stats = (
        "OVERVIEW\nSessions 3\n"
        "COST & TOKENS\nInput 1,000\nOutput 200\nCache Read 4,000\nCache Write 50\n"
    )
    with tempfile.TemporaryDirectory() as tmp:
        line = _init_line("claude-x", "default", ["Read"])
        a = _write(tmp, "a.jsonl", line + "\n")
        b = _write(tmp, "b.jsonl", line + "\n")
        st = _write(tmp, "stats.txt", stats)
        report = probe.build_report([a, b], stats_path=st)
    assert report["stats_capture_provided"] is True
    cache = report["cache"]
    assert cache["cache_status"] == "ok"
    assert cache["read"] == 4000
    assert cache["write"] == 50
    assert cache["read_to_input_ratio"] == 4.0


def test_unhappy_malformed_capture_parse_status_invalid_and_no_init():
    # malformed JSONL lines never coerce to success; a capture with no init -> no_init_found.
    with tempfile.TemporaryDirectory() as tmp:
        bad = _write(tmp, "bad.jsonl", "{not json\nstill not json\n")
        report = probe.build_report([bad])
    cap = report["captures"][0]
    # parses as text but finds no init envelope -> no_init_found, not a silent empty success
    assert cap["parse_status"] == "no_init_found"
    assert cap["init_found"] is False
    assert cap["invalid_json_lines_until_init"] == 2
    # single capture -> cannot diff
    assert report["cross_capture"]["verdict"] == "need_two_captures_for_diff"


def test_unhappy_missing_capture_file_typed_error():
    missing = Path("/nonexistent-xyz-cache-stable/never.jsonl")
    report = probe.build_report([missing])
    cap = report["captures"][0]
    assert cap["parse_status"] == "invalid"
    assert "error_type" in cap
    assert cap["error_type"] in {"FileNotFoundError", "OSError", "IsADirectoryError"}


def test_unhappy_malformed_section_artifact_status_invalid():
    with tempfile.TemporaryDirectory() as tmp:
        line = _init_line("claude-x", "default", ["Read"])
        a = _write(tmp, "a.jsonl", line + "\n")
        b = _write(tmp, "b.jsonl", line + "\n")
        sec = _write(tmp, "broken.json", "{ this is : not json ")
        report = probe.build_report([a, b], section_path=sec)
    sa = report["section_artifact"]
    assert sa["section_artifact_status"] == "invalid"
    assert sa["error_type"] == "JSONDecodeError"


def test_unhappy_section_artifact_unsupported_shape():
    with tempfile.TemporaryDirectory() as tmp:
        line = _init_line("claude-x", "default", ["Read"])
        a = _write(tmp, "a.jsonl", line + "\n")
        b = _write(tmp, "b.jsonl", line + "\n")
        sec = _write(tmp, "noshape.json", json.dumps({"unexpected": True}))
        report = probe.build_report([a, b], section_path=sec)
    sa = report["section_artifact"]
    assert sa["section_artifact_status"] == "unsupported_shape"
    assert sa["missing_field"] == "sections"


def test_unhappy_section_content_not_string():
    with tempfile.TemporaryDirectory() as tmp:
        line = _init_line("claude-x", "default", ["Read"])
        a = _write(tmp, "a.jsonl", line + "\n")
        b = _write(tmp, "b.jsonl", line + "\n")
        artifact = {"sections": [{"name": "system", "content": 123}]}
        sec = _write(tmp, "badcontent.json", json.dumps(artifact))
        report = probe.build_report([a, b], section_path=sec)
    sa = report["section_artifact"]
    assert sa["section_artifact_status"] == "unsupported_shape"
    assert sa["missing_field"] == "content"


def test_section_first_duplicate_detected_on_repeated_name():
    # Intra-artifact scope: the field fires only when a section NAME is DUPLICATED within
    # ONE artifact and its content hash differs from the earlier same-named section. It is
    # NOT a cross-capture diff (the rename makes the single-artifact scope explicit).
    with tempfile.TemporaryDirectory() as tmp:
        line = _init_line("claude-x", "default", ["Read"])
        a = _write(tmp, "a.jsonl", line + "\n")
        b = _write(tmp, "b.jsonl", line + "\n")
        artifact = {"sections": [
            {"name": "system", "content": "AAAA"},
            {"name": "system", "content": "DIFFERENT"},
        ]}
        sec = _write(tmp, "diff.json", json.dumps(artifact))
        report = probe.build_report([a, b], section_path=sec)
    sa = report["section_artifact"]
    assert sa["first_duplicate_section"] == "system"
    assert sa["first_duplicate_section_offset"] == 4
    # the misleading cross-capture-implying names are gone
    assert "first_diff_section" not in sa
    assert "first_diff_offset" not in sa


def test_unhappy_missing_section_artifact_file_invalid():
    with tempfile.TemporaryDirectory() as tmp:
        line = _init_line("claude-x", "default", ["Read"])
        a = _write(tmp, "a.jsonl", line + "\n")
        b = _write(tmp, "b.jsonl", line + "\n")
        # passing the directory itself forces an OSError (IsADirectoryError) on read_text
        report = probe.build_report([a, b], section_path=Path(tmp))
    sa = report["section_artifact"]
    assert sa["section_artifact_status"] == "invalid"
    assert "error_type" in sa


def test_unhappy_section_entry_not_a_dict():
    with tempfile.TemporaryDirectory() as tmp:
        line = _init_line("claude-x", "default", ["Read"])
        a = _write(tmp, "a.jsonl", line + "\n")
        b = _write(tmp, "b.jsonl", line + "\n")
        artifact = {"sections": ["not-a-dict"]}
        sec = _write(tmp, "listentry.json", json.dumps(artifact))
        report = probe.build_report([a, b], section_path=sec)
    sa = report["section_artifact"]
    assert sa["section_artifact_status"] == "unsupported_shape"
    assert sa["missing_field"] == "section_object"


def test_unhappy_missing_stats_capture_file_invalid():
    with tempfile.TemporaryDirectory() as tmp:
        line = _init_line("claude-x", "default", ["Read"])
        a = _write(tmp, "a.jsonl", line + "\n")
        b = _write(tmp, "b.jsonl", line + "\n")
        # passing the directory itself forces an OSError on read_text
        report = probe.build_report([a, b], stats_path=Path(tmp))
    cache = report["cache"]
    assert cache["cache_status"] == "invalid"
    assert "error_type" in cache


def test_unhappy_malformed_stats_capture_not_parsed():
    with tempfile.TemporaryDirectory() as tmp:
        line = _init_line("claude-x", "default", ["Read"])
        a = _write(tmp, "a.jsonl", line + "\n")
        b = _write(tmp, "b.jsonl", line + "\n")
        st = _write(tmp, "junk.txt", "this is not opencode stats output at all")
        report = probe.build_report([a, b], stats_path=st)
    cache = report["cache"]
    assert cache["cache_status"] == "not_parsed"


def test_capture_envelope_exception_yields_parse_status_invalid():
    # Force the inner parser to raise; the handler must emit a typed invalid status, not
    # a silent empty success (fail-closed).
    orig = probe.parse_stream_json
    probe.parse_stream_json = lambda *a, **k: (_ for _ in ()).throw(ValueError("boom"))
    try:
        with tempfile.TemporaryDirectory() as tmp:
            a = _write(tmp, "a.jsonl", "anything\n")
            report = probe.build_report([a])
    finally:
        probe.parse_stream_json = orig
    cap = report["captures"][0]
    assert cap["parse_status"] == "invalid"
    assert cap["error_type"] == "ValueError"


def test_determinism_identical_input_byte_identical_report():
    with tempfile.TemporaryDirectory() as tmp:
        a = _write(tmp, "a.jsonl", _init_line("claude-x", "default", ["Read", "Bash"]) + "\n")
        b = _write(tmp, "b.jsonl", _init_line("claude-y", "plan", ["Read", "Edit"]) + "\n")
        artifact = {"sections": [{"name": "system", "content": "AAAA", "volatility_class": "volatile"}]}
        sec = _write(tmp, "sections.json", json.dumps(artifact))
        st = _write(tmp, "stats.txt", "OVERVIEW\nSessions 3\nCOST & TOKENS\nInput 1,000\nCache Read 4,000\n")
        first = probe.build_report([a, b], section_path=sec, stats_path=st)
        second = probe.build_report([a, b], section_path=sec, stats_path=st)
    # report carries no ts/duration fields; still drop them defensively before comparing
    def _strip(d):
        return {k: v for k, v in d.items() if k not in {"ts", "timestamp_utc", "duration_ms"}}
    assert json.dumps(_strip(first), sort_keys=True) == json.dumps(_strip(second), sort_keys=True)


def test_cli_e2e_emits_valid_json():
    with tempfile.TemporaryDirectory() as tmp:
        line = _init_line("claude-x", "default", ["Read", "Bash"])
        a = _write(tmp, "a.jsonl", line + "\n")
        b = _write(tmp, "b.jsonl", line + "\n")
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--captures", str(a), str(b), "--pretty"],
            capture_output=True, text=True, timeout=30,
        )
    assert proc.returncode == 0
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-cache-stable-prefix-auditor"
    assert report["cross_capture"]["verdict"] == "init_surface_stable"
    assert "honest_scope" in report


def test_main_returns_zero_via_stringio():
    # exercise main() directly for coverage of the argparse/dump path.
    with tempfile.TemporaryDirectory() as tmp:
        line = _init_line("claude-x", "default", ["Read"])
        a = _write(tmp, "a.jsonl", line + "\n")
        b = _write(tmp, "b.jsonl", line + "\n")
        argv = ["prog", "--captures", str(a), str(b)]
        orig = sys.argv
        sys.argv = argv
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = probe.main()
        finally:
            sys.argv = orig
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-cache-stable-prefix-auditor"


def test_unhappy_malformed_lines_in_ordered_scan_surfaced_not_silent():
    """fail-open repair: _ordered_init_tools skips non-JSON lines in the JSONL stream
    (intentional), but the skip must be OBSERVABLE, not a silent fail-open continue.

    A capture with malformed/invalid non-JSON lines preceding the init line must:
      - still recover the init tool order (behavior preserved), AND
      - surface a typed count of the malformed/unparsed lines it skipped.
    """
    with tempfile.TemporaryDirectory() as tmp:
        # two malformed non-JSON lines, a blank line, then a valid init line
        text = (
            "{not json at all\n"
            "still <<< not >>> json\n"
            "\n"
            + _init_line("claude-x", "default", ["Read", "Bash"]) + "\n"
        )
        cap = _write(tmp, "malformed.jsonl", text)
        # direct helper contract: returns (ordered_tools, malformed_line_count)
        tools, malformed = probe._ordered_init_tools(text)
        assert tools  # init tool order still recovered despite malformed lines
        assert malformed == 2  # the two non-JSON lines were counted, not silently dropped

        report = probe.build_report([cap])
    envelope = report["captures"][0]
    assert envelope["parse_status"] == "ok"
    # the malformed/skipped lines are surfaced in the per-capture envelope (observable)
    assert envelope["ordered_scan_malformed_lines"] == 2

    # determinism: identical malformed input yields an identical malformed count
    tools2, malformed2 = probe._ordered_init_tools(text)
    assert (tools2, malformed2) == (tools, malformed)


def test_breakpoint_moved_false_on_pure_append():
    """Bead 0.5: capture B is A plus an appended tool whose hash sorts after all of A's
    hashes — prefix region byte-identical (sorted hash list is a pure positional prefix).
    breakpoint_moved must be False and first_moved_block_index must be None.

    LS (sha256_16 starts with 'e6...') sorts after Read ('9b...') and Bash ('d1...'),
    so adding LS produces [Read-hash, Bash-hash, LS-hash] — A's hashes stay at indices
    0 and 1 unchanged."""
    with tempfile.TemporaryDirectory() as tmp:
        a = _write(tmp, "a.jsonl", _init_line("claude-x", "default", ["Read", "Bash"]) + "\n")
        b = _write(tmp, "b.jsonl", _init_line("claude-x", "default", ["Read", "Bash", "LS"]) + "\n")
        report = probe.build_report([a, b])
    cross = report["cross_capture"]
    assert cross["breakpoint_moved"] is False
    assert cross["first_moved_block_index"] is None
    # tool_set_churn is True (LS added), but the prefix region was not re-templated
    assert cross["tool_set_churn"] is True


def test_breakpoint_moved_true_on_retemplate():
    """Bead 0.5: capture B swaps a tool from the prefix region (re-template / shift).
    breakpoint_moved must be True and first_moved_block_index must be 0 (first mismatch)."""
    with tempfile.TemporaryDirectory() as tmp:
        # A has [Bash, Read] sorted hashes; B replaces Bash with Edit — prefix diverges at index 0
        a = _write(tmp, "a.jsonl", _init_line("claude-x", "default", ["Bash", "Read"]) + "\n")
        b = _write(tmp, "b.jsonl", _init_line("claude-x", "default", ["Edit", "Read"]) + "\n")
        report = probe.build_report([a, b])
    cross = report["cross_capture"]
    assert cross["breakpoint_moved"] is True
    assert isinstance(cross["first_moved_block_index"], int)
    assert cross["first_moved_block_index"] == 0


def test_breakpoint_moved_edge_identical_captures():
    """Bead 0.5 edge: identical captures → breakpoint_moved False, index None."""
    with tempfile.TemporaryDirectory() as tmp:
        line = _init_line("claude-x", "default", ["Read", "Bash"])
        a = _write(tmp, "a.jsonl", line + "\n")
        b = _write(tmp, "b.jsonl", line + "\n")
        report = probe.build_report([a, b])
    cross = report["cross_capture"]
    assert cross["breakpoint_moved"] is False
    assert cross["first_moved_block_index"] is None


def test_breakpoint_moved_true_on_reorder_same_tool_set():
    """H1 REGRESSION: capture B has IDENTICAL tool membership to A but in a different
    PROVIDER ORDER (re-template / reorder of the same set). The sorted hash list is
    byte-identical between A and B, so the old set/sorted-based invariant reported
    breakpoint_moved=False — a FALSE NEGATIVE that missed the exact re-template event
    the breakpoint invariant exists to catch.

    With provider order tracked via ordered_tool_name_hashes, A's order
    [Read, Bash] and B's order [Bash, Read] diverge at index 0, so breakpoint_moved
    must be True. tool_set_churn stays False (membership is unchanged)."""
    with tempfile.TemporaryDirectory() as tmp:
        a = _write(tmp, "a.jsonl", _init_line("claude-x", "default", ["Read", "Bash"]) + "\n")
        b = _write(tmp, "b.jsonl", _init_line("claude-x", "default", ["Bash", "Read"]) + "\n")
        report = probe.build_report([a, b])
    cross = report["cross_capture"]
    # the defect: identical membership, different order -> reorder MUST be detected
    assert cross["breakpoint_moved"] is True
    assert cross["first_moved_block_index"] == 0
    # membership is identical, so set-churn must stay False (honest separation of signals)
    assert cross["tool_set_churn"] is False
    assert cross["added_tool_hashes"] == []
    assert cross["removed_tool_hashes"] == []
    # the ordered hash list is exposed per-capture. Capture B's provider order
    # ([Bash, Read]) is NOT sorted, so its ordered list differs from its sorted list,
    # while always being a permutation of it.
    cap1 = report["captures"][1]
    assert cap1["ordered_tool_name_hashes"] != cap1["tool_name_hashes"]
    assert sorted(cap1["ordered_tool_name_hashes"]) == cap1["tool_name_hashes"]


def test_breakpoint_evaluated_across_all_capture_pairs_not_just_first():
    """H1 (#2): the invariant must be ORed across EVERY usable capture pair and record
    the EARLIEST moved index + the triggering capture index — not only the first pair.
    Here cap[1] is order-identical to base (no breakpoint), but cap[2] reorders the
    prefix. The old code checked only the first pair and would have reported
    breakpoint_moved=False. The base capture carries a leading blank line to exercise
    the blank-line skip in ordered-tool recovery."""
    with tempfile.TemporaryDirectory() as tmp:
        a = _write(tmp, "a.jsonl", "\n" + _init_line("claude-x", "default", ["Read", "Bash"]) + "\n")
        b = _write(tmp, "b.jsonl", _init_line("claude-x", "default", ["Read", "Bash"]) + "\n")
        c = _write(tmp, "c.jsonl", _init_line("claude-x", "default", ["Bash", "Read"]) + "\n")
        report = probe.build_report([a, b, c])
    cross = report["cross_capture"]
    assert cross["breakpoint_moved"] is True
    assert cross["first_moved_block_index"] == 0
    # the third capture (index 2) is the one that moved the breakpoint
    assert cross["breakpoint_capture_index"] == 2


def test_breakpoint_keeps_earliest_index_across_pairs():
    """H1 (#2): when multiple pairs move the breakpoint, the EARLIEST diverging index
    must be retained even when a LATER pair diverges at a larger index. base [Read,Bash,
    Edit] (sorted-order provider list); cap[1] reorders at index 0 ([Bash,Read,Edit]);
    cap[2] keeps index 0 fixed but reorders later ([Read,Edit,Bash] -> first diverges at
    index 1). The recorded earliest index must stay 0 and the triggering capture stays
    the first one that moved (index 1)."""
    with tempfile.TemporaryDirectory() as tmp:
        a = _write(tmp, "a.jsonl", _init_line("claude-x", "default", ["Read", "Bash", "Edit"]) + "\n")
        b = _write(tmp, "b.jsonl", _init_line("claude-x", "default", ["Bash", "Read", "Edit"]) + "\n")
        c = _write(tmp, "c.jsonl", _init_line("claude-x", "default", ["Read", "Edit", "Bash"]) + "\n")
        report = probe.build_report([a, b, c])
    cross = report["cross_capture"]
    assert cross["breakpoint_moved"] is True
    assert cross["first_moved_block_index"] == 0
    assert cross["breakpoint_capture_index"] == 1


def _cap(model="A", perm="default", tools=("t1", "t2")):
    return {"parse_status": "ok", "model": model, "permission_mode": perm,
            "tool_name_hashes": sorted(tools), "ordered_tool_name_hashes": list(tools)}


def test_breakpoint_invariant_base_longer_than_cap_no_index_error():
    # The bounds guard `i >= len(cap_hashes) or cap_hashes[i] != h` must short-circuit when base is
    # LONGER than cap (a truncation): a > weakening would index cap_hashes[len(cap)] and raise
    # IndexError instead of returning (True, len(cap)).
    moved, idx = probe._breakpoint_invariant(["a", "b", "c"], ["a", "b"])
    assert moved is True and idx == 2


def test_single_dimension_churn_flags_risk():
    # any_churn = model OR permission OR tool_set OR breakpoint: ANY single churn dimension must flag
    # cache_stability_risk. An and->or weakening would require ALL dimensions to churn together,
    # hiding a single-dimension (here model-only) prefix change.
    cross = probe.cross_capture_churn([_cap(model="A"), _cap(model="B")])
    assert cross["model_churn"] is True
    assert cross["cache_stability_risk"] == "churn_detected"


def test_first_differing_capture_index_is_the_earliest():
    # first_differing_capture_index records the FIRST capture that differed (guard `differed and
    # first_differing_capture_index is None`). An and->or weakening would keep overwriting it,
    # recording the LAST differing capture instead of the first. Two captures both differ from base.
    cross = probe.cross_capture_churn([_cap(model="A"), _cap(model="B"), _cap(model="C")])
    assert cross["first_differing_capture_index"] == 1


def test_section_artifact_empty_sections_is_unsupported_shape():
    # An empty `sections` list is an unsupported section artifact (guard `not isinstance(sections,
    # list) or not sections`). An and->or weakening would accept an empty list and proceed.
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        json.dump({"sections": []}, f)
        p = Path(f.name)
    try:
        rep = probe.build_section_report(p)
    finally:
        p.unlink(missing_ok=True)
    assert rep["section_artifact_status"] == "unsupported_shape"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} cache_stable_prefix_auditor tests passed")
