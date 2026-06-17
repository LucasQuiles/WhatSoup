#!/usr/bin/env python3
"""experiment_e5_masker_bijection — E5 (plan bead 3.4): masker bijection corpus, run through the harness.

Characterizes the `prompt_sanitizer` masker over a corpus of overlapping / nested / duplicate / adjacent
sensitive entities, gated by the `experiment_harness` prediction-before-result interlock so the result is
earned, not rationalized.

Findings the corpus is built to surface:
  - PRODUCTION (longest-first, single-pass `prompt_sanitizer.mask`): zero residual leaks AND an exact
    mask->rehydrate bijection over every item. This is the pre-registered success criterion
    (production_residual_leaks == 0).
  - CONTROL (shortest-first overlap resolution): diverges from production on overlapping entities —
    proving span ORDER is load-bearing. HONEST finding (verified empirically against the live SSOT
    patterns): the pattern-based `residual_scan` is necessary-not-sufficient — it does not always flag the
    fragmentation the wrong order causes (e.g. `alice@example.com` -> `alice@<HOST>` exposes `alice@`), so
    the masker's correctness rests on longest-first span resolution, not on residual_scan alone.
  - B1 FALLBACK: when a rehydration would fail (a placeholder missing from the swapmap), the raw output is
    recovered byte-identically via `raw_output_handle_protocol` store/retrieve.

Reuses prompt_sanitizer + sensitive_pattern_loader + experiment_harness + raw_output_handle_protocol. It is
an experiment driver (not a plane gate); proof_class `direct_task_outcome`; fail-closed; metadata-only
(counts / verdicts / hashes — never raw corpus values).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact  # noqa: E402
import prompt_sanitizer as ps  # noqa: E402
import sensitive_pattern_loader as spl  # noqa: E402
import experiment_harness as eh  # noqa: E402
import raw_output_handle_protocol as b1  # noqa: E402

SCHEMA = "agent-runtime-experiment-e5"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

EXPERIMENT_ID = "E5"
_SESSION_KEY = "cape-e5-experiment-session-key-0001"

# Synthetic corpus: overlapping/nested paths, an email containing a host, a duplicated value, adjacency.
_CORPUS = [
    "deploy /Users/testuser/agent-runtime-probes then clean /Users/testuser afterwards",
    "contact alice@example.com or just visit example.com for details",
    "token in /Users/testuser/agent-runtime-probes and again /Users/testuser/agent-runtime-probes here",
    "paths /Users/testuser/a /Users/testuser/b adjacent",
]


def _mask_shortest_first(norm: str, patterns, nonce: str) -> str:
    """CONTROL ONLY: resolve overlapping spans SHORTEST-first (the buggy order), single-pass. Demonstrates
    why production resolves longest-first; never used on a real masking path."""
    matches = []
    for _rank, typ, rx in ps._ordered_patterns(patterns):
        for m in rx.finditer(norm):
            if m.group(0):
                matches.append((m.start(), m.end(), typ))
    matches.sort(key=lambda t: (t[1] - t[0], t[0]))  # shortest first
    occupied = [False] * (len(norm) + 1)
    chosen = []
    for s, e, typ in matches:
        if any(occupied[s:e]):
            continue
        chosen.append((s, e, typ))
        for i in range(s, e):
            occupied[i] = True
    chosen.sort()
    out, cursor = [], 0
    for s, e, typ in chosen:
        out.append(norm[cursor:s])
        out.append(f"__CAPE_{nonce}_{typ}_X__")
        cursor = e
    out.append(norm[cursor:])
    return "".join(out)


def run_corpus(corpus=None, store_dir=None) -> dict:
    """Run the masker corpus; return aggregate metrics (metadata-only). `store_dir` is a caller-controlled
    directory for the B1 raw-handle fallback demonstration."""
    corpus = list(_CORPUS if corpus is None else corpus)
    patterns = spl.load_patterns(None)
    nonce = ps.session_nonce(_SESSION_KEY)

    residual_leaks = 0
    roundtrip_exact = 0
    control_diverged = 0
    for text in corpus:
        norm = ps._normalize(text)
        masked, swapmap = ps.mask(text, nonce, patterns)
        residual_leaks += len(ps.residual_scan(masked, patterns))
        roundtrip_exact += int(ps.rehydrate(masked, swapmap) == norm)
        control_diverged += int(_mask_shortest_first(norm, patterns, nonce) != masked)
    roundtrip_failures = len(corpus) - roundtrip_exact

    b1_fallback_ok = _demonstrate_b1_fallback(corpus[0], nonce, patterns, store_dir) if store_dir else None

    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "direct_task_outcome",
        "item_count": len(corpus),
        "production_residual_leaks": residual_leaks,
        "production_roundtrip_failures": roundtrip_failures,
        "control_diverged_count": control_diverged,
        "b1_fallback_ok": b1_fallback_ok,
    }


def _raises_value_error(fn, *args) -> bool:
    """True iff calling fn(*args) raises ValueError (the fail-closed signal)."""
    try:
        fn(*args)
        return False
    except ValueError:
        return True


def _demonstrate_b1_fallback(text: str, nonce: str, patterns, store_dir) -> bool:
    """Store raw, mask, then force a rehydration failure (a placeholder dropped from the swapmap) and
    confirm (a) rehydrate fails CLOSED and (b) the raw is recovered byte-identically via the B1 handle.
    Assumes `text` masks to >=1 entity (the experiment's corpus[0] guarantees this)."""
    raw_bytes = text.encode("utf-8")
    handle = b1.store(raw_bytes, store_dir)
    masked, swapmap = ps.mask(text, nonce, patterns)
    broken = dict(swapmap)
    broken.pop(next(iter(broken)))  # drop one placeholder -> rehydrate must fail closed
    rehydration_failed = _raises_value_error(ps.rehydrate, masked, broken)
    recovered = b1.retrieve(handle, store_dir)  # fallback: recover from the content-addressed handle
    return rehydration_failed and recovered == raw_bytes


def experiment(store_dir: str) -> dict:
    """Register the (immutable) success criterion, run the corpus, and evaluate the result through the
    harness. Returns {harness report, full metrics}."""
    prediction = {
        "experiment_id": EXPERIMENT_ID,
        "hypothesis": "the production longest-first masker leaks zero residuals over the corpus while "
                      "preserving an exact mask->rehydrate bijection",
        "success_criterion": {"metric": "production_residual_leaks", "comparator": "eq", "threshold": 0},
    }
    eh.register_prediction(prediction, store_dir)
    metrics = run_corpus(store_dir=store_dir)
    harness_report = eh.write_result(EXPERIMENT_ID, metrics, store_dir)
    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "experiment_id": EXPERIMENT_ID,
        "harness": harness_report,
        "metrics": metrics,
    })


def main() -> int:
    ap = argparse.ArgumentParser(description="E5 masker-bijection experiment (run through the harness).")
    ap.add_argument("--run", action="store_true", required=True, help="run the experiment")
    ap.add_argument("--store-dir", required=True, help="caller-controlled dir for predictions + B1 handles")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    try:
        report = experiment(args.store_dir)
    except (eh.PredictionError, ps.SessionKeyError, b1.StoreError) as exc:
        return _emit({"schema": SCHEMA, "error_type": type(exc).__name__, "_error": str(exc),
                      "overall_verdict": "FAIL"}, 1)
    ok = report["harness"]["overall_verdict"] == "PASS"
    return _emit(report, 0 if ok else 1)


if __name__ == "__main__":
    raise SystemExit(main())
