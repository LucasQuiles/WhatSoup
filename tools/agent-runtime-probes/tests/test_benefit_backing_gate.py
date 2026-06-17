#!/usr/bin/env python3
"""Tests for benefit_backing_gate — proof-chain Slice 3 backed-benefit (claim vs measurement). Standalone.

Keystone (Slice 3 'bind benefit to the measurement substrate'): `benefit_meter_gate` asks "was the meter
operational?"; this gate asks "does the CLAIMED benefit value match what was MEASURED?". A `measured`
benefit that claims value X on unit U is backed ONLY by a measurement of unit U, from a real-measurement
provenance (provider_truth / local_measured, never a chars/4 heuristic), whose value matches X within
tolerance. An unbacked, inflated, wrong-unit, or weak-provenance claim is downgraded to `unknown`
(adoption-ineligible) and the chain FAILs. heuristic/unknown benefits never claimed a measurement.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import benefit_backing_gate as bbg  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402

START = "user alice@example.com asked about the deadline and the refund policy in detail"
T_MASK = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline and the refund policy in detail"
T_COMPRESS = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline"


def _chain(v0=2.0, u0="leak_count", pc0="measured", v1=0.4, u1="token_fraction", pc1="measured",
           cid="backing-fixture"):
    g = mpc.genesis_anchor(cid)
    a0 = mpc.attest_step(chain_id=cid, step_index=0, prev_record_hash=g, prev_text=START, new_text=T_MASK,
                         declared_purpose="mask", benefit=mpc.Benefit(v0, u0, "decrease", pc0, "ev"),
                         determinism_ok=True)
    a1 = mpc.attest_step(chain_id=cid, step_index=1, prev_record_hash=a0.record_hash, prev_text=T_MASK,
                         new_text=T_COMPRESS, declared_purpose="compress",
                         benefit=mpc.Benefit(v1, u1, "decrease", pc1, "ev"), determinism_ok=True)
    return [a0.as_dict(), a1.as_dict()]


def _m(step_index, unit, measured_value, provenance="provider_truth"):
    return {"step_index": step_index, "unit": unit, "measured_value": measured_value, "provenance": provenance}


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except bbg.BackingError as exc:
        return exc.error_type
    return None


# --- backed vs unbacked claims ------------------------------------------------

def test_measured_claims_backed_by_matching_measurements_pass():
    recs = _chain()
    measurements = [_m(0, "leak_count", 2.0, "local_measured"), _m(1, "token_fraction", 0.42, "provider_truth")]
    rep = bbg.verify_backing(recs, measurements)
    assert rep["overall_verdict"] == "PASS" and rep["unbacked_count"] == 0
    assert rep["steps"][1]["backed"] is True and rep["steps"][1]["effective_proof_class"] == "measured"


def test_unbacked_measured_claim_downgrades_and_fails():
    recs = _chain()
    rep = bbg.verify_backing(recs, [_m(0, "leak_count", 2.0, "local_measured")])  # no measurement for step 1
    assert rep["overall_verdict"] == "FAIL"
    assert rep["unbacked_indices"] == [1]
    assert rep["steps"][1]["effective_proof_class"] == "unknown"
    assert rep["steps"][1]["backing_reason"] == "unbacked_measured_claim"


def test_inflated_claim_is_caught():
    recs = _chain(v1=0.4)  # claims 40% reduction
    rep = bbg.verify_backing(recs, [_m(0, "leak_count", 2.0, "local_measured"),
                                    _m(1, "token_fraction", 0.10, "provider_truth")])  # only 10% measured
    assert rep["overall_verdict"] == "FAIL"
    assert rep["steps"][1]["backing_reason"] == "benefit_claim_mismatch"


def test_weak_provenance_cannot_back_a_measured_claim():
    recs = _chain()
    rep = bbg.verify_backing(recs, [_m(0, "leak_count", 2.0, "local_measured"),
                                    _m(1, "token_fraction", 0.40, "heuristic")])  # chars/4 can't back measured
    assert rep["overall_verdict"] == "FAIL" and rep["steps"][1]["backing_reason"] == "weak_provenance"


def test_unit_mismatch_is_caught():
    recs = _chain()
    rep = bbg.verify_backing(recs, [_m(0, "leak_count", 2.0, "local_measured"),
                                    _m(1, "byte_fraction", 0.40, "provider_truth")])  # wrong unit
    assert rep["overall_verdict"] == "FAIL" and rep["steps"][1]["backing_reason"] == "unit_mismatch"


def test_heuristic_benefit_needs_no_backing():
    recs = _chain(pc0="heuristic", pc1="heuristic")
    rep = bbg.verify_backing(recs, [])  # no measurements, but no measured claims either
    assert rep["overall_verdict"] == "PASS" and rep["unbacked_count"] == 0
    assert [s["effective_proof_class"] for s in rep["steps"]] == ["heuristic", "heuristic"]


def test_tolerance_boundary():
    recs = _chain(v1=0.40)
    # exactly at the default tolerance (0.05) -> backed
    ok = bbg.verify_backing(recs, [_m(0, "leak_count", 2.0, "local_measured"),
                                   _m(1, "token_fraction", 0.45, "provider_truth")])
    assert ok["steps"][1]["backed"] is True
    # just beyond -> mismatch
    bad = bbg.verify_backing(recs, [_m(0, "leak_count", 2.0, "local_measured"),
                                    _m(1, "token_fraction", 0.4501, "provider_truth")], tolerance=0.05)
    assert bad["steps"][1]["backed"] is False


def test_mixed_one_unbacked_fails():
    recs = _chain()
    rep = bbg.verify_backing(recs, [_m(0, "leak_count", 9.0, "local_measured"),  # step 0 claim 2.0 != 9.0
                                    _m(1, "token_fraction", 0.40, "provider_truth")])
    assert rep["overall_verdict"] == "FAIL" and rep["unbacked_indices"] == [0]
    assert rep["steps"][0]["effective_proof_class"] == "unknown"


# --- malformed / fail-closed --------------------------------------------------

def test_malformed_measurement_is_typed():
    recs = _chain()
    assert _err(bbg.verify_backing, recs, [_m(9, "leak_count", 1.0)]) == "malformed_measurement"  # out of range
    assert _err(bbg.verify_backing, recs, [_m(0, "leak_count", "x")]) == "malformed_measurement"  # non-number
    assert _err(bbg.verify_backing, recs, [_m(0, "leak_count", 1.0), _m(0, "leak_count", 2.0)]) == "malformed_measurement"
    assert _err(bbg.verify_backing, recs, [_m(0, "leak_count", 1.0, "bogus")]) == "malformed_measurement"
    assert _err(bbg.verify_backing, recs, ["not-a-dict"]) == "malformed_measurement"
    assert _err(bbg.verify_backing, recs, [{"step_index": 0, "unit": "x"}]) == "malformed_measurement"  # no value
    assert _err(bbg.verify_backing, recs, "nope") == "malformed_measurement"  # not a list
    assert _err(bbg.verify_backing, recs, [_m(0, "", 1.0)]) == "malformed_measurement"  # empty unit


def test_none_measurements_downgrades_all_measured():
    recs = _chain()  # two measured claims, no measurements at all
    rep = bbg.verify_backing(recs, None)
    assert rep["overall_verdict"] == "FAIL" and rep["unbacked_count"] == 2


def test_empty_chain_fails():
    rep = bbg.verify_backing([], [])
    assert rep["overall_verdict"] == "FAIL" and rep["error_type"] == "empty_chain"


def test_output_is_metadata_only():
    recs = _chain()
    blob = json.dumps(bbg.verify_backing(recs, [_m(0, "leak_count", 2.0, "local_measured"),
                                                _m(1, "token_fraction", 0.4, "provider_truth")]))
    assert "alice@example.com" not in blob and "refund policy" not in blob


# --- CLI e2e ------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["benefit_backing_gate.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = bbg.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_pass_fail_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        recs = _chain(cid="cli-chain")
        cf = dp / "chain.json"
        cf.write_text(json.dumps(recs), encoding="utf-8")
        mf = dp / "m.json"
        mf.write_text(json.dumps([_m(0, "leak_count", 2.0, "local_measured"),
                                  _m(1, "token_fraction", 0.4, "provider_truth")]), encoding="utf-8")

        rc, rep = _run_main(["--chain", str(cf), "--measurements", str(mf), "--pretty"])
        assert rc == 0 and rep["overall_verdict"] == "PASS"

        mf2 = dp / "m2.json"
        mf2.write_text(json.dumps([_m(0, "leak_count", 2.0, "local_measured")]), encoding="utf-8")  # step 1 unbacked
        rc, rep = _run_main(["--chain", str(cf), "--measurements", str(mf2)])
        assert rc == 1 and rep["unbacked_indices"] == [1]

        rc, rep = _run_main(["--chain", str(dp / "no.json"), "--measurements", str(mf)])
        assert rc == 1 and rep["error_type"] == "missing_chain"
        rc, rep = _run_main(["--chain", str(cf), "--measurements", str(dp / "no.json")])
        assert rc == 1 and rep["error_type"] == "missing_measurements"

        bad = dp / "bad.json"
        bad.write_text("{nope", encoding="utf-8")
        rc, rep = _run_main(["--chain", str(bad), "--measurements", str(mf)])
        assert rc == 1 and rep["error_type"] == "malformed_chain"
        rc, rep = _run_main(["--chain", str(cf), "--measurements", str(bad)])
        assert rc == 1 and rep["error_type"] == "malformed_measurements_json"

        ml = dp / "ml.json"
        ml.write_text(json.dumps([_m(9, "leak_count", 1.0)]), encoding="utf-8")
        rc, rep = _run_main(["--chain", str(cf), "--measurements", str(ml)])
        assert rc == 1 and rep["error_type"] == "malformed_measurement"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} benefit_backing_gate tests passed")
