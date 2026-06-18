#!/usr/bin/env python3
"""Tests for hook_context_profiler metadata parsing."""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import hook_context_profiler as profiler  # noqa: E402
from hook_context_profiler import (  # noqa: E402
    build_report,
    command_identity,
    content_bytes,
    is_hookish,
    parse_stream_json,
    split_command,
    walk,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "hook_context_profiler.py"


def synthetic_stream() -> str:
    return "\n".join([
        json.dumps({
            "type": "hook_event",
            "hook_event_name": "SessionStart",
            "command": "/private/secret/path/session-hook.sh --token sk-shouldnotleak123456",
            "stdout": "context payload with email person@example.com",
            "stderr": "",
            "exit_code": 0,
        }),
        json.dumps({
            "type": "assistant",
            "message": {"content": "model text should be ignored by hook parser"},
        }),
        json.dumps({
            "hookEventName": "PreToolUse",
            "hookName": "guard-canary",
            "hookSpecificOutput": {
                "additionalContext": "additional secret context ghp_shouldnotleak0000000000000000",
            },
            "exitCode": 2,
        }),
        "not-json",
    ])


def duplicate_stream() -> str:
    command = "/private/secret/path/pre-tool.sh --token sk-dupehook123456"
    return "\n".join([
        json.dumps({
            "type": "hook_event",
            "hook_event_name": "PreToolUse",
            "command": command,
            "stdout": "first duplicate payload with person@example.com",
            "exit_code": 0,
        }),
        json.dumps({
            "type": "hook_event",
            "hook_event_name": "PreToolUse",
            "command": command,
            "stdout": "second duplicate payload with ghp_shouldnotleak0000000000000000",
            "exit_code": 0,
        }),
        json.dumps({
            "type": "hook_event",
            "hook_event_name": "PostToolUse",
            "hookName": "single-post-hook",
            "stdout": "single payload",
            "exit_code": 0,
        }),
    ])


def test_parse_stream_json_summarizes_hook_events_without_raw_content():
    parsed = parse_stream_json(synthetic_stream())

    assert parsed["parsed_json_lines"] == 3, parsed
    assert parsed["invalid_json_lines"] == 1, parsed
    assert parsed["event_counts"] == {"SessionStart": 1, "PreToolUse": 1}, parsed
    assert parsed["hook_invocation_count"] == 2, parsed
    assert parsed["unique_hook_count"] == 2, parsed
    assert parsed["exit_codes"] == {"0": 1, "2": 1}, parsed
    assert parsed["raw_content_suppressed"] is True, parsed

    rendered = json.dumps(parsed, sort_keys=True)
    for forbidden in [
        "/private/secret/path",
        "sk-shouldnotleak",
        "person@example.com",
        "ghp_shouldnotleak",
        "context payload",
        "additional secret context",
    ]:
        assert forbidden not in rendered, forbidden
    assert "stdout_bytes" in rendered, parsed
    assert "additional_context_bytes" in rendered, parsed


def test_build_report_dry_run_has_schema_and_no_raw_prompt_or_command():
    report = build_report(mode="dry_run")
    assert report["schema"] == "agent-runtime-hook-context-profile", report
    assert report["schema_version"] == "0.3", report
    assert report["proof_class"] == "dry_run", report
    assert report["command_shape"]["provider_call_when_run"] is True, report

    rendered = json.dumps(report, sort_keys=True)
    assert "Reply exactly OK" not in rendered, report
    assert "claude -p" not in rendered, report
    assert "raw hook stdout" in rendered, report


def test_input_jsonl_mode_output_suppresses_raw_fixture_values():
    path = Path(tempfile.mkdtemp(prefix="hook-profiler-test-")) / "capture.jsonl"
    path.write_text(synthetic_stream(), encoding="utf-8")
    report = build_report(mode="input_jsonl", stream_text=path.read_text(encoding="utf-8"))
    assert report["proof_class"] == "offline_stream_parse", report
    assert report["stream_summary"]["hook_invocation_count"] == 2, report
    rendered = json.dumps(report, sort_keys=True)
    assert "capture.jsonl" not in rendered, report
    assert "person@example.com" not in rendered, report
    assert "sk-shouldnotleak" not in rendered, report


def test_duplicate_summary_groups_repeated_hook_identity_without_raw_content():
    parsed = parse_stream_json(duplicate_stream())
    summary = parsed["duplicate_summary"]
    assert parsed["hook_invocation_count"] == 3, parsed
    assert parsed["unique_hook_count"] == 2, parsed
    assert summary["duplicate_group_count"] == 1, parsed
    assert summary["extra_invocation_count"] == 1, parsed
    group = summary["groups"][0]
    assert group["invocation_count"] == 2, group
    assert group["event_counts"] == {"PreToolUse": 2}, group
    assert group["identity"]["script_or_path_basename"] == "pre-tool.sh", group

    rendered = json.dumps(parsed, sort_keys=True)
    for forbidden in [
        "/private/secret/path",
        "sk-dupehook",
        "person@example.com",
        "ghp_shouldnotleak",
        "first duplicate payload",
        "second duplicate payload",
    ]:
        assert forbidden not in rendered, forbidden


# ---------------------------------------------------------------------------
# walk() — iterator over nested dicts and lists
# ---------------------------------------------------------------------------

def test_walk_yields_nested_dicts():
    obj = {"a": {"b": 1}, "c": [{"d": 2}]}
    visited = list(walk(obj))
    assert {"b": 1} in visited
    assert {"d": 2} in visited
    assert {"a": {"b": 1}, "c": [{"d": 2}]} in visited


def test_walk_flat_list_of_scalars_yields_nothing():
    assert list(walk([1, 2, 3])) == []


def test_walk_nested_list_of_dicts():
    obj = [{"x": 1}, {"y": [{"z": 2}]}]
    visited = list(walk(obj))
    assert {"x": 1} in visited
    assert {"z": 2} in visited


# ---------------------------------------------------------------------------
# split_command() — shlex fallback on unbalanced quotes
# ---------------------------------------------------------------------------

def test_split_command_normal():
    assert split_command("/bin/sh script.sh --arg value") == ["/bin/sh", "script.sh", "--arg", "value"]


def test_split_command_fallback_on_unbalanced_quote():
    # shlex.split raises ValueError on unbalanced quotes; we fall back to str.split
    result = split_command("/bin/sh 'unbalanced")
    assert "/bin/sh" in result[0] or result  # does not raise


# ---------------------------------------------------------------------------
# command_identity() — no command vs command present
# ---------------------------------------------------------------------------

def test_command_identity_no_command_present():
    ci = command_identity(None)
    assert ci["command_present"] is False
    assert ci["command_sha256_16"] is None
    assert ci["executable_basename"] is None
    assert ci["script_or_path_basename"] is None
    assert ci["argv_count"] == 0


def test_command_identity_empty_string():
    ci = command_identity("")
    assert ci["command_present"] is False


def test_command_identity_with_command():
    # First path-like arg is argv[0] = /usr/local/bin/python3, so script_or_path_basename = python3
    ci = command_identity("/usr/local/bin/python3 /home/user/script.py --flag")
    assert ci["command_present"] is True
    assert ci["executable_basename"] == "python3"
    # pathish = first argv that starts with "/" → that is argv[0] here
    assert ci["script_or_path_basename"] == "python3"
    assert ci["argv_count"] == 3
    assert ci["command_sha256_16"] is not None


def test_command_identity_script_basename_from_second_slash_arg():
    # When argv[0] does NOT start with "/", pathish picks the first arg that does
    ci = command_identity("python3 /home/user/script.py --flag")
    assert ci["executable_basename"] == "python3"
    assert ci["script_or_path_basename"] == "script.py"
    assert ci["argv_count"] == 3


def test_command_identity_no_path_arg_uses_argv0():
    # When no argv part starts with "/", pathish falls back to argv[0]
    ci = command_identity("bash script.sh")
    assert ci["executable_basename"] == "bash"
    assert ci["script_or_path_basename"] == "bash"


# ---------------------------------------------------------------------------
# content_bytes() — str / dict / list / other
# ---------------------------------------------------------------------------

def test_content_bytes_string():
    assert content_bytes("hello") == 5


def test_content_bytes_dict():
    val = {"key": "value"}
    assert content_bytes(val) == len(json.dumps(val, sort_keys=True, default=str).encode("utf-8"))


def test_content_bytes_list():
    val = [1, 2, 3]
    assert content_bytes(val) == len(json.dumps(val, sort_keys=True, default=str).encode("utf-8"))


def test_content_bytes_non_string_scalar():
    assert content_bytes(42) == 0
    assert content_bytes(None) == 0
    assert content_bytes(3.14) == 0


# ---------------------------------------------------------------------------
# is_hookish() — marker-key path vs type-string path
# ---------------------------------------------------------------------------

def test_is_hookish_via_hook_event_name_key():
    assert is_hookish({"hook_event_name": "SessionStart"}) is True


def test_is_hookish_via_hookEventName_key():
    assert is_hookish({"hookEventName": "PreToolUse"}) is True


def test_is_hookish_via_hook_name_key():
    assert is_hookish({"hook_name": "guard"}) is True


def test_is_hookish_via_hookName_key():
    assert is_hookish({"hookName": "guard"}) is True


def test_is_hookish_via_hookSpecificOutput_key():
    assert is_hookish({"hookSpecificOutput": {}}) is True


def test_is_hookish_via_type_string_containing_hook():
    # Line 86: type string does not contain a marker key, but contains "hook"
    item = {"type": "hook_execution_result", "someField": "value"}
    assert is_hookish(item) is True


def test_is_hookish_type_string_not_hookish():
    assert is_hookish({"type": "assistant", "content": "text"}) is False


def test_is_hookish_type_non_string_ignored():
    assert is_hookish({"type": 42}) is False


def test_is_hookish_empty_dict():
    assert is_hookish({}) is False


# ---------------------------------------------------------------------------
# parse_stream_json() — unhappy paths
# ---------------------------------------------------------------------------

def test_parse_stream_json_empty_string():
    parsed = parse_stream_json("")
    assert parsed["parsed_json_lines"] == 0
    assert parsed["invalid_json_lines"] == 0
    assert parsed["hook_invocation_count"] == 0
    assert parsed["unique_hook_count"] == 0
    assert parsed["raw_content_suppressed"] is True


def test_parse_stream_json_all_invalid_json():
    text = "not json\nalso not json\n{broken"
    parsed = parse_stream_json(text)
    assert parsed["invalid_json_lines"] == 3
    assert parsed["parsed_json_lines"] == 0
    assert parsed["hook_invocation_count"] == 0


def test_parse_stream_json_blank_lines_ignored():
    text = "\n\n   \n" + json.dumps({"hook_event_name": "SessionStart", "exit_code": 0})
    parsed = parse_stream_json(text)
    assert parsed["parsed_json_lines"] == 1
    assert parsed["invalid_json_lines"] == 0


def test_parse_stream_json_non_hook_events_not_counted():
    text = "\n".join([
        json.dumps({"type": "assistant", "message": "hello"}),
        json.dumps({"type": "result", "status": "ok"}),
    ])
    parsed = parse_stream_json(text)
    assert parsed["hook_invocation_count"] == 0
    assert parsed["unique_hook_count"] == 0


def test_parse_stream_json_hookspecific_nested_additional_context_bytes():
    # nested hookSpecificOutput.additionalContext should be counted in additional_context_bytes
    item = {
        "hookEventName": "PostToolUse",
        "hookSpecificOutput": {
            "additionalContext": "some nested context data",
        },
    }
    parsed = parse_stream_json(json.dumps(item))
    row = parsed["hook_rows"][0]
    assert row["additional_context_bytes"] > 0


def test_parse_stream_json_no_duplicate_groups_when_all_unique():
    text = "\n".join([
        json.dumps({"hook_event_name": "SessionStart", "command": "/a/hook.sh"}),
        json.dumps({"hook_event_name": "PreToolUse", "command": "/b/hook.sh"}),
    ])
    parsed = parse_stream_json(text)
    assert parsed["duplicate_summary"]["duplicate_group_count"] == 0
    assert parsed["duplicate_summary"]["extra_invocation_count"] == 0
    assert parsed["duplicate_summary"]["groups"] == []


def test_parse_stream_json_exit_code_via_exitCode_key():
    # exitCode (camelCase) alternate key
    item = {"hookEventName": "PreToolUse", "exitCode": 1}
    parsed = parse_stream_json(json.dumps(item))
    assert parsed["exit_codes"] == {"1": 1}


def test_parse_stream_json_exit_code_via_exit_code_key():
    item = {"hook_event_name": "SessionStart", "exit_code": 0}
    parsed = parse_stream_json(json.dumps(item))
    assert parsed["exit_codes"] == {"0": 1}


def test_parse_stream_json_no_event_string_does_not_crash():
    # hook item with no event name field → invocation counted but no event_counts entry
    item = {"hookSpecificOutput": {"additionalContext": "ctx"}}
    parsed = parse_stream_json(json.dumps(item))
    assert parsed["hook_invocation_count"] == 1
    assert parsed["event_counts"] == {}


def test_parse_stream_json_identity_uses_hook_name_when_no_command():
    # When no command, identity_source is the hookName
    item = {"hookEventName": "SessionStart", "hookName": "my-hook"}
    parsed = parse_stream_json(json.dumps(item))
    row = parsed["hook_rows"][0]
    assert row["identity"]["command_present"] is False


def test_parse_stream_json_identity_uses_event_when_no_command_or_hook_name():
    # When no command and no hookName, identity_source falls back to event or "unknown"
    item = {"hook_event_name": "PostToolUse"}
    parsed = parse_stream_json(json.dumps(item))
    assert parsed["hook_invocation_count"] == 1


def test_parse_stream_json_stdout_stderr_additional_context_bytes_counted():
    item = {
        "hookEventName": "SessionStart",
        "stdout": "hello world",
        "stderr": "err",
        "additionalContext": "ctx data",
    }
    parsed = parse_stream_json(json.dumps(item))
    row = parsed["hook_rows"][0]
    assert row["stdout_bytes"] == len("hello world".encode("utf-8"))
    assert row["stderr_bytes"] == len("err".encode("utf-8"))
    assert row["additional_context_bytes"] == len("ctx data".encode("utf-8"))


def test_parse_stream_json_dict_stdout_counts_bytes():
    # content_bytes on a dict value
    item = {
        "hookEventName": "SessionStart",
        "stdout": {"key": "value"},
    }
    parsed = parse_stream_json(json.dumps(item))
    row = parsed["hook_rows"][0]
    assert row["stdout_bytes"] > 0


def test_parse_stream_json_hookspecific_non_dict_not_double_counted():
    # hookSpecificOutput that is NOT a dict should not cause AttributeError
    item = {
        "hookEventName": "SessionStart",
        "hookSpecificOutput": "not a dict",
    }
    # Should not raise
    parsed = parse_stream_json(json.dumps(item))
    assert parsed["hook_invocation_count"] == 1


def test_parse_stream_json_multiple_events_same_hook_increments_count():
    command = "/hooks/mytool.sh"
    lines = [
        json.dumps({"hook_event_name": "PreToolUse", "command": command, "exit_code": 0}),
        json.dumps({"hook_event_name": "PostToolUse", "command": command, "exit_code": 0}),
        json.dumps({"hook_event_name": "PreToolUse", "command": command, "exit_code": 1}),
    ]
    parsed = parse_stream_json("\n".join(lines))
    assert parsed["unique_hook_count"] == 1
    assert parsed["hook_invocation_count"] == 3
    row = parsed["hook_rows"][0]
    assert row["invocation_count"] == 3
    assert row["event_counts"].get("PreToolUse") == 2
    assert row["event_counts"].get("PostToolUse") == 1
    assert row["exit_codes"]["0"] == 2
    assert row["exit_codes"]["1"] == 1
    # duplicate group: invocation_count > 1
    assert parsed["duplicate_summary"]["duplicate_group_count"] == 1
    assert parsed["duplicate_summary"]["extra_invocation_count"] == 2


def test_parse_stream_json_hook_identity_from_type_hook_in_string():
    # A hookish item detected purely via type="hook_result" (line 86 path)
    # no HOOK_MARKER_KEYS present, so is_hookish falls through to the type check
    item = {"type": "hook_result", "exit_code": 5}
    parsed = parse_stream_json(json.dumps(item))
    assert parsed["hook_invocation_count"] == 1
    assert parsed["exit_codes"] == {"5": 1}


def test_parse_stream_json_stdout_bytes_total_in_report():
    stream = json.dumps({"hook_event_name": "SessionStart", "exit_code": 0})
    report = build_report(mode="input_jsonl", stream_text=stream)
    assert report["stdout_bytes_total"] == len(stream.encode("utf-8"))


def test_build_report_run_mode_proof_class():
    report = build_report(mode="run", stream_text="", rc=0, stderr_text="")
    assert report["proof_class"] == "live_provider_run"
    assert report["rc"] == 0


def test_build_report_empty_stream_text_gives_zero_counts():
    report = build_report(mode="dry_run")
    ss = report["stream_summary"]
    assert ss["parsed_json_lines"] == 0
    assert ss["hook_invocation_count"] == 0
    assert ss["raw_content_suppressed"] is True


def test_build_report_stderr_bytes_total_counted():
    report = build_report(mode="run", stream_text="", rc=0, stderr_text="some error output")
    assert report["stderr_bytes_total"] == len("some error output".encode("utf-8"))


# ---------------------------------------------------------------------------
# main() in-process — patches sys.argv to drive all non-run branches
# ---------------------------------------------------------------------------

def test_main_dry_run_emits_schema_and_returns_0():
    orig_argv = sys.argv[:]
    sys.argv = [PROBE_PATH.name]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = profiler.main()
    finally:
        sys.argv = orig_argv
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-hook-context-profile"
    assert report["proof_class"] == "dry_run"


def test_main_input_jsonl_valid_file_returns_0():
    tmp = Path(tempfile.mkdtemp(prefix="hook-main-test-"))
    capture = tmp / "events.jsonl"
    capture.write_text(
        json.dumps({"hook_event_name": "SessionStart", "exit_code": 0}) + "\n",
        encoding="utf-8",
    )
    orig_argv = sys.argv[:]
    sys.argv = [PROBE_PATH.name, "--input-jsonl", str(capture)]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = profiler.main()
    finally:
        sys.argv = orig_argv
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["proof_class"] == "offline_stream_parse"
    assert report["stream_summary"]["hook_invocation_count"] == 1


def test_main_input_jsonl_missing_file_returns_1():
    orig_argv = sys.argv[:]
    sys.argv = [PROBE_PATH.name, "--input-jsonl", "/nonexistent/no_such_file.jsonl"]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = profiler.main()
    finally:
        sys.argv = orig_argv
    assert rc == 1
    error_report = json.loads(buf.getvalue())
    assert "error" in error_report
    assert error_report["schema"] == "agent-runtime-hook-context-profile"


def test_main_run_flag_with_claude_not_on_path_returns_1():
    # --run is set, claude is not on PATH → returns 1 with error json
    orig_argv = sys.argv[:]
    orig_which = profiler.shutil.which
    sys.argv = [PROBE_PATH.name, "--run"]
    profiler.shutil.which = lambda name: None
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = profiler.main()
    finally:
        sys.argv = orig_argv
        profiler.shutil.which = orig_which
    assert rc == 1
    error_report = json.loads(buf.getvalue())
    assert "error" in error_report
    assert "claude not found" in error_report["error"]


def test_main_run_flag_with_claude_on_path_invokes_subprocess_and_returns_0():
    # --run is set, claude is found on PATH, subprocess.run is mocked to avoid provider call
    import types

    # Build a fake CompletedProcess-like object
    class FakeResult:
        stdout = json.dumps({"hook_event_name": "SessionStart", "exit_code": 0}) + "\n"
        stderr = ""
        returncode = 0

    orig_argv = sys.argv[:]
    orig_which = profiler.shutil.which
    orig_subprocess_run = profiler.subprocess.run
    sys.argv = [PROBE_PATH.name, "--run"]
    profiler.shutil.which = lambda name: "/usr/local/bin/claude"
    profiler.subprocess.run = lambda cmd, **kw: FakeResult()
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = profiler.main()
    finally:
        sys.argv = orig_argv
        profiler.shutil.which = orig_which
        profiler.subprocess.run = orig_subprocess_run
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["proof_class"] == "live_provider_run"
    assert report["stream_summary"]["hook_invocation_count"] == 1


# ---------------------------------------------------------------------------
# CLI e2e — main() paths via subprocess (no --run / no provider call)
# ---------------------------------------------------------------------------

def test_cli_dry_run_default_emits_valid_json():
    # Default invocation (no flags) → dry_run mode
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH)],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-hook-context-profile"
    assert report["proof_class"] == "dry_run"
    assert report["stream_summary"]["raw_content_suppressed"] is True


def test_cli_input_jsonl_valid_file_parses_events():
    tmp = Path(tempfile.mkdtemp(prefix="hook-cli-test-"))
    capture = tmp / "events.jsonl"
    capture.write_text(
        json.dumps({"hook_event_name": "SessionStart", "exit_code": 0}) + "\n"
        + json.dumps({"hook_event_name": "PreToolUse", "exit_code": 0}) + "\n",
        encoding="utf-8",
    )
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--input-jsonl", str(capture)],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["proof_class"] == "offline_stream_parse"
    assert report["stream_summary"]["hook_invocation_count"] == 2
    assert report["stream_summary"]["event_counts"]["SessionStart"] == 1
    assert report["stream_summary"]["event_counts"]["PreToolUse"] == 1


def test_cli_input_jsonl_missing_file_returns_rc1():
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--input-jsonl", "/nonexistent/path/does_not_exist.jsonl"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 1, proc
    error_report = json.loads(proc.stdout)
    assert "error" in error_report
    assert error_report["schema"] == "agent-runtime-hook-context-profile"


def test_cli_input_jsonl_with_invalid_json_lines_counts_errors():
    tmp = Path(tempfile.mkdtemp(prefix="hook-cli-test-"))
    capture = tmp / "mixed.jsonl"
    capture.write_text(
        json.dumps({"hook_event_name": "SessionStart", "exit_code": 0}) + "\n"
        + "this is not json\n"
        + "{also broken\n",
        encoding="utf-8",
    )
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--input-jsonl", str(capture)],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["stream_summary"]["invalid_json_lines"] == 2
    assert report["stream_summary"]["parsed_json_lines"] == 1


def test_cli_input_jsonl_empty_file_returns_zero_events():
    tmp = Path(tempfile.mkdtemp(prefix="hook-cli-test-"))
    capture = tmp / "empty.jsonl"
    capture.write_text("", encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--input-jsonl", str(capture)],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["stream_summary"]["hook_invocation_count"] == 0
    assert report["stream_summary"]["parsed_json_lines"] == 0


def test_cli_input_jsonl_suppresses_raw_content():
    tmp = Path(tempfile.mkdtemp(prefix="hook-cli-test-"))
    capture = tmp / "secret.jsonl"
    capture.write_text(
        json.dumps({
            "hook_event_name": "SessionStart",
            "command": "/private/secret/path/hook.sh --token sk-leaktest1234567890",
            "stdout": "raw output with person@example.com",
            "exit_code": 0,
        }),
        encoding="utf-8",
    )
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--input-jsonl", str(capture)],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    # Raw content must NOT appear in the output
    assert "/private/secret/path" not in proc.stdout
    assert "sk-leaktest" not in proc.stdout
    assert "person@example.com" not in proc.stdout
    assert "raw output" not in proc.stdout
    report = json.loads(proc.stdout)
    assert report["stream_summary"]["raw_content_suppressed"] is True


def test_cli_output_is_sorted_keys_json():
    # Keys should be alphabetically sorted (sort_keys=True in the print call)
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH)],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0
    # Verify it's valid JSON with schema at top level
    report = json.loads(proc.stdout)
    keys = list(report.keys())
    assert keys == sorted(keys), f"Keys not sorted: {keys}"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} hook context profiler tests passed")
