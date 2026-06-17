#!/usr/bin/env python3
"""experiment_e3_mask_cache_stability — E3 (plan bead 3.2): mask cache-stability proxy through the harness.

Proves the `prompt_sanitizer` masker is a cache-FRIENDLY transform — and, crucially, refuses to overclaim
a provider cache HIT from that.

  - BYTE-STABILITY PROXY (measurable, offline): masking is deterministic, and prefix-stable —
    masked(prefix) is a byte-prefix of masked(prefix + suffix), because per-entity placeholders are
    assigned left-to-right with stable coreference counters, so an unchanged prefix masks to identical
    bytes regardless of what follows. Byte-stable prefixes are the NECESSARY condition for provider prompt
    caching. A CONTROL confirms the proxy is meaningful: a CHANGED prefix is not a byte-prefix match.
  - PROVIDER CACHE HIT (honest non-overclaim): whether the provider actually cached requires provider usage
    fields (`cache_read_input_tokens`), which are UNKNOWN offline. The verdict is therefore
    `inconclusive_no_usage` — byte-stability is a proxy, not proof of a cache hit (E3-acceptance / USAGE-TRUTH).

Run through `experiment_harness` (pre-registered criterion `prefix_stability_failures == 0`). proof_class
`direct_task_outcome`; metadata-only (counts / verdicts / hashes, never raw text).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact  # noqa: E402
import prompt_sanitizer as ps  # noqa: E402
import sensitive_pattern_loader as spl  # noqa: E402
import experiment_harness as eh  # noqa: E402

SCHEMA = "agent-runtime-experiment-e3"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

EXPERIMENT_ID = "E3"
_SESSION_KEY = "cape-e3-experiment-session-key-0001"

# Prefix/suffix sets with sensitive shapes in the PREFIX (paths/hosts — no emails) so masking is non-trivial.
_CORPUS = [
    {"prefix": "system prompt: operate on /Users/testuser/agent-runtime-probes with strict care",
     "suffixes": [" then summarize the audit", " then reconcile /Users/testuser/logs", ""]},
    {"prefix": "deploy target host is build.internal.example and the cache prefix is fixed",
     "suffixes": [" run now", " run after review", ""]},
]


def _provider_cache_verdict(usage) -> str:
    """A provider cache HIT can only be asserted from provider usage; absent/unknown -> inconclusive."""
    if not isinstance(usage, dict):
        return "inconclusive_no_usage"
    cr = usage.get("cache_read_input_tokens")
    if not isinstance(cr, (int, float)) or isinstance(cr, bool):
        return "inconclusive_no_usage"
    return "hit" if cr > 0 else "miss"


def run_corpus(corpus=None, usage=None) -> dict:
    """Measure determinism + prefix byte-stability over the corpus; report the (honest) provider verdict."""
    corpus = list(_CORPUS if corpus is None else corpus)
    patterns = spl.load_patterns(None)
    nonce = ps.session_nonce(_SESSION_KEY)

    determinism_failures = 0
    prefix_stability_failures = 0
    masked_prefixes: list = []
    for item in corpus:
        prefix = item["prefix"]
        m1, _ = ps.mask(prefix, nonce, patterns)
        m2, _ = ps.mask(prefix, nonce, patterns)
        determinism_failures += int(m1 != m2)
        masked_prefixes.append(m1)
        for sfx in item["suffixes"]:
            full, _ = ps.mask(prefix + sfx, nonce, patterns)
            prefix_stability_failures += int(not full.startswith(m1))

    # CONTROL: a DIFFERENT prefix must NOT be a byte-prefix match (the proxy detects prefix changes).
    control_detected = True
    for i, item in enumerate(corpus):
        other = masked_prefixes[(i + 1) % len(corpus)]
        full, _ = ps.mask(item["prefix"] + (item["suffixes"][0]), nonce, patterns)
        if full.startswith(other) and other != masked_prefixes[i]:
            control_detected = False

    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "direct_task_outcome",
        "item_count": len(corpus),
        "determinism_failures": determinism_failures,
        "prefix_stability_failures": prefix_stability_failures,
        "control_prefix_change_detected": control_detected,
        "provider_cache_hit_verdict": _provider_cache_verdict(usage),
    }


def experiment(store_dir: str) -> dict:
    """Register the immutable byte-stability criterion, run the corpus, evaluate through the harness."""
    prediction = {
        "experiment_id": EXPERIMENT_ID,
        "hypothesis": "the masker is deterministic and prefix-stable (masked(prefix) is a byte-prefix of "
                      "masked(prefix+suffix)) — the cache-friendly proxy — while a provider cache HIT stays "
                      "inconclusive without provider usage",
        "success_criterion": {"metric": "prefix_stability_failures", "comparator": "eq", "threshold": 0},
    }
    eh.register_prediction(prediction, store_dir)
    metrics = run_corpus()
    harness_report = eh.write_result(EXPERIMENT_ID, metrics, store_dir)
    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "experiment_id": EXPERIMENT_ID,
        "harness": harness_report,
        "metrics": metrics,
    })


def main() -> int:
    ap = argparse.ArgumentParser(description="E3 mask cache-stability proxy (run through the harness).")
    ap.add_argument("--run", action="store_true", required=True, help="run the experiment")
    ap.add_argument("--store-dir", required=True, help="caller-controlled prediction store directory")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    try:
        report = experiment(args.store_dir)
    except (eh.PredictionError, ps.SessionKeyError) as exc:
        return _emit({"schema": SCHEMA, "error_type": type(exc).__name__, "_error": str(exc),
                      "overall_verdict": "FAIL"}, 1)
    ok = report["harness"]["overall_verdict"] == "PASS"
    return _emit(report, 0 if ok else 1)


if __name__ == "__main__":
    raise SystemExit(main())
