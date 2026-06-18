#!/usr/bin/env python3
"""Tests for experiment_e5_masker_bijection — E5 run through the experiment harness. Standalone.

E5 (plan bead 3.4) characterizes the prompt_sanitizer masker over a corpus of overlapping / nested /
duplicate / adjacent sensitive entities, through the prediction-before-result interlock:
  - PRODUCTION (longest-first, single-pass): zero residual leaks AND exact mask->rehydrate bijection — the
    pre-registered success criterion (production_residual_leaks == 0).
  - CONTROL (shortest-first): diverges from production (fragments entities) — proving span ORDER is
    load-bearing. (Honest finding: pattern-based residual_scan is necessary-not-sufficient; it does not
    always flag the fragmentation, so the masker's correctness rests on longest-first resolution.)
  - B1 FALLBACK: on a rehydration failure the raw is recovered byte-identically via the raw-output handle.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import experiment_e5_masker_bijection as e5  # noqa: E402
import experiment_harness as eh  # noqa: E402


def test_production_corpus_zero_residual_and_exact_roundtrip():
    with tempfile.TemporaryDirectory() as d:
        m = e5.run_corpus(store_dir=d)
        assert m["item_count"] >= 3
        assert m["production_residual_leaks"] == 0
        assert m["production_roundtrip_failures"] == 0


def test_control_shortest_first_diverges_from_production():
    with tempfile.TemporaryDirectory() as d:
        m = e5.run_corpus(store_dir=d)
        # span ORDER matters: the shortest-first control masks at least one item differently
        assert m["control_diverged_count"] >= 1


def test_b1_fallback_recovers_raw_on_rehydration_failure():
    with tempfile.TemporaryDirectory() as d:
        m = e5.run_corpus(store_dir=d)
        assert m["b1_fallback_ok"] is True


def test_experiment_registers_prediction_and_confirms():
    with tempfile.TemporaryDirectory() as d:
        store = Path(d) / "preds"
        rep = e5.experiment(store_dir=str(store))
        assert rep["harness"]["overall_verdict"] == "PASS"           # integrity: prediction pre-registered
        assert rep["harness"]["hypothesis_verdict"] == "confirmed"   # production leaks zero residuals
        assert rep["metrics"]["production_residual_leaks"] == 0
        # the prediction file was written immutably under the store
        assert (store / "E5.prediction.json").exists()


def test_experiment_is_reproducible_idempotent_prediction():
    with tempfile.TemporaryDirectory() as d:
        store = str(Path(d) / "preds")
        r1 = e5.experiment(store_dir=store)
        r2 = e5.experiment(store_dir=store)  # re-register identical prediction -> idempotent, no error
        assert r1["harness"]["prediction_hash"] == r2["harness"]["prediction_hash"]


def test_output_is_metadata_only():
    with tempfile.TemporaryDirectory() as d:
        rep = e5.experiment(store_dir=str(Path(d) / "preds"))
        blob = json.dumps(rep)
        # the corpus contains synthetic sensitive shapes; none of the raw values may appear in the report
        assert "testuser" not in blob and "example.com" not in blob and "alice@" not in blob


def test_raises_value_error_helper_both_branches():
    def boom():
        raise ValueError("x")
    assert e5._raises_value_error(boom) is True
    assert e5._raises_value_error(lambda: None) is False


def _run_main(argv):
    saved = sys.argv
    sys.argv = ["experiment_e5_masker_bijection.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = e5.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_run_emits_report():
    with tempfile.TemporaryDirectory() as d:
        rc, rep = _run_main(["--run", "--store-dir", str(Path(d) / "preds"), "--pretty"])
        assert rc == 0
        assert rep["harness"]["hypothesis_verdict"] == "confirmed"
        assert rep["metrics"]["production_residual_leaks"] == 0


def test_main_fails_closed_on_unwritable_store():
    with tempfile.TemporaryDirectory() as d:
        bogus = Path(d) / "iam_a_file"
        bogus.write_text("x", encoding="utf-8")  # store-dir path is a FILE -> StoreError/PredictionError
        rc, rep = _run_main(["--run", "--store-dir", str(bogus)])
        assert rc == 1 and rep["overall_verdict"] == "FAIL" and "error_type" in rep


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} experiment_e5_masker_bijection tests passed")
