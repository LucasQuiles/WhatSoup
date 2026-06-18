#!/usr/bin/env python3
"""Tests for output_redaction_auditor — Phase 4 bead 4.4 redaction governance. Standalone.

Mechanically enforces the estate-wide "metadata-only" invariant: scans a report's string values for
HIGH-PRECISION sensitive-shape leaks (secret/token/filesystem-path/repo) via the SSOT patterns and FAILs
fail-closed on any leak. Keystone: it must NOT false-positive on benign numeric metadata (ratios, counts,
scores) — the loose host/user/id pattern classes are deliberately excluded (caught by field-name redaction
instead), so a clean report always PASSes while a real path/secret/token leak is caught.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import output_redaction_auditor as ora  # noqa: E402

_CLEAN = {
    "schema": "agent-runtime-foo", "overall_verdict": "PASS",
    "metrics": {"ratio": 0.4, "count": 5, "score": 0.95, "pass_rate_delta": 0.0},
    "steps": [{"step_index": 0, "verdict": "PASS", "reason": None},
              {"step_index": 1, "verdict": "FAIL", "reason": "cache_not_worse"}],
    "prediction_hash": "9f3a1c0b2d4e6f80",
}


def test_clean_report_passes_no_false_positive():
    rep = ora.audit_report(_CLEAN)
    assert rep["overall_verdict"] == "PASS" and rep["leak_count"] == 0
    assert rep["scanned_string_count"] >= 1


def test_leaked_filesystem_path_is_flagged():
    leaky = dict(_CLEAN)
    leaky["_error"] = "failed reading /Users/testuser/agent-runtime-probes/private"
    rep = ora.audit_report(leaky)
    assert rep["overall_verdict"] == "FAIL" and rep["leak_count"] >= 1
    assert any(l["leak_type"] == "PATH" and l["field_path"] == "_error" for l in rep["leaks"])


def test_leaked_secret_token_is_flagged():
    leaky = {"note": "key is sk-ant-api03-AABBCCDDEEFF00112233445566778899ZZ"}
    rep = ora.audit_report(leaky)
    assert rep["overall_verdict"] == "FAIL"
    assert any(l["leak_type"] in ("TOKEN", "SECRET") for l in rep["leaks"])


def test_numeric_metadata_is_not_false_flagged():
    # floats / counts / short labels must never trip the auditor (precision keystone)
    rep = ora.audit_report({"a": "ratio 0.4", "b": "token_fraction 0.4 leak_count 2",
                            "c": "step 2 of 5", "d": 0.55, "e": 12})
    assert rep["overall_verdict"] == "PASS" and rep["leak_count"] == 0


def test_nested_leak_reports_field_path():
    leaky = {"metrics": {"items": [{"detail": "see /Users/testuser/logs/run.json"}]}}
    rep = ora.audit_report(leaky)
    assert rep["overall_verdict"] == "FAIL"
    assert rep["leaks"][0]["field_path"] == "metrics.items[0].detail"


def test_audit_output_is_metadata_only_hash_not_raw():
    leaky = {"x": "/Users/testuser/agent-runtime-probes/secret-file"}
    rep = ora.audit_report(leaky)
    blob = json.dumps(rep)
    assert "testuser" not in blob and "secret-file" not in blob  # only a hash of the leaked value
    assert len(rep["leaks"][0]["value_sha256_16"]) == 16


def test_audit_reports_worst_case():
    rep = ora.audit_reports([_CLEAN, {"x": "/Users/testuser/agent-runtime-probes/y"}, _CLEAN])
    assert rep["overall_verdict"] == "FAIL"
    assert rep["leaky_report_indices"] == [1]
    assert ora.audit_reports([_CLEAN, _CLEAN])["overall_verdict"] == "PASS"
    # empty corpus fails closed
    empty = ora.audit_reports([])
    assert empty["overall_verdict"] == "FAIL" and empty["error_type"] == "empty_corpus"


def _run_main(argv):
    saved = sys.argv
    sys.argv = ["output_redaction_auditor.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = ora.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_clean_fail_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        clean_f = dp / "clean.json"
        clean_f.write_text(json.dumps(_CLEAN), encoding="utf-8")
        rc, rep = _run_main(["--report", str(clean_f), "--pretty"])
        assert rc == 0 and rep["overall_verdict"] == "PASS"

        leaky_f = dp / "leaky.json"
        leaky_f.write_text(json.dumps({"x": "/Users/testuser/agent-runtime-probes/z"}), encoding="utf-8")
        rc, rep = _run_main(["--report", str(leaky_f)])
        assert rc == 1 and rep["overall_verdict"] == "FAIL"

        # a list of reports -> corpus audit
        list_f = dp / "list.json"
        list_f.write_text(json.dumps([_CLEAN, _CLEAN]), encoding="utf-8")
        rc, rep = _run_main(["--report", str(list_f)])
        assert rc == 0 and rep["overall_verdict"] == "PASS"

        rc, rep = _run_main(["--report", str(dp / "no.json")])
        assert rc == 1 and rep["error_type"] == "missing_report"
        bad = dp / "bad.json"
        bad.write_text("{nope", encoding="utf-8")
        rc, rep = _run_main(["--report", str(bad)])
        assert rc == 1 and rep["error_type"] == "malformed_report"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} output_redaction_auditor tests passed")
