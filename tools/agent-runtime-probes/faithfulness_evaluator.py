#!/usr/bin/env python3
"""faithfulness_evaluator — the "no quality compromise" proof for the reducer plane.

The central CAPE question is "is compression provably better with NO quality compromise?" A token
reduction is only adoptable if the compressed text STILL answers the questions the original answered.
This evaluator measures that DETERMINISTICALLY and OFFLINE: for each fixture it holds a question plus
the ANSWER-ANCHORS (the spans that must survive to answer it) and NEGATIONS (polarity-bearing spans
whose loss would invert meaning). It scores task-success on the ANSWER (anchor survival + negation
polarity), NOT on BLEU/lexical overlap, and emits a per-fixture + worst-case faithfulness delta.

HONEST SCOPE (do not over-claim): this is a deterministic GROUNDEDNESS proxy — it proves that the
answer-anchors and negation polarity are PRESERVED, which catches the dominant compression failure
mode (dropping answer-bearing content / inverting a negation). It is NOT a full LLM task-success
eval (that needs a provider and is gated/future); it cannot detect subtle semantic drift that keeps
every anchor intact. proof_class is therefore `deterministic_verifier`, never `measured` task success.

Adoption is fail-closed and WORST-CASE: a compressor is faithfulness-OK only if the worst per-fixture
delta is not worse than -tolerance AND no negation polarity broke AND no fixture falls below the floor.
Mean deltas are deliberately NOT used (a mean hides the one fixture the compressor destroyed).

Reports are metadata-only: scores, counts, deltas, ids — never the raw text, question, or anchors.
"""
from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402

SCHEMA = "agent-runtime-faithfulness-evaluator"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

# A compressor is faithfulness-OK only if the WORST per-fixture delta is >= -DEFAULT_TOLERANCE.
DEFAULT_TOLERANCE = 0.0  # default: not-worse-at-all
# Per-fixture absolute floor: even a non-negative delta is rejected if compressed success is below this.
DEFAULT_SUCCESS_FLOOR = 0.0


class FaithfulnessError(ValueError):
    """Typed, fail-closed error: never green a compressor on missing/malformed evidence."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _normalize(text: str) -> str:
    """NFC + casefold + whitespace-collapse so anchor matching is robust to formatting/case but not
    to content. (Casefold, not lower, for correct Unicode case handling.)"""
    folded = unicodedata.normalize("NFC", text).casefold()
    return " ".join(folded.split())


def task_success(text: str, anchors: list, negations: list) -> tuple[float, int, int]:
    """Deterministic answerability score for `text`.

    Returns (score, anchors_dropped, negations_broken).
      score = fraction of answer-anchors present, EXCEPT a broken negation (a polarity span that is
      absent) is a meaning inversion and forces score to 0.0 (total task failure), because answering
      with inverted polarity is worse than not answering.
    """
    norm = _normalize(text)
    present = sum(1 for a in anchors if _normalize(a) in norm)
    dropped = len(anchors) - present
    broken = sum(1 for n in negations if _normalize(n) not in norm)
    if broken:
        return 0.0, dropped, broken
    score = present / len(anchors) if anchors else 1.0
    return score, dropped, broken


def evaluate_pair(original: str, compressed: str, fixture: dict) -> dict:
    """Score one (original, compressed) pair against a fixture. Metadata-only result.

    fixture = {"id": str, "question": str, "answer_anchors": [str,...], "negations": [str,...]?}.
    """
    fid = fixture.get("id")
    anchors = fixture.get("answer_anchors")
    if not fid or not isinstance(anchors, list) or not anchors:
        raise FaithfulnessError("malformed_fixture", "fixture needs id + non-empty answer_anchors")
    negations = fixture.get("negations") or []
    if not isinstance(negations, list):
        raise FaithfulnessError("malformed_fixture", "negations must be a list")

    s_orig, drop_orig, _ = task_success(original, anchors, negations)
    s_comp, drop_comp, broken_comp = task_success(compressed, anchors, negations)
    return {
        "id": fid,
        "question_sha256_16": sha256_16(fixture.get("question", "")),
        "anchor_count": len(anchors),
        "negation_count": len(negations),
        "success_original": round(s_orig, 6),
        "success_compressed": round(s_comp, 6),
        "faithfulness_delta": round(s_comp - s_orig, 6),
        "anchors_dropped_by_compression": max(0, drop_comp - drop_orig),
        "negations_broken_by_compression": broken_comp,
        # token deltas are a SEPARATE cost axis; faithfulness is the quality axis (kept distinct).
    }


def evaluate_corpus(
    items: list,
    tolerance: float = DEFAULT_TOLERANCE,
    success_floor: float = DEFAULT_SUCCESS_FLOOR,
) -> dict:
    """Evaluate a corpus of {fixture, original, compressed} items. Worst-case, fail-closed.

    Adoption verdict is ADOPT only if EVERY fixture clears the bar: worst delta >= -tolerance, zero
    negation breaks, and no compressed success below the floor. Empty corpus is FAIL (no evidence).
    """
    if not isinstance(items, list) or not items:
        return {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "proof_class": "deterministic_verifier",
            "fixture_count": 0, "results": [], "overall_verdict": "FAIL", "error_type": "empty_corpus",
        }
    results: list[dict] = []
    for it in items:
        if not isinstance(it, dict) or "fixture" not in it or "original" not in it or "compressed" not in it:
            raise FaithfulnessError("malformed_item", "each item needs fixture + original + compressed")
        results.append(evaluate_pair(it["original"], it["compressed"], it["fixture"]))

    deltas = [r["faithfulness_delta"] for r in results]
    worst_delta = min(deltas)
    total_broken = sum(r["negations_broken_by_compression"] for r in results)
    min_success = min(r["success_compressed"] for r in results)

    reasons: list[str] = []
    if worst_delta < -tolerance:
        reasons.append(f"worst_faithfulness_delta:{worst_delta}")
    if total_broken > 0:
        reasons.append(f"negation_polarity_broken:{total_broken}")
    if min_success < success_floor:
        reasons.append(f"compressed_success_below_floor:{min_success}")
    verdict = "ADOPT" if not reasons else "REJECT"

    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "fixture_count": len(results),
        "tolerance": tolerance,
        "success_floor": success_floor,
        "worst_faithfulness_delta": worst_delta,
        "mean_faithfulness_delta_advisory": round(sum(deltas) / len(deltas), 6),  # advisory ONLY
        "negations_broken_total": total_broken,
        "min_compressed_success": min_success,
        "results": results,
        "reject_reasons": reasons,
        "overall_verdict": verdict,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Deterministic offline faithfulness evaluator (no-quality-compromise proof).")
    ap.add_argument("--corpus", required=True, help="JSON file: [{fixture, original, compressed}, ...]")
    ap.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE)
    ap.add_argument("--success-floor", type=float, default=DEFAULT_SUCCESS_FLOOR)
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
        report = evaluate_corpus(items, tolerance=args.tolerance, success_floor=args.success_floor)
    except FaithfulnessError as exc:
        report = {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "error_type": exc.error_type, "_error": exc.message, "overall_verdict": "FAIL",
        }
        json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0 if report["overall_verdict"] == "ADOPT" else 1


if __name__ == "__main__":
    raise SystemExit(main())
