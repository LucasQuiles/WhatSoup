#!/usr/bin/env python3
"""Tests for mcp_json_diagnostic."""
from __future__ import annotations

import io
import json
import os
import stat
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import mcp_json_diagnostic as probe  # noqa: E402
from mcp_json_diagnostic import (  # noqa: E402
    build_report,
    diagnose_path,
    env_key_count,
    mode_class,
    size_class,
    summarize_mcp_servers,
    transport_class,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "mcp_json_diagnostic.py"


def _tmp_mcp(content: str | None) -> Path:
    path = Path(tempfile.mkdtemp(prefix="mcp-json-diagnostic-test-")) / ".mcp.json"
    if content is not None:
        path.write_text(content, encoding="utf-8")
    return path


def test_zero_byte_mcp_json_is_invalid_without_mutation():
    path = Path(tempfile.mkdtemp(prefix="mcp-json-diagnostic-test-")) / ".mcp.json"
    path.write_text("", encoding="utf-8")
    report = build_report([path])

    row = report["paths"][0]
    assert row["exists"] is True, report
    assert row["size_class"] == "zero_byte", report
    assert row["parse_status"] == "invalid", report
    assert row["fault_class"] == "zero_byte_invalid_json", report
    assert row["recommended_action"] == "remove_if_unneeded_or_replace_with_valid_json_object", report
    assert path.exists(), "probe must not remove or mutate the file"


def test_invalid_json_suppresses_raw_content_and_secret_canaries():
    path = Path(tempfile.mkdtemp(prefix="mcp-json-diagnostic-test-")) / ".mcp.json"
    path.write_text('{"mcpServers": {"secret-server": "sk-shouldnotleak123456"', encoding="utf-8")
    report = build_report([path])
    rendered = json.dumps(report, sort_keys=True)

    row = report["paths"][0]
    assert row["parse_status"] == "invalid", report
    assert row["fault_class"] == "json_decode_error", report
    assert row["error_class"] == "JSONDecodeError", report
    for forbidden in ["secret-server", "sk-shouldnotleak", "mcpServers\":"]:
        assert forbidden not in rendered, forbidden
    assert "error_line" in rendered, report
    assert "error_column" in rendered, report


def test_valid_mcp_json_emits_shape_not_values():
    path = Path(tempfile.mkdtemp(prefix="mcp-json-diagnostic-test-")) / ".mcp.json"
    path.write_text(json.dumps({
        "mcpServers": {
            "private-pinecone": {
                "command": "/Users/testuser/.local/bin/pinecone-mcp",
                "args": ["--api-key", "pcsk_shouldnotleak000000"],
                "env": {"PINECONE_API_KEY": "pcsk_shouldnotleak000000"},
            },
            "private-remote": {
                "url": "https://secret.example.invalid/mcp?token=ghp_shouldnotleak0000000000000000",
                "headers": {"Authorization": "Bearer shouldnotleak"},
            },
        },
        "otherKey": "person@example.com",
    }), encoding="utf-8")

    row = diagnose_path(path)
    assert row["parse_status"] == "valid_object", row
    assert row["shape"] == "object", row
    assert row["mcp_server_summary"]["server_count"] == 2, row
    assert row["mcp_server_summary"]["transport_counts"] == {"http": 1, "stdio": 1}, row
    assert row["mcp_server_summary"]["env_key_count_total"] == 1, row

    rendered = json.dumps(row, sort_keys=True)
    for forbidden in [
        "private-pinecone",
        "private-remote",
        "pinecone-mcp",
        "secret.example.invalid",
        "pcsk_shouldnotleak",
        "ghp_shouldnotleak",
        "Authorization",
        "Bearer shouldnotleak",
        "person@example.com",
        "otherKey",
    ]:
        assert forbidden not in rendered, forbidden
    assert "server_name_hashes" in rendered, row
    assert "top_level_key_hashes" in rendered, row


def test_missing_file_reports_not_present_without_creation():
    path = _tmp_mcp(None)  # directory exists, file does not
    assert not path.exists()
    report = build_report([path])
    row = report["paths"][0]
    assert row["exists"] is False, row
    assert row["size_bytes"] is None, row
    assert row["size_class"] == "missing", row
    assert row["mode_class"] is None, row
    assert row["content_sha256_16"] is None, row
    assert row["parse_status"] == "missing", row
    assert row["shape"] == "absent", row
    assert row["fault_class"] == "not_present", row
    assert row["recommended_action"] == "no_action_if_not_needed", row
    assert not path.exists(), "probe must not create the file"
    # summary aggregation reflects the missing row
    assert report["summary"]["exists_count"] == 0, report
    assert report["summary"]["parse_status_counts"] == {"missing": 1}, report
    assert report["summary"]["fault_class_counts"] == {"not_present": 1}, report


def test_valid_non_object_json_is_typed_and_values_suppressed():
    # top-level JSON array containing secret-shaped strings
    path = _tmp_mcp('["sk-shouldnotleak999999", "person@evil.invalid"]')
    row = diagnose_path(path)
    assert row["parse_status"] == "valid_non_object", row
    assert row["shape"] == "list", row
    assert row["fault_class"] == "valid_json_wrong_top_level_shape", row
    assert row["recommended_action"] == "replace_with_object_shape_if_used_by_mcp_loader", row
    # no mcp summary / key hashes for a non-object document
    assert "mcp_server_summary" not in row, row
    assert "top_level_key_hashes" not in row, row
    rendered = json.dumps(row, sort_keys=True)
    for forbidden in ["sk-shouldnotleak", "person@evil.invalid"]:
        assert forbidden not in rendered, forbidden


def test_mode_class_private_0600():
    path = _tmp_mcp("{}")
    os.chmod(path, 0o600)
    assert mode_class(path) == "private_0600", oct(stat.S_IMODE(path.stat().st_mode))


def test_mode_class_group_or_world_accessible():
    path = _tmp_mcp("{}")
    os.chmod(path, 0o644)
    assert mode_class(path) == "group_or_world_accessible"


def test_mode_class_owner_only_nonstandard():
    path = _tmp_mcp("{}")
    os.chmod(path, 0o700)  # owner rwx, no group/world bits, != 0o600
    assert mode_class(path) == "owner_only_nonstandard"


def test_mode_class_none_for_missing_path():
    assert mode_class(Path("/nonexistent-xyz-mcp/.mcp.json")) is None


def test_size_class_boundaries():
    assert size_class(None) == "missing"
    assert size_class(0) == "zero_byte"
    assert size_class(1) == "small"
    assert size_class(1023) == "small"
    assert size_class(1024) == "medium"
    assert size_class(1024 * 1024 - 1) == "medium"
    assert size_class(1024 * 1024) == "large"


def test_transport_class_covers_all_branches():
    assert transport_class({"url": "https://x.invalid"}) == "http"
    assert transport_class({"command": "/bin/x"}) == "stdio"
    assert transport_class({"command": ["/bin/x", "--flag"]}) == "stdio"
    assert transport_class({"args": ["--flag"]}) == "unknown"
    assert transport_class("not-a-dict") == "non_object_spec"
    assert transport_class(["list-spec"]) == "non_object_spec"


def test_env_key_count_branches():
    assert env_key_count({"env": {"A": "1", "B": "2"}}) == 2
    assert env_key_count({"environment": {"A": "1"}}) == 1
    assert env_key_count({"env": "not-a-dict"}) == 0
    assert env_key_count({}) == 0
    assert env_key_count("not-a-dict") == 0


def test_summarize_mcp_servers_missing_key():
    summary = summarize_mcp_servers({"otherKey": 1})
    assert summary["mcp_servers_present"] is False, summary
    assert summary["mcp_servers_shape"] == "missing", summary
    assert summary["server_count"] == 0, summary
    assert summary["server_name_hashes"] == [], summary
    assert summary["transport_counts"] == {}, summary
    assert summary["env_key_count_total"] == 0, summary


def test_summarize_mcp_servers_wrong_shape_reports_type_not_value():
    # mcpServers present but a list, not an object — shape reported as type name
    summary = summarize_mcp_servers({"mcpServers": ["secret-server-name"]})
    assert summary["mcp_servers_present"] is True, summary
    assert summary["mcp_servers_shape"] == "list", summary
    assert summary["server_count"] == 0, summary
    rendered = json.dumps(summary, sort_keys=True)
    assert "secret-server-name" not in rendered, rendered


def test_valid_object_with_non_object_server_spec_classified_unknown():
    # server spec is a bare string (non-object) -> transport non_object_spec, env count 0
    path = _tmp_mcp(json.dumps({"mcpServers": {"weird": "ghp_shouldnotleak1234567890123456"}}))
    row = diagnose_path(path)
    assert row["parse_status"] == "valid_object", row
    summary = row["mcp_server_summary"]
    assert summary["server_count"] == 1, summary
    assert summary["transport_counts"] == {"non_object_spec": 1}, summary
    assert summary["env_key_count_total"] == 0, summary
    rendered = json.dumps(row, sort_keys=True)
    assert "ghp_shouldnotleak" not in rendered, rendered
    assert "weird" not in rendered, rendered


def test_main_default_path_emits_valid_report_via_monkeypatched_target():
    # Point DEFAULT_PATH at a fixture so main()'s no-arg branch is exercised
    # without reading the real ~/.mcp.json.
    path = _tmp_mcp(json.dumps({"mcpServers": {"s": {"command": "/bin/x"}}}))
    orig = probe.DEFAULT_PATH
    orig_argv = sys.argv
    probe.DEFAULT_PATH = path
    sys.argv = ["mcp_json_diagnostic.py"]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        probe.DEFAULT_PATH = orig
        sys.argv = orig_argv
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-mcp-json-diagnostic"
    assert report["summary"]["path_count"] == 1, report
    assert report["paths"][0]["parse_status"] == "valid_object", report


def test_main_with_explicit_paths_and_pretty():
    path = _tmp_mcp(json.dumps({"mcpServers": {}}))
    orig_argv = sys.argv
    sys.argv = ["mcp_json_diagnostic.py", "--path", str(path), "--pretty"]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
    assert rc == 0
    raw = buf.getvalue()
    assert "\n  " in raw, "pretty output should be indented"
    report = json.loads(raw)
    assert report["summary"]["path_count"] == 1, report
    assert report["paths"][0]["parse_status"] == "valid_object", report


def test_cli_entrypoint_emits_valid_json_for_fixture():
    # e2e: covers the `if __name__ == "__main__"` entrypoint as a real subprocess.
    path = _tmp_mcp(json.dumps({"mcpServers": {"x": {"url": "https://h.invalid"}}}))
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--path", str(path)],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-mcp-json-diagnostic"
    assert report["paths"][0]["parse_status"] == "valid_object", report
    assert "h.invalid" not in proc.stdout, "raw url must not leak"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} MCP JSON diagnostic tests passed")
