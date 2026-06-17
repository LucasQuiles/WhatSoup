#!/usr/bin/env python3
"""Tests for experiment_e2_additive_through_b3 — E2 through the harness. Standalone.

E2 (plan bead 3.1) CHARACTERIZES B3 (paired_trial_harness) under an additive-only intervention: adding
uncached context tokens (no quality gain) drops the cache_read_to_input_ratio, so B3's `cache_not_worse`
predicate fails and the intervention is NOT adoption-eligible. A contrast improving-reducer arm IS adopted,
showing B3 rejects on the cost/cache merits rather than rejecting everything.

HONEST SCOPE (E2-PROOF): this characterizes B3's REJECTION behavior; it does NOT prove plane separation —
that is `adoption_orchestrator` / bead 4.3. The experiment asserts that caveat is carried in the report.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import experiment_e2_additive_through_b3 as e2  # noqa: E402


def test_b3_rejects_additive_only_intervention():
    m = e2.run_trial()
    assert m["additive_adoption_eligible"] is False
    assert m["additive_b3_adoptions"] == 0
    assert "cache_not_worse" in m["additive_failed_predicates"]


def test_b3_adopts_the_contrast_improving_reducer():
    m = e2.run_trial()
    # B3 is not rejecting everything — a genuine cost-reducing arm is adopted
    assert m["reducer_adoption_eligible"] is True
    assert m["reducer_b3_adoptions"] == 1


def test_scope_caveat_disclaims_plane_separation():
    m = e2.run_trial()
    scope = m["scope"].lower()
    assert "not" in scope and "plane separation" in scope


def test_experiment_registers_prediction_and_confirms():
    with tempfile.TemporaryDirectory() as d:
        store = Path(d) / "preds"
        rep = e2.experiment(store_dir=str(store))
        assert rep["harness"]["overall_verdict"] == "PASS"
        assert rep["harness"]["hypothesis_verdict"] == "confirmed"
        assert rep["metrics"]["additive_b3_adoptions"] == 0
        assert (store / "E2.prediction.json").exists()


def test_experiment_is_reproducible_idempotent_prediction():
    with tempfile.TemporaryDirectory() as d:
        store = str(Path(d) / "preds")
        r1 = e2.experiment(store_dir=store)
        r2 = e2.experiment(store_dir=store)
        assert r1["harness"]["prediction_hash"] == r2["harness"]["prediction_hash"]


def test_output_is_metadata_only():
    m = e2.run_trial()
    blob = json.dumps(m)
    # only predicate names / counts / booleans / labels — no jsonl paths or raw fixture text
    assert ".jsonl" not in blob and "/var/folders" not in blob and "/tmp" not in blob


def _run_main(argv):
    saved = sys.argv
    sys.argv = ["experiment_e2_additive_through_b3.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = e2.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_run_emits_report():
    with tempfile.TemporaryDirectory() as d:
        rc, rep = _run_main(["--run", "--store-dir", str(Path(d) / "preds"), "--pretty"])
        assert rc == 0 and rep["harness"]["hypothesis_verdict"] == "confirmed"
        assert rep["metrics"]["additive_b3_adoptions"] == 0


def test_main_fails_closed_on_unwritable_store():
    with tempfile.TemporaryDirectory() as d:
        bogus = Path(d) / "iam_a_file"
        bogus.write_text("x", encoding="utf-8")
        rc, rep = _run_main(["--run", "--store-dir", str(bogus)])
        assert rc == 1 and rep["overall_verdict"] == "FAIL" and "error_type" in rep


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} experiment_e2_additive_through_b3 tests passed")
