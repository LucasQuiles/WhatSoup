#!/usr/bin/env python3
"""Tests for bleu_faithfulness_gap — the proxy-gaming detector. Standalone runner.

Keystone: a compression that keeps the original's WORDING (high lexical/BLEU overlap) but drops the
answer-anchors (low faithfulness) is the Goodhart gaming pattern and MUST be flagged; a genuinely
faithful compression must NOT be. Synthetic fixtures.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import bleu_faithfulness_gap as bg  # noqa: E402

FIX = {
    "id": "policy-1",
    "question": "Who is eligible and what is the deadline?",
    "answer_anchors": ["admins are eligible", "deadline is june 30"],
    "negations": ["contractors are not eligible"],
}
# punctuation-clean so the token-based lexical_overlap math is exact (faithfulness uses substring
# matching so it is punctuation-tolerant either way; lexical_overlap is token-based, hence sensitive).
ORIGINAL = "per policy admins are eligible contractors are not eligible and the deadline is june 30"
# gaming: lexically all-from-original, but BOTH answer-anchors are gone -> faithfulness 0, lexical high.
GAMING = "contractors are not eligible"
FAITHFUL = "admins are eligible contractors are not eligible deadline is june 30"


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except bg.GapError as exc:
        return exc.error_type
    return None


# --- lexical_overlap (BLEU-1 clipped precision) --------------------------------

def test_lexical_overlap_identical_is_one():
    assert bg.lexical_overlap("a b c", "a b c") == 1.0


def test_lexical_overlap_subset_stays_high():
    # dropping tokens keeps precision high (every remaining token is from the original) — the point.
    assert bg.lexical_overlap("a b c", "a b") == 1.0


def test_lexical_overlap_foreign_tokens_low():
    assert bg.lexical_overlap("a b", "x y") == 0.0


def test_lexical_overlap_clipping():
    # compressed repeats a token more than the original has it -> clipped
    assert bg.lexical_overlap("a", "a a") == 0.5


def test_lexical_overlap_empty_cases():
    assert bg.lexical_overlap("", "") == 1.0
    assert bg.lexical_overlap("a b", "") == 0.0


# --- gap_report ----------------------------------------------------------------

def test_gap_report_flags_proxy_gaming():
    r = bg.gap_report(ORIGINAL, GAMING, FIX)
    assert r["lexical_overlap"] == 1.0  # all words from original
    assert r["faithfulness"] == 0.0      # both anchors dropped
    assert r["gap"] == 1.0 and r["proxy_gaming_flag"] is True


def test_gap_report_faithful_not_flagged():
    r = bg.gap_report(ORIGINAL, FAITHFUL, FIX)
    assert r["faithfulness"] == 1.0 and r["proxy_gaming_flag"] is False


def test_gap_report_malformed_fixture():
    assert _err(bg.gap_report, "a", "b", {"id": "x"}) == "malformed_fixture"
    assert _err(bg.gap_report, "a", "b", {"id": "x", "answer_anchors": ["a"], "negations": "no"}) == "malformed_fixture"


# --- evaluate_corpus -----------------------------------------------------------

def _item(compressed):
    return {"fixture": FIX, "original": ORIGINAL, "compressed": compressed}


def test_corpus_pass_when_no_gaming():
    rep = bg.evaluate_corpus([_item(FAITHFUL)])
    assert rep["overall_verdict"] == "PASS" and rep["flagged_count"] == 0


def test_corpus_fails_on_gaming_fixture():
    rep = bg.evaluate_corpus([_item(FAITHFUL), _item(GAMING)])
    assert rep["overall_verdict"] == "FAIL"
    assert rep["flagged_count"] == 1 and "policy-1" in rep["flagged_ids"]
    assert rep["worst_gap"] == 1.0


def test_corpus_empty_fails_closed():
    rep = bg.evaluate_corpus([])
    assert rep["overall_verdict"] == "FAIL" and rep["error_type"] == "empty_corpus"


def test_corpus_malformed_item():
    assert _err(bg.evaluate_corpus, [{"fixture": FIX, "original": "a"}]) == "malformed_item"


def test_corpus_deterministic_across_independent_calls():
    items = [_item(FAITHFUL)]
    r1 = bg.evaluate_corpus(items)
    r2 = bg.evaluate_corpus(items)
    assert json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)
    assert r1["overall_verdict"] == "PASS" and r1["flagged_count"] == 0


# --- CLI e2e -------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["bleu_faithfulness_gap.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = bg.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_pass_fail_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        good = dp / "good.json"
        good.write_text(json.dumps([_item(FAITHFUL)]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(good), "--pretty"])
        assert rc == 0 and rep["overall_verdict"] == "PASS"

        bad = dp / "bad.json"
        bad.write_text(json.dumps([_item(GAMING)]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(bad)])
        assert rc == 1 and rep["overall_verdict"] == "FAIL"

        rc, rep = _run_main(["--corpus", str(dp / "nope.json")])
        assert rc == 1 and rep["error_type"] == "missing_corpus" and "/Users/" not in rep["_error"]

        mal = dp / "mal.json"
        mal.write_text("{not json", encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(mal)])
        assert rc == 1 and rep["error_type"] == "malformed_corpus"

        bi = dp / "bi.json"
        bi.write_text(json.dumps([{"fixture": FIX, "original": "a"}]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(bi)])
        assert rc == 1 and rep["error_type"] == "malformed_item"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} bleu_faithfulness_gap tests passed")
