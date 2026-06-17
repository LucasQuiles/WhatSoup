#!/usr/bin/env python3
"""Unit tests for opencode_config_redactor value suppression and fail-closed paths.

The `opencode debug config` subprocess is always mocked (probe.subprocess.run is
replaced); no real opencode binary is invoked and no network is touched.
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

import opencode_config_redactor as probe  # noqa: E402
from opencode_config_redactor import (  # noqa: E402
    RedactionStats,
    build_report,
    candidate_sources,
    classify_path,
    command_shape,
    count_substitution_markers,
    filename_class,
    inventory_paths,
    parse_json_object,
    placeholder,
    read_file_source,
    redact_config_tree,
    run_debug_config,
    sanitize_metadata,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "opencode_config_redactor.py"


class _FakeProc:
    """Stand-in for subprocess.CompletedProcess returned by a mocked subprocess.run."""

    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def _mock_subprocess_run(stdout="", stderr="", returncode=0, raises=None):
    """Return a fake subprocess.run; if `raises` is set, raise it instead."""

    def fake(*args, **kwargs):
        if raises is not None:
            raise raises
        return _FakeProc(stdout=stdout, stderr=stderr, returncode=returncode)

    return fake


def test_resolved_config_tree_redacts_all_scalar_leaves():
    stats = RedactionStats()
    cfg = {
        "model": "provider/model-name",
        "mcp": {"pinecone": {"enabled": True, "environment": {"PINECONE_API_KEY": "pcsk_aaaaaaaaaaaaaaaa"}}},
        "provider": {"openai": {"options": {"baseURL": "https://example.com/api"}}},
    }
    out = redact_config_tree(cfg, stats=stats)
    rendered = str(out)
    assert "provider/model-name" not in rendered, out
    assert "pcsk_aaaaaaaaaaaaaaaa" not in rendered, out
    assert "https://example.com/api" not in rendered, out
    assert out["mcp"]["pinecone"]["enabled"].startswith("<redacted:scalar:bool>"), out
    assert stats.total == 4, stats


def test_report_contains_hashes_and_inventory_but_not_values():
    tmp_path = Path(tempfile.mkdtemp(prefix="opencode-redactor-test-"))
    cfg = {"model": "provider/model-name", "mcp": {"x": {"command": ["node", "/Users/testuser/private/tool.js"]}}}
    report = build_report(cfg, "file", {"path": str(tmp_path / "opencode.json"), "status": "parsed"}, tmp_path)
    rendered = str(report)
    assert report["parse_status"] == "parsed"
    assert report["config_sha256_16"]
    assert report["redacted_config_sha256_16"]
    assert "$.mcp.x.command[1]" in {row["path"] for row in report["config_inventory"]}
    assert "provider/model-name" not in rendered, report
    assert "/Users/testuser/private/tool.js" not in rendered, report
    assert str(tmp_path) not in rendered, report
    assert "path_metadata" in report["source_metadata"], report["source_metadata"]
    assert report["source_metadata"]["path_metadata"]["path_sha256_16"], report["source_metadata"]


def test_candidate_sources_do_not_emit_raw_paths():
    tmp_path = Path(tempfile.mkdtemp(prefix="opencode-redactor-candidates-"))
    project_config = tmp_path / "opencode.json"
    project_config.write_text('{"model":"provider/model-name"}')
    cfg = {"model": "provider/model-name"}
    report = build_report(cfg, "file", {"path": str(project_config), "status": "parsed"}, tmp_path)
    rendered = str(report)
    assert str(tmp_path) not in rendered, report
    assert str(Path.home()) not in rendered, report
    candidates = report["resolution"]["candidate_sources"]
    assert candidates, report
    assert all("path" not in row for row in candidates), candidates
    assert any(row["path_class"] == "project_root_opencode_config" for row in candidates), candidates
    assert all(row.get("path_sha256_16") for row in candidates), candidates


def test_file_source_metadata_suppresses_input_path():
    tmp_path = Path(tempfile.mkdtemp(prefix="opencode-redactor-file-source-"))
    source = tmp_path / "private-opencode.json"
    source.write_text('{"model":"provider/model-name"}')
    config, metadata = read_file_source(source, tmp_path)
    assert config == {"model": "provider/model-name"}
    rendered = str(metadata)
    assert str(tmp_path) not in rendered, metadata
    assert "private-opencode.json" not in rendered, metadata
    assert metadata["path_sha256_16"], metadata
    assert metadata["filename_class"] == "other_json", metadata


# --- placeholder() type-kind branches ----------------------------------------

def test_placeholder_renders_typed_kinds():
    assert placeholder(True, "scalar") == "<redacted:scalar:bool>"
    assert placeholder(7, "scalar") == "<redacted:scalar:int>"
    assert placeholder(3.5, "scalar") == "<redacted:scalar:float>"
    assert placeholder("x", "sensitive") == "<redacted:sensitive:str>"
    # Non-scalar fallback exercises the type(value).__name__ branch.
    assert placeholder({"a": 1}, "scalar") == "<redacted:scalar:dict>"


# --- filename_class() branches ------------------------------------------------

def test_filename_class_covers_all_extension_branches():
    assert filename_class(Path("/x/opencode.json")) == "opencode_json"
    assert filename_class(Path("/x/opencode.jsonc")) == "opencode_jsonc"
    assert filename_class(Path("/x/other.json")) == "other_json"
    assert filename_class(Path("/x/other.jsonc")) == "other_jsonc"
    # Unknown extension -> other_with_extension
    assert filename_class(Path("/x/tool.js")) == "other_with_extension"
    # No extension -> other_without_extension
    assert filename_class(Path("/x/Makefile")) == "other_without_extension"


# --- classify_path() branches -------------------------------------------------

def test_classify_path_home_other_absolute_and_relative():
    cwd = Path(tempfile.mkdtemp(prefix="opencode-classify-cwd-"))
    # A home file that is not under .config/opencode -> home_other
    home_file = Path.home() / ".some-unrelated-classify-file.json"
    assert classify_path(home_file, cwd) == "home_other"
    # Absolute path outside home and cwd -> absolute_other
    assert classify_path(Path("/opt/elsewhere/config.json"), cwd) == "absolute_other"
    # Relative path that does not resolve under cwd/home/system -> relative_other.
    # safe_resolve makes paths absolute against os.getcwd(); use a path engineered
    # to land outside all known roots by resolving from the filesystem root.
    rel = classify_path(Path("../../../../../../tmp-nonexistent-relother"), cwd)
    assert rel in {"relative_other", "absolute_other"}, rel
    # project_other: a file under cwd that is not a known opencode config
    assert classify_path(cwd / "nested" / "data.txt", cwd) == "project_other"


def test_classify_path_recognizes_opencode_homes():
    cwd = Path(tempfile.mkdtemp(prefix="opencode-classify-known-"))
    assert classify_path(Path.home() / ".config/opencode/opencode.json", cwd) == "home_opencode_config"
    assert classify_path(cwd / ".opencode/opencode.json", cwd) == "project_dot_opencode_config"
    assert classify_path(cwd / "opencode.json", cwd) == "project_root_opencode_config"


# --- command_shape() branches -------------------------------------------------

def test_command_shape_identifies_debug_config_and_flags():
    shape = command_shape(["opencode", "debug", "config", "--pure", "-q"])
    assert shape["command_id"] == "opencode_debug_config"
    assert shape["executable_basename"] == "opencode"
    assert shape["arg_count"] == 5
    assert shape["flags"] == ["--pure", "-q"]


def test_command_shape_marks_other_commands():
    shape = command_shape(["node", "/Users/testuser/private/server.js", "--port", "8080"])
    assert shape["command_id"] == "other"
    assert shape["executable_basename"] == "node"
    assert shape["flags"] == ["--port"]


# --- sanitize_metadata() command/list branches --------------------------------

def test_sanitize_metadata_replaces_command_with_shape_and_suppresses_path():
    cwd = Path(tempfile.mkdtemp(prefix="opencode-sanitize-"))
    meta = {
        "command": ["node", "/Users/testuser/private/secret-server.js"],
        "nested": [{"config_path": "/Users/testuser/private/opencode.json"}],
        "label": "plain-value",
    }
    out = sanitize_metadata(meta, cwd)
    rendered = str(out)
    # The raw command path must be gone; only command_shape remains.
    assert "command_shape" in out, out
    assert "/Users/testuser/private/secret-server.js" not in rendered, out
    assert out["command_shape"]["command_id"] == "other", out
    # The *_path key inside a list element is converted to <name>_metadata, raw path gone.
    assert "/Users/testuser/private/opencode.json" not in rendered, out
    assert out["nested"][0]["config_path_metadata"]["path_sha256_16"], out
    assert "config_path" not in out["nested"][0], out


# --- count_substitution_markers() ---------------------------------------------

def test_count_substitution_markers_counts_env_and_file():
    cfg = {
        "a": "{env:OPENAI_API_KEY}",
        "b": ["{file:/etc/secret}", "{file:/etc/other}"],
        "c": {"d": "no markers here"},
    }
    counts = count_substitution_markers(cfg)
    assert counts == {"env": 1, "file": 2}, counts


# --- inventory_paths() truncation + array branches ----------------------------

def test_inventory_paths_truncates_long_arrays():
    cfg = {"items": list(range(60))}
    rows = inventory_paths(cfg)
    paths = {row["path"] for row in rows}
    # First 50 indices inventoried, then an array_truncated marker for the rest.
    assert "$.items[0]" in paths
    assert "$.items[49]" in paths
    assert "$.items[50]" not in paths
    trunc = [r for r in rows if r["type"] == "array_truncated"]
    assert trunc and trunc[0]["omitted"] == 10, rows


def test_inventory_paths_respects_max_paths_cap():
    cfg = {str(i): i for i in range(20)}
    rows = inventory_paths(cfg, max_paths=5)
    # A global inventory_truncated marker is appended when the cap is hit.
    assert any(r["type"] == "inventory_truncated" and r["max_paths"] == 5 for r in rows), rows


# --- parse_json_object() unhappy paths ----------------------------------------

def test_parse_json_object_rejects_empty_stdout():
    raised = False
    try:
        parse_json_object("   \n  ")
    except ValueError as exc:
        raised = True
        assert "empty stdout" in str(exc)
    assert raised, "empty stdout must raise ValueError, not return clean None"


def test_parse_json_object_recovers_embedded_object():
    # Leading log noise before a JSON object: brace-slice recovery path.
    out = parse_json_object("INFO starting\n{\"model\":\"x\"}\ntrailing log")
    assert out == {"model": "x"}, out


def test_parse_json_object_reraises_when_no_braces():
    raised = False
    try:
        parse_json_object("not json at all, no braces")
    except json.JSONDecodeError:
        raised = True
    assert raised, "garbage with no object braces must re-raise JSONDecodeError"


# --- run_debug_config() unhappy paths (mocked subprocess) ---------------------

def test_run_debug_config_binary_missing_fails_closed():
    orig = probe.subprocess.run
    probe.subprocess.run = _mock_subprocess_run(raises=FileNotFoundError("opencode"))
    try:
        config, meta = run_debug_config(timeout=5, pure=False, cwd=Path.cwd())
    finally:
        probe.subprocess.run = orig
    assert config is None, "missing binary must not yield a config"
    assert meta["status"] == "error"
    assert meta["error_type"] == "FileNotFoundError"
    assert meta["rc"] == 127


def test_run_debug_config_timeout_fails_closed():
    orig = probe.subprocess.run
    probe.subprocess.run = _mock_subprocess_run(
        raises=subprocess.TimeoutExpired(cmd=["opencode"], timeout=5)
    )
    try:
        config, meta = run_debug_config(timeout=5, pure=True, cwd=Path.cwd())
    finally:
        probe.subprocess.run = orig
    assert config is None, "timeout must not yield a config"
    assert meta["status"] == "error"
    assert meta["error_type"] == "TimeoutExpired"
    assert meta["rc"] == 124


def test_run_debug_config_nonzero_exit_fails_closed_without_echoing_stdout():
    secret_stdout = '{"mcp":{"x":{"environment":{"OPENAI_API_KEY":"sk-abcdefghij1234567890"}}}}'
    orig = probe.subprocess.run
    probe.subprocess.run = _mock_subprocess_run(
        stdout=secret_stdout, stderr="boom: config error sk-leakything", returncode=3
    )
    try:
        config, meta = run_debug_config(timeout=5, pure=False, cwd=Path.cwd())
    finally:
        probe.subprocess.run = orig
    assert config is None
    assert meta["status"] == "error"
    assert meta["error_type"] == "nonzero_exit"
    assert meta["rc"] == 3
    rendered = json.dumps(meta)
    # Only hashes/byte counts are emitted; raw stdout/stderr must never appear.
    assert "sk-abcdefghij1234567890" not in rendered, meta
    assert "leakything" not in rendered, meta
    assert meta["stdout_sha256_16"] and meta["stderr_sha256_16"], meta
    assert meta["stdout_bytes"] == len(secret_stdout.encode("utf-8")), meta


def test_run_debug_config_malformed_json_fails_closed():
    orig = probe.subprocess.run
    probe.subprocess.run = _mock_subprocess_run(stdout="this is not json", returncode=0)
    try:
        config, meta = run_debug_config(timeout=5, pure=False, cwd=Path.cwd())
    finally:
        probe.subprocess.run = orig
    assert config is None, "malformed JSON must fail closed, not return clean None silently"
    assert meta["status"] == "error"
    # parse_json_object raised JSONDecodeError -> error_type captured by name.
    assert meta["error_type"] == "JSONDecodeError", meta
    assert "this is not json" not in json.dumps(meta), meta


def test_run_debug_config_success_parses_and_passes_pure_flag():
    captured = {}

    def fake(cmd, *args, **kwargs):
        captured["cmd"] = cmd
        return _FakeProc(stdout='{"model":"provider/m","mcp":{}}', returncode=0)

    orig = probe.subprocess.run
    probe.subprocess.run = fake
    try:
        config, meta = run_debug_config(timeout=5, pure=True, cwd=Path.cwd())
    finally:
        probe.subprocess.run = orig
    assert config == {"model": "provider/m", "mcp": {}}, config
    assert meta["status"] == "parsed"
    assert meta["rc"] == 0
    assert captured["cmd"] == ["opencode", "debug", "config", "--pure"], captured


# --- build_report() unavailable branch ----------------------------------------

def test_build_report_unavailable_when_config_none():
    cwd = Path(tempfile.mkdtemp(prefix="opencode-unavail-"))
    meta = {"command_shape": command_shape(["opencode", "debug", "config"]),
            "status": "error", "error_type": "FileNotFoundError", "rc": 127}
    report = build_report(None, "debug", meta, cwd)
    assert report["parse_status"] == "unavailable"
    assert report["config"] is None
    assert report["config_sha256_16"] is None
    assert report["redaction"]["redacted_count"] == 0
    # source_metadata is still sanitized.
    assert report["source_metadata"]["status"] == "error"


# --- secret-shaped VALUE suppression even under benign keys -------------------

def test_secret_shaped_value_under_benign_key_is_redacted_as_sensitive():
    stats = RedactionStats()
    cfg = {"notes": "sk-abcdefghij1234567890", "label": "harmless"}
    out = redact_config_tree(cfg, stats=stats)
    rendered = str(out)
    assert "sk-abcdefghij1234567890" not in rendered, out
    # The secret-shaped value is caught by the probelib content-aware first pass.
    assert out["notes"] == "<redacted:sensitive:str>", out
    assert out["label"] == "<redacted:scalar:str>", out
    assert stats.by_reason["probelib_sensitive_key_or_value"] == 1, stats.by_reason
    assert stats.by_reason["scalar_leaf"] == 1, stats.by_reason


# --- redact_config_tree default-stats + None-leaf branches --------------------

def test_redact_config_tree_default_stats_and_preserves_none_leaf():
    # Called WITHOUT a stats arg -> internal RedactionStats() default branch.
    cfg = {"enabled": True, "disabled_field": None, "items": [1, None, "x"]}
    out = redact_config_tree(cfg)
    # None leaves are preserved as null (not placeholdered), structure intact.
    assert out["disabled_field"] is None, out
    assert out["items"][1] is None, out
    assert out["enabled"] == "<redacted:scalar:bool>", out
    assert out["items"][0] == "<redacted:scalar:int>", out
    assert out["items"][2] == "<redacted:scalar:str>", out


# --- candidate_sources dedup branch -------------------------------------------

def test_candidate_sources_dedup_collapses_colliding_paths():
    # With cwd == HOME/.config/opencode, the home candidate
    # (HOME/.config/opencode/opencode.json) and the cwd-root candidate
    # (cwd/opencode.json) resolve to the SAME path, firing the `seen` dedup
    # `continue` branch; that pair collapses to one row.
    cwd = Path.home() / ".config/opencode"
    rows = candidate_sources(cwd)
    shas = [row["path_sha256_16"] for row in rows]
    assert len(shas) == len(set(shas)), ("dedup must drop colliding candidates", rows)
    rendered = json.dumps(rows)
    assert str(Path.home()) not in rendered, rows
    assert all("path" not in row for row in rows), rows
    assert all(row.get("path_sha256_16") for row in rows), rows


# --- main() in-process: file source happy + error paths -----------------------

def test_main_file_source_emits_redacted_report():
    tmp = Path(tempfile.mkdtemp(prefix="opencode-main-file-"))
    src = tmp / "opencode.json"
    src.write_text('{"model":"provider/model","mcp":{"x":{"environment":{"PINECONE_API_KEY":"pcsk_zzzzzzzzzzzzzzzz"}}}}')
    argv = ["prog", "--source", "file", "--file", str(src), "--cwd", str(tmp)]
    orig_argv = sys.argv
    sys.argv = argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["parse_status"] == "parsed"
    assert report["source"] == "file"
    rendered = buf.getvalue()
    assert "pcsk_zzzzzzzzzzzzzzzz" not in rendered, report
    assert "provider/model" not in rendered, report
    assert str(tmp) not in rendered, report
    assert report["source_metadata"]["status"] == "parsed"


def test_main_file_source_missing_file_fails_closed():
    tmp = Path(tempfile.mkdtemp(prefix="opencode-main-missing-"))
    missing = tmp / "does-not-exist.json"
    argv = ["prog", "--source", "file", "--file", str(missing), "--cwd", str(tmp)]
    orig_argv = sys.argv
    sys.argv = argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
    assert rc == 1, "missing file must exit nonzero (fail closed)"
    report = json.loads(buf.getvalue())
    assert report["parse_status"] == "unavailable"
    assert report["source_metadata"]["status"] == "error"
    assert report["source_metadata"]["error_type"] in {"FileNotFoundError", "JSONDecodeError"}, report
    assert str(tmp) not in buf.getvalue(), report


def test_main_debug_source_unavailable_fails_closed_with_mocked_subprocess():
    tmp = Path(tempfile.mkdtemp(prefix="opencode-main-debug-"))
    argv = ["prog", "--source", "debug", "--cwd", str(tmp), "--timeout", "5"]
    orig_argv = sys.argv
    orig_run = probe.subprocess.run
    sys.argv = argv
    probe.subprocess.run = _mock_subprocess_run(raises=FileNotFoundError("opencode"))
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
        probe.subprocess.run = orig_run
    assert rc == 1, "missing opencode binary must exit nonzero (fail closed)"
    report = json.loads(buf.getvalue())
    assert report["parse_status"] == "unavailable"
    assert report["source_metadata"]["error_type"] == "FileNotFoundError", report


def test_main_debug_source_success_pretty_with_mocked_subprocess():
    tmp = Path(tempfile.mkdtemp(prefix="opencode-main-debug-ok-"))
    stdout = '{"model":"provider/m","provider":{"openai":{"options":{"apiKey":"sk-abcdefghij1234567890"}}}}'
    argv = ["prog", "--source", "debug", "--cwd", str(tmp), "--pretty", "--pure"]
    orig_argv = sys.argv
    orig_run = probe.subprocess.run
    sys.argv = argv
    probe.subprocess.run = _mock_subprocess_run(stdout=stdout, returncode=0)
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
        probe.subprocess.run = orig_run
    assert rc == 0
    rendered = buf.getvalue()
    report = json.loads(rendered)
    assert report["parse_status"] == "parsed"
    assert report["source"] == "debug"
    # --pretty produced indented output (newlines inside the JSON body).
    assert "\n  " in rendered, "pretty output should be indented"
    # The secret apiKey value must be suppressed in the emitted report.
    assert "sk-abcdefghij1234567890" not in rendered, report


# --- CLI e2e subprocess: opencode unavailable -> typed error, nonzero exit ----

def test_cli_entrypoint_debug_source_fails_closed_when_opencode_absent():
    # Real subprocess of the probe. PATH is emptied so `opencode` cannot be
    # found; the probe must fail closed with a typed error and exit 1.
    tmp = Path(tempfile.mkdtemp(prefix="opencode-cli-e2e-"))
    env = dict(os.environ)
    env["PATH"] = ""  # no executables resolvable -> FileNotFoundError in subprocess.run
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--source", "debug", "--cwd", str(tmp), "--timeout", "5"],
        capture_output=True, text=True, timeout=30, env=env,
    )
    assert proc.returncode == 1, (proc.returncode, proc.stderr)
    report = json.loads(proc.stdout)
    assert report["schema"] == "opencode-resolved-config-redacted"
    assert report["parse_status"] == "unavailable"
    assert report["source_metadata"]["status"] == "error"
    assert report["source_metadata"]["error_type"] == "FileNotFoundError", report


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} opencode config redactor tests passed")
