#!/usr/bin/env python3
"""cape_shadow_runner — activation-ladder step 2: run the REDUCER plane in log-would-do (shadow) mode.

Produces, with a mechanically-proven ZERO-side-effect guarantee, the two numbers that decide whether live
adoption is worth it: (1) would the reducer plane ADOPT a reduction for this session, and (2) what is the
PROVIDER-TRUTH token saving it would yield. Nothing is applied: shadow mode records what it WOULD do and
never injects a reduced prompt, calls a provider, or egresses.

Safety model (reuses shadow_harness): the reducer pipeline runs inside `run_shadow`, which fails the run if
the pipeline attempts ANY side effect through the `ShadowBoundary` (egress / write / inject / provider_call /
external_call). A correct log-would-do pipeline touches NONE of these — it only computes the gated reduction
candidate via `compressor_adapter.adapt` (pure decision) — so a clean shadow run reports PASS / no_side_effects.
The boundary is the safety net: a pipeline that wrongly tries to APPLY the candidate is caught (see the
`apply_violation` helper + its test).

Token-savings honesty: byte reduction is a LOCAL proxy and is reported separately; it is NEVER a savings
claim. The would-save number is provider-truth only — `substrate_measurement_adapter.token_reduction` over
the fixture's paired provider usage (from a prior real measurement); absent/unknown usage -> would_save_status
`unknown`, never a chars/4 estimate. Quality-not-worse is enforced upstream by the plane's own gates (governor
+ anchor); this runner reports the plane's ADOPT/FALLBACK decision, it does not re-judge quality.

Scope: REDUCER plane only (the enricher shadow path is the next sub-unit). Offline, deterministic, metadata-only.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

import compressor_adapter as ca
import shadow_harness as sh
import substrate_measurement_adapter as sma

SCHEMA = "agent-runtime-cape-shadow-runner"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only; emits decisions/byte+token fractions/side-effect verdict, never raw prompt text"


def _default_compressor(text: str) -> str:
    """In-boundary synthetic reducer (collapse whitespace runs). Deterministic, no external dependency;
    the default candidate-producer for a shadow run when a fixture does not supply its own compressor."""
    return " ".join(text.split())


def _would_save(reduced: bool, usage_before: Any, usage_after: Any) -> tuple[float | None, str]:
    """Provider-truth token-fraction saving from paired usage, or unknown. NEVER a chars/4 estimate."""
    if reduced and isinstance(usage_before, dict) and isinstance(usage_after, dict):
        frac = sma.token_reduction(usage_before, usage_after)
        if frac is not None:
            return frac, "provider_truth"
    return None, "unknown"


def shadow_reduce(fixture: dict, *, store_dir: str | Path) -> dict:
    """Run one session fixture through the reducer plane in shadow mode. Returns a metadata-only report.
    `fixture`: {session_id, raw (str), [compressor], [anchors], [content_class], [usage_before], [usage_after]}."""
    raw = fixture.get("raw")
    holder: dict[str, Any] = {}

    def _pipeline(_boundary) -> None:
        # LOG-WOULD-DO: compute the gated reduction decision only. Deliberately touch NO boundary side
        # effect — shadow mode records what it would do; it never injects/calls/egresses.
        holder["adapt"] = ca.adapt(
            raw,
            store_dir=store_dir,
            compressor=fixture.get("compressor") or _default_compressor,
            anchors=fixture.get("anchors"),
            content_class=fixture.get("content_class"),
        )

    se = sh.run_shadow(_pipeline)
    overall = "shadow_clean" if se["overall_verdict"] == "PASS" else "shadow_unsafe"

    res = holder.get("adapt")
    if res is None:
        # the pipeline crashed (run_shadow caught it) -> fail-closed, no decision.
        return _report(fixture, "error", False, 0.0, None, "unknown", se, "shadow_unsafe")

    reduced = bool(res["reduced_applied"])
    raw_bytes, out_bytes = res["raw_bytes"], res["output_bytes"]
    # reduced is True only when the plane adopted a reduction of non-empty content (empty raw always
    # FALLBACKs), so raw_bytes > 0 here; verbatim/fallback rows report 0.0 without dividing.
    byte_red = round((raw_bytes - out_bytes) / raw_bytes, 6) if reduced else 0.0
    save, save_status = _would_save(reduced, fixture.get("usage_before"), fixture.get("usage_after"))
    return _report(fixture, res["overall_verdict"], reduced, byte_red, save, save_status, se, overall)


def _report(fixture: dict, decision: str, reduced: bool, byte_red: float, save: float | None,
            save_status: str, se: dict, overall: str) -> dict:
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "session_id": fixture.get("session_id"),
        "reducer_decision": decision,                       # ADOPT | FALLBACK | error
        "would_reduce_applied": reduced,
        "byte_reduction_fraction": byte_red,                # LOCAL proxy — NOT a token-savings claim
        "would_save_token_fraction": save,                  # provider-truth reduction, or null
        "would_save_status": save_status,                   # provider_truth | unknown
        "side_effect_verdict": se["overall_verdict"],       # must be PASS for a usable estimate
        "side_effect_status": se["status"],                 # no_side_effects when clean
        "blocked_action_types": se["attempted_action_types"],
        "overall": overall,                                 # shadow_clean | shadow_unsafe
    }


def shadow_corpus(fixtures: list, *, store_dir: str | Path) -> dict:
    """Run a corpus of fixtures; aggregate fail-closed (ANY unsafe run -> corpus unsafe)."""
    rows = [shadow_reduce(fx, store_dir=store_dir) for fx in fixtures]
    clean = all(r["overall"] == "shadow_clean" for r in rows)
    # provider_truth status <=> a non-None token fraction (by _would_save's contract), so the single
    # not-None filter is sufficient and unambiguous.
    saves = [r["would_save_token_fraction"] for r in rows if r["would_save_token_fraction"] is not None]
    adopt_count = sum(1 for r in rows if r["reducer_decision"] == "ADOPT")
    mean_save = round(sum(saves) / len(saves), 6) if saves else None
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "fixture_count": len(rows),
        "adopt_count": adopt_count,
        "all_shadow_clean": clean,                          # mechanically: no side effect across the corpus
        "provider_truth_save_count": len(saves),
        "unknown_save_count": len(rows) - len(saves),
        "mean_provider_truth_save_fraction": mean_save,     # informational; null if no provider-truth usage
        "rows": rows,
        "overall_verdict": "PASS" if clean else "FAIL",
    }


def apply_violation(boundary, candidate: str) -> None:
    """A DELIBERATELY-WRONG apply path used only to prove the boundary catches a real apply attempt:
    injecting the reduced prompt + calling the provider are side effects and must be blocked in shadow mode."""
    boundary.inject("session_prompt", candidate)
    boundary.provider_call("model", candidate)


def _default_corpus() -> list:
    """Synthetic, metadata-only fixtures (no real session text). A whitespace-heavy raw reduces; a fixture
    with paired provider usage yields a provider-truth would-save; one without yields unknown."""
    usage_before = {"input_tokens": 800, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 100}
    usage_after = {"input_tokens": 500, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 100}
    return [
        {"session_id": "ws_reducible_with_usage",
         "raw": "please   summarize    the    following     context    with     much   whitespace",
         "usage_before": usage_before, "usage_after": usage_after},
        {"session_id": "ws_reducible_no_usage",
         "raw": "another      whitespace      heavy      session      prompt      to      reduce"},
    ]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Reducer-plane shadow runner (log-would-do; offline).")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args(argv)
    with tempfile.TemporaryDirectory(prefix="cape-shadow-") as d:
        report = shadow_corpus(_default_corpus(), store_dir=d)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0 if report["overall_verdict"] == "PASS" else 2


if __name__ == "__main__":
    sys.exit(main())
