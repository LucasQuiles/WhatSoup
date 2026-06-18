#!/usr/bin/env python3
"""Tests for claude_observability_hook_probe metadata-only output.

Covers:
- Happy-path redaction and summarization
- CLI e2e subprocess test (covers __main__ path)
- Unhappy-path / edge branches: missing root, OSError on parse, malformed
  JSON, non-dict JSON objects, empty/whitespace-only lines, non-string
  hook/event/session/tool values, path classification branches, hook_identity
  branches (absent, path-like vs label), safe_tool_name edge cases,
  safe_basename SECRET_VALUE redaction, iter_hook_files absent root,
  classify_path all variants, merge_counter int check, max_files slicing.
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import claude_observability_hook_probe as probe  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "claude_observability_hook_probe.py"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_hook_file(root: Path, date: str = "2026-06-15", session: str = "sess-01") -> Path:
    hook_file = root / date / session / "metadata" / "hook_events.jsonl"
    hook_file.parent.mkdir(parents=True, exist_ok=True)
    return hook_file


def _write_lines(hook_file: Path, rows: list) -> None:
    hook_file.write_text(
        "\n".join(json.dumps(r) if isinstance(r, dict) else r for r in rows),
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# Original integration tests (kept intact)
# ---------------------------------------------------------------------------

def write_hook_events(root: Path) -> Path:
    hook_file = root / "2026-06-15/session-secret/metadata/hook_events.jsonl"
    hook_file.parent.mkdir(parents=True, exist_ok=True)
    rows = [
        {
            "seq": 1,
            "ts": "2026-06-15T10:00:00Z",
            "session_id": "session-secret@example.com",
            "origin_type": "hook",
            "event": "PreToolUse",
            "hook": "/private/secret/hooks/guard-secret.sh",
            "data": {
                "tool_ref": "toolu_secret_1",
                "tool_name": "Bash",
                "cwd": "/Users/testuser/private/repo",
                "path": "/Users/testuser/private/repo/.env",
                "package_root": "/Users/testuser/private",
                "transcript_path": "/Users/testuser/.claude/private/transcript.jsonl",
                "prompt_hash": "ghp_shouldnotleak0000000000000000",
                "command_hash": "cmdhash-secret",
                "stdout_bytes": 12,
                "stderr_bytes": 5,
                "error": "error leaked to person@example.com",
            },
        },
        {
            "seq": 2,
            "ts": "2026-06-15T10:00:01Z",
            "session_id": "session-secret@example.com",
            "origin_type": "hook",
            "event": "PreToolUse",
            "hook": "legacy-sk-shouldnotleak123456",
            "data": {
                "tool_ref": "toolu_secret_1",
                "tool": "Bash",
                "cwd": "/Users/testuser/private/repo",
                "stdout_bytes": 0,
                "stderr_bytes": 0,
            },
        },
        {
            "seq": 3,
            "ts": "2026-06-15T10:00:02Z",
            "session_id": "session-secret@example.com",
            "origin_type": "hook",
            "event": "PostToolUse",
            "hook": "/private/secret/hooks/post-secret.sh",
            "data": {
                "tool_ref": "toolu_secret_2",
                "tool_name": "Read",
                "stdout_bytes": 3,
                "stderr_bytes": 0,
            },
        },
        "not-json",
    ]
    hook_file.write_text("\n".join(json.dumps(row) if isinstance(row, dict) else row for row in rows), encoding="utf-8")
    return hook_file


def assert_no_raw_values(rendered: str) -> None:
    for forbidden in [
        "/private/secret",
        "/Users/testuser/private",
        "session-secret@example.com",
        "session-secret",
        "person@example.com",
        "ghp_shouldnotleak",
        "sk-shouldnotleak",
        "legacy-sk",
        "toolu_secret",
        "cmdhash-secret",
        "error leaked",
        ".env",
        "transcript.jsonl",
    ]:
        assert forbidden not in rendered, forbidden


def test_observability_hook_probe_summarizes_metadata_without_raw_values():
    with tempfile.TemporaryDirectory(prefix="hook-observability-") as tmp_dir:
        root = Path(tmp_dir)
        write_hook_events(root)
        report = probe.build_report(root)
        rendered = json.dumps(report, sort_keys=True)

        assert report["schema"] == "agent-runtime-claude-observability-hook-events", report
        assert report["schema_version"] == "0.1", report
        assert report["proof_class"] == "historical_local_claude_observability_metadata", report
        assert report["root"]["hook_event_file_count"] == 1, report
        assert report["summary"]["json_line_count"] == 3, report
        assert report["summary"]["parse_error_count"] == 1, report
        assert report["summary"]["event_counts"] == {"PreToolUse": 2, "PostToolUse": 1}, report
        assert report["summary"]["tool_counts"] == {"Bash": 2, "Read": 1}, report
        assert report["summary"]["stdout_bytes_total"] == 15, report
        assert report["summary"]["stderr_bytes_total"] == 5, report
        assert report["summary"]["suppressed_value_key_counts"]["cwd"] == 2, report
        assert report["summary"]["suppressed_value_key_counts"]["error"] == 1, report
        assert report["summary"]["multi_hook_tool_event_group_count"] == 1, report
        assert report["summary"]["multi_hook_tool_event_max_hook_identity_count"] == 2, report
        assert_no_raw_values(rendered)
        assert "guard-secret.sh" in rendered, report
        assert "<redacted:value>" in rendered, report


def test_observability_hook_probe_cli_suppresses_values():
    with tempfile.TemporaryDirectory(prefix="hook-observability-") as tmp_dir:
        root = Path(tmp_dir)
        write_hook_events(root)
        result = subprocess.run(
            [
                sys.executable,
                str(PROBE_PATH),
                "--root",
                str(root),
                "--pretty",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        report = json.loads(result.stdout)
        assert result.stderr == "", result.stderr
        assert report["summary"]["hook_invocation_count"] == 3, report
        assert_no_raw_values(result.stdout)


# ---------------------------------------------------------------------------
# CLI e2e test — covers the __main__ path (no --root so uses DEFAULT_ROOT)
# ---------------------------------------------------------------------------

def test_cli_entrypoint_emits_valid_json_for_nonexistent_root():
    """Run the probe as a real subprocess against a nonexistent root.

    Covers the `if __name__ == '__main__': raise SystemExit(main())` path
    and the `not root.exists()` branch in iter_hook_files.
    """
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--root", "/nonexistent-xyz-obvs/not-a-dir"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-claude-observability-hook-events"
    assert report["root"]["exists"] is False
    assert report["root"]["hook_event_file_count"] == 0
    assert report["summary"]["json_line_count"] == 0


# ---------------------------------------------------------------------------
# Unit tests for pure functions
# ---------------------------------------------------------------------------

def test_classify_path_none_value_returns_none():
    assert probe.classify_path(None) == "none"


def test_classify_path_empty_string_returns_none():
    assert probe.classify_path("") == "none"


def test_classify_path_non_string_integer_returns_none():
    assert probe.classify_path(42) == "none"


def test_classify_path_home_users_prefix():
    assert probe.classify_path("/Users/testuser/some/path") == "home_path"


def test_classify_path_tilde_prefix():
    assert probe.classify_path("~/some/path") == "home_path"


def test_classify_path_absolute_non_home():
    assert probe.classify_path("/tmp/some-dir") == "absolute_path"


def test_classify_path_relative_or_label():
    assert probe.classify_path("relative/path") == "relative_or_label"
    assert probe.classify_path("just-a-label") == "relative_or_label"


def test_hook_identity_missing_value_returns_not_present():
    result = probe.hook_identity(None)
    assert result["hook_present"] is False
    assert result["hook_sha256_16"] is None
    assert result["hook_basename"] is None
    assert result["hook_label_class"] == "none"


def test_hook_identity_empty_string_returns_not_present():
    result = probe.hook_identity("")
    assert result["hook_present"] is False


def test_hook_identity_non_string_returns_not_present():
    result = probe.hook_identity(42)
    assert result["hook_present"] is False


def test_hook_identity_label_style_no_slash():
    result = probe.hook_identity("my-guard-hook")
    assert result["hook_present"] is True
    assert result["hook_label_class"] == "label"
    assert result["hook_basename"] == "my-guard-hook"
    assert isinstance(result["hook_sha256_16"], str)


def test_hook_identity_path_like_with_slash():
    result = probe.hook_identity("/usr/local/hooks/guard.sh")
    assert result["hook_present"] is True
    assert result["hook_label_class"] == "path_like"
    assert result["hook_basename"] == "guard.sh"


def test_safe_tool_name_none_returns_none():
    assert probe.safe_tool_name(None) is None


def test_safe_tool_name_empty_string_returns_none():
    assert probe.safe_tool_name("") is None


def test_safe_tool_name_integer_returns_none():
    assert probe.safe_tool_name(123) is None


def test_safe_tool_name_short_clean_label_passes_through():
    assert probe.safe_tool_name("Bash") == "Bash"


def test_safe_tool_name_path_like_returns_hash_prefix():
    result = probe.safe_tool_name("/some/path/to/tool")
    assert result is not None
    assert result.startswith("tool_hash:")


def test_safe_tool_name_overlong_value_returns_hash_prefix():
    long_name = "x" * 81
    result = probe.safe_tool_name(long_name)
    assert result is not None
    assert result.startswith("tool_hash:")


def test_safe_basename_redacts_secret_shaped_value():
    """safe_basename should return '<redacted:value>' for secret-looking strings."""
    result = probe.safe_basename("sk-ABCDEFGHIJKLMNOPQRST")
    assert result == "<redacted:value>"


def test_safe_basename_plain_value_passes_through():
    result = probe.safe_basename("guard.sh")
    assert result == "guard.sh"


def test_safe_basename_truncates_at_80_chars():
    long = "a" * 100
    result = probe.safe_basename(long)
    assert len(result) == 80


def test_iter_hook_files_missing_root_returns_empty():
    result = probe.iter_hook_files(Path("/nonexistent-xyz-probe-test/sessions"))
    assert result == []


def test_iter_hook_files_existing_empty_root_returns_empty():
    with tempfile.TemporaryDirectory() as tmp:
        result = probe.iter_hook_files(Path(tmp))
        assert result == []


# ---------------------------------------------------------------------------
# Unhappy-path tests for parse_hook_file
# ---------------------------------------------------------------------------

def test_parse_hook_file_empty_lines_skipped():
    """Blank/whitespace-only lines must be skipped without counting as errors."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        f.write_text("\n   \n\n", encoding="utf-8")
        result = probe.parse_hook_file(f, root)
        assert result["json_line_count"] == 0
        assert result["invalid_json_lines"] == 0


def test_parse_hook_file_invalid_json_lines_counted_as_error():
    """Lines that are not valid JSON must increment invalid_json_lines."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        f.write_text("not-json\n{malformed\n", encoding="utf-8")
        result = probe.parse_hook_file(f, root)
        assert result["invalid_json_lines"] == 2
        assert result["json_line_count"] == 0


def test_parse_hook_file_non_dict_json_line_is_invalid():
    """A JSON line that parses but is not a dict must count as invalid."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        f.write_text(json.dumps([1, 2, 3]) + "\n", encoding="utf-8")
        result = probe.parse_hook_file(f, root)
        assert result["invalid_json_lines"] == 1
        assert result["json_line_count"] == 0


def test_parse_hook_file_non_string_event_not_counted():
    """Non-string event field must not be counted in event_counts."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        row = {"session_id": "s1", "event": 42, "origin_type": 99, "hook": "my-hook", "data": {}}
        f.write_text(json.dumps(row) + "\n", encoding="utf-8")
        result = probe.parse_hook_file(f, root)
        assert result["json_line_count"] == 1
        assert result["event_counts"] == {}
        assert result["origin_type_counts"] == {}


def test_parse_hook_file_missing_hook_key_uses_missing_id():
    """When hook key is absent, hook_rows should contain 'missing' entry."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        row = {"session_id": "s1", "event": "PreToolUse", "data": {}}
        f.write_text(json.dumps(row) + "\n", encoding="utf-8")
        result = probe.parse_hook_file(f, root)
        assert result["json_line_count"] == 1
        assert len(result["hook_rows"]) == 1
        assert result["hook_rows"][0]["hook_id_sha256_16"] == "missing"


def test_parse_hook_file_non_string_session_id_becomes_unknown():
    """Non-string session_id should produce 'unknown' session hash."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        row = {"session_id": None, "event": "TestEvent", "hook": "test-hook", "data": {}}
        f.write_text(json.dumps(row) + "\n", encoding="utf-8")
        result = probe.parse_hook_file(f, root)
        # session_count reflects the 'unknown' token
        assert result["session_count"] == 1


def test_parse_hook_file_non_int_stdout_stderr_bytes_not_counted():
    """Non-int stdout_bytes / stderr_bytes must not add to totals."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        row = {
            "session_id": "s1",
            "event": "E",
            "hook": "h",
            "data": {"stdout_bytes": "big", "stderr_bytes": None},
        }
        f.write_text(json.dumps(row) + "\n", encoding="utf-8")
        result = probe.parse_hook_file(f, root)
        assert result["stdout_bytes_total"] == 0
        assert result["stderr_bytes_total"] == 0


def test_parse_hook_file_command_hash_count_incremented():
    """When data.command_hash is a string, command_hash_count must increment."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        row = {
            "session_id": "s1",
            "event": "E",
            "hook": "h",
            "data": {"command_hash": "abc123"},
        }
        f.write_text(json.dumps(row) + "\n", encoding="utf-8")
        result = probe.parse_hook_file(f, root)
        assert result["hook_rows"][0]["command_hash_count"] == 1


def test_parse_hook_file_non_string_command_hash_not_counted():
    """Non-string command_hash must NOT increment command_hash_count."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        row = {
            "session_id": "s1",
            "event": "E",
            "hook": "h",
            "data": {"command_hash": 42},
        }
        f.write_text(json.dumps(row) + "\n", encoding="utf-8")
        result = probe.parse_hook_file(f, root)
        assert result["hook_rows"][0]["command_hash_count"] == 0


def test_parse_hook_file_tool_ref_requires_both_string_event_and_tool_ref():
    """multi_hook_groups only populated when both tool_ref and event are strings."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        # tool_ref present but event is not a string -> no multi-hook group
        row = {
            "session_id": "s1",
            "event": 99,
            "hook": "h",
            "data": {"tool_ref": "ref-1"},
        }
        f.write_text(json.dumps(row) + "\n", encoding="utf-8")
        result = probe.parse_hook_file(f, root)
        assert result["multi_hook_tool_event_summary"]["group_count"] == 0


def test_parse_hook_file_data_is_not_dict_uses_empty():
    """When 'data' is not a dict, the function must use {} and not crash."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        row = {"session_id": "s1", "event": "E", "hook": "h", "data": "bad-data"}
        f.write_text(json.dumps(row) + "\n", encoding="utf-8")
        result = probe.parse_hook_file(f, root)
        assert result["json_line_count"] == 1


def test_parse_hook_file_tool_via_tool_key_fallback():
    """safe_tool_name should be called on data['tool'] when 'tool_name' absent."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        row = {
            "session_id": "s1",
            "event": "E",
            "hook": "h",
            "data": {"tool": "Grep"},
        }
        f.write_text(json.dumps(row) + "\n", encoding="utf-8")
        result = probe.parse_hook_file(f, root)
        assert result["tool_counts"] == {"Grep": 1}


def test_parse_hook_file_suppressed_value_key_empty_string_not_counted():
    """Empty-string values for suppressed keys must not increment the counter."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        row = {
            "session_id": "s1",
            "event": "E",
            "hook": "h",
            "data": {"cwd": "", "path": None},
        }
        f.write_text(json.dumps(row) + "\n", encoding="utf-8")
        result = probe.parse_hook_file(f, root)
        assert result["suppressed_value_key_counts"] == {}


def test_parse_hook_file_path_class_classification_in_data():
    """Path keys in data must be classified via classify_path."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        row = {
            "session_id": "s1",
            "event": "E",
            "hook": "h",
            "data": {
                "cwd": "/tmp/some-dir",    # absolute_path
                "path": "/Users/testuser/file",   # home_path
            },
        }
        f.write_text(json.dumps(row) + "\n", encoding="utf-8")
        result = probe.parse_hook_file(f, root)
        assert "cwd:absolute_path" in result["path_class_counts"]
        assert "path:home_path" in result["path_class_counts"]


# ---------------------------------------------------------------------------
# Unhappy-path tests for build_report
# ---------------------------------------------------------------------------

def test_build_report_missing_root_returns_empty_summary():
    """build_report on a nonexistent root must return valid schema with zero counts."""
    report = probe.build_report(Path("/nonexistent-xyz-build-report-test"))
    assert report["schema"] == "agent-runtime-claude-observability-hook-events"
    assert report["root"]["exists"] is False
    assert report["root"]["hook_event_file_count"] == 0
    assert report["summary"]["json_line_count"] == 0
    assert report["summary"]["hook_invocation_count"] == 0


def test_build_report_oserror_on_parse_increments_parse_error_count():
    """OSError during parse_hook_file must increment parse_error_count and not crash."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f = _make_hook_file(root)
        row = {"session_id": "s1", "event": "E", "hook": "h", "data": {}}
        _write_lines(f, [row])
        # Monkeypatch parse_hook_file to raise OSError
        orig = probe.parse_hook_file
        probe.parse_hook_file = lambda path, rt: (_ for _ in ()).throw(OSError("permission denied"))
        try:
            report = probe.build_report(root)
        finally:
            probe.parse_hook_file = orig
        assert report["summary"]["parse_error_count"] >= 1


def test_build_report_max_files_limits_selection():
    """max_files=1 should process only one file even if two exist."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f1 = _make_hook_file(root, date="2026-06-14", session="sess-a")
        f2 = _make_hook_file(root, date="2026-06-15", session="sess-b")
        row = {"session_id": "s1", "event": "E", "hook": "h", "data": {}}
        _write_lines(f1, [row])
        _write_lines(f2, [row])
        report = probe.build_report(root, max_files=1)
        assert report["root"]["hook_event_file_count"] == 2
        assert report["root"]["scanned_file_count"] == 1


def test_build_report_max_files_none_processes_all():
    """max_files=None should process all available files."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        f1 = _make_hook_file(root, date="2026-06-14", session="sess-a")
        f2 = _make_hook_file(root, date="2026-06-15", session="sess-b")
        row = {"session_id": "s1", "event": "E", "hook": "h", "data": {}}
        _write_lines(f1, [row])
        _write_lines(f2, [row])
        report = probe.build_report(root, max_files=None)
        assert report["root"]["scanned_file_count"] == 2


def test_build_report_pretty_flag_in_cli_mode():
    """--pretty flag must produce indented JSON."""
    buf = io.StringIO()
    orig_argv = sys.argv
    sys.argv = ["claude_observability_hook_probe.py", "--root", "/nonexistent-xyz", "--pretty"]
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
    assert rc == 0
    output = buf.getvalue()
    # Indented JSON has newlines within the output
    assert "\n" in output
    report = json.loads(output)
    assert report["schema"] == "agent-runtime-claude-observability-hook-events"


def test_build_report_compact_mode_in_cli():
    """Without --pretty the JSON must be on one line (no indent)."""
    buf = io.StringIO()
    orig_argv = sys.argv
    sys.argv = ["claude_observability_hook_probe.py", "--root", "/nonexistent-xyz"]
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
    assert rc == 0
    output = buf.getvalue().strip()
    # compact JSON: first line IS the whole JSON object
    assert output.startswith("{")
    report = json.loads(output)
    assert "schema" in report


# ---------------------------------------------------------------------------
# merge_counter edge cases
# ---------------------------------------------------------------------------

def test_merge_counter_non_int_value_skipped():
    """merge_counter must skip non-int values silently."""
    from collections import Counter
    target: Counter[str] = Counter()
    probe.merge_counter(target, {"good": 3, "bad": "not-int", "also_bad": None})
    assert target["good"] == 3
    assert "bad" not in target
    assert "also_bad" not in target


# ---------------------------------------------------------------------------
# Determinism test
# ---------------------------------------------------------------------------

def test_build_report_is_deterministic():
    """Same input directory must produce bit-identical reports on two runs."""
    with tempfile.TemporaryDirectory(prefix="hook-det-") as tmp:
        root = Path(tmp)
        hook_file = _make_hook_file(root)
        rows = [
            {
                "session_id": "s1",
                "event": "PreToolUse",
                "origin_type": "hook",
                "hook": "/hooks/my-guard.sh",
                "data": {
                    "tool_name": "Bash",
                    "tool_ref": "ref-1",
                    "cwd": "/Users/testuser/proj",
                    "stdout_bytes": 10,
                    "stderr_bytes": 2,
                    "command_hash": "h1",
                },
            },
            {
                "session_id": "s2",
                "event": "PostToolUse",
                "origin_type": "hook",
                "hook": "/hooks/my-guard.sh",
                "data": {"tool_ref": "ref-1", "tool_name": "Read"},
            },
        ]
        _write_lines(hook_file, rows)
        r1 = json.dumps(probe.build_report(root), sort_keys=True)
        r2 = json.dumps(probe.build_report(root), sort_keys=True)
        assert r1 == r2


# ---------------------------------------------------------------------------
# Multi-hook fanout fan-out path
# ---------------------------------------------------------------------------

def test_multi_hook_fanout_detected_when_multiple_hooks_share_tool_event_ref():
    """Two different hooks handling the same session+event+tool_ref must be flagged."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        hook_file = _make_hook_file(root)
        rows = [
            {
                "session_id": "shared-session",
                "event": "PreToolUse",
                "hook": "/hooks/guard-a.sh",
                "data": {"tool_ref": "common-ref"},
            },
            {
                "session_id": "shared-session",
                "event": "PreToolUse",
                "hook": "/hooks/guard-b.sh",
                "data": {"tool_ref": "common-ref"},
            },
        ]
        _write_lines(hook_file, rows)
        result = probe.parse_hook_file(hook_file, root)
        assert result["multi_hook_tool_event_summary"]["group_count"] >= 1
        assert result["multi_hook_tool_event_summary"]["max_hook_identity_count"] >= 2


# ---------------------------------------------------------------------------
# Additional redaction / secret guard tests
# ---------------------------------------------------------------------------

def test_hook_with_secret_shaped_name_gets_redacted_basename():
    """A hook value with a secret-shaped basename must be redacted in output."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        hook_file = _make_hook_file(root)
        row = {
            "session_id": "s1",
            "event": "E",
            "hook": "/path/to/sk-ABCDEFGHIJKLMNOPQRST",
            "data": {},
        }
        _write_lines(hook_file, [row])
        result = probe.parse_hook_file(hook_file, root)
        rendered = json.dumps(result)
        assert "sk-ABCDEFGHIJKLMNOPQRST" not in rendered
        hook_row = result["hook_rows"][0]
        assert hook_row["identity"]["hook_basename"] == "<redacted:value>"


def test_path_classification_none_type_in_data_key():
    """None value for a PATH_KEY must be classified as 'none'."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        hook_file = _make_hook_file(root)
        row = {"session_id": "s1", "event": "E", "hook": "h", "data": {"cwd": None}}
        _write_lines(hook_file, [row])
        result = probe.parse_hook_file(hook_file, root)
        assert "cwd:none" in result["path_class_counts"]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} Claude observability hook probe tests passed")
