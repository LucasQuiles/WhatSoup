#!/usr/bin/env python3
"""Tests for corpus_guard probe hygiene checks."""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json
import subprocess

from corpus_guard import (  # noqa: E402
    LIBRARIES, check_fail_open_scan, check_lean_corpus, check_probe_hygiene, check_two_plane_separation,
)


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


def test_bot_errors_probe_observation_is_declared_a_non_probe_library():
    assert "bot_errors_probe_observation.py" in LIBRARIES, LIBRARIES


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


def test_corpus_presence_passes_on_synthetic_root():
    """Guard against over-correction: a properly-structured root must still pass corpus_presence.

    Fixture-pinned: builds a synthetic temp dir satisfying the minimum corpus_presence
    requirements so the test is deterministic regardless of live $HOME drift.

    corpus_presence requires (from corpus_guard.py check_corpus_presence):
      1. At least one AGENT-RUNTIME-*.md file under root.
      2. An agent-runtime-probes/ subdirectory.
      3. At least PROBE_COUNT_FLOOR (40) .py files in that dir (excluding corpus_guard.py).
    """
    with tempfile.TemporaryDirectory(prefix="corpus-guard-synthetic-root-") as tmp:
        root = Path(tmp)
        # Requirement 1: at least one AGENT-RUNTIME-*.md doc
        (root / "AGENT-RUNTIME-CURRENT-STATE.md").write_text(
            "# synthetic fixture for test_corpus_presence_passes_on_synthetic_root\n",
            encoding="utf-8",
        )
        # Requirements 2 and 3: probe dir with >= 40 py files (excluding corpus_guard.py)
        probe_dir = root / "agent-runtime-probes"
        probe_dir.mkdir()
        for i in range(42):
            (probe_dir / f"synthetic_probe_{i:03d}.py").write_text(
                f'SCHEMA_VERSION = "0.1"\nREPORT = {{"redaction": "metadata-only", "n": {i}}}\n',
                encoding="utf-8",
            )
        report, rc = _run_guard(str(root))

    # corpus_presence check must exist and pass
    presence_checks = [c for c in report["checks"] if c["name"] == "corpus_presence"]
    assert presence_checks, (
        "No corpus_presence check in guard output: "
        + str([c["name"] for c in report["checks"]])
    )
    cp = presence_checks[0]
    assert cp["status"] == "pass", (
        "corpus_presence should pass on synthetic fixture root. "
        "Fixture may need updating if PROBE_COUNT_FLOOR changed in corpus_guard.py. "
        "Got: " + str(cp)
    )


def test_corpus_presence_on_real_home_advisory():
    """NON-BLOCKING advisory: observe live $HOME corpus_presence verdict.

    Never fails the gate: skips with detail if $HOME drifted so live state stays
    visible without breaking CI.  Unconditional assertion: corpus_presence check
    must always appear in guard output (schema contract).
    """
    import pytest
    real_root = str(Path.home())
    report, _rc = _run_guard(real_root)

    presence_checks = [c for c in report["checks"] if c["name"] == "corpus_presence"]
    # Unconditional schema-contract assertion: the check must always be emitted.
    assert presence_checks, (
        "corpus_presence absent from guard output -- schema changed; "
        "update test. checks=" + str([c["name"] for c in report["checks"]])
    )

    cp = presence_checks[0]
    # Surface the OVERALL live verdict, not just corpus_presence: the real live drift
    # (e.g. a doc-ceiling / lean_corpus breach from foreign reference docs) shows up in
    # the summary verdict while corpus_presence itself may still pass. Watch the verdict.
    verdict = report["summary"]["verdict"]
    failing = [c["name"] for c in report["checks"] if c.get("status") == "fail"]
    print(
        "\n[ADVISORY] live $HOME (" + real_root + "): overall_verdict=" + verdict
        + " corpus_presence=" + cp["status"]
        + " failing_checks=" + ("; ".join(failing) if failing else "none")
    )
    if verdict != "PASS":
        pytest.skip(
            "ADVISORY (owner: planprompt-cape harden track): live $HOME guard overall "
            "verdict is not PASS -- see the [ADVISORY] print above for the verdict and "
            "failing checks. Non-blocking by design; expected when live corpus/docs drift "
            "past the doc-ceiling. Deterministic coverage lives in "
            "test_corpus_presence_passes_on_synthetic_root."
        )


def _sites(report: dict) -> list:
    shared = violation(report, "plane_verdict_logic_shared")
    return shared["sites"] if shared else []


def _site_kinds(report: dict) -> set:
    return {s["kind"] for s in _sites(report)}


def test_two_plane_separation_passes_on_clean_tree():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        # two independent gates + a pure-projector dispatcher touching each only via .SCHEMA
        write_probe(root, "paired_trial_harness.py", "SCHEMA = 'b3'\ndef evaluate():\n    return {}\n")
        write_probe(root, "enricher_lift_gate.py", "SCHEMA = 'lift'\ndef evaluate():\n    return {}\n")
        write_probe(root, "adoption_orchestrator.py",
                    "import paired_trial_harness as b3\nimport enricher_lift_gate as lift\n"
                    "GATES = {'reducer': b3.SCHEMA, 'enricher': lift.SCHEMA}\n")
        report = check_two_plane_separation(root)
        assert report["status"] == "pass" and report["violations"] == []


def test_two_plane_separation_flags_gate_importing_other_gate():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        # the reducer gate reaches into the enricher gate -> verdict-logic coupling
        write_probe(root, "paired_trial_harness.py",
                    "import enricher_lift_gate\nSCHEMA = 'b3'\n")
        write_probe(root, "enricher_lift_gate.py", "SCHEMA = 'lift'\n")
        report = check_two_plane_separation(root)
        assert report["status"] == "fail"
        assert "gate_imports_other_gate" in _site_kinds(report)


def test_two_plane_separation_flags_unsanctioned_bridge_and_symbol_import():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        write_probe(root, "paired_trial_harness.py", "SCHEMA = 'b3'\ndef evaluate():\n    return {}\n")
        write_probe(root, "enricher_lift_gate.py", "SCHEMA = 'lift'\ndef evaluate():\n    return {}\n")
        # a non-dispatcher module importing BOTH gates AND pulling a verdict symbol
        write_probe(root, "rogue_merger.py",
                    "import paired_trial_harness\nfrom enricher_lift_gate import evaluate\nX = 1\n")
        report = check_two_plane_separation(root)
        kinds = _site_kinds(report)
        assert "unsanctioned_plane_bridge" in kinds
        assert "gate_symbol_import" in kinds


def test_two_plane_separation_flags_dispatcher_using_gate_logic():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        write_probe(root, "paired_trial_harness.py", "SCHEMA = 'b3'\ndef evaluate():\n    return {}\n")
        write_probe(root, "enricher_lift_gate.py", "SCHEMA = 'lift'\ndef evaluate():\n    return {}\n")
        # the dispatcher CALLS a gate's verdict fn instead of only reading .SCHEMA -> impure projector
        write_probe(root, "adoption_orchestrator.py",
                    "import paired_trial_harness as b3\nimport enricher_lift_gate as lift\n"
                    "R = b3.evaluate()\nS = lift.SCHEMA\n")
        report = check_two_plane_separation(root)
        kinds = _site_kinds(report)
        assert "dispatcher_uses_gate_logic" in kinds


def test_two_plane_separation_dispatcher_symbol_import_flagged():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        write_probe(root, "paired_trial_harness.py", "SCHEMA = 'b3'\ndef evaluate():\n    return {}\n")
        write_probe(root, "enricher_lift_gate.py", "SCHEMA = 'lift'\n")
        # dispatcher pulling a non-SCHEMA symbol via from-import -> verdict-logic reuse
        write_probe(root, "adoption_orchestrator.py",
                    "from paired_trial_harness import evaluate\nimport enricher_lift_gate as lift\n"
                    "S = lift.SCHEMA\n")
        report = check_two_plane_separation(root)
        assert "dispatcher_imports_gate_symbol" in _site_kinds(report)


def test_two_plane_separation_fails_closed_on_parse_error():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        write_probe(root, "paired_trial_harness.py", "SCHEMA = 'b3'\ndef evaluate(:\n")  # syntax error
        report = check_two_plane_separation(root)
        assert report["status"] == "fail"
        assert violation(report, "two_plane_separation_parse_error") is not None


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} corpus guard tests passed")
