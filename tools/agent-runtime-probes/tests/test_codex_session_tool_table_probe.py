#!/usr/bin/env python3
"""Tests for codex_session_tool_table_probe."""
import argparse
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import codex_session_tool_table_probe as probe  # noqa: E402
from codex_session_tool_table_probe import (  # noqa: E402
    artifact_tool_sets,
    build_report,
    build_tool_table,
    classify_tool_namespace,
    main,
    namespace_counts,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "codex_session_tool_table_probe.py"


def make_args(tmp: Path) -> argparse.Namespace:
    codex_dir = tmp / ".codex"
    codex_dir.mkdir()
    config = codex_dir / "config.toml"
    config.write_text(
        'model = "gpt-test"\n'
        '[mcp_servers.playwright]\n'
        'command = "playwright-mcp"\n'
        '[mcp_servers.render]\n'
        'command = "sk-configsecret-should-not-render"\n',
        encoding="utf-8",
    )
    return argparse.Namespace(
        pretty=False,
        latest=False,
        artifact=[],
        session_root=str(codex_dir / "sessions"),
        codex_config=str(config),
    )


def test_artifact_tool_table_suppresses_payloads_and_flags_mcp_mismatch():
    tmp = Path(tempfile.mkdtemp(prefix="codex-tool-table-test-"))
    args = make_args(tmp)
    artifact = tmp / "session.jsonl"
    artifact.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "type": "init",
                        "tools": [
                            {"name": "mcp__playwright__browser_click", "description": "SECRET_DESCRIPTION"},
                            {"name": "mcp__sentry"},
                            {"name": "apply_patch"},
                        ],
                    }
                ),
                json.dumps(
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "function_call",
                            "name": "apply_patch",
                            "arguments": {"private": "SECRET_TRANSCRIPT_TEXT"},
                        },
                    }
                ),
                json.dumps(
                    {
                        "type": "event_msg",
                        "payload": {
                            "type": "agent_message",
                            "text": "user@example.com sk-proj-0000000000000000000000000000000000000000",
                        },
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )
    args.artifact = [str(artifact)]

    report = build_report(args)

    assert report["schema_version"] == "0.1", report
    assert report["tool_table"]["tool_name_count"] == 3, report
    assert report["tool_table"]["namespace_counts"]["mcp"] == 2, report
    assert report["tool_table"]["namespace_counts"]["codex_harness_tool"] == 1, report
    assert report["tool_table"]["used_and_active_names"] == ["apply_patch"], report
    assert report["mcp_tool_config_reconciliation"]["verdict"] == "recorded-mcp-tool-not-in-current-codex-config", report
    assert report["mcp_tool_config_reconciliation"]["matched_observed_servers"] == ["playwright"], report
    assert report["mcp_tool_config_reconciliation"]["unconfigured_observed_servers"] == ["sentry"], report
    assert report["mcp_tool_config_reconciliation"]["configured_not_observed_servers"] == ["render"], report
    rendered = json.dumps(report, sort_keys=True)
    assert "SECRET_DESCRIPTION" not in rendered, report
    assert "SECRET_TRANSCRIPT_TEXT" not in rendered, report
    assert "user@example.com" not in rendered, report
    assert "sk-proj-0000000000000000000000000000000000000000" not in rendered, report
    assert "sk-configsecret-should-not-render" not in rendered, report
    assert str(artifact) not in rendered, report


def test_malformed_artifact_reports_parse_errors_not_active_tools():
    tmp = Path(tempfile.mkdtemp(prefix="codex-tool-table-test-"))
    args = make_args(tmp)
    artifact = tmp / "session.jsonl"
    artifact.write_text("{bad\n", encoding="utf-8")
    args.artifact = [str(artifact)]

    report = build_report(args)
    artifact_row = report["artifact_scan"]["artifacts"][0]

    assert artifact_row["parse_status"] == "no-json-objects", artifact_row
    assert artifact_row["parse_mode"] == "jsonl-after-json-error", artifact_row
    assert artifact_row["json_parse_error_count"] == 1, artifact_row
    assert report["tool_table"]["tool_name_count"] == 0, report["tool_table"]
    assert report["tool_table"]["completeness"]["verdict"] == "recorded-session-tool-evidence-not-complete-active-table", report["tool_table"]


def test_latest_session_selection_emits_hashes_not_paths():
    tmp = Path(tempfile.mkdtemp(prefix="codex-tool-table-test-"))
    args = make_args(tmp)
    session_dir = tmp / ".codex/sessions/2026/06/15"
    session_dir.mkdir(parents=True)
    latest = session_dir / "rollout-new.jsonl"
    latest.write_text(json.dumps({"type": "init", "tools": [{"name": "update_plan"}]}), encoding="utf-8")
    os.utime(latest, (2, 2))
    args.latest = True
    args.session_root = str(tmp / ".codex/sessions")

    report = build_report(args)

    assert report["session"]["latest_found"] is True, report
    assert report["session"]["latest_path_sha256_16"], report
    assert report["tool_table"]["tool_names"] == ["update_plan"], report
    rendered = json.dumps(report, sort_keys=True)
    assert str(latest) not in rendered, report
    assert "rollout-new.jsonl" not in rendered, report


def test_tool_namespace_classification():
    assert classify_tool_namespace("mcp__render") == "mcp"
    assert classify_tool_namespace("functions.exec_command") == "developer_tool_namespace"
    assert classify_tool_namespace("browser_click") == "browser_harness_tool"
    assert classify_tool_namespace("update_plan") == "codex_harness_tool"
    assert classify_tool_namespace("create_goal") == "goal_harness_tool"
    assert classify_tool_namespace("spawn_agent") == "subagent_harness_tool"
    assert classify_tool_namespace("microsoft_docs_search") == "microsoft_docs_tool"


def test_tool_namespace_other_or_unknown_fallthrough():
    # Covers the final `return "other_or_unknown"` branch (line 46).
    # None of the known prefixes/names match; must return the fallback.
    result = classify_tool_namespace("some_completely_unknown_tool")
    assert result == "other_or_unknown", result

    result2 = classify_tool_namespace("view_image")
    assert result2 == "codex_harness_tool", result2  # sanity-check known case nearby

    result3 = classify_tool_namespace("totally_novel_xyz")
    assert result3 == "other_or_unknown", result3


def test_namespace_counts_aggregates_correctly():
    # Direct unit test for namespace_counts: multi-name input produces correct bucket sums.
    names = [
        "mcp__playwright__click",
        "mcp__sentry__alert",
        "apply_patch",
        "exec_command",
        "some_unknown_tool_xyz",
        "another_unknown",
    ]
    counts = namespace_counts(names)
    assert counts["mcp"] == 2, counts
    assert counts["codex_harness_tool"] == 2, counts
    assert counts["other_or_unknown"] == 2, counts


def test_artifact_tool_sets_skips_non_dict_artifact():
    # Line 62: artifact entry that is not a dict must be skipped (continue).
    # The artifact list contains a string (non-dict) plus a valid artifact.
    tool_scan = {
        "artifacts": [
            "not-a-dict",  # triggers the non-dict branch → continue
            {
                "channels": {
                    "active_schema_or_request_tool": ["apply_patch"],
                }
            },
        ]
    }
    result = artifact_tool_sets(tool_scan)
    assert result == {"active_schema_or_request_tool": {"apply_patch"}}, result


def test_artifact_tool_sets_skips_non_dict_channels():
    # Line 62: artifact where channels is not a dict (e.g. None or a list) → continue.
    tool_scan = {
        "artifacts": [
            {"channels": None},           # channels is None → skip
            {"channels": ["not", "dict"]}, # channels is list → skip
            {"channels": {"tool_use_event": ["exec_command"]}},  # valid
        ]
    }
    result = artifact_tool_sets(tool_scan)
    assert result == {"tool_use_event": {"exec_command"}}, result


def test_artifact_tool_sets_skips_non_list_channel_values():
    # Line 65: a channel entry whose value is not a list → continue.
    tool_scan = {
        "artifacts": [
            {
                "channels": {
                    "active_schema_or_request_tool": "not-a-list",  # skip → continue
                    "tool_use_event": ["apply_patch"],              # valid
                }
            }
        ]
    }
    result = artifact_tool_sets(tool_scan)
    # Only tool_use_event should be present; non-list channel skipped.
    assert "active_schema_or_request_tool" not in result, result
    assert result.get("tool_use_event") == {"apply_patch"}, result


def test_build_tool_table_no_artifact_parsed_returns_fallback():
    # Lines 128-135: when tool_scan status is not "parsed", build_tool_table is bypassed
    # and the fallback dict with verdict "no-artifact-parsed" is used instead.
    tmp = Path(tempfile.mkdtemp(prefix="codex-tool-table-fallback-"))
    args = make_args(tmp)
    # No artifact supplied and latest=False → tool_scan status = "not_provided" → fallback
    report = build_report(args)
    tt = report["tool_table"]
    assert tt["tool_name_count"] == 0, tt
    assert tt["tool_names"] == [], tt
    assert tt["namespace_counts"] == {}, tt
    assert tt["channel_counts"] == {}, tt
    assert tt["channels"] == {}, tt
    assert tt["completeness"]["verdict"] == "no-artifact-parsed", tt
    assert "pass --latest or --artifact" in tt["completeness"]["reason"], tt


def test_build_tool_table_used_not_active_detection():
    # Exercises the "used_not_active_names" computation: a tool that appears in
    # tool_use_event but NOT in active_schema_or_request_tool.
    tool_scan = {
        "status": "parsed",
        "artifacts": [
            {
                "channels": {
                    "active_schema_or_request_tool": ["apply_patch"],
                    "tool_use_event": ["apply_patch", "exec_command"],  # exec_command not in active
                    "tool_result_event": ["apply_patch"],
                    "deferred_or_search_result": ["some_deferred_tool"],
                }
            }
        ]
    }
    result = build_tool_table(tool_scan)
    assert "exec_command" in result["used_not_active_names"], result
    assert result["active_not_used_names"] == [], result
    assert result["used_and_active_names"] == ["apply_patch"], result
    assert result["tool_use_event_count"] == 2, result
    assert result["tool_result_event_count"] == 1, result
    assert result["deferred_or_search_result_count"] == 1, result


def test_main_no_args_emits_valid_json_with_no_artifact_schema():
    # Call main() directly (covering lines 157-166) with a temp config dir.
    tmp = Path(tempfile.mkdtemp(prefix="codex-tool-table-main-"))
    codex_dir = tmp / ".codex"
    codex_dir.mkdir()
    config = codex_dir / "config.toml"
    config.write_text('[mcp_servers.test]\ncommand = "test-mcp"\n', encoding="utf-8")
    sessions_dir = codex_dir / "sessions"
    sessions_dir.mkdir()

    buf = io.StringIO()
    rc = None
    with redirect_stdout(buf):
        rc = main([
            "--session-root", str(sessions_dir),
            "--codex-config", str(config),
        ])

    assert rc == 0, rc
    out = buf.getvalue()
    report = json.loads(out)
    assert report["schema"] == "agent-runtime-codex-session-tool-table", report
    assert report["tool_table"]["completeness"]["verdict"] == "no-artifact-parsed", report


def test_main_pretty_flag_emits_indented_json():
    # Covers the `indent=2` branch on line 165 (--pretty).
    tmp = Path(tempfile.mkdtemp(prefix="codex-tool-table-pretty-"))
    codex_dir = tmp / ".codex"
    codex_dir.mkdir()
    config = codex_dir / "config.toml"
    config.write_text("", encoding="utf-8")
    sessions_dir = codex_dir / "sessions"
    sessions_dir.mkdir()

    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = main([
            "--pretty",
            "--session-root", str(sessions_dir),
            "--codex-config", str(config),
        ])

    assert rc == 0, rc
    out = buf.getvalue()
    # Pretty-printed JSON has newlines with indentation
    assert "\n  " in out, "Expected indented JSON output"
    report = json.loads(out)
    assert report["schema"] == "agent-runtime-codex-session-tool-table", report


def test_main_with_artifact_flag():
    # Call main() with --artifact to exercise that CLI path end-to-end.
    tmp = Path(tempfile.mkdtemp(prefix="codex-tool-table-artifact-"))
    codex_dir = tmp / ".codex"
    codex_dir.mkdir()
    config = codex_dir / "config.toml"
    config.write_text('[mcp_servers.playwright]\ncommand = "playwright-mcp"\n', encoding="utf-8")
    sessions_dir = codex_dir / "sessions"
    sessions_dir.mkdir()
    artifact = tmp / "session.jsonl"
    artifact.write_text(
        json.dumps({"type": "init", "tools": [{"name": "mcp__playwright__click"}, {"name": "exec_command"}]}),
        encoding="utf-8",
    )

    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = main([
            "--artifact", str(artifact),
            "--session-root", str(sessions_dir),
            "--codex-config", str(config),
        ])

    assert rc == 0, rc
    report = json.loads(buf.getvalue())
    assert report["tool_table"]["tool_name_count"] == 2, report
    assert "exec_command" in report["tool_table"]["tool_names"], report
    # exec_command is a codex_harness_tool (starts with exec_command is in the set)
    assert report["tool_table"]["namespace_counts"].get("codex_harness_tool", 0) == 1, report
    assert report["mcp_tool_config_reconciliation"]["matched_observed_servers"] == ["playwright"], report


def test_cli_entrypoint_emits_valid_json():
    # E2e: runs the probe as a subprocess to cover the `__main__` path.
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH)],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-codex-session-tool-table", report
    assert "tool_table" in report, report
    assert "mcp_tool_config_reconciliation" in report, report


def test_latest_requested_but_no_session_found():
    # latest=True but sessions dir is empty → latest_found is False, tool_table fallback.
    tmp = Path(tempfile.mkdtemp(prefix="codex-tool-table-nolatest-"))
    args = make_args(tmp)
    empty_sessions = tmp / "empty_sessions"
    empty_sessions.mkdir()
    args.latest = True
    args.session_root = str(empty_sessions)

    report = build_report(args)

    assert report["session"]["latest_requested"] is True, report
    assert report["session"]["latest_found"] is False, report
    assert report["session"]["latest_path_sha256_16"] is None, report
    assert report["session"]["latest_size_bytes"] is None, report
    # No artifact parsed → fallback tool_table
    assert report["tool_table"]["completeness"]["verdict"] == "no-artifact-parsed", report


def test_artifact_with_non_string_channel_names_skipped():
    # Exercises line 68: non-string names inside a valid list are not added.
    tool_scan = {
        "artifacts": [
            {
                "channels": {
                    "active_schema_or_request_tool": [123, None, "valid_tool", True],
                }
            }
        ]
    }
    result = artifact_tool_sets(tool_scan)
    # Only "valid_tool" is a str
    assert result == {"active_schema_or_request_tool": {"valid_tool"}}, result


def test_reconciliation_no_artifact_returns_requires_artifact_verdict():
    # When no artifact is parsed, reconcile_mcp_tool_names returns "requires-tool-artifact".
    tmp = Path(tempfile.mkdtemp(prefix="codex-tool-table-recon-"))
    args = make_args(tmp)
    # No artifact; tool_scan.status = "not_provided"
    report = build_report(args)
    recon = report["mcp_tool_config_reconciliation"]
    assert recon["verdict"] == "requires-tool-artifact", recon
    assert recon["status"] == "not_provided", recon


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} Codex session tool-table probe tests passed")
