#!/usr/bin/env python3
"""Tests for substrate_measurement_adapter — Slice 3 live-extraction glue. Standalone.

Closes the loop: substrate probe outputs (usage_truth_probe provider-usage fields / deterministic local
counts / chars-4 heuristics) -> normalized {step_index, unit, measured_value, provenance} records that
`benefit_backing_gate` consumes. The load-bearing logic is the provider-truth token-fraction REDUCTION:
total provider input = input_tokens + cache_read + cache_creation (DISJOINT buckets — summing only
input_tokens was the M3 bug), reduction = (total_before - total_after)/total_before; an `unknown` field
fails closed to NO measurement (never a fabricated number). Includes an end-to-end adapter->backing-gate
test proving the substrate wiring works.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import substrate_measurement_adapter as sma  # noqa: E402
import benefit_backing_gate as bbg  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402


def _usage(input_tokens, cache_read, cache_creation):
    return {"input_tokens": input_tokens, "cache_read_input_tokens": cache_read,
            "cache_creation_input_tokens": cache_creation}


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except sma.AdapterError as exc:
        return exc.error_type
    return None


# --- provider-truth token reduction (the disjoint-bucket math) ----------------

def test_token_reduction_uses_disjoint_bucket_total():
    # total_before = 40+50+10 = 100 ; total_after = 30+30+0 = 60 ; reduction = 40/100 = 0.4
    before, after = _usage(40, 50, 10), _usage(30, 30, 0)
    m = sma.extract({"step_index": 1, "source": "usage_truth", "before": before, "after": after})
    assert m == {"step_index": 1, "unit": "token_fraction", "measured_value": 0.4, "provenance": "provider_truth"}


def test_token_reduction_unknown_field_yields_no_measurement():
    before, after = _usage(40, "unknown", 10), _usage(30, 30, 0)
    assert sma.extract({"step_index": 1, "source": "usage_truth", "before": before, "after": after}) is None
    # zero/absent total before -> also no measurement (no division by zero, no fabricated value)
    assert sma.extract({"step_index": 1, "source": "usage_truth",
                        "before": _usage(0, 0, 0), "after": _usage(0, 0, 0)}) is None


# --- deterministic local count + heuristic ------------------------------------

def test_deterministic_count_is_local_measured():
    m = sma.extract({"step_index": 0, "source": "deterministic_count", "unit": "leak_count",
                     "before": 5, "after": 3})
    assert m == {"step_index": 0, "unit": "leak_count", "measured_value": 2.0, "provenance": "local_measured"}


def test_heuristic_estimate_is_tagged_heuristic():
    m = sma.extract({"step_index": 1, "source": "heuristic_estimate", "unit": "token_fraction", "value": 0.4})
    assert m["provenance"] == "heuristic" and m["measured_value"] == 0.4


# --- build_measurements (dispatch + drop uncomputable) ------------------------

def test_build_drops_uncomputable_and_keeps_the_rest():
    items = [
        {"step_index": 0, "source": "deterministic_count", "unit": "leak_count", "before": 5, "after": 3},
        {"step_index": 1, "source": "usage_truth", "before": _usage(40, "unknown", 10), "after": _usage(30, 30, 0)},
    ]
    out = sma.build_measurements(items)
    assert len(out) == 1 and out[0]["step_index"] == 0


def test_malformed_items_are_typed():
    assert _err(sma.build_measurements, "nope") == "malformed_item"
    assert _err(sma.extract, "nope") == "malformed_item"
    assert _err(sma.extract, {"step_index": 0, "source": "bogus"}) == "unknown_source"
    assert _err(sma.extract, {"source": "deterministic_count", "unit": "x", "before": 1, "after": 0}) == "malformed_item"  # no step_index
    assert _err(sma.extract, {"step_index": 0, "source": "deterministic_count", "unit": "x",
                              "before": "a", "after": 0}) == "malformed_item"  # non-number
    assert _err(sma.extract, {"step_index": 0, "source": "heuristic_estimate", "unit": "x", "value": "a"}) == "malformed_item"


# --- END-TO-END: adapter -> benefit_backing_gate ------------------------------

def _chain():
    cid = "adapter-e2e"
    g = mpc.genesis_anchor(cid)
    t0 = "user alice@example.com asked about the deadline and the refund policy in detail"
    t1 = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline and the refund policy in detail"
    t2 = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline"
    a0 = mpc.attest_step(chain_id=cid, step_index=0, prev_record_hash=g, prev_text=t0, new_text=t1,
                         declared_purpose="mask", benefit=mpc.Benefit(2.0, "leak_count", "decrease", "measured", "ev"),
                         determinism_ok=True)
    a1 = mpc.attest_step(chain_id=cid, step_index=1, prev_record_hash=a0.record_hash, prev_text=t1, new_text=t2,
                         declared_purpose="compress",
                         benefit=mpc.Benefit(0.4, "token_fraction", "decrease", "measured", "ev"), determinism_ok=True)
    return [a0.as_dict(), a1.as_dict()]


def test_end_to_end_adapter_feeds_backing_gate_pass():
    recs = _chain()
    measurements = sma.build_measurements([
        {"step_index": 0, "source": "deterministic_count", "unit": "leak_count", "before": 5, "after": 3},
        {"step_index": 1, "source": "usage_truth", "before": _usage(40, 50, 10), "after": _usage(30, 30, 0)},
    ])
    rep = bbg.verify_backing(recs, measurements)
    assert rep["overall_verdict"] == "PASS" and rep["unbacked_count"] == 0


def test_end_to_end_inflated_claim_caught_via_adapter():
    recs = _chain()  # step 1 claims 0.4 token_fraction
    # provider truth shows only a 10% reduction (90/100) -> inflated claim must be caught
    measurements = sma.build_measurements([
        {"step_index": 0, "source": "deterministic_count", "unit": "leak_count", "before": 5, "after": 3},
        {"step_index": 1, "source": "usage_truth", "before": _usage(40, 50, 10), "after": _usage(50, 30, 10)},
    ])
    rep = bbg.verify_backing(recs, measurements)
    assert rep["overall_verdict"] == "FAIL" and rep["steps"][1]["backing_reason"] == "benefit_claim_mismatch"


def test_output_is_metadata_only():
    out = sma.build_measurements([{"step_index": 1, "source": "usage_truth",
                                   "before": _usage(40, 50, 10), "after": _usage(30, 30, 0)}])
    assert "token_fraction" in json.dumps(out)  # units/numbers only, no raw text


# --- CLI e2e ------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["substrate_measurement_adapter.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = sma.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_extracts_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        items_f = dp / "items.json"
        items_f.write_text(json.dumps([
            {"step_index": 0, "source": "deterministic_count", "unit": "leak_count", "before": 5, "after": 3},
            {"step_index": 1, "source": "usage_truth", "before": _usage(40, 50, 10), "after": _usage(30, 30, 0)},
        ]), encoding="utf-8")
        rc, rep = _run_main(["--items", str(items_f), "--pretty"])
        assert rc == 0 and rep["measurement_count"] == 2 and len(rep["measurements"]) == 2

        rc, rep = _run_main(["--items", str(dp / "no.json")])
        assert rc == 1 and rep["error_type"] == "missing_items"

        bad = dp / "bad.json"
        bad.write_text("{nope", encoding="utf-8")
        rc, rep = _run_main(["--items", str(bad)])
        assert rc == 1 and rep["error_type"] == "malformed_items_json"

        ml = dp / "ml.json"
        ml.write_text(json.dumps([{"step_index": 0, "source": "bogus"}]), encoding="utf-8")
        rc, rep = _run_main(["--items", str(ml)])
        assert rc == 1 and rep["error_type"] == "unknown_source"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} substrate_measurement_adapter tests passed")
