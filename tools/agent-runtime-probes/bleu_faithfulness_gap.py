#!/usr/bin/env python3
"""bleu_faithfulness_gap — proxy-gaming detector for the reducer plane.

The documented compression deception (Goodhart): a compressor keeps LEXICAL/BLEU overlap with the
original HIGH (so it looks faithful) while GROUNDEDNESS collapses (it dropped the answer-bearing
content). Optimizing or judging on the cheap lexical proxy alone rewards exactly this. This detector
computes BOTH on the same pair and flags the GAP:

    gap = lexical_overlap(original, compressed) - faithfulness(compressed)

A large positive gap (lexically similar, but the answer-anchors/negation are gone) is the gaming
signature. lexical_overlap is clipped unigram precision (BLEU-1) of the compressed text against the
original; faithfulness is reused from faithfulness_evaluator (answer-anchor survival + negation
polarity), so the two scores are directly comparable.

HONEST SCOPE: this is a heuristic SIGNAL, not a proof. BLEU-1 is a coarse lexical measure and the
faithfulness side is the deterministic groundedness proxy (not a full task eval). The detector catches
the dominant "high BLEU / low groundedness" gaming pattern; it cannot detect gaming that also degrades
lexical overlap, nor semantic drift that preserves anchors. proof_class is `deterministic_verifier`.

Fail-closed + worst-case: a corpus is gaming-clean only if NO fixture's gap exceeds the threshold.
Reports are metadata-only (scores/flags/ids; never raw text or anchors).
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402
import faithfulness_evaluator as fe  # noqa: E402  (reuse _normalize + task_success — single source)

SCHEMA = "agent-runtime-bleu-faithfulness-gap"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

# A pair is gaming-suspect when lexical_overlap exceeds faithfulness by more than this.
DEFAULT_GAP_THRESHOLD = 0.25


class GapError(ValueError):
    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _tokens(text: str) -> list:
    return fe._normalize(text).split()


def lexical_overlap(original: str, compressed: str) -> float:
    """Clipped unigram precision (BLEU-1) of `compressed` against `original`, in [0,1].

    High = the compressed text's tokens are (mostly) drawn from the original — i.e. it *looks*
    faithful lexically. An empty compressed text is defined as 1.0 against an empty original, else 0.0.
    """
    comp = _tokens(compressed)
    orig = _tokens(original)
    if not comp:
        return 1.0 if not orig else 0.0
    oc = Counter(orig)
    cc = Counter(comp)
    clipped = sum(min(n, oc.get(t, 0)) for t, n in cc.items())
    return clipped / len(comp)


def gap_report(original: str, compressed: str, fixture: dict, threshold: float = DEFAULT_GAP_THRESHOLD) -> dict:
    """Per-pair lexical-vs-faithfulness gap. fixture is the faithfulness_evaluator fixture shape."""
    anchors = fixture.get("answer_anchors")
    fid = fixture.get("id")
    if not fid or not isinstance(anchors, list) or not anchors:
        raise GapError("malformed_fixture", "fixture needs id + non-empty answer_anchors")
    negations = fixture.get("negations") or []
    if not isinstance(negations, list):
        raise GapError("malformed_fixture", "negations must be a list")

    lex = lexical_overlap(original, compressed)
    faith, _dropped, _broken = fe.task_success(compressed, anchors, negations)
    gap = lex - faith
    return {
        "id": fid,
        "question_sha256_16": sha256_16(fixture.get("question", "")),
        "lexical_overlap": round(lex, 6),
        "faithfulness": round(faith, 6),
        "gap": round(gap, 6),
        "proxy_gaming_flag": gap > threshold,
    }


def evaluate_corpus(items: list, threshold: float = DEFAULT_GAP_THRESHOLD) -> dict:
    """Worst-case, fail-closed gap scan. Clean only if NO fixture's gap exceeds the threshold."""
    if not isinstance(items, list) or not items:
        return {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "proof_class": "deterministic_verifier", "gap_threshold": threshold,
            "fixture_count": 0, "results": [], "overall_verdict": "FAIL", "error_type": "empty_corpus",
        }
    results: list = []
    for it in items:
        if not isinstance(it, dict) or "fixture" not in it or "original" not in it or "compressed" not in it:
            raise GapError("malformed_item", "each item needs fixture + original + compressed")
        results.append(gap_report(it["original"], it["compressed"], it["fixture"], threshold))

    flagged = [r["id"] for r in results if r["proxy_gaming_flag"]]
    worst_gap = max(r["gap"] for r in results)
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "gap_threshold": threshold,
        "fixture_count": len(results),
        "worst_gap": worst_gap,
        "flagged_count": len(flagged),
        "flagged_ids": flagged,
        "results": results,
        "overall_verdict": "PASS" if not flagged else "FAIL",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Proxy-gaming detector: lexical(BLEU)-vs-faithfulness gap.")
    ap.add_argument("--corpus", required=True, help="JSON file: [{fixture, original, compressed}, ...]")
    ap.add_argument("--threshold", type=float, default=DEFAULT_GAP_THRESHOLD)
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    path = Path(args.corpus)
    if not path.exists():
        report = {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "error_type": "missing_corpus", "_error": f"corpus not found: sha256_16={sha256_16(str(path))}",
            "overall_verdict": "FAIL",
        }
        json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        report = {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "error_type": "malformed_corpus", "_error": f"JSONDecodeError: {exc}", "overall_verdict": "FAIL",
        }
        json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1
    try:
        report = evaluate_corpus(items, threshold=args.threshold)
    except GapError as exc:
        report = {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "error_type": exc.error_type, "_error": exc.message, "overall_verdict": "FAIL",
        }
        json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0 if report["overall_verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
