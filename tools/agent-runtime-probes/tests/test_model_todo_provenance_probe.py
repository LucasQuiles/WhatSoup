#!/usr/bin/env python3
"""Tests for model_todo_provenance_probe."""
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

import model_todo_provenance_probe as probe  # noqa: E402
from model_todo_provenance_probe import (  # noqa: E402
    aggregate_tool_artifacts,
    artifact_target,
    build_report,
    claim_verdicts,
    claude_settings_summary,
    codex_config_summary,
    collect_tool_names,
    configured_codex_mcp_servers,
    extract_schema_name,
    latest_codex_session_path,
    matching_terms,
    mcp_server_from_tool_name,
    normalize_mcp_server_name,
    parse_artifact_objects,
    reconcile_mcp_tool_names,
    safe_model_list,
    safe_tool_name,
    scan_text_file,
    summarize_target_matrix,
    target_matches,
    tool_artifact_summary,
    tool_callability_verdict,
    value_kind,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "model_todo_provenance_probe.py"


def make_args(tmp: Path) -> argparse.Namespace:
    claude_dir = tmp / ".claude"
    codex_dir = tmp / ".codex"
    claude_dir.mkdir()
    codex_dir.mkdir()
    claude_settings = claude_dir / "settings.json"
    codex_config = codex_dir / "config.toml"
    quick = codex_dir / "quick.config.toml"
    reference = tmp / "settings-reference.md"
    doc = tmp / "runtime-doc.md"

    claude_settings.write_text(
        json.dumps({"fallbackModel": ["claude-opus-4-8", "claude-sonnet-4-6"]}),
        encoding="utf-8",
    )
    codex_config.write_text(
        'model = "gpt-test"\nmodel_reasoning_effort = "low"\n',
        encoding="utf-8",
    )
    quick.write_text('model = "gpt-test"\nmodel_reasoning_effort = "low"\n', encoding="utf-8")
    reference.write_text("| **TodoWrite** | Creates and manages structured task lists | No |\n", encoding="utf-8")
    doc.write_text(
        'Claim: "TodoWrite disabled as of v2.1.142" is not a sourced fact.\n'
        "Claim: claude-fable-5 appeared in an old note.\n",
        encoding="utf-8",
    )
    return argparse.Namespace(
        pretty=False,
        skip_commands=True,
        claude_settings=str(claude_settings),
        codex_config=str(codex_config),
        codex_profile=[str(quick)],
        claude_reference=str(reference),
        doc=[str(doc)],
        tool_artifact=[],
        latest_codex_session=False,
        codex_session_root=str(tmp / ".codex/sessions"),
    )


def test_fallback_model_does_not_prove_primary_model():
    tmp = Path(tempfile.mkdtemp(prefix="model-todo-probe-test-"))
    report = build_report(make_args(tmp))
    assert report["schema_version"] == "0.3", report
    assert report["claude_settings"]["fallbackModel_values"] == ["claude-opus-4-8", "claude-sonnet-4-6"], report
    assert report["claude_settings"]["model_value"] is None, report
    assert report["claim_verdicts"]["claude_primary_model"]["verdict"] == "static-config-primary-unproven", report
    assert report["claim_verdicts"]["opus_4_8_claim"]["verdict"] == "fallback-member-not-primary-proof", report


def test_todowrite_version_phrase_is_demoted_not_promoted_to_fact():
    tmp = Path(tempfile.mkdtemp(prefix="model-todo-probe-test-"))
    report = build_report(make_args(tmp))
    assert report["doc_scan"]["aggregate_term_counts"]["version_2_1_142"] == 1, report
    assert report["doc_scan"]["aggregate_term_counts"]["todowrite"] == 1, report
    assert report["local_claude_tool_reference"]["todowrite_refs"] == 1, report
    assert report["claim_verdicts"]["v2_1_142_todowrite_disabled_claim"]["verdict"] == "demote-unsubstantiated-product-fact", report
    assert report["claim_verdicts"]["todowrite_current_callability"]["verdict"] == "not-probed", report


def test_probe_does_not_emit_doc_line_bodies_or_secret_values():
    tmp = Path(tempfile.mkdtemp(prefix="model-todo-probe-test-"))
    args = make_args(tmp)
    Path(args.doc[0]).write_text(
        "TodoWrite mentioned near sk-abcd1234efgh5678 and user@example.com\n",
        encoding="utf-8",
    )
    report = build_report(args)
    rendered = json.dumps(report, sort_keys=True)
    assert "mentioned near" not in rendered, report
    assert "sk-abcd1234efgh5678" not in rendered, report
    assert "user@example.com" not in rendered, report
    assert "line_sha256_16" in rendered, report


def test_tool_artifact_parser_extracts_task_surfaces_without_payloads():
    tmp = Path(tempfile.mkdtemp(prefix="model-todo-probe-test-"))
    args = make_args(tmp)
    artifact = tmp / "tool-capture.jsonl"
    artifact.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "type": "init",
                        "tools": [
                            {"name": "TaskCreate", "description": "SECRET_PAYLOAD_SHOULD_NOT_RENDER"},
                            {"type": "function", "function": {"name": "functions.update_plan"}},
                            {"name": "mcp__tmup__task_list"},
                        ],
                    }
                ),
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {
                            "content": [
                                {
                                    "type": "tool_use",
                                    "name": "TodoWrite",
                                    "input": {"token": "sk-artifactsecret123456"},
                                }
                            ]
                        },
                    }
                ),
                json.dumps({"results": [{"name": "TaskUpdate", "description": "user@example.com"}]}),
            ]
        ),
        encoding="utf-8",
    )
    args.tool_artifact = [str(artifact)]
    report = build_report(args)
    scan = report["tool_artifact_scan"]
    assert scan["status"] == "parsed", report
    assert scan["aggregate_target_matrix"]["TodoWrite"]["status"] == "observed", report
    assert scan["aggregate_target_matrix"]["Task_family"]["status"] == "observed", report
    assert scan["aggregate_target_matrix"]["tmup_task_tools"]["status"] == "observed", report
    assert scan["aggregate_target_matrix"]["codex_update_plan"]["status"] == "observed", report
    assert report["claim_verdicts"]["todowrite_current_callability"]["verdict"] == "observed-in-supplied-artifact", report
    rendered = json.dumps(report, sort_keys=True)
    assert "SECRET_PAYLOAD_SHOULD_NOT_RENDER" not in rendered, report
    assert "sk-artifactsecret123456" not in rendered, report
    assert "user@example.com" not in rendered, report
    assert "TaskCreate" in rendered, report
    assert "TodoWrite" in rendered, report


def test_artifact_parser_marks_jsonl_after_json_document_error():
    objects, errors, mode = parse_artifact_objects('{"type":"init"}\nnot-json\n')
    assert mode == "jsonl-after-json-error", (objects, errors, mode)
    assert errors == 1, (objects, errors, mode)
    assert objects == [{"type": "init"}], objects


def test_tool_artifact_non_observation_is_not_absence():
    tmp = Path(tempfile.mkdtemp(prefix="model-todo-probe-test-"))
    args = make_args(tmp)
    artifact = tmp / "tool-capture.json"
    artifact.write_text(json.dumps({"type": "init", "tools": [{"name": "Read"}]}), encoding="utf-8")
    args.tool_artifact = [str(artifact)]
    report = build_report(args)
    verdict = report["claim_verdicts"]["todowrite_current_callability"]
    assert verdict["verdict"] == "not-observed-in-supplied-artifact", report
    assert "non-observation is not absence" in verdict["reason"], report


def test_mcp_reconciliation_flags_recorded_tool_not_in_static_codex_config():
    tmp = Path(tempfile.mkdtemp(prefix="model-todo-probe-test-"))
    args = make_args(tmp)
    Path(args.codex_config).write_text(
        'model = "gpt-test"\n'
        '[mcp_servers.playwright]\n'
        'command = "sk-configsecret-should-not-render"\n'
        '[mcp_servers.render]\n'
        'command = "render-mcp"\n',
        encoding="utf-8",
    )
    artifact = tmp / "tool-capture.jsonl"
    artifact.write_text(
        json.dumps(
            {
                "type": "init",
                "tools": [
                    {"name": "mcp__playwright__browser_click"},
                    {"name": "mcp__sentry"},
                ],
            }
        ),
        encoding="utf-8",
    )
    args.tool_artifact = [str(artifact)]

    report = build_report(args)
    reconciliation = report["mcp_tool_config_reconciliation"]

    assert reconciliation["status"] == "compared", report
    assert reconciliation["verdict"] == "recorded-mcp-tool-not-in-current-codex-config", report
    assert reconciliation["matched_observed_servers"] == ["playwright"], report
    assert reconciliation["unconfigured_observed_servers"] == ["sentry"], report
    assert reconciliation["configured_not_observed_servers"] == ["render"], report
    rendered = json.dumps(report, sort_keys=True)
    assert "sk-configsecret-should-not-render" not in rendered, report


def test_latest_codex_session_mode_parses_tool_events_without_transcript_text():
    tmp = Path(tempfile.mkdtemp(prefix="model-todo-probe-test-"))
    args = make_args(tmp)
    session_dir = tmp / ".codex/sessions/2026/06/15"
    session_dir.mkdir(parents=True)
    old = session_dir / "rollout-old.jsonl"
    latest = session_dir / "rollout-new.jsonl"
    old.write_text(json.dumps({"type": "response_item", "payload": {"type": "function_call", "name": "Read"}}), encoding="utf-8")
    latest.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "type": "response_item",
                        "payload": {
                            "type": "function_call",
                            "name": "update_plan",
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
    os.utime(old, (1, 1))
    os.utime(latest, (2, 2))
    args.latest_codex_session = True
    args.codex_session_root = str(tmp / ".codex/sessions")

    report = build_report(args)

    scan = report["tool_artifact_scan"]
    assert report["codex_session_scan"]["latest_found"] is True, report
    assert scan["artifacts"][0]["source_class"] == "latest_codex_session_jsonl", report
    assert scan["aggregate_target_matrix"]["codex_update_plan"]["status"] == "observed", report
    rendered = json.dumps(report, sort_keys=True)
    assert "SECRET_TRANSCRIPT_TEXT" not in rendered, report
    assert "user@example.com" not in rendered, report
    assert "sk-proj-0000000000000000000000000000000000000000" not in rendered, report


# ---------------------------------------------------------------------------
# Unit tests for low-level helpers — cover missing branches
# ---------------------------------------------------------------------------

def test_safe_tool_name_rejects_slash():
    """UNHAPPY_TEST_TERMS: invalid — slash in name returns None (line 68)."""
    assert safe_tool_name("some/path") is None


def test_safe_tool_name_rejects_at():
    """UNHAPPY_TEST_TERMS: invalid — @ in name returns None (line 68)."""
    assert safe_tool_name("user@host") is None


def test_safe_tool_name_rejects_empty_after_strip():
    """UNHAPPY_TEST_TERMS: invalid — whitespace-only returns None (line 68)."""
    assert safe_tool_name("   ") is None


def test_safe_tool_name_rejects_non_string():
    """UNHAPPY_TEST_TERMS: invalid — non-string input returns None (line 64-65)."""
    assert safe_tool_name(42) is None
    assert safe_tool_name(None) is None
    assert safe_tool_name([]) is None


def test_safe_tool_name_rejects_regex_mismatch():
    """UNHAPPY_TEST_TERMS: invalid — starts with digit, fails TOOL_NAME regex (line 69)."""
    assert safe_tool_name("123invalid") is None


def test_value_kind_covers_all_branches():
    """Covers lines 73-81: null/string/list/dict/other branches of value_kind."""
    assert value_kind(None) == "null"
    assert value_kind("hello") == "string"
    assert value_kind([1, 2]) == "list"
    assert value_kind({"a": 1}) == "object"
    assert value_kind(3.14) == "float"
    assert value_kind(42) == "int"


def test_safe_model_list_string_input():
    """Covers line 86: safe_model_list with a bare string input."""
    result = safe_model_list("claude-opus-4-8")
    assert result == ["claude-opus-4-8"]


def test_safe_model_list_empty_input():
    """UNHAPPY_TEST_TERMS: missing — safe_model_list with non-string non-list (line 89)."""
    assert safe_model_list(None) == []
    assert safe_model_list(42) == []
    assert safe_model_list({}) == []


def test_extract_schema_name_string_item():
    """Covers line 100: extract_schema_name with a plain string input."""
    assert extract_schema_name("ReadFile") == "ReadFile"


def test_extract_schema_name_non_dict_non_string():
    """UNHAPPY_TEST_TERMS: invalid — extract_schema_name with int returns None (line 102)."""
    assert extract_schema_name(42) is None
    assert extract_schema_name(None) is None


def test_extract_schema_name_function_nested_name():
    """Covers line 109: extract_schema_name falls through to function.get('name')."""
    item = {"function": {"name": "ToolSearch"}}
    assert extract_schema_name(item) == "ToolSearch"


def test_collect_tool_names_tool_use_function_dict():
    """Covers line 134: collect_tool_names with function dict inside tool_use event."""
    channels: dict = {}
    obj = {"type": "tool_use", "function": {"name": "BashTool"}}
    collect_tool_names(obj, channels)
    assert "BashTool" in channels.get("tool_use_event", set())


def test_collect_tool_names_tool_result_event():
    """Covers lines 136-137: collect_tool_names with tool_result event type."""
    channels: dict = {}
    obj = {"type": "tool_result", "name": "ReadTool", "tool_name": "ReadTool"}
    collect_tool_names(obj, channels)
    assert "ReadTool" in channels.get("tool_result_event", set())


def test_collect_tool_names_tool_key_dict():
    """Covers line 148: collect_tool_names with 'tool' key in dict."""
    channels: dict = {}
    obj = {"tool": {"name": "WriteTool"}}
    collect_tool_names(obj, channels)
    assert "WriteTool" in channels.get("tool_use_event", set())


def test_collect_tool_names_toolcall_key():
    """Covers line 148: collect_tool_names with 'toolcall' key in dict."""
    channels: dict = {}
    obj = {"toolcall": {"name": "GlobTool"}}
    collect_tool_names(obj, channels)
    assert "GlobTool" in channels.get("tool_use_event", set())


def test_parse_artifact_objects_json_list():
    """Covers line 157: parse_artifact_objects returns json-list for a JSON array."""
    objects, errors, mode = parse_artifact_objects('[{"a": 1}, {"b": 2}]')
    assert mode == "json-list"
    assert errors == 0
    assert objects == [{"a": 1}, {"b": 2}]


def test_parse_artifact_objects_skips_blank_lines():
    """Covers line 167: empty lines are skipped in JSONL parsing (after JSON doc-level error)."""
    # Feed something that fails JSON parse but has valid JSONL lines separated by blanks
    objects, errors, mode = parse_artifact_objects('{"x": 1}\n\n{"y": 2}\nnot-json\n')
    assert mode == "jsonl-after-json-error"
    assert errors == 1  # 'not-json' line fails
    assert len(objects) == 2


def test_target_matches_tool_search():
    """Covers line 188: target_matches recognizes ToolSearch."""
    assert "tool_search" in target_matches("ToolSearch")
    assert "tool_search" in target_matches("tool_search")
    assert "tool_search" in target_matches("tool_search_tool")


def test_mcp_server_from_tool_name_empty_remainder():
    """UNHAPPY_TEST_TERMS: invalid — mcp__ with no server name returns None (line 201)."""
    assert mcp_server_from_tool_name("mcp__") is None


def test_mcp_server_from_tool_name_no_prefix():
    """UNHAPPY_TEST_TERMS: missing — non-mcp__ prefix returns None."""
    assert mcp_server_from_tool_name("SomeOtherTool") is None


def test_reconcile_mcp_tool_names_channels_not_dict():
    """UNHAPPY_TEST_TERMS: malformed — artifact channels is not dict (line 251)."""
    tool_scan = {
        "status": "parsed",
        "artifacts": [{"channels": "not-a-dict"}],
    }
    result = reconcile_mcp_tool_names(tool_scan, {})
    assert result["status"] == "compared"
    assert result["verdict"] == "no-recorded-mcp-tool-names"


def test_reconcile_mcp_tool_names_names_not_list():
    """UNHAPPY_TEST_TERMS: malformed — channel value is not a list (line 254)."""
    tool_scan = {
        "status": "parsed",
        "artifacts": [{"channels": {"some_channel": "not-a-list"}}],
    }
    result = reconcile_mcp_tool_names(tool_scan, {})
    assert result["status"] == "compared"
    assert result["verdict"] == "no-recorded-mcp-tool-names"


def test_reconcile_mcp_tool_names_name_not_str():
    """UNHAPPY_TEST_TERMS: malformed — channel entry is not str (line 257)."""
    tool_scan = {
        "status": "parsed",
        "artifacts": [{"channels": {"chan": [42, None, True]}}],
    }
    result = reconcile_mcp_tool_names(tool_scan, {})
    assert result["status"] == "compared"
    assert result["verdict"] == "no-recorded-mcp-tool-names"


def test_reconcile_mcp_observed_all_match_config():
    """Covers line 274: verdict is 'recorded-mcp-tools-match-current-codex-config'."""
    tool_scan = {
        "status": "parsed",
        "artifacts": [{"channels": {"active_schema_or_request_tool": ["mcp__myserver__do_thing"]}}],
    }
    codex_config = {"mcp_servers": {"myserver": {"command": "run"}}}
    result = reconcile_mcp_tool_names(tool_scan, codex_config)
    assert result["status"] == "compared"
    assert result["verdict"] == "recorded-mcp-tools-match-current-codex-config"
    assert result["matched_observed_servers"] == ["myserver"]


def test_tool_artifact_summary_missing_file():
    """UNHAPPY_TEST_TERMS: missing — parse_status is 'missing' for nonexistent path (lines 302-303)."""
    path = Path("/nonexistent-xyz/no-such-file.jsonl")
    result = tool_artifact_summary(path)
    assert result["exists"] is False
    assert result["parse_status"] == "missing"


def test_tool_artifact_summary_read_error():
    """UNHAPPY_TEST_TERMS: error — parse_status is 'read-error' on OSError (lines 306-309)."""
    tmp_path = Path(tempfile.mkdtemp(prefix="model-todo-probe-err-"))
    path = tmp_path / "broken.jsonl"
    path.write_text('{"ok": 1}', encoding="utf-8")
    orig_read_text = Path.read_text

    def boom(self, *args, **kwargs):
        if self == path:
            raise OSError("simulated read error")
        return orig_read_text(self, *args, **kwargs)

    Path.read_text = boom
    try:
        result = tool_artifact_summary(path)
    finally:
        Path.read_text = orig_read_text

    assert result["parse_status"] == "read-error"
    assert result["error_class"] == "OSError"


def test_latest_codex_session_path_root_missing():
    """UNHAPPY_TEST_TERMS: missing — returns None when root doesn't exist (line 337)."""
    result = latest_codex_session_path(Path("/nonexistent-xyz/sessions"))
    assert result is None


def test_latest_codex_session_path_no_jsonl_files():
    """UNHAPPY_TEST_TERMS: missing — returns None when no .jsonl files found (line 340)."""
    tmp_path = Path(tempfile.mkdtemp(prefix="model-todo-probe-sess-"))
    session_dir = tmp_path / "sessions"
    session_dir.mkdir()
    (session_dir / "some.txt").write_text("not jsonl", encoding="utf-8")
    result = latest_codex_session_path(session_dir)
    assert result is None


def test_claude_settings_summary_missing_or_nondict():
    """UNHAPPY_TEST_TERMS: missing — not-object-or-missing when settings isn't a dict (line 381)."""
    tmp_path = Path(tempfile.mkdtemp(prefix="model-todo-probe-cs-"))
    path = tmp_path / "settings.json"
    path.write_text("[]", encoding="utf-8")  # valid JSON but not a dict
    result = claude_settings_summary(path)
    assert result["parse_status"] == "not-object-or-missing"

    # Also test truly missing file
    missing_path = tmp_path / "no-settings.json"
    result2 = claude_settings_summary(missing_path)
    assert result2["parse_status"] == "not-object-or-missing"


def test_claude_settings_summary_no_model_no_fallback():
    """UNHAPPY_TEST_TERMS: missing — verdict is no-static-primary-model-config-found (lines 390-391)."""
    tmp_path = Path(tempfile.mkdtemp(prefix="model-todo-probe-nm-"))
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"theme": "dark"}), encoding="utf-8")
    result = claude_settings_summary(path)
    assert result["parse_status"] == "ok"
    assert result["verdict"] == "no-static-primary-model-config-found"
    assert result["fallbackModel_count"] == 0


def test_claude_settings_summary_model_set():
    """Covers line 387+535: primary-model-configured verdict and static-config-primary-proven in claim_verdicts."""
    tmp_path = Path(tempfile.mkdtemp(prefix="model-todo-probe-ms-"))
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"model": "claude-sonnet-4-6"}), encoding="utf-8")
    result = claude_settings_summary(path)
    assert result["verdict"] == "primary-model-configured"
    assert result["model_value"] == "claude-sonnet-4-6"


def test_codex_config_summary_profile_not_dict():
    """UNHAPPY_TEST_TERMS: missing — profile path doesn't exist returns not-object-or-missing (line 420)."""
    tmp_path = Path(tempfile.mkdtemp(prefix="model-todo-probe-cp-"))
    config_path = tmp_path / "config.toml"
    config_path.write_text('model = "test"\n', encoding="utf-8")
    missing_profile = tmp_path / "nonexistent.toml"
    result = codex_config_summary(config_path, [missing_profile])
    assert result["parse_status"] == "ok"
    profile_data = result["profiles"].get("nonexistent.toml", {})
    assert profile_data.get("parse_status") == "not-object-or-missing"


def test_codex_config_summary_config_not_dict():
    """UNHAPPY_TEST_TERMS: missing — not-object-or-missing when config file is absent (lines 423-427)."""
    tmp_path = Path(tempfile.mkdtemp(prefix="model-todo-probe-cd-"))
    config_path = tmp_path / "nonexistent-config.toml"
    # load_toml returns None for missing files; None is not a dict -> triggers the error branch
    result = codex_config_summary(config_path, [])
    assert result["parse_status"] == "not-object-or-missing"
    assert result["exists"] is False
    assert "profiles" in result


def test_scan_text_file_nonexistent_path():
    """UNHAPPY_TEST_TERMS: missing — returns early with exists=False (line 459)."""
    path = Path("/nonexistent-xyz/no-such-doc.md")
    result = scan_text_file(path)
    assert result["exists"] is False
    assert result["matches"] == []


def test_scan_text_file_os_error():
    """UNHAPPY_TEST_TERMS: error — OSError captured in result (lines 462-464)."""
    tmp_path = Path(tempfile.mkdtemp(prefix="model-todo-probe-sf-"))
    path = tmp_path / "doc.md"
    path.write_text("some content\n", encoding="utf-8")
    orig_read_text = Path.read_text

    def boom(self, *args, **kwargs):
        if self == path:
            raise OSError("simulated read error")
        return orig_read_text(self, *args, **kwargs)

    Path.read_text = boom
    try:
        result = scan_text_file(path)
    finally:
        Path.read_text = orig_read_text

    assert "error" in result
    assert "OSError" in result["error"]


def test_scan_text_file_line_with_no_matching_terms():
    """Covers line 468: continue branch when line has no matching terms."""
    tmp_path = Path(tempfile.mkdtemp(prefix="model-todo-probe-nm2-"))
    path = tmp_path / "doc.md"
    path.write_text("This line has no special terms at all.\n", encoding="utf-8")
    result = scan_text_file(path)
    assert result["matches"] == []
    assert result["match_count"] == 0


def test_artifact_target_when_no_aggregate_matrix():
    """UNHAPPY_TEST_TERMS: missing — artifact_target returns None when no aggregate_target_matrix (line 509)."""
    tool_scan = {"status": "parsed", "artifacts": []}
    result = artifact_target(tool_scan, "TodoWrite")
    assert result is None


def test_claim_verdicts_primary_proven_and_not_found_in_fallback():
    """Covers lines 535-539: static-config-primary-proven, not-found-in-checked-fallback-list."""
    claude = {
        "model_value": "claude-sonnet-4-6",
        "fallbackModel_values": ["claude-haiku-3-5"],
    }
    doc_counts = {k: 0 for k in ["version_2_1_142", "todowrite", "disabled_default", "fable"]}
    reference = {"verdict": "no-local-reference-todowrite-hit"}
    tool_scan = {"status": "not_provided"}
    result = claim_verdicts(claude, doc_counts, reference, tool_scan)
    assert result["claude_primary_model"]["verdict"] == "static-config-primary-proven"
    assert result["opus_4_8_claim"]["verdict"] == "not-found-in-checked-fallback-list"


def test_command_summary_called_when_skip_commands_false():
    """Covers lines 597-599: commands dict is populated when skip_commands=False."""
    tmp = Path(tempfile.mkdtemp(prefix="model-todo-probe-cmd-"))
    args = make_args(tmp)
    args.skip_commands = False
    # Mock command_summary via probe module attribute swap
    orig_run = probe.run
    probe.run = lambda cmd, timeout=10: {"rc": 0, "stdout": "fake-v1.0", "stderr": ""}
    try:
        report = build_report(args)
    finally:
        probe.run = orig_run
    assert "commands" in report
    assert "claude_version" in report["commands"]
    assert "codex_version" in report["commands"]


# ---------------------------------------------------------------------------
# Determinism test
# ---------------------------------------------------------------------------

def test_determinism_same_input_produces_identical_output():
    """Same args and files produce byte-identical JSON output across two calls."""
    tmp = Path(tempfile.mkdtemp(prefix="model-todo-probe-det-"))
    args = make_args(tmp)
    report1 = build_report(args)
    report2 = build_report(args)
    rendered1 = json.dumps(report1, sort_keys=True)
    rendered2 = json.dumps(report2, sort_keys=True)
    assert rendered1 == rendered2, "build_report is not deterministic"


# ---------------------------------------------------------------------------
# CLI e2e test — covers main() and the __main__ entrypoint
# ---------------------------------------------------------------------------

def test_cli_e2e_skip_commands_emits_valid_json_with_schema():
    """Covers lines 643-672: run probe as subprocess, assert exit 0 and JSON shape."""
    tmp = Path(tempfile.mkdtemp(prefix="model-todo-probe-e2e-"))
    claude_settings = tmp / "settings.json"
    codex_config = tmp / "config.toml"
    reference = tmp / "ref.md"
    doc = tmp / "doc.md"
    claude_settings.write_text(json.dumps({"fallbackModel": ["claude-opus-4-8"]}), encoding="utf-8")
    codex_config.write_text('model = "e2e-test"\n', encoding="utf-8")
    reference.write_text("| TodoWrite | task list tool |\n", encoding="utf-8")
    doc.write_text("Some documentation without claims.\n", encoding="utf-8")

    proc = subprocess.run(
        [
            sys.executable,
            str(PROBE_PATH),
            "--skip-commands",
            "--claude-settings", str(claude_settings),
            "--codex-config", str(codex_config),
            "--codex-profile", str(codex_config),
            "--claude-reference", str(reference),
            "--doc", str(doc),
            "--codex-session-root", str(tmp / "sessions"),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, f"probe exited nonzero: {proc.returncode}\nstderr: {proc.stderr}"
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-model-todo-provenance"
    assert report["schema_version"] == "0.3"
    assert "claim_verdicts" in report
    assert "limitations" in report


def test_cli_e2e_pretty_flag_produces_indented_output():
    """Covers args.pretty=True branch in main (line 670)."""
    tmp = Path(tempfile.mkdtemp(prefix="model-todo-probe-pretty-"))
    claude_settings = tmp / "settings.json"
    codex_config = tmp / "config.toml"
    reference = tmp / "ref.md"
    doc = tmp / "doc.md"
    claude_settings.write_text(json.dumps({}), encoding="utf-8")
    codex_config.write_text('model = "test"\n', encoding="utf-8")
    reference.write_text("", encoding="utf-8")
    doc.write_text("", encoding="utf-8")

    proc = subprocess.run(
        [
            sys.executable,
            str(PROBE_PATH),
            "--pretty",
            "--skip-commands",
            "--claude-settings", str(claude_settings),
            "--codex-config", str(codex_config),
            "--codex-profile", str(codex_config),
            "--claude-reference", str(reference),
            "--doc", str(doc),
            "--codex-session-root", str(tmp / "sessions"),
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, f"probe exited nonzero\nstderr: {proc.stderr}"
    # Pretty-print produces newlines within the JSON
    assert "\n" in proc.stdout
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-model-todo-provenance"


def test_tool_artifact_summary_empty_json_object():
    """Covers parse_status='no-json-objects' when JSON yields empty list."""
    tmp_path = Path(tempfile.mkdtemp(prefix="model-todo-probe-ej-"))
    path = tmp_path / "empty.jsonl"
    path.write_text("   \n   \n", encoding="utf-8")  # blank lines only, jsonl parse yields 0 objects
    result = tool_artifact_summary(path)
    assert result["parse_status"] == "no-json-objects"
    assert result["json_object_count"] == 0


def test_aggregate_tool_artifacts_no_paths():
    """Covers not_provided path in aggregate_tool_artifacts."""
    result = aggregate_tool_artifacts([])
    assert result["status"] == "not_provided"
    assert "verdict" in result


def test_collect_tool_names_search_result_list_branch():
    """Covers line 120: list under SEARCH_RESULT_KEYS emits to deferred_or_search_result."""
    channels: dict = {}
    obj = {"results": [{"name": "TaskUpdate"}, {"name": "ToolSearch"}]}
    collect_tool_names(obj, channels)
    assert "deferred_or_search_result" in channels
    names = channels["deferred_or_search_result"]
    assert "TaskUpdate" in names or "ToolSearch" in names


def test_collect_tool_names_tool_use_with_tool_name_field():
    """Covers line 131: tool_name field in tool_use event."""
    channels: dict = {}
    obj = {"type": "tool_use", "tool_name": "GrepTool"}
    collect_tool_names(obj, channels)
    assert "GrepTool" in channels.get("tool_use_event", set())


def test_collect_tool_names_search_result_key_in_dict():
    """Covers line 144-146: SEARCH_RESULT_KEYS key inside dict body."""
    channels: dict = {}
    obj = {"deferred_tools": [{"name": "TaskStop"}]}
    collect_tool_names(obj, channels)
    assert "deferred_or_search_result" in channels


def test_mcp_server_from_tool_name_normalizes_underscores():
    """Covers line 202: normalize_mcp_server_name strips underscores to dashes."""
    result = mcp_server_from_tool_name("mcp__my_server__do_thing")
    assert result == "my-server"


def test_extract_schema_name_function_dict_with_no_name():
    """UNHAPPY_TEST_TERMS: missing — extract_schema_name returns None when function dict lacks 'name' (line 109)."""
    item = {"function": {"description": "no name field here"}}
    result = extract_schema_name(item)
    assert result is None


def test_main_direct_call_via_argv_patching():
    """Covers main() body (lines 643-672) by calling it directly with argv override."""
    import model_todo_provenance_probe as _probe
    tmp = Path(tempfile.mkdtemp(prefix="model-todo-probe-main-"))
    claude_settings = tmp / "settings.json"
    codex_config = tmp / "config.toml"
    reference = tmp / "ref.md"
    doc = tmp / "doc.md"
    claude_settings.write_text(json.dumps({"fallbackModel": ["claude-opus-4-8"]}), encoding="utf-8")
    codex_config.write_text('model = "main-test"\n', encoding="utf-8")
    reference.write_text("| TodoWrite | task list |\n", encoding="utf-8")
    doc.write_text("No special claims here.\n", encoding="utf-8")

    orig_argv = sys.argv
    buf = io.StringIO()
    sys.argv = [
        "model_todo_provenance_probe.py",
        "--skip-commands",
        "--claude-settings", str(claude_settings),
        "--codex-config", str(codex_config),
        "--codex-profile", str(codex_config),
        "--claude-reference", str(reference),
        "--doc", str(doc),
        "--codex-session-root", str(tmp / "sessions"),
    ]
    try:
        with redirect_stdout(buf):
            rc = _probe.main()
    finally:
        sys.argv = orig_argv

    assert rc == 0, f"main() returned nonzero: {rc}"
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-model-todo-provenance"
    assert "claim_verdicts" in report


def test_main_direct_call_pretty_flag():
    """Covers the pretty=True branch inside main() (line 670 indent path)."""
    import model_todo_provenance_probe as _probe
    tmp = Path(tempfile.mkdtemp(prefix="model-todo-probe-pretty2-"))
    claude_settings = tmp / "settings.json"
    codex_config = tmp / "config.toml"
    reference = tmp / "ref.md"
    doc = tmp / "doc.md"
    claude_settings.write_text(json.dumps({}), encoding="utf-8")
    codex_config.write_text('model = "pretty-test"\n', encoding="utf-8")
    reference.write_text("", encoding="utf-8")
    doc.write_text("", encoding="utf-8")

    orig_argv = sys.argv
    buf = io.StringIO()
    sys.argv = [
        "model_todo_provenance_probe.py",
        "--pretty",
        "--skip-commands",
        "--claude-settings", str(claude_settings),
        "--codex-config", str(codex_config),
        "--codex-profile", str(codex_config),
        "--claude-reference", str(reference),
        "--doc", str(doc),
        "--codex-session-root", str(tmp / "sessions"),
    ]
    try:
        with redirect_stdout(buf):
            rc = _probe.main()
    finally:
        sys.argv = orig_argv

    assert rc == 0, f"main() returned nonzero: {rc}"
    output = buf.getvalue()
    assert "\n  " in output, "pretty output should contain indented lines"
    report = json.loads(output)
    assert report["schema"] == "agent-runtime-model-todo-provenance"


def test_claim_verdicts_with_model_set_proves_primary():
    """Covers lines 535-539: static-config-primary-proven branch inside claim_verdicts dict literal."""
    claude = {
        "model_value": "claude-sonnet-4-6",
        "fallbackModel_values": [],
    }
    doc_counts = {k: 0 for k in ["version_2_1_142", "todowrite", "disabled_default", "fable"]}
    reference = {"verdict": "no-local-reference-todowrite-hit"}
    tool_scan = {"status": "not_provided"}
    result = claim_verdicts(claude, doc_counts, reference, tool_scan)
    assert result["claude_primary_model"]["verdict"] == "static-config-primary-proven"
    assert result["claude_primary_model"]["reason"] == "model is set in checked Claude settings"
    assert result["opus_4_8_claim"]["verdict"] == "not-found-in-checked-fallback-list"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} model/Todo provenance probe tests passed")
