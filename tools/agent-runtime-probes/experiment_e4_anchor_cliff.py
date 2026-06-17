#!/usr/bin/env python3
"""experiment_e4_anchor_cliff — E4 (plan bead 3.3): anchor/cliff sweep through the harness.

Sweeps a text through increasing compression and runs each variant through BOTH reducer gates —
`compression_governor` (ratio cap) and `anchor_preservation_gate` (semantic survival) — to characterize
the fidelity cliff and prove the gates compose safely.

The load-bearing finding: the governor's ratio cap has a SEMANTIC BLIND SPOT — a compression whose ratio
is UNDER the cap can still have dropped an anchor (lost meaning). The governor alone would ADOPT such a
compression; the anchor gate catches it, so the COMPOSED gate (governor AND anchor) never adopts a
compression that lost meaning. E4 quantifies the governor's blind spots and asserts zero unsafe adoptions
by the composition (the pre-registered criterion `adoptions_with_anchor_loss == 0`), and emits a
source-hashed safe-ratio calibration candidate (FLOOR-PROVENANCE: a `local_measured` datum, eligible to
inform a cap — never a research seed).

Run through `experiment_harness` so the safety claim is earned, not rationalized. proof_class
`direct_task_outcome`; fail-closed; metadata-only (ratios / verdicts / counts / hashes, never raw text).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402
import compression_governor as gov  # noqa: E402
import anchor_preservation_gate as ag  # noqa: E402
import experiment_harness as eh  # noqa: E402

SCHEMA = "agent-runtime-experiment-e4"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

EXPERIMENT_ID = "E4"

# A text whose MEANING is tail-heavy: an early anchor (survives truncation) and a tail anchor (a safety
# negation) that aggressive truncation drops — so some compressions sit UNDER the ratio cap yet have lost
# the safety clause (the governor's blind spot the anchor gate must close).
_TEXT = ("the production system config sets the retry limit to three for the audit job "
         "and that safety rule must never be silently disabled")
_ANCHORS = [
    {"kind": "simple", "text": "system config"},                 # early — survives most truncation
    {"kind": "negation", "text": "must never be silently disabled"},  # tail — dropped under heavy truncation
]
_CONTENT_CLASS = "prose"  # governor cap 2.0x
_KEEP_FRACTIONS = (1.0, 0.85, 0.7, 0.55, 0.4, 0.25)


def _truncate(text: str, keep_fraction: float) -> str:
    words = text.split()
    keep = max(1, round(len(words) * keep_fraction))
    return " ".join(words[:keep])


def run_sweep(text: str = _TEXT, anchors=None, content_class: str = _CONTENT_CLASS,
              keep_fractions=_KEEP_FRACTIONS) -> dict:
    """Sweep compression levels; record per-variant governor + anchor verdicts and the composed decision."""
    anchors = list(_ANCHORS if anchors is None else anchors)
    points: list = []
    for frac in keep_fractions:
        compressed = _truncate(text, frac)
        g = gov.govern(text, compressed, content_class=content_class)
        a = ag.gate(text, compressed, anchors)
        gov_pass = g["overall_verdict"] == "PASS"
        anchor_pass = a["overall_verdict"] == "PASS"
        points.append({
            "keep_fraction": frac,
            "governor_ratio": g.get("observed_ratio"),
            "governor_pass": gov_pass,
            "anchor_pass": anchor_pass,
            "composed_adopt": gov_pass and anchor_pass,
        })

    # the governor's ratio cap would adopt these (under cap) despite a lost anchor — the blind spots:
    governor_only_unsafe = sum(1 for p in points if p["governor_pass"] and not p["anchor_pass"])
    # the composed gate must adopt NONE that lost an anchor:
    adoptions_with_anchor_loss = sum(1 for p in points if p["composed_adopt"] and not p["anchor_pass"])
    safe = [p["governor_ratio"] for p in points if p["composed_adopt"] and p["governor_ratio"] is not None]
    unsafe = [p["governor_ratio"] for p in points if not p["anchor_pass"] and p["governor_ratio"] is not None]
    safe_ratio_ceiling = max(safe) if safe else None
    cliff_ratio = min(unsafe) if unsafe else None

    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "direct_task_outcome",
        "content_class": content_class,
        "sweep_points": points,
        "governor_only_unsafe_adoptions": governor_only_unsafe,
        "adoptions_with_anchor_loss": adoptions_with_anchor_loss,
        "safe_ratio_ceiling": safe_ratio_ceiling,
        "cliff_ratio": cliff_ratio,
        "calibration_candidate": {
            "content_class": content_class,
            "safe_ratio_ceiling": safe_ratio_ceiling,
            "cliff_ratio": cliff_ratio,
            "source_hash_16": sha256_16(text),
            "provenance": "local_measured",
        },
    }


def experiment(store_dir: str) -> dict:
    """Register the immutable safety criterion, run the sweep, evaluate through the harness."""
    prediction = {
        "experiment_id": EXPERIMENT_ID,
        "hypothesis": "the composed reducer gate (governor AND anchor) never adopts a compression that "
                      "dropped an anchor, even where the ratio cap alone would have allowed it",
        "success_criterion": {"metric": "adoptions_with_anchor_loss", "comparator": "eq", "threshold": 0},
    }
    eh.register_prediction(prediction, store_dir)
    metrics = run_sweep()
    harness_report = eh.write_result(EXPERIMENT_ID, metrics, store_dir)
    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "experiment_id": EXPERIMENT_ID,
        "harness": harness_report,
        "metrics": metrics,
    })


def main() -> int:
    ap = argparse.ArgumentParser(description="E4 anchor-cliff sweep (run through the harness).")
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
    except (eh.PredictionError, gov.GovernorError, ag.AnchorGateError) as exc:
        return _emit({"schema": SCHEMA, "error_type": type(exc).__name__, "_error": str(exc),
                      "overall_verdict": "FAIL"}, 1)
    ok = report["harness"]["overall_verdict"] == "PASS"
    return _emit(report, 0 if ok else 1)


if __name__ == "__main__":
    raise SystemExit(main())
