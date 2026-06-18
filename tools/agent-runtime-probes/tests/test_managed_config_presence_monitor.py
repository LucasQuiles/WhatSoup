#!/usr/bin/env python3
"""Tests for metadata-only managed config presence monitor.

No pytest fixtures; manual setattr+try/finally; __main__ PASS runner; CLI e2e.
Covers: all size_class branches, all path_class branches, mode_class owner_private,
parse_json_shape list/scalar shapes, parse_toml_shape (full coverage), shape_for
unparsed fallback, payload_status zero-byte and unparsed branches, build_report
no-payload verdict, redaction (no raw values), CLI e2e (main/parse_args in-process).
"""

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

from config_surface_doctor import SurfaceSpec  # noqa: E402
import managed_config_presence_monitor as probe  # noqa: E402
from managed_config_presence_monitor import (  # noqa: E402
    build_report,
    directory_shape,
    mode_class,
    parse_json_shape,
    parse_toml_shape,
    path_class,
    payload_status,
    shape_for,
    size_class,
    summarize_path,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "managed_config_presence_monitor.py"


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------

def _spec(path: Path, harness: str = "claude", surface: str = "managed_settings",
          fmt: str = "json") -> SurfaceSpec:
    return SurfaceSpec(path, harness, surface, fmt, "test loader", "audit_only", "high")


def _managed_specs(root: Path) -> list[SurfaceSpec]:
    """Build a minimal but complete set of managed specs under root."""
    dropin = root / "managed-settings.d"
    dropin.mkdir(parents=True)
    valid = root / "managed-settings.json"
    valid.write_text(json.dumps({
        "secretPolicy": "sk-shouldnotleak123456",
        "prompt": "raw managed prompt should never leak",
    }), encoding="utf-8")
    invalid = root / "requirements.toml"
    invalid.write_text("token = 'pcsk_shouldnotleak000000'\n[broken\n", encoding="utf-8")
    return [
        SurfaceSpec(dropin, "claude", "managed_settings_dropin_dir", "directory", "fixture loader", "audit_only", "high"),
        SurfaceSpec(valid, "claude", "managed_settings", "json", "fixture loader", "audit_only", "high"),
        SurfaceSpec(invalid, "codex", "managed_requirements", "toml", "fixture loader", "audit_only", "high"),
        SurfaceSpec(root / "missing.json", "opencode", "managed_settings", "json", "fixture loader", "audit_only", "high"),
        SurfaceSpec(root / "not-managed.json", "whatsoup", "managed_components", "json", "fixture loader", "audit_only", "medium"),
    ]


def _assert_no_fixture_content(rendered: str, root: Path) -> None:
    for forbidden in [
        str(root),
        "sk-shouldnotleak",
        "pcsk_shouldnotleak",
        "secretPolicy",
        "raw managed prompt",
        "token =",
        "[broken",
        "not-managed",
    ]:
        assert forbidden not in rendered, f"forbidden content leaked: {forbidden!r}"


# ---------------------------------------------------------------------------
# size_class — all branches
# ---------------------------------------------------------------------------

def test_size_class_none_returns_none():
    assert size_class(None) is None


def test_size_class_zero_returns_zero_byte():
    assert size_class(0) == "zero_byte"


def test_size_class_small_returns_small():
    assert size_class(1) == "small"
    assert size_class(1023) == "small"


def test_size_class_medium_returns_medium():
    assert size_class(1024) == "medium"
    assert size_class(1024 * 1024 - 1) == "medium"


def test_size_class_large_returns_large():
    assert size_class(1024 * 1024) == "large"
    assert size_class(10 * 1024 * 1024) == "large"


# ---------------------------------------------------------------------------
# path_class — all branches
# ---------------------------------------------------------------------------

def test_path_class_macos_claudecode_managed():
    p = Path("/Library/Application Support/ClaudeCode/managed-settings.json")
    assert path_class(p) == "macos_claudecode_managed"


def test_path_class_macos_codex_managed():
    p = Path("/Library/Application Support/Codex/requirements.toml")
    assert path_class(p) == "macos_codex_managed"


def test_path_class_macos_opencode_managed():
    p = Path("/Library/Application Support/opencode/opencode.json")
    assert path_class(p) == "macos_opencode_managed"


def test_path_class_system_etc_claude():
    p = Path("/etc/claude-code/managed-settings.json")
    assert path_class(p) == "system_etc_claude"


def test_path_class_system_etc_codex():
    p = Path("/etc/codex/requirements.toml")
    assert path_class(p) == "system_etc_codex"


def test_path_class_other_managed_path():
    p = Path("/tmp/some-random-path/config.json")
    assert path_class(p) == "other_managed_path"


# ---------------------------------------------------------------------------
# mode_class — both branches
# ---------------------------------------------------------------------------

def test_mode_class_missing_path_returns_none():
    assert mode_class(Path("/nonexistent-path-xyz-abc")) is None


def test_mode_class_owner_private_file():
    with tempfile.NamedTemporaryFile(delete=False) as f:
        tmp = Path(f.name)
    try:
        tmp.chmod(0o600)
        assert mode_class(tmp) == "owner_private"
    finally:
        tmp.unlink(missing_ok=True)


def test_mode_class_group_world_accessible_file():
    with tempfile.NamedTemporaryFile(delete=False) as f:
        tmp = Path(f.name)
    try:
        tmp.chmod(0o644)
        assert mode_class(tmp) == "group_or_world_accessible"
    finally:
        tmp.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# parse_json_shape — dict, list, and scalar branches
# ---------------------------------------------------------------------------

def test_parse_json_shape_dict():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump({"alpha": 1, "beta": 2}, f)
        tmp = Path(f.name)
    try:
        result = parse_json_shape(tmp)
        assert result["parse_status"] == "valid"
        assert result["shape"] == "object"
        assert result["top_level_key_count"] == 2
        assert isinstance(result["top_level_key_hashes"], list)
        assert len(result["top_level_key_hashes"]) == 2
    finally:
        tmp.unlink(missing_ok=True)


def test_parse_json_shape_list():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump([1, "hello", True], f)
        tmp = Path(f.name)
    try:
        result = parse_json_shape(tmp)
        assert result["parse_status"] == "valid"
        assert result["shape"] == "array"
        assert result["item_count"] == 3
        assert isinstance(result["item_type_hashes"], list)
    finally:
        tmp.unlink(missing_ok=True)


def test_parse_json_shape_scalar_string():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump("just a string", f)
        tmp = Path(f.name)
    try:
        result = parse_json_shape(tmp)
        assert result["parse_status"] == "valid"
        assert result["shape"] == "str"
    finally:
        tmp.unlink(missing_ok=True)


def test_parse_json_shape_list_empty():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump([], f)
        tmp = Path(f.name)
    try:
        result = parse_json_shape(tmp)
        assert result["parse_status"] == "valid"
        assert result["shape"] == "array"
        assert result["item_count"] == 0
        assert result["item_type_hashes"] == []
    finally:
        tmp.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# parse_toml_shape — dict and non-dict branches
# ---------------------------------------------------------------------------

def test_parse_toml_shape_valid_dict():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".toml", delete=False) as f:
        f.write("[section]\nkey = 'value'\n")
        tmp = Path(f.name)
    try:
        result = parse_toml_shape(tmp)
        assert result["parse_status"] == "valid"
        assert result["shape"] == "object"
        assert result["top_level_key_count"] == 1
        assert isinstance(result["top_level_key_hashes"], list)
    finally:
        tmp.unlink(missing_ok=True)


def test_parse_toml_shape_non_dict_returns_type_name():
    # TOML always produces a dict at top level; exercise the non-dict branch by
    # patching tomllib.loads to return a non-dict scalar.
    import tomllib
    orig_loads = tomllib.loads
    tomllib.loads = lambda text: 42  # type: ignore[assignment]
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".toml", delete=False) as f:
            f.write("x = 1\n")
            tmp = Path(f.name)
        try:
            result = parse_toml_shape(tmp)
            assert result["parse_status"] == "valid"
            assert result["shape"] == "int"
        finally:
            tmp.unlink(missing_ok=True)
    finally:
        tomllib.loads = orig_loads


# ---------------------------------------------------------------------------
# shape_for — all branches including "unparsed" fallback
# ---------------------------------------------------------------------------

def test_shape_for_missing_path():
    result = shape_for(Path("/no/such/path/here.json"), "json")
    assert result["parse_status"] == "missing"


def test_shape_for_directory():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d)
        (p / "child.json").write_text("{}")
        result = shape_for(p, "directory")
        assert result["parse_status"] == "directory"
        assert result["file_count"] == 1


def test_shape_for_json_valid():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump({"k": 1}, f)
        tmp = Path(f.name)
    try:
        result = shape_for(tmp, "json")
        assert result["parse_status"] == "valid"
    finally:
        tmp.unlink(missing_ok=True)


def test_shape_for_json_invalid_returns_invalid():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write("not valid json{{{{")
        tmp = Path(f.name)
    try:
        result = shape_for(tmp, "json")
        assert result["parse_status"] == "invalid"
        assert "error_class" in result
    finally:
        tmp.unlink(missing_ok=True)


def test_shape_for_toml_valid():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".toml", delete=False) as f:
        f.write("key = 'value'\n")
        tmp = Path(f.name)
    try:
        result = shape_for(tmp, "toml")
        assert result["parse_status"] == "valid"
    finally:
        tmp.unlink(missing_ok=True)


def test_shape_for_toml_invalid_returns_invalid():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".toml", delete=False) as f:
        f.write("[broken section\n")
        tmp = Path(f.name)
    try:
        result = shape_for(tmp, "toml")
        assert result["parse_status"] == "invalid"
        assert "error_class" in result
    finally:
        tmp.unlink(missing_ok=True)


def test_shape_for_jsonc_treated_as_json():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonc", delete=False) as f:
        json.dump({"x": 1}, f)
        tmp = Path(f.name)
    try:
        result = shape_for(tmp, "jsonc")
        assert result["parse_status"] == "valid"
    finally:
        tmp.unlink(missing_ok=True)


def test_shape_for_unknown_format_returns_unparsed():
    """Any format not in {json, jsonc, toml, directory} returns 'unparsed'."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".xyz", delete=False) as f:
        f.write("arbitrary content\n")
        tmp = Path(f.name)
    try:
        result = shape_for(tmp, "xyz_unknown_format")
        assert result["parse_status"] == "unparsed"
    finally:
        tmp.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# payload_status — all branches
# ---------------------------------------------------------------------------

def test_payload_status_missing():
    row = {"exists": False, "is_directory": False, "is_file": False}
    assert payload_status(row) == "missing_no_checked_payload"


def test_payload_status_empty_directory():
    row = {"exists": True, "is_directory": True, "is_file": False, "entry_count": 0}
    assert payload_status(row) == "empty_directory_policy_insertion_point"


def test_payload_status_non_empty_directory():
    row = {"exists": True, "is_directory": True, "is_file": False,
           "entry_count": 3, "parse_status": "directory"}
    assert payload_status(row) == "present_payload_or_dropin_review_required"


def test_payload_status_zero_byte_file():
    row = {"exists": True, "is_directory": False, "is_file": True, "size_class": "zero_byte"}
    assert payload_status(row) == "zero_byte_payload_invalid_or_empty"


def test_payload_status_invalid_parse():
    row = {"exists": True, "is_directory": False, "is_file": True,
           "size_class": "small", "parse_status": "invalid"}
    assert payload_status(row) == "present_invalid_payload"


def test_payload_status_valid_parse():
    row = {"exists": True, "is_directory": False, "is_file": True,
           "size_class": "small", "parse_status": "valid"}
    assert payload_status(row) == "present_payload_or_dropin_review_required"


def test_payload_status_unparsed_fallback():
    row = {"exists": True, "is_directory": False, "is_file": True,
           "size_class": "small", "parse_status": "unparsed"}
    assert payload_status(row) == "present_unparsed_review_required"


# ---------------------------------------------------------------------------
# directory_shape — entry counting
# ---------------------------------------------------------------------------

def test_directory_shape_empty_dir():
    with tempfile.TemporaryDirectory() as d:
        result = directory_shape(Path(d))
        assert result["parse_status"] == "directory"
        assert result["entry_count"] == 0
        assert result["file_count"] == 0
        assert result["directory_count"] == 0
        assert result["json_file_count"] == 0
        assert result["toml_file_count"] == 0


def test_directory_shape_with_files():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d)
        (p / "a.json").write_text("{}")
        (p / "b.toml").write_text("x = 1\n")
        (p / "sub").mkdir()
        result = directory_shape(p)
        assert result["entry_count"] == 3
        assert result["file_count"] == 2
        assert result["directory_count"] == 1
        assert result["json_file_count"] == 1
        assert result["toml_file_count"] == 1


# ---------------------------------------------------------------------------
# summarize_path — zero-byte file, large file hash skipped, permission error
# ---------------------------------------------------------------------------

def test_summarize_path_zero_byte_file():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "empty.json"
        p.write_text("")
        spec = _spec(p, harness="claude", surface="managed_settings", fmt="json")
        row = summarize_path(spec)
        assert row["size_class"] == "zero_byte"
        assert row["exists"] is True
        assert row["is_file"] is True
        assert row["payload_status"] == "zero_byte_payload_invalid_or_empty"


def test_summarize_path_large_file_skips_hash():
    """Files over 1MB should have content_sha256_16=None."""
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "big.json"
        # Write a JSON array with enough bytes to cross 1MB
        content = json.dumps(["x" * 100] * 11000)
        p.write_text(content)
        assert p.stat().st_size > 1024 * 1024
        spec = _spec(p, harness="claude", surface="managed_settings", fmt="json")
        row = summarize_path(spec)
        assert row["size_class"] == "large"
        assert row["content_sha256_16"] is None


def test_summarize_path_missing_file():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "absent.json"
        spec = _spec(p, harness="opencode", surface="managed_settings", fmt="json")
        row = summarize_path(spec)
        assert row["exists"] is False
        assert row["is_file"] is False
        assert row["is_directory"] is False
        assert row["size_class"] is None
        assert row["mode_class"] is None
        assert row["content_sha256_16"] is None
        assert row["payload_status"] == "missing_no_checked_payload"


def test_summarize_path_valid_json_small():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "settings.json"
        p.write_text(json.dumps({"allowedTools": ["read", "write"]}))
        spec = _spec(p, harness="claude", surface="managed_settings", fmt="json")
        row = summarize_path(spec)
        assert row["exists"] is True
        assert row["is_file"] is True
        assert row["parse_status"] == "valid"
        assert row["shape"] == "object"
        assert row["content_sha256_16"] is not None
        assert row["payload_status"] == "present_payload_or_dropin_review_required"


def test_summarize_path_medium_file():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "med.json"
        # 2KB content — medium class
        content = json.dumps({"data": "x" * 2000})
        p.write_text(content)
        assert 1024 <= p.stat().st_size < 1024 * 1024
        spec = _spec(p, harness="claude", surface="managed_settings", fmt="json")
        row = summarize_path(spec)
        assert row["size_class"] == "medium"


def test_summarize_path_redacts_raw_values():
    """No raw key names, values, or paths should appear in the summarize_path output."""
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "secret-settings.json"
        p.write_text(json.dumps({"apiKey": "sk-supersecret99999", "prompt": "hidden"}))
        spec = _spec(p, harness="claude", surface="managed_settings", fmt="json")
        row = summarize_path(spec)
        rendered = json.dumps(row, sort_keys=True)
        # Raw key names must not appear
        assert "apiKey" not in rendered
        assert "prompt" not in rendered
        # Raw values must not appear
        assert "supersecret" not in rendered
        assert "hidden" not in rendered


# ---------------------------------------------------------------------------
# build_report — no-payload verdict and full smoke
# ---------------------------------------------------------------------------

def test_build_report_no_present_surfaces_emits_clean_verdict():
    """When no managed surfaces exist, verdict must be no_checked_managed_payload_present."""
    with tempfile.TemporaryDirectory() as d:
        missing_specs = [
            SurfaceSpec(Path(d) / "a.json", "claude", "managed_settings", "json",
                        "test", "audit_only", "high"),
            SurfaceSpec(Path(d) / "b.json", "codex", "managed_requirements", "toml",
                        "test", "audit_only", "high"),
        ]
        report = build_report(missing_specs)
        assert report["summary"]["verdict"] == "no_checked_managed_payload_present"
        assert report["summary"]["existing_count"] == 0
        assert report["summary"]["present_review_count"] == 0


def test_build_report_filters_non_managed_harness_surfaces():
    """Surfaces with non-managed harnesses or surfaces are excluded."""
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "cfg.json"
        p.write_text("{}")
        non_managed = [
            SurfaceSpec(p, "whatsoup", "managed_settings", "json", "t", "audit_only", "high"),
            SurfaceSpec(p, "claude", "settings", "json", "t", "audit_only", "high"),
        ]
        report = build_report(non_managed)
        assert report["summary"]["managed_surface_count"] == 0


def test_managed_config_monitor_classifies_presence_without_values():
    with tempfile.TemporaryDirectory(prefix="managed-config-monitor-") as tmp_dir:
        root = Path(tmp_dir)
        report = build_report(_managed_specs(root))
        rendered = json.dumps(report, sort_keys=True)
        assert report["schema"] == "agent-runtime-managed-config-presence", report
        assert report["summary"]["managed_surface_count"] == 4, report
        assert report["summary"]["existing_count"] == 3, report
        assert report["summary"]["missing_count"] == 1, report
        assert report["summary"]["empty_directory_count"] == 1, report
        assert report["summary"]["invalid_payload_count"] == 1, report
        assert report["summary"]["present_review_count"] == 2, report
        assert report["summary"]["verdict"] == "managed_payload_present_review_required", report
        _assert_no_fixture_content(rendered, root)


def test_managed_config_monitor_rows_emit_hashes_and_statuses():
    with tempfile.TemporaryDirectory(prefix="managed-config-monitor-") as tmp_dir:
        root = Path(tmp_dir)
        report = build_report(_managed_specs(root))
        statuses = {row["path_basename"]: row for row in report["surfaces"]}
        assert statuses["managed-settings.d"]["payload_status"] == "empty_directory_policy_insertion_point", statuses
        assert statuses["managed-settings.json"]["payload_status"] == "present_payload_or_dropin_review_required", statuses
        assert statuses["requirements.toml"]["payload_status"] == "present_invalid_payload", statuses
        assert statuses["missing.json"]["payload_status"] == "missing_no_checked_payload", statuses
        for row in report["surfaces"]:
            assert row["path_sha256_16"], row
            assert "path_class" in row, row
            assert "mode_class" in row, row


def test_build_report_has_required_top_level_keys():
    with tempfile.TemporaryDirectory() as d:
        report = build_report([
            SurfaceSpec(Path(d) / "x.json", "claude", "managed_settings", "json",
                        "test", "audit_only", "high"),
        ])
        for key in ("schema", "schema_version", "proof_class", "redaction", "summary", "surfaces", "limitations"):
            assert key in report, f"missing key: {key}"
        assert report["schema"] == "agent-runtime-managed-config-presence"
        assert isinstance(report["limitations"], list)
        assert len(report["limitations"]) > 0


def test_build_report_redaction_header_in_report():
    with tempfile.TemporaryDirectory() as d:
        report = build_report([
            SurfaceSpec(Path(d) / "s.json", "claude", "managed_settings", "json",
                        "test", "audit_only", "high"),
        ])
        redaction = report["redaction"]
        assert "raw managed config values" in redaction
        assert "metadata-only" in redaction


def test_build_report_dropin_dir_with_entries_not_empty():
    """A non-empty drop-in dir should count as present, not empty_directory."""
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "dropin.d"
        p.mkdir()
        (p / "extra.json").write_text("{}")
        specs = [SurfaceSpec(p, "claude", "managed_settings_dropin_dir", "directory",
                             "test", "audit_only", "high")]
        report = build_report(specs)
        row = report["surfaces"][0]
        assert row["payload_status"] == "present_payload_or_dropin_review_required"
        assert report["summary"]["empty_directory_count"] == 0


# ---------------------------------------------------------------------------
# build_report summary counters — by_harness, by_payload_status, by_parse_status
# ---------------------------------------------------------------------------

def test_build_report_summary_counters_are_consistent():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "s.json"
        p.write_text(json.dumps({"k": 1}))
        specs = [
            SurfaceSpec(p, "claude", "managed_settings", "json", "t", "audit_only", "high"),
            SurfaceSpec(Path(d) / "absent.json", "codex", "managed_requirements", "toml",
                        "t", "audit_only", "high"),
        ]
        report = build_report(specs)
        s = report["summary"]
        assert s["managed_surface_count"] == s["existing_count"] + s["missing_count"]
        assert isinstance(s["by_harness"], dict)
        assert isinstance(s["by_payload_status"], dict)
        assert isinstance(s["by_parse_status"], dict)


# ---------------------------------------------------------------------------
# main() and parse_args() — in-process to satisfy line coverage
# ---------------------------------------------------------------------------

def test_main_no_pretty_emits_compact_json():
    """Call main() with no args → compact JSON on stdout."""
    orig_argv = sys.argv[:]
    sys.argv = ["managed_config_presence_monitor.py"]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
    assert rc == 0
    output = buf.getvalue()
    report = json.loads(output)
    assert report["schema"] == "agent-runtime-managed-config-presence"
    # Compact: no leading spaces on lines
    lines = output.splitlines()
    assert not any(line.startswith("  ") for line in lines), "Expected compact (non-pretty) JSON"


def test_main_pretty_emits_indented_json():
    """Call main() with --pretty → indented JSON on stdout."""
    orig_argv = sys.argv[:]
    sys.argv = ["managed_config_presence_monitor.py", "--pretty"]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
    assert rc == 0
    output = buf.getvalue()
    report = json.loads(output)
    assert report["schema"] == "agent-runtime-managed-config-presence"
    # Pretty: indented lines should exist
    assert any(line.startswith("  ") for line in output.splitlines())


def test_parse_args_defaults():
    orig_argv = sys.argv[:]
    sys.argv = ["managed_config_presence_monitor.py"]
    try:
        args = probe.parse_args()
        assert args.pretty is False
    finally:
        sys.argv = orig_argv


def test_parse_args_pretty_flag():
    orig_argv = sys.argv[:]
    sys.argv = ["managed_config_presence_monitor.py", "--pretty"]
    try:
        args = probe.parse_args()
        assert args.pretty is True
    finally:
        sys.argv = orig_argv


# ---------------------------------------------------------------------------
# CLI e2e — subprocess covers the __main__ guard path
# ---------------------------------------------------------------------------

def test_managed_config_monitor_cli_reports_local_summary():
    result = subprocess.run(
        [
            sys.executable,
            str(PROBE_PATH),
            "--pretty",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads(result.stdout)
    assert result.stderr == "", result.stderr
    assert report["schema"] == "agent-runtime-managed-config-presence", report
    assert report["summary"]["managed_surface_count"] >= 8, report
    assert "surfaces" in report, report


def test_cli_compact_mode_emits_valid_json():
    result = subprocess.run(
        [sys.executable, str(PROBE_PATH)],
        check=True,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    report = json.loads(result.stdout)
    assert report["schema"] == "agent-runtime-managed-config-presence"
    # Compact mode: first line should not start with space
    assert not result.stdout.splitlines()[0].startswith("  ")


# ---------------------------------------------------------------------------
# __main__ runner
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} managed config presence monitor tests passed")
