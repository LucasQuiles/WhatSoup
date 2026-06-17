#!/usr/bin/env python3
"""Tests for adoption_orchestrator — the two-plane adoption dispatcher (Slice 2 adoption tier). Standalone.

Keystone (the plane-separation guarantee): a reducer adoption request carrying an ENRICHER lift-gate
report — or an enricher request carrying a B3 report — is a cross_plane_violation and is forced to
NOT-adopt EVEN IF that foreign gate said adoption_eligible. The dispatcher PROJECTS the right gate's
verdict, never recomputes it, and tags benefit by axis without ever merging cost and quality. Synthetic
gate reports built to each gate's documented contract (schema + adoption_eligible + axis fields).
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import adoption_orchestrator as ao  # noqa: E402
import paired_trial_harness as b3  # noqa: E402
import enricher_lift_gate as lift  # noqa: E402


def _b3_report(eligible: bool):
    return {
        "schema": b3.SCHEMA, "schema_version": "0.1", "status": "adoption_eligible",
        "adoption_eligible": eligible,
        "metrics": {"tokens": {"token_cost_delta": -120.0}, "cache": {"cache_metrics_present": True},
                    "quality": {"quality_not_worse": True}},
    }


def _lift_report(eligible: bool):
    return {
        "schema": lift.SCHEMA, "schema_version": "0.1", "verdict_status": "adoption_eligible",
        "adoption_eligible": eligible, "win_rate_delta_pp": 4.2, "lift_efficiency": 3.5,
    }


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except ao.AdoptionError as exc:
        return exc.error_type
    return None


# --- happy-path projection per plane -------------------------------------------

def test_reducer_with_b3_eligible_adopts_on_cost_axis():
    r = ao.dispatch("reducer", _b3_report(True))
    assert r["overall_verdict"] == "ADOPT" and r["adopt"] is True
    assert r["routing_ok"] is True and r["cross_plane_violation"] is False
    assert r["benefit_axis"] == "cost" and r["benefit"]["axis"] == "cost"
    assert "tokens" in r["benefit"]["fields"] and r["benefit"]["present"] is True


def test_enricher_with_lift_eligible_adopts_on_quality_axis():
    r = ao.dispatch("enricher", _lift_report(True))
    assert r["overall_verdict"] == "ADOPT" and r["adopt"] is True
    assert r["benefit_axis"] == "quality"
    assert set(r["benefit"]["fields"]) == {"win_rate_delta_pp", "lift_efficiency"}


def test_eligible_false_falls_back():
    r = ao.dispatch("reducer", _b3_report(False))
    assert r["overall_verdict"] == "FALLBACK" and r["adopt"] is False
    assert "gate_not_eligible" in r["reasons"] and r["routing_ok"] is True


# --- THE keystone: cross-plane gate confusion ----------------------------------

def test_reducer_carrying_lift_report_is_cross_plane_violation_even_if_eligible():
    # the foreign gate says ELIGIBLE, but it is the wrong plane's gate -> must NOT adopt.
    r = ao.dispatch("reducer", _lift_report(True))
    assert r["cross_plane_violation"] is True and r["adopt"] is False
    assert r["overall_verdict"] == "FALLBACK" and "cross_plane_violation" in r["reasons"]
    # benefit must not leak the foreign (quality) axis fields
    assert r["benefit"]["fields"] == {} and r["benefit"]["axis"] == "cost"


def test_enricher_carrying_b3_report_is_cross_plane_violation():
    r = ao.dispatch("enricher", _b3_report(True))
    assert r["cross_plane_violation"] is True and r["adopt"] is False
    assert r["benefit"]["axis"] == "quality" and r["benefit"]["fields"] == {}


def test_unrecognized_gate_schema_falls_back_without_cross_plane_flag():
    foreign = {"schema": "agent-runtime-faithfulness-evaluator", "adoption_eligible": True}
    r = ao.dispatch("reducer", foreign)
    assert r["adopt"] is False and r["cross_plane_violation"] is False
    assert "unrecognized_gate_schema" in r["reasons"]


# --- per-axis benefit anti-merge invariant -------------------------------------

def test_reducer_benefit_never_carries_quality_fields():
    # even if a (malformed) reducer report smuggles quality fields, the cost-axis projection drops them
    smuggled = _b3_report(True)
    smuggled["win_rate_delta_pp"] = 9.9
    smuggled["lift_efficiency"] = 9.9
    r = ao.dispatch("reducer", smuggled)
    assert "win_rate_delta_pp" not in r["benefit"]["fields"]
    assert "lift_efficiency" not in r["benefit"]["fields"]


def test_enricher_benefit_never_carries_cost_fields():
    smuggled = _lift_report(True)
    smuggled["metrics"] = {"tokens": {"token_cost_delta": -500.0}}
    r = ao.dispatch("enricher", smuggled)
    assert "tokens" not in r["benefit"]["fields"]
    assert set(r["benefit"]["fields"]) == {"win_rate_delta_pp", "lift_efficiency"}


# --- strict-bool projection (red-team F5) ---------------------------------------

def test_truthy_non_bool_eligibility_does_not_adopt():
    sneaky = _b3_report(True)
    sneaky["adoption_eligible"] = 1  # truthy int, not True
    r = ao.dispatch("reducer", sneaky)
    assert r["projected_adoption_eligible"] is False and r["adopt"] is False
    assert "gate_not_eligible" in r["reasons"]


# --- typed fail-closed errors --------------------------------------------------

def test_unknown_plane_and_malformed_report_raise():
    assert _err(ao.dispatch, "governance", _b3_report(True)) == "unknown_plane"
    assert _err(ao.dispatch, "reducer", "not-a-dict") == "malformed_report"
    assert _err(ao.dispatch, "reducer", {"schema": b3.SCHEMA}) == "malformed_report"  # no adoption_eligible
    assert _err(ao.dispatch, "reducer", {"adoption_eligible": True}) == "malformed_report"  # no schema


def test_dispatch_is_metadata_only():
    r = ao.dispatch("enricher", _lift_report(True))
    blob = json.dumps(r)
    assert "secret" not in blob.lower() and "/Users/" not in blob


# --- CLI e2e -------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["adoption_orchestrator.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = ao.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_adopt_fallback_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        good = dp / "b3_good.json"
        good.write_text(json.dumps(_b3_report(True)), encoding="utf-8")
        rc, r = _run_main(["--plane", "reducer", "--gate-report", str(good), "--pretty"])
        assert rc == 0 and r["overall_verdict"] == "ADOPT"

        # cross-plane via CLI -> FALLBACK rc1
        liftf = dp / "lift.json"
        liftf.write_text(json.dumps(_lift_report(True)), encoding="utf-8")
        rc, r = _run_main(["--plane", "reducer", "--gate-report", str(liftf)])
        assert rc == 1 and r["cross_plane_violation"] is True

        # missing file
        rc, r = _run_main(["--plane", "reducer", "--gate-report", str(dp / "nope.json")])
        assert rc == 1 and r["error_type"] == "missing_report"

        # malformed JSON
        mal = dp / "mal.json"
        mal.write_text("{not json", encoding="utf-8")
        rc, r = _run_main(["--plane", "reducer", "--gate-report", str(mal)])
        assert rc == 1 and r["error_type"] == "malformed_report"

        # report dict lacking adoption_eligible -> dispatch raises malformed_report
        bad = dp / "bad.json"
        bad.write_text(json.dumps({"schema": b3.SCHEMA}), encoding="utf-8")
        rc, r = _run_main(["--plane", "reducer", "--gate-report", str(bad)])
        assert rc == 1 and r["error_type"] == "malformed_report"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} adoption_orchestrator tests passed")
