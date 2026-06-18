#!/usr/bin/env python3
"""Tests for codex_hook_dual_path_probe metadata-only drift detection."""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from codex_hook_dual_path_probe import build_report  # noqa: E402


def write_fixture(root: Path) -> tuple[Path, Path]:
    config = root / "config.toml"
    hooks_json = root / "hooks.json"
    config.write_text(
        """
[hooks]
SessionStart = [
  { matcher = "startup|resume", hooks = [
    { type = "command", command = "python3.12 \\"/private/secret/hooks/validate-settings-schema.py\\"", timeout = 10, statusMessage = "secret status text" },
  ] },
]
PreToolUse = [
  { matcher = "^mcp__pinecone__.*", hooks = [
    { type = "command", command = "/private/secret/new/principal-mind-guard.py" },
  ] },
  { matcher = "Edit|Write|apply_patch", hooks = [
    { type = "command", command = "python3.12 \\"/private/secret/hooks/validate-settings-schema.py\\"" },
  ] },
]

[hooks.state]
""",
        encoding="utf-8",
    )
    config.write_text(
        config.read_text(encoding="utf-8")
        + f'"{config}:session_start:0:0" = {{ trusted_hash = "sha256:aaaabbbbccccdddd" }}\n'
        + f'"{config}:pre_tool_use:0:0" = {{ trusted_hash = "sha256:eeeeffffgggghhhh" }}\n',
        encoding="utf-8",
    )
    hooks_json.write_text(
        json.dumps(
            [
                {
                    "type": "PreToolUse",
                    "matcher": "^mcp__pinecone__.*",
                    "hooks": [
                        {"command": "/private/secret/old/principal-mind-guard.py"}
                    ],
                }
            ]
        ),
        encoding="utf-8",
    )
    return config, hooks_json


def test_codex_hook_dual_path_detects_static_drift_without_raw_commands():
    tmp = Path(tempfile.mkdtemp(prefix="codex-hook-probe-test-"))
    config, hooks_json = write_fixture(tmp)
    report = build_report(config, hooks_json)
    rendered = json.dumps(report, sort_keys=True)
    assert report["config_toml"]["hook_command_count"] == 3, report
    assert report["hooks_json"]["hook_command_count"] == 1, report
    assert report["comparison"]["legacy_is_subset_by_matcher"] is True, report
    assert report["comparison"]["legacy_is_subset_by_command_path"] is False, report
    assert report["comparison"]["same_matcher_different_command_path"] is True, report
    assert report["comparison"]["config_only_matchers"] == ["Edit|Write|apply_patch", "startup|resume"], report
    assert report["comparison"]["missing_config_trusted_state_count"] == 1, report
    assert report["verdict"] == "static-drift-detected-runtime-unproven", report
    assert "/private/secret/new/principal-mind-guard.py" not in rendered, report
    assert "/private/secret/old/principal-mind-guard.py" not in rendered, report
    assert "secret status text" not in rendered, report
    assert "sha256:aaaabbbbccccdddd" not in rendered, report


def test_codex_hook_dual_path_reports_runtime_as_unproven():
    tmp = Path(tempfile.mkdtemp(prefix="codex-hook-probe-test-"))
    config, hooks_json = write_fixture(tmp)
    report = build_report(config, hooks_json)
    assert report["proof_class"] == "static-local-config", report
    assert report["comparison"]["runtime_invocation_proof"] == "not_probed", report
    assert "does not execute hooks" in report["limitations"], report


def test_codex_hook_dual_path_marks_malformed_sources_as_errors():
    tmp = Path(tempfile.mkdtemp(prefix="codex-hook-probe-test-"))
    config = tmp / "config.toml"
    hooks_json = tmp / "hooks.json"
    config.write_text("[broken", encoding="utf-8")
    hooks_json.write_text("{bad", encoding="utf-8")

    report = build_report(config, hooks_json)

    assert report["config_toml"]["parse_status"] == "error", report["config_toml"]
    assert report["config_toml"]["error_type"] == "TOMLDecodeError", report["config_toml"]
    assert report["config_toml"]["hook_command_count"] == 0, report["config_toml"]
    assert report["hooks_json"]["parse_status"] == "error", report["hooks_json"]
    assert report["hooks_json"]["error_type"] == "JSONDecodeError", report["hooks_json"]
    assert report["hooks_json"]["hook_command_count"] == 0, report["hooks_json"]


def test_command_identity_missing_command_returns_nonexistent_record():
    """UNHAPPY_TEST_TERMS: missing command yields command_present=False identity block."""
    from codex_hook_dual_path_probe import command_identity
    result = command_identity(None)
    assert result["command_present"] is False, result
    assert result["command_sha256_16"] is None, result
    assert result["executable_basename"] is None, result
    assert result["script_or_path_basename"] is None, result
    assert result["script_or_path_sha256_16"] is None, result
    assert result["argv_count"] == 0, result


def test_command_identity_empty_string_command_is_missing():
    """UNHAPPY_TEST_TERMS: empty string is treated the same as missing command."""
    from codex_hook_dual_path_probe import command_identity
    result = command_identity("")
    assert result["command_present"] is False, result
    assert result["argv_count"] == 0, result


def test_normalize_config_entries_invalid_nondict_config_returns_empty():
    """UNHAPPY_TEST_TERMS: invalid config (non-dict) produces empty entries and zero trusted state."""
    from codex_hook_dual_path_probe import normalize_config_entries
    from pathlib import Path
    entries, trusted = normalize_config_entries("not-a-dict", Path("/fake/config.toml"))
    assert entries == [], entries
    assert trusted["trusted_state_count"] == 0, trusted
    assert trusted["trusted_state_entry_hashes"] == [], trusted


def test_normalize_config_entries_nonlist_hook_group_is_skipped():
    """UNHAPPY_TEST_TERMS: malformed hooks dict where event maps to non-list is skipped."""
    from codex_hook_dual_path_probe import normalize_config_entries
    from pathlib import Path
    config = {"hooks": {"SessionStart": "not-a-list", "PreToolUse": []}}
    entries, trusted = normalize_config_entries(config, Path("/fake/config.toml"))
    assert entries == [], entries


def test_normalize_config_entries_nondict_group_entry_is_skipped():
    """UNHAPPY_TEST_TERMS: malformed group (non-dict) inside hook list is skipped gracefully."""
    from codex_hook_dual_path_probe import normalize_config_entries
    from pathlib import Path
    config = {"hooks": {"PreToolUse": ["not-a-dict-group"]}}
    entries, trusted = normalize_config_entries(config, Path("/fake/config.toml"))
    assert entries == [], entries


def test_normalize_config_entries_nonstring_command_yields_missing_identity():
    """UNHAPPY_TEST_TERMS: hook with nonstring command field produces command_present=False."""
    from codex_hook_dual_path_probe import normalize_config_entries
    from pathlib import Path
    config = {
        "hooks": {
            "PreToolUse": [
                {"matcher": ".*", "hooks": [{"type": "command", "command": 42}]}
            ]
        }
    }
    entries, _ = normalize_config_entries(config, Path("/fake/config.toml"))
    assert len(entries) == 1, entries
    assert entries[0]["identity"]["command_present"] is False, entries[0]


def test_normalize_legacy_entries_inline_command_field_is_expanded():
    """UNHAPPY_TEST_TERMS: legacy group with top-level command (no hooks array) is normalized."""
    from codex_hook_dual_path_probe import normalize_legacy_entries
    # Synthetic data — no real paths or executable names exposed
    data = [
        {
            "type": "PreToolUse",
            "matcher": "^synthetic__matcher__.*",
            "command": "/synthetic/path/to/runner.py",
        }
    ]
    entries = normalize_legacy_entries(data)
    assert len(entries) == 1, entries
    assert entries[0]["matcher"] == "^synthetic__matcher__.*", entries[0]
    assert entries[0]["identity"]["command_present"] is True, entries[0]


def test_normalize_legacy_entries_nondict_group_is_skipped():
    """UNHAPPY_TEST_TERMS: non-dict top-level entry in legacy list is skipped."""
    from codex_hook_dual_path_probe import normalize_legacy_entries
    entries = normalize_legacy_entries(["not-a-dict", None, 42])
    assert entries == [], entries


def test_normalize_legacy_entries_nondict_hook_in_hooks_array_is_skipped():
    """UNHAPPY_TEST_TERMS: non-dict element inside hooks array is skipped."""
    from codex_hook_dual_path_probe import normalize_legacy_entries
    data = [
        {
            "type": "PreToolUse",
            "matcher": "synthetic",
            "hooks": ["not-a-dict-hook", None],
        }
    ]
    entries = normalize_legacy_entries(data)
    assert entries == [], entries


def test_config_parse_status_missing_returns_missing_parse_status():
    """UNHAPPY_TEST_TERMS: None config value maps to parse_status='missing'."""
    from codex_hook_dual_path_probe import config_parse_status
    result = config_parse_status(None)
    assert result["parse_status"] == "missing", result
    assert result["error_type"] is None, result


def test_config_parse_status_invalid_shape_returns_error_type_name():
    """UNHAPPY_TEST_TERMS: non-dict non-error value is reported as invalid_shape."""
    from codex_hook_dual_path_probe import config_parse_status
    result = config_parse_status([1, 2, 3])
    assert result["parse_status"] == "invalid_shape", result
    assert result["error_type"] == "list", result


def test_hooks_json_parse_status_missing_returns_missing():
    """UNHAPPY_TEST_TERMS: None legacy value maps to parse_status='missing'."""
    from codex_hook_dual_path_probe import hooks_json_parse_status
    result = hooks_json_parse_status(None)
    assert result["parse_status"] == "missing", result
    assert result["error_type"] is None, result


def test_hooks_json_parse_status_invalid_shape_for_dict_without_error_key():
    """UNHAPPY_TEST_TERMS: dict without '_error' key is invalid_shape for hooks.json."""
    from codex_hook_dual_path_probe import hooks_json_parse_status
    result = hooks_json_parse_status({"no_error_key": True})
    assert result["parse_status"] == "invalid_shape", result
    assert result["error_type"] == "dict", result


def test_build_report_missing_config_and_hooks_json_returns_missing_parse_status():
    """UNHAPPY_TEST_TERMS: missing config.toml and hooks.json yield parse_status='missing' for both."""
    import tempfile
    from pathlib import Path
    from codex_hook_dual_path_probe import build_report
    tmp = Path(tempfile.mkdtemp(prefix="codex-hook-probe-missing-"))
    report = build_report(tmp / "config.toml", tmp / "hooks.json")
    assert report["config_toml"]["parse_status"] == "missing", report["config_toml"]
    assert report["config_toml"]["hook_command_count"] == 0, report["config_toml"]
    assert report["hooks_json"]["parse_status"] == "missing", report["hooks_json"]
    assert report["hooks_json"]["hook_command_count"] == 0, report["hooks_json"]
    assert report["verdict"] == "static-dual-path-reconciled-runtime-unproven", report["verdict"]


def test_build_report_determinism_same_fixture_produces_identical_output():
    """Determinism test: identical inputs produce bit-for-bit identical JSON output."""
    import tempfile
    from pathlib import Path
    tmp = Path(tempfile.mkdtemp(prefix="codex-hook-probe-determinism-"))
    config, hooks_json = write_fixture(tmp)
    from codex_hook_dual_path_probe import build_report
    report_a = json.dumps(build_report(config, hooks_json), sort_keys=True)
    report_b = json.dumps(build_report(config, hooks_json), sort_keys=True)
    assert report_a == report_b, "build_report is non-deterministic"


def test_cli_e2e_subprocess_exits_zero_with_json_schema():
    """CLI e2e: running the probe as a subprocess exits 0 and emits valid JSON with expected schema."""
    import subprocess
    import tempfile
    from pathlib import Path
    tmp = Path(tempfile.mkdtemp(prefix="codex-hook-probe-cli-"))
    config, hooks_json = write_fixture(tmp)
    probe_path = Path(__file__).resolve().parent.parent / "codex_hook_dual_path_probe.py"
    result = subprocess.run(
        [sys.executable, str(probe_path), "--config", str(config), "--hooks-json", str(hooks_json)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, f"probe exited {result.returncode}; stderr={result.stderr!r}"
    report = json.loads(result.stdout)
    assert report["schema"] == "agent-runtime-codex-hook-dual-path", report
    assert report["proof_class"] == "static-local-config", report
    assert "comparison" in report, report
    assert "verdict" in report, report
    # Confirm raw command strings are not leaked into CLI output
    assert "/private/secret" not in result.stdout, "raw command path leaked to stdout"


def test_cli_e2e_pretty_flag_produces_indented_json():
    """CLI e2e: --pretty flag produces indented (multi-line) JSON output and exits 0."""
    import subprocess
    import tempfile
    from pathlib import Path
    tmp = Path(tempfile.mkdtemp(prefix="codex-hook-probe-cli-pretty-"))
    config, hooks_json = write_fixture(tmp)
    probe_path = Path(__file__).resolve().parent.parent / "codex_hook_dual_path_probe.py"
    result = subprocess.run(
        [sys.executable, str(probe_path), "--config", str(config), "--hooks-json", str(hooks_json), "--pretty"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, f"probe exited {result.returncode}; stderr={result.stderr!r}"
    assert "\n" in result.stdout and "  " in result.stdout, "expected indented JSON from --pretty"
    report = json.loads(result.stdout)
    assert report["schema"] == "agent-runtime-codex-hook-dual-path", report


def test_split_command_malformed_unclosed_quote_falls_back_to_split():
    """UNHAPPY_TEST_TERMS: malformed command with unclosed quote triggers ValueError fallback."""
    from codex_hook_dual_path_probe import split_command
    # shlex.split raises ValueError on unclosed quote; split_command must fall back to str.split
    malformed = 'python3 "unclosed'
    parts = split_command(malformed)
    assert isinstance(parts, list), parts
    assert len(parts) >= 1, parts
    # No raw secret content — just structural check
    assert parts[0] == "python3", parts


def test_normalize_config_entries_nondict_hook_inside_hooks_array_is_skipped():
    """UNHAPPY_TEST_TERMS: non-dict element in hooks array of a config group is skipped."""
    from codex_hook_dual_path_probe import normalize_config_entries
    # Group has valid dict structure but hooks array contains non-dict entries
    config = {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "synthetic-matcher",
                    "hooks": ["not-a-dict-hook", None, 99],
                }
            ]
        }
    }
    entries, _ = normalize_config_entries(config, Path("/fake/config.toml"))
    # All non-dict hooks must be skipped — entries should be empty
    assert entries == [], entries


def test_main_function_emits_json_to_stdout_and_returns_zero():
    """UNHAPPY_TEST_TERMS: main() called in-process with missing default files returns 0 and valid JSON."""
    import io
    import tempfile
    from contextlib import redirect_stdout
    import codex_hook_dual_path_probe as probe_mod
    tmp = Path(tempfile.mkdtemp(prefix="codex-hook-probe-main-"))
    # Monkey-patch the defaults to point at a temp dir where files don't exist
    orig_config = probe_mod.DEFAULT_CONFIG_TOML
    orig_hooks = probe_mod.DEFAULT_HOOKS_JSON
    probe_mod.DEFAULT_CONFIG_TOML = tmp / "config.toml"
    probe_mod.DEFAULT_HOOKS_JSON = tmp / "hooks.json"
    buf = io.StringIO()
    try:
        old_argv = sys.argv
        sys.argv = [sys.argv[0]]
        with redirect_stdout(buf):
            rc = probe_mod.main()
        sys.argv = old_argv
    finally:
        probe_mod.DEFAULT_CONFIG_TOML = orig_config
        probe_mod.DEFAULT_HOOKS_JSON = orig_hooks
    assert rc == 0, f"main() returned {rc}"
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-codex-hook-dual-path", report
    assert report["config_toml"]["parse_status"] == "missing", report["config_toml"]
    assert report["hooks_json"]["parse_status"] == "missing", report["hooks_json"]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} Codex hook dual-path tests passed")
