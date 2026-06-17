#!/usr/bin/env python3
"""Tests for metadata-only Loom memory-line probe."""

import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import loom_memory_line_probe as probe  # noqa: E402
from loom_memory_line_probe import (  # noqa: E402
    CAPABILITY_FILES,
    build_report,
    count_files,
    count_test_functions,
    git_metadata,
    line_ref,
    main,
    parse_metrics,
    parse_pytest_summary,
    rel,
    run_pytest,
    source_ref_resolver_status,
)

PROBE_PATH = Path(__file__).resolve().parents[1] / "loom_memory_line_probe.py"


def write(path: Path, text: str = "placeholder\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def fixture_loom(root: Path) -> None:
    for refs in CAPABILITY_FILES.values():
        for ref in refs:
            write(root / ref)
    write(
        root / "README.md",
        "Status: Design complete, code not yet started. sk-readmesecret9999\n",
    )
    write(
        root / "loom/contracts/memory_note.py",
        "def injection_too_broad(sensitivity, allowed_injection):\n    return False\n\ndef validate_memory_note(meta):\n    return None\n",
    )
    write(
        root / "loom/vault/admission.py",
        "_SSOT_REGISTRY = 'secret-patterns.json'\n\ndef admit(meta, body):\n    return meta.get('source_refs')[0].get('resolver_status')\n",
    )
    write(
        root / "loom/governance/lint.py",
        "def lint_note(meta, now=None):\n    refs = meta.get('source_refs')\n    return refs\n",
    )
    write(
        root / "loom/governance/conflict.py",
        "def detect_conflicts(notes):\n    return []\n",
    )
    write(
        root / "loom/governance/source_refs.py",
        "def resolve_source_ref(ref):\n    return {'resolver_status': 'verified'}\n\n"
        "def all_source_refs_verified(refs):\n    return True\n",
    )
    write(
        root / "loom/pipeline.py",
        "def admit_note(meta, body, vault=None, now=None):\n    return None\n",
    )
    write(
        root / "loom/mcp/server.py",
        "TOOLS = ['memory_search', 'memory_get']\n",
    )
    write(
        root / "tests/governance/test_lint.py",
        "def test_source_refs_required():\n    assert True\n",
    )
    write(
        root / "tests/governance/test_conflict.py",
        "def test_conflict_detector():\n    assert True\n",
    )
    write(
        root / "tests/governance/test_source_refs.py",
        "def test_source_ref_resolver():\n    assert True\n",
    )
    write(
        root / "tests/vault/test_admission.py",
        "def test_resolver_status_verified():\n    resolver_status = 'verified'\n    assert resolver_status\n",
    )
    metrics = root / ".loom-poller/metrics.jsonl"
    metrics.parent.mkdir(parents=True, exist_ok=True)
    metrics.write_text(
        json.dumps({
            "passed": True,
            "coverage_pct": 100.0,
            "cov_min": 100,
            "gates": {"ruff": True, "pytest+coverage": True, "mutation": True},
            "mutation": {"killed": 7, "total": 7},
            "sidecar": "secret-sidecar-name-should-be-hashed",
        })
        + "\n"
        + json.dumps({
            "passed": True,
            "coverage_pct": 100.0,
            "cov_min": 100,
            "gates": {"ruff": True, "pytest+coverage": True},
            "mutation": None,
            "sidecar": "agent-runtime-n6-recapture",
        })
        + "\n",
        encoding="utf-8",
    )


def test_battery_metrics_counts_invalid_json_lines():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        fixture_loom(root)
        metrics = root / ".loom-poller/metrics.jsonl"
        metrics.write_text("{not json}\n" + metrics.read_text(encoding="utf-8"), encoding="utf-8")
        report = build_report(root)
        assert report["loom_metrics"]["invalid_json_lines"] == 1, report["loom_metrics"]


def assert_no_fixture_content(rendered: str, root: Path) -> None:
    for forbidden in [
        str(root),
        "sk-readmesecret9999",
        "secret-sidecar-name-should-be-hashed",
        "Design complete, code not yet started",
        "_SSOT_REGISTRY",
        "resolver_status = 'verified'",
    ]:
        assert forbidden not in rendered, forbidden


def test_loom_memory_line_probe_maps_capabilities_and_findings_without_raw_content():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        fixture_loom(root)
        report = build_report(root)
        rendered = json.dumps(report, sort_keys=True)
        assert report["schema"] == "agent-runtime-loom-memory-line", report
        assert report["summary"]["capability_status_counts"] == {"present_with_tests": len(CAPABILITY_FILES)}, report
        assert report["summary"]["source_ref_resolver_status"] == "dedicated_resolver_present", report
        assert report["summary"]["latest_metrics_passed"] is True, report
        assert report["summary"]["latest_metrics_has_mutation"] is False, report
        assert report["summary"]["latest_mutation_killed"] == 7, report
        assert {item["code"] for item in report["findings"]} == {
            "latest_battery_record_without_mutation",
            "loom_readme_status_stale",
        }, report
        assert report["line_refs"]["pipeline_admit_note"]["found"] is True, report
        assert report["line_refs"]["source_ref_resolver"]["found"] is True, report
        assert_no_fixture_content(rendered, root)


def test_source_ref_resolver_missing_module_reports_gate_only_status():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        fixture_loom(root)
        (root / "loom/governance/source_refs.py").unlink()
        (root / "tests/governance/test_source_refs.py").unlink()
        status = source_ref_resolver_status(root)
        rendered = json.dumps(status, sort_keys=True)
        assert status["status"] == "contract_and_admission_gate_only", status
        assert "resolve_source_ref" not in rendered, rendered
        assert str(root) not in rendered, rendered


def test_parse_pytest_summary_keeps_only_counts():
    parsed = parse_pytest_summary("some banner\n330 passed, 2 skipped in 0.88s\nsecret body\n")
    rendered = json.dumps(parsed, sort_keys=True)
    assert parsed["status"] == "parsed", parsed
    assert parsed["passed"] == 330, parsed
    assert parsed["skipped"] == 2, parsed
    assert parsed["seconds"] == 0.88, parsed
    assert "secret body" not in rendered, rendered


def test_latest_failed_battery_record_is_a_high_finding():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        fixture_loom(root)
        metrics = root / ".loom-poller/metrics.jsonl"
        with metrics.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "passed": False,
                "coverage_pct": 98.0,
                "cov_min": 100,
                "gates": {"ruff": True, "pytest+coverage": False},
                "mutation": {"killed": 7, "total": 7},
                "sidecar": "failed-sidecar-secret",
            }) + "\n")
        report = build_report(root)
        rendered = json.dumps(report, sort_keys=True)
        codes = {item["code"] for item in report["findings"]}
        assert "latest_battery_record_failed" in codes, report
        assert report["summary"]["severity_counts"]["high"] == 1, report
        assert "failed-sidecar-secret" not in rendered, rendered


def test_loom_memory_line_cli_with_fixture_root_is_metadata_only():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        fixture_loom(root)
        result = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve().parents[1] / "loom_memory_line_probe.py"),
                "--root",
                str(root),
                "--pretty",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        report = json.loads(result.stdout)
        assert result.stderr == "", result.stderr
        assert report["schema"] == "agent-runtime-loom-memory-line", report
        assert report["summary"]["capability_count"] == len(CAPABILITY_FILES), report
        assert_no_fixture_content(json.dumps(report, sort_keys=True), root)


def test_rel_returns_posix_path_when_under_root():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        assert rel(root / "loom" / "pipeline.py", root) == "loom/pipeline.py"


def test_rel_falls_back_to_sha_hash_when_path_outside_root():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        outside = Path("/some/other/absolute/elsewhere.py")
        out = rel(outside, root)
        # Fail-closed: never leak the absolute outside path; emit a hash instead.
        assert out.startswith("sha256:"), out
        assert len(out) == len("sha256:") + 16, out
        assert "/some/other/absolute" not in out, out


def test_count_files_returns_zero_for_missing_directory():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        assert count_files(root, "loom") == 0


def test_count_files_skips_pycache_and_venv_and_counts_real_modules():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        write(root / "loom/a.py")
        write(root / "loom/sub/b.py")
        write(root / "loom/__pycache__/cached.py")
        write(root / "loom/.venv/lib/vendored.py")
        write(root / "loom/notes.md")
        assert count_files(root, "loom") == 2


def test_count_test_functions_returns_zero_for_missing_tests_dir():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        assert count_test_functions(root) == 0


def test_count_test_functions_counts_defs_and_skips_pycache():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        write(root / "tests/test_x.py", "def test_a():\n    pass\n\ndef test_b():\n    pass\n")
        write(root / "tests/__pycache__/test_cached.py", "def test_ignored():\n    pass\n")
        assert count_test_functions(root) == 2


def test_git_metadata_non_repo_reports_not_a_repo_without_absolute_path():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        meta = git_metadata(root)
        rendered = json.dumps(meta, sort_keys=True)
        assert meta["is_git_repo"] is False, meta
        assert "root_sha256_16" in meta and len(meta["root_sha256_16"]) == 16, meta
        assert str(root) not in rendered, rendered


def test_git_metadata_real_repo_emits_counts_not_paths_or_diffs():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        subprocess.run(["git", "-C", str(root), "init", "-q"], check=True)
        subprocess.run(["git", "-C", str(root), "config", "user.email", "t@t"], check=True)
        subprocess.run(["git", "-C", str(root), "config", "user.name", "t"], check=True)
        write(root / "tracked.py", "x = 1\n")
        subprocess.run(["git", "-C", str(root), "add", "tracked.py"], check=True)
        subprocess.run(["git", "-C", str(root), "commit", "-q", "-m", "init"], check=True)
        # Create one untracked + one modified to exercise status code counting.
        write(root / "tracked.py", "x = 2\n")
        write(root / "untracked-secret.py", "sk-shouldnotleak0000\n")
        meta = git_metadata(root)
        rendered = json.dumps(meta, sort_keys=True)
        assert meta["is_git_repo"] is True, meta
        assert isinstance(meta["branch"], str) and meta["branch"], meta
        assert isinstance(meta["head_short"], str) and len(meta["head_short"]) == 12, meta
        assert meta["dirty_entry_count"] == 2, meta
        assert isinstance(meta["status_code_counts"], dict), meta
        assert sum(meta["status_code_counts"].values()) == 2, meta
        # Redaction: no absolute paths, no filenames, no secret-shaped values.
        assert str(root) not in rendered, rendered
        assert "untracked-secret.py" not in rendered, rendered
        assert "sk-shouldnotleak0000" not in rendered, rendered


def test_line_ref_missing_file_reports_not_found_without_path():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        row = line_ref(root, "lbl", "loom/absent.py", r"def whatever")
        rendered = json.dumps(row, sort_keys=True)
        assert row["found"] is False, row
        assert row["line"] is None, row
        assert row["line_sha256_16"] is None, row
        assert len(row["path_sha256_16"]) == 16, row
        assert str(root) not in rendered, rendered


def test_line_ref_present_file_without_match_reports_not_found():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        write(root / "loom/present.py", "def something_else():\n    return 1\n")
        row = line_ref(root, "lbl", "loom/present.py", r"def the_target_symbol")
        assert row["found"] is False, row
        assert row["line"] is None, row


def test_line_ref_match_emits_line_number_and_hash_not_raw_source():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        write(root / "loom/m.py", "header\ndef validate_memory_note(meta):  # secretpasswordvalue\n    pass\n")
        row = line_ref(root, "lbl", "loom/m.py", r"def validate_memory_note")
        rendered = json.dumps(row, sort_keys=True)
        assert row["found"] is True, row
        assert row["line"] == 2, row
        assert len(row["line_sha256_16"]) == 16, row
        # Redaction: emit the hash, never the raw source line text.
        assert "validate_memory_note(meta)" not in rendered, rendered
        assert "secretpasswordvalue" not in rendered, rendered


def test_parse_metrics_missing_file_reports_not_exists_zero_records():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        row = parse_metrics(root)
        rendered = json.dumps(row, sort_keys=True)
        assert row["exists"] is False, row
        assert row["record_count"] == 0, row
        assert row["latest"] is None, row
        assert row["latest_with_mutation"] is None, row
        assert row["invalid_json_lines"] == 0, row
        assert str(root) not in rendered, rendered


def test_parse_metrics_skips_blank_lines_and_keeps_record_count():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        metrics = root / ".loom-poller/metrics.jsonl"
        metrics.parent.mkdir(parents=True, exist_ok=True)
        metrics.write_text(
            "\n   \n"
            + json.dumps({"passed": True, "gates": {"ruff": True}, "sidecar": "s"})
            + "\n\n",
            encoding="utf-8",
        )
        row = parse_metrics(root)
        assert row["exists"] is True, row
        assert row["record_count"] == 1, row
        assert row["invalid_json_lines"] == 0, row
        assert row["latest"]["passed"] is True, row


def test_parse_pytest_summary_unparseable_text_reports_not_parsed_only_byte_count():
    text = "internal error traceback with secret token sk-pytestleak0000 and no summary line"
    parsed = parse_pytest_summary(text)
    rendered = json.dumps(parsed, sort_keys=True)
    # Fail-closed: malformed/unrecognized output is a typed not_parsed, never a silent pass.
    assert parsed["status"] == "not_parsed", parsed
    assert parsed["stdout_bytes"] == len(text.encode("utf-8")), parsed
    assert "passed" not in parsed, parsed
    assert "sk-pytestleak0000" not in rendered, rendered


def test_run_pytest_parses_passing_run_through_mocked_subprocess():
    class _Proc:
        returncode = 0
        stdout = "5 passed in 0.42s\n"
        stderr = ""

    orig = probe.subprocess.run
    probe.subprocess.run = lambda *a, **k: _Proc()
    try:
        with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
            result = run_pytest(Path(tmp_dir))
    finally:
        probe.subprocess.run = orig
    assert result["status"] == "passed", result
    assert result["rc"] == 0, result
    assert result["passed"] == 5, result


def test_run_pytest_failing_run_reports_failed_status_and_nonzero_rc():
    class _Proc:
        returncode = 1
        stdout = "1 failed, 2 passed in 0.10s\n"
        stderr = ""

    orig = probe.subprocess.run
    probe.subprocess.run = lambda *a, **k: _Proc()
    try:
        with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
            result = run_pytest(Path(tmp_dir))
    finally:
        probe.subprocess.run = orig
    assert result["status"] == "failed", result
    assert result["rc"] == 1, result


def test_source_ref_resolver_status_skips_missing_gate_files():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        # No loom/ or tests/ files at all -> dedicated absent + no hits -> "absent".
        status = source_ref_resolver_status(root)
        rendered = json.dumps(status, sort_keys=True)
        assert status["status"] == "absent", status
        assert status["resolver_status_hit_count"] == 0, status
        assert status["resolver_status_refs"] == [], status
        assert str(root) not in rendered, rendered


def test_build_report_emits_source_ref_resolver_not_dedicated_finding():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        fixture_loom(root)
        # Remove the dedicated resolver module but keep its gate signal in admission.
        (root / "loom/governance/source_refs.py").unlink()
        (root / "tests/governance/test_source_refs.py").unlink()
        report = build_report(root)
        codes = {item["code"] for item in report["findings"]}
        assert "source_ref_resolver_not_dedicated" in codes, report
        finding = next(f for f in report["findings"] if f["code"] == "source_ref_resolver_not_dedicated")
        assert finding["severity"] == "medium", finding
        assert finding["evidence"]["status"] == "contract_and_admission_gate_only", finding


def test_build_report_run_tests_failed_pytest_yields_high_finding_and_redaction():
    class _Proc:
        returncode = 1
        stdout = "collected\n1 failed in 0.01s\nsecret-traceback-body sk-pytestbody0000\n"
        stderr = ""

    orig = probe.subprocess.run
    probe.subprocess.run = lambda *a, **k: _Proc()
    try:
        with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
            root = Path(tmp_dir)
            fixture_loom(root)
            report = build_report(root, run_tests=True)
    finally:
        probe.subprocess.run = orig
    rendered = json.dumps(report, sort_keys=True)
    assert report["pytest"]["status"] == "failed", report["pytest"]
    assert report["summary"]["pytest_status"] == "failed", report["summary"]
    codes = {item["code"] for item in report["findings"]}
    assert "loom_pytest_failed" in codes, report
    assert report["summary"]["severity_counts"]["high"] >= 1, report["summary"]
    # Redaction: pytest stdout body / secrets never surface; only counts/bytes.
    assert "secret-traceback-body" not in rendered, rendered
    assert "sk-pytestbody0000" not in rendered, rendered


def test_build_report_run_tests_passing_sets_pytest_passed_count():
    class _Proc:
        returncode = 0
        stdout = "12 passed in 0.30s\n"
        stderr = ""

    orig = probe.subprocess.run
    probe.subprocess.run = lambda *a, **k: _Proc()
    try:
        with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
            root = Path(tmp_dir)
            fixture_loom(root)
            report = build_report(root, run_tests=True)
    finally:
        probe.subprocess.run = orig
    assert report["summary"]["pytest_status"] == "passed", report["summary"]
    assert report["summary"]["pytest_passed"] == 12, report["summary"]
    assert "loom_pytest_failed" not in {f["code"] for f in report["findings"]}, report


def test_main_in_process_returns_zero_on_no_high_findings():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        fixture_loom(root)
        orig_argv = sys.argv
        sys.argv = ["loom_memory_line_probe.py", "--root", str(root)]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = main()
        finally:
            sys.argv = orig_argv
        assert rc == 0, rc
        report = json.loads(buf.getvalue())
        rendered = buf.getvalue()
        assert report["schema"] == "agent-runtime-loom-memory-line", report
        assert report["summary"]["pytest_status"] == "not_run", report
        assert_no_fixture_content(rendered, root)


def test_main_in_process_returns_two_when_high_severity_finding_present():
    with tempfile.TemporaryDirectory(prefix="loom-memory-line-") as tmp_dir:
        root = Path(tmp_dir)
        fixture_loom(root)
        metrics = root / ".loom-poller/metrics.jsonl"
        with metrics.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "passed": False,
                "gates": {"ruff": True, "pytest+coverage": False},
                "mutation": {"killed": 1, "total": 2},
                "sidecar": "main-high-secret",
            }) + "\n")
        orig_argv = sys.argv
        sys.argv = ["loom_memory_line_probe.py", "--root", str(root), "--pretty"]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = main()
        finally:
            sys.argv = orig_argv
        # Fail-closed exit: a high-severity finding must drive a nonzero exit.
        assert rc == 2, rc
        report = json.loads(buf.getvalue())
        assert "main-high-secret" not in buf.getvalue(), buf.getvalue()
        assert report["summary"]["severity_counts"].get("high", 0) >= 1, report


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} Loom memory-line probe tests passed")
