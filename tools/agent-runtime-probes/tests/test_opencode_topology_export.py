#!/usr/bin/env python3
"""Tests for opencode_topology_export: value suppression, --live flag, missing config, CLI e2e, and determinism.

No-install: mocks are applied by monkeypatching module attributes (save/restore in finally).
The CLI entrypoint test runs the probe as a real subprocess to cover the __main__ path.
"""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import opencode_topology_export as topo  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "opencode_topology_export.py"


def _make_tmp_home(cfg_content=None):
    """Create a temp dir structured as a minimal $HOME with optional config content."""
    tmp = Path(tempfile.mkdtemp(prefix="opencode-topology-test-"))
    cfg_dir = tmp / ".config" / "opencode"
    cfg_dir.mkdir(parents=True)
    if cfg_content is not None:
        cfg_dir.joinpath("opencode.json").write_text(
            json.dumps(cfg_content), encoding="utf-8"
        )
    return tmp


def test_opencode_topology_suppresses_environment_values():
    tmp = Path(tempfile.mkdtemp(prefix="opencode-topology-test-"))
    old_home = topo.HOME
    old_run = topo.run
    old_argv = sys.argv[:]
    try:
        topo.HOME = tmp
        topo.run = lambda argv, timeout=30: {"cmd": argv, "rc": 0, "stdout": "0", "stderr": ""}
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
        sys.argv = ["opencode_topology_export.py"]
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            assert topo.main() == 0
        rendered = stdout.getvalue()
        report = json.loads(rendered)
        assert report["schema"] == "agent-runtime-opencode-topology", report
        assert "environment_keys" in rendered, report
        assert "PINECONE_API_KEY" in rendered, report
        assert "pcsk_aaaaaaaaaaaaaaaa" not in rendered, report
        assert "91a299a7-a3b3-467a-ae45-45d4d1dba2d5" not in rendered, report
    finally:
        topo.HOME = old_home
        topo.run = old_run
        sys.argv = old_argv


def test_live_flag_adds_diagnostic_keys():
    """UNHAPPY_TEST_TERMS: live, missing, error, timeout
    Covers the --live branch (lines 71-73): when --live is passed the report must include
    paths, mcp_list, and auth_list keys populated by the mocked run() helper.
    """
    tmp = _make_tmp_home({"model": "m/m"})
    old_home = topo.HOME
    old_run = topo.run
    old_argv = sys.argv[:]
    calls = []

    def fake_run(argv, timeout=20):
        calls.append(tuple(argv))
        return {"cmd": argv, "rc": 0, "stdout": " ".join(argv), "stderr": ""}

    try:
        topo.HOME = tmp
        topo.run = fake_run
        sys.argv = ["opencode_topology_export.py", "--live"]
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            rc = topo.main()
        assert rc == 0
        report = json.loads(stdout.getvalue())
        # --live branch: paths, mcp_list, auth_list must be present
        assert "paths" in report, f"missing 'paths' key; got keys: {list(report)}"
        assert "mcp_list" in report, f"missing 'mcp_list' key; got keys: {list(report)}"
        assert "auth_list" in report, f"missing 'auth_list' key; got keys: {list(report)}"
        # verify the fake_run was called for the three live sub-commands
        assert any("debug" in c for c in calls), f"expected 'opencode debug paths' call; got {calls}"
        assert any("list" in c and "mcp" in c for c in calls), f"expected mcp list call; got {calls}"
        assert any("list" in c and "auth" in c for c in calls), f"expected auth list call; got {calls}"
    finally:
        topo.HOME = old_home
        topo.run = old_run
        sys.argv = old_argv


def test_missing_config_file_yields_empty_config_keys():
    """UNHAPPY_TEST_TERMS: missing, absent, error, empty
    When the config file does not exist load_json returns None, `or {}` yields an empty dict,
    and config_keys must be an empty list (not None).
    """
    tmp = _make_tmp_home()  # no opencode.json written
    old_home = topo.HOME
    old_run = topo.run
    old_argv = sys.argv[:]
    try:
        topo.HOME = tmp
        topo.run = lambda argv, timeout=20: {"cmd": argv, "rc": 0, "stdout": "0.0.0", "stderr": ""}
        sys.argv = ["opencode_topology_export.py"]
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            rc = topo.main()
        assert rc == 0
        report = json.loads(stdout.getvalue())
        assert report["schema"] == "agent-runtime-opencode-topology"
        assert report["config_keys"] == [], f"expected [] for missing config; got {report['config_keys']!r}"
        assert report["model"] is None, f"expected None model; got {report['model']!r}"
        assert report["mcp_servers"] == {}, f"expected empty mcp_servers; got {report['mcp_servers']!r}"
    finally:
        topo.HOME = old_home
        topo.run = old_run
        sys.argv = old_argv


def test_mcp_non_dict_item_skipped():
    """UNHAPPY_TEST_TERMS: malformed, non-dict, invalid, skipped
    MCP entries that are not dicts (e.g. a bare string) must be silently excluded
    from mcp_servers — the `if isinstance(item, dict)` guard must hold.
    """
    cfg = {
        "mcp": {
            "valid": {"type": "local", "enabled": True},
            "bad": "not-a-dict",
        }
    }
    tmp = _make_tmp_home(cfg)
    old_home = topo.HOME
    old_run = topo.run
    old_argv = sys.argv[:]
    try:
        topo.HOME = tmp
        topo.run = lambda argv, timeout=20: {"cmd": argv, "rc": 0, "stdout": "0", "stderr": ""}
        sys.argv = ["opencode_topology_export.py"]
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            assert topo.main() == 0
        report = json.loads(stdout.getvalue())
        assert "valid" in report["mcp_servers"], "valid mcp entry should appear"
        assert "bad" not in report["mcp_servers"], "non-dict mcp entry must be skipped"
    finally:
        topo.HOME = old_home
        topo.run = old_run
        sys.argv = old_argv


def test_determinism_identical_input_produces_identical_output():
    """UNHAPPY_TEST_TERMS: non-deterministic, flaky, ordering
    Two calls with identical inputs must produce byte-identical JSON output
    (no timestamp, random seeds, or unordered sets in the output).
    """
    cfg = {
        "model": "my-provider/my-model",
        "mcp": {
            "server_b": {"type": "local", "enabled": False, "environment": {"KEY": "val"}},
            "server_a": {"type": "remote", "enabled": True},
        },
    }
    tmp = _make_tmp_home(cfg)
    old_home = topo.HOME
    old_run = topo.run
    old_argv = sys.argv[:]
    try:
        topo.HOME = tmp
        topo.run = lambda argv, timeout=20: {"cmd": argv, "rc": 0, "stdout": "1.2.3", "stderr": ""}
        sys.argv = ["opencode_topology_export.py"]

        results = []
        for _ in range(2):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                topo.main()
            results.append(buf.getvalue())

        assert results[0] == results[1], (
            "Two identical runs produced different output — non-deterministic behavior detected"
        )
    finally:
        topo.HOME = old_home
        topo.run = old_run
        sys.argv = old_argv


def test_cli_entrypoint_emits_valid_json():
    """e2e: covers the `if __name__ == "__main__"` entrypoint.
    Runs the probe as a real subprocess and asserts the output is valid JSON
    with the expected schema field.
    """
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH)],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, f"probe exited {proc.returncode}: {proc.stderr[:200]}"
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-opencode-topology"
    assert "schema_version" in report
    assert "version" in report


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} OpenCode topology tests passed")
