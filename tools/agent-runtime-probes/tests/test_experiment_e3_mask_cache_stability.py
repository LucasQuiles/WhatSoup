#!/usr/bin/env python3
"""Tests for experiment_e3_mask_cache_stability — E3 through the harness. Standalone.

E3 (plan bead 3.2) proves the masker is a cache-FRIENDLY transform — deterministic, and prefix-stable
(masked(prefix) is a byte-prefix of masked(prefix+suffix)), the necessary condition for provider prompt
caching — WITHOUT overclaiming a provider cache HIT, which requires provider usage fields that are unknown
offline. Honest split: byte-stability is a measurable PROXY; the provider cache verdict is
`inconclusive_no_usage` until real usage is supplied.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import experiment_e3_mask_cache_stability as e3  # noqa: E402


def test_masked_prefix_is_byte_stable_and_deterministic():
    m = e3.run_corpus()
    assert m["prefix_stability_failures"] == 0
    assert m["determinism_failures"] == 0
    assert m["item_count"] >= 2


def test_provider_cache_hit_is_inconclusive_without_usage():
    m = e3.run_corpus()  # offline: no provider usage
    assert m["provider_cache_hit_verdict"] == "inconclusive_no_usage"


def test_provider_cache_verdict_helper_branches():
    assert e3._provider_cache_verdict(None) == "inconclusive_no_usage"
    assert e3._provider_cache_verdict({"input_tokens": 10}) == "inconclusive_no_usage"  # field absent
    assert e3._provider_cache_verdict({"cache_read_input_tokens": "unknown"}) == "inconclusive_no_usage"
    assert e3._provider_cache_verdict({"cache_read_input_tokens": 5}) == "hit"
    assert e3._provider_cache_verdict({"cache_read_input_tokens": 0}) == "miss"


def test_prefix_change_breaks_stability_control():
    m = e3.run_corpus()
    # the proxy is MEANINGFUL: a changed prefix is NOT a byte-prefix match (it would be detected)
    assert m["control_prefix_change_detected"] is True


def test_experiment_registers_prediction_and_confirms():
    with tempfile.TemporaryDirectory() as d:
        store = Path(d) / "preds"
        rep = e3.experiment(store_dir=str(store))
        assert rep["harness"]["overall_verdict"] == "PASS"
        assert rep["harness"]["hypothesis_verdict"] == "confirmed"
        assert rep["metrics"]["prefix_stability_failures"] == 0
        assert rep["metrics"]["provider_cache_hit_verdict"] == "inconclusive_no_usage"
        assert (store / "E3.prediction.json").exists()


def test_experiment_is_reproducible_idempotent_prediction():
    with tempfile.TemporaryDirectory() as d:
        store = str(Path(d) / "preds")
        r1 = e3.experiment(store_dir=store)
        r2 = e3.experiment(store_dir=store)
        assert r1["harness"]["prediction_hash"] == r2["harness"]["prediction_hash"]


def test_output_is_metadata_only():
    with tempfile.TemporaryDirectory() as d:
        rep = e3.experiment(store_dir=str(Path(d) / "preds"))
        assert "testuser" not in json.dumps(rep)


def _run_main(argv):
    saved = sys.argv
    sys.argv = ["experiment_e3_mask_cache_stability.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = e3.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_run_emits_report():
    with tempfile.TemporaryDirectory() as d:
        rc, rep = _run_main(["--run", "--store-dir", str(Path(d) / "preds"), "--pretty"])
        assert rc == 0 and rep["harness"]["hypothesis_verdict"] == "confirmed"
        assert rep["metrics"]["provider_cache_hit_verdict"] == "inconclusive_no_usage"


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
    print(f"\nall {len(tests)} experiment_e3_mask_cache_stability tests passed")
