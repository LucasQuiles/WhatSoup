#!/usr/bin/env python3
"""Tests for BOT ERRORS proof-ladder: fail-closed source statuses, unhappy paths,
component structure, redaction, and CLI e2e.

Conventions (from test_pi_presence_probe.py exemplar):
- no pytest fixtures; manual setattr+try/finally where needed
- __main__ PASS runner at the bottom
- CLI e2e via subprocess covering the __main__ entrypoint
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

import bot_errors_proof_ladder as probe  # noqa: E402
from bot_errors_proof_ladder import (  # noqa: E402
    build_report,
    component_report,
    evidence_item,
    file_ref,
    line_refs,
    managed_component_names,
    managed_component_summary,
    ref,
    rel,
    runtime_manifest_files,
    runtime_manifest_summary,
)

PROBE_PATH = Path(__file__).resolve().parent.parent / "bot_errors_proof_ladder.py"
COMPONENTS_8 = [
    "q_loop", "dispatcher", "collector", "daily_health",
    "heartbeat_watchdog", "deadman", "runtime_manifest", "managed_components",
]


# ---------------------------------------------------------------------------
# Existing test (preserved)
# ---------------------------------------------------------------------------

def test_malformed_json_sources_are_typed_not_clean_absence():
    with tempfile.TemporaryDirectory(prefix="bot-errors-proof-ladder-test-") as tmp_dir:
        repo = Path(tmp_dir)
        deploy = repo / "deploy"
        deploy.mkdir()
        (deploy / "bot-errors-runtime-manifest.json").write_text("{bad", encoding="utf-8")
        (deploy / "managed-components.json").write_text("{bad", encoding="utf-8")

        manifest = runtime_manifest_summary(repo)
        managed = managed_component_summary(repo)
        manifest_files = runtime_manifest_files(repo)
        managed_names = managed_component_names(repo)
        report = build_report(repo)

    assert manifest_files == []
    assert managed_names == []
    assert manifest["status"] == "invalid_json", manifest
    assert manifest["error_class"] == "json_decode", manifest
    assert manifest["formatStatus"] == "invalid_json", manifest
    assert managed["status"] == "invalid_json", managed
    assert managed["error_class"] == "json_decode", managed
    assert managed["formatStatus"] == "invalid_json", managed
    assert report["source_status"]["runtime_manifest"] == {
        "status": "invalid_json",
        "error_class": "json_decode",
    }, report["source_status"]
    assert report["source_status"]["managed_components"] == {
        "status": "invalid_json",
        "error_class": "json_decode",
    }, report["source_status"]


# ---------------------------------------------------------------------------
# rel() and ref() helpers
# ---------------------------------------------------------------------------

def test_rel_returns_relative_path_when_inside_repo():
    repo = Path("/some/repo")
    p = Path("/some/repo/deploy/scripts/foo.py")
    result = rel(p, repo)
    assert result == "deploy/scripts/foo.py", result


def test_rel_suppresses_path_when_outside_repo():
    # ValueError branch: path not under repo
    repo = Path("/home/user/repo")
    p = Path("/tmp/elsewhere/file.py")
    result = rel(p, repo)
    assert result is None, result


def test_ref_with_line_number_appends_suffix():
    repo = Path("/repo")
    p = Path("/repo/foo.py")
    result = ref(p, repo, 42)
    assert result.endswith(":42"), result


def test_ref_with_no_line_omits_suffix():
    repo = Path("/repo")
    p = Path("/repo/foo.py")
    result = ref(p, repo, None)
    assert ":" not in result or result.endswith("foo.py"), result


# ---------------------------------------------------------------------------
# line_refs() helper
# ---------------------------------------------------------------------------

def test_line_refs_returns_empty_for_missing_file():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        result = line_refs(repo, "nonexistent.txt", r"match")
    assert result == []


def test_line_refs_matches_pattern_and_returns_refs():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        f = repo / "test.txt"
        f.write_text("no hit\nNEEDLE here\nalso NEEDLE\n", encoding="utf-8")
        result = line_refs(repo, "test.txt", r"NEEDLE")
    assert len(result) == 2
    # refs should not contain raw absolute paths — they are relative to repo
    for r in result:
        assert r.startswith("test.txt"), r


def test_line_refs_respects_limit():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        f = repo / "test.txt"
        f.write_text("\n".join(["match"] * 10), encoding="utf-8")
        result = line_refs(repo, "test.txt", r"match", limit=3)
    assert len(result) == 3


def test_line_refs_returns_empty_for_no_match():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        f = repo / "test.txt"
        f.write_text("no patterns here\n", encoding="utf-8")
        result = line_refs(repo, "test.txt", r"NEEDLE_NOT_PRESENT")
    assert result == []


# ---------------------------------------------------------------------------
# file_ref() helper
# ---------------------------------------------------------------------------

def test_file_ref_returns_none_for_missing_file():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        result = file_ref(repo, "missing.py")
    assert result is None


def test_file_ref_returns_ref_for_existing_file():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        f = repo / "exists.py"
        f.write_text("content", encoding="utf-8")
        result = file_ref(repo, "exists.py")
    assert result is not None
    assert "exists.py" in result
    assert result.endswith(":1"), result  # line 1 always


# ---------------------------------------------------------------------------
# runtime_manifest_summary() unhappy paths
# ---------------------------------------------------------------------------

def test_runtime_manifest_missing_returns_missing_status():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        (repo / "deploy").mkdir()
        result = runtime_manifest_summary(repo)
    assert result["status"] == "missing"
    assert result["error_class"] is None
    assert result["files"] == []


def test_runtime_manifest_invalid_shape_non_dict_returns_invalid_shape():
    # JSON root is a list, not a dict — invalid_shape branch
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        (deploy / "bot-errors-runtime-manifest.json").write_text("[1, 2, 3]", encoding="utf-8")
        result = runtime_manifest_summary(repo)
    assert result["status"] == "invalid_shape", result
    assert result["error_class"] == "root_not_object", result
    assert result["files"] == []


def test_runtime_manifest_files_not_list_returns_invalid_shape():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        data = {"files": "not-a-list"}
        (deploy / "bot-errors-runtime-manifest.json").write_text(json.dumps(data), encoding="utf-8")
        result = runtime_manifest_summary(repo)
    assert result["status"] == "invalid_shape", result
    assert result["error_class"] == "files_not_list", result
    assert result["files"] == []


def test_runtime_manifest_malformed_entry_is_partial_not_observed():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        data = {"files": [{"path": "a.py"}, {"path": "b.py"}, {"other": "no-path"}]}
        (deploy / "bot-errors-runtime-manifest.json").write_text(json.dumps(data), encoding="utf-8")
        result = runtime_manifest_summary(repo)
        files = runtime_manifest_files(repo)
    assert result["status"] == "partial", result
    assert result["error_class"] is None
    # only items with a "path" key are included
    assert "a.py" in result["files"]
    assert "b.py" in result["files"]
    assert len(result["files"]) == 2
    assert result["counts"]["invalid"] == 1
    assert files == result["files"]


def test_runtime_manifest_malformed_json_is_not_counted_as_valid():
    # Fail-closed: malformed JSON must not appear in file counts
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        (deploy / "bot-errors-runtime-manifest.json").write_text("{corrupted", encoding="utf-8")
        result = runtime_manifest_summary(repo)
    assert result["status"] == "invalid_json"
    assert result["files"] == []  # NOT counted as clean


def test_runtime_manifest_partial_entries_are_not_observed_zero():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        (deploy / "bot-errors-runtime-manifest.json").write_text(
            json.dumps({"files": [{"path": "valid.py"}, "not-a-file-entry"]}),
            encoding="utf-8",
        )
        result = runtime_manifest_summary(repo)
    assert result["status"] == "partial", result
    assert result["counts"] == {
        "expected": 2,
        "observed_valid": 1,
        "invalid": 1,
        "skipped": 0,
        "unknown": 0,
    }, result


def test_runtime_manifest_rejects_empty_and_non_string_paths():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        (deploy / "bot-errors-runtime-manifest.json").write_text(
            json.dumps({"files": [{"path": "valid.py"}, {"path": ""}, {"path": 7}]}),
            encoding="utf-8",
        )
        result = runtime_manifest_summary(repo)
    assert result["status"] == "partial", result
    assert result["files"] == ["valid.py"], result
    assert result["counts"]["invalid"] == 2, result


# ---------------------------------------------------------------------------
# managed_component_summary() unhappy paths
# ---------------------------------------------------------------------------

def test_managed_components_missing_returns_missing_status():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        (repo / "deploy").mkdir()
        result = managed_component_summary(repo)
    assert result["status"] == "missing"
    assert result["error_class"] is None
    assert result["names"] == []


def test_managed_components_invalid_shape_non_dict():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        (deploy / "managed-components.json").write_text("[1, 2]", encoding="utf-8")
        result = managed_component_summary(repo)
    assert result["status"] == "invalid_shape", result
    assert result["error_class"] == "root_not_object", result
    assert result["names"] == []


def test_managed_components_entries_not_list():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        data = {"protective_services": {"entries": "not-a-list"}}
        (deploy / "managed-components.json").write_text(json.dumps(data), encoding="utf-8")
        result = managed_component_summary(repo)
    assert result["status"] == "invalid_shape", result
    assert result["error_class"] == "entries_not_list", result
    assert result["names"] == []


def test_managed_components_malformed_entry_is_partial_not_observed():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        data = {
            "protective_services": {
                "entries": [{"name": "svc-alpha"}, {"name": "svc-beta"}, {"other": "no-name"}]
            }
        }
        (deploy / "managed-components.json").write_text(json.dumps(data), encoding="utf-8")
        result = managed_component_summary(repo)
        names = managed_component_names(repo)
    assert result["status"] == "partial", result
    assert "svc-alpha" in result["names"]
    assert "svc-beta" in result["names"]
    assert len(result["names"]) == 2
    assert result["counts"]["invalid"] == 1
    assert names == result["names"]


def test_managed_components_reject_empty_and_non_string_names():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        data = {
            "protective_services": {
                "entries": [{"name": "svc-alpha"}, {"name": ""}, {"name": 7}]
            }
        }
        (deploy / "managed-components.json").write_text(json.dumps(data), encoding="utf-8")
        result = managed_component_summary(repo)
    assert result["status"] == "partial", result
    assert result["names"] == ["svc-alpha"], result
    assert result["counts"]["invalid"] == 2, result


def test_managed_components_malformed_json_not_counted_as_valid():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        (deploy / "managed-components.json").write_text("{bad json}", encoding="utf-8")
        result = managed_component_summary(repo)
    assert result["status"] == "invalid_json"
    assert result["names"] == []  # NOT counted as clean


# ---------------------------------------------------------------------------
# evidence_item() helper
# ---------------------------------------------------------------------------

def test_evidence_item_returns_correct_shape():
    item = evidence_item("code_present", "present", ["foo.py:1"], "Test note")
    assert item["proof_class"] == "code_present"
    assert item["status"] == "present"
    assert item["evidence_refs"] == ["foo.py:1"]
    assert item["note"] == "Test note"


# ---------------------------------------------------------------------------
# component_report() — all 8 components, empty repo (all files missing)
# ---------------------------------------------------------------------------

def test_all_8_components_have_live_observation_not_probed_in_empty_repo():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        for comp in COMPONENTS_8:
            r = component_report(repo, comp, [], [])
            live_obs = [e for e in r["evidence"] if e["proof_class"] == "live_observation"]
            assert len(live_obs) == 1, f"{comp}: expected 1 live_observation, got {live_obs}"
            assert live_obs[0]["status"] == "not_probed", f"{comp}: {live_obs[0]}"


def test_all_8_components_have_not_probed_verdict_in_empty_repo():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        for comp in COMPONENTS_8:
            r = component_report(repo, comp, [], [])
            assert r["verdict"] == "current live state unproven", f"{comp}: {r['verdict']}"


def test_component_report_shape_is_valid():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        r = component_report(repo, "q_loop", [], [])
    assert r["component"] == "q_loop"
    assert isinstance(r["proof_classes"], list)
    assert isinstance(r["status_counts"], dict)
    assert isinstance(r["evidence"], list)
    assert "verdict" in r
    assert len(r["proof_classes"]) == len(r["evidence"])


def test_deadman_has_code_present_and_design_only_proof_classes():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        r = component_report(repo, "deadman", [], [])
    pcs = r["proof_classes"]
    # deadman gets code_present (script path) + code_present (deadman code check) + design_only
    assert pcs.count("code_present") >= 2, f"deadman proof_classes: {pcs}"
    assert "design_only" in pcs, f"deadman proof_classes: {pcs}"


def test_runtime_manifest_component_has_static_manifest_and_manifest_file_count():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        r = component_report(repo, "runtime_manifest", ["a.py", "b.py"], [])
    pcs = r["proof_classes"]
    assert "static_manifest" in pcs, pcs
    assert "manifest_file_count" in pcs, pcs
    # file count should appear in evidence notes
    count_item = next(e for e in r["evidence"] if e["proof_class"] == "manifest_file_count")
    assert "2" in count_item["note"], count_item


def test_missing_runtime_manifest_is_not_static_evidence():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        report = component_report(repo, "runtime_manifest", [], [])
    static_manifest = next(item for item in report["evidence"] if item["proof_class"] == "static_manifest")
    assert static_manifest["status"] == "missing", static_manifest
    assert static_manifest["evidence_refs"] == [], static_manifest


def test_managed_components_component_has_static_policy():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        r = component_report(repo, "managed_components", [], ["svc-a", "svc-b"])
    pcs = r["proof_classes"]
    assert "static_policy" in pcs, pcs
    policy_item = next(e for e in r["evidence"] if e["proof_class"] == "static_policy")
    assert "2" in policy_item["note"], policy_item


def test_invalid_managed_components_is_not_static_policy_evidence():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        (deploy / "managed-components.json").write_text("{bad", encoding="utf-8")
        report = build_report(repo)
    component = next(item for item in report["components"] if item["component"] == "managed_components")
    static_policy = next(item for item in component["evidence"] if item["proof_class"] == "static_policy")
    assert static_policy["status"] == "invalid_json", static_policy
    assert static_policy["evidence_refs"] == [], static_policy
    assert "lists 0" not in static_policy["note"], static_policy


def test_invalid_runtime_manifest_is_not_static_manifest_evidence():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        (deploy / "bot-errors-runtime-manifest.json").write_text("{bad", encoding="utf-8")
        report = build_report(repo)
    component = next(item for item in report["components"] if item["component"] == "runtime_manifest")
    static_manifest = next(item for item in component["evidence"] if item["proof_class"] == "static_manifest")
    assert static_manifest["status"] == "invalid_json", static_manifest
    assert static_manifest["evidence_refs"] == [], static_manifest
    assert "lists 0" not in static_manifest["note"], static_manifest


def test_invalid_manifest_status_suppresses_matching_policy_line_refs():
    """An invalid source cannot borrow static policy lines from a readable fixture."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        manifest = repo / "deploy" / "bot-errors-runtime-manifest.json"
        manifest.parent.mkdir()
        manifest.write_text("expectedHeadShaPolicy = observability-only\n", encoding="utf-8")
        report = component_report(
            repo,
            "runtime_manifest",
            [],
            [],
            manifest_status={"status": "invalid_json", "artifact_refs": ["deploy/bot-errors-runtime-manifest.json"]},
        )
    static_manifest = next(item for item in report["evidence"] if item["proof_class"] == "static_manifest")
    assert static_manifest["status"] == "invalid_json", static_manifest
    assert static_manifest["evidence_refs"] == [], static_manifest


def test_component_report_with_all_files_present():
    # Exercise code_present=present branches for all script-backed components
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        (deploy / "scripts").mkdir(parents=True)
        (deploy / "health-profiles").mkdir(parents=True)
        docs = repo / "docs" / "runbooks"
        docs.mkdir(parents=True)

        (deploy / "scripts" / "bot-errors-q-loop.py").write_text("# q_loop", encoding="utf-8")
        (deploy / "scripts" / "bot-errors-dispatcher.py").write_text("# dispatcher", encoding="utf-8")
        (deploy / "scripts" / "bot-errors-collector.py").write_text("# collector", encoding="utf-8")
        (deploy / "scripts" / "bot-errors-health-check.py").write_text(
            "def deadman(): pass\nDEADMAN=True\ndeadman-state\nDaily health probe\n",
            encoding="utf-8",
        )
        (deploy / "scripts" / "bot-errors-heartbeat-watchdog.py").write_text(
            '"q_loop"\n"dispatcher"\n"collector"\n"daily_health"\n',
            encoding="utf-8",
        )
        (deploy / "health-profiles" / "runtime-host.json").write_text(
            json.dumps({
                "expectQLoop": True,
                "expectDispatcher": True,
                "expectRuntimeManifest": True,
            }),
            encoding="utf-8",
        )
        (deploy / "scripts" / "README-bot-errors.md").write_text(
            "hub collector, dispatcher, q-loop, and health timer were active\n"
            "Daily health probe\n"
            "matched `8/8` host-local runtime manifest hashes\n",
            encoding="utf-8",
        )
        (docs / "runtime-host-deadman.md").write_text(
            "DESIGN ONLY\nnot yet installed\nruntime-host-deadman\n",
            encoding="utf-8",
        )

        q_loop_r = component_report(repo, "q_loop", [], [])
        deadman_r = component_report(repo, "deadman", [], [])

        q_code = [e for e in q_loop_r["evidence"] if e["proof_class"] == "code_present"]
        assert q_code[0]["status"] == "present", q_code

        deadman_code = [e for e in deadman_r["evidence"] if e["proof_class"] == "code_present"]
        # first entry is script file (present), second is deadman-specific code check (present)
        assert any(e["status"] == "present" for e in deadman_code), deadman_code
        design_items = [e for e in deadman_r["evidence"] if e["proof_class"] == "design_only"]
        assert design_items[0]["status"] == "present", design_items


def test_role_profile_inventory_supplies_static_expectation_without_profile_name():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        profile = repo / "deploy" / "health-profiles" / "private-profile-name.json"
        profile.parent.mkdir(parents=True)
        profile.write_text(
            json.dumps({
                "expectQLoop": True,
                "expectDispatcher": True,
                "expectRuntimeManifest": True,
            }),
            encoding="utf-8",
        )
        report = build_report(repo)
    q_loop = next(item for item in report["components"] if item["component"] == "q_loop")
    expectation = next(item for item in q_loop["evidence"] if item["proof_class"] == "static_expectation")
    assert expectation["status"] == "present", expectation
    assert expectation["evidence_refs"] == ["deploy/health-profiles"], expectation
    assert "private-profile-name.json" not in json.dumps(report, sort_keys=True), report


def test_invalid_profile_source_propagates_without_static_reference():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        profile = repo / "deploy" / "health-profiles" / "private-profile-name.json"
        profile.parent.mkdir(parents=True)
        profile.write_text("{bad", encoding="utf-8")
        report = build_report(repo)
    q_loop = next(item for item in report["components"] if item["component"] == "q_loop")
    expectation = next(item for item in q_loop["evidence"] if item["proof_class"] == "static_expectation")
    assert report["observations"]["health_profiles"]["status"] == "invalid_json", report
    assert expectation["status"] == "invalid_json", expectation
    assert expectation["evidence_refs"] == [], expectation
    assert "status is invalid_json" in expectation["note"], expectation
    assert report["summary"]["health_profile_count"] is None, report


def test_profile_read_failure_is_not_recast_as_invalid_shape():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        profile = repo / "deploy" / "health-profiles" / "profile.json"
        profile.parent.mkdir(parents=True)
        profile.write_text("{}", encoding="utf-8")
        original_load_json = probe.load_json
        probe.load_json = lambda _path: {"_error": "PermissionError: denied"}
        try:
            summary = probe.profile_expectation_summary(repo)
        finally:
            probe.load_json = original_load_json
    assert summary["status"] == "read_error", summary
    assert summary["error_class"] == "read_error", summary
    assert summary["counts"]["unknown"] == 1, summary


# ---------------------------------------------------------------------------
# build_report() — shape, summary fields, redaction
# ---------------------------------------------------------------------------

def test_build_report_empty_repo_has_correct_shape():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        report = build_report(repo)

    assert report["schema"] == "bot-errors-proof-ladder-report"
    assert report["schema_version"] == "0.2"
    assert report["serializationStatus"] == "emitted"
    assert report["requiredObservations"] == ["health_profiles", "managed_components", "runtime_manifest"]
    assert report["reportVerdict"] == "inconclusive"
    assert report["observations"]["runtime_manifest"]["status"] == "missing"
    assert report["observations"]["runtime_manifest"]["counts"]["observed_valid"] is None
    assert "repo" not in report
    assert "redaction" in report
    assert "summary" in report
    assert "observations" in report
    assert "components" in report
    assert "gaps" in report
    assert "proof_class_definitions" in report


def test_build_report_has_8_components():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        report = build_report(repo)
    assert report["summary"]["components"] == 8


def test_build_report_live_observation_not_probed_equals_8():
    # All 8 components must report live_observation=not_probed
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        report = build_report(repo)
    assert report["summary"]["live_observation_not_probed"] == 8, (
        f"Expected 8/8 not_probed, got {report['summary']['live_observation_not_probed']}"
    )


def test_build_report_redaction_field_prohibits_raw_paths_and_credentials():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        report = build_report(repo)
    redaction_note = report["redaction"]
    assert "absolute-path" in redaction_note, redaction_note
    assert "credential" in redaction_note, redaction_note


def test_build_report_source_status_keys_present():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        report = build_report(repo)
    ss = report["source_status"]
    assert "runtime_manifest" in ss
    assert "managed_components" in ss
    assert "health_profiles" in ss
    for key in ("runtime_manifest", "managed_components", "health_profiles"):
        assert "status" in ss[key], ss[key]
        assert "error_class" in ss[key], ss[key]


def test_build_report_missing_sources_reflected_in_source_status():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        report = build_report(repo)
    assert report["source_status"]["runtime_manifest"]["status"] == "missing"
    assert report["source_status"]["managed_components"]["status"] == "missing"


def test_build_report_invalid_json_sources_are_invalid_not_missing():
    # Fail-closed: malformed JSON must appear as invalid_json, not missing
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        (deploy / "bot-errors-runtime-manifest.json").write_text("{bad", encoding="utf-8")
        (deploy / "managed-components.json").write_text("{bad", encoding="utf-8")
        report = build_report(repo)
    assert report["source_status"]["runtime_manifest"]["status"] == "invalid_json"
    assert report["source_status"]["managed_components"]["status"] == "invalid_json"
    # Must NOT claim a valid zero inventory when the source is invalid.
    assert report["summary"]["runtime_manifest_files"] is None
    assert report["summary"]["managed_protective_services"] is None
    assert report["reportVerdict"] == "invalid"


def test_build_report_ok_sources_populate_summary_counts():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        manifest_data = {"files": [{"path": "a.py"}, {"path": "b.py"}]}
        managed_data = {
            "protective_services": {"entries": [{"name": "svc-a"}, {"name": "svc-b"}, {"name": "svc-c"}]}
        }
        (deploy / "bot-errors-runtime-manifest.json").write_text(json.dumps(manifest_data), encoding="utf-8")
        (deploy / "managed-components.json").write_text(json.dumps(managed_data), encoding="utf-8")
        report = build_report(repo)
    assert report["summary"]["runtime_manifest_files"] == 2
    assert report["summary"]["managed_protective_services"] == 3
    assert report["source_status"]["runtime_manifest"]["status"] == "observed"
    assert report["source_status"]["managed_components"]["status"] == "observed"


def test_build_report_proof_class_counts_in_summary():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        report = build_report(repo)
    pcc = report["summary"]["proof_class_counts"]
    assert isinstance(pcc, dict)
    # live_observation must appear with count 8 (one per component)
    assert pcc.get("live_observation") == 8, pcc


def test_build_report_gaps_are_present():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        report = build_report(repo)
    gaps = report["gaps"]
    assert isinstance(gaps, list)
    assert len(gaps) >= 1
    gap_ids = {g["gap"] for g in gaps}
    assert "live-observation-absent" in gap_ids, gap_ids


def test_build_report_suppresses_repo_and_head_identifiers():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        report = build_report(repo)
    assert "repo" not in report
    assert "head" not in report


# ---------------------------------------------------------------------------
# main() in-process — covers lines 212-221 (argparse + json.dump path)
# ---------------------------------------------------------------------------

def test_main_inprocess_emits_valid_json_for_missing_repo():
    orig_argv = sys.argv
    buf = io.StringIO()
    sys.argv = ["bot_errors_proof_ladder.py", "--repo", "/tmp/no-such-bot-errors-repo-inprocess"]
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["schema"] == "bot-errors-proof-ladder-report"
    assert report["summary"]["components"] == 8
    assert report["summary"]["live_observation_not_probed"] == 8


def test_main_inprocess_pretty_flag_emits_indented_output():
    orig_argv = sys.argv
    buf = io.StringIO()
    sys.argv = ["bot_errors_proof_ladder.py", "--repo", "/tmp/no-such-bot-errors-repo-inprocess", "--pretty"]
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
    assert rc == 0
    lines = buf.getvalue().splitlines()
    assert len(lines) > 10, "expected indented multi-line output"
    report = json.loads(buf.getvalue())
    assert report["schema"] == "bot-errors-proof-ladder-report"


# ---------------------------------------------------------------------------
# CLI e2e — covers __main__ path + --pretty flag
# ---------------------------------------------------------------------------

def test_cli_emits_valid_json_for_nonexistent_repo():
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--repo", "/tmp/no-such-bot-errors-repo"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["schema"] == "bot-errors-proof-ladder-report"
    assert report["summary"]["components"] == 8
    assert report["summary"]["live_observation_not_probed"] == 8


def test_cli_pretty_flag_emits_indented_json():
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--repo", "/tmp/no-such-bot-errors-repo", "--pretty"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    # --pretty output is indented; check the newline structure
    lines = proc.stdout.splitlines()
    assert len(lines) > 10, "expected many lines for pretty-printed output"
    report = json.loads(proc.stdout)
    assert report["schema"] == "bot-errors-proof-ladder-report"


def test_cli_strict_emits_report_and_fails_closed_for_missing_evidence():
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--repo", "/tmp/no-such-bot-errors-repo", "--strict"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.stdout, proc.stderr
    report = json.loads(proc.stdout)
    assert report["reportVerdict"] == "inconclusive", report
    assert proc.returncode == 2, proc.stderr


def test_cli_strict_accepts_complete_valid_sources():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        (deploy / "bot-errors-runtime-manifest.json").write_text(
            json.dumps({"files": [{"path": "deploy/scripts/probe.py"}]}), encoding="utf-8"
        )
        (deploy / "managed-components.json").write_text(
            json.dumps({"protective_services": {"entries": [{"name": "health-monitor"}]}}),
            encoding="utf-8",
        )
        profile = deploy / "health-profiles" / "profile.json"
        profile.parent.mkdir()
        profile.write_text(
            json.dumps({"expectQLoop": True, "expectDispatcher": True, "expectRuntimeManifest": True}),
            encoding="utf-8",
        )
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--repo", str(repo), "--strict"],
            capture_output=True, text=True, timeout=30,
        )
    report = json.loads(proc.stdout)
    assert proc.returncode == 0, proc.stderr
    assert report["reportVerdict"] == "valid", report
    assert report["summary"]["consistency_passed"] == report["summary"]["consistency_total"], report


def test_cli_with_malformed_json_repo_reports_invalid_not_crash():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        deploy = repo / "deploy"
        deploy.mkdir()
        (deploy / "bot-errors-runtime-manifest.json").write_text("{bad json}", encoding="utf-8")
        (deploy / "managed-components.json").write_text("{bad json}", encoding="utf-8")

        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--repo", str(repo)],
            capture_output=True, text=True, timeout=30,
        )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["source_status"]["runtime_manifest"]["status"] == "invalid_json"
    assert report["source_status"]["managed_components"]["status"] == "invalid_json"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} BOT ERRORS proof-ladder tests passed")
