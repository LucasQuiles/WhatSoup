#!/usr/bin/env python3
"""Tests for chain_outcome_gate — proof-chain Slice 4 mid-chain-failure typed state. Standalone.

Keystone (consensus §7 'mid-chain failure (partial chain)'): a chain of k recorded steps is ambiguous on
its own — it could be a normally completed plan, a chain that aborted because step k FAILED (producing no
record), or a maliciously truncated chain. The terminal seal (F2) already rules out truncation; this gate
types the rest. The load-bearing invariant: a `failed`/`aborted` outcome MUST name failed_at_step == k (the
recorded count) — the failure is at the step beyond the last record, so no record exists for it; a failure
index INSIDE the recorded range is a contradiction. `completed` forbids any failure marker.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import chain_outcome_gate as cog  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402

START = "user alice@example.com asked about the deadline and the refund policy in detail"
T_MASK = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline and the refund policy in detail"
T_COMPRESS = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline"


def _chain(cid="outcome-fixture"):
    g = mpc.genesis_anchor(cid)
    a0 = mpc.attest_step(chain_id=cid, step_index=0, prev_record_hash=g, prev_text=START, new_text=T_MASK,
                         declared_purpose="mask",
                         benefit=mpc.Benefit(0.0, "leak_count", "decrease", "measured", "ev"), determinism_ok=True)
    a1 = mpc.attest_step(chain_id=cid, step_index=1, prev_record_hash=a0.record_hash, prev_text=T_MASK,
                         new_text=T_COMPRESS, declared_purpose="compress",
                         benefit=mpc.Benefit(0.4, "token_fraction", "decrease", "measured", "ev"), determinism_ok=True)
    return [a0.as_dict(), a1.as_dict()]


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except cog.OutcomeError as exc:
        return exc.error_type
    return None


# --- valid outcomes -----------------------------------------------------------

def test_completed_chain_passes():
    rep = cog.verify_outcome(_chain(), {"status": "completed"})
    assert rep["overall_verdict"] == "PASS"
    assert rep["is_partial"] is False and rep["recorded_step_count"] == 2


def test_failed_mid_chain_passes():
    # the 3rd step (index 2) failed -> 2 records, failed_at_step == 2
    rep = cog.verify_outcome(_chain(), {"status": "failed", "failed_at_step": 2,
                                        "failure_class": "anchor_loss"})
    assert rep["overall_verdict"] == "PASS"
    assert rep["is_partial"] is True and rep["failure_class"] == "anchor_loss"


def test_aborted_passes():
    rep = cog.verify_outcome(_chain(), {"status": "aborted", "failed_at_step": 2,
                                        "failure_class": "budget_exhausted"})
    assert rep["overall_verdict"] == "PASS" and rep["status"] == "aborted"


def test_failed_at_genesis_with_empty_chain_passes():
    # the very first step failed -> zero records, failed_at_step == 0
    rep = cog.verify_outcome([], {"status": "failed", "failed_at_step": 0, "failure_class": "genesis_step_failed"})
    assert rep["overall_verdict"] == "PASS" and rep["recorded_step_count"] == 0 and rep["is_partial"] is True


# --- index-consistency violations (verdict FAIL, not malformed) ---------------

def test_failure_index_inside_recorded_range_fails():
    # a record exists for step 1, so 'failed at step 1' is a contradiction
    rep = cog.verify_outcome(_chain(), {"status": "failed", "failed_at_step": 1, "failure_class": "x"})
    assert rep["overall_verdict"] == "FAIL" and "inconsistent_failure_index" in rep["reasons"]


def test_failure_index_with_gap_fails():
    rep = cog.verify_outcome(_chain(), {"status": "failed", "failed_at_step": 5, "failure_class": "x"})
    assert rep["overall_verdict"] == "FAIL" and "inconsistent_failure_index" in rep["reasons"]


def test_completed_with_failure_marker_fails():
    rep = cog.verify_outcome(_chain(), {"status": "completed", "failed_at_step": 2})
    assert rep["overall_verdict"] == "FAIL" and "spurious_failure_marker" in rep["reasons"]
    rep2 = cog.verify_outcome(_chain(), {"status": "completed", "failure_class": "x"})
    assert rep2["overall_verdict"] == "FAIL" and "spurious_failure_marker" in rep2["reasons"]


def test_empty_chain_completed_fails():
    rep = cog.verify_outcome([], {"status": "completed"})
    assert rep["overall_verdict"] == "FAIL" and rep["error_type"] == "empty_completed_chain"


def test_base_chain_invalid_fails():
    recs = _chain()
    recs[1]["record_hash"] = "00" * 32
    rep = cog.verify_outcome(recs, {"status": "completed"})
    assert rep["overall_verdict"] == "FAIL" and "base_chain_invalid" in rep["reasons"]


# --- malformed outcome (typed, fail-closed) -----------------------------------

def test_malformed_outcome_is_typed():
    recs = _chain()
    assert _err(cog.verify_outcome, recs, "nope") == "malformed_outcome"
    assert _err(cog.verify_outcome, recs, {}) == "malformed_outcome"            # no status
    assert _err(cog.verify_outcome, recs, {"status": "bogus"}) == "malformed_outcome"
    assert _err(cog.verify_outcome, recs, {"status": "failed"}) == "malformed_outcome"  # missing index+class
    assert _err(cog.verify_outcome, recs, {"status": "failed", "failed_at_step": 2}) == "malformed_outcome"  # no class
    assert _err(cog.verify_outcome, recs, {"status": "failed", "failed_at_step": -1, "failure_class": "x"}) == "malformed_outcome"
    assert _err(cog.verify_outcome, recs, {"status": "failed", "failed_at_step": 2, "failure_class": ""}) == "malformed_outcome"


def test_output_is_metadata_only():
    blob = json.dumps(cog.verify_outcome(_chain(), {"status": "failed", "failed_at_step": 2, "failure_class": "x"}))
    assert "alice@example.com" not in blob and "refund policy" not in blob


# --- CLI e2e ------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["chain_outcome_gate.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = cog.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_pass_fail_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        recs = _chain("cli-chain")
        cf = dp / "chain.json"
        cf.write_text(json.dumps(recs), encoding="utf-8")
        of = dp / "outcome.json"
        of.write_text(json.dumps({"status": "failed", "failed_at_step": 2, "failure_class": "anchor_loss"}), encoding="utf-8")

        rc, rep = _run_main(["--chain", str(cf), "--outcome", str(of), "--pretty"])
        assert rc == 0 and rep["overall_verdict"] == "PASS"

        of2 = dp / "outcome2.json"
        of2.write_text(json.dumps({"status": "failed", "failed_at_step": 1, "failure_class": "x"}), encoding="utf-8")
        rc, rep = _run_main(["--chain", str(cf), "--outcome", str(of2)])
        assert rc == 1 and "inconsistent_failure_index" in rep["reasons"]

        rc, rep = _run_main(["--chain", str(dp / "no.json"), "--outcome", str(of)])
        assert rc == 1 and rep["error_type"] == "missing_chain"
        rc, rep = _run_main(["--chain", str(cf), "--outcome", str(dp / "no.json")])
        assert rc == 1 and rep["error_type"] == "missing_outcome"

        bad = dp / "bad.json"
        bad.write_text("{nope", encoding="utf-8")
        rc, rep = _run_main(["--chain", str(bad), "--outcome", str(of)])
        assert rc == 1 and rep["error_type"] == "malformed_chain"
        rc, rep = _run_main(["--chain", str(cf), "--outcome", str(bad)])
        assert rc == 1 and rep["error_type"] == "malformed_outcome_json"

        ml = dp / "ml.json"
        ml.write_text(json.dumps({"status": "failed"}), encoding="utf-8")
        rc, rep = _run_main(["--chain", str(cf), "--outcome", str(ml)])
        assert rc == 1 and rep["error_type"] == "malformed_outcome"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} chain_outcome_gate tests passed")
