#!/usr/bin/env python3
"""Tests for faithfulness_canary_corpus — the content-class fidelity-cliff proof. Standalone runner.

Keystone (IS the thesis): across every content class, the FAITHFUL compression raises no alarm and
the CLIFF compression is caught by the union of {faithfulness, gap}. Expectations are re-derived
independently per class (a numeric/date/id/entity cliff drops the anchor -> faithfulness delta < 0;
the negation cliff inverts polarity -> negation broken), never asserted as f(x)==f(x).
"""
import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import faithfulness_canary_corpus as cc  # noqa: E402
import faithfulness_evaluator as fe  # noqa: E402
import bleu_faithfulness_gap as bg  # noqa: E402


# --- corpus shape --------------------------------------------------------------

def test_corpus_covers_the_five_named_content_classes():
    ids = [c.class_id for c in cc.canary_classes()]
    # independently-known required content classes the fidelity cliff breaks
    assert set(ids) == {"numeric", "date", "identifier", "negation", "entity"}
    assert len(ids) == len(set(ids))  # no duplicates


def test_every_fixture_is_well_formed_for_the_scorers():
    # the fixtures must be valid faithfulness_evaluator input (else the proof is vacuous)
    for c in cc.canary_classes():
        r = fe.evaluate_pair(c.original, c.faithful, c.fixture)
        assert r["success_compressed"] == 1.0  # faithful keeps every anchor + negation


# --- per-class: faithful raises no alarm, cliff is caught -----------------------

def test_each_faithful_compression_is_clean_on_both_scorers():
    for c in cc.canary_classes():
        item = [{"fixture": c.fixture, "original": c.original, "compressed": c.faithful}]
        assert fe.evaluate_corpus(item)["overall_verdict"] == "ADOPT", c.class_id
        assert bg.evaluate_corpus(item)["overall_verdict"] == "PASS", c.class_id


def test_each_cliff_is_caught_and_attribution_is_correct():
    by_id = {c.class_id: c for c in cc.canary_classes()}
    for cid, klass in by_id.items():
        rec = cc._classify_catch(klass, bg.DEFAULT_GAP_THRESHOLD)
        assert rec["cliff_caught"] is True, cid
        # independently re-derive the catch signal for this class
        pair = fe.evaluate_pair(klass.original, klass.cliff, klass.fixture)
        if cid == "negation":
            # inverted polarity: negation broken, and lexically near-identical -> gap also fires
            assert pair["negations_broken_by_compression"] == 1
            assert "faithfulness" in rec["caught_by"]
        else:
            # numeric/date/identifier/entity: the lone anchor is dropped -> success falls
            assert pair["faithfulness_delta"] < 0
            assert "faithfulness" in rec["caught_by"]


# --- top-level evaluate --------------------------------------------------------

def test_default_corpus_passes():
    rep = cc.evaluate()
    assert rep["overall_verdict"] == "PASS"
    assert rep["faithful_arm"]["no_false_alarm"] is True
    assert rep["cliff_arm"]["all_cliffs_caught"] is True
    assert rep["cliff_arm"]["uncaught_class_ids"] == []
    assert rep["class_count"] == 5
    assert rep["reject_reasons"] == []


def test_evaluate_is_metadata_only():
    rep = cc.evaluate()
    blob = json.dumps(rep)
    # no raw fixture/original/compressed text may leak into the report
    for c in cc.canary_classes():
        assert c.original not in blob
        assert c.cliff not in blob
        assert c.fixture["question"] not in blob


def test_empty_corpus_fails_closed():
    rep = cc.evaluate(classes=())
    assert rep["overall_verdict"] == "FAIL" and rep["error_type"] == "empty_corpus"
    assert rep["class_count"] == 0


def test_uncaught_cliff_fails_closed():
    # a "cliff" that changes nothing keeps the anchor (delta 0) and gap 0 -> neither detector fires
    inert = cc.CanaryClass(
        class_id="inert", description="control: cliff identical to original",
        fixture={"id": "inert-1", "question": "q", "answer_anchors": ["the anchor span"], "negations": []},
        original="the anchor span is present",
        faithful="the anchor span is present",
        cliff="the anchor span is present",
    )
    rep = cc.evaluate(classes=(inert,))
    assert rep["overall_verdict"] == "FAIL"
    assert rep["cliff_arm"]["all_cliffs_caught"] is False
    assert "inert" in rep["cliff_arm"]["uncaught_class_ids"]
    assert any(r.startswith("uncaught_cliffs:") for r in rep["reject_reasons"])
    # the catch record shows no detector fired
    assert rep["cliff_arm"]["catches"][0]["caught_by"] == []


def test_faithful_false_alarm_fails_closed():
    # a class whose "faithful" arm actually drops the anchor must trip the false-alarm guard
    broken = cc.CanaryClass(
        class_id="broken", description="control: faithful arm drops the anchor",
        fixture={"id": "broken-1", "question": "q", "answer_anchors": ["needed span"], "negations": []},
        original="the needed span is here",
        faithful="unrelated text",      # anchor dropped -> faithfulness REJECT on the faithful arm
        cliff="unrelated text",
    )
    rep = cc.evaluate(classes=(broken,))
    assert rep["overall_verdict"] == "FAIL"
    assert rep["faithful_arm"]["no_false_alarm"] is False
    assert "faithful_arm_false_alarm" in rep["reject_reasons"]


def test_evaluate_deterministic_across_independent_calls():
    r1 = cc.evaluate()
    r2 = cc.evaluate()
    assert json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)
    assert r1["overall_verdict"] == "PASS"  # independently-known verdict for the curated corpus


# --- CLI e2e -------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["faithfulness_canary_corpus.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = cc.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_default_pass_and_list():
    rc, rep = _run_main(["--pretty"])
    assert rc == 0 and rep["overall_verdict"] == "PASS"

    rc, listing = _run_main(["--list", "--pretty"])
    assert rc == 0
    listed = {c["class_id"] for c in listing["classes"]}
    assert listed == {"numeric", "date", "identifier", "negation", "entity"}

    # threshold/tolerance/floor flags are accepted and still pass on the curated corpus
    rc, rep = _run_main(["--threshold", "0.25", "--tolerance", "0.0", "--success-floor", "0.0"])
    assert rc == 0 and rep["overall_verdict"] == "PASS"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} faithfulness_canary_corpus tests passed")
