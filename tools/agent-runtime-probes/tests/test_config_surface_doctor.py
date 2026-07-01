#!/usr/bin/env python3
"""Tests for config_surface_doctor: fail-closed file metadata, per-format parsers,
summary aggregation, the main() report path with both CLI flags, and a real CLI e2e.

Style mirrors tests/test_pi_presence_probe.py: no pytest fixtures, manual monkeypatch
via setattr + try/finally, a `__main__` runner that prints PASS per test, and a
subprocess e2e that exercises the real `if __name__ == "__main__"` entrypoint.
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

import config_surface_doctor as probe  # noqa: E402
from config_surface_doctor import (  # noqa: E402
    expand_specs,
    file_hash,
    main,
    parse_directory,
    parse_json,
    parse_markdown,
    parse_plist,
    parse_script,
    parse_surface,
    parse_toml,
    parse_yaml_keys,
    stat_info,
    summarize,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "config_surface_doctor.py"

PLIST_OK = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.q.example</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/true</string><string>--flag</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>FOO</key><string>bar</string><key>BAZ</key><string>qux</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
</dict>
</plist>
"""


# ---------------------------------------------------------------------------
# file_hash + stat_info (already partially present; keep + extend)
# ---------------------------------------------------------------------------

def test_file_hash_returns_digest_for_real_file():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "f.txt"
        path.write_bytes(b"hello")
        digest, err = file_hash(path)
    assert err is None, (digest, err)
    assert isinstance(digest, str) and len(digest) == 16, digest
    # sha256("hello")[:16] is deterministic.
    assert digest == "2cf24dba5fb0a30e", digest


def test_file_hash_fails_closed_on_directory():
    # A directory cannot be read as bytes -> typed error, never a silent digest.
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        digest, err = file_hash(Path(tmp_dir))
    assert digest is None, digest
    assert err in {"IsADirectoryError", "PermissionError", "OSError"}, err


def test_stat_info_missing_path_reports_not_exists_only():
    row = stat_info(Path("/nonexistent-xyz-config-surface/none.json"))
    assert row == {"exists": False}, row


def test_stat_info_existing_file_reports_full_metadata():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "c.json"
        path.write_text('{"a": 1}', encoding="utf-8")
        row = stat_info(path)
    assert row["exists"] is True, row
    assert row["bytes"] == 8, row
    assert row["mode"].startswith("-"), row
    assert row["hash_status"] == "ok", row
    assert row["hash_error_type"] is None, row
    assert isinstance(row["sha256_16"], str) and len(row["sha256_16"]) == 16, row
    assert isinstance(row["mtime"], int), row


def test_stat_info_distinguishes_hash_read_errors_from_absence():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        row = stat_info(Path(tmp_dir))
        assert row["exists"] is True, row
        assert row["hash_status"] == "error", row
        assert row["hash_error_type"] in {"IsADirectoryError", "PermissionError", "OSError"}, row
        assert row["sha256_16"] is None, row


# ---------------------------------------------------------------------------
# parse_json: object / array / scalar shapes
# ---------------------------------------------------------------------------

def test_parse_json_object_lists_sorted_keys_and_count():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "o.json"
        path.write_text('{"z": 1, "a": 2, "m": 3}', encoding="utf-8")
        row = parse_json(path)
    assert row["parse_status"] == "valid", row
    assert row["shape"] == "object", row
    assert row["top_level_keys"] == ["a", "m", "z"], row
    assert row["top_level_key_count"] == 3, row


def test_parse_json_array_reports_item_count_and_types():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "a.json"
        path.write_text('[1, "x", 2]', encoding="utf-8")
        row = parse_json(path)
    assert row["parse_status"] == "valid", row
    assert row["shape"] == "array", row
    assert row["item_count"] == 3, row
    assert row["item_types"] == ["int", "str"], row


def test_parse_json_scalar_reports_python_type_shape():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "s.json"
        path.write_text("42", encoding="utf-8")
        row = parse_json(path)
    assert row["parse_status"] == "valid", row
    assert row["shape"] == "int", row
    assert "top_level_keys" not in row, row


# ---------------------------------------------------------------------------
# parse_toml
# ---------------------------------------------------------------------------

def test_parse_toml_reports_top_level_keys():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "c.toml"
        path.write_text('model = "x"\n[profile]\nname = "y"\n', encoding="utf-8")
        row = parse_toml(path)
    assert row["parse_status"] == "valid", row
    assert row["shape"] == "object", row
    assert row["top_level_keys"] == ["model", "profile"], row
    assert row["top_level_key_count"] == 2, row


# ---------------------------------------------------------------------------
# parse_plist via real /usr/bin/plutil (present on macOS)
# ---------------------------------------------------------------------------

def test_parse_plist_valid_extracts_launchd_fields():
    if not os.path.exists("/usr/bin/plutil"):
        return  # plutil only on macOS; skip silently elsewhere
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "com.q.example.plist"
        path.write_text(PLIST_OK, encoding="utf-8")
        row = parse_plist(path)
    assert row["parse_status"] == "valid", row
    assert row["shape"] == "dict", row
    assert row["label"] == "com.q.example", row
    assert row["argv0"] == "/usr/bin/true", row
    assert row["argv_count"] == 2, row
    assert row["environment_keys"] == ["BAZ", "FOO"], row
    assert row["has_run_at_load"] is True, row
    assert row["has_start_interval"] is True, row
    assert row["has_start_calendar_interval"] is False, row
    assert "Label" in row["top_level_keys"], row


def test_parse_plist_malformed_fails_closed_with_plutil_error():
    if not os.path.exists("/usr/bin/plutil"):
        return
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "broken.plist"
        path.write_text("this is not a plist at all <<<", encoding="utf-8")
        row = parse_plist(path)
    # Fail-closed: typed invalid marker, not a silent empty/valid result.
    assert row["parse_status"] == "invalid", row
    assert row["error_type"] == "plutil", row
    assert isinstance(row["error"], str) and row["error"], row


def test_parse_plist_non_dict_top_level_reports_shape_only():
    # A plist whose root is an array exercises the non-dict branch (no launchd fields).
    if not os.path.exists("/usr/bin/plutil"):
        return
    array_plist = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0"><array><string>a</string></array></plist>\n'
    )
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "arr.plist"
        path.write_text(array_plist, encoding="utf-8")
        row = parse_plist(path)
    assert row["parse_status"] == "valid", row
    assert row["shape"] == "list", row
    assert "label" not in row, row
    assert "has_run_at_load" not in row, row


def test_parse_plist_failure_branch_with_empty_stderr(monkeypatch_run=None):
    # Force the plutil nonzero-return path with empty stderr/stdout to cover the
    # "plutil failed" fallback message (no real plutil dependency).
    class _Proc:
        returncode = 1
        stderr = ""
        stdout = ""

    orig = probe.subprocess.run
    probe.subprocess.run = lambda *a, **k: _Proc()
    try:
        row = parse_plist(Path("/whatever.plist"))
    finally:
        probe.subprocess.run = orig
    assert row["parse_status"] == "invalid", row
    assert row["error_type"] == "plutil", row
    assert row["error"] == "plutil failed", row


# ---------------------------------------------------------------------------
# parse_markdown: with + without frontmatter
# ---------------------------------------------------------------------------

def test_parse_markdown_no_frontmatter_reports_line_count_only():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "x.md"
        path.write_text("# Title\n\nbody line\nthird\n", encoding="utf-8")
        row = parse_markdown(path)
    assert row["parse_status"] == "text", row
    assert row["line_count"] == 4, row
    assert "frontmatter_keys" not in row, row


def test_parse_markdown_frontmatter_extracts_keys():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "y.md"
        path.write_text(
            "---\nname: agent\ndescription: does things\ntools: all\n---\nbody\n",
            encoding="utf-8",
        )
        row = parse_markdown(path)
    assert row["parse_status"] == "text", row
    assert row["frontmatter_keys"] == ["description", "name", "tools"], row
    assert row["frontmatter_key_count"] == 3, row


# ---------------------------------------------------------------------------
# parse_yaml_keys
# ---------------------------------------------------------------------------

def test_parse_yaml_keys_collects_top_level_keys_only():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "p.yaml"
        path.write_text(
            "# comment\n"
            "version: 1\n"
            "policy:\n"
            "  nested: skip\n"
            "- listitem\n"
            "limits: 5\n",
            encoding="utf-8",
        )
        row = parse_yaml_keys(path)
    assert row["parse_status"] == "keys_only", row
    assert row["shape"] == "yaml_text", row
    assert row["top_level_keys"] == ["limits", "policy", "version"], row
    assert row["top_level_key_count"] == 3, row
    assert row["line_count"] == 6, row


# ---------------------------------------------------------------------------
# parse_script: with + without shebang, executable flag
# ---------------------------------------------------------------------------

def test_parse_script_with_shebang_and_exec_bit():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "s.sh"
        path.write_text("#!/bin/bash\necho hi\n", encoding="utf-8")
        os.chmod(path, 0o755)
        row = parse_script(path)
    assert row["parse_status"] == "text", row
    assert row["line_count"] == 2, row
    assert row["shebang"] == "#!/bin/bash", row
    assert row["executable"] is True, row


def test_parse_script_without_shebang_not_executable():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "s.rules"
        path.write_text("allow foo\ndeny bar\n", encoding="utf-8")
        os.chmod(path, 0o644)
        row = parse_script(path)
    assert row["shebang"] is None, row
    assert row["executable"] is False, row
    assert row["line_count"] == 2, row


# ---------------------------------------------------------------------------
# parse_directory
# ---------------------------------------------------------------------------

def test_parse_directory_counts_files_dirs_and_json():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        base = Path(tmp_dir)
        (base / "a.json").write_text("{}", encoding="utf-8")
        (base / "b.json").write_text("{}", encoding="utf-8")
        (base / "c.txt").write_text("x", encoding="utf-8")
        (base / "sub").mkdir()
        row = parse_directory(base)
    assert row["parse_status"] == "directory", row
    assert row["entry_count"] == 4, row
    assert row["file_count"] == 3, row
    assert row["directory_count"] == 1, row
    assert row["json_file_count"] == 2, row


# ---------------------------------------------------------------------------
# parse_surface dispatch: missing, every fmt, exception, unparsed
# ---------------------------------------------------------------------------

def test_parse_surface_missing_path_reports_missing():
    row = parse_surface(Path("/nonexistent-xyz/none.json"), "json")
    assert row == {"parse_status": "missing"}, row


def test_parse_surface_routes_each_format():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        base = Path(tmp_dir)
        (base / "f.json").write_text('{"k": 1}', encoding="utf-8")
        (base / "f.toml").write_text('k = 1\n', encoding="utf-8")
        (base / "f.md").write_text("hi\n", encoding="utf-8")
        (base / "f.yaml").write_text("k: 1\n", encoding="utf-8")
        (base / "f.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (base / "dir").mkdir()

        assert parse_surface(base / "f.json", "json")["shape"] == "object"
        assert parse_surface(base / "f.toml", "toml")["parse_status"] == "valid"
        assert parse_surface(base / "f.md", "markdown")["parse_status"] == "text"
        assert parse_surface(base / "f.yaml", "yaml")["parse_status"] == "keys_only"
        assert parse_surface(base / "f.yaml", "yml")["parse_status"] == "keys_only"
        for script_fmt in ("script", "rules", "js", "ts", "python", "shell", "lock"):
            assert parse_surface(base / "f.sh", script_fmt)["parse_status"] == "text", script_fmt
        assert parse_surface(base / "dir", "directory")["parse_status"] == "directory"


def test_parse_surface_invalid_json_fails_closed():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "bad.json"
        path.write_text("{bad", encoding="utf-8")
        row = parse_surface(path, "json")
    assert row["parse_status"] == "invalid", row
    assert row["error_type"] == "JSONDecodeError", row
    assert isinstance(row["error"], str) and row["error"], row


def test_parse_surface_reports_malformed_json_as_invalid():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "bad.json"
        path.write_text("{bad", encoding="utf-8")
        row = parse_surface(path, "json")
    assert row["parse_status"] == "invalid", row
    assert row["error_type"] == "JSONDecodeError", row


def test_parse_surface_invalid_toml_fails_closed():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "bad.toml"
        path.write_text("this is = = not toml\n[unclosed\n", encoding="utf-8")
        row = parse_surface(path, "toml")
    assert row["parse_status"] == "invalid", row
    assert "TOML" in row["error_type"] or "Error" in row["error_type"], row


def test_parse_surface_zero_byte_mcp_json_is_invalid():
    # Behavioral unhappy path called out in the spec: a zero-byte .mcp.json must
    # classify as invalid (empty string is not valid JSON), never silent-clean.
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / ".mcp.json"
        path.write_text("", encoding="utf-8")
        row = parse_surface(path, "json")
    assert row["parse_status"] == "invalid", row
    assert row["error_type"] == "JSONDecodeError", row


def test_parse_surface_unknown_format_reports_unparsed():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        path = Path(tmp_dir) / "f.weird"
        path.write_text("data", encoding="utf-8")
        row = parse_surface(path, "weird-format-not-handled")
    assert row == {"parse_status": "unparsed"}, row


# ---------------------------------------------------------------------------
# summarize: counts by every bucket
# ---------------------------------------------------------------------------

def test_summarize_aggregates_counts_by_bucket():
    surfaces = [
        {"exists": True, "harness": "claude", "surface": "settings", "format": "json", "risk": "high", "parse_status": "valid"},
        {"exists": True, "harness": "claude", "surface": "mcp", "format": "json", "risk": "high", "parse_status": "invalid"},
        {"exists": False, "harness": "codex", "surface": "settings", "format": "toml", "risk": "high", "parse_status": "missing"},
        {"exists": True, "harness": "codex", "surface": "instruction", "format": "markdown", "risk": "medium", "parse_status": "text"},
    ]
    out = summarize(surfaces)
    assert out["surface_count"] == 4, out
    assert out["existing_count"] == 3, out
    assert out["missing_count"] == 1, out
    assert out["by_harness"] == {"claude": 2, "codex": 2}, out
    assert out["by_risk"] == {"high": 3, "medium": 1}, out
    assert out["by_format"] == {"json": 2, "toml": 1, "markdown": 1}, out
    assert out["by_parse_status"]["invalid"] == 1, out
    assert out["by_surface"]["settings"] == 2, out


def test_summarize_uses_unknown_when_parse_status_absent():
    surfaces = [{"exists": True, "harness": "x", "surface": "s", "format": "f", "risk": "low"}]
    out = summarize(surfaces)
    assert out["by_parse_status"] == {"unknown": 1}, out


# ---------------------------------------------------------------------------
# expand_specs: dedup + spec shape
# ---------------------------------------------------------------------------

def test_expand_specs_returns_unique_paths_with_required_fields():
    specs = expand_specs()
    paths = [s.path for s in specs]
    assert len(paths) == len(set(paths)), "expand_specs must dedup by path"
    # The static allowlist entries must be present and well-formed.
    by_path = {str(s.path): s for s in specs}
    settings = by_path[str(probe.HOME / ".claude/settings.json")]
    assert settings.harness == "claude", settings
    assert settings.risk == "high", settings
    assert settings.fmt == "json", settings
    # Risk buckets are constrained to the documented vocabulary.
    assert {s.risk for s in specs} <= {"high", "medium", "low"}, {s.risk for s in specs}


def test_expand_specs_tracks_maclab_launchd_prefix_not_retired_host_prefix():
    with tempfile.TemporaryDirectory(prefix="config-surface-doctor-") as tmp_dir:
        home = Path(tmp_dir)
        launch_agents = home / "Library" / "LaunchAgents"
        launch_agents.mkdir(parents=True)
        maclab_label = "com.maclab.sched.whatsoup-qregistry-loop.plist"
        retired_label = "com." + "mq" + "mac.sched.whatsoup-qregistry-loop.plist"
        (launch_agents / maclab_label).write_text(PLIST_OK, encoding="utf-8")
        (launch_agents / retired_label).write_text(PLIST_OK, encoding="utf-8")

        orig_home = probe.HOME
        probe.HOME = home
        try:
            launchd_paths = {
                spec.path.name for spec in probe.expand_specs()
                if spec.harness == "launchd" and spec.surface == "scheduled_service"
            }
        finally:
            probe.HOME = orig_home

    assert maclab_label in launchd_paths, launchd_paths
    assert retired_label not in launchd_paths, launchd_paths


# ---------------------------------------------------------------------------
# main(): report shape, both flags, include-missing behavior
# ---------------------------------------------------------------------------

def _run_main(argv):
    orig = sys.argv
    sys.argv = ["config_surface_doctor.py", *argv]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = main()
    finally:
        sys.argv = orig
    return rc, buf.getvalue()


def test_main_emits_valid_report_default():
    rc, out = _run_main([])
    assert rc == 0, rc
    report = json.loads(out)
    assert report["schema"] == "agent-runtime-config-surface-report", report
    assert report["schema_version"] == "0.1", report
    assert report["allowlist_only"] is True, report
    assert "summary" in report and "surfaces" in report, report
    summary = report["summary"]
    # Default run excludes missing surfaces: every emitted surface must exist.
    assert summary["missing_count"] == 0, summary
    assert summary["surface_count"] == summary["existing_count"], summary
    for item in report["surfaces"]:
        assert item["exists"] is True, item


def test_main_include_missing_adds_absent_surfaces():
    rc_default, out_default = _run_main([])
    rc_incl, out_incl = _run_main(["--include-missing"])
    assert rc_default == 0 and rc_incl == 0
    default_report = json.loads(out_default)
    incl_report = json.loads(out_incl)
    # include-missing must be a superset and must surface absent allowlisted paths.
    assert incl_report["summary"]["surface_count"] >= default_report["summary"]["surface_count"], (
        default_report["summary"], incl_report["summary"],
    )
    assert incl_report["summary"]["missing_count"] >= 0
    missing = [s for s in incl_report["surfaces"] if not s["exists"]]
    if incl_report["summary"]["missing_count"]:
        assert missing, "missing_count>0 but no exists=False rows"
        # Missing rows carry parse_status 'missing' (fail-closed, not silent valid).
        assert all(m.get("parse_status") == "missing" for m in missing), missing


def test_main_pretty_flag_indents_json():
    rc, out = _run_main(["--pretty"])
    assert rc == 0, rc
    # Pretty output is multi-line indented; compact output is single logical line.
    assert "\n  " in out, "pretty JSON should contain indented lines"
    report = json.loads(out)
    assert report["schema"] == "agent-runtime-config-surface-report", report


def test_main_redaction_notice_present_and_metadata_only():
    rc, out = _run_main([])
    assert rc == 0
    report = json.loads(out)
    assert "metadata-only" in report["redaction"], report["redaction"]
    # No surface row should leak a raw scalar config value: emitted keys are a fixed
    # metadata vocabulary. Assert none of the parsed values are raw secrets.
    blob = json.dumps(report)
    assert "sk-" not in blob or "<redacted" in blob, "raw secret-shaped value present"


# ---------------------------------------------------------------------------
# CLI e2e: real subprocess exercises `if __name__ == '__main__'` entrypoint
# ---------------------------------------------------------------------------

def test_cli_entrypoint_emits_valid_json():
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH)],
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-config-surface-report", report
    assert "summary" in report and "surfaces" in report, report


def test_cli_entrypoint_pretty_and_include_missing():
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--pretty", "--include-missing"],
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["allowlist_only"] is True, report
    # include-missing via the real CLI must keep parse_status='missing' rows fail-closed.
    missing = [s for s in report["surfaces"] if not s["exists"]]
    assert all(m.get("parse_status") == "missing" for m in missing), missing


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} config surface doctor tests passed")
