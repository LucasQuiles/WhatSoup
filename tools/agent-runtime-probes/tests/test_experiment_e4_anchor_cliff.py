#!/usr/bin/env python3
"""Tests for experiment_e4_anchor_cliff — E4 anchor/cliff sweep through the harness. Standalone.

E4 (plan bead 3.3) sweeps compression levels through BOTH reducer gates. The keystone: the governor's
ratio cap has a SEMANTIC BLIND SPOT — compressions UNDER the cap can still have dropped an anchor — and the
anchor gate closes it, so the COMPOSED gate adopts ZERO meaning-losing compressions. Run through the
prediction-before-result harness so the safety claim is earned.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import experiment_e4_anchor_cliff as e4  # noqa: E402


def test_sweep_quantifies_governor_blind_spots():
    m = e4.run_sweep()
    # the ratio cap ALONE would adopt >=1 compression that lost an anchor (proves the anchor gate matters)
    assert m["governor_only_unsafe_adoptions"] >= 1
    assert len(m["sweep_points"]) == 6


def test_composed_gate_never_adopts_anchor_loss():
    m = e4.run_sweep()
    assert m["adoptions_with_anchor_loss"] == 0
    # every composed adoption preserved all anchors
    for p in m["sweep_points"]:
        if p["composed_adopt"]:
            assert p["anchor_pass"] is True


def test_calibration_candidate_is_source_hashed_local_measured():
    m = e4.run_sweep()
    c = m["calibration_candidate"]
    assert c["provenance"] == "local_measured"          # FLOOR-PROVENANCE: eligible to inform a cap
    assert len(c["source_hash_16"]) == 16
    assert c["cliff_ratio"] is not None and c["cliff_ratio"] > 1.0


def test_experiment_registers_prediction_and_confirms():
    with tempfile.TemporaryDirectory() as d:
        store = Path(d) / "preds"
        rep = e4.experiment(store_dir=str(store))
        assert rep["harness"]["overall_verdict"] == "PASS"
        assert rep["harness"]["hypothesis_verdict"] == "confirmed"
        assert rep["metrics"]["adoptions_with_anchor_loss"] == 0
        assert (store / "E4.prediction.json").exists()


def test_experiment_is_reproducible_idempotent_prediction():
    with tempfile.TemporaryDirectory() as d:
        store = str(Path(d) / "preds")
        r1 = e4.experiment(store_dir=store)
        r2 = e4.experiment(store_dir=store)
        assert r1["harness"]["prediction_hash"] == r2["harness"]["prediction_hash"]


def test_output_is_metadata_only():
    with tempfile.TemporaryDirectory() as d:
        rep = e4.experiment(store_dir=str(Path(d) / "preds"))
        blob = json.dumps(rep)
        assert "must never be silently disabled" not in blob and "system config" not in blob


def _run_main(argv):
    saved = sys.argv
    sys.argv = ["experiment_e4_anchor_cliff.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = e4.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_run_emits_report():
    with tempfile.TemporaryDirectory() as d:
        rc, rep = _run_main(["--run", "--store-dir", str(Path(d) / "preds"), "--pretty"])
        assert rc == 0 and rep["harness"]["hypothesis_verdict"] == "confirmed"
        assert rep["metrics"]["governor_only_unsafe_adoptions"] >= 1


def test_main_fails_closed_on_unwritable_store():
    with tempfile.TemporaryDirectory() as d:
        bogus = Path(d) / "iam_a_file"
        bogus.write_text("x", encoding="utf-8")
        rc, rep = _run_main(["--run", "--store-dir", str(bogus)])
        assert rc == 1 and rep["overall_verdict"] == "FAIL" and "error_type" in rep


def test_sweep_governor_pass_per_point_matches_verdict():
    # governor_pass = (governor overall_verdict == "PASS"): a ==/!= flip inverts the per-point label.
    # The deterministic sweep PASSes the governor at the lightest compression (keep 1.0) and FAILs it
    # at the most aggressive (keep 0.4).
    m = e4.run_sweep()
    by_frac = {p["keep_fraction"]: p for p in m["sweep_points"]}
    assert by_frac[1.0]["governor_pass"] is True
    assert by_frac[0.4]["governor_pass"] is False


def test_sweep_blind_spot_and_safe_ceiling_counts_are_exact():
    # governor_only_unsafe_adoptions = count(governor_pass AND not anchor_pass): the deterministic
    # sweep has EXACTLY 3 such blind spots. An and->or weakening counts 6 (every point); removing the
    # `not` counts 1 (only the all-pass point). safe_ratio_ceiling = max ratio among COMPOSED
    # adoptions; only the keep=1.0 point composes (ratio 1.0), so the ceiling is 1.0 — an and->or
    # weakening of the safe filter would include every point's ratio and raise the ceiling above 1.0.
    m = e4.run_sweep()
    assert m["governor_only_unsafe_adoptions"] == 3
    assert m["safe_ratio_ceiling"] == 1.0


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} experiment_e4_anchor_cliff tests passed")
