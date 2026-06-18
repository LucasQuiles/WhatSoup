#!/usr/bin/env python3
"""anchor_preservation_gate — SEMANTIC pre/post survival gate for the reducer plane (P3/bead 1.3).

Closes red-team COMP-01: a purely LEXICAL anchor check (does the regex-matched string still appear?)
passes SEMANTIC corruption — a compressor that keeps every anchor token while dropping the negation,
conditional, or coreference that gives it meaning ("NOT valid" -> "valid", "only if X" stripped) gets a
clean verdict. This gate refuses that. It is the runtime per-mutation gate that sits AFTER
compression_governor (ratio) and BEFORE the B3 adoption trial: if any required meaning is lost, it
fails closed and the caller falls back to verbatim (B1 raw handle).

It shares its semantic core with `faithfulness_evaluator` (same `_normalize`, same "negation absence =
inversion" model — single source) and adds the COMP-01 mitigation: PAIRED-PATTERN anchors. Three anchor
kinds:
  - simple   {kind:"simple",  text}                  -> the span must survive (normalized substring).
  - negation {kind:"negation",text}                  -> a polarity span whose ABSENCE inverts meaning;
                                                        its loss fails the gate (never "still mostly there").
  - paired   {kind:"paired",  entity, qualifier, max_gap?} -> BOTH must survive AND remain within max_gap
                                                        characters of each other (proximity). This catches
                                                        the detach attack: entity and qualifier both still
                                                        present in the text but no longer governing each
                                                        other ("valid ... [later] ... not").

Precondition (fail-closed): every required anchor must be PRESENT (and, for paired, in-proximity) in the
ORIGINAL — you cannot certify survival of meaning that was never there; a spec that asks otherwise is a
typed malformed_spec error, not a silent pass.

HONEST SCOPE: deterministic semantic-survival of DECLARED anchors only; it cannot invent the anchors a
text needs (that is the canary corpus' job) nor detect drift in unanchored content. proof_class is
`deterministic_verifier`. Fail-closed; metadata-only (anchor ids/kinds/reasons, never raw text/anchors).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402
import faithfulness_evaluator as fe  # noqa: E402  (reuse _normalize — single semantic-normalization source)

SCHEMA = "agent-runtime-anchor-preservation-gate"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

DEFAULT_MAX_GAP = 48  # max chars between a paired entity and its qualifier to still count as governing


class AnchorGateError(ValueError):
    """Typed, fail-closed error: never green a compression on a missing/malformed anchor spec."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _all_starts(haystack: str, needle: str) -> list:
    """All start indices of needle in haystack (overlapping-safe by stepping 1)."""
    if not needle:
        return []
    out, i = [], haystack.find(needle)
    while i != -1:
        out.append(i)
        i = haystack.find(needle, i + 1)
    return out


def _min_span_gap(norm_text: str, a: str, b: str) -> int | None:
    """Min char gap between the nearest occurrences of substrings a and b (0 if they overlap/touch).
    None if either is absent."""
    starts_a = _all_starts(norm_text, a)
    starts_b = _all_starts(norm_text, b)
    if not starts_a or not starts_b:
        return None
    best = None
    for ia in starts_a:
        a0, a1 = ia, ia + len(a)
        for ib in starts_b:
            b0, b1 = ib, ib + len(b)
            gap = 0 if (a0 < b1 and b0 < a1) else max(b0 - a1, a0 - b1)
            best = gap if best is None else min(best, gap)
    return best


def _validate_anchor(anchor: dict) -> tuple[str, dict]:
    """Normalize/validate one anchor spec; return (anchor_id, parsed) or raise malformed_spec."""
    if not isinstance(anchor, dict):
        raise AnchorGateError("malformed_spec", "each anchor must be a dict")
    kind = anchor.get("kind")
    if kind in ("simple", "negation"):
        text = anchor.get("text")
        if not isinstance(text, str) or not text:
            raise AnchorGateError("malformed_spec", f"{kind} anchor needs non-empty text")
        return sha256_16(f"{kind}:{text}"), {"kind": kind, "text": fe._normalize(text)}
    if kind == "paired":
        ent, qual = anchor.get("entity"), anchor.get("qualifier")
        if not isinstance(ent, str) or not ent or not isinstance(qual, str) or not qual:
            raise AnchorGateError("malformed_spec", "paired anchor needs non-empty entity + qualifier")
        gap = anchor.get("max_gap", DEFAULT_MAX_GAP)
        if not isinstance(gap, int) or gap < 0:
            raise AnchorGateError("malformed_spec", "paired max_gap must be a non-negative int")
        return sha256_16(f"paired:{ent}|{qual}"), {
            "kind": "paired", "entity": fe._normalize(ent), "qualifier": fe._normalize(qual), "max_gap": gap,
        }
    raise AnchorGateError("malformed_spec", f"unknown anchor kind: {kind!r}")


def _present_in(norm_text: str, parsed: dict) -> tuple[bool, str | None]:
    """Does the anchor's meaning survive in norm_text? Returns (survived, miss_reason)."""
    if parsed["kind"] in ("simple", "negation"):
        if parsed["text"] in norm_text:
            return True, None
        return False, ("negation_inverted" if parsed["kind"] == "negation" else "anchor_dropped")
    # paired: both members present AND within max_gap (proximity / still governing)
    gap = _min_span_gap(norm_text, parsed["entity"], parsed["qualifier"])
    if gap is None:
        return False, "paired_member_dropped"
    if gap > parsed["max_gap"]:
        return False, "qualifier_detached"
    return True, None


def gate(original: str, compressed: str, anchors: list) -> dict:
    """Semantic survival gate for one (original, compressed) pair. Metadata-only, fail-closed.

    PASS only if EVERY declared anchor's meaning survives in `compressed`; otherwise the caller must fall
    back to verbatim. Each anchor must first be present (in proximity, for paired) in `original`."""
    if not isinstance(original, str) or not isinstance(compressed, str):
        raise AnchorGateError("malformed_input", "original and compressed must be strings")
    if not isinstance(anchors, list) or not anchors:
        raise AnchorGateError("malformed_spec", "anchors must be a non-empty list")

    norm_orig = fe._normalize(original)
    norm_comp = fe._normalize(compressed)

    results: list = []
    misses: list = []
    for raw in anchors:
        aid, parsed = _validate_anchor(raw)
        # precondition: the anchor must exist (in proximity) in the ORIGINAL.
        present_orig, _ = _present_in(norm_orig, parsed)
        if not present_orig:
            raise AnchorGateError("malformed_spec", f"required anchor not present in original: {parsed['kind']}")
        survived, reason = _present_in(norm_comp, parsed)
        rec = {"anchor_id": aid, "kind": parsed["kind"], "survived": survived}
        if not survived:
            rec["miss_reason"] = reason
            misses.append(rec)
        results.append(rec)

    preserved = not misses
    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "anchor_count": len(results),
        "preserved": preserved,
        "miss_count": len(misses),
        "miss_reasons": sorted({m["miss_reason"] for m in misses}),
        "results": results,
        "recommended_action": "use_compressed" if preserved else "fallback_to_verbatim",
        "overall_verdict": "PASS" if preserved else "FAIL",
    })


def gate_corpus(items: list) -> dict:
    """Run the gate over a corpus of {original, compressed, anchors}. Worst-case, fail-closed:
    PASS only if EVERY item preserves all its anchors."""
    if not isinstance(items, list) or not items:
        return {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "proof_class": "deterministic_verifier", "item_count": 0,
            "overall_verdict": "FAIL", "error_type": "empty_corpus",
        }
    results: list = []
    for it in items:
        if not isinstance(it, dict) or "original" not in it or "compressed" not in it or "anchors" not in it:
            raise AnchorGateError("malformed_item", "each item needs original + compressed + anchors")
        results.append(gate(it["original"], it["compressed"], it["anchors"]))
    failed = [i for i, r in enumerate(results) if not r["preserved"]]
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "item_count": len(results),
        "failed_count": len(failed),
        "failed_indices": failed,
        "results": results,
        "overall_verdict": "PASS" if not failed else "FAIL",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Semantic anchor-preservation gate (reducer plane, COMP-01).")
    ap.add_argument("--corpus", required=True, help="JSON: [{original, compressed, anchors:[...]}]")
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
    try:
        report = gate_corpus(items)
    except AnchorGateError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message,
                      "overall_verdict": "FAIL"}, 1)
    return _emit(report, 0 if report["overall_verdict"] == "PASS" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
