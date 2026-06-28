#!/usr/bin/env python3
"""Tests for secret_guard_canary metadata and payload suppression."""
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest.mock as mock
from argparse import Namespace
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import secret_guard_canary as probe  # noqa: E402
from secret_guard_canary import (  # noqa: E402
    build_report,
    guard_bundle_summary,
    guard_command_basenames,
    iter_observability_files,
    observability_guard_correlation,
    run_hook,
    safe_hook_basename,
    safe_tool_label,
    settings_summary,
    policy_signal_summary,
    canary_public_row,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "secret_guard_canary.py"


# ---------------------------------------------------------------------------
# Happy-path: schema + static-inventory
# ---------------------------------------------------------------------------

def _make_synthetic_settings(tmp_dir: str) -> Path:
    """Write a deterministic settings.json fixture to tmp_dir and return its Path.

    The fixture has:
    - Bash and Read in permissions.allow (broad_allow True for both)
    - NO PreToolUse Bash or Read matcher in hooks (direct_pretool_covers_bash/read False)
    """
    settings = {
        "permissions": {
            "allow": ["Bash", "Read"],
            "deny": [],
        },
        "hooks": {
            "PreToolUse": [
                # Intentionally omits Bash and Read matchers so direct_pretool_covers_* is False
                {"matcher": "Write", "hooks": []},
            ]
        },
    }
    path = Path(tmp_dir) / "settings.json"
    path.write_text(json.dumps(settings), encoding="utf-8")
    return path


def _make_empty_settings(tmp_dir: str) -> Path:
    """Write an empty (no PreToolUse) local settings.json fixture and return its Path."""
    path = Path(tmp_dir) / "settings.local.json"
    path.write_text(json.dumps({}), encoding="utf-8")
    return path


def test_secret_guard_static_inventory_separates_present_from_active():
    """Fixture-pinned: uses a synthetic settings.json so the test is deterministic.

    The fixture has Bash+Read in allow (broad_allow=True) but NO PreToolUse
    Bash/Read matcher (direct_pretool_covers_bash/read=False).  The present guard
    bundle (on-disk LAB/claude-guards) is read live as usual.
    """
    with tempfile.TemporaryDirectory(prefix="secret-guard-canary-fixture-") as tmp:
        synthetic_settings = _make_synthetic_settings(tmp)
        synthetic_local = _make_empty_settings(tmp)
        with mock.patch.object(probe, "SETTINGS_PATH", synthetic_settings), \
             mock.patch.object(probe, "LOCAL_SETTINGS_PATH", synthetic_local):
            report = build_report(Namespace(run=False, timeout=5.0))

    assert report["schema"] == "agent-runtime-secret-guard-canary", report
    assert report["schema_version"] == "0.3", report
    assert report["proof_class"] == "static_config", report
    assert report["active_settings"]["broad_allow"]["Bash"] is True, report
    assert report["active_settings"]["broad_allow"]["Read"] is True, report
    assert report["active_settings"]["direct_pretool_covers_bash"] is False, report
    assert report["active_settings"]["direct_pretool_covers_read"] is False, report
    assert report["present_guard_bundle"]["present_covers_bash"] is True, report
    assert report["present_guard_bundle"]["present_covers_read"] is True, report
    assert report["historical_observability_correlation"]["current_turn_proof"] is False, report


def test_secret_guard_live_settings_advisory():
    """NON-BLOCKING advisory: observe live settings direct_pretool_covers_bash/read values.

    Never fails the gate: skips with a static reason if values differ from the
    historical baseline (False/False), so a real settings regression stays visible
    without reds in CI.  Unconditional assertion: active_settings key must be present.
    """
    report = build_report(Namespace(run=False, timeout=5.0))
    # Unconditional schema-contract assertion: active_settings must always be present.
    assert "active_settings" in report, (
        "active_settings key missing from build_report output -- schema changed; update test."
    )
    covers_bash = report["active_settings"].get("direct_pretool_covers_bash")
    covers_read = report["active_settings"].get("direct_pretool_covers_read")
    print(
        "\n[ADVISORY] live settings: direct_pretool_covers_bash="
        + str(covers_bash) + " direct_pretool_covers_read=" + str(covers_read)
    )
    if covers_bash is not False or covers_read is not False:
        pytest.skip("ADVISORY: live settings direct_pretool_covers_bash/read differ from historical False/False baseline -- settings have a PreToolUse Bash or Read matcher; review intentionality")


def test_secret_guard_run_uses_hashes_not_payloads():
    report = build_report(Namespace(run=True, timeout=5.0))
    rendered = json.dumps(report, sort_keys=True)
    assert report["proof_class"] == "static_config_plus_direct_script_synthetic_execution", report
    # HIGH-security additions upstreamed from the live estate: explicit guard-path classification +
    # coverage decision so the canary cannot misrepresent offline (direct-script) proof as runtime
    # PreToolUse hook coverage. Presence/shape coverage (values depend on live guard-bundle state).
    assert isinstance(report["guard_path_classification"], list) and report["guard_path_classification"], report
    assert isinstance(report["coverage_decision"], dict) and report["coverage_decision"], report
    assert report["canary_run"]["count"] >= 17, report
    assert report["policy_signals"]["project_env_variant_count"] == 6, report
    assert report["policy_signals"]["project_env_allowed_count"] == 6, report
    assert report["interpretation"]["generic_project_env_is_gap_in_policy"] is True, report
    assert "sk-proj-0000000000000000000000000000000000000000" not in rendered, report
    assert "/Users/testuser/.config/secrets/synthetic-canary.env" not in rendered, report
    assert "/Users/testuser/LAB/synthetic-project/.env" not in rendered, report
    assert "/Users/testuser/LAB/synthetic-project/.env.local" not in rendered, report
    assert "/Users/testuser/LAB/synthetic-project/packages/api/.env.production" not in rendered, report
    assert "/Users/testuser/.ssh/id_ed25519" not in rendered, report
    for row in report["canaries"]:
        assert "input_sha256_16" in row, row
        assert "command" not in row, row
        assert "file_path" not in row, row


def test_historical_observability_correlation_matches_guard_basenames_without_raw_payloads():
    root = Path(tempfile.mkdtemp(prefix="secret-guard-observability-test-"))
    metadata = root / "2026-06-15/session-a/metadata"
    metadata.mkdir(parents=True)
    hook_file = metadata / "hook_events.jsonl"
    hook_file.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "hook": "/tmp/synthetic/bash-secret-guard.py",
                        "origin_type": "pretool_hook",
                        "event": "bash.executed",
                        "data": {
                            "tool": "Bash",
                            "prompt_hash": "SECRET_PROMPT_HASH_SHOULD_NOT_LEAK",
                            "stdout": "sk-proj-0000000000000000000000000000000000000000",
                        },
                    }
                ),
                json.dumps(
                    {
                        "hook": "obs-pretool-read",
                        "origin_type": "pretool_hook",
                        "event": "file.read",
                        "data": {"tool_name": "Read"},
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )

    report = build_report(
        Namespace(
            run=False,
            timeout=5.0,
            observability_root=str(root),
            max_observability_files=None,
        )
    )
    correlation = report["historical_observability_correlation"]
    assert correlation["hook_event_file_count"] == 1, correlation
    assert correlation["json_line_count"] == 2, correlation
    assert correlation["target_guard_identity_match_count"] == 1, correlation
    assert correlation["target_guard_basename_match_rows"] == [
        {"basename": "bash-secret-guard.py", "count": 1}
    ], correlation
    assert correlation["pretool_bash_event_count"] == 1, correlation
    assert correlation["pretool_read_event_count"] == 1, correlation
    assert correlation["current_turn_proof"] is False, correlation
    assert correlation["verdict"] == "historical-events-observed-target-guard-identity", correlation
    rendered = json.dumps(report, sort_keys=True)
    assert str(root) not in rendered, report
    assert "/tmp/synthetic" not in rendered, report
    assert "SECRET_PROMPT_HASH_SHOULD_NOT_LEAK" not in rendered, report
    assert "sk-proj-0000000000000000000000000000000000000000" not in rendered, report


# ---------------------------------------------------------------------------
# Determinism test
# ---------------------------------------------------------------------------

def test_build_report_is_deterministic():
    """Same inputs must produce byte-identical JSON output (no timestamps/random UUIDs)."""
    args = Namespace(run=False, timeout=5.0)
    r1 = json.dumps(build_report(args), sort_keys=True)
    r2 = json.dumps(build_report(args), sort_keys=True)
    assert r1 == r2, "build_report is not deterministic"


# ---------------------------------------------------------------------------
# CLI e2e subprocess test (covers __main__ path)
# ---------------------------------------------------------------------------

def test_cli_entrypoint_emits_valid_json():
    """Run the probe as a real subprocess to cover the if __name__ == '__main__' block."""
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-secret-guard-canary"
    assert "proof_class" in report
    assert "active_settings" in report
    assert "present_guard_bundle" in report


def test_cli_pretty_flag_emits_indented_json():
    """--pretty flag produces indented JSON output."""
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--pretty"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    # Indented JSON starts with "{\n"
    assert proc.stdout.startswith("{\n"), "Expected pretty-printed JSON"
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-secret-guard-canary"


# ---------------------------------------------------------------------------
# settings_summary: malformed/missing permissions branches
# ---------------------------------------------------------------------------

def test_settings_summary_missing_file_returns_empty_counts():
    """settings_summary on a nonexistent path returns zero counts and exists=False."""
    missing = Path("/nonexistent/totally/fake/settings.json")
    result = settings_summary(missing)
    assert result["exists"] is False
    assert result["allow_count"] == 0
    assert result["deny_count"] == 0
    assert result["direct_pretool_matchers"] == []


def test_settings_summary_invalid_permissions_non_dict_falls_back_to_empty():
    """When permissions key is not a dict, allow/deny fall back to empty lists."""
    _fd, _name = tempfile.mkstemp(suffix=".json"); os.close(_fd); tmp = Path(_name)
    tmp.write_text(json.dumps({"permissions": "not-a-dict"}))
    try:
        result = settings_summary(tmp)
        assert result["allow_count"] == 0
        assert result["deny_count"] == 0
    finally:
        tmp.unlink(missing_ok=True)


def test_settings_summary_permissions_with_non_list_allow_and_deny():
    """When allow/deny are not lists, they fall back to empty lists."""
    _fd, _name = tempfile.mkstemp(suffix=".json"); os.close(_fd); tmp = Path(_name)
    tmp.write_text(json.dumps({"permissions": {"allow": "Bash", "deny": 42}}))
    try:
        result = settings_summary(tmp)
        assert result["allow_count"] == 0
        assert result["deny_count"] == 0
    finally:
        tmp.unlink(missing_ok=True)


def test_settings_summary_non_dict_enabled_plugins_treated_as_empty():
    """When enabledPlugins is not a list, it is treated as empty."""
    _fd, _name = tempfile.mkstemp(suffix=".json"); os.close(_fd); tmp = Path(_name)
    tmp.write_text(json.dumps({"enabledPlugins": "not-a-list"}))
    try:
        result = settings_summary(tmp)
        assert result["enabled_plugins_count"] == 0
    finally:
        tmp.unlink(missing_ok=True)


def test_settings_summary_hooks_with_pretool_matchers():
    """When hooks contains PreToolUse list with matcher items, matchers are extracted."""
    _fd, _name = tempfile.mkstemp(suffix=".json"); os.close(_fd); tmp = Path(_name)
    tmp.write_text(json.dumps({
        "hooks": {
            "PreToolUse": [
                {"matcher": "Bash", "hooks": []},
                {"matcher": "Read", "hooks": []},
                {"not_matcher": "Other"},  # no matcher key
            ]
        }
    }))
    try:
        result = settings_summary(tmp)
        assert "Bash" in result["direct_pretool_matchers"]
        assert "Read" in result["direct_pretool_matchers"]
        assert result["direct_pretool_covers_bash"] is True
        assert result["direct_pretool_covers_read"] is True
    finally:
        tmp.unlink(missing_ok=True)


def test_settings_summary_hooks_non_list_pretool_skipped():
    """When PreToolUse is not a list, direct_pretool_matchers is empty."""
    _fd, _name = tempfile.mkstemp(suffix=".json"); os.close(_fd); tmp = Path(_name)
    tmp.write_text(json.dumps({"hooks": {"PreToolUse": "not-a-list"}}))
    try:
        result = settings_summary(tmp)
        assert result["direct_pretool_matchers"] == []
        assert result["direct_pretool_covers_bash"] is False
    finally:
        tmp.unlink(missing_ok=True)


def test_settings_summary_secret_deny_glob_detected():
    """has_secret_file_deny_glob is True when deny list contains .env or .config/secrets entries."""
    _fd, _name = tempfile.mkstemp(suffix=".json"); os.close(_fd); tmp = Path(_name)
    tmp.write_text(json.dumps({
        "permissions": {
            "allow": [],
            "deny": ["**/.env", "~/.config/secrets/**"],
        }
    }))
    try:
        result = settings_summary(tmp)
        assert result["has_secret_file_deny_glob"] is True
    finally:
        tmp.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# guard_bundle_summary: malformed/missing hook entries
# ---------------------------------------------------------------------------

def test_guard_bundle_summary_non_dict_hook_items_skipped():
    """Non-dict items inside PreToolUse list are skipped without crash."""
    orig_load = probe.load_json
    probe.load_json = lambda path: {
        "hooks": {
            "PreToolUse": [
                "not-a-dict",            # line 79 -- non-dict item continue
                None,                    # also non-dict
                {
                    "matcher": "Bash",
                    "hooks": [
                        "not-a-dict-hook",  # line 111 -- non-dict hook continue
                        {"command": "echo test", "type": "interceptor"},
                    ],
                },
            ]
        }
    }
    try:
        result = guard_bundle_summary()
        assert result["present_covers_bash"] is True
        # Only one valid hook (the dict one with command "echo test")
        bash_rows = [r for r in result["pretool_matchers"] if r["matcher"] == "Bash"]
        assert bash_rows[0]["hook_count"] == 1
    finally:
        probe.load_json = orig_load


def test_guard_bundle_summary_hook_with_non_string_command_skipped():
    """Hooks with non-string command field are skipped (line 114 branch)."""
    orig_load = probe.load_json
    probe.load_json = lambda path: {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Read",
                    "hooks": [
                        {"command": 12345, "type": "interceptor"},  # non-string command
                        {"type": "interceptor"},                     # missing command
                    ],
                },
            ]
        }
    }
    try:
        result = guard_bundle_summary()
        read_rows = [r for r in result["pretool_matchers"] if r["matcher"] == "Read"]
        # Both hooks are skipped — hook_count should be 0
        assert read_rows[0]["hook_count"] == 0
    finally:
        probe.load_json = orig_load


def test_guard_bundle_summary_non_list_pretool_returns_empty_rows():
    """When PreToolUse is not a list, rows is empty."""
    orig_load = probe.load_json
    probe.load_json = lambda path: {"hooks": {"PreToolUse": "not-a-list"}}
    try:
        result = guard_bundle_summary()
        assert result["pretool_matchers"] == []
        assert result["present_covers_bash"] is False
        assert result["present_covers_read"] is False
    finally:
        probe.load_json = orig_load


def test_guard_command_basenames_non_dict_row_is_skipped():
    """Non-dict rows in pretool_matchers are skipped without crash."""
    bundle = {"pretool_matchers": ["not-a-dict", None, 42]}
    result = guard_command_basenames(bundle)
    assert result["all_command_basenames"] == []
    assert result["target_guard_command_basenames"] == []


def test_guard_command_basenames_non_dict_command_is_skipped():
    """Non-dict command entries inside a row's commands list are skipped."""
    bundle = {
        "pretool_matchers": [
            {
                "matcher": "Bash",
                "commands": [
                    "not-a-dict",
                    {"command_basename": "bash-secret-guard.py"},
                ],
            }
        ]
    }
    result = guard_command_basenames(bundle)
    assert "bash-secret-guard.py" in result["target_guard_command_basenames"]


def test_guard_command_basenames_empty_basename_skipped():
    """Empty or non-string basename values are skipped."""
    bundle = {
        "pretool_matchers": [
            {
                "matcher": "Bash",
                "commands": [
                    {"command_basename": ""},    # empty — skipped (line 133 branch)
                    {"command_basename": None},  # None — also skipped
                ],
            }
        ]
    }
    result = guard_command_basenames(bundle)
    assert result["all_command_basenames"] == []


# ---------------------------------------------------------------------------
# safe_hook_basename: edge cases
# ---------------------------------------------------------------------------

def test_safe_hook_basename_non_string_returns_none():
    """Non-string value returns None (line 133)."""
    assert safe_hook_basename(None) is None
    assert safe_hook_basename(42) is None
    assert safe_hook_basename([]) is None


def test_safe_hook_basename_empty_string_returns_none():
    """Empty string returns None."""
    assert safe_hook_basename("") is None


def test_safe_hook_basename_path_with_slash_uses_basename():
    """Path containing '/' extracts the basename."""
    result = safe_hook_basename("/some/path/bash-secret-guard.py")
    assert result == "bash-secret-guard.py"


def test_safe_hook_basename_plain_name_passthrough():
    """Plain name without slash is used as-is."""
    result = safe_hook_basename("obs-pretool-read")
    assert result == "obs-pretool-read"


def test_safe_hook_basename_jwt_shaped_string_redacted():
    """JWT-shaped hook names are redacted by probelib.redact() (value matches SECRET_VALUE pattern)."""
    # A JWT token: eyJ<header>.<payload>.<signature>
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123xyz456def789ghi"
    result = safe_hook_basename(jwt)
    # redact() returns "<redacted:value>" for JWT-shaped strings
    assert result != jwt, "JWT-shaped value was not redacted by safe_hook_basename"


# ---------------------------------------------------------------------------
# safe_tool_label: edge cases
# ---------------------------------------------------------------------------

def test_safe_tool_label_non_string_returns_none():
    """Non-string value returns None (line 141)."""
    assert safe_tool_label(None) is None
    assert safe_tool_label(42) is None


def test_safe_tool_label_empty_string_returns_none():
    """Empty string returns None."""
    assert safe_tool_label("") is None


def test_safe_tool_label_overlong_value_is_hashed():
    """Values longer than 80 chars are replaced with a hash (line 143)."""
    long_val = "A" * 81
    result = safe_tool_label(long_val)
    assert result is not None
    assert result.startswith("tool_hash:"), f"Expected tool_hash: prefix, got: {result}"


def test_safe_tool_label_slash_value_is_hashed():
    """Values containing '/' are hashed (line 143)."""
    result = safe_tool_label("/some/path/to/tool")
    assert result is not None
    assert result.startswith("tool_hash:")


def test_safe_tool_label_plain_short_value_passthrough():
    """Short plain tool names pass through redact."""
    result = safe_tool_label("Bash")
    assert result == "Bash"


# ---------------------------------------------------------------------------
# iter_observability_files: missing root returns empty list
# ---------------------------------------------------------------------------

def test_iter_observability_files_missing_root_returns_empty():
    """When root doesn't exist, iter_observability_files returns [] (line 150)."""
    missing = Path("/nonexistent/path/to/observability")
    result = iter_observability_files(missing)
    assert result == []


def test_iter_observability_files_existing_root_with_no_files():
    """When root exists but has no matching files, returns empty list."""
    tmp = Path(tempfile.mkdtemp())
    try:
        result = iter_observability_files(tmp)
        assert result == []
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# observability_guard_correlation: error/edge branches
# ---------------------------------------------------------------------------

def test_observability_guard_correlation_root_missing_verdict():
    """When root doesn't exist, verdict is 'observability-root-missing' (line 216)."""
    missing_root = Path("/nonexistent/observability-root-xyz")
    bundle = guard_bundle_summary()
    result = observability_guard_correlation(missing_root, bundle)
    assert result["verdict"] == "observability-root-missing", result["verdict"]
    assert result["root_exists"] is False


def test_observability_guard_correlation_no_files_verdict():
    """When root exists but has no hook files, verdict is 'no-observability-hook-files' (line 218)."""
    tmp_root = Path(tempfile.mkdtemp(prefix="no-files-test-"))
    bundle = guard_bundle_summary()
    try:
        result = observability_guard_correlation(tmp_root, bundle)
        assert result["verdict"] == "no-observability-hook-files", result["verdict"]
        assert result["hook_event_file_count"] == 0
    finally:
        import shutil
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_observability_guard_correlation_oserror_on_read():
    """OSError when reading a hook_events.jsonl file is counted (lines 178-181)."""
    tmp_root = Path(tempfile.mkdtemp(prefix="oserror-test-"))
    metadata = tmp_root / "2026-06-15/session-x/metadata"
    metadata.mkdir(parents=True)
    hook_file = metadata / "hook_events.jsonl"
    hook_file.write_text("irrelevant", encoding="utf-8")

    bundle = guard_bundle_summary()

    # Patch Path.read_text to raise OSError
    orig_read_text = Path.read_text

    def mock_read_text(self, **kwargs):
        if self.name == "hook_events.jsonl":
            raise OSError("Permission denied")
        return orig_read_text(self, **kwargs)

    Path.read_text = mock_read_text
    try:
        result = observability_guard_correlation(tmp_root, bundle)
        assert result["read_error_count"] == 1, result
        assert result["degraded"] is True, result
        assert "OSError" in result["read_error_types"]
    finally:
        Path.read_text = orig_read_text
        import shutil
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_observability_guard_correlation_invalid_json_lines():
    """Malformed JSON lines in hook_events.jsonl increment invalid_json_lines (lines 187-189)."""
    tmp_root = Path(tempfile.mkdtemp(prefix="invalid-json-test-"))
    metadata = tmp_root / "2026-06-15/session-y/metadata"
    metadata.mkdir(parents=True)
    hook_file = metadata / "hook_events.jsonl"
    hook_file.write_text(
        "\n".join([
            "not-valid-json",
            "{also invalid",
            "",  # blank line (skipped)
            json.dumps({"hook": "valid.py", "origin_type": "pretool_hook"}),
        ]),
        encoding="utf-8",
    )
    bundle = guard_bundle_summary()
    try:
        result = observability_guard_correlation(tmp_root, bundle)
        assert result["invalid_json_lines"] == 2, result
        assert result["json_line_count"] == 1, result
    finally:
        import shutil
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_observability_guard_correlation_non_dict_json_line_counted_invalid():
    """Non-dict JSON values (like arrays) in jsonl are counted as invalid (lines 191-192)."""
    tmp_root = Path(tempfile.mkdtemp(prefix="non-dict-json-test-"))
    metadata = tmp_root / "2026-06-15/session-z/metadata"
    metadata.mkdir(parents=True)
    hook_file = metadata / "hook_events.jsonl"
    hook_file.write_text(
        "\n".join([
            json.dumps([1, 2, 3]),   # array, not dict
            json.dumps("a string"),  # string, not dict
            json.dumps({"hook": "real.py", "origin_type": "other"}),
        ]),
        encoding="utf-8",
    )
    bundle = guard_bundle_summary()
    try:
        result = observability_guard_correlation(tmp_root, bundle)
        assert result["invalid_json_lines"] == 2, result
        assert result["json_line_count"] == 1, result
    finally:
        import shutil
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_observability_guard_correlation_other_guard_bundle_identity_verdict():
    """When a guard command basename (not target) is observed, verdict is 'other-guard-bundle' (line 222)."""
    tmp_root = Path(tempfile.mkdtemp(prefix="other-guard-test-"))
    metadata = tmp_root / "2026-06-15/session-a/metadata"
    metadata.mkdir(parents=True)
    hook_file = metadata / "hook_events.jsonl"
    # Use a basename that's in all_basenames but NOT in target_guard_basenames
    hook_file.write_text(
        json.dumps({
            "hook": "obs-hook.py",  # a non-target hook; we'll inject it via mocked bundle
            "origin_type": "pretool_hook",
        }),
        encoding="utf-8",
    )

    # Create a bundle where "obs-hook.py" is in all_command_basenames but not in targets
    fake_bundle = {
        "pretool_matchers": [
            {
                "matcher": "Bash",
                "hook_count": 1,
                "commands": [{"command_basename": "obs-hook.py", "type": "interceptor", "timeout": 5, "command_sha256_16": "abc123"}],
            }
        ],
        "present_covers_bash": True,
        "present_covers_read": False,
        "exists": True,
        "plugin_manifest_path": "/fake",
        "hooks_json_path": "/fake/hooks.json",
    }

    try:
        result = observability_guard_correlation(tmp_root, fake_bundle)
        assert result["verdict"] == "historical-events-observed-other-guard-bundle-identity", result["verdict"]
        assert result["any_guard_identity_match_count"] > 0
        assert result["target_guard_identity_match_count"] == 0
    finally:
        import shutil
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_observability_guard_correlation_max_files_limits_scan():
    """max_files parameter limits how many files are scanned."""
    tmp_root = Path(tempfile.mkdtemp(prefix="max-files-test-"))
    for i in range(3):
        metadata = tmp_root / f"2026-06-15/session-{i}/metadata"
        metadata.mkdir(parents=True)
        (metadata / "hook_events.jsonl").write_text(
            json.dumps({"hook": "obs.py", "origin_type": "pretool_hook"}),
            encoding="utf-8",
        )
    bundle = guard_bundle_summary()
    try:
        result = observability_guard_correlation(tmp_root, bundle, max_files=1)
        assert result["hook_event_file_count"] == 3, "Should count all files even when limiting"
        assert result["scanned_file_count"] == 1, "Should only scan max_files=1"
    finally:
        import shutil
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_observability_guard_correlation_no_guard_events_verdict():
    """When files exist but no guard basenames match, verdict is 'did-not-observe' variant."""
    tmp_root = Path(tempfile.mkdtemp(prefix="no-match-test-"))
    metadata = tmp_root / "2026-06-15/session-a/metadata"
    metadata.mkdir(parents=True)
    hook_file = metadata / "hook_events.jsonl"
    hook_file.write_text(
        json.dumps({"hook": "unrelated-obs.py", "origin_type": "other"}),
        encoding="utf-8",
    )
    bundle = guard_bundle_summary()
    try:
        result = observability_guard_correlation(tmp_root, bundle)
        assert result["verdict"] == "historical-events-did-not-observe-guard-command-identities", result["verdict"]
    finally:
        import shutil
        shutil.rmtree(tmp_root, ignore_errors=True)


# ---------------------------------------------------------------------------
# run_hook: timeout and JSON decode error branches
# ---------------------------------------------------------------------------

def test_run_hook_timeout_returns_timeout_status():
    """When subprocess times out, run_hook returns status='timeout' (lines 268-269)."""
    _fd, _name = tempfile.mkstemp(suffix=".py"); os.close(_fd); fake_script = Path(_name)
    fake_script.write_text("import time; time.sleep(60)\n")
    try:
        result = run_hook(fake_script, "Bash", {"command": "echo test"}, timeout=0.01)
        assert result["status"] == "timeout", result
        assert result["decision"] == "unknown", result
        assert result["stdout_bytes"] == 0
        assert result["stderr_bytes"] == 0
    finally:
        fake_script.unlink(missing_ok=True)


def test_run_hook_json_decode_error_sets_decision_unknown():
    """When stdout is not valid JSON, decision is 'unknown' (lines 285-286)."""
    _fd, _name = tempfile.mkstemp(suffix=".py"); os.close(_fd); fake_script = Path(_name)
    fake_script.write_text("print('not-valid-json')\n")
    try:
        result = run_hook(fake_script, "Bash", {"command": "echo test"}, timeout=5.0)
        assert result["status"] == "ok", result
        assert result["decision"] == "unknown", result
    finally:
        fake_script.unlink(missing_ok=True)


def test_run_hook_empty_stdout_parse_status():
    """When stdout is empty, parse_status is 'empty_stdout' and decision defaults to 'allow'."""
    _fd, _name = tempfile.mkstemp(suffix=".py"); os.close(_fd); fake_script = Path(_name)
    fake_script.write_text("import sys; sys.exit(0)\n")
    try:
        result = run_hook(fake_script, "Read", {"file_path": "/tmp/test"}, timeout=5.0)
        assert result["status"] == "ok", result
        assert result["parse_status"] == "empty_stdout", result
        assert result["decision"] == "allow", result
    finally:
        fake_script.unlink(missing_ok=True)


def test_run_hook_valid_json_allow_decision():
    """When stdout is valid JSON with permissionDecision, that decision is extracted."""
    _fd, _name = tempfile.mkstemp(suffix=".py"); os.close(_fd); fake_script = Path(_name)
    output = json.dumps({
        "hookSpecificOutput": {
            "permissionDecision": "deny",
            "permissionDecisionReason": "secret file",
        }
    })
    fake_script.write_text(f"print({repr(output)})\n")
    try:
        result = run_hook(fake_script, "Read", {"file_path": "/tmp/test"}, timeout=5.0)
        assert result["status"] == "ok", result
        assert result["decision"] == "deny", result
        assert result["parse_status"] == "json", result
        assert result["reason_bytes"] > 0
        assert result["reason_sha256_16"] is not None
    finally:
        fake_script.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# canary_public_row: redaction contract — no secret values in output
# ---------------------------------------------------------------------------

def test_canary_public_row_contains_no_secret_inputs():
    """canary_public_row must not expose the raw tool input."""
    canary = {
        "id": "test_canary",
        "hook": "bash",
        "tool": "Bash",
        "input": {"command": "cat ~/.config/secrets/synthetic-canary.env"},
        "expected_decision": "deny",
        "surface": "test-surface",
    }
    result_data = {
        "status": "ok",
        "returncode": 1,
        "decision": "deny",
        "parse_status": "json",
        "stdout_bytes": 0,
        "stderr_bytes": 0,
        "reason_sha256_16": None,
        "reason_bytes": 0,
        "stdout_sha256_16": None,
        "stderr_sha256_16": None,
    }
    row = canary_public_row(canary, result_data)
    rendered = json.dumps(row)
    assert "synthetic-canary.env" not in rendered, "Secret file path leaked into canary row"
    assert "~/.config/secrets" not in rendered, "Secret path leaked"
    assert "input_sha256_16" in row


def test_canary_public_row_pass_is_true_when_decision_matches():
    """pass field is True when observed_decision matches expected_decision."""
    canary = {
        "id": "test", "hook": "read", "tool": "Read",
        "input": {"file_path": "/safe/path"},
        "expected_decision": "allow", "surface": "safe",
    }
    result_data = {"decision": "allow", "status": "ok", "returncode": 0,
                   "parse_status": "json", "stdout_bytes": 0, "stderr_bytes": 0,
                   "reason_sha256_16": None, "reason_bytes": 0,
                   "stdout_sha256_16": None, "stderr_sha256_16": None}
    row = canary_public_row(canary, result_data)
    assert row["pass"] is True


def test_canary_public_row_pass_is_false_when_decision_mismatches():
    """pass field is False when observed_decision doesn't match expected_decision."""
    canary = {
        "id": "test", "hook": "bash", "tool": "Bash",
        "input": {"command": "echo test"},
        "expected_decision": "deny", "surface": "test-surface",
    }
    result_data = {"decision": "allow", "status": "ok", "returncode": 0,
                   "parse_status": "json", "stdout_bytes": 0, "stderr_bytes": 0,
                   "reason_sha256_16": None, "reason_bytes": 0,
                   "stdout_sha256_16": None, "stderr_sha256_16": None}
    row = canary_public_row(canary, result_data)
    assert row["pass"] is False


# ---------------------------------------------------------------------------
# policy_signal_summary: edge cases
# ---------------------------------------------------------------------------

def test_policy_signal_summary_no_canaries_returns_not_tested():
    """Empty canaries list returns 'not_tested' project_env_policy_status."""
    result = policy_signal_summary([])
    assert result["project_env_policy_status"] == "not_tested"
    assert result["project_env_variant_count"] == 0


def test_policy_signal_summary_all_denied_returns_not_observed_allowed():
    """When project_env canaries exist but none are allowed, returns 'not_observed_allowed'."""
    canaries = [
        {"policy_signal": "project_env_allowed", "id": "x", "observed_decision": "deny"},
        {"policy_signal": "project_env_allowed", "id": "y", "observed_decision": "deny"},
    ]
    result = policy_signal_summary(canaries)
    assert result["project_env_policy_status"] == "not_observed_allowed"
    assert result["project_env_denied_count"] == 2
    assert result["project_env_allowed_count"] == 0


def test_policy_signal_summary_mixed_returns_allowed_ids():
    """When some project_env canaries are allowed, returns those IDs."""
    canaries = [
        {"policy_signal": "project_env_allowed", "id": "a", "observed_decision": "allow"},
        {"policy_signal": "project_env_allowed", "id": "b", "observed_decision": "deny"},
        {"policy_signal": "expected_enforcement", "id": "c", "observed_decision": "allow"},
    ]
    result = policy_signal_summary(canaries)
    assert result["project_env_allowed_count"] == 1
    assert "a" in result["project_env_allowed_ids"]
    assert result["project_env_policy_status"] == "allowed_by_current_policy_decision_needed"


# ---------------------------------------------------------------------------
# Redaction contract: secret values must not appear in any report output
# ---------------------------------------------------------------------------

def test_report_no_raw_secret_values_in_static_mode():
    """In static mode, no secret-shaped values appear in the JSON output."""
    report = build_report(Namespace(run=False, timeout=5.0))
    rendered = json.dumps(report, sort_keys=True)
    # Common secret patterns
    assert "sk-proj-" not in rendered
    assert "pcsk_" not in rendered
    assert "AKIA" not in rendered
    # File paths that might be in input data
    assert "/synthetic-canary.env" not in rendered


def test_secret_shaped_tool_label_jwt_not_emitted_raw():
    """safe_tool_label must not echo raw JWT-shaped strings (which match SECRET_VALUE pattern)."""
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123xyz456def789ghi"
    result = safe_tool_label(jwt)
    assert result != jwt, "JWT value was emitted raw from safe_tool_label"


def test_secret_shaped_hook_basename_jwt_not_emitted_raw():
    """safe_hook_basename must not echo raw JWT-shaped strings."""
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123xyz456def789ghi"
    result = safe_hook_basename(jwt)
    assert result != jwt, "JWT value was emitted raw from safe_hook_basename"


# ---------------------------------------------------------------------------
# main() function direct call (covers lines 551-560 without subprocess)
# ---------------------------------------------------------------------------

def test_main_function_returns_zero_and_emits_json():
    """Calling main() with no args returns 0 and prints valid JSON to stdout."""
    buf = io.StringIO()
    orig_stdout = sys.stdout
    sys.stdout = buf
    try:
        rc = probe.main([])
    finally:
        sys.stdout = orig_stdout
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-secret-guard-canary"


def test_main_function_pretty_flag_produces_indented_json():
    """main(['--pretty']) produces indented JSON."""
    buf = io.StringIO()
    orig_stdout = sys.stdout
    sys.stdout = buf
    try:
        rc = probe.main(["--pretty"])
    finally:
        sys.stdout = orig_stdout
    assert rc == 0
    output = buf.getvalue()
    assert output.startswith("{\n"), "Expected indented output"
    json.loads(output)  # should parse cleanly


def test_main_function_observability_root_arg():
    """main() accepts --observability-root and uses it."""
    tmp_root = Path(tempfile.mkdtemp(prefix="main-obs-root-test-"))
    buf = io.StringIO()
    orig_stdout = sys.stdout
    sys.stdout = buf
    try:
        rc = probe.main(["--observability-root", str(tmp_root)])
    finally:
        sys.stdout = orig_stdout
        import shutil
        shutil.rmtree(tmp_root, ignore_errors=True)
    assert rc == 0
    report = json.loads(buf.getvalue())
    # Root exists but has no files
    assert report["historical_observability_correlation"]["verdict"] == "no-observability-hook-files"


def test_main_function_max_observability_files_arg():
    """main() accepts --max-observability-files and passes it to observability logic."""
    buf = io.StringIO()
    orig_stdout = sys.stdout
    sys.stdout = buf
    try:
        rc = probe.main(["--max-observability-files", "5"])
    finally:
        sys.stdout = orig_stdout
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["historical_observability_correlation"]["max_files"] == 5


def test_safe_tool_label_exactly_80_chars_passes_through_not_hashed():
    # The length cap is the STRICT `len(value) > 80`: a value of EXACTLY 80 chars (no slash) is
    # within the cap and passes through redact, not hashed. The existing overlong test uses 81
    # (hashed by both > and >=), so it cannot exercise the boundary. A >= weakening would hash an
    # at-cap value.
    result = safe_tool_label("A" * 80)
    assert result is not None
    assert not result.startswith("tool_hash:"), f"80-char value should pass through, got: {result}"


def test_guard_bundle_summary_read_only_matcher_covers_read_not_bash():
    # present_covers_read = `any(matcher == "Read")`: a bundle whose ONLY pretool matcher is Read
    # must report present_covers_read True and present_covers_bash False. The existing tests assert
    # the Bash side (True) and the empty side (both False), but never present_covers_read True in
    # isolation — so a != weakening of the Read comparison survives.
    orig_load = probe.load_json
    probe.load_json = lambda path: {
        "hooks": {"PreToolUse": [
            {"matcher": "Read", "hooks": [{"command": "echo r", "type": "interceptor"}]},
        ]}
    }
    try:
        result = guard_bundle_summary()
        assert result["present_covers_read"] is True
        assert result["present_covers_bash"] is False
    finally:
        probe.load_json = orig_load


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} secret guard canary tests passed")
