#!/usr/bin/env python3
"""cape_shadow_enricher — activation-ladder step 2: run the ENRICHER plane in log-would-do (shadow) mode.

Companion to cape_shadow_runner (reducer). The enricher ADDS bounded context for quality, so its shadow
report is a COST + SAFETY picture, not a saving: would the plane inject enrichment, at what provider-truth
token COST, and is that injection SAFE (sanitized prompt with zero residual leak + an intact per-call fence).
Whether the enrichment is actually ADOPTED is a SEPARATE statistical decision (`enricher_lift_gate` over >=50
paired trials, win-rate lift per added token >= tau) — NOT a per-session call and explicitly out of scope here.

Pipeline (log-would-do, all offline, no side effects): load SSOT patterns -> `prompt_sanitizer.sanitize`
(mask the prompt, fail-closed on residual leak) -> `injection_fence.fence` (sanitize + nonce-wrap the
retrieved context) -> `injection_fence.inject_at_end` (compute the candidate enriched prompt — NEVER applied).
The whole pipeline runs inside `shadow_harness.run_shadow`; a clean run touches NO `ShadowBoundary` side effect
-> PASS/no_side_effects. The boundary is the safety net: a pipeline that wrongly injects the candidate into a
live prompt / calls the provider (the `apply_violation` helper) is caught -> FAIL.

Token honesty: byte cost is a LOCAL proxy reported separately. The added-token COST is provider-truth only
(from the fixture's paired usage where enrichment raises input tokens); absent usage -> `unknown`, never
chars/4. Deterministic: the fence per-call nonce is derived from the session key (sha256), so a shadow report
is reproducible. Metadata-only: counts / fractions / booleans, never raw prompt, context, or masked text.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from typing import Any

import injection_fence as inj
import prompt_sanitizer as ps
import sensitive_pattern_loader as spl
import shadow_harness as sh
import substrate_measurement_adapter as sma

SCHEMA = "agent-runtime-cape-shadow-enricher"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only; emits enrich decision/cost fractions/safety booleans/side-effect verdict, never raw text"


def _det_nonce(session_key: str):
    """A DETERMINISTIC per-fixture fence nonce source (sha256 of the session key). Keeps the shadow report
    reproducible; the nonce VALUE never enters the metadata-only report, only the fact the fence round-trips."""
    digest = hashlib.sha256((session_key + "|cape-fence").encode("utf-8")).hexdigest()
    return lambda n: (digest * ((n // len(digest)) + 1))[:n]


def _added_cost(usage_before: Any, usage_after: Any) -> tuple[float | None, str]:
    """Provider-truth ADDED-token cost fraction (enrichment raises input tokens), or unknown. The substrate
    adapter measures REDUCTION; enrichment is its negation. Never a chars/4 estimate. `token_reduction`
    returns None for absent/non-dict/incomplete usage, so no extra type guard is needed."""
    red = sma.token_reduction(usage_before, usage_after)
    if red is not None:
        return round(-red, 6), "provider_truth"
    return None, "unknown"


def shadow_enrich(fixture: dict) -> dict:
    """Run one session fixture through the enricher plane in shadow mode. Returns a metadata-only report.
    `fixture`: {session_id, prompt (str), context (str retrieved), session_key (str), [usage_before/after]}."""
    prompt = fixture.get("prompt")
    context = fixture.get("context", "")
    session_key = fixture.get("session_key", "")
    holder: dict[str, Any] = {}

    def _pipeline(_boundary) -> None:
        patterns = spl.load_patterns()
        san = ps.sanitize(prompt, session_key, patterns)
        masked = san.get("masked")
        holder["sanitize_status"] = san.get("session_key_status", "ok")
        holder["sanitize_accepted"] = bool(san.get("report", {}).get("accepted", False))
        if masked is None:
            holder["enrichable"] = False
            return
        # LOG-WOULD-DO: compute the candidate enriched prompt; never inject/call (no boundary side effect).
        nonce = inj.call_nonce(rng=_det_nonce(session_key))
        fenced = inj.fence(context, nonce)
        candidate = inj.inject_at_end(masked, fenced)
        holder["enrichable"] = True
        holder["fence_intact"] = inj.unfence(fenced, nonce) is not None
        holder["masked_bytes"] = len(masked.encode("utf-8"))
        holder["candidate_bytes"] = len(candidate.encode("utf-8"))

    se = sh.run_shadow(_pipeline)
    overall = "shadow_clean" if se["overall_verdict"] == "PASS" else "shadow_unsafe"

    enrichable = bool(holder.get("enrichable"))
    if not enrichable or overall == "shadow_unsafe":
        return _report(fixture, would_enrich=False, accepted=bool(holder.get("sanitize_accepted")),
                       status=holder.get("sanitize_status", "unknown"), fence_intact=False,
                       byte_cost=0.0, tok_cost=None, tok_status="unknown", se=se, overall=overall)

    mb, cb = holder["masked_bytes"], holder["candidate_bytes"]
    byte_cost = round((cb - mb) / mb, 6) if mb else 0.0
    tok_cost, tok_status = _added_cost(fixture.get("usage_before"), fixture.get("usage_after"))
    # context present + sanitize accepted (no residual leak) + fence intact = a usable would-enrich.
    would = bool(context) and bool(holder.get("sanitize_accepted")) and bool(holder.get("fence_intact"))
    return _report(fixture, would_enrich=would, accepted=bool(holder.get("sanitize_accepted")),
                   status=holder.get("sanitize_status", "ok"), fence_intact=bool(holder.get("fence_intact")),
                   byte_cost=byte_cost, tok_cost=tok_cost, tok_status=tok_status, se=se, overall=overall)


def _report(fixture: dict, *, would_enrich: bool, accepted: bool, status: str, fence_intact: bool,
            byte_cost: float, tok_cost: float | None, tok_status: str, se: dict, overall: str) -> dict:
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "session_id": fixture.get("session_id"),
        "would_enrich": would_enrich,
        "sanitize_accepted": accepted,                  # False => residual leak => B1 fallback signal
        "sanitize_status": status,                      # ok | invalid (session key)
        "fence_intact": fence_intact,                   # per-call fence round-trips
        "added_byte_cost_fraction": byte_cost,          # LOCAL proxy — enrichment ADDS, never a saving
        "added_token_cost_fraction": tok_cost,          # provider-truth added cost, or null
        "added_token_cost_status": tok_status,          # provider_truth | unknown
        "adoption_note": "lift adoption is decided by enricher_lift_gate over >=50 paired trials, not here",
        "side_effect_verdict": se["overall_verdict"],   # must be PASS
        "side_effect_status": se["status"],
        "blocked_action_types": se["attempted_action_types"],
        "overall": overall,                             # shadow_clean | shadow_unsafe
    }


def shadow_enrich_corpus(fixtures: list) -> dict:
    """Run a corpus; aggregate fail-closed (ANY unsafe or leaked run -> corpus FAIL)."""
    rows = [shadow_enrich(fx) for fx in fixtures]
    clean = all(r["overall"] == "shadow_clean" for r in rows)
    costs = [r["added_token_cost_fraction"] for r in rows if r["added_token_cost_status"] == "provider_truth"]
    mean_cost = round(sum(costs) / len(costs), 6) if costs else None
    # would_enrich is True only when sanitize_accepted (see shadow_enrich), so an enriched candidate is
    # leak-free BY CONSTRUCTION — no separate corpus leak-gate is needed. We instead report how many
    # prompts were fail-closed-rejected as unsanitizable (fell back to no-enrich).
    rejected = sum(1 for r in rows if not r["sanitize_accepted"])
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "fixture_count": len(rows),
        "would_enrich_count": sum(1 for r in rows if r["would_enrich"]),
        "sanitize_rejected_count": rejected,
        "all_shadow_clean": clean,
        "provider_truth_cost_count": len(costs),
        "mean_provider_truth_cost_fraction": mean_cost,
        "rows": rows,
        "overall_verdict": "PASS" if clean else "FAIL",
    }


def apply_violation(boundary, candidate: str) -> None:
    """A DELIBERATELY-WRONG apply path used only to prove the boundary catches a real enrichment apply:
    injecting the enriched prompt + calling the provider are side effects and must be blocked in shadow mode."""
    boundary.inject("session_prompt", candidate)
    boundary.provider_call("model", candidate)


def _default_corpus() -> list:
    """Synthetic, metadata-only fixtures (no real session text). Enrichment raises input tokens, so the
    paired-usage fixture yields a provider-truth ADDED cost; the no-usage fixture yields unknown."""
    usage_before = {"input_tokens": 500, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 100}
    usage_after = {"input_tokens": 800, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 100}
    return [
        {"session_id": "enrich_with_usage", "prompt": "please respond to the question with care",
         "context": "retrieved policy note: refunds within 30 days", "session_key": "sess-key-aaaa1111",
         "usage_before": usage_before, "usage_after": usage_after},
        {"session_id": "enrich_no_usage", "prompt": "summarize the thread",
         "context": "retrieved: the deadline is friday", "session_key": "sess-key-bbbb2222"},
    ]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Enricher-plane shadow runner (log-would-do; offline).")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args(argv)
    report = shadow_enrich_corpus(_default_corpus())
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0 if report["overall_verdict"] == "PASS" else 2


if __name__ == "__main__":
    sys.exit(main())
