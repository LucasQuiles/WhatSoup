#!/usr/bin/env python3
"""Tests for tool_surface_diff offline parsing.

No pytest fixtures: plain test_* funcs, manual setattr + try/finally monkeypatching,
crafted JSONL fed via tempfile, and a CLI e2e subprocess test on a fixture. The --run
provider path is exercised ONLY with subprocess.run/shutil.which stubbed -- the real
provider/network is never invoked.
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

import tool_surface_diff as probe  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "tool_surface_diff.py"


class _FakeProc:
    """Stand-in for subprocess.CompletedProcess so run_mode never touches a provider."""

    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def test_parse_stream_json_extracts_init_tool_names_without_payloads():
    text = "\n".join(
        [
            json.dumps({"type": "system", "text": "hidden prompt sk-proj-0000000000000000000000000000000000000000"}),
            json.dumps(
                {
                    "type": "init",
                    "model": "claude-test",
                    "permissionMode": "acceptEdits",
                    "tools": [
                        {"name": "Read", "description": "SECRET_DESCRIPTION"},
                        {"name": "mcp__tmup__task_list", "input_schema": {"secret": "SECRET_SCHEMA"}},
                        "Bash",
                    ],
                }
            ),
            json.dumps({"type": "assistant", "text": "user@example.com"}),
        ]
    )

    result = probe.parse_stream_json(text)
    rendered = json.dumps(result, sort_keys=True)

    assert result["schema_version"] if "schema_version" in result else True
    assert result["init_found"] is True, result
    assert result["model"] == "claude-test", result
    assert result["permission_mode"] == "acceptEdits", result
    assert result["tool_count"] == 3, result
    assert result["mcp_tool_count"] == 1, result
    assert result["core_tool_count"] == 2, result
    assert result["tools"] == ["Bash", "Read", "mcp__tmup__task_list"], result
    assert "SECRET_DESCRIPTION" not in rendered, result
    assert "SECRET_SCHEMA" not in rendered, result
    assert "hidden prompt" not in rendered, result
    assert "sk-proj-0000000000000000000000000000000000000000" not in rendered, result
    assert "user@example.com" not in rendered, result


def test_parse_stream_json_missing_init_is_non_absence():
    result = probe.parse_stream_json(json.dumps({"type": "assistant", "text": "no init here"}))
    assert result["init_found"] is False, result
    assert result["tool_count"] == 0, result
    assert "not current-turn availability" in result["artifact_assumption"], result


def test_build_input_report_hashes_path_not_raw_path():
    tmp = Path(tempfile.mkdtemp(prefix="tool-surface-diff-test-"))
    capture = tmp / "capture.jsonl"
    capture.write_text(json.dumps({"type": "init", "tools": [{"name": "Read"}]}), encoding="utf-8")

    report = probe.build_input_report(capture)
    rendered = json.dumps(report, sort_keys=True)

    assert report["schema"] == "agent-runtime-tool-surface-diff", report
    assert report["schema_version"] == "0.2", report
    assert report["result"]["tools"] == ["Read"], report
    assert "path_sha256_16" in report, report
    assert str(capture) not in rendered, report
    assert "capture.jsonl" not in rendered, report


def test_dry_run_report_is_explicitly_non_live():
    report = probe.build_dry_run_report()
    assert report["schema_version"] == "0.2", report
    assert report["dry_run"] is True, report
    assert "--run can call the provider" in " ".join(report["limitations"]), report


# --- find_init / normalize_tool unhappy paths ---------------------------------


def test_find_init_recurses_into_nested_list_and_dict_values():
    # init envelope is buried inside a list nested under a dict value: exercises both
    # the dict-values recursion (return found) and the list recursion branch.
    nested = {
        "wrapper": {
            "events": [
                {"type": "assistant", "text": "noise"},
                {"type": "init", "model": "m", "tools": ["Read"]},
            ]
        }
    }
    found = probe.find_init(nested)
    assert found is not None, nested
    assert found["model"] == "m", found
    assert found["tools"] == ["Read"], found


def test_find_init_returns_none_when_no_init_anywhere():
    # Deep structure with no init-shaped dict must fall through to None, not fabricate one.
    assert probe.find_init({"a": [{"b": "c"}, [1, 2, 3]], "d": "e"}) is None
    assert probe.find_init([{"type": "assistant"}, {"tools_but_no_model": []}]) is None


def test_find_init_requires_tools_key_not_just_model():
    # A dict with model/permissionMode but NO "tools" key is not an init envelope.
    assert probe.find_init({"type": "init", "model": "m", "permissionMode": "default"}) is None


def test_normalize_tool_rejects_non_string_non_name_entries():
    # int / None / dict-without-name-keys must normalize to None (later filtered out),
    # never to a stringified surrogate.
    assert probe.normalize_tool(123) is None
    assert probe.normalize_tool(None) is None
    assert probe.normalize_tool({"description": "no name key here"}) is None
    assert probe.normalize_tool({"name": 7}) is None  # name present but not a str
    # alternate name keys are honored
    assert probe.normalize_tool({"tool_name": "Edit"}) == "Edit"
    assert probe.normalize_tool({"id": "mcp__x__y"}) == "mcp__x__y"


def test_parse_stream_json_drops_unnamed_tools_from_count():
    # Mixed valid/invalid tool entries: only the resolvable names survive the count.
    text = json.dumps(
        {
            "type": "init",
            "tools": ["Bash", {"description": "anonymous"}, 42, {"name": "Read"}],
        }
    )
    result = probe.parse_stream_json(text)
    assert result["init_found"] is True, result
    assert result["tools"] == ["Bash", "Read"], result
    assert result["tool_count"] == 2, result
    assert result["core_tool_count"] == 2, result
    assert result["mcp_tool_count"] == 0, result


# --- parse_stream_json: malformed / blank-line fail-closed accounting ----------


def test_parse_stream_json_counts_invalid_lines_and_skips_blanks():
    # Blank lines are skipped (not counted invalid); non-JSON lines are counted as
    # invalid and never silently treated as a clean parse; init still found afterward.
    text = "\n".join(
        [
            "",
            "   ",
            "this is not json {",
            "{also bad",
            json.dumps({"type": "assistant", "text": "x"}),
            json.dumps({"type": "init", "model": "m", "tools": ["Read"]}),
        ]
    )
    result = probe.parse_stream_json(text)
    assert result["invalid_json_lines_until_init"] == 2, result
    # two valid JSON objects parsed before/at init (assistant + init)
    assert result["parsed_json_lines_until_init"] == 2, result
    assert result["init_found"] is True, result
    assert result["tools"] == ["Read"], result


def test_parse_stream_json_all_malformed_fails_closed_not_clean():
    # Entirely malformed capture: init_found MUST be False with the lines counted invalid,
    # never a silent empty-but-clean success.
    text = "\n".join(["{bad", "also bad ]", "<<<not json>>>"])
    result = probe.parse_stream_json(text)
    assert result["init_found"] is False, result
    assert result["invalid_json_lines_until_init"] == 3, result
    assert result["parsed_json_lines_until_init"] == 0, result
    assert result["tool_count"] == 0, result
    assert result["mcp_tool_count"] == 0, result
    assert result["core_tool_count"] == 0, result


def test_parse_stream_json_empty_input_has_null_digest():
    result = probe.parse_stream_json("")
    assert result["init_found"] is False, result
    assert result["input_sha256_16"] is None, result
    assert result["input_bytes"] == 0, result
    assert result["parsed_json_lines_until_init"] == 0, result


def test_parse_stream_json_permission_mode_snake_case_fallback():
    # permission_mode (snake_case) is honored when permissionMode (camel) is absent.
    text = json.dumps({"type": "init", "tools": ["Read"], "permission_mode": "bypassPermissions"})
    result = probe.parse_stream_json(text)
    assert result["permission_mode"] == "bypassPermissions", result


# --- build_input_report: OSError fail-closed path -----------------------------


def test_build_input_report_unreadable_path_returns_typed_error_not_clean():
    # A directory path makes read_text raise OSError -> typed error report, no result,
    # and the path is hashed (never echoed).
    tmp = Path(tempfile.mkdtemp(prefix="tool-surface-diff-dir-"))
    report = probe.build_input_report(tmp)
    rendered = json.dumps(report, sort_keys=True)
    assert "error" in report, report
    assert report["error"] in ("IsADirectoryError", "PermissionError", "OSError"), report
    assert "result" not in report, report  # did not fabricate a clean parse
    assert "path_sha256_16" in report, report
    assert str(tmp) not in rendered, report
    assert report["schema"] == "agent-runtime-tool-surface-diff", report


def test_build_input_report_missing_init_reports_non_absence():
    tmp = Path(tempfile.mkdtemp(prefix="tool-surface-diff-noinit-"))
    capture = tmp / "capture.jsonl"
    capture.write_text(json.dumps({"type": "assistant", "text": "no init"}), encoding="utf-8")
    report = probe.build_input_report(capture)
    assert report["result"]["init_found"] is False, report
    assert report["result"]["tool_count"] == 0, report
    assert any("does not prove live" in lim for lim in report["limitations"]), report


# --- run_mode: provider path with subprocess stubbed (NEVER calls a provider) --


def test_run_mode_parses_stubbed_stream_without_calling_provider():
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["timeout"] = kwargs.get("timeout")
        stdout = "\n".join(
            [
                "not-json-noise",  # one malformed line before init
                json.dumps({"type": "system", "text": "boot"}),
                json.dumps(
                    {
                        "type": "init",
                        "model": "claude-stub",
                        "permissionMode": "default",
                        "tools": ["Bash", "mcp__srv__tool", {"name": "Read"}],
                    }
                ),
            ]
        )
        return _FakeProc(stdout=stdout, stderr="warn-bytes", returncode=0)

    orig = probe.subprocess.run
    probe.subprocess.run = fake_run
    try:
        result = probe.run_mode("safe-mode", ["--safe-mode"], timeout=7)
    finally:
        probe.subprocess.run = orig

    # provider command was assembled but only our stub ran
    assert captured["cmd"][0] == "claude", captured
    assert "--safe-mode" in captured["cmd"], captured
    assert captured["timeout"] == 7, captured
    assert result["mode"] == "safe-mode", result
    assert result["proof_class"] == "live_provider_run", result
    assert result["init_found"] is True, result
    assert result["model"] == "claude-stub", result
    assert result["permission_mode"] == "default", result
    assert result["tool_count"] == 3, result
    assert result["mcp_tool_count"] == 1, result
    assert result["core_tool_count"] == 2, result
    assert result["tools"] == ["Bash", "Read", "mcp__srv__tool"], result
    assert result["rc"] == 0, result
    assert result["stderr_bytes"] == len(b"warn-bytes"), result
    assert result["invalid_json_lines_until_init"] == 1, result


def test_run_mode_no_init_in_stream_reports_non_absence():
    def fake_run(cmd, **kwargs):
        stdout = json.dumps({"type": "assistant", "text": "done"})
        return _FakeProc(stdout=stdout, stderr="", returncode=2)

    orig = probe.subprocess.run
    probe.subprocess.run = fake_run
    try:
        result = probe.run_mode("default", [], timeout=5)
    finally:
        probe.subprocess.run = orig
    assert result["init_found"] is False, result
    assert result["model"] is None, result
    assert result["permission_mode"] is None, result
    assert result["tool_count"] == 0, result
    assert result["rc"] == 2, result


# --- main(): each CLI branch -------------------------------------------------


def test_main_input_jsonl_branch_emits_offline_report():
    tmp = Path(tempfile.mkdtemp(prefix="tool-surface-diff-main-input-"))
    capture = tmp / "cap.jsonl"
    capture.write_text(
        json.dumps({"type": "init", "model": "m", "tools": [{"name": "Read"}]}),
        encoding="utf-8",
    )
    orig_argv = sys.argv
    sys.argv = ["tool_surface_diff.py", "--input-jsonl", str(capture)]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["result"]["proof_class"] == "offline_stream_json_parse", report
    assert report["result"]["tools"] == ["Read"], report


def test_main_claude_not_on_path_returns_error_rc1():
    orig_which, orig_argv = probe.shutil.which, sys.argv
    probe.shutil.which = lambda name: None
    sys.argv = ["tool_surface_diff.py"]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        probe.shutil.which, sys.argv = orig_which, orig_argv
    assert rc == 1
    report = json.loads(buf.getvalue())
    assert report["error"] == "claude not found on PATH", report


def test_main_dry_run_when_claude_present_but_no_run_flag():
    orig_which, orig_argv = probe.shutil.which, sys.argv
    probe.shutil.which = lambda name: "/usr/local/bin/claude"
    sys.argv = ["tool_surface_diff.py"]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        probe.shutil.which, sys.argv = orig_which, orig_argv
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["dry_run"] is True, report
    assert report["schema"] == "agent-runtime-tool-surface-diff", report


def test_main_run_branch_computes_diff_with_stubbed_provider():
    # Exercises the full --run path with BOTH shutil.which and subprocess.run stubbed:
    # the real provider is never contacted. Default mode exposes {Bash, Read};
    # other modes drop Read, so the diff must record Read as removed_vs_default.
    def fake_run(cmd, **kwargs):
        # default mode appends no extra flags; every other mode adds a reducing flag
        # (--safe-mode / --bare / "--tools" ""). Default keeps Read; others drop it.
        reduced = "--safe-mode" in cmd or "--bare" in cmd or cmd[-2:] == ["--tools", ""]
        tools = ["Bash"] if reduced else ["Bash", "Read"]
        stdout = json.dumps({"type": "init", "model": "m", "tools": tools})
        return _FakeProc(stdout=stdout, stderr="", returncode=0)

    orig_which = probe.shutil.which
    orig_run = probe.subprocess.run
    orig_argv = sys.argv
    probe.shutil.which = lambda name: "/usr/local/bin/claude"
    probe.subprocess.run = fake_run
    sys.argv = ["tool_surface_diff.py", "--run", "--timeout", "3"]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        probe.shutil.which = orig_which
        probe.subprocess.run = orig_run
        sys.argv = orig_argv
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-tool-surface-diff", report
    assert len(report["results"]) == len(probe.MODES), report
    # default mode keeps Read; bare/safe-mode/tools-empty drop it
    assert report["diff"]["default"]["removed_vs_default"] == [], report
    assert report["diff"]["bare"]["removed_vs_default"] == ["Read"], report
    assert report["diff"]["safe-mode"]["removed_vs_default"] == ["Read"], report
    assert report["diff"]["tools-empty"]["removed_vs_default"] == ["Read"], report
    # nothing added anywhere vs default
    for mode in probe.MODES:
        assert report["diff"][mode]["added_vs_default"] == [], (mode, report)
    # report is metadata-only: tool names/counts plus the redaction note, no raw stderr.
    assert "metadata-only" in report["redaction"], report
    for item in report["results"]:
        assert "stderr_bytes" in item, item  # byte COUNT only
        assert item["proof_class"] == "live_provider_run", item


# --- CLI e2e (real subprocess, offline --input-jsonl on a tempfile fixture) ----


def test_cli_entrypoint_input_jsonl_e2e_offline():
    # Covers the `if __name__ == "__main__"` entrypoint via a real subprocess, offline.
    # No --run, so no provider is ever contacted.
    tmp = Path(tempfile.mkdtemp(prefix="tool-surface-diff-e2e-"))
    capture = tmp / "cap.jsonl"
    capture.write_text(
        "\n".join(
            [
                "garbage-not-json",
                json.dumps(
                    {
                        "type": "init",
                        "model": "claude-e2e",
                        "permissionMode": "default",
                        "tools": [
                            {"name": "Read", "description": "LEAK_DESC"},
                            "mcp__srv__tool",
                        ],
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--input-jsonl", str(capture)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-tool-surface-diff", report
    res = report["result"]
    assert res["init_found"] is True, report
    assert res["model"] == "claude-e2e", report
    assert res["tool_count"] == 2, report
    assert res["mcp_tool_count"] == 1, report
    assert res["invalid_json_lines_until_init"] == 1, report
    assert "LEAK_DESC" not in proc.stdout, "tool descriptions must not be emitted"
    assert str(capture) not in proc.stdout, "raw path must not be emitted"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} tool-surface diff tests passed")
