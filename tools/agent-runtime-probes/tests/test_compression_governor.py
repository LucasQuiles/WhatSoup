#!/usr/bin/env python3
"""Tests for compression_governor — per-content-class compression-ratio cap gate (P3/bead 1.2). Standalone.

Keystone: the high-risk classes (numeric/date/identifier/negation) are capped TIGHTER (<=1.67x) than
anchor/prose (<=2.0x), so a 2.0x compression that is fine for prose is REJECTED for numeric content; and
only a `local_measured` calibration may raise a cap (a research_seed never does). Ratios/caps are
re-derived independently here (estimate_tokens = ceil(chars/4)), never asserted as f(x)==f(x).
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import compression_governor as cg  # noqa: E402


def _chars(n: int) -> str:
    return "x" * n


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except cg.GovernorError as exc:
        return exc.error_type
    return None


# --- content-class auto-detection ----------------------------------------------

def test_detect_negation_forces_dense():
    assert cg.detect_content_class("the build is not valid right now") == "negation"


def test_detect_numeric_dense():
    assert cg.detect_content_class("12 34 56 78") == "numeric"


def test_detect_date_dense():
    assert cg.detect_content_class("2026-06-17 2026-06-18") == "date"


def test_detect_prose_default():
    assert cg.detect_content_class("the quick brown fox jumps over lazy dogs today") == "prose"


# --- cap_for_class -------------------------------------------------------------

def test_cap_tiers_match_research_seed():
    assert cg.cap_for_class("numeric") == (1.67, "dense")
    assert cg.cap_for_class("negation") == (1.67, "dense")
    assert cg.cap_for_class("entity") == (2.0, "anchor")
    assert cg.cap_for_class("prose") == (2.0, "anchor")
    # unknown class -> strictest tier, fail-safe
    assert cg.cap_for_class("mystery") == (1.67, "dense")


# --- govern: the ratio gate ----------------------------------------------------

def test_prose_at_2x_is_within_cap():
    # 200 chars -> 50 tok ; 100 chars -> 25 tok ; ratio 2.0 == anchor cap 2.0 -> within
    r = cg.govern(_chars(200), _chars(100), content_class="prose")
    assert r["observed_ratio"] == 2.0 and r["cap"] == 2.0
    assert r["within_cap"] is True and r["overall_verdict"] == "PASS"
    assert r["recommended_action"] == "proceed"


def test_numeric_at_2x_is_over_cap():
    # same 2.0x ratio, but numeric cap is 1.67 -> over cap -> fall back to verbatim
    r = cg.govern(_chars(200), _chars(100), content_class="numeric")
    assert r["within_cap"] is False and r["overall_verdict"] == "FAIL"
    assert r["recommended_action"] == "fallback_to_verbatim"
    assert any(x.startswith("ratio_over_cap:") for x in r["reasons"])


def test_empty_compressed_is_infinite_and_fails():
    r = cg.govern(_chars(40), "", content_class="prose")
    assert r["ratio_is_infinite"] is True and r["observed_ratio"] is None
    assert r["within_cap"] is False and r["overall_verdict"] == "FAIL"


def test_expanded_output_is_flagged_but_within_cap():
    # compressed longer than original: not over-compression, so within cap, but flagged expanded
    r = cg.govern(_chars(40), _chars(80), content_class="prose")
    assert r["expanded"] is True and r["within_cap"] is True


def test_malformed_and_empty_inputs_fail_closed():
    assert _err(cg.govern, 123, "x") == "malformed_input"
    assert _err(cg.govern, "x", None) == "malformed_input"
    assert _err(cg.govern, "", "y") == "empty_original"


def test_auto_detect_used_when_class_absent():
    r = cg.govern("the limit is not 5", _chars(4))
    assert r["content_class"] == "negation" and r["class_was_declared"] is False
    assert r["cap"] == 1.67


# --- calibration provenance (FLOOR-PROVENANCE) ---------------------------------

def _ratio_25():
    # 200 chars -> 50 tok ; 80 chars -> 20 tok ; ratio 2.5
    return _chars(200), _chars(80)

def test_local_measured_calibration_raises_cap():
    orig, comp = _ratio_25()
    cal = {"llmlingua2": {"provenance": "local_measured", "max_ratio": 3.0}}
    r = cg.govern(orig, comp, content_class="numeric", compressor_id="llmlingua2", calibration=cal)
    assert r["cap"] == 3.0 and r["cap_provenance"] == "local_measured"
    assert r["within_cap"] is True  # 2.5 <= 3.0


def test_research_seed_calibration_does_not_raise_cap():
    orig, comp = _ratio_25()
    cal = {"x": {"provenance": "research_seed", "max_ratio": 3.0}}
    r = cg.govern(orig, comp, content_class="numeric", compressor_id="x", calibration=cal)
    assert r["cap"] == 1.67 and r["cap_provenance"] == "research_seed"
    assert r["within_cap"] is False  # seed cap holds; 2.5 > 1.67


def test_bad_local_measured_calibration_fails_closed():
    cal = {"x": {"provenance": "local_measured", "max_ratio": -1}}
    assert _err(cg.govern, _chars(40), _chars(20), content_class="numeric",
                compressor_id="x", calibration=cal) == "bad_calibration"


# --- govern_corpus (worst-case) ------------------------------------------------

def test_corpus_pass_when_all_within():
    items = [{"original": _chars(200), "compressed": _chars(120), "content_class": "numeric"}]  # 1.667 <=1.67
    rep = cg.govern_corpus(items)
    assert rep["overall_verdict"] == "PASS" and rep["over_cap_count"] == 0


def test_corpus_worst_case_fails_on_one_over():
    items = [
        {"original": _chars(200), "compressed": _chars(120), "content_class": "numeric"},  # within
        {"original": _chars(200), "compressed": _chars(100), "content_class": "numeric"},  # 2.0 > 1.67 over
    ]
    rep = cg.govern_corpus(items)
    assert rep["overall_verdict"] == "FAIL" and rep["over_cap_count"] == 1
    assert rep["over_cap_indices"] == [1] and rep["worst_observed_ratio"] == 2.0


def test_corpus_infinite_ratio_surfaced():
    items = [{"original": _chars(40), "compressed": "", "content_class": "prose"}]
    rep = cg.govern_corpus(items)
    assert rep["worst_ratio_is_infinite"] is True and rep["worst_observed_ratio"] is None
    assert rep["overall_verdict"] == "FAIL"


def test_corpus_empty_and_malformed_fail_closed():
    rep = cg.govern_corpus([])
    assert rep["overall_verdict"] == "FAIL" and rep["error_type"] == "empty_corpus"
    assert _err(cg.govern_corpus, [{"original": "a"}]) == "malformed_item"


def test_output_is_metadata_only():
    secret_text = "alice@example.com password=hunter2 lives here in the prose body"
    r = cg.govern(secret_text, _chars(20), content_class="prose")
    blob = json.dumps(r)
    assert "hunter2" not in blob and "alice@example.com" not in blob


# --- CLI e2e -------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["compression_governor.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = cg.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_pass_fail_calibration_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        good = dp / "good.json"
        good.write_text(json.dumps([{"original": _chars(200), "compressed": _chars(120),
                                      "content_class": "numeric"}]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(good), "--pretty"])
        assert rc == 0 and rep["overall_verdict"] == "PASS"

        bad = dp / "bad.json"
        bad.write_text(json.dumps([{"original": _chars(200), "compressed": _chars(100),
                                    "content_class": "numeric"}]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(bad)])
        assert rc == 1 and rep["overall_verdict"] == "FAIL"

        # calibration raises the cap -> the same over-cap item now passes
        cal = dp / "cal.json"
        cal.write_text(json.dumps({"c1": {"provenance": "local_measured", "max_ratio": 3.0}}), encoding="utf-8")
        bad2 = dp / "bad2.json"
        bad2.write_text(json.dumps([{"original": _chars(200), "compressed": _chars(100),
                                     "content_class": "numeric", "compressor_id": "c1"}]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(bad2), "--calibration", str(cal)])
        assert rc == 0 and rep["overall_verdict"] == "PASS"

        rc, rep = _run_main(["--corpus", str(dp / "nope.json")])
        assert rc == 1 and rep["error_type"] == "missing_corpus"

        mal = dp / "mal.json"
        mal.write_text("{not json", encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(mal)])
        assert rc == 1 and rep["error_type"] == "malformed_corpus"

        rc, rep = _run_main(["--corpus", str(good), "--calibration", str(dp / "nocal.json")])
        assert rc == 1 and rep["error_type"] == "missing_calibration"

        malcal = dp / "malcal.json"
        malcal.write_text("{nope", encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(good), "--calibration", str(malcal)])
        assert rc == 1 and rep["error_type"] == "malformed_calibration"

        # malformed item via CLI -> GovernorError surfaced
        bi = dp / "bi.json"
        bi.write_text(json.dumps([{"original": "a"}]), encoding="utf-8")
        rc, rep = _run_main(["--corpus", str(bi)])
        assert rc == 1 and rep["error_type"] == "malformed_item"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} compression_governor tests passed")
