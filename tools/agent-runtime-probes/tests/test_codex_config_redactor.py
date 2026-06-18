#!/usr/bin/env python3
"""Unit tests for codex_config_redactor value/key suppression."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import codex_config_redactor as probe  # noqa: E402
from codex_config_redactor import (  # noqa: E402
    RedactionStats,
    build_report,
    doctor_summary,
    inventory_paths,
    main,
    parse_doctor_json,
    placeholder,
    redact_config_tree,
    source_row,
    summarize_base_config,
    summarize_legacy_hooks,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "codex_config_redactor.py"


def test_redacts_scalar_leaves_and_path_like_keys():
    stats = RedactionStats()
    cfg = {
        "model": "gpt-secret",
        "projects": {"/Users/testuser/private-project": {"trust_level": "trusted"}},
        "hooks": {"state": {"/Users/testuser/.codex/config.toml:pre_tool_use:0:0": {"trusted_hash": "sha256:abc"}}},
        "mcp_servers": {"x": {"env": {"TOKEN": "sk-aaaaaaaaaaaaaaaa"}}},
    }
    out = redact_config_tree(cfg, stats=stats)
    rendered = str(out)
    assert "gpt-secret" not in rendered, out
    assert "/Users/testuser" not in rendered, out
    assert "private-project" not in rendered, out
    assert "sk-aaaaaaaaaaaaaaaa" not in rendered, out
    assert "<redacted:key:" in rendered, out
    assert stats.redacted_keys == 2, stats


def test_report_reads_local_sources_without_values():
    root = Path(tempfile.mkdtemp(prefix="codex-redactor-test-"))
    (root / "agents").mkdir()
    (root / "config.toml").write_text(
        'model = "gpt-secret"\n'
        '[projects."/Users/testuser/private"]\n'
        'trust_level = "trusted"\n'
        '[mcp_servers.pinecone]\n'
        'command = "/Users/testuser/.local/bin/pinecone-mcp"\n',
        encoding="utf-8",
    )
    (root / "quick.config.toml").write_text('model = "quick-secret"\n', encoding="utf-8")
    (root / "agents" / "tmup-tier1.toml").write_text('model = "agent-secret"\n', encoding="utf-8")
    (root / "hooks.json").write_text(
        json.dumps([{"type": "PreToolUse", "matcher": "Bash", "hooks": [{"command": "/Users/testuser/private.sh"}]}]),
        encoding="utf-8",
    )
    (root / "version.json").write_text(json.dumps({"latest": "0.0.0"}), encoding="utf-8")

    report = build_report(root, root)
    rendered = str(report)
    assert report["schema"] == "codex-effective-config-redacted"
    assert report["summary"]["parsed_source_count"] == 5, report["summary"]
    assert report["summary"]["base_config"]["mcp_server_names"] == ["pinecone"], report["summary"]
    assert report["summary"]["legacy_hooks"]["available"] is True, report["summary"]
    assert report["summary"]["legacy_hooks"]["shape"] == "list", report["summary"]
    assert report["summary"]["legacy_hooks"]["command_count"] == 1, report["summary"]
    assert "gpt-secret" not in rendered, report
    assert "quick-secret" not in rendered, report
    assert "agent-secret" not in rendered, report
    assert "/Users/testuser/private" not in rendered, report
    assert "/Users/testuser/private.sh" not in rendered, report


def test_malformed_sources_are_error_status_not_available_config():
    root = Path(tempfile.mkdtemp(prefix="codex-redactor-test-"))
    root.joinpath("config.toml").write_text("[broken", encoding="utf-8")
    root.joinpath("hooks.json").write_text("{bad", encoding="utf-8")

    report = build_report(root, root)
    sources = {row["source_class"]: row for row in report["sources"]}

    assert sources["base_config"]["parse_status"] == "error", sources["base_config"]
    assert sources["base_config"]["error_type"] == "TOMLDecodeError", sources["base_config"]
    assert sources["legacy_hooks_json"]["parse_status"] == "error", sources["legacy_hooks_json"]
    assert sources["legacy_hooks_json"]["error_type"] == "JSONDecodeError", sources["legacy_hooks_json"]
    assert report["summary"]["base_config"] == {
        "available": False,
        "status": "error",
        "error_type": "TOMLDecodeError",
    }, report["summary"]["base_config"]
    assert report["summary"]["legacy_hooks"] == {
        "available": False,
        "status": "error",
        "error_type": "JSONDecodeError",
    }, report["summary"]["legacy_hooks"]


def test_doctor_summary_emits_detail_keys_not_detail_values():
    doctor = {
        "schemaVersion": 1,
        "overallStatus": "warning",
        "codexVersion": "0.139.0",
        "checks": {
            "config.load": {
                "category": "config",
                "status": "ok",
                "durationMs": 1,
                "details": {"config.toml": "/Users/testuser/.codex/config.toml", "model": "gpt-secret"},
            }
        },
    }
    out = doctor_summary(doctor, {"source": "fixture", "status": "parsed"})
    rendered = str(out)
    assert out["check_count"] == 1, out
    assert out["checks"][0]["detail_keys"] == ["config.toml", "model"], out
    assert "gpt-secret" not in rendered, out
    assert "/Users/testuser/.codex/config.toml" not in rendered, out


def test_placeholder_tags_every_scalar_kind_by_type():
    # Each scalar leaf is suppressed but its TYPE is preserved in the placeholder tag.
    assert placeholder(True, "scalar") == "<redacted:scalar:bool>"
    assert placeholder(7, "scalar") == "<redacted:scalar:int>"
    assert placeholder(1.5, "sensitive") == "<redacted:sensitive:float>"
    assert placeholder("x", "scalar") == "<redacted:scalar:str>"
    # bytes is not one of the explicit scalar kinds -> falls back to the python type name.
    assert placeholder(b"x", "scalar") == "<redacted:scalar:bytes>"


def test_redact_config_tree_preserves_none_leaf_and_creates_own_stats():
    # value is None -> returned verbatim (not a placeholder), and a stats object is
    # created internally when none is supplied (no crash, no leaf counted for None).
    assert redact_config_tree(None) is None
    out = redact_config_tree({"a": None, "b": "gpt-secret"})
    assert out["a"] is None, out
    assert out["b"] == "<redacted:scalar:str>", out
    assert "gpt-secret" not in str(out), out


def test_redact_config_tree_int_leaf_is_scalar_placeholder_carrying_no_value():
    stats = RedactionStats()
    out = redact_config_tree({"timeout": 30, "ratio": 0.5}, stats=stats)
    assert out == {"timeout": "<redacted:scalar:int>", "ratio": "<redacted:scalar:float>"}, out
    assert "30" not in str(out["timeout"]), out
    assert stats.leaf_types["int"] == 1, stats.leaf_types
    assert stats.leaf_types["float"] == 1, stats.leaf_types
    assert stats.by_reason["scalar_leaf"] == 2, stats.by_reason


def test_inventory_truncates_long_arrays_and_caps_total_paths():
    # Array longer than 50 emits an array_truncated marker with the omitted remainder.
    long_list = list(range(60))
    rows = inventory_paths(long_list)
    trunc = [r for r in rows if r.get("type") == "array_truncated"]
    assert len(trunc) == 1, rows
    assert trunc[0]["omitted"] == 10, trunc
    # max_paths cap appends an inventory_truncated sentinel and stops walking.
    capped = inventory_paths({"a": {"b": {"c": 1}}, "d": 2, "e": 3}, max_paths=2)
    assert any(r.get("type") == "inventory_truncated" for r in capped), capped
    assert any(r.get("max_paths") == 2 for r in capped), capped


def test_source_row_unknown_suffix_is_treated_as_missing():
    # A non-toml/non-json source class yields data=None -> parse_status "missing",
    # no config emitted, exercising the unknown-suffix branch of source_row.
    root = Path(tempfile.mkdtemp(prefix="codex-redactor-test-"))
    target = root / "notes.txt"
    target.write_text("model = secret", encoding="utf-8")
    row = source_row(target, "weird_class")
    assert row["parse_status"] == "missing", row
    assert row["config"] is None, row
    assert row["config_sha256_16"] is None, row
    assert "secret" not in str(row["config"]), row


def test_summarize_base_config_returns_unavailable_for_non_dict():
    # A missing/None config (not a dict, not an _error dict) is reported unavailable.
    assert summarize_base_config(None) == {"available": False}
    assert summarize_base_config(["not", "a", "dict"]) == {"available": False}


def test_summarize_base_config_counts_plugins_hashes_and_trusted_state():
    config = {
        "model": "gpt-secret",
        "mcp_servers": {"pinecone": {}, "github": {}},
        "plugins": {"alpha": {}, "beta": {}},
        "projects": {"/Users/testuser/p1": {}, "/Users/testuser/p2": {}},
        "hooks": {
            "pre_tool_use": [{"command": "x"}],
            "state": {"/Users/testuser/.codex/config.toml:k": {"trusted_hash": "sha256:zz"}},
        },
    }
    out = summarize_base_config(config)
    assert out["available"] is True, out
    assert out["mcp_server_names"] == ["github", "pinecone"], out
    assert out["mcp_server_count"] == 2, out
    assert out["plugin_ids"] == ["alpha", "beta"], out
    assert out["plugin_count"] == 2, out
    assert out["project_trust_entry_count"] == 2, out
    assert out["trusted_hook_state_count"] == 1, out
    assert out["hook_command_groups"] == 1, out
    # Project keys (raw paths) are emitted only as hashes; no raw path survives.
    assert len(out["project_key_hashes"]) == 2, out
    assert "/Users/testuser/p1" not in str(out), out


def test_summarize_legacy_hooks_list_counts_matchers_and_commands():
    data = [
        {"type": "PreToolUse", "matcher": "Bash", "hooks": [{"command": "a"}, {"command": "b"}]},
        {"type": "PostToolUse", "hooks": [{"command": "c"}]},
        "not-a-dict-item",
    ]
    out = summarize_legacy_hooks(data)
    assert out["available"] is True, out
    assert out["shape"] == "list", out
    assert out["events"] == ["PostToolUse", "PreToolUse"], out
    assert out["hook_group_count"] == 3, out
    assert out["matcher_count"] == 1, out
    assert out["command_count"] == 3, out


def test_summarize_legacy_hooks_object_shape_counts_groups_and_commands():
    data = {
        "PreToolUse": [
            {"hooks": [{"command": "a"}, {"command": "b"}]},
            {"hooks": [{"command": "c"}]},
        ],
        "PostToolUse": [{"hooks": [{"command": "d"}]}],
    }
    out = summarize_legacy_hooks(data)
    assert out["shape"] == "object", out
    assert out["events"] == ["PostToolUse", "PreToolUse"], out
    assert out["hook_group_count"] == 3, out
    assert out["command_count"] == 4, out


def test_summarize_legacy_hooks_scalar_is_unavailable():
    assert summarize_legacy_hooks("garbage") == {"available": False}
    assert summarize_legacy_hooks(42) == {"available": False}


def test_doctor_summary_skips_non_dict_checks_without_crashing():
    doctor = {
        "schemaVersion": 1,
        "overallStatus": "ok",
        "codexVersion": "0.139.0",
        "checks": {"good": {"category": "c", "status": "ok"}, "bad": "not-a-dict"},
    }
    out = doctor_summary(doctor, {"source": "fixture", "status": "parsed"})
    # The non-dict check is dropped; only the valid one is counted.
    assert out["check_count"] == 1, out
    assert out["checks"][0]["id"] == "good", out


def test_doctor_summary_unavailable_when_data_not_dict():
    out = doctor_summary(None, {"source": "not_run", "status": "not_run"})
    assert out["available"] is False, out
    assert "check_count" not in out, out


def test_parse_doctor_json_reads_saved_file_and_hashes_bytes():
    root = Path(tempfile.mkdtemp(prefix="codex-doctor-test-"))
    fixture = root / "doctor.json"
    fixture.write_text(json.dumps({"overallStatus": "ok", "checks": {}}), encoding="utf-8")
    data, meta = parse_doctor_json(fixture, run_doctor=False, timeout=5)
    assert data == {"overallStatus": "ok", "checks": {}}, data
    assert meta["source"] == "file", meta
    assert meta["status"] == "parsed", meta
    assert meta["bytes"] > 0, meta
    assert len(meta["sha256_16"]) == 16, meta


def test_parse_doctor_json_not_run_when_flag_disabled():
    data, meta = parse_doctor_json(None, run_doctor=False, timeout=5)
    assert data is None, data
    assert meta == {"source": "not_run", "status": "not_run"}, meta


def test_parse_doctor_json_handles_missing_codex_binary():
    # FileNotFoundError -> rc 127, never runs real codex/network.
    orig = probe.subprocess.run

    def fake_run(*args, **kwargs):
        raise FileNotFoundError("codex")

    probe.subprocess.run = fake_run
    try:
        data, meta = parse_doctor_json(None, run_doctor=True, timeout=5)
    finally:
        probe.subprocess.run = orig
    assert data is None, data
    assert meta["rc"] == 127, meta
    assert meta["status"] == "error", meta
    assert meta["error_type"] == "FileNotFoundError", meta


def test_parse_doctor_json_handles_timeout():
    orig = probe.subprocess.run

    def fake_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd=["codex"], timeout=5)

    probe.subprocess.run = fake_run
    try:
        data, meta = parse_doctor_json(None, run_doctor=True, timeout=5)
    finally:
        probe.subprocess.run = orig
    assert data is None, data
    assert meta["rc"] == 124, meta
    assert meta["error_type"] == "TimeoutExpired", meta


class _FakeProc:
    def __init__(self, returncode, stdout, stderr):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_parse_doctor_json_nonzero_exit_is_error_without_raw_output():
    orig = probe.subprocess.run
    probe.subprocess.run = lambda *a, **k: _FakeProc(3, '{"overallStatus":"ok"}', "boom-detail")
    try:
        data, meta = parse_doctor_json(None, run_doctor=True, timeout=5)
    finally:
        probe.subprocess.run = orig
    assert data is None, data
    assert meta["status"] == "error", meta
    assert meta["error_type"] == "nonzero_exit", meta
    # Raw stdout/stderr are reduced to byte counts + hashes, never echoed.
    assert "boom-detail" not in str(meta), meta
    assert meta["stderr_bytes"] == len(b"boom-detail"), meta


def test_parse_doctor_json_parses_successful_subprocess_output():
    orig = probe.subprocess.run
    probe.subprocess.run = lambda *a, **k: _FakeProc(0, '{"overallStatus":"ok","checks":{}}', "")
    try:
        data, meta = parse_doctor_json(None, run_doctor=True, timeout=5)
    finally:
        probe.subprocess.run = orig
    assert data == {"overallStatus": "ok", "checks": {}}, data
    assert meta["rc"] == 0, meta
    assert meta["status"] == "parsed", meta


def test_parse_doctor_json_malformed_subprocess_output_fails_closed():
    orig = probe.subprocess.run
    probe.subprocess.run = lambda *a, **k: _FakeProc(0, "not-json-{secret", "")
    try:
        data, meta = parse_doctor_json(None, run_doctor=True, timeout=5)
    finally:
        probe.subprocess.run = orig
    assert data is None, data
    assert meta["status"] == "error", meta
    assert meta["error_type"] == "JSONDecodeError", meta
    # The malformed (possibly secret-bearing) stdout is never echoed into metadata.
    assert "secret" not in str(meta), meta


def test_main_emits_report_for_empty_codex_home_and_returns_zero():
    root = Path(tempfile.mkdtemp(prefix="codex-main-test-"))
    argv = ["codex_config_redactor", "--codex-home", str(root), "--cwd", str(root)]
    orig_argv = sys.argv
    sys.argv = argv
    import io
    from contextlib import redirect_stdout

    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = main()
    finally:
        sys.argv = orig_argv
    assert rc == 0, rc
    report = json.loads(buf.getvalue())
    assert report["schema"] == "codex-effective-config-redacted", report
    # Empty home: only the 3 fixed sources exist (config.toml, hooks.json, version.json);
    # no profile/agent globs match, so all 3 are missing and doctor is not run.
    assert report["summary"]["source_count"] == 3, report["summary"]
    assert report["summary"]["missing_source_count"] == 3, report["summary"]
    assert report["summary"]["parsed_source_count"] == 0, report["summary"]
    assert report["doctor"]["metadata"]["status"] == "not_run", report["doctor"]


def test_main_pretty_flag_and_doctor_json_fixture_flow():
    root = Path(tempfile.mkdtemp(prefix="codex-main-test-"))
    doctor_fixture = root / "doctor.json"
    doctor_fixture.write_text(
        json.dumps({
            "overallStatus": "warning",
            "codexVersion": "0.139.0",
            "checks": {"config.load": {"category": "config", "status": "ok",
                                       "details": {"model": "gpt-secret"}}},
        }),
        encoding="utf-8",
    )
    argv = ["codex_config_redactor", "--codex-home", str(root), "--cwd", str(root),
            "--doctor-json", str(doctor_fixture), "--pretty"]
    orig_argv = sys.argv
    sys.argv = argv
    import io
    from contextlib import redirect_stdout

    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = main()
    finally:
        sys.argv = orig_argv
    assert rc == 0, rc
    rendered = buf.getvalue()
    # --pretty produced indented JSON.
    assert "\n  " in rendered, rendered[:200]
    report = json.loads(rendered)
    assert report["doctor"]["available"] is True, report["doctor"]
    assert report["doctor"]["check_count"] == 1, report["doctor"]
    # Doctor detail VALUES are suppressed; only detail-key names survive.
    assert "gpt-secret" not in rendered, report["doctor"]


def test_cli_entrypoint_emits_valid_json_for_empty_home():
    # e2e: covers `if __name__ == "__main__"` + real json.dump path as a subprocess.
    root = Path(tempfile.mkdtemp(prefix="codex-cli-test-"))
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--codex-home", str(root), "--cwd", str(root)],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "codex-effective-config-redacted", report
    assert report["summary"]["source_count"] == 3, report["summary"]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} codex config redactor tests passed")
