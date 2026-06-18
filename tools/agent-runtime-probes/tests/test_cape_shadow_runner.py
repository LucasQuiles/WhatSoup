#!/usr/bin/env python3
"""Tests for cape_shadow_runner — reducer-plane shadow (log-would-do) runner. Standalone.

Pins: a clean shadow run attempts ZERO side effects (PASS/no_side_effects) while recording the plane's
ADOPT/FALLBACK decision; would-save is provider-truth only (paired usage) or `unknown` (never chars/4);
the boundary is a real safety net (a wrong apply path is caught); corpus aggregation is fail-closed;
crash path fails closed; output is metadata-only.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import cape_shadow_runner as csr  # noqa: E402
import shadow_harness as sh  # noqa: E402

USAGE_BEFORE = {"input_tokens": 800, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 100}
USAGE_AFTER = {"input_tokens": 500, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 100}
WS_RAW = "please   summarize    the    following     context    with     much   whitespace"


def _sd(d):
    return {"store_dir": d}


def test_reducible_with_usage_adopts_clean_and_provider_truth_save():
    with tempfile.TemporaryDirectory() as d:
        fx = {"session_id": "s1", "raw": WS_RAW, "usage_before": USAGE_BEFORE, "usage_after": USAGE_AFTER}
        r = csr.shadow_reduce(fx, store_dir=d)
    assert r["reducer_decision"] == "ADOPT" and r["would_reduce_applied"] is True
    assert r["byte_reduction_fraction"] > 0
    assert r["would_save_status"] == "provider_truth"
    assert abs(r["would_save_token_fraction"] - 0.3) < 1e-9
    assert r["side_effect_verdict"] == "PASS" and r["side_effect_status"] == "no_side_effects"
    assert r["blocked_action_types"] == [] and r["overall"] == "shadow_clean"


def test_reducible_without_usage_is_unknown_save():
    with tempfile.TemporaryDirectory() as d:
        r = csr.shadow_reduce({"session_id": "s2", "raw": WS_RAW}, store_dir=d)
    assert r["would_reduce_applied"] is True
    assert r["would_save_status"] == "unknown" and r["would_save_token_fraction"] is None
    assert r["overall"] == "shadow_clean"


def test_compressor_nonstring_falls_back_no_reduction():
    with tempfile.TemporaryDirectory() as d:
        fx = {"session_id": "s3", "raw": WS_RAW, "compressor": lambda t: 12345,
              "usage_before": USAGE_BEFORE, "usage_after": USAGE_AFTER}
        r = csr.shadow_reduce(fx, store_dir=d)
    assert r["reducer_decision"] == "FALLBACK" and r["would_reduce_applied"] is False
    assert r["byte_reduction_fraction"] == 0.0
    # a non-adopted reduction yields no would-save even with usage present
    assert r["would_save_status"] == "unknown" and r["would_save_token_fraction"] is None
    assert r["overall"] == "shadow_clean"


def test_safety_net_boundary_catches_a_wrong_apply():
    # Proves the ShadowBoundary is a real net: a pipeline that injects/calls is caught -> FAIL.
    se = sh.run_shadow(lambda b: csr.apply_violation(b, "candidate-reduced-text"))
    assert se["overall_verdict"] == "FAIL"
    assert "inject" in se["attempted_action_types"]


def test_crash_path_fails_closed():
    # raw is not a string -> compressor_adapter.adapt raises -> run_shadow catches -> shadow_unsafe.
    with tempfile.TemporaryDirectory() as d:
        r = csr.shadow_reduce({"session_id": "s4", "raw": None}, store_dir=d)
    assert r["reducer_decision"] == "error" and r["overall"] == "shadow_unsafe"
    assert r["side_effect_verdict"] == "FAIL"
    assert r["would_reduce_applied"] is False and r["would_save_status"] == "unknown"


def test_corpus_aggregation_fail_closed_and_counts():
    with tempfile.TemporaryDirectory() as d:
        rep = csr.shadow_corpus(csr._default_corpus(), store_dir=d)
    assert rep["overall_verdict"] == "PASS" and rep["all_shadow_clean"] is True
    assert rep["fixture_count"] == 2 and rep["adopt_count"] == 2
    assert rep["provider_truth_save_count"] == 1 and rep["unknown_save_count"] == 1
    assert abs(rep["mean_provider_truth_save_fraction"] - 0.3) < 1e-9


def test_corpus_any_unsafe_marks_corpus_fail():
    with tempfile.TemporaryDirectory() as d:
        corpus = [{"session_id": "ok", "raw": WS_RAW},
                  {"session_id": "bad", "raw": None}]  # crash -> shadow_unsafe
        rep = csr.shadow_corpus(corpus, store_dir=d)
    assert rep["overall_verdict"] == "FAIL" and rep["all_shadow_clean"] is False


def test_metadata_only_no_raw_prompt_in_report():
    secret_raw = "user sk-shadow-should-not-appear   asked   about   billing"
    with tempfile.TemporaryDirectory() as d:
        r = csr.shadow_reduce({"session_id": "s5", "raw": secret_raw}, store_dir=d)
    assert "sk-shadow-should-not-appear" not in json.dumps(r)


def test_determinism_same_inputs_same_report():
    with tempfile.TemporaryDirectory() as d:
        fx = {"session_id": "s6", "raw": WS_RAW, "usage_before": USAGE_BEFORE, "usage_after": USAGE_AFTER}
        a = csr.shadow_reduce(fx, store_dir=d)
        b = csr.shadow_reduce(fx, store_dir=d)
    assert a == b


def test_cli_emits_pass_and_exit_zero():
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = csr.main(["--pretty"])
    out = json.loads(buf.getvalue())
    assert rc == 0 and out["overall_verdict"] == "PASS" and out["fixture_count"] == 2


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} cape_shadow_runner tests passed")
