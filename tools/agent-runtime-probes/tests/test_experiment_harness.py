#!/usr/bin/env python3
"""Tests for experiment_harness — Phase 3 bead 3.0: prediction-before-result interlock. Standalone.

Keystone (anti-HARKing / anti-fabrication): an experiment's SUCCESS CRITERION must be registered and
made IMMUTABLE before any result is written, and a result can only be produced against a pre-existing,
untampered prediction. You cannot move the goalposts after seeing the data. The harness separates
experiment INTEGRITY (prediction pre-existed + untampered + evaluable -> PASS) from the SCIENTIFIC
OUTCOME (confirmed | refuted | inconclusive — a refuted hypothesis is still a valid result). The
prediction_hash is re-derived INDEPENDENTLY here, not by calling the module's own hasher.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import experiment_harness as eh  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402  (reuse canonical_bytes for the independent hash)


def _pred(eid="E2", metric="b3_reject_rate", comparator="gte", threshold=0.9, hypothesis="additive ctx is rejected by B3"):
    return {"experiment_id": eid, "hypothesis": hypothesis,
            "success_criterion": {"metric": metric, "comparator": comparator, "threshold": threshold}}


def _independent_hash(prediction):
    body = {"experiment_id": prediction["experiment_id"], "hypothesis": prediction["hypothesis"],
            "success_criterion": prediction["success_criterion"]}
    return sha256(eh.PRED_DOMAIN_TAG + mpc.canonical_bytes(body)).hexdigest()


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except eh.PredictionError as exc:
        return exc.error_type
    return None


# --- register + immutability --------------------------------------------------

def test_register_returns_hash_matching_independent_derivation():
    with tempfile.TemporaryDirectory() as d:
        rec = eh.register_prediction(_pred(), d)
        assert rec["prediction_hash"] == _independent_hash(_pred())
        assert rec["experiment_id"] == "E2" and rec["registered"] is True


def test_reregister_identical_is_idempotent_but_different_is_immutable():
    with tempfile.TemporaryDirectory() as d:
        eh.register_prediction(_pred(), d)
        again = eh.register_prediction(_pred(), d)  # identical -> idempotent
        assert again["prediction_hash"] == _independent_hash(_pred())
        # changing the criterion after registration is rejected (no goalpost-moving)
        assert _err(eh.register_prediction, _pred(threshold=0.1), d) == "prediction_immutable"


def test_malformed_prediction_is_typed():
    with tempfile.TemporaryDirectory() as d:
        assert _err(eh.register_prediction, "nope", d) == "malformed_prediction"
        assert _err(eh.register_prediction, {"experiment_id": "E"}, d) == "malformed_prediction"  # no criterion/hypothesis
        assert _err(eh.register_prediction, _pred(comparator="bogus"), d) == "malformed_prediction"
        assert _err(eh.register_prediction, _pred(threshold="x"), d) == "malformed_prediction"
        assert _err(eh.register_prediction, _pred(eid="../etc/passwd"), d) == "malformed_prediction"  # path traversal
        assert _err(eh.register_prediction, _pred(metric=""), d) == "malformed_prediction"
        assert _err(eh.register_prediction, {"experiment_id": "E", "hypothesis": "h",
                                             "success_criterion": "notadict"}, d) == "malformed_prediction"
        # write_result with a path-traversal experiment_id is refused before any file access
        assert _err(eh.write_result, "../etc/passwd", {"m": 1.0}, d) == "malformed_prediction"


# --- write_result interlock + verdicts ----------------------------------------

def test_register_fails_closed_on_unwritable_store():
    with tempfile.TemporaryDirectory() as d:
        bogus = Path(d) / "iam_a_file"
        bogus.write_text("x", encoding="utf-8")  # store-dir path is a FILE -> mkdir fails
        assert _err(eh.register_prediction, _pred(), str(bogus)) == "store_unwritable"


def test_result_without_prediction_fails_closed():
    with tempfile.TemporaryDirectory() as d:
        rep = eh.write_result("E2", {"b3_reject_rate": 0.95}, d)  # never registered
        assert rep["overall_verdict"] == "FAIL" and rep["error_type"] == "no_prediction"


def test_confirmed_and_refuted_both_have_integrity_pass():
    with tempfile.TemporaryDirectory() as d:
        eh.register_prediction(_pred(comparator="gte", threshold=0.9), d)
        confirmed = eh.write_result("E2", {"b3_reject_rate": 0.95}, d)
        assert confirmed["overall_verdict"] == "PASS" and confirmed["hypothesis_verdict"] == "confirmed"
        refuted = eh.write_result("E2", {"b3_reject_rate": 0.50}, d)
        assert refuted["overall_verdict"] == "PASS" and refuted["hypothesis_verdict"] == "refuted"
        assert confirmed["prediction_hash"] == _independent_hash(_pred())


def test_observed_missing_metric_is_inconclusive():
    with tempfile.TemporaryDirectory() as d:
        eh.register_prediction(_pred(), d)
        rep = eh.write_result("E2", {"some_other_metric": 1.0}, d)
        assert rep["overall_verdict"] == "PASS" and rep["hypothesis_verdict"] == "inconclusive"


def test_all_comparators_evaluate():
    cases = [("lte", 0.5, 0.4, "confirmed"), ("lte", 0.5, 0.6, "refuted"),
             ("gte", 0.5, 0.6, "confirmed"), ("lt", 0.5, 0.5, "refuted"),
             ("gt", 0.5, 0.6, "confirmed"), ("eq", 0.5, 0.5, "confirmed"), ("eq", 0.5, 0.51, "refuted")]
    for comp, thr, obs, expected in cases:
        with tempfile.TemporaryDirectory() as d:
            eh.register_prediction(_pred(eid="EC", metric="m", comparator=comp, threshold=thr), d)
            rep = eh.write_result("EC", {"m": obs}, d)
            assert rep["hypothesis_verdict"] == expected, (comp, thr, obs)


def test_tampered_prediction_file_is_detected():
    with tempfile.TemporaryDirectory() as d:
        eh.register_prediction(_pred(), d)
        # an attacker edits the stored criterion after registration but leaves the stored hash
        p = next(Path(d).glob("*.prediction.json"))
        obj = json.loads(p.read_text())
        obj["success_criterion"]["threshold"] = 0.01  # weaken the bar post-hoc
        p.write_text(json.dumps(obj), encoding="utf-8")
        rep = eh.write_result("E2", {"b3_reject_rate": 0.05}, d)
        assert rep["overall_verdict"] == "FAIL" and rep["error_type"] == "prediction_tampered"


def test_output_is_metadata_only():
    with tempfile.TemporaryDirectory() as d:
        rec = eh.register_prediction(_pred(), d)
        rep = eh.write_result("E2", {"b3_reject_rate": 0.95}, d)
        # records carry ids/hashes/enums/one metric value only — no raw paths or fabricated content
        assert "passwd" not in json.dumps([rec, rep])
        assert rep["prediction_hash"] == rec["prediction_hash"]  # result is bound to the registered prediction


# --- CLI e2e ------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["experiment_harness.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = eh.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_register_then_result_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        store = dp / "store"
        pred_f = dp / "pred.json"
        pred_f.write_text(json.dumps(_pred()), encoding="utf-8")

        rc, rec = _run_main(["--register", str(pred_f), "--store-dir", str(store)])
        assert rc == 0 and rec["registered"] is True

        obs_f = dp / "obs.json"
        obs_f.write_text(json.dumps({"b3_reject_rate": 0.95}), encoding="utf-8")
        rc, rep = _run_main(["--result", str(obs_f), "--experiment-id", "E2", "--store-dir", str(store)])
        assert rc == 0 and rep["hypothesis_verdict"] == "confirmed"

        # result with no registered prediction
        rc, rep = _run_main(["--result", str(obs_f), "--experiment-id", "NOPE", "--store-dir", str(store)])
        assert rc == 1 and rep["error_type"] == "no_prediction"

        # --result without --experiment-id
        rc, rep = _run_main(["--result", str(obs_f), "--store-dir", str(store)])
        assert rc == 1 and rep["error_type"] == "missing_experiment_id"

        # missing / malformed files
        rc, rep = _run_main(["--register", str(dp / "no.json"), "--store-dir", str(store)])
        assert rc == 1 and rep["error_type"] == "missing_prediction_file"
        bad = dp / "bad.json"
        bad.write_text("{nope", encoding="utf-8")
        rc, rep = _run_main(["--register", str(bad), "--store-dir", str(store)])
        assert rc == 1 and rep["error_type"] == "malformed_prediction_json"
        rc, rep = _run_main(["--result", str(bad), "--experiment-id", "E2", "--store-dir", str(store)])
        assert rc == 1 and rep["error_type"] == "malformed_observed_json"
        # malformed prediction content via CLI
        mp = dp / "mp.json"
        mp.write_text(json.dumps({"experiment_id": "E", "hypothesis": "h",
                                  "success_criterion": {"metric": "m", "comparator": "bogus", "threshold": 1}}), encoding="utf-8")
        rc, rep = _run_main(["--register", str(mp), "--store-dir", str(store)])
        assert rc == 1 and rep["error_type"] == "malformed_prediction"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} experiment_harness tests passed")
