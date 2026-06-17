#!/usr/bin/env python3
"""faithfulness_canary_corpus — the content-class fidelity-cliff proof for the reducer plane.

The "no quality compromise" thesis is only credible if we can show WHERE compression silently
breaks answerability and that our deterministic scorers catch it there. The fidelity cliff does
not break uniformly: it breaks at the content classes whose meaning lives in a SINGLE fragile
span — a number, a date, an exact identifier, a negation's polarity, or a named entity. Paraphrase
compression that "reads fine" routinely destroys exactly these.

This module ships a curated canary corpus, one fixture per content class, each carrying:
  - a FAITHFUL compression (drops filler, keeps the class-critical span), and
  - a CLIFF compression (breaks that span — drops the number/date/id, inverts the negation, or
    swaps the entity), usually while keeping high lexical/BLEU overlap (the gaming shape).

It then runs BOTH deterministic scorers over the corpus and proves two things together:
  1. NO FALSE ALARM: every faithful compression is ADOPT (faithfulness_evaluator) and clean
     (bleu_faithfulness_gap) — the scorers do not punish legitimate compression.
  2. EVERY CLIFF CAUGHT: every cliff compression is caught by the UNION of the two scorers
     (faithfulness REJECT — anchor dropped or negation broken — OR proxy-gaming flag).

Why a union, honestly: some cliffs (numeric/date/id/entity drops) are caught by anchor survival;
the negation inversion is the canonical high-lexical/low-faithfulness gaming shape the gap detector
exists for. Neither scorer alone covers every class; the corpus proves the pair does, for the
catchable classes. It does NOT claim to catch semantic drift that preserves every anchor — that is
out of scope for deterministic verifiers (see faithfulness_evaluator HONEST SCOPE). proof_class is
`deterministic_verifier`.

Fail-closed: an empty corpus FAILs; any uncaught cliff or any faithful false-alarm FAILs. Reports
are metadata-only (class ids, which detector caught each cliff, scores/flags — never raw text).
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402
import faithfulness_evaluator as fe  # noqa: E402
import bleu_faithfulness_gap as bg  # noqa: E402

SCHEMA = "agent-runtime-faithfulness-canary-corpus"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"


class CanaryError(ValueError):
    """Typed, fail-closed error: never green the corpus on missing/malformed evidence."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


@dataclass(frozen=True)
class CanaryClass:
    """One content class of the fidelity cliff.

    `fixture` is the faithfulness_evaluator fixture shape: {id, question, answer_anchors, negations}.
    `faithful` keeps the class-critical span (must pass both scorers); `cliff` breaks it (must be
    caught by the union). All text is synthetic.
    """

    class_id: str
    description: str
    fixture: dict
    original: str
    faithful: str
    cliff: str


def canary_classes() -> tuple[CanaryClass, ...]:
    """The curated content-class inventory. Synthetic text only.

    Each cliff breaks the one span its class hinges on:
      numeric    -> the count is paraphrased away ("4 keys" -> "several keys")
      date       -> the date is softened to a vague term ("june 30 2026" -> "soon")
      identifier -> an exact token is generalized ("resend_api_key" -> "the api key")
      negation   -> polarity is inverted by dropping "not" (the high-lexical gaming shape)
      entity     -> the subject is swapped ("admins" -> "users") keeping the sentence frame
    """
    return (
        CanaryClass(
            class_id="numeric",
            description="a load-bearing count survives or is paraphrased into vagueness",
            fixture={
                "id": "numeric-keycount",
                "question": "How many keys were loaded?",
                "answer_anchors": ["loaded 4 keys"],
                "negations": [],
            },
            original="the startup routine loaded 4 keys from the env file before serving",
            faithful="startup loaded 4 keys from the env file",
            cliff="startup loaded several keys from the env file",
        ),
        CanaryClass(
            class_id="date",
            description="a temporal anchor survives or is softened to a vague term",
            fixture={
                "id": "date-deadline",
                "question": "What is the deadline?",
                "answer_anchors": ["deadline is june 30 2026"],
                "negations": [],
            },
            original="per the policy the submission deadline is june 30 2026 with no extensions",
            faithful="the submission deadline is june 30 2026",
            cliff="the submission deadline is soon",
        ),
        CanaryClass(
            class_id="identifier",
            description="an exact identifier token survives or is generalized away",
            fixture={
                "id": "identifier-envvar",
                "question": "Which variable must be set?",
                "answer_anchors": ["resend_api_key"],
                "negations": [],
            },
            original="you must set the variable resend_api_key in the environment before deploy",
            faithful="you must set resend_api_key before deploy",
            cliff="you must set the api key before deploy",
        ),
        CanaryClass(
            class_id="negation",
            description="negation polarity survives or is inverted by dropping not (gaming shape)",
            fixture={
                "id": "negation-eligibility",
                "question": "Are contractors eligible?",
                "answer_anchors": ["external contractors"],
                "negations": ["are not eligible"],
            },
            original="note that external contractors are not eligible for the referral bonus",
            faithful="external contractors are not eligible for the referral bonus",
            cliff="external contractors are eligible for the referral bonus",
        ),
        CanaryClass(
            class_id="entity",
            description="the answer-bearing entity survives or is swapped under a stable frame",
            fixture={
                "id": "entity-eligibility",
                "question": "Who is eligible?",
                "answer_anchors": ["admins are eligible"],
                "negations": [],
            },
            original="under the new rule only admins are eligible to approve refunds",
            faithful="only admins are eligible to approve refunds",
            cliff="only users are eligible to approve refunds",
        ),
    )


def _item(cc: CanaryClass, compressed: str) -> dict:
    return {"fixture": cc.fixture, "original": cc.original, "compressed": compressed}


def _classify_catch(cc: CanaryClass, threshold: float) -> dict:
    """For a single class, score its CLIFF compression with both detectors and attribute the catch.

    A cliff is faithfulness-caught when compression lowers task success (anchor dropped) or breaks a
    negation; gap-caught when the proxy-gaming flag fires. caught = either.
    """
    pair = fe.evaluate_pair(cc.original, cc.cliff, cc.fixture)
    gap = bg.gap_report(cc.original, cc.cliff, cc.fixture, threshold=threshold)
    faith_caught = pair["faithfulness_delta"] < 0 or pair["negations_broken_by_compression"] > 0
    gap_caught = bool(gap["proxy_gaming_flag"])
    detectors = []
    if faith_caught:
        detectors.append("faithfulness")
    if gap_caught:
        detectors.append("gap")
    return {
        "class_id": cc.class_id,
        "fixture_id": cc.fixture["id"],
        "question_sha256_16": sha256_16(cc.fixture.get("question", "")),
        "cliff_faithfulness_delta": pair["faithfulness_delta"],
        "cliff_negations_broken": pair["negations_broken_by_compression"],
        "cliff_proxy_gaming_flag": gap_caught,
        "caught_by": detectors,
        "cliff_caught": faith_caught or gap_caught,
    }


def evaluate(
    classes: tuple[CanaryClass, ...] | None = None,
    threshold: float = bg.DEFAULT_GAP_THRESHOLD,
    tolerance: float = fe.DEFAULT_TOLERANCE,
    success_floor: float = fe.DEFAULT_SUCCESS_FLOOR,
) -> dict:
    """Run both scorers over the canary corpus and prove no-false-alarm AND every-cliff-caught.

    Returns a metadata-only report. overall_verdict is PASS only if the faithful arm is fully clean
    (faithfulness ADOPT and gap PASS) AND every class's cliff is caught by the union of detectors.
    """
    classes = canary_classes() if classes is None else classes
    if not classes:
        return {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "proof_class": "deterministic_verifier", "class_count": 0,
            "overall_verdict": "FAIL", "error_type": "empty_corpus",
        }

    # Arm 1 — no false alarm: the faithful compressions must clear both scorers cleanly.
    faithful_items = [_item(cc, cc.faithful) for cc in classes]
    faith_report = fe.evaluate_corpus(faithful_items, tolerance=tolerance, success_floor=success_floor)
    gap_report = bg.evaluate_corpus(faithful_items, threshold=threshold)
    no_false_alarm = faith_report["overall_verdict"] == "ADOPT" and gap_report["overall_verdict"] == "PASS"

    # Arm 2 — every cliff caught by the union of detectors, attributed per class.
    catches = [_classify_catch(cc, threshold) for cc in classes]
    uncaught = [c["class_id"] for c in catches if not c["cliff_caught"]]
    all_cliffs_caught = not uncaught

    reasons: list = []
    if not no_false_alarm:
        reasons.append("faithful_arm_false_alarm")
    if uncaught:
        reasons.append("uncaught_cliffs:" + ",".join(uncaught))

    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "gap_threshold": threshold,
        "tolerance": tolerance,
        "success_floor": success_floor,
        "class_count": len(classes),
        "class_ids": [cc.class_id for cc in classes],
        "faithful_arm": {
            "faithfulness_verdict": faith_report["overall_verdict"],
            "gap_verdict": gap_report["overall_verdict"],
            "no_false_alarm": no_false_alarm,
        },
        "cliff_arm": {
            "all_cliffs_caught": all_cliffs_caught,
            "uncaught_class_ids": uncaught,
            "catches": catches,
        },
        "reject_reasons": reasons,
        "overall_verdict": "PASS" if not reasons else "FAIL",
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Content-class fidelity-cliff canary corpus (no-quality-compromise proof)."
    )
    ap.add_argument("--threshold", type=float, default=bg.DEFAULT_GAP_THRESHOLD)
    ap.add_argument("--tolerance", type=float, default=fe.DEFAULT_TOLERANCE)
    ap.add_argument("--success-floor", type=float, default=fe.DEFAULT_SUCCESS_FLOOR)
    ap.add_argument("--list", action="store_true", help="list the canary content classes and exit")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    if args.list:
        listing = {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "classes": [{"class_id": cc.class_id, "description": cc.description} for cc in canary_classes()],
        }
        json.dump(redact(listing), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 0

    report = evaluate(threshold=args.threshold, tolerance=args.tolerance, success_floor=args.success_floor)
    json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0 if report["overall_verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
