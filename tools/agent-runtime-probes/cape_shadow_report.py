#!/usr/bin/env python3
"""cape_shadow_report — activation-ladder step 2 capstone: the single shadow-apparatus entry point.

Runs BOTH planes' shadow runners (cape_shadow_runner for the reducer, cape_shadow_enricher for the enricher)
and emits ONE metadata-only dashboard: the mechanically-proven side-effect verdict across both planes, plus
each plane's provider-truth number — the reducer's would-SAVE and the enricher's would-COST. This is the
operational answer to "is CAPE saving tokens, safely?" — run it, read the dashboard.

HONESTY (load-bearing): this does NOT emit a single conflated "net" number. The reducer's save fraction is
over the pre-reduction input baseline; the enricher's cost fraction is over the masked-prompt baseline — they
are DIFFERENT baselines and must NOT be summed. A true NET token impact requires real per-session paired
provider usage over ONE baseline, which only a live/shadow run over real fixtures produces — gated. So the
net status is `research_only_synthetic` until that data exists (mirrors the savings-meter Phase-5 gate). The
PASS verdict here means ONLY "both planes attempted zero side effects," never "CAPE saves tokens."

Offline, deterministic, metadata-only. Composes the two runners; adds no plane logic of its own.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile

import cape_shadow_enricher as cse
import cape_shadow_runner as csr

SCHEMA = "agent-runtime-cape-shadow-report"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only; emits per-plane counts/fractions + side-effect verdict, never raw text"
_NET_NOTE = (
    "Per-plane fractions are over DIFFERENT baselines (reducer: pre-reduction input; enricher: masked "
    "prompt) and MUST NOT be summed. A true net token impact requires real per-session paired provider "
    "usage over one baseline (gated on a live/shadow run over real fixtures)."
)


def apparatus_report(reducer_fixtures: list, enricher_fixtures: list, *, store_dir) -> dict:
    """Run both shadow corpora and assemble the unified dashboard. Fail-closed: PASS iff BOTH planes are
    side-effect clean. PASS asserts zero side effects only — NOT a token saving."""
    red = csr.shadow_corpus(reducer_fixtures, store_dir=store_dir)
    enr = cse.shadow_enrich_corpus(enricher_fixtures)
    both_clean = red["all_shadow_clean"] and enr["all_shadow_clean"]
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "reducer": {
            "fixture_count": red["fixture_count"],
            "adopt_count": red["adopt_count"],
            "provider_truth_save_count": red["provider_truth_save_count"],
            "mean_provider_truth_save_fraction": red["mean_provider_truth_save_fraction"],
            "all_shadow_clean": red["all_shadow_clean"],
        },
        "enricher": {
            "fixture_count": enr["fixture_count"],
            "would_enrich_count": enr["would_enrich_count"],
            "sanitize_rejected_count": enr["sanitize_rejected_count"],
            "provider_truth_cost_count": enr["provider_truth_cost_count"],
            "mean_provider_truth_cost_fraction": enr["mean_provider_truth_cost_fraction"],
            "all_shadow_clean": enr["all_shadow_clean"],
        },
        "side_effect_proven_clean": both_clean,
        "net_token_impact_status": "research_only_synthetic",
        "net_token_impact_note": _NET_NOTE,
        "verdict_meaning": "PASS asserts zero side effects across both planes; it is NOT a token-savings claim",
        "overall_verdict": "PASS" if both_clean else "FAIL",
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="CAPE shadow-apparatus report (both planes; offline).")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args(argv)
    with tempfile.TemporaryDirectory(prefix="cape-shadow-report-") as d:
        report = apparatus_report(csr._default_corpus(), cse._default_corpus(), store_dir=d)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0 if report["overall_verdict"] == "PASS" else 2


if __name__ == "__main__":
    sys.exit(main())
