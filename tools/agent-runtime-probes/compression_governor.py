#!/usr/bin/env python3
"""compression_governor — per-content-class compression-ratio cap gate for the reducer plane (P3/bead 1.2).

THE RISK (empirical): compression has a non-linear FIDELITY CLIFF. SYNTHESIS-v1 §H4 (grounded in arXiv
2503.19114) measures semantic preservation collapsing at ~40-60% compression while grammaticality (and
BLEU/ROUGE) persist — a silent failure. Token-class bias is severe: CARDINAL/numeric preservation is the
LOWEST of all types (EM 0.13-0.26), DATE 0.22-0.23, and negations are preferentially dropped, INVERTING
meaning. §H8: the cliff is method-conditional (extractive distilled compressors push it higher), so a
single global cap is wrong — calibrate per-compressor.

WHAT THIS GATE DOES: it bounds the COMPRESSION RATIO well below the cliff, per content class, before any
text-level anchor check. A compression whose observed ratio exceeds the class cap is rejected and the
caller falls back to verbatim. Caps (research_seed, from SYNTHESIS-v1 §3 / arXiv 2503.19114 Table 2/7):
  - anchor-bearing / prose content : <= 2.00x  (>= 50% retained)
  - numeric / date / identifier / negation-dense : <= 1.67x  (>= 60% retained — the high-risk classes)
A `local_measured` calibration entry for a specific compressor may override the seed cap (only measured
evidence raises a cap; a research_seed never does — FLOOR-PROVENANCE).

CONCEPTUAL FRAME (thinkers-lab, applied honestly as framing not as numeric evidence): Brewer's
harvest/yield — this gate deliberately SACRIFICES YIELD (reject the compression, fall back to verbatim)
to PRESERVE HARVEST (never ship a low-fidelity compressed prompt); fidelity is the sacred invariant,
compression is the relaxable one. Snowden's catastrophic fold — the cliff is a fold, so the cap sits a
safety margin below it rather than at it.

HONEST SCOPE: this is a RATIO gate only — it proves the compression stayed within a calibrated budget. It
does NOT prove the surviving content is faithful (that is anchor_preservation_gate / faithfulness_evaluator,
the next bead) nor that a negation survived. proof_class is `deterministic_verifier`. Token counts are the
chars/4 heuristic (labeled, never provider truth). Fail-closed; metadata-only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact  # noqa: E402
from instruction_budget_auditor import estimate_tokens  # noqa: E402  (single-source chars/4 heuristic)

SCHEMA = "agent-runtime-compression-governor"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

# research_seed caps (SYNTHESIS-v1 §3, arXiv 2503.19114). A cap is a MAX allowed original/compressed ratio.
CAP_DENSE = 1.67   # numeric / date / identifier / negation-dense -> >= 60% retained
CAP_ANCHOR = 2.00  # anchor-bearing / prose -> >= 50% retained

# content class -> tier. Aligned with faithfulness_canary_corpus content classes.
DENSE_CLASSES = frozenset({"numeric", "date", "identifier", "negation"})
ANCHOR_CLASSES = frozenset({"entity", "prose", "anchor"})

# auto-detection patterns (used only when content_class is not declared).
_NUMERIC = re.compile(r"\b\d[\d,.:_-]*\b")
_DATE = re.compile(
    r"\b(\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}(?:/\d{2,4})?|"
    r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2})\b",
    re.IGNORECASE,
)
# negation markers: a single one is catastrophic (H4 polarity inversion), so its mere presence -> dense.
_NEGATION = re.compile(
    r"\b(not|no|never|none|cannot|can't|don't|won't|isn't|aren't|unless|without|"
    r"must\s+not|no\s+longer|n't)\b",
    re.IGNORECASE,
)
# density fraction at/above which numeric+date content is treated as dense.
DENSITY_THRESHOLD = 0.12


class GovernorError(ValueError):
    """Typed, fail-closed error: never green a compression on missing/malformed input."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def detect_content_class(text: str) -> str:
    """Auto-classify text into a cap tier proxy when no class is declared. A negation marker forces the
    dense tier (polarity inversion is the highest-risk failure); otherwise dense if numeric+date density
    crosses the threshold. Returns one of: numeric/date/negation/prose (tier-equivalent labels)."""
    if _NEGATION.search(text):
        return "negation"
    tokens = text.split()
    if not tokens:
        return "prose"
    numeric_hits = len(_NUMERIC.findall(text))
    date_hits = len(_DATE.findall(text))
    if (numeric_hits + date_hits) / len(tokens) >= DENSITY_THRESHOLD:
        return "date" if date_hits >= numeric_hits else "numeric"
    return "prose"


def cap_for_class(content_class: str) -> tuple[float, str]:
    """(research_seed cap, tier) for a content class. Unknown class -> strictest (dense) tier, fail-safe."""
    if content_class in DENSE_CLASSES:
        return CAP_DENSE, "dense"
    if content_class in ANCHOR_CLASSES:
        return CAP_ANCHOR, "anchor"
    return CAP_DENSE, "dense"  # unknown -> conservative


def _resolve_cap(tier_cap: float, tier: str, compressor_id, calibration: dict | None) -> tuple[float, str]:
    """Apply a per-compressor calibration override. ONLY a `local_measured` entry may change the cap; a
    research_seed (or absent) entry leaves the seed default in force (FLOOR-PROVENANCE)."""
    if not calibration or compressor_id is None:
        return tier_cap, "research_seed"
    entry = calibration.get(compressor_id)
    if not isinstance(entry, dict) or entry.get("provenance") != "local_measured":
        return tier_cap, "research_seed"
    # a measured entry may carry a per-tier cap or a single max_ratio.
    measured = entry.get(tier, entry.get("max_ratio"))
    if not isinstance(measured, (int, float)) or measured <= 0:
        raise GovernorError("bad_calibration", f"local_measured cap for {compressor_id} must be a positive number")
    return float(measured), "local_measured"


def govern(original: str, compressed: str, content_class: str | None = None,
           compressor_id: str | None = None, calibration: dict | None = None) -> dict:
    """Bound one compression's ratio against its per-content-class cap. Metadata-only, fail-closed."""
    if not isinstance(original, str) or not isinstance(compressed, str):
        raise GovernorError("malformed_input", "original and compressed must be strings")
    if not original:
        raise GovernorError("empty_original", "original text is empty; nothing to govern")

    klass = content_class if content_class is not None else detect_content_class(original)
    tier_cap, tier = cap_for_class(klass)
    cap, cap_provenance = _resolve_cap(tier_cap, tier, compressor_id, calibration)

    orig_tok = estimate_tokens(len(original))
    comp_tok = estimate_tokens(len(compressed))
    # ratio = how many times shorter; an empty compressed text is infinite compression (max risk).
    expanded = comp_tok >= orig_tok
    if comp_tok <= 0:
        observed_ratio = float("inf")
    else:
        observed_ratio = orig_tok / comp_tok

    within_cap = observed_ratio <= cap
    reasons: list = []
    if not within_cap:
        reasons.append(f"ratio_over_cap:{round(observed_ratio, 3)}>{cap}")

    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "content_class": klass,
        "class_was_declared": content_class is not None,
        "cap_tier": tier,
        "cap": cap,
        "cap_provenance": cap_provenance,
        "compressor_id": compressor_id,
        "token_basis": "heuristic; chars/4 family, not provider truth",
        "observed_ratio": None if observed_ratio == float("inf") else round(observed_ratio, 4),
        "ratio_is_infinite": observed_ratio == float("inf"),
        "expanded": expanded,
        "within_cap": within_cap,
        "recommended_action": "proceed" if within_cap else "fallback_to_verbatim",
        "reasons": reasons,
        "overall_verdict": "PASS" if within_cap else "FAIL",
    })


def govern_corpus(items: list, calibration: dict | None = None) -> dict:
    """Govern a corpus of {original, compressed, content_class?, compressor_id?}. Worst-case, fail-closed:
    PASS only if EVERY item is within its cap (one over-compressed item sinks the batch)."""
    if not isinstance(items, list) or not items:
        return {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "proof_class": "deterministic_verifier", "item_count": 0,
            "overall_verdict": "FAIL", "error_type": "empty_corpus",
        }
    results: list = []
    for it in items:
        if not isinstance(it, dict) or "original" not in it or "compressed" not in it:
            raise GovernorError("malformed_item", "each item needs original + compressed")
        results.append(govern(it["original"], it["compressed"],
                              content_class=it.get("content_class"),
                              compressor_id=it.get("compressor_id"), calibration=calibration))
    over = [i for i, r in enumerate(results) if not r["within_cap"]]
    finite = [r["observed_ratio"] for r in results if r["observed_ratio"] is not None]
    any_infinite = any(r["ratio_is_infinite"] for r in results)
    worst_ratio = None if any_infinite else (max(finite) if finite else None)
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "item_count": len(results),
        "over_cap_count": len(over),
        "over_cap_indices": over,
        "worst_observed_ratio": worst_ratio,
        "worst_ratio_is_infinite": any_infinite,
        "results": results,
        "overall_verdict": "PASS" if not over else "FAIL",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Per-content-class compression-ratio cap gate (reducer plane).")
    ap.add_argument("--corpus", required=True, help="JSON: [{original, compressed, content_class?, compressor_id?}]")
    ap.add_argument("--calibration", help="JSON file: {compressor_id: {provenance, max_ratio|<tier>}}")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    path = Path(args.corpus)
    if not path.exists():
        return _emit({"schema": SCHEMA, "error_type": "missing_corpus",
                      "_error": "corpus not found", "overall_verdict": "FAIL"}, 1)
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return _emit({"schema": SCHEMA, "error_type": "malformed_corpus",
                      "_error": f"JSONDecodeError: {exc}", "overall_verdict": "FAIL"}, 1)
    calibration = None
    if args.calibration:
        cpath = Path(args.calibration)
        if not cpath.exists():
            return _emit({"schema": SCHEMA, "error_type": "missing_calibration",
                          "_error": "calibration not found", "overall_verdict": "FAIL"}, 1)
        try:
            calibration = json.loads(cpath.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            return _emit({"schema": SCHEMA, "error_type": "malformed_calibration",
                          "_error": f"JSONDecodeError: {exc}", "overall_verdict": "FAIL"}, 1)
    try:
        report = govern_corpus(items, calibration=calibration)
    except GovernorError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message,
                      "overall_verdict": "FAIL"}, 1)
    return _emit(report, 0 if report["overall_verdict"] == "PASS" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
