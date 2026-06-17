#!/usr/bin/env python3
"""Tests for metadata-only compaction survival canaries."""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from compaction_survival_canary import Anchor, CanaryCase, ClaimGuard, ForbiddenPattern, build_report, evaluate_case  # noqa: E402


def assert_no_fixture_content(rendered: str, extra: list[str] | None = None) -> None:
    forbidden = [
        "sk-syntheticsecret9999",
        "pcsk_synthetic_secret9999",
        "RAW HIDDEN SYSTEM PROMPT: private body",
        "private transcript body",
        "full provider payload",
        "Raw credential canary",
        "stderr had pcsk",
    ]
    forbidden.extend(extra or [])
    for item in forbidden:
        assert item not in rendered, item


def test_default_canaries_pass_and_suppress_raw_payloads():
    report = build_report()
    rendered = json.dumps(report, sort_keys=True)
    assert report["schema"] == "agent-runtime-compaction-survival-canary", report
    assert report["summary"]["verdict"] == "pass", report
    assert report["summary"]["canary_count"] == 3, report
    assert report["summary"]["required_anchor_count"] == 11, report
    assert report["summary"]["observed_required_anchor_count"] == 11, report
    assert report["summary"]["forbidden_payload_hit_count"] == 0, report
    assert report["summary"]["plane_counts"]["evidence"] == 7, report
    assert report["summary"]["plane_counts"]["state"] == 3, report
    assert report["summary"]["plane_counts"]["safety"] == 1, report
    assert_no_fixture_content(rendered)


def test_missing_anchor_forbidden_payload_and_unsupported_claim_are_detected_safely():
    case = CanaryCase(
        canary_id="failure_fixture",
        source_kind="synthetic_source",
        compacted_kind="synthetic_compacted",
        source_text=(
            "R10 branch fix/agent-config-root-isolation-20260615 is not merged. "
            "Secret source token sk-failurefixture9999."
        ),
        compacted_text=(
            "R10 complete. The compressed note includes sk-failurefixture9999 and omits the branch."
        ),
        required_anchors=(
            Anchor("branch_ref", "evidence", (r"fix/agent-config-root-isolation-20260615",)),
            Anchor("merge_state", "state", (r"not merged",)),
        ),
        forbidden_patterns=(ForbiddenPattern("secret_shape", r"sk-failurefixture9999"),),
        claim_guards=(ClaimGuard("r10_complete_requires_qualifier", r"\bR10\b.*\bcomplete\b", r"not merged|pushed branch"),),
    )
    row = evaluate_case(case)
    rendered = json.dumps(row, sort_keys=True)
    assert row["verdict"] == "fail", row
    assert row["missing_required_anchor_count"] == 2, row
    assert row["forbidden_payload_hit_count"] == 1, row
    assert row["unsupported_claim_count"] == 1, row
    assert {item["anchor_ref"] for item in row["missing_required_anchor_refs"]} == {"branch_ref", "merge_state"}, row
    assert row["forbidden_payload_hit_refs"][0]["forbidden_ref"] == "secret_shape", row
    assert "sk-failurefixture9999" not in rendered, rendered
    assert "fix/agent-config-root-isolation" not in rendered, rendered
    assert "R10 complete" not in rendered, rendered


def test_artifact_loader_reduces_raw_handoff_to_metadata_only():
    with tempfile.TemporaryDirectory(prefix="compaction-canary-") as tmp_dir:
        root = Path(tmp_dir)
        artifact_path = root / "artifact.json"
        artifact = {
            "canaries": [
                {
                    "id": "artifact_case",
                    "source_kind": "session_handoff",
                    "compacted_kind": "compacted_summary",
                    "source": (
                        "Evidence row: /Users/testuser/private/path should not leak. "
                        "Decision D1 remains open. private transcript body. sk-artifactsecret9999"
                    ),
                    "summary": "Decision D1 remains open; private transcript and secret bodies suppressed.",
                    "anchors": [
                        {"id": "decision_d1_open", "plane": "state", "patterns": ["Decision D1 remains open"]},
                    ],
                    "forbidden_patterns": [
                        {"id": "raw_path", "pattern": r"/Users/testuser/private/path"},
                        {"id": "raw_transcript", "pattern": "private transcript body"},
                        {"id": "secret_shape", "pattern": "sk-artifactsecret9999"},
                    ],
                }
            ]
        }
        artifact_path.write_text(json.dumps(artifact), encoding="utf-8")
        report = build_report(artifact_path=artifact_path)
        rendered = json.dumps(report, sort_keys=True)
        assert report["summary"]["verdict"] == "pass", report
        assert report["artifact"]["status"] == "loaded", report
        assert report["artifact"]["case_count"] == 1, report
        assert report["summary"]["source_missing_anchor_count"] == 0, report
        assert report["summary"]["missing_required_anchor_count"] == 0, report
        assert str(root) not in rendered, rendered
        assert "/Users/testuser/private/path" not in rendered, rendered
        assert_no_fixture_content(rendered, ["sk-artifactsecret9999", "Decision D1 remains open"])


def test_cli_default_is_provider_free_and_passes():
    result = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parents[1] / "compaction_survival_canary.py"),
            "--pretty",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads(result.stdout)
    assert result.stderr == "", result.stderr
    assert report["summary"]["verdict"] == "pass", report
    assert report["artifact"]["status"] == "synthetic_defaults", report


def test_safe_ref_hashes_invalid_identifier():
    """UNHAPPY_TEST: safe_ref must hash identifiers that fail SAFE_ID or contain secret shapes."""
    from compaction_survival_canary import safe_ref
    # identifier with spaces fails SAFE_ID — must be hashed
    hashed = safe_ref("has spaces here")
    assert hashed.startswith("sha256:"), hashed
    assert "has spaces here" not in hashed, hashed


def test_safe_ref_hashes_secret_shaped_identifier():
    """UNHAPPY_TEST: safe_ref must hash identifiers that look like secrets."""
    from compaction_survival_canary import safe_ref
    # secret-shaped value should be hashed, not returned verbatim
    result = safe_ref("sk-somesecretvalue1234")
    assert result.startswith("sha256:"), result
    assert "sk-somesecretvalue1234" not in result, result


def test_pattern_matches_malformed_regex_returns_error():
    """UNHAPPY_TEST: malformed regex must return (False, error_class_name) not raise."""
    from compaction_survival_canary import pattern_matches
    matched, error_class = pattern_matches(r"[invalid(", "some text")
    assert matched is False, (matched, error_class)
    assert error_class is not None, (matched, error_class)
    assert "error" in error_class.lower(), (matched, error_class)


def test_anchor_status_with_invalid_pattern_records_error():
    """UNHAPPY_TEST: an anchor with a malformed regex pattern produces invalid_patterns entries and source_ok=False."""
    from compaction_survival_canary import Anchor, anchor_status
    anchor = Anchor("bad_anchor", "evidence", (r"[broken(", r"good_pattern"))
    result = anchor_status(anchor, "good_pattern is here", "good_pattern is here")
    # The invalid pattern should be recorded
    assert len(result["invalid_patterns"]) == 1, result
    assert result["invalid_patterns"][0]["pattern_index"] == 0, result
    assert result["invalid_patterns"][0]["error_class"] is not None, result


def test_anchor_status_source_missing_when_pattern_not_in_source():
    """UNHAPPY_TEST: anchor not present in source sets source_present=False."""
    from compaction_survival_canary import Anchor, anchor_status
    anchor = Anchor("missing_anchor", "evidence", (r"this_phrase_is_absent",))
    result = anchor_status(anchor, "source has other content", "compacted has other content")
    assert result["source_present"] is False, result
    assert result["compacted_present"] is False, result


def test_evaluate_case_source_missing_anchor_fail_reason():
    """UNHAPPY_TEST: anchor missing in source triggers source_missing_required_anchor fail_reason."""
    case = CanaryCase(
        canary_id="source_missing_test",
        source_kind="synthetic_source",
        compacted_kind="synthetic_compacted",
        source_text="The compacted text has anchor_phrase but the source does not.",
        compacted_text="anchor_phrase is here in compacted.",
        required_anchors=(
            Anchor("phantom_anchor", "evidence", (r"anchor_phrase_absent_from_source",)),
        ),
    )
    row = evaluate_case(case)
    assert "source_missing_required_anchor" in row["fail_reasons"], row
    assert row["verdict"] == "fail", row
    assert row["source_missing_anchor_count"] == 1, row
    assert len(row["source_missing_anchor_refs"]) == 1, row
    assert row["source_missing_anchor_refs"][0]["anchor_ref"] == "phantom_anchor", row


def test_evaluate_case_invalid_pattern_fail_reason():
    """UNHAPPY_TEST: malformed regex in anchor triggers invalid_pattern fail_reason."""
    case = CanaryCase(
        canary_id="invalid_pattern_test",
        source_kind="synthetic_source",
        compacted_kind="synthetic_compacted",
        source_text="some source text",
        compacted_text="some compacted text",
        required_anchors=(
            Anchor("bad_regex_anchor", "evidence", (r"[unclosed(",)),
        ),
    )
    row = evaluate_case(case)
    assert "invalid_pattern" in row["fail_reasons"], row
    assert row["verdict"] == "fail", row
    assert row["invalid_pattern_count"] >= 1, row


def test_anchor_from_dict_patterns_as_string():
    """UNHAPPY_TEST: anchor_from_dict handles patterns supplied as a bare string, not list."""
    from compaction_survival_canary import anchor_from_dict
    result = anchor_from_dict({"id": "a1", "plane": "evidence", "patterns": "bare_string_pattern"}, 0)
    assert result.patterns == ("bare_string_pattern",), result.patterns
    assert result.anchor_id == "a1", result


def test_anchor_from_dict_patterns_as_invalid_type_produces_empty():
    """UNHAPPY_TEST: anchor_from_dict with patterns=None/int/bool produces empty patterns tuple."""
    from compaction_survival_canary import anchor_from_dict
    result = anchor_from_dict({"id": "a2", "plane": "state", "patterns": 42}, 1)
    assert result.patterns == (), result.patterns


def test_claim_guard_from_dict_builds_correct_object():
    """Cover claim_guard_from_dict body: parse claim_id, claim_pattern, required_qualifier_pattern."""
    from compaction_survival_canary import claim_guard_from_dict
    result = claim_guard_from_dict(
        {
            "claim_id": "guard_1",
            "claim_pattern": r"\bcomplete\b",
            "required_qualifier_pattern": r"not merged",
        },
        0,
    )
    assert result.claim_id == "guard_1", result
    assert result.claim_pattern == r"\bcomplete\b", result
    assert result.required_qualifier_pattern == "not merged", result


def test_claim_guard_from_dict_uses_fallback_id():
    """Cover claim_guard_from_dict fallback when neither claim_id nor id is present."""
    from compaction_survival_canary import claim_guard_from_dict
    result = claim_guard_from_dict({"claim_pattern": r"\bdone\b", "required_qualifier_pattern": r"pushed"}, 3)
    assert result.claim_id == "claim_3", result


def test_load_artifact_missing_file_returns_error_status():
    """UNHAPPY_TEST: missing artifact file triggers status=missing and empty cases."""
    from compaction_survival_canary import load_artifact
    cases, meta = load_artifact(Path("/nonexistent/path/canary_artifact_xyz.json"))
    assert meta["status"] == "missing", meta
    assert cases == (), cases


def test_load_artifact_invalid_json_returns_error_status():
    """UNHAPPY_TEST: artifact with malformed JSON triggers status=invalid_json."""
    from compaction_survival_canary import load_artifact
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write("this is not json {{{")
        name = f.name
    try:
        cases, meta = load_artifact(Path(name))
        assert meta["status"] == "invalid_json", meta
        assert "error_class" in meta, meta
        assert cases == (), cases
    finally:
        os.unlink(name)


def test_load_artifact_list_toplevel_loads_cases():
    """Cover load_artifact branch where JSON root is a list of case dicts."""
    from compaction_survival_canary import load_artifact
    artifact_list = [
        {
            "id": "list_case",
            "source_kind": "list_source",
            "compacted_kind": "list_compacted",
            "source": "Evidence phrase alpha is confirmed.",
            "summary": "Evidence phrase alpha is confirmed in compacted.",
            "anchors": [{"id": "alpha", "plane": "evidence", "patterns": ["Evidence phrase alpha"]}],
        }
    ]
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        json.dump(artifact_list, f)
        name = f.name
    try:
        cases, meta = load_artifact(Path(name))
        assert meta["status"] == "loaded", meta
        assert meta["case_count"] == 1, meta
        assert len(cases) == 1, cases
    finally:
        os.unlink(name)


def test_load_artifact_nondict_nonlist_root_returns_empty():
    """UNHAPPY_TEST: artifact with JSON root that is not dict or list yields no cases."""
    from compaction_survival_canary import load_artifact
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        json.dump("just_a_string", f)
        name = f.name
    try:
        cases, meta = load_artifact(Path(name))
        assert meta["status"] == "loaded", meta
        assert meta["case_count"] == 0, meta
        assert cases == (), cases
    finally:
        os.unlink(name)


def test_build_report_missing_artifact_increments_fail_count():
    """UNHAPPY_TEST: missing artifact_path causes fail_count to increment in build_report summary."""
    report = build_report(artifact_path=Path("/nonexistent/missing_artifact_xyz.json"))
    assert report["summary"]["verdict"] == "fail", report
    assert report["summary"]["fail_count"] >= 1, report
    assert report["artifact"]["status"] == "missing", report
    # fail_reason_counts should include artifact_missing
    assert "artifact_missing" in report["summary"]["fail_reason_counts"], report


def test_build_report_invalid_json_artifact_increments_fail_count():
    """UNHAPPY_TEST: artifact with invalid JSON produces verdict=fail with artifact_invalid_json reason."""
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write("not valid json !!!")
        name = f.name
    try:
        report = build_report(artifact_path=Path(name))
        assert report["summary"]["verdict"] == "fail", report
        assert report["artifact"]["status"] == "invalid_json", report
        assert "artifact_invalid_json" in report["summary"]["fail_reason_counts"], report
    finally:
        os.unlink(name)


def test_main_exits_zero_on_default_canaries():
    """CLI e2e: main() exits 0 when all default canaries pass; JSON shape is well-formed."""
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve().parents[1] / "compaction_survival_canary.py")],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (result.returncode, result.stderr)
    report = json.loads(result.stdout)
    assert report["schema"] == "agent-runtime-compaction-survival-canary", report
    assert report["summary"]["verdict"] == "pass", report
    assert "canaries" in report, report
    assert report["summary"]["canary_count"] >= 3, report


def test_main_nonzero_exit_on_missing_artifact():
    """UNHAPPY_TEST nonzero exit: main() exits 2 when artifact path is missing (fail verdict)."""
    result = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parents[1] / "compaction_survival_canary.py"),
            "--artifact", "/nonexistent/totally_missing_canary.json",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2, (result.returncode, result.stderr)
    report = json.loads(result.stdout)
    assert report["summary"]["verdict"] == "fail", report
    assert report["artifact"]["status"] == "missing", report


def test_determinism_same_input_produces_identical_output():
    """Determinism: calling build_report() twice with same synthetic cases gives identical JSON."""
    report1 = build_report()
    report2 = build_report()
    dumped1 = json.dumps(report1, sort_keys=True)
    dumped2 = json.dumps(report2, sort_keys=True)
    assert dumped1 == dumped2, "build_report is non-deterministic"


def test_forbidden_payload_suppressed_in_artifact_loaded_case():
    """UNHAPPY_TEST: forbidden pattern that appears in compacted text causes fail + forbidden_hits without leaking raw text."""
    with tempfile.TemporaryDirectory(prefix="compaction-canary-forbidden-") as tmp_dir:
        artifact_path = Path(tmp_dir) / "forbidden_hit.json"
        artifact = {
            "canaries": [
                {
                    "id": "leak_test",
                    "source_kind": "synth_src",
                    "compacted_kind": "synth_compacted",
                    "source": "Source contains secret_token_xyz12345 and some info.",
                    "summary": "Compacted leaked the raw token: secret_token_xyz12345 here.",
                    "anchors": [
                        {"id": "info_present", "plane": "evidence", "patterns": ["some info"]}
                    ],
                    "forbidden_patterns": [
                        {"id": "raw_secret", "pattern": "secret_token_xyz12345"}
                    ],
                }
            ]
        }
        artifact_path.write_text(json.dumps(artifact), encoding="utf-8")
        report = build_report(artifact_path=artifact_path)
        rendered = json.dumps(report, sort_keys=True)
        assert report["summary"]["verdict"] == "fail", report
        assert report["summary"]["forbidden_payload_hit_count"] == 1, report
        # The raw secret must not appear in the rendered report
        assert "secret_token_xyz12345" not in rendered, rendered


def test_parse_args_defaults_to_no_artifact_and_no_pretty():
    """Cover parse_args() body: defaults return artifact=None, pretty=False."""
    import sys as _sys
    from compaction_survival_canary import parse_args
    orig_argv = _sys.argv[:]
    _sys.argv = ["compaction_survival_canary.py"]
    try:
        args = parse_args()
        assert args.artifact is None, args
        assert args.pretty is False, args
    finally:
        _sys.argv = orig_argv


def test_parse_args_accepts_pretty_flag():
    """Cover parse_args() --pretty branch."""
    import sys as _sys
    from compaction_survival_canary import parse_args
    orig_argv = _sys.argv[:]
    _sys.argv = ["compaction_survival_canary.py", "--pretty"]
    try:
        args = parse_args()
        assert args.pretty is True, args
    finally:
        _sys.argv = orig_argv


def test_main_returns_zero_on_passing_report():
    """Cover main() body: exits 0 when default canaries pass; output is valid JSON."""
    import io
    import sys as _sys
    from compaction_survival_canary import main
    orig_argv = _sys.argv[:]
    _sys.argv = ["compaction_survival_canary.py"]
    buf = io.StringIO()
    orig_stdout = _sys.stdout
    _sys.stdout = buf
    try:
        rc = main()
    finally:
        _sys.stdout = orig_stdout
        _sys.argv = orig_argv
    assert rc == 0, rc
    report = json.loads(buf.getvalue())
    assert report["summary"]["verdict"] == "pass", report


def test_main_returns_two_on_missing_artifact():
    """UNHAPPY_TEST nonzero: main() returns 2 when artifact is missing (fail verdict)."""
    import io
    import sys as _sys
    from compaction_survival_canary import main
    orig_argv = _sys.argv[:]
    _sys.argv = ["compaction_survival_canary.py", "--artifact", "/nonexistent/missing_artifact_abc.json"]
    buf = io.StringIO()
    orig_stdout = _sys.stdout
    _sys.stdout = buf
    try:
        rc = main()
    finally:
        _sys.stdout = orig_stdout
        _sys.argv = orig_argv
    assert rc == 2, rc
    report = json.loads(buf.getvalue())
    assert report["summary"]["verdict"] == "fail", report


def test_risky_claim_without_qualifier_detected_as_unsupported():
    """UNHAPPY_TEST: compacted text with risky completion claim but no qualifier → unsupported_claim."""
    case = CanaryCase(
        canary_id="risky_claim_test",
        source_kind="synthetic_source",
        compacted_kind="synthetic_compacted",
        source_text="Task alpha is in progress. Branch pushed but not merged.",
        compacted_text="Task alpha is complete. All work done.",
        required_anchors=(
            Anchor("in_progress_evidence", "state", (r"in progress",)),
        ),
        claim_guards=(
            ClaimGuard("alpha_complete_needs_qualifier", r"\bcomplete\b", r"not merged|still pending"),
        ),
    )
    row = evaluate_case(case)
    assert "unsupported_claim" in row["fail_reasons"], row
    assert row["unsupported_claim_count"] == 1, row
    assert row["verdict"] == "fail", row
    rendered = json.dumps(row, sort_keys=True)
    # raw source/compacted text must not be in output
    assert "Task alpha is in progress" not in rendered, rendered
    assert "Task alpha is complete" not in rendered, rendered


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} compaction survival canary tests passed")
