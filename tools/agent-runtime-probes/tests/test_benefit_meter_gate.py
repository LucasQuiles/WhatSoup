#!/usr/bin/env python3
"""Tests for benefit_meter_gate — proof-chain Slice 4 benefit-meter integrity. Standalone.

Keystone (consensus §7 'non-operational meter ⇒ benefit=unknown'): a step that DECLARES a `measured`
benefit is only trustworthy if the meter that produced that measurement was OPERATIONAL. A measured claim
with a non-operational / degraded / absent meter is an OVERCLAIM — its effective proof_class is downgraded
to `unknown` (adoption-ineligible) and the chain FAILs the integrity gate. heuristic/unknown benefits never
claimed a measurement, so meter status does not touch them. Expectations are derived from that contract.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import benefit_meter_gate as bmg  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402

START = "user alice@example.com asked about the deadline and the refund policy in detail"
T_MASK = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline and the refund policy in detail"
T_COMPRESS = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline"


def _attest(cid, idx, prev_hash, prev_text, new_text, purpose, proof_class):
    return mpc.attest_step(
        chain_id=cid, step_index=idx, prev_record_hash=prev_hash, prev_text=prev_text,
        new_text=new_text, declared_purpose=purpose,
        benefit=mpc.Benefit(0.2, "token_fraction", "decrease", proof_class, "ev:x"),
        determinism_ok=True,
    )


def _chain(pc0="measured", pc1="measured", cid="meter-fixture"):
    """A mask(step0) + compress(step1) chain with chosen per-step benefit proof_classes."""
    g = mpc.genesis_anchor(cid)
    a0 = _attest(cid, 0, g, START, T_MASK, "mask", pc0)
    a1 = _attest(cid, 1, a0.record_hash, T_MASK, T_COMPRESS, "compress", pc1)
    return [a0.as_dict(), a1.as_dict()]


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except bmg.MeterGateError as exc:
        return exc.error_type
    return None


# --- backed vs unbacked measured claims ---------------------------------------

def test_measured_with_operational_meter_passes():
    recs = _chain("measured", "heuristic")
    meters = [{"step_index": 0, "status": "operational", "meter_id": "savings"}]
    rep = bmg.verify_benefit_meters(recs, meters)
    assert rep["overall_verdict"] == "PASS"
    assert rep["downgrade_count"] == 0
    step0 = rep["steps"][0]
    assert step0["effective_proof_class"] == "measured" and step0["downgraded"] is False
    # the heuristic step is untouched by meter status
    assert rep["steps"][1]["effective_proof_class"] == "heuristic"


def test_measured_without_meter_entry_downgrades_and_fails():
    recs = _chain("measured", "unknown")
    rep = bmg.verify_benefit_meters(recs, [])  # no meter declared for the measured step
    assert rep["overall_verdict"] == "FAIL"
    assert rep["downgraded_indices"] == [0]
    s0 = rep["steps"][0]
    assert s0["meter_status"] == "absent" and s0["effective_proof_class"] == "unknown" and s0["downgraded"] is True


def test_non_operational_and_degraded_meters_downgrade():
    for bad in ("non_operational", "degraded", "absent"):
        recs = _chain("measured", "heuristic")
        rep = bmg.verify_benefit_meters(recs, [{"step_index": 0, "status": bad}])
        assert rep["overall_verdict"] == "FAIL", bad
        assert rep["steps"][0]["effective_proof_class"] == "unknown", bad


def test_heuristic_and_unknown_unaffected_by_meter():
    recs = _chain("heuristic", "unknown")
    rep = bmg.verify_benefit_meters(recs, [])  # no meters, but no measured claims either
    assert rep["overall_verdict"] == "PASS"
    assert rep["downgrade_count"] == 0
    assert [s["effective_proof_class"] for s in rep["steps"]] == ["heuristic", "unknown"]


def test_mixed_one_unbacked_measured_fails_only_that_step():
    recs = _chain("measured", "measured")
    meters = [{"step_index": 0, "status": "operational"}]  # step 1 measured has NO operational meter
    rep = bmg.verify_benefit_meters(recs, meters)
    assert rep["overall_verdict"] == "FAIL"
    assert rep["downgraded_indices"] == [1]
    assert rep["steps"][0]["effective_proof_class"] == "measured"
    assert rep["steps"][1]["effective_proof_class"] == "unknown"


def test_meters_none_downgrades_all_measured():
    recs = _chain("measured", "measured")
    rep = bmg.verify_benefit_meters(recs, None)
    assert rep["overall_verdict"] == "FAIL" and rep["downgrade_count"] == 2


# --- informational meter on a non-measured step -------------------------------

def test_meter_on_heuristic_step_is_informational_no_downgrade():
    recs = _chain("heuristic", "heuristic")
    rep = bmg.verify_benefit_meters(recs, [{"step_index": 0, "status": "non_operational"}])
    assert rep["overall_verdict"] == "PASS"  # heuristic never claimed a measurement
    assert rep["steps"][0]["meter_status"] == "non_operational"
    assert rep["steps"][0]["downgraded"] is False


# --- fail-closed on malformed input -------------------------------------------

def test_malformed_meter_status_is_typed():
    recs = _chain()
    assert _err(bmg.verify_benefit_meters, recs, [{"step_index": 9, "status": "operational"}]) == "malformed_meter_status"
    assert _err(bmg.verify_benefit_meters, recs, [{"step_index": 0, "status": "bogus"}]) == "malformed_meter_status"
    assert _err(bmg.verify_benefit_meters, recs, [{"step_index": 0, "status": "operational"},
                                                  {"step_index": 0, "status": "degraded"}]) == "malformed_meter_status"
    assert _err(bmg.verify_benefit_meters, recs, ["not-a-dict"]) == "malformed_meter_status"
    assert _err(bmg.verify_benefit_meters, recs, [{"status": "operational"}]) == "malformed_meter_status"


def test_empty_chain_fails():
    rep = bmg.verify_benefit_meters([], [])
    assert rep["overall_verdict"] == "FAIL" and rep["error_type"] == "empty_chain"


def test_output_is_metadata_only():
    recs = _chain("measured", "measured")
    blob = json.dumps(bmg.verify_benefit_meters(recs, [{"step_index": 0, "status": "operational"}]))
    assert "alice@example.com" not in blob and "refund policy" not in blob


# --- CLI e2e ------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["benefit_meter_gate.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = bmg.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_pass_fail_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        recs = _chain("measured", "heuristic", "cli-chain")
        chain_f = dp / "chain.json"
        chain_f.write_text(json.dumps(recs), encoding="utf-8")
        meters_f = dp / "meters.json"
        meters_f.write_text(json.dumps([{"step_index": 0, "status": "operational"}]), encoding="utf-8")

        rc, rep = _run_main(["--chain", str(chain_f), "--meters", str(meters_f), "--pretty"])
        assert rc == 0 and rep["overall_verdict"] == "PASS"

        # no --meters: the measured step downgrades -> FAIL
        rc, rep = _run_main(["--chain", str(chain_f)])
        assert rc == 1 and rep["overall_verdict"] == "FAIL"

        rc, rep = _run_main(["--chain", str(dp / "nope.json")])
        assert rc == 1 and rep["error_type"] == "missing_chain"

        bad = dp / "bad.json"
        bad.write_text("{nope", encoding="utf-8")
        rc, rep = _run_main(["--chain", str(bad)])
        assert rc == 1 and rep["error_type"] == "malformed_chain"

        rc, rep = _run_main(["--chain", str(chain_f), "--meters", str(dp / "nometers.json")])
        assert rc == 1 and rep["error_type"] == "missing_meters"

        badm = dp / "badm.json"
        badm.write_text("{nope", encoding="utf-8")
        rc, rep = _run_main(["--chain", str(chain_f), "--meters", str(badm)])
        assert rc == 1 and rep["error_type"] == "malformed_meters"

        # malformed meter content -> typed error through main
        outm = dp / "outm.json"
        outm.write_text(json.dumps([{"step_index": 9, "status": "operational"}]), encoding="utf-8")
        rc, rep = _run_main(["--chain", str(chain_f), "--meters", str(outm)])
        assert rc == 1 and rep["error_type"] == "malformed_meter_status"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} benefit_meter_gate tests passed")
