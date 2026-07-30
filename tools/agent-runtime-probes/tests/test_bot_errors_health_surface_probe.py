#!/usr/bin/env python3
"""Safety tests for bot_errors_health_surface_probe metadata-only output."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import io
from contextlib import redirect_stdout

import bot_errors_health_surface_probe as probe
from bot_errors_health_surface_probe import (  # noqa: E402
    build_report,
    function_body,
    line_refs,
    main,
    managed_surface,
    manifest_surface,
    parse_functions,
    read_lines,
    rel,
)


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def fixture_repo(root: Path) -> Path:
    repo = root / "WhatSoup"
    write(
        repo / "deploy/scripts/bot-errors-health-check.py",
        '''
"""fixture health check with secret-looking text that must not leak"""
import argparse

PROVIDER_PROBE_FAILURE_RE = "FAIL provider_probe"
FAKE_SECRET = "sk-this-must-not-appear"

def runtime_manifest_inventory(profile):
    return ["runtime_manifest: files=1 root=/Users/testuser/secret-runtime"]

def plugin_inventory(profile):
    settings_path = "/Users/testuser/.claude/settings.json"
    lines = []
    lines.append(f"plugins settings: {settings_path} user_scope_keys=2")
    lines.append("FAIL plugin_coverage bot-a: missing=1/2 inherited_enabled=secret-plugin")
    agent_options = {"enabledPlugins": {}, "pluginDirs": ["/Users/testuser/private-plugin"]}
    return lines

def classify_provider_probe_failure(text, rc, timed_out):
    if timed_out:
        return "provider_timeout"
    if "auth" in text:
        return "provider_auth_required"
    return "provider_probe_failed"

def provider_probe_contradicted_by_live_service(failure_class, credential_fragments, live_evidence):
    return "provider_auth_context=headless_login_keychain_blocked" in credential_fragments

def provider_probe_inconclusive_due_to_headless_auth(failure_class, credential_fragments):
    return "provider_auth_context=noninteractive_probe_keychain_blocked" in credential_fragments

def opencode_provider_probe_inventory(profile, item, name, data, provider, target):
    return ["provider_probe bot-a: provider=opencode-cli command=/Users/testuser/private-opencode status=ok"]

def provider_probe_target_inventory(profile, item, name, data, provider, target, health_probe_line=None):
    line = "provider_probe bot-a: provider=claude-cli status=advisory_inconclusive provider_probe_signal=headless_auth_probe_blocked"
    return [line]

def provider_probe_inventory(profile, item, name, data, expectation, health_probe_line=None):
    return provider_probe_target_inventory(profile, item, name, data, "claude-cli", "primary")

def alert_source_from_health_evidence(evidence):
    return "provider_probe:bot-a:provider_auth_required"

def critical_asset_from_health_evidence(evidence):
    code = "AGENT_PROVIDER_AUTH_REQUIRED"
    other = "AGENT_PROVIDER_USAGE_LIMIT"
    return {"code": code, "other": other}

def emit_per_instance_health_failures(failures):
    return []

def deadman():
    return 0

def daily():
    tool_lines, missing_required_tools = tool_inventory({})
    lines = [
        "machine: fixture-host",
        "profile: role=test path=/Users/testuser/private-profile.json",
        *runtime_manifest_inventory({}),
        *plugin_inventory({}),
        *provider_probe_inventory({}, {}, "bot-a", {"type": "agent"}, "always_on"),
    ]
    path = outbox_event("summary", "\\n".join(lines), source="daily-health", event_type="alert")
    emit_per_instance_health_failures(lines)
    return 0

def tool_inventory(profile):
    return [], []

def outbox_event(summary, evidence, source, event_type):
    return "/Users/testuser/private-outbox/event.json"

def main():
    parser = argparse.ArgumentParser(description="BOT ERRORS health and deadman checks")
    parser.add_argument("--daily", action="store_true")
    parser.add_argument("--deadman", action="store_true")
    parser.add_argument("--record-primary-phone-verification", metavar="INSTANCE")
    parser.add_argument("--owner", default="")
    return 0
''',
    )
    write(
        repo / "deploy/bot-errors-runtime-manifest.json",
        json.dumps(
            {
                "schemaVersion": 1,
                "files": [
                    {
                        "path": "deploy/scripts/bot-errors-health-check.py",
                        "mustContain": [
                            "provider_probe_inventory",
                            "redact_json_value(state)",
                            "private sk-this-must-not-appear",
                        ],
                    }
                ],
            }
        ),
    )
    write(
        repo / "deploy/managed-components.json",
        json.dumps(
            {
                "protective_services": {
                    "entries": [
                        {"name": "secret-service-name", "purpose": "Monitors health and restarts jobs."},
                        {"name": "token-backup", "purpose": "Backs up auth token material."},
                    ]
                }
            }
        ),
    )
    return repo


def assert_no_fixture_secrets(rendered: str) -> None:
    for forbidden in [
        "sk-this-must-not-appear",
        "/Users/testuser/secret-runtime",
        "/Users/testuser/private-plugin",
        "/Users/testuser/private-opencode",
        "/Users/testuser/private-profile.json",
        "/Users/testuser/private-outbox/event.json",
        "secret-plugin",
        "secret-service-name",
        "token-backup",
    ]:
        assert forbidden not in rendered, forbidden


def test_parse_functions_reports_syntax_error_marker():
    parsed = parse_functions("def broken(:\n    pass\n")
    assert parsed["_parse_error"]["_error"] == "SyntaxError", parsed
    assert parsed["_parse_error"]["line"] == 1, parsed


def test_health_surface_malformed_json_sources_are_typed():
    with tempfile.TemporaryDirectory(prefix="bot-errors-health-surface-") as tmp_dir:
        repo = Path(tmp_dir)
        write(repo / "deploy/bot-errors-runtime-manifest.json", "{bad")
        write(repo / "deploy/managed-components.json", "{bad")

        manifest = manifest_surface(repo)
        managed = managed_surface(repo)

    assert manifest["status"] == "invalid_json", manifest
    assert manifest["error_class"] == "json_decode", manifest
    assert managed["status"] == "invalid_json", managed
    assert managed["error_class"] == "json_decode", managed


def test_health_surface_probe_maps_source_without_raw_values():
    with tempfile.TemporaryDirectory(prefix="bot-errors-health-surface-") as tmp_dir:
        report = build_report(fixture_repo(Path(tmp_dir)))
        rendered = json.dumps(report, sort_keys=True)
        assert report["schema"] == "bot-errors-health-surface-report", report
        assert report["schema_version"] == "0.2", report
        assert report["serializationStatus"] == "emitted", report
        assert report["reportVerdict"] == "valid", report
        assert "repo" not in report, report
        assert report["summary"]["key_functions_missing"] == 0, report
        assert "runtime_manifest_inventory" in report["daily_health_surfaces"]["inventory_calls"], report
        assert "plugin_inventory" in report["daily_health_surfaces"]["inventory_calls"], report
        assert report["plugin_surfaces"]["checks_enabled_plugins"] is True, report
        assert report["plugin_surfaces"]["checks_plugin_dirs"] is True, report
        assert_no_fixture_secrets(rendered)


def test_health_surface_probe_extracts_provider_and_alert_classes():
    with tempfile.TemporaryDirectory(prefix="bot-errors-health-surface-") as tmp_dir:
        report = build_report(fixture_repo(Path(tmp_dir)))
        provider = report["provider_probe_surfaces"]
        alerts = report["alert_surfaces"]
        assert "provider_auth_required" in provider["failure_classes"], provider
        assert "provider_timeout" in provider["failure_classes"], provider
        assert "provider_probe_signal=headless_auth_probe_blocked" in provider["provider_probe_signal_markers"], provider
        assert "AGENT_PROVIDER_AUTH_REQUIRED" in alerts["critical_asset_codes"], alerts
        assert report["runtime_manifest_surface"]["marker_category_counts"]["provider_markers"] == 1, report
        assert report["managed_components_surface"]["purpose_category_counts"]["credential_backup"] == 1, report


def test_health_surface_probe_cli_suppresses_fixture_payloads():
    with tempfile.TemporaryDirectory(prefix="bot-errors-health-surface-") as tmp_dir:
        repo = fixture_repo(Path(tmp_dir))
        result = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve().parents[1] / "bot_errors_health_surface_probe.py"),
                "--repo",
                str(repo),
                "--pretty",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        report = json.loads(result.stdout)
        assert result.stderr == "", result.stderr
        assert report["summary"]["consistency_passed"] == report["summary"]["consistency_total"], report
        assert_no_fixture_secrets(result.stdout)


# ---------------------------------------------------------------------------
# read_lines: missing-file branch (line 54)
# ---------------------------------------------------------------------------

def test_read_lines_missing_path_returns_empty():
    """read_lines returns [] without raising when the path does not exist."""
    result = read_lines(Path("/nonexistent-xyz/does-not-exist.py"))
    assert result == [], result


# ---------------------------------------------------------------------------
# rel: ValueError branch (lines 61-62) — path outside repo
# ---------------------------------------------------------------------------

def test_rel_path_outside_repo_returns_str_path():
    """rel() suppresses paths outside the supplied repository root."""
    outside = Path("/tmp/not-under-repo.txt")
    repo = Path("/Users/testuser/LAB/WhatSoup")
    result = rel(outside, repo)
    assert result is None, result


# ---------------------------------------------------------------------------
# line_refs: full body coverage (lines 71-79)
# ---------------------------------------------------------------------------

def test_line_refs_returns_matching_refs():
    """line_refs finds lines matching pattern and returns location refs."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-line-refs-") as tmp_dir:
        repo = Path(tmp_dir)
        rel_path = Path("scripts/check.py")
        target = repo / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("no match\nfoo_pattern found\nanother match foo_pattern\n", encoding="utf-8")
        refs = line_refs(repo, rel_path, r"foo_pattern")
    assert len(refs) == 2, refs
    assert "2" in refs[0], refs
    assert "3" in refs[1], refs


def test_line_refs_respects_limit():
    """line_refs stops collecting after reaching the limit."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-line-refs-limit-") as tmp_dir:
        repo = Path(tmp_dir)
        rel_path = Path("scripts/check.py")
        target = repo / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("\n".join(["hit"] * 20), encoding="utf-8")
        refs = line_refs(repo, rel_path, r"hit", limit=3)
    assert len(refs) == 3, refs


def test_line_refs_missing_file_returns_empty():
    """line_refs returns [] gracefully when the target file does not exist."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-line-refs-miss-") as tmp_dir:
        repo = Path(tmp_dir)
        refs = line_refs(repo, Path("no/such/file.py"), r"anything")
    assert refs == [], refs


# ---------------------------------------------------------------------------
# function_body: falsy-fn branch (line 99)
# ---------------------------------------------------------------------------

def test_function_body_none_fn_returns_empty():
    """function_body returns '' when fn is None."""
    assert function_body(["line one", "line two"], None) == ""


def test_function_body_false_fn_returns_empty():
    """function_body returns '' when fn is an empty dict (falsy)."""
    assert function_body(["line one"], {}) == ""


# ---------------------------------------------------------------------------
# function_inventory: missing-function branch (lines 116-117)
# build_report with no health script present exercises this
# ---------------------------------------------------------------------------

def test_function_inventory_missing_functions_marked_absent():
    """build_report marks key functions as present=False when health script is missing."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-no-script-") as tmp_dir:
        repo = Path(tmp_dir)
        # No health script, no manifest, no managed — bare empty repo
        report = build_report(repo)
    fn_items = report["source"]["functions"]
    absent = [item for item in fn_items if not item.get("present")]
    # All KEY_FUNCTIONS must be absent since there is no script
    assert len(absent) == len(probe.KEY_FUNCTIONS), absent
    assert all(item["name"] in probe.KEY_FUNCTIONS for item in absent), absent
    assert report["summary"]["key_functions_missing"] == len(probe.KEY_FUNCTIONS), report


# ---------------------------------------------------------------------------
# manifest_surface: missing, invalid_shape, invalid_files, non-dict item
# (lines 215, 219, 222, 226, 231, 238, 240)
# ---------------------------------------------------------------------------

def test_manifest_surface_missing_file():
    """manifest_surface returns status=missing when the file does not exist."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-manifest-miss-") as tmp_dir:
        result = manifest_surface(Path(tmp_dir))
    assert result["status"] == "missing", result
    assert result["error_class"] is None, result
    assert result["counts"]["observed_valid"] is None, result
    assert result["file_count"] == 0, result


def test_manifest_surface_invalid_shape_non_dict():
    """manifest_surface returns status=invalid_shape when JSON root is not a dict."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-manifest-shape-") as tmp_dir:
        repo = Path(tmp_dir)
        (repo / "deploy").mkdir(parents=True, exist_ok=True)
        (repo / "deploy/bot-errors-runtime-manifest.json").write_text(
            json.dumps([1, 2, 3]), encoding="utf-8"
        )
        result = manifest_surface(repo)
    assert result["status"] == "invalid_shape", result
    assert result["error_class"] == "root_not_object", result
    assert result["file_count"] == 0, result


def test_manifest_surface_invalid_files_not_list():
    """A non-list files field is an invalid source shape."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-manifest-files-") as tmp_dir:
        repo = Path(tmp_dir)
        (repo / "deploy").mkdir(parents=True, exist_ok=True)
        (repo / "deploy/bot-errors-runtime-manifest.json").write_text(
            json.dumps({"files": "oops-not-a-list"}), encoding="utf-8"
        )
        result = manifest_surface(repo)
    assert result["status"] == "invalid_shape", result
    assert result["error_class"] == "files_not_list", result
    assert result["file_count"] == 0, result


def test_manifest_surface_non_dict_item_in_files_is_skipped():
    """manifest_surface skips non-dict items in the files list (line 226 continue)."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-manifest-item-") as tmp_dir:
        repo = Path(tmp_dir)
        (repo / "deploy").mkdir(parents=True, exist_ok=True)
        (repo / "deploy/bot-errors-runtime-manifest.json").write_text(
            json.dumps({"files": ["not-a-dict", 42, {"mustContain": ["plugin marker"]}]}),
            encoding="utf-8",
        )
        result = manifest_surface(repo)
    assert result["status"] == "partial", result
    assert result["file_count"] == 1, result
    assert result["counts"]["observed_valid"] == 1, result
    assert result["counts"]["invalid"] == 2, result
    counts = result["marker_category_counts"]
    assert counts.get("plugin_markers", 0) == 1, counts


def test_manifest_surface_non_str_marker_is_skipped():
    """manifest_surface skips non-string values in mustContain (line 231 continue)."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-manifest-nonstr-") as tmp_dir:
        repo = Path(tmp_dir)
        (repo / "deploy").mkdir(parents=True, exist_ok=True)
        (repo / "deploy/bot-errors-runtime-manifest.json").write_text(
            json.dumps({"files": [{"mustContain": [None, 42, "manifest marker"]}]}),
            encoding="utf-8",
        )
        result = manifest_surface(repo)
    assert result["status"] == "observed", result
    counts = result["marker_category_counts"]
    # Only the string "manifest marker" should be counted
    assert counts.get("runtime_manifest_markers", 0) == 1, counts


def test_manifest_surface_single_str_mustcontain():
    """manifest_surface handles mustContain as a plain string (not a list)."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-manifest-str-") as tmp_dir:
        repo = Path(tmp_dir)
        (repo / "deploy").mkdir(parents=True, exist_ok=True)
        (repo / "deploy/bot-errors-runtime-manifest.json").write_text(
            json.dumps({"files": [{"mustContain": "provider check"}]}),
            encoding="utf-8",
        )
        result = manifest_surface(repo)
    assert result["status"] == "observed", result
    counts = result["marker_category_counts"]
    assert counts.get("provider_markers", 0) == 1, counts


def test_manifest_surface_counts_jsonl_private_markers():
    """manifest_surface counts markers containing 'jsonl' or 'private' (line 241)."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-manifest-priv-") as tmp_dir:
        repo = Path(tmp_dir)
        (repo / "deploy").mkdir(parents=True, exist_ok=True)
        (repo / "deploy/bot-errors-runtime-manifest.json").write_text(
            json.dumps({"files": [{"mustContain": ["jsonl stream", "private key"]}]}),
            encoding="utf-8",
        )
        result = manifest_surface(repo)
    counts = result["marker_category_counts"]
    assert counts.get("private_log_markers", 0) == 2, counts


def test_manifest_surface_counts_plugin_and_manifest_markers():
    """manifest_surface counts plugin_markers and runtime_manifest_markers (lines 238, 240)."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-manifest-plugmani-") as tmp_dir:
        repo = Path(tmp_dir)
        (repo / "deploy").mkdir(parents=True, exist_ok=True)
        (repo / "deploy/bot-errors-runtime-manifest.json").write_text(
            json.dumps({"files": [{"mustContain": ["plugin directory", "manifest version"]}]}),
            encoding="utf-8",
        )
        result = manifest_surface(repo)
    counts = result["marker_category_counts"]
    assert counts.get("plugin_markers", 0) == 1, counts
    assert counts.get("runtime_manifest_markers", 0) == 1, counts


# ---------------------------------------------------------------------------
# managed_surface: missing, invalid_shape, entries-not-list, non-dict entry,
# manifest_or_drift counter (lines 254, 258, 262, 266, 271)
# ---------------------------------------------------------------------------

def test_managed_surface_missing_file():
    """managed_surface returns status=missing when the file does not exist."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-managed-miss-") as tmp_dir:
        result = managed_surface(Path(tmp_dir))
    assert result["status"] == "missing", result
    assert result["error_class"] is None, result


def test_managed_surface_invalid_shape_non_dict():
    """managed_surface returns status=invalid_shape when JSON root is not a dict."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-managed-shape-") as tmp_dir:
        repo = Path(tmp_dir)
        (repo / "deploy").mkdir(parents=True, exist_ok=True)
        (repo / "deploy/managed-components.json").write_text(
            json.dumps([{"name": "svc"}]), encoding="utf-8"
        )
        result = managed_surface(repo)
    assert result["status"] == "invalid_shape", result
    assert result["error_class"] == "root_not_object", result


def test_managed_surface_entries_not_list_is_invalid_not_observed_zero():
    """A non-list entries field is invalid evidence, never a parsed empty inventory."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-managed-entries-") as tmp_dir:
        repo = Path(tmp_dir)
        (repo / "deploy").mkdir(parents=True, exist_ok=True)
        (repo / "deploy/managed-components.json").write_text(
            json.dumps({"protective_services": {"entries": "not-a-list"}}),
            encoding="utf-8",
        )
        result = managed_surface(repo)
    assert result["status"] == "invalid_shape", result
    assert result["counts"]["observed_valid"] is None, result
    assert result["counts"]["unknown"] == 1, result
    assert result["protective_service_count"] == 0, result


def test_managed_surface_non_dict_entry_is_partial_not_complete_inventory():
    """Invalid collection members preserve valid counts but make the observation partial."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-managed-nondictentry-") as tmp_dir:
        repo = Path(tmp_dir)
        (repo / "deploy").mkdir(parents=True, exist_ok=True)
        (repo / "deploy/managed-components.json").write_text(
            json.dumps({
                "protective_services": {
                    "entries": ["not-a-dict", 42, {"purpose": "Monitors drift and manifest."}]
                }
            }),
            encoding="utf-8",
        )
        result = managed_surface(repo)
    assert result["status"] == "partial", result
    assert result["counts"]["observed_valid"] == 1, result
    assert result["counts"]["invalid"] == 2, result
    assert result["protective_service_count"] == 1, result
    counts = result["purpose_category_counts"]
    assert counts.get("manifest_or_drift", 0) == 1, counts


def test_managed_surface_manifest_or_drift_counter():
    """managed_surface increments manifest_or_drift for entries with manifest/drift in purpose (line 271)."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-managed-manifest-") as tmp_dir:
        repo = Path(tmp_dir)
        (repo / "deploy").mkdir(parents=True, exist_ok=True)
        (repo / "deploy/managed-components.json").write_text(
            json.dumps({
                "protective_services": {
                    "entries": [
                        {"purpose": "Checks manifest integrity."},
                        {"purpose": "Detects drift in config."},
                    ]
                }
            }),
            encoding="utf-8",
        )
        result = managed_surface(repo)
    counts = result["purpose_category_counts"]
    assert counts.get("manifest_or_drift", 0) == 2, counts


def test_managed_surface_protective_services_none():
    """A missing protective-services object is invalid policy shape, not empty evidence."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-managed-noprotect-") as tmp_dir:
        repo = Path(tmp_dir)
        (repo / "deploy").mkdir(parents=True, exist_ok=True)
        (repo / "deploy/managed-components.json").write_text(
            json.dumps({"other_key": "value"}), encoding="utf-8"
        )
        result = managed_surface(repo)
    assert result["status"] == "invalid_shape", result
    assert result["error_class"] == "protective_services_not_object", result
    assert result["protective_service_count"] == 0, result


def test_health_report_missing_managed_policy_is_inconclusive_not_green():
    with tempfile.TemporaryDirectory(prefix="private-health-root-") as tmp_dir:
        report = build_report(Path(tmp_dir))
        rendered = json.dumps(report, sort_keys=True)
    assert report["reportVerdict"] == "inconclusive", report
    assert report["consistency"]["managed_components_observed"] is False, report
    assert report["summary"]["consistency_passed"] < report["summary"]["consistency_total"], report
    assert tmp_dir not in rendered, rendered


def test_health_surface_strict_mode_refuses_invalid_policy_but_report_mode_serializes():
    with tempfile.TemporaryDirectory(prefix="private-health-root-") as tmp_dir:
        repo = Path(tmp_dir)
        write(repo / "deploy/managed-components.json", json.dumps({"protective_services": {"entries": "not-a-list"}}))
        probe_path = str(Path(__file__).resolve().parents[1] / "bot_errors_health_surface_probe.py")
        report_only = subprocess.run([sys.executable, probe_path, "--repo", str(repo)], capture_output=True, text=True)
        strict = subprocess.run([sys.executable, probe_path, "--repo", str(repo), "--strict"], capture_output=True, text=True)
    assert report_only.returncode == 0, report_only.stderr
    assert json.loads(report_only.stdout)["reportVerdict"] == "invalid"
    assert strict.returncode == 2, strict.stderr
    assert json.loads(strict.stdout)["reportVerdict"] == "invalid"


# ---------------------------------------------------------------------------
# main(): direct call (lines 379-386)
# ---------------------------------------------------------------------------

def test_main_direct_call_returns_zero_and_emits_json():
    """main() returns 0 and writes valid JSON to stdout when called directly."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-main-") as tmp_dir:
        repo = fixture_repo(Path(tmp_dir))
        orig_argv = sys.argv[:]
        sys.argv = ["bot_errors_health_surface_probe.py", "--repo", str(repo)]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = main()
        finally:
            sys.argv = orig_argv
    assert rc == 0, rc
    output = buf.getvalue()
    parsed = json.loads(output)
    assert parsed["schema"] == "bot-errors-health-surface-report", parsed
    assert parsed["schema_version"] == "0.2", parsed


def test_main_pretty_flag_produces_indented_json():
    """main() --pretty produces indented JSON output (exercises indent=2 branch)."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-main-pretty-") as tmp_dir:
        repo = fixture_repo(Path(tmp_dir))
        orig_argv = sys.argv[:]
        sys.argv = ["bot_errors_health_surface_probe.py", "--repo", str(repo), "--pretty"]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = main()
        finally:
            sys.argv = orig_argv
    assert rc == 0, rc
    output = buf.getvalue()
    # Pretty output has indentation
    assert "\n  " in output, "expected indented JSON"
    parsed = json.loads(output)
    assert parsed["schema"] == "bot-errors-health-surface-report", parsed


# ---------------------------------------------------------------------------
# Determinism test
# ---------------------------------------------------------------------------

def test_build_report_is_deterministic():
    """build_report produces identical output on two consecutive calls (determinism)."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-determinism-") as tmp_dir:
        repo = fixture_repo(Path(tmp_dir))
        r1 = json.dumps(build_report(repo), sort_keys=True)
        r2 = json.dumps(build_report(repo), sort_keys=True)
    assert r1 == r2, "build_report is non-deterministic"


# ---------------------------------------------------------------------------
# CLI e2e subprocess test (exit code + JSON shape)
# ---------------------------------------------------------------------------

def test_cli_e2e_exit_code_and_json_shape():
    """CLI e2e: probe exits 0 and stdout is valid JSON with expected top-level keys."""
    with tempfile.TemporaryDirectory(prefix="bot-errors-cli-e2e-") as tmp_dir:
        repo = fixture_repo(Path(tmp_dir))
        probe_path = str(Path(__file__).resolve().parents[1] / "bot_errors_health_surface_probe.py")
        result = subprocess.run(
            [sys.executable, probe_path, "--repo", str(repo)],
            capture_output=True,
            text=True,
        )
    assert result.returncode == 0, f"probe exited {result.returncode}: {result.stderr}"
    parsed = json.loads(result.stdout)
    for key in ("schema", "schema_version", "summary", "source", "consistency"):
        assert key in parsed, f"missing key {key!r} in output"
    assert parsed["schema"] == "bot-errors-health-surface-report", parsed


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} BOT ERRORS health-surface tests passed")
