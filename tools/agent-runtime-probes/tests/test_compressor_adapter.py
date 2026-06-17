#!/usr/bin/env python3
"""Tests for compressor_adapter — reducer-plane entry that gates a compression to ADOPT or B1 FALLBACK
(P3/bead 1.4). Standalone runner; expectations re-derived from the documented contract, not f(x)==f(x).

Keystones:
  - COMPRESS-EXT: an ABSENT or DISABLED external compressor never runs (default path is synthetic only);
    a FAULTY external compressor that IS enabled still cannot bypass the governor + anchor gates.
  - B1-ORDERING: raw is stored before the compressor runs; a store failure fails CLOSED and the
    compressor is never invoked; after ANY fallback the raw is still byte-recoverable via its handle.
  - The reducer plane never adopts an unvalidated reduction: governor over-cap or anchor loss -> verbatim.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import compressor_adapter as ca  # noqa: E402
import raw_output_handle_protocol as b1  # noqa: E402


class _Spy:
    """A compressor whose .called flag proves whether the adapter invoked it."""

    def __init__(self, out):
        self.out = out
        self.called = False

    def __call__(self, text):
        self.called = True
        return self.out if not callable(self.out) else self.out(text)


def _adapt(raw, store_dir, **kw):
    return ca.adapt(raw, store_dir=store_dir, **kw)


# --- happy path: validated reduction is adopted -------------------------------

def test_adapt_adopts_validated_reduction():
    with tempfile.TemporaryDirectory() as d:
        anchors = [{"kind": "simple", "text": "retry limit is 3"}]
        # whitespace-collapsing synthetic compressor: reduces, preserves the anchor substring.
        r = _adapt("the   retry limit is 3    today  please", store_dir=d,
                   compressor=ca._synthetic_compressor, anchors=anchors, compressor_id="synthetic")
        assert r["reduced_applied"] is True
        assert r["overall_verdict"] == "ADOPT"
        assert r["output_kind"] == "reduced"
        assert r["governor"]["verdict"] == "PASS"
        assert r["anchor"]["verdict"] == "PASS"
        # raw remains recoverable even on the adopt path
        assert b1.retrieve(r["handle"], d).decode() == "the   retry limit is 3    today  please"


def test_anchors_optional_are_skipped_but_governor_still_gates():
    with tempfile.TemporaryDirectory() as d:
        r = _adapt("alpha   beta   gamma   delta", store_dir=d,
                   compressor=ca._synthetic_compressor, compressor_id="synthetic")
        assert r["reduced_applied"] is True
        assert r["anchor"]["verdict"] == "skipped_no_anchors"
        assert r["governor"]["verdict"] == "PASS"


# --- COMPRESS-EXT: absent / disabled external compressors never run -----------

def test_no_compressor_falls_back_verbatim():
    with tempfile.TemporaryDirectory() as d:
        r = _adapt("some output text", store_dir=d, compressor=None)
        assert r["reduced_applied"] is False
        assert r["overall_verdict"] == "FALLBACK"
        assert r["reason"] == "no_compressor"
        assert r["output_text"] == "some output text"


def test_external_disabled_is_not_invoked():
    with tempfile.TemporaryDirectory() as d:
        spy = _Spy("anything")
        r = _adapt("payload here", store_dir=d, compressor=spy, is_external=True, enable_external=False)
        assert spy.called is False  # the load-bearing COMPRESS-EXT assertion
        assert r["reduced_applied"] is False
        assert r["reason"] == "external_compressor_disabled"
        assert r["output_text"] == "payload here"
        assert r["external_attempted"] is False


def test_external_enabled_faulty_output_cannot_bypass_anchor_gate():
    with tempfile.TemporaryDirectory() as d:
        anchors = [{"kind": "negation", "text": "do not retry"}]
        # an ENABLED external compressor that inverts a negation -> must be caught, not adopted.
        faulty = _Spy(lambda t: t.replace("do not retry", "do retry"))
        r = _adapt("on a 500 you must do not retry now", store_dir=d, compressor=faulty,
                   anchors=anchors, is_external=True, enable_external=True, compressor_id="ext-faulty")
        assert faulty.called is True
        assert r["external_attempted"] is True
        assert r["reduced_applied"] is False
        assert r["anchor"]["verdict"] == "FAIL"
        assert "negation_inverted" in r["anchor"]["miss_reasons"]
        assert r["output_kind"] == "verbatim"


# --- faulty compressor handling -----------------------------------------------

def test_compressor_raises_falls_back():
    with tempfile.TemporaryDirectory() as d:
        def boom(_):
            raise RuntimeError("kaboom")
        r = _adapt("text", store_dir=d, compressor=boom)
        assert r["reduced_applied"] is False
        assert r["reason"].startswith("compressor_raised:RuntimeError")
        assert r["output_text"] == "text"


def test_compressor_non_string_falls_back():
    with tempfile.TemporaryDirectory() as d:
        r = _adapt("text", store_dir=d, compressor=lambda _: 123)
        assert r["reduced_applied"] is False
        assert r["reason"] == "compressor_non_string_output"


def test_compressor_dict_form_adopts_and_malformed_dict_falls_back():
    with tempfile.TemporaryDirectory() as d:
        ok = _adapt("alpha   beta   gamma", store_dir=d, compressor=lambda _: {"reduced": "alpha beta gamma"})
        assert ok["reduced_applied"] is True and ok["output_kind"] == "reduced"
        bad = _adapt("alpha beta", store_dir=d, compressor=lambda _: {"no_reduced_key": "x"})
        assert bad["reduced_applied"] is False and bad["reason"] == "compressor_malformed_output"


def test_over_compression_caught_by_governor():
    with tempfile.TemporaryDirectory() as d:
        # empty output is infinite compression -> governor FAIL -> verbatim fallback
        r = _adapt("a fairly long original output that should not vanish entirely", store_dir=d,
                   compressor=lambda _: "")
        assert r["reduced_applied"] is False
        assert r["governor"]["verdict"] == "FAIL"
        assert r["output_kind"] == "verbatim"


# --- B1-ORDERING: store-before-compress, fail closed, raw recoverable ---------

def test_store_error_fails_closed_and_compressor_not_invoked():
    with tempfile.TemporaryDirectory() as d:
        bogus = Path(d) / "iam_a_file"
        bogus.write_text("x", encoding="utf-8")  # store_dir path is a FILE -> mkdir fails -> StoreError
        spy = _Spy("reduced")
        r = _adapt("important raw", store_dir=str(bogus), compressor=spy)
        assert spy.called is False  # never invoke the worker if raw could not be stored
        assert r["reduced_applied"] is False
        assert r["store_status"] == "store_error"
        assert r["reason"] == "raw_store_unwritable"
        assert r["output_text"] == "important raw"


def test_empty_raw_falls_back_via_governor_error():
    with tempfile.TemporaryDirectory() as d:
        r = _adapt("", store_dir=d, compressor=lambda _: "")
        assert r["reduced_applied"] is False
        assert r["reason"].startswith("governor_error:")
        assert r["output_text"] == ""


def test_anchor_spec_error_falls_back():
    with tempfile.TemporaryDirectory() as d:
        # anchor text not present in the original -> anchor gate raises malformed_spec -> safe fallback
        anchors = [{"kind": "simple", "text": "phrase absent from source"}]
        r = _adapt("alpha beta gamma", store_dir=d, compressor=lambda _: "alpha beta", anchors=anchors)
        assert r["reduced_applied"] is False
        assert r["reason"].startswith("anchor_spec_error:")


def test_raw_recoverable_after_anchor_fallback():
    with tempfile.TemporaryDirectory() as d:
        raw = "keep the do not retry rule intact please"
        anchors = [{"kind": "negation", "text": "do not retry"}]
        r = _adapt(raw, store_dir=d, compressor=lambda t: t.replace("do not retry", "retry"),
                   anchors=anchors)
        assert r["reduced_applied"] is False
        assert b1.retrieve(r["handle"], d).decode() == raw  # safety invariant


# --- metadata-only + malformed input ------------------------------------------

def test_report_is_metadata_only():
    with tempfile.TemporaryDirectory() as d:
        anchors = [{"kind": "simple", "text": "secret token abc123 value"}]
        r = _adapt("the secret token abc123 value is here   now", store_dir=d,
                   compressor=ca._synthetic_compressor, anchors=anchors)
        rep = ca.report_for(r)
        blob = json.dumps(rep)
        assert "abc123" not in blob              # raw/anchor text never echoed
        assert "output_text" not in blob          # working payload dropped from the report
        assert rep["metadata"]["handle"] == r["handle"]
        assert rep["metadata"]["overall_verdict"] in ("ADOPT", "FALLBACK")


def test_malformed_input_is_typed():
    with tempfile.TemporaryDirectory() as d:
        try:
            _adapt(123, store_dir=d, compressor=lambda _: "x")
        except ca.AdapterError as exc:
            assert exc.error_type == "malformed_input"
        else:
            raise AssertionError("expected AdapterError")


# --- corpus + CLI e2e ---------------------------------------------------------

def test_corpus_aggregates_adopt_fallback_and_errors():
    with tempfile.TemporaryDirectory() as d:
        items = [
            {"raw": "alpha   beta   gamma   delta"},                                  # adopt (synthetic)
            {"raw": "keep do not retry", "reduced": "keep retry",
             "anchors": [{"kind": "negation", "text": "do not retry"}]},              # fallback (anchor)
        ]
        rep = ca.adapt_corpus(items, store_dir=d)
        assert rep["item_count"] == 2
        assert rep["adopted_count"] == 1
        assert rep["fallback_count"] == 1
        assert rep["error_count"] == 0
        assert rep["overall_verdict"] == "PASS"  # no fail-closed store errors = plane is sound
        # empty corpus fails closed
        assert ca.adapt_corpus([], store_dir=d)["overall_verdict"] == "FAIL"
        try:
            ca.adapt_corpus([{"no_raw": 1}], store_dir=d)
        except ca.AdapterError as exc:
            assert exc.error_type == "malformed_item"
        else:
            raise AssertionError("expected AdapterError")


def _run_main(argv):
    saved = sys.argv
    sys.argv = ["compressor_adapter.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = ca.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_corpus_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        store = dp / "store"
        corpus = dp / "c.json"
        corpus.write_text(json.dumps([
            {"raw": "alpha   beta   gamma   delta epsilon"},
            {"raw": "keep do not retry now", "reduced": "keep retry now",
             "anchors": [{"kind": "negation", "text": "do not retry"}]},
        ]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(corpus), "--store-dir", str(store), "--pretty"])
        assert rc == 0 and rep["metadata"]["overall_verdict"] == "PASS"
        assert rep["metadata"]["adopted_count"] == 1 and rep["metadata"]["fallback_count"] == 1
        # raw/reduced text must not leak through the CLI report
        assert "epsilon" not in json.dumps(rep)

        rc, rep = _run_main(["--corpus", str(dp / "nope.json"), "--store-dir", str(store)])
        assert rc == 1 and rep["error_type"] == "missing_corpus"

        mal = dp / "mal.json"
        mal.write_text("{nope", encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(mal), "--store-dir", str(store)])
        assert rc == 1 and rep["error_type"] == "malformed_corpus"

        bi = dp / "bi.json"
        bi.write_text(json.dumps([{"no_raw": 1}]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(bi), "--store-dir", str(store)])
        assert rc == 1 and rep["error_type"] == "malformed_item"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} compressor_adapter tests passed")
