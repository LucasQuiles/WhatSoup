#!/usr/bin/env python3
"""Tests for anchor_preservation_gate — SEMANTIC survival gate (P3/bead 1.3, COMP-01). Standalone.

Keystone (COMP-01): a compression that keeps the anchor STRING but drops the meaning must FAIL — a
stripped negation ("must NOT retry" -> "must retry") and a detached qualifier (entity + qualifier both
present but far apart) are caught, where a lexical "is the token still here?" check would pass. Expected
outcomes are re-derived from the gate's documented semantics, not from f(x)==f(x).
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import anchor_preservation_gate as ag  # noqa: E402


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except ag.AnchorGateError as exc:
        return exc.error_type
    return None


# --- proximity helper ----------------------------------------------------------

def test_min_span_gap_basic():
    assert ag._min_span_gap("alpha beta", "alpha", "beta") == 1   # one space between spans
    assert ag._min_span_gap("alpha beta", "alpha", "zzz") is None  # absent
    assert ag._min_span_gap("notvalid", "not", "valid") == 0       # touching/overlapping spans


# --- simple + negation survival ------------------------------------------------

def test_simple_anchor_survives_and_drops():
    anchors = [{"kind": "simple", "text": "retry limit is 3"}]
    keep = ag.gate("the retry limit is 3 today", "retry limit is 3", anchors)
    assert keep["preserved"] is True and keep["overall_verdict"] == "PASS"
    drop = ag.gate("the retry limit is 3 today", "the retry policy changed", anchors)
    assert drop["preserved"] is False and "anchor_dropped" in drop["miss_reasons"]
    assert drop["recommended_action"] == "fallback_to_verbatim"


def test_negation_inversion_is_caught():
    # COMP-01: the negation phrase is the meaning; dropping it inverts -> FAIL (not "mostly fine")
    anchors = [{"kind": "negation", "text": "do not retry"}]
    inverted = ag.gate("you must do not retry on a 500 error", "you must retry on a 500 error", anchors)
    assert inverted["preserved"] is False and "negation_inverted" in inverted["miss_reasons"]


# --- paired-pattern anchors (the COMP-01 mitigation) ---------------------------

def test_paired_anchor_survives_when_in_proximity():
    anchors = [{"kind": "paired", "entity": "migration 0043", "qualifier": "must not run", "max_gap": 16}]
    orig = "the backfill must not run before migration 0043 completes"
    comp = "must not run before migration 0043"
    r = ag.gate(orig, comp, anchors)
    assert r["preserved"] is True


def test_paired_anchor_fails_when_qualifier_detached():
    # both tokens survive but the qualifier no longer governs the entity (far apart) -> qualifier_detached
    anchors = [{"kind": "paired", "entity": "migration 0043", "qualifier": "must not run", "max_gap": 8}]
    orig = "the backfill must not run before migration 0043 completes"
    detached = ("must not run the early seed job " + "x " * 30 + "then start migration 0043")
    r = ag.gate(orig, detached, anchors)
    assert r["preserved"] is False and "qualifier_detached" in r["miss_reasons"]


def test_paired_anchor_fails_when_member_dropped():
    anchors = [{"kind": "paired", "entity": "migration 0043", "qualifier": "must not run", "max_gap": 16}]
    orig = "the backfill must not run before migration 0043 completes"
    dropped = "start migration 0043 now"  # qualifier gone entirely
    r = ag.gate(orig, dropped, anchors)
    assert r["preserved"] is False and "paired_member_dropped" in r["miss_reasons"]


# --- precondition + fail-closed errors -----------------------------------------

def test_anchor_absent_from_original_is_malformed_spec():
    anchors = [{"kind": "simple", "text": "this phrase is not in the source"}]
    assert _err(ag.gate, "a wholly different original text", "whatever", anchors) == "malformed_spec"


def test_paired_not_in_proximity_in_original_is_malformed_spec():
    # entity + qualifier both in original but FAR apart -> the pairing premise is false
    anchors = [{"kind": "paired", "entity": "alpha", "qualifier": "omega", "max_gap": 4}]
    orig = "alpha " + "y " * 40 + "omega"
    assert _err(ag.gate, orig, "alpha omega", anchors) == "malformed_spec"


def test_malformed_specs_fail_closed():
    assert _err(ag.gate, "x", "y", []) == "malformed_spec"
    assert _err(ag.gate, "x", "y", [{"kind": "simple"}]) == "malformed_spec"
    assert _err(ag.gate, "x", "y", [{"kind": "paired", "entity": "a"}]) == "malformed_spec"
    assert _err(ag.gate, "x", "y", [{"kind": "mystery", "text": "z"}]) == "malformed_spec"
    assert _err(ag.gate, "x", "y", [{"kind": "paired", "entity": "a", "qualifier": "b", "max_gap": -1}]) == "malformed_spec"
    assert _err(ag.gate, 123, "y", [{"kind": "simple", "text": "a"}]) == "malformed_input"


def test_output_is_metadata_only():
    anchors = [{"kind": "simple", "text": "secret token abc123"}]
    r = ag.gate("the secret token abc123 lives here", "the secret token abc123 lives here", anchors)
    blob = json.dumps(r)
    assert "abc123" not in blob  # anchor text never echoed; only hashed ids


# --- corpus (worst-case) -------------------------------------------------------

def test_corpus_worst_case_and_errors():
    good = {"original": "retry limit is 3 here", "compressed": "retry limit is 3",
            "anchors": [{"kind": "simple", "text": "retry limit is 3"}]}
    bad = {"original": "do not retry now", "compressed": "do retry now",
           "anchors": [{"kind": "negation", "text": "do not retry"}]}
    rep = ag.gate_corpus([good, bad])
    assert rep["overall_verdict"] == "FAIL" and rep["failed_indices"] == [1]
    assert ag.gate_corpus([good])["overall_verdict"] == "PASS"
    rep0 = ag.gate_corpus([])
    assert rep0["overall_verdict"] == "FAIL" and rep0["error_type"] == "empty_corpus"
    assert _err(ag.gate_corpus, [{"original": "a", "compressed": "b"}]) == "malformed_item"


# --- CLI e2e -------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["anchor_preservation_gate.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = ag.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_pass_fail_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        good = dp / "good.json"
        good.write_text(json.dumps([{"original": "retry limit is 3 here", "compressed": "retry limit is 3",
                                      "anchors": [{"kind": "simple", "text": "retry limit is 3"}]}]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(good), "--pretty"])
        assert rc == 0 and rep["overall_verdict"] == "PASS"

        bad = dp / "bad.json"
        bad.write_text(json.dumps([{"original": "do not retry now", "compressed": "do retry now",
                                    "anchors": [{"kind": "negation", "text": "do not retry"}]}]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(bad)])
        assert rc == 1 and rep["overall_verdict"] == "FAIL"

        rc, rep = _run_main(["--corpus", str(dp / "nope.json")])
        assert rc == 1 and rep["error_type"] == "missing_corpus"

        mal = dp / "mal.json"
        mal.write_text("{not json", encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(mal)])
        assert rc == 1 and rep["error_type"] == "malformed_corpus"

        bi = dp / "bi.json"
        bi.write_text(json.dumps([{"original": "a", "compressed": "b"}]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(bi)])
        assert rc == 1 and rep["error_type"] == "malformed_item"


def test_simple_anchor_empty_text_is_malformed_spec():
    # A simple/negation anchor needs NON-EMPTY text (guard `not isinstance(text, str) or not text`).
    # An and-weakening would accept an empty-string anchor (isinstance is True, so the conjunction is
    # False), silently admitting a vacuous anchor that "matches" everywhere and proves nothing.
    assert _err(ag.gate, "some original text", "compressed",
                [{"kind": "simple", "text": ""}]) == "malformed_spec"


def test_paired_max_gap_negative_rejected_zero_accepted():
    # paired max_gap must be a NON-NEGATIVE int (guard `not isinstance(gap, int) or gap < 0`).
    # Two boundaries: a negative gap is REJECTED (the bool disjunct); max_gap == 0 (entity
    # immediately adjacent to qualifier) is a VALID spec and must be ACCEPTED (the strict `< 0`).
    # An and-weakening would admit a negative gap; a <= weakening would reject the legitimate zero.
    neg = [{"kind": "paired", "entity": "alpha", "qualifier": "beta", "max_gap": -1}]
    assert _err(ag.gate, "alpha beta", "alpha beta", neg) == "malformed_spec"
    # max_gap == 0: "alphabeta" places entity end exactly at qualifier start (gap 0) -> valid spec,
    # so the gate evaluates preservation rather than rejecting the spec.
    zero = [{"kind": "paired", "entity": "alpha", "qualifier": "beta", "max_gap": 0}]
    assert _err(ag.gate, "alphabeta", "alphabeta", zero) != "malformed_spec"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} anchor_preservation_gate tests passed")
