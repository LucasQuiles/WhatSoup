#!/usr/bin/env python3
"""Tests for faithfulness_evaluator — the no-quality-compromise proof. Standalone runner.

The keystone assertions ARE the thesis: a faithful compression (drops filler, keeps answer-anchors)
ADOPTS; a compression that drops an answer-anchor or inverts a negation REJECTS; adoption is WORST-CASE
(one destroyed fixture sinks the whole corpus even if the mean looks fine). Synthetic fixtures.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import faithfulness_evaluator as fe  # noqa: E402

FIX = {
    "id": "policy-1",
    "question": "Who is eligible and what is the deadline?",
    "answer_anchors": ["admins are eligible", "deadline is june 30"],
    "negations": ["contractors are not eligible"],
}
ORIGINAL = "Per policy, admins are eligible, contractors are not eligible, and the deadline is June 30."


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except fe.FaithfulnessError as exc:
        return exc.error_type
    return None


# --- _normalize + task_success -------------------------------------------------

def test_normalize_casefold_and_whitespace():
    assert fe._normalize("  Admins   ARE\tEligible ") == "admins are eligible"


def test_task_success_all_anchors_present():
    score, dropped, broken = fe.task_success(ORIGINAL, FIX["answer_anchors"], FIX["negations"])
    assert score == 1.0 and dropped == 0 and broken == 0


def test_task_success_dropped_anchor_is_fractional():
    text = "the deadline is June 30."
    score, dropped, broken = fe.task_success(text, FIX["answer_anchors"], [])
    assert score == 0.5 and dropped == 1


def test_task_success_broken_negation_forces_zero():
    text = "admins are eligible and the deadline is June 30."  # negation phrase dropped
    score, dropped, broken = fe.task_success(text, FIX["answer_anchors"], FIX["negations"])
    assert score == 0.0 and broken == 1


def test_task_success_empty_anchors_is_one():
    assert fe.task_success("anything", [], [])[0] == 1.0


# --- evaluate_pair -------------------------------------------------------------

def test_evaluate_pair_faithful_compression_delta_zero():
    compressed = "admins are eligible; contractors are not eligible; deadline is June 30."
    r = fe.evaluate_pair(ORIGINAL, compressed, FIX)
    assert r["faithfulness_delta"] == 0.0 and r["success_compressed"] == 1.0


def test_evaluate_pair_lossy_compression_negative_delta():
    compressed = "admins are eligible; contractors are not eligible."  # dropped the deadline anchor
    r = fe.evaluate_pair(ORIGINAL, compressed, FIX)
    assert r["faithfulness_delta"] < 0 and r["anchors_dropped_by_compression"] == 1


def test_evaluate_pair_negation_inversion_zeroes_success():
    compressed = "admins are eligible; deadline is June 30."  # dropped "contractors are not eligible"
    r = fe.evaluate_pair(ORIGINAL, compressed, FIX)
    assert r["success_compressed"] == 0.0 and r["negations_broken_by_compression"] == 1


def test_evaluate_pair_malformed_fixture():
    assert _err(fe.evaluate_pair, "a", "b", {"id": "x"}) == "malformed_fixture"
    assert _err(fe.evaluate_pair, "a", "b", {"answer_anchors": ["x"]}) == "malformed_fixture"
    assert _err(fe.evaluate_pair, "a", "b", {"id": "x", "answer_anchors": ["a"], "negations": "no"}) == "malformed_fixture"


# --- evaluate_corpus (worst-case, fail-closed) ---------------------------------

def _item(compressed, fixture=FIX, original=ORIGINAL):
    return {"fixture": fixture, "original": original, "compressed": compressed}


def test_corpus_adopt_when_all_faithful():
    items = [_item("admins are eligible; contractors are not eligible; deadline is June 30.")]
    rep = fe.evaluate_corpus(items)
    assert rep["overall_verdict"] == "ADOPT" and rep["worst_faithfulness_delta"] == 0.0


def test_corpus_worst_case_rejects_even_if_mean_ok():
    good = _item("admins are eligible; contractors are not eligible; deadline is June 30.")
    bad = _item("admins are eligible; contractors are not eligible.")  # drops deadline -> delta -0.5
    rep = fe.evaluate_corpus([good, bad])
    assert rep["overall_verdict"] == "REJECT"
    assert rep["worst_faithfulness_delta"] == -0.5
    assert any("worst_faithfulness_delta" in r for r in rep["reject_reasons"])


def test_corpus_rejects_negation_break():
    rep = fe.evaluate_corpus([_item("admins are eligible; deadline is June 30.")])
    assert rep["overall_verdict"] == "REJECT"
    assert rep["negations_broken_total"] == 1
    assert any("negation_polarity_broken" in r for r in rep["reject_reasons"])


def test_corpus_rejects_below_floor():
    bad = _item("admins are eligible; contractors are not eligible.")  # success 0.5
    rep = fe.evaluate_corpus([bad], tolerance=1.0, success_floor=0.9)  # tolerance hides delta; floor catches
    assert rep["overall_verdict"] == "REJECT"
    assert any("below_floor" in r for r in rep["reject_reasons"])


def test_corpus_empty_fails_closed():
    rep = fe.evaluate_corpus([])
    assert rep["overall_verdict"] == "FAIL" and rep["error_type"] == "empty_corpus"


def test_corpus_malformed_item():
    assert _err(fe.evaluate_corpus, [{"fixture": FIX, "original": "a"}]) == "malformed_item"


def test_corpus_deterministic_across_independent_calls():
    items = [_item("admins are eligible; contractors are not eligible; deadline is June 30.")]
    r1 = fe.evaluate_corpus(items)
    r2 = fe.evaluate_corpus(items)
    # two INDEPENDENT calls serialize identically (determinism) ...
    assert json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)
    # ... and match the independently-known expected verdict for a faithful single-fixture corpus.
    assert r1["overall_verdict"] == "ADOPT" and r1["worst_faithfulness_delta"] == 0.0


# --- CLI e2e -------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["faithfulness_evaluator.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = fe.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_adopt_reject_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        good = dp / "good.json"
        good.write_text(json.dumps([_item("admins are eligible; contractors are not eligible; deadline is June 30.")]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(good), "--pretty"])
        assert rc == 0 and rep["overall_verdict"] == "ADOPT"

        bad = dp / "bad.json"
        bad.write_text(json.dumps([_item("admins are eligible; deadline is June 30.")]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(bad)])
        assert rc == 1 and rep["overall_verdict"] == "REJECT"

        rc, rep = _run_main(["--corpus", str(dp / "nope.json")])
        assert rc == 1 and rep["error_type"] == "missing_corpus" and "/Users/" not in rep["_error"]

        mal = dp / "mal.json"
        mal.write_text("{not json", encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(mal)])
        assert rc == 1 and rep["error_type"] == "malformed_corpus"

        baditem = dp / "bi.json"
        baditem.write_text(json.dumps([{"fixture": FIX, "original": "a"}]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(baditem)])
        assert rc == 1 and rep["error_type"] == "malformed_item"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} faithfulness_evaluator tests passed")
