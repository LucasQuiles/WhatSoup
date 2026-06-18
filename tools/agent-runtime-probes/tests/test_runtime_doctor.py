#!/usr/bin/env python3
"""Tests for runtime_doctor redacted config summaries."""
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import runtime_doctor  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "runtime_doctor.py"


class _Patched:
    """Minimal NO-fixture manual monkeypatch: setattr on enter, restore on exit.

    Used so tests never touch real CLIs (command_version/run), real disk walks
    (du/sqlite_counts), or the network. Each value is a (name, replacement) pair.
    """

    def __init__(self, **attrs):
        self._attrs = attrs
        self._saved = {}

    def __enter__(self):
        for name, value in self._attrs.items():
            self._saved[name] = getattr(runtime_doctor, name)
            setattr(runtime_doctor, name, value)
        return self

    def __exit__(self, *exc):
        for name, value in self._saved.items():
            setattr(runtime_doctor, name, value)
        return False


def _fake_command_version(binary, *args):
    """Deterministic stand-in for command_version: pretends the binary exists
    on PATH and returns a fixed version run() shape. Never spawns a process."""
    return {
        "path": f"/fake/bin/{binary}",
        "version": {"cmd": [binary, *args], "rc": 0, "stdout": f"{binary} 9.9.9", "stderr": ""},
    }


def _fake_run_record(cmd, rc=0, stdout="ok", stderr=""):
    return {"cmd": cmd, "rc": rc, "stdout": stdout, "stderr": stderr}


def test_runtime_doctor_suppresses_opencode_environment_values():
    tmp = Path(tempfile.mkdtemp(prefix="runtime-doctor-test-"))
    old_home = runtime_doctor.HOME
    try:
        runtime_doctor.HOME = tmp
        cfg_dir = tmp / ".config/opencode"
        cfg_dir.mkdir(parents=True)
        cfg_dir.joinpath("opencode.json").write_text(
            json.dumps(
                {
                    "model": "provider/model",
                    "mcp": {
                        "x": {
                            "type": "local",
                            "enabled": True,
                            "command": ["node", "/tmp/tool.js"],
                            "environment": {
                                "PINECONE_API_KEY": "pcsk_aaaaaaaaaaaaaaaa",
                                "MS365_CLIENT_ID": "91a299a7-a3b3-467a-ae45-45d4d1dba2d5",
                            },
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        summary = runtime_doctor.summarize_opencode(live=False)
        rendered = json.dumps(summary, sort_keys=True)
        assert "environment_keys" in rendered, summary
        assert "PINECONE_API_KEY" in rendered, summary
        assert "pcsk_aaaaaaaaaaaaaaaa" not in rendered, summary
        assert "91a299a7-a3b3-467a-ae45-45d4d1dba2d5" not in rendered, summary
    finally:
        runtime_doctor.HOME = old_home


def test_runtime_doctor_redacts_codex_mcp_env_values():
    tmp = Path(tempfile.mkdtemp(prefix="runtime-doctor-test-"))
    old_home = runtime_doctor.HOME
    try:
        runtime_doctor.HOME = tmp
        cfg_dir = tmp / ".codex"
        cfg_dir.mkdir(parents=True)
        cfg_dir.joinpath("config.toml").write_text(
            """
            model = "gpt-test"
            [mcp_servers.x]
            command = "/tmp/x"
            [mcp_servers.x.env]
            PINECONE_API_KEY = "pcsk_aaaaaaaaaaaaaaaa"
            """,
            encoding="utf-8",
        )
        summary = runtime_doctor.summarize_codex(live=False)
        rendered = json.dumps(summary, sort_keys=True)
        assert "PINECONE_API_KEY" in rendered, summary
        assert "pcsk_aaaaaaaaaaaaaaaa" not in rendered, summary
    finally:
        runtime_doctor.HOME = old_home


def test_runtime_doctor_marks_malformed_claude_settings_as_error():
    tmp = Path(tempfile.mkdtemp(prefix="runtime-doctor-test-"))
    old_home = runtime_doctor.HOME
    try:
        runtime_doctor.HOME = tmp
        cfg_dir = tmp / ".claude"
        cfg_dir.mkdir(parents=True)
        cfg_dir.joinpath("settings.json").write_text("{bad", encoding="utf-8")

        summary = runtime_doctor.summarize_claude(live=False)

        assert summary["settings_status"] == {
            "status": "error",
            "error_type": "JSONDecodeError",
            "shape": "error",
        }, summary
    finally:
        runtime_doctor.HOME = old_home


def test_runtime_doctor_marks_malformed_codex_config_as_error():
    tmp = Path(tempfile.mkdtemp(prefix="runtime-doctor-test-"))
    old_home = runtime_doctor.HOME
    try:
        runtime_doctor.HOME = tmp
        cfg_dir = tmp / ".codex"
        cfg_dir.mkdir(parents=True)
        cfg_dir.joinpath("config.toml").write_text("[broken", encoding="utf-8")

        summary = runtime_doctor.summarize_codex(live=False)

        assert summary["config_status"] == {
            "status": "error",
            "error_type": "TOMLDecodeError",
            "shape": "error",
        }, summary
    finally:
        runtime_doctor.HOME = old_home


# --- load_status: every branch returns the documented status/shape -----------

def test_load_status_none_reports_missing_absent():
    assert runtime_doctor.load_status(None) == {
        "status": "missing", "error_type": None, "shape": "absent",
    }


def test_load_status_error_marker_extracts_error_type_prefix():
    out = runtime_doctor.load_status({"_error": "JSONDecodeError: Expecting value"})
    assert out == {"status": "error", "error_type": "JSONDecodeError", "shape": "error"}


def test_load_status_plain_dict_reports_ok_object():
    assert runtime_doctor.load_status({"model": "x"}) == {
        "status": "ok", "error_type": None, "shape": "object",
    }


def test_load_status_non_dict_reports_invalid_shape():
    # A JSON file that parses to a list (not a dict) is an invalid runtime config shape.
    out = runtime_doctor.load_status(["unexpected", "list"])
    assert out == {"status": "invalid_shape", "error_type": "list", "shape": "list"}


# --- command_version: missing binary yields null version, present yields run() -

def test_command_version_missing_binary_has_null_path_and_no_version():
    # shutil.which is the real function here; an impossible binary name is never on PATH,
    # so no subprocess is spawned and there must be NO version field at all.
    out = runtime_doctor.command_version("nonexistent-binary-xyz-123", "--version")
    assert out == {"path": None}
    assert "version" not in out


def test_command_version_present_binary_invokes_run_without_real_cli():
    # Mock BOTH PATH resolution and run() so no real process is ever launched.
    real_which = runtime_doctor.shutil.which
    runtime_doctor.shutil.which = lambda name: f"/fake/bin/{name}"
    with _Patched(run=lambda argv, timeout=10: _fake_run_record(argv, stdout="claude 1.0.0")):
        try:
            out = runtime_doctor.command_version("claude", "--version")
        finally:
            runtime_doctor.shutil.which = real_which
    assert out["path"] == "/fake/bin/claude"
    assert out["version"]["stdout"] == "claude 1.0.0"
    assert out["version"]["cmd"] == ["claude", "--version"]


# --- summarize_claude: live branch + non-dict settings else branch ------------

def test_summarize_claude_live_includes_mcp_and_plugin_lists_mocked():
    tmp = Path(tempfile.mkdtemp(prefix="runtime-doctor-test-"))
    calls = []

    def fake_run(argv, timeout=20):
        calls.append(argv)
        return _fake_run_record(argv, stdout="srv: connected")

    with _Patched(HOME=tmp, command_version=_fake_command_version,
                  du=lambda p: None, run=fake_run):
        cfg_dir = tmp / ".claude"
        cfg_dir.mkdir(parents=True)
        cfg_dir.joinpath("settings.json").write_text(
            json.dumps({"model": "opus", "mcpServers": {"a": {"token": "sk-abcdefgh1234"}}}),
            encoding="utf-8",
        )
        summary = runtime_doctor.summarize_claude(live=True)

    # live branch ran exactly the two documented CLI diagnostics (mocked, no real CLI)
    assert ["claude", "mcp", "list"] in calls
    assert ["claude", "plugin", "list"] in calls
    assert summary["mcp_list"]["stdout"] == "srv: connected"
    assert summary["plugin_list"]["stdout"] == "srv: connected"
    # binary came from the mocked command_version, not a real spawn
    assert summary["binary"]["path"] == "/fake/bin/claude"
    # selected_settings redacts the secret token value; only the key name survives
    rendered = json.dumps(summary, sort_keys=True)
    assert "sk-abcdefgh1234" not in rendered, summary
    assert "mcpServers" in summary["settings_keys"]


def test_summarize_claude_error_settings_yields_none_keys_and_passthrough():
    # Malformed JSON -> load_json returns a {"_error": ...} dict; that IS a dict, so
    # settings_keys becomes the sorted keys of the error marker and selected_settings
    # filters to nothing. Assert the error shape is reported, not a crash.
    tmp = Path(tempfile.mkdtemp(prefix="runtime-doctor-test-"))
    with _Patched(HOME=tmp, command_version=_fake_command_version, du=lambda p: None):
        cfg_dir = tmp / ".claude"
        cfg_dir.mkdir(parents=True)
        cfg_dir.joinpath("settings.json").write_text("{bad json", encoding="utf-8")
        summary = runtime_doctor.summarize_claude(live=False)
    assert summary["settings_status"]["status"] == "error"
    assert summary["settings_keys"] == ["_error"]
    assert "mcp_list" not in summary  # non-live: no CLI diagnostics


def test_summarize_claude_missing_settings_passes_none_through():
    # No settings.json -> load_json returns None (not a dict): settings_keys is None
    # and selected_settings is the raw None passthrough (the `else settings` branch).
    tmp = Path(tempfile.mkdtemp(prefix="runtime-doctor-test-"))
    with _Patched(HOME=tmp, command_version=_fake_command_version, du=lambda p: None):
        (tmp / ".claude").mkdir(parents=True)
        summary = runtime_doctor.summarize_claude(live=False)
    assert summary["settings_status"] == {
        "status": "missing", "error_type": None, "shape": "absent",
    }
    assert summary["settings_keys"] is None
    assert summary["selected_settings"] is None


# --- summarize_codex: live branch + non-dict config else branch ---------------

def test_summarize_codex_live_includes_mcp_list_mocked():
    tmp = Path(tempfile.mkdtemp(prefix="runtime-doctor-test-"))
    calls = []

    def fake_run(argv, timeout=20):
        calls.append(argv)
        return _fake_run_record(argv, stdout="codex-srv ok")

    with _Patched(HOME=tmp, command_version=_fake_command_version,
                  du=lambda p: None, run=fake_run):
        cfg_dir = tmp / ".codex"
        cfg_dir.mkdir(parents=True)
        cfg_dir.joinpath("config.toml").write_text(
            'model = "gpt-test"\napproval_policy = "on-request"\n', encoding="utf-8")
        summary = runtime_doctor.summarize_codex(live=True)
    assert ["codex", "mcp", "list"] in calls
    assert summary["mcp_list"]["stdout"] == "codex-srv ok"
    assert summary["selected_settings"]["model"] == "gpt-test"
    assert summary["selected_settings"]["approval_policy"] == "on-request"


def test_summarize_codex_missing_config_passes_none_through():
    tmp = Path(tempfile.mkdtemp(prefix="runtime-doctor-test-"))
    with _Patched(HOME=tmp, command_version=_fake_command_version, du=lambda p: None):
        (tmp / ".codex").mkdir(parents=True)
        summary = runtime_doctor.summarize_codex(live=False)
    assert summary["config_status"]["status"] == "missing"
    assert summary["config_keys"] is None
    assert summary["selected_settings"] is None
    assert "mcp_list" not in summary


# --- summarize_opencode: live branch + happy path (db/resource/ocw mocked) -----

def test_summarize_opencode_live_runs_all_diagnostics_mocked():
    tmp = Path(tempfile.mkdtemp(prefix="runtime-doctor-test-"))
    calls = []

    def fake_run(argv, timeout=20):
        calls.append(argv)
        return _fake_run_record(argv, stdout="opencode-diag")

    real_which = runtime_doctor.shutil.which
    runtime_doctor.shutil.which = lambda name: f"/fake/bin/{name}"
    with _Patched(HOME=tmp, command_version=_fake_command_version,
                  du=lambda p: "4.0K", sqlite_counts=lambda path, tables: {t: 7 for t in tables},
                  run=fake_run):
        try:
            cfg_dir = tmp / ".config/opencode"
            cfg_dir.mkdir(parents=True)
            cfg_dir.joinpath("opencode.json").write_text(
                json.dumps({
                    "model": "prov/m", "small_model": "prov/s", "default_agent": "build",
                    "plugin": ["p1"],
                    "mcp": {"srv": {"type": "local", "enabled": True,
                                    "command": ["node", "x.js"],
                                    "environment": {"PINECONE_API_KEY": "pcsk_secretsecret"}}},
                }),
                encoding="utf-8",
            )
            summary = runtime_doctor.summarize_opencode(live=True)
        finally:
            runtime_doctor.shutil.which = real_which

    # live diagnostics all dispatched (mocked)
    for argv in (["opencode", "debug", "paths"], ["opencode", "mcp", "list"],
                 ["opencode", "auth", "list"],
                 ["opencode", "stats", "--days", "7", "--tools", "10", "--models", "10"]):
        assert argv in calls, calls
    assert summary["paths"]["stdout"] == "opencode-diag"
    assert summary["auth_list"]["stdout"] == "opencode-diag"
    assert summary["stats_7d"]["stdout"] == "opencode-diag"
    # mocked db_counts surfaced, real sqlite never touched
    assert summary["db_counts"] == {k: 7 for k in
                                    ("session", "message", "part", "event", "project", "todo")}
    # ocw wrappers resolved via mocked which (no real PATH dependency)
    assert summary["ocw_wrappers"]["ocw"] == "/fake/bin/ocw"
    # secret env VALUE suppressed; only the key name remains
    rendered = json.dumps(summary, sort_keys=True)
    assert "pcsk_secretsecret" not in rendered, summary
    assert "PINECONE_API_KEY" in summary["mcp_servers"]["srv"]["environment_keys"]


# --- summarize_pi: presence booleans + version shape (no real pi) -------------

def test_summarize_pi_absent_reports_false_presence_and_null_sizes():
    tmp = Path(tempfile.mkdtemp(prefix="runtime-doctor-test-"))
    # command_version mocked to the missing-binary shape: path null, no version
    with _Patched(HOME=tmp, command_version=lambda b, *a: {"path": None},
                  du=lambda p: None):
        summary = runtime_doctor.summarize_pi()
    assert summary["binary"] == {"path": None}
    assert summary["known_paths"] == {
        "~/.pi": False, "~/.pi/agent": False, "~/.config/pi": False,
    }
    assert summary["state_sizes"] == {".pi": None, ".config/pi": None}


def test_summarize_pi_present_reports_true_presence_and_version():
    tmp = Path(tempfile.mkdtemp(prefix="runtime-doctor-test-"))
    (tmp / ".pi/agent").mkdir(parents=True)
    (tmp / ".config/pi").mkdir(parents=True)
    with _Patched(HOME=tmp, command_version=_fake_command_version, du=lambda p: "8.0K"):
        summary = runtime_doctor.summarize_pi()
    assert summary["binary"]["version"]["stdout"] == "pi 9.9.9"
    assert summary["known_paths"]["~/.pi"] is True
    assert summary["known_paths"]["~/.pi/agent"] is True
    assert summary["known_paths"]["~/.config/pi"] is True
    assert summary["state_sizes"][".pi"] == "8.0K"


# --- main(): assembles report, non-live; secrets stay suppressed --------------

def test_main_non_live_emits_full_report_and_zero_exit():
    tmp = Path(tempfile.mkdtemp(prefix="runtime-doctor-test-"))
    argv_saved = sys.argv
    with _Patched(HOME=tmp, command_version=_fake_command_version,
                  du=lambda p: None, sqlite_counts=lambda path, tables: None,
                  run=lambda argv, timeout=20: _fake_run_record(argv)):
        # opencode config with a secret to prove redaction survives the full assembly
        cfg = tmp / ".config/opencode"
        cfg.mkdir(parents=True)
        cfg.joinpath("opencode.json").write_text(
            json.dumps({"mcp": {"s": {"type": "local",
                                      "environment": {"GITHUB_TOKEN": "ghp_" + "a" * 36}}}}),
            encoding="utf-8")
        buf = io.StringIO()
        try:
            sys.argv = ["runtime_doctor.py"]
            with redirect_stdout(buf):
                rc = runtime_doctor.main()
        finally:
            sys.argv = argv_saved
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-runtime-doctor"
    assert report["schema_version"] == "0.1"
    assert report["live"] is False
    assert set(report) >= {"claude", "codex", "opencode", "pi", "cwd"}
    # non-live: no CLI-list keys present in any summary
    assert "mcp_list" not in report["claude"]
    assert "paths" not in report["opencode"]
    # secret never leaks into the emitted report
    assert "ghp_" + "a" * 36 not in buf.getvalue()


def test_main_live_flag_sets_live_true_and_runs_diagnostics_mocked():
    tmp = Path(tempfile.mkdtemp(prefix="runtime-doctor-test-"))
    argv_saved = sys.argv
    calls = []
    with _Patched(HOME=tmp, command_version=_fake_command_version,
                  du=lambda p: None, sqlite_counts=lambda path, tables: None,
                  run=lambda argv, timeout=20: (calls.append(argv) or _fake_run_record(argv))):
        buf = io.StringIO()
        try:
            sys.argv = ["runtime_doctor.py", "--live"]
            with redirect_stdout(buf):
                rc = runtime_doctor.main()
        finally:
            sys.argv = argv_saved
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["live"] is True
    assert "mcp_list" in report["claude"]  # live diagnostics assembled
    assert ["claude", "mcp", "list"] in calls


# --- CLI e2e: real subprocess covers the __main__ entrypoint ------------------

def test_cli_entrypoint_emits_valid_json():
    # Real subprocess so the `if __name__ == "__main__"` path executes and json.dump runs.
    # Non-live by default -> no MCP/network diagnostics are invoked.
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH)],
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-runtime-doctor"
    assert report["live"] is False
    assert {"claude", "codex", "opencode", "pi"} <= set(report)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} runtime doctor tests passed")
