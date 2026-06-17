#!/usr/bin/env python3
"""Tests for corpus_guard probe hygiene checks."""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json
import subprocess

from corpus_guard import check_fail_open_scan, check_lean_corpus, check_probe_hygiene  # noqa: E402


def write_probe(root: Path, name: str, body: str) -> None:
    path = root / name
    path.write_text(body, encoding="utf-8")


def write_readme(root: Path, rows: list[str]) -> None:
    lines = ["# Test Probes", "", "## Scripts", "", "| Script | Purpose | Provider call by default? |", "|---|---|---|"]
    lines.extend(f"| `{row}` | test fixture | No |" for row in rows)
    lines.append("")
    root.joinpath("README.md").write_text("\n".join(lines), encoding="utf-8")


def violation(report: dict, kind: str) -> dict | None:
    return next((item for item in report["violations"] if item["kind"] == kind), None)


def test_redaction_discipline_is_high_severity():
    with tempfile.TemporaryDirectory(prefix="corpus-guard-test-") as tmp_dir:
        root = Path(tmp_dir)
        (root / "tests").mkdir()
        write_probe(root, "bad_probe.py", 'SCHEMA_VERSION = "0.1"\nprint("x")\n')
        write_probe(root, "good_probe.py", 'SCHEMA_VERSION = "0.1"\nREPORT = {"redaction": "metadata-only"}\n')
        write_readme(root, ["bad_probe.py", "good_probe.py"])

        report = check_probe_hygiene(root)
        item = violation(report, "redaction_discipline")
        assert report["severity"] == "high", report
        assert item is not None, report
        assert item["severity"] == "high", item
        assert item["probes"] == ["bad_probe.py"], item


def test_schema_version_consistency_flags_malformed_values():
    with tempfile.TemporaryDirectory(prefix="corpus-guard-test-") as tmp_dir:
        root = Path(tmp_dir)
        (root / "tests").mkdir()
        write_probe(root, "bad_schema.py", 'SCHEMA_VERSION = "v1"\nREPORT = {"redaction": "metadata-only"}\n')
        write_readme(root, ["bad_schema.py"])

        report = check_probe_hygiene(root)
        item = violation(report, "schema_version_consistency")
        assert item is not None, report
        assert item["severity"] == "medium", item
        assert item["probes"] == [{"probe": "bad_schema.py", "values": ["v1"]}], item


def test_readme_drift_flags_missing_and_orphan_rows():
    with tempfile.TemporaryDirectory(prefix="corpus-guard-test-") as tmp_dir:
        root = Path(tmp_dir)
        (root / "tests").mkdir()
        write_probe(root, "present.py", 'SCHEMA_VERSION = "0.1"\nREPORT = {"redaction": "metadata-only"}\n')
        write_probe(root, "missing.py", 'SCHEMA_VERSION = "0.1"\nREPORT = {"redaction": "metadata-only"}\n')
        write_readme(root, ["present.py", "orphan.py"])

        report = check_probe_hygiene(root)
        item = violation(report, "readme_drift")
        assert item is not None, report
        assert item["missing_rows"] == ["missing.py"], item
        assert item["orphan_rows"] == ["orphan.py"], item


def test_goals_process_docs_must_not_own_moving_whatsoup_heads():
    with tempfile.TemporaryDirectory(prefix="corpus-guard-test-") as tmp_dir:
        root = Path(tmp_dir)
        docs = {
            "AGENT-RUNTIME-GOALS.md": [
                "current checkout test/coverage-ratchet-next-20260615d@abcdef0",
            ],
            "AGENT-RUNTIME-CURRENT-STATE.md": [
                "current observed checkout test/coverage-ratchet-next-20260615d@1234567",
            ],
        }

        report = check_lean_corpus(root, docs, ceiling=13)
        item = violation(report, "process_doc_volatile_head_ref")
        assert item is not None, report
        assert item["severity"] == "medium", item
        assert item["refs"] == [
            {
                "doc": "AGENT-RUNTIME-GOALS.md",
                "line": 1,
                "text": "current checkout test/coverage-ratchet-next-20260615d@abcdef0",
            }
        ], item


def test_goals_process_docs_may_point_to_current_state_for_moving_whatsoup_heads():
    with tempfile.TemporaryDirectory(prefix="corpus-guard-test-") as tmp_dir:
        root = Path(tmp_dir)
        docs = {
            "AGENT-RUNTIME-GOALS.md": [
                "current checkout head is owned by AGENT-RUNTIME-CURRENT-STATE.md",
            ],
            "AGENT-RUNTIME-CURRENT-STATE.md": [
                "current observed checkout test/coverage-ratchet-next-20260615d@1234567",
            ],
        }

        report = check_lean_corpus(root, docs, ceiling=13)
        assert violation(report, "process_doc_volatile_head_ref") is None, report


def test_current_style_probe_hygiene_passes():
    with tempfile.TemporaryDirectory(prefix="corpus-guard-test-") as tmp_dir:
        root = Path(tmp_dir)
        tests = root / "tests"
        tests.mkdir()
        write_probe(root, "redacted.py", 'SCHEMA_VERSION = "0.1"\nfrom probelib import redact\n')
        tests.joinpath("test_redacted.py").write_text("def test_redacted_error_marker():\n    assert True\n", encoding="utf-8")
        write_probe(root, "banner.py", 'REPORT = {"schema_version": "0.2", "redaction": "metadata-only"}\n')
        tests.joinpath("test_banner.py").write_text("def test_banner_missing_path_marker():\n    assert True\n", encoding="utf-8")
        write_probe(root, "probelib.py", "def redact(value):\n    return value\n")
        write_readme(root, ["redacted.py", "banner.py"])

        report = check_probe_hygiene(root)
        assert report["status"] == "pass", report
        assert report["script_count"] == 2, report


def test_probe_hygiene_flags_missing_direct_or_unhappy_path_test_signal():
    with tempfile.TemporaryDirectory(prefix="corpus-guard-test-") as tmp_dir:
        root = Path(tmp_dir)
        tests = root / "tests"
        tests.mkdir()
        write_probe(root, "no_direct.py", 'SCHEMA_VERSION = "0.1"\nREPORT = {"redaction": "metadata-only"}\n')
        write_probe(root, "happy_only.py", 'SCHEMA_VERSION = "0.1"\nREPORT = {"redaction": "metadata-only"}\n')
        tests.joinpath("test_happy_only.py").write_text("def test_happy_only_error_marker():\n    value = True\n", encoding="utf-8")
        write_readme(root, ["no_direct.py", "happy_only.py"])

        report = check_probe_hygiene(root)
        missing_direct = violation(report, "missing_direct_probe_test")
        missing_signal = violation(report, "missing_unhappy_path_test_signal")

        assert missing_direct is not None, report
        assert missing_direct["probes"] == ["no_direct.py"], missing_direct
        assert missing_signal is not None, report
        assert missing_signal["tests"] == ["test_happy_only.py"], missing_signal


def test_fail_open_scan_flags_silent_exception_handlers():
    with tempfile.TemporaryDirectory(prefix="corpus-guard-test-") as tmp_dir:
        root = Path(tmp_dir)
        write_probe(
            root,
            "bad_probe.py",
            "\n".join([
                "def bad_return():",
                "    try:",
                "        parse()",
                "    except ValueError:",
                "        return []",
                "",
                "def bad_pass():",
                "    try:",
                "        parse()",
                "    except OSError:",
                "        pass",
                "",
            ]),
        )

        report = check_fail_open_scan(root)
        item = violation(report, "silent_fail_open_exception_handler")
        assert report["status"] == "fail", report
        assert item is not None, report
        assert item["severity"] == "high", item
        assert [site["kind"] for site in item["sites"]] == ["return_empty_list", "pass"], item


def test_fail_open_scan_allows_typed_degraded_or_counted_handlers():
    with tempfile.TemporaryDirectory(prefix="corpus-guard-test-") as tmp_dir:
        root = Path(tmp_dir)
        write_probe(
            root,
            "good_probe.py",
            "\n".join([
                "def typed_return():",
                "    try:",
                "        parse()",
                "    except ValueError as exc:",
                "        return {'status': 'error', '_error': type(exc).__name__}",
                "",
                "def counted_continue(rows):",
                "    invalid = 0",
                "    for row in rows:",
                "        try:",
                "            parse(row)",
                "        except ValueError:",
                "            invalid += 1",
                "            continue",
                "    return {'invalid': invalid}",
                "",
            ]),
        )

        report = check_fail_open_scan(root)
        assert report["status"] == "pass", report


def _run_guard(root: str) -> tuple[dict, int]:
    """Helper: run corpus_guard.py as subprocess, return (parsed_json, exit_code)."""
    guard = Path(__file__).parent.parent / "corpus_guard.py"
    result = subprocess.run(
        [sys.executable, str(guard), "--root", root],
        capture_output=True, text=True,
    )
    report = json.loads(result.stdout)
    return report, result.returncode


def test_corpus_presence_fails_on_empty_root():
    """Defect F1: empty/mislocated root must fail with HIGH corpus_presence violation."""
    with tempfile.TemporaryDirectory(prefix="corpus-guard-empty-") as tmp_dir:
        report, rc = _run_guard(tmp_dir)

    # Must be FAIL verdict, nonzero exit
    assert report["summary"]["verdict"] == "FAIL", f"expected FAIL, got: {report['summary']}"
    assert rc != 0, f"expected nonzero exit, got: {rc}"
    assert report["summary"]["high_fail"] is True, f"expected high_fail:true, got: {report['summary']}"

    # The corpus_presence check must exist and be a high-severity fail
    presence_checks = [c for c in report["checks"] if c["name"] == "corpus_presence"]
    assert presence_checks, f"No corpus_presence check found in: {[c['name'] for c in report['checks']]}"
    cp = presence_checks[0]
    assert cp["status"] == "fail", f"corpus_presence status should be fail, got: {cp}"
    assert cp["severity"] == "high", f"corpus_presence severity should be high, got: {cp}"


def test_corpus_presence_passes_on_real_root():
    """Guard against over-correction: real root /Users/testuser must still pass corpus_presence."""
    real_root = str(Path.home())
    report, rc = _run_guard(real_root)

    # corpus_presence check must exist and pass
    presence_checks = [c for c in report["checks"] if c["name"] == "corpus_presence"]
    assert presence_checks, f"No corpus_presence check found in: {[c['name'] for c in report['checks']]}"
    cp = presence_checks[0]
    assert cp["status"] == "pass", f"corpus_presence should pass on real root, got: {cp}"

    # Overall verdict must remain PASS (no regression)
    assert report["summary"]["verdict"] == "PASS", f"real root verdict regressed: {report['summary']}"
    assert rc == 0, f"real root should exit 0, got: {rc}"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} corpus guard tests passed")
