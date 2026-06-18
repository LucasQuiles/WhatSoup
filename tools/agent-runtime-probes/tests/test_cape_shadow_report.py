#!/usr/bin/env python3
"""Tests for cape_shadow_report — combined shadow-apparatus dashboard. Standalone.

Pins: the dashboard surfaces each plane's provider-truth number; PASS iff BOTH planes are side-effect clean
(an unsafe fixture in either plane fails the whole apparatus); the net is honestly research_only_synthetic
(never a conflated sum); output is metadata-only and deterministic.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import cape_shadow_report as rep  # noqa: E402
import cape_shadow_runner as csr  # noqa: E402
import cape_shadow_enricher as cse  # noqa: E402


def test_both_planes_clean_dashboard():
    with tempfile.TemporaryDirectory() as d:
        r = rep.apparatus_report(csr._default_corpus(), cse._default_corpus(), store_dir=d)
    assert r["overall_verdict"] == "PASS" and r["side_effect_proven_clean"] is True
    # reducer would-save surfaced (0.3 on the default corpus)
    assert r["reducer"]["adopt_count"] == 2
    assert abs(r["reducer"]["mean_provider_truth_save_fraction"] - 0.3) < 1e-9
    # enricher would-cost surfaced (0.4286 on the default corpus)
    assert r["enricher"]["would_enrich_count"] == 2
    assert abs(r["enricher"]["mean_provider_truth_cost_fraction"] - 0.428571) < 1e-5


def test_net_is_research_only_not_a_conflated_sum():
    with tempfile.TemporaryDirectory() as d:
        r = rep.apparatus_report(csr._default_corpus(), cse._default_corpus(), store_dir=d)
    assert r["net_token_impact_status"] == "research_only_synthetic"
    assert "MUST NOT be summed" in r["net_token_impact_note"]
    # there is deliberately NO single net fraction field to misread
    assert "net_token_impact_fraction" not in r
    assert "NOT a token-savings claim" in r["verdict_meaning"]


def test_malformed_reducer_fixture_fails_whole_apparatus():
    # unhappy path: a malformed reducer fixture (raw not a str -> AdapterError) crashes the shadow run
    # closed (shadow_unsafe), and the whole apparatus must report FAIL.
    with tempfile.TemporaryDirectory() as d:
        bad_reducer = [{"session_id": "malformed", "raw": None}]  # malformed_input -> shadow_unsafe
        r = rep.apparatus_report(bad_reducer, cse._default_corpus(), store_dir=d)
    assert r["reducer"]["all_shadow_clean"] is False
    assert r["side_effect_proven_clean"] is False and r["overall_verdict"] == "FAIL"


def test_malformed_enricher_fixture_fails_whole_apparatus():
    # unhappy path: a malformed enricher fixture (prompt not a str) makes prompt_sanitizer raise, the
    # shadow run fails closed (shadow_unsafe), and the whole apparatus reports FAIL.
    with tempfile.TemporaryDirectory() as d:
        bad_enricher = [{"session_id": "malformed", "prompt": None, "context": "ctx", "session_key": "k" * 16}]
        r = rep.apparatus_report(csr._default_corpus(), bad_enricher, store_dir=d)
    assert r["enricher"]["all_shadow_clean"] is False
    assert r["side_effect_proven_clean"] is False and r["overall_verdict"] == "FAIL"


def test_metadata_only_no_raw_text():
    with tempfile.TemporaryDirectory() as d:
        red = [{"session_id": "r", "raw": "secret   sk-should-not-leak   text"}]
        enr = [{"session_id": "e", "prompt": "respond", "context": "ghp_shouldnotleak", "session_key": "k" * 16}]
        r = rep.apparatus_report(red, enr, store_dir=d)
    blob = json.dumps(r)
    assert "sk-should-not-leak" not in blob and "ghp_shouldnotleak" not in blob


def test_determinism_same_inputs_same_report():
    with tempfile.TemporaryDirectory() as d:
        a = rep.apparatus_report(csr._default_corpus(), cse._default_corpus(), store_dir=d)
        b = rep.apparatus_report(csr._default_corpus(), cse._default_corpus(), store_dir=d)
    assert a == b


def test_cli_emits_pass_and_exit_zero():
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = rep.main(["--pretty"])
    out = json.loads(buf.getvalue())
    assert rc == 0 and out["overall_verdict"] == "PASS"
    assert out["net_token_impact_status"] == "research_only_synthetic"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} cape_shadow_report tests passed")
