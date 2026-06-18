#!/usr/bin/env python3
"""enrichment_control_fixtures.py — Bead 2.4: deterministic CONTROL ARMS generator.

The enricher lift-gate (Bead 2.5) must prove that a measured quality lift is
CONTENT-DRIVEN, not gamed. To do that it needs control arms that hold everything
constant except the variable under test. This module deterministically generates
those arms from a synthetic (or caller-supplied) query/task fixture set.

Arms (CONTROL-ARMS assumption + H10 near-miss + Power-of-Noise arXiv 2401.14887):
  - gold            : context that actually answers the query (the positive arm).
  - random          : irrelevant noise-floor context. The Power of Noise result
                      (arXiv 2401.14887) shows random/irrelevant context can HELP a
                      RAG pipeline, so "lift over no-context" is NOT proof of relevance
                      — the gate must beat the random arm, not just the empty arm.
  - near_miss       : RELATED-but-WRONG context. This is the HARD control: near-miss
                      retrieval HURTS (~ -25% in the literature) because it is on-topic
                      yet factually wrong. Each near-miss item carries
                      {similarity_tag, wrongness_reason, verifier}; a near-miss whose
                      wrongness cannot be VERIFIED is counted as `invalid_nearmiss`
                      (never silently treated as a valid hard control).
  - padding         : gold-token-count contentless filler. Same token budget as gold,
                      zero information — isolates the "more tokens = better" confound.
  - position_ablation: the SAME gold content placed in a DIFFERENT position with the
                      query held fixed. Cheap positional-vs-content attribution (H10):
                      if score moves when only position moves, the effect is positional,
                      not content.

DETERMINISM: all sampling uses `random.Random(seed)` (a local, seeded RNG). The module
NEVER calls the global `random` module, `time`, `os.urandom`, uuid, or any other entropy
source. Same `--seed` -> byte-identical arms and report.

UNHAPPY (fail-closed, typed — no bare return/pass/continue):
  - malformed query fixtures      -> typed parse_status="invalid" / error_type marker.
  - empty query fixture set        -> degraded marker (status="degraded").
  - unverifiable near-miss wrongness -> counted into `invalid_nearmiss_count`.

The REPORT is metadata-only: per-arm {arm, item_count, token_estimate, provenance,
similarity_tag?, wrongness_reason?, verifier?} plus top-level schema/seed/arms_summary/
invalid_nearmiss_count. Fixture CONTENT (the actual context strings) is written ONLY to
an optional `--out-dir`; it never enters the report.

CLI: python3 enrichment_control_fixtures.py --seed <int> [--query-fixtures <file>]
                                            [--out-dir <dir>] [--pretty]
Output: metadata-only JSON report to stdout.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path
from typing import Any

from probelib import redact, sha256_16

SCHEMA = "agent-runtime-enrichment-control-fixtures"
SCHEMA_VERSION = "0.1"
DEFAULT_SEED = 1729  # constant default seed; determinism is load-bearing

ARMS = ("gold", "random", "near_miss", "padding", "position_ablation")

# Token estimate is a HEURISTIC (chars/4), explicitly NOT provider truth. Used only to
# size the padding arm to the gold arm; it never feeds an adoption verdict.
_CHARS_PER_TOKEN = 4

# Built-in synthetic query/task fixtures. Each entry is self-contained: the query, the
# gold answer-bearing context, a pool of irrelevant facts (for the random arm), and a
# set of near-miss candidates each with an explicit wrongness_reason + verifier rule.
_SYNTHETIC_FIXTURES: list[dict[str, Any]] = [
    {
        "query_id": "q_capital_fr",
        "query": "What is the capital of France?",
        "gold": "The capital of France is Paris, its seat of government.",
        "irrelevant": [
            "Basalt is an igneous rock formed from cooled lava.",
            "The mitochondrion is the powerhouse of the cell.",
        ],
        "near_miss": [
            {
                "text": "The capital of France is Lyon, its largest industrial hub.",
                "similarity_tag": "same_topic_wrong_entity",
                "wrongness_reason": "names Lyon as capital; the capital is Paris",
                # verifier: the asserted capital token must equal the gold capital token.
                "asserted_value": "Lyon",
                "correct_value": "Paris",
            },
            {
                # unverifiable: no asserted_value/correct_value pair -> invalid_nearmiss
                "text": "France has a rich and storied administrative history.",
                "similarity_tag": "same_topic_no_claim",
                "wrongness_reason": "vague; no checkable wrong fact",
            },
        ],
    },
    {
        "query_id": "q_boiling_h2o",
        "query": "At what temperature does water boil at sea level in Celsius?",
        "gold": "At sea level water boils at 100 degrees Celsius.",
        "irrelevant": [
            "The Treaty of Westphalia was signed in 1648.",
            "Photosynthesis converts light energy into chemical energy.",
        ],
        "near_miss": [
            {
                "text": "At sea level water boils at 90 degrees Celsius.",
                "similarity_tag": "same_topic_wrong_value",
                "wrongness_reason": "states 90C; correct sea-level boiling point is 100C",
                "asserted_value": "90",
                "correct_value": "100",
            },
        ],
    },
    {
        "query_id": "q_speed_light",
        "query": "What is the approximate speed of light in a vacuum (km/s)?",
        "gold": "Light travels at approximately 299792 kilometers per second in a vacuum.",
        "irrelevant": [
            "Maple syrup is graded by color and flavor intensity.",
            "The violin has four strings tuned in perfect fifths.",
        ],
        "near_miss": [
            {
                "text": "Light travels at approximately 199792 kilometers per second in a vacuum.",
                "similarity_tag": "same_topic_wrong_value",
                "wrongness_reason": "states 199792; correct value is ~299792 km/s",
                "asserted_value": "199792",
                "correct_value": "299792",
            },
        ],
    },
]


class MalformedQueryFixtureError(ValueError):
    """Raised when a caller-supplied query-fixture file is structurally invalid."""


def token_estimate(text: str) -> int:
    """HEURISTIC chars/4 token estimate (never provider truth)."""
    return (len(text) + _CHARS_PER_TOKEN - 1) // _CHARS_PER_TOKEN


def load_query_fixtures(path: Path) -> list[dict[str, Any]]:
    """Load + validate a caller-supplied query-fixture JSON file.

    Expects a JSON list of objects, each with at least `query_id`, `query`, `gold`.
    Malformed structure raises MalformedQueryFixtureError (typed, fail-closed) — never
    a silent empty list that would fabricate an empty-but-valid fixture set.
    """
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise MalformedQueryFixtureError(f"read_error:{type(exc).__name__}") from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise MalformedQueryFixtureError(f"json_invalid:{exc.lineno}:{exc.colno}") from exc
    if not isinstance(data, list):
        raise MalformedQueryFixtureError("top_level_not_list")
    for index, entry in enumerate(data):
        if not isinstance(entry, dict):
            raise MalformedQueryFixtureError(f"entry_not_object:{index}")
        for required in ("query_id", "query", "gold"):
            value = entry.get(required)
            if not isinstance(value, str) or not value:
                raise MalformedQueryFixtureError(f"missing_field:{required}:{index}")
    return data


def _verify_near_miss(candidate: dict[str, Any]) -> tuple[bool, str]:
    """Return (verified, verifier_label).

    A near-miss is a VALID hard control only if its wrongness is checkable: it must
    assert a concrete value that DIFFERS from the known-correct value. Anything else
    (no asserted_value, no correct_value, or asserted == correct) is unverifiable and
    must be counted as invalid_nearmiss — never silently promoted to a valid control.
    """
    asserted = candidate.get("asserted_value")
    correct = candidate.get("correct_value")
    if not isinstance(asserted, str) or not isinstance(correct, str):
        return False, "no_checkable_claim"
    if asserted == correct:
        return False, "asserted_equals_correct"
    return True, "value_mismatch_verifier"


def _build_arm_items(
    fixtures: list[dict[str, Any]],
    rng: random.Random,
) -> tuple[dict[str, list[dict[str, Any]]], int]:
    """Build per-arm item lists deterministically. Returns (arm_items, invalid_count)."""
    arm_items: dict[str, list[dict[str, Any]]] = {arm: [] for arm in ARMS}
    invalid_nearmiss_count = 0

    # A single shared, seeded pool of irrelevant facts; the random arm samples it
    # deterministically (sorted for stable iteration, then rng.choice).
    irrelevant_pool: list[str] = []
    for fixture in fixtures:
        for fact in fixture.get("irrelevant", []) or []:
            if isinstance(fact, str) and fact:
                irrelevant_pool.append(fact)
    irrelevant_pool.sort()

    for fixture in fixtures:
        query_id = fixture["query_id"]
        gold_text = fixture["gold"]
        gold_tokens = token_estimate(gold_text)

        # --- gold arm ---
        arm_items["gold"].append({
            "query_id": query_id,
            "content": gold_text,
            "token_estimate": gold_tokens,
            "provenance": "synthetic_gold",
        })

        # --- random arm (Power of Noise control) ---
        if irrelevant_pool:
            noise = rng.choice(irrelevant_pool)
        else:
            noise = "Unrelated filler sentence with no bearing on the query."
        arm_items["random"].append({
            "query_id": query_id,
            "content": noise,
            "token_estimate": token_estimate(noise),
            "provenance": "synthetic_random_noise",
            "similarity_tag": "unrelated",
        })

        # --- near_miss arm (the HARD control) ---
        for candidate in fixture.get("near_miss", []) or []:
            text = candidate.get("text")
            if not isinstance(text, str) or not text:
                # malformed near-miss candidate: unverifiable by construction.
                invalid_nearmiss_count += 1
                continue
            verified, verifier_label = _verify_near_miss(candidate)
            if not verified:
                invalid_nearmiss_count += 1
                continue
            arm_items["near_miss"].append({
                "query_id": query_id,
                "content": text,
                "token_estimate": token_estimate(text),
                "provenance": "synthetic_near_miss",
                "similarity_tag": candidate.get("similarity_tag", "related_wrong"),
                "wrongness_reason": candidate.get("wrongness_reason", ""),
                "verifier": verifier_label,
            })

        # --- padding arm (gold-token-count contentless filler) ---
        # Deterministic filler char chosen from a fixed alphabet by seeded RNG, repeated
        # to match the gold TOKEN budget (chars/4 heuristic -> ~4 chars per token), so the
        # padding arm and gold arm have an equal token_estimate. Zero query-relevant info.
        filler_char = "abcdefghijklmnopqrstuvwxyz"[rng.randrange(26)]
        padding_text = filler_char * (gold_tokens * _CHARS_PER_TOKEN)
        arm_items["padding"].append({
            "query_id": query_id,
            "content": padding_text,
            "token_estimate": token_estimate(padding_text),
            "provenance": "synthetic_padding",
        })

        # --- position_ablation arm (SAME gold content, DIFFERENT position) ---
        # Content is byte-identical to the gold arm; only the `position` slot differs.
        # query is held fixed (recorded for the gate to assert query invariance).
        arm_items["position_ablation"].append({
            "query_id": query_id,
            "content": gold_text,
            "token_estimate": gold_tokens,
            "provenance": "synthetic_position_ablation",
            "position": "suffix",  # gold default placement is prefix; ablation uses suffix
            "query": fixture["query"],
        })

    return arm_items, invalid_nearmiss_count


def _arm_summary(arm: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    """Metadata-only per-arm summary (NEVER the content strings)."""
    total_tokens = sum(int(item["token_estimate"]) for item in items)
    summary: dict[str, Any] = {
        "arm": arm,
        "item_count": len(items),
        "token_estimate": total_tokens,
        "token_estimate_class": "heuristic_chars_div_4",
    }
    if items:
        # Surface representative metadata fields when present (first item is stable
        # because item order is deterministic). These are class labels, not content.
        sample = items[0]
        if "provenance" in sample:
            summary["provenance"] = sample["provenance"]
        if "similarity_tag" in sample:
            summary["similarity_tag"] = sample["similarity_tag"]
        if "wrongness_reason" in sample:
            summary["wrongness_reason"] = sample["wrongness_reason"]
        if "verifier" in sample:
            summary["verifier"] = sample["verifier"]
    return summary


def _write_fixture_content(out_dir: Path, arm_items: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Write fixture CONTENT to --out-dir (content lives here, NOT in the report).

    Returns a metadata-only descriptor {out_dir, files_written, content_sha256_16}.
    Fail-closed: an OSError is raised to the caller (typed), never swallowed.
    """
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        files_written = 0
        digest_input_parts: list[str] = []
        for arm in ARMS:
            arm_path = out_dir / f"{arm}.jsonl"
            lines = [json.dumps(item, sort_keys=True, ensure_ascii=False) for item in arm_items[arm]]
            body = "\n".join(lines) + ("\n" if lines else "")
            arm_path.write_text(body, encoding="utf-8")
            files_written += 1
            digest_input_parts.append(f"{arm}:{body}")
    except OSError as exc:
        raise MalformedQueryFixtureError(f"out_dir_write_error:{type(exc).__name__}") from exc
    return {
        "out_dir": str(out_dir),
        "files_written": files_written,
        "content_sha256_16": sha256_16("\x00".join(digest_input_parts)),
    }


def build_report(
    seed: int,
    query_fixtures_path: Path | None = None,
    out_dir: Path | None = None,
) -> dict[str, Any]:
    """Core logic: generate control arms and return the metadata-only report dict."""
    # --- Load fixtures (typed fail-closed on malformed input) ---
    if query_fixtures_path is not None:
        try:
            fixtures = load_query_fixtures(query_fixtures_path)
        except MalformedQueryFixtureError as exc:
            return {
                "schema": SCHEMA,
                "schema_version": SCHEMA_VERSION,
                "redaction": "metadata-only",
                "seed": seed,
                "parse_status": "invalid",
                "error_type": "malformed_query_fixtures",
                "_error": str(exc),
            }
        fixtures_source = "caller_supplied"
    else:
        fixtures = list(_SYNTHETIC_FIXTURES)
        fixtures_source = "builtin_synthetic"

    # --- Empty fixture set -> degraded marker (not a fabricated empty success) ---
    if not fixtures:
        return {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only",
            "seed": seed,
            "status": "degraded",
            "error_type": "empty_query_fixtures",
            "fixtures_source": fixtures_source,
            "arms_summary": [],
            "invalid_nearmiss_count": 0,
        }

    rng = random.Random(seed)  # ONLY entropy source; deterministic per seed
    arm_items, invalid_nearmiss_count = _build_arm_items(fixtures, rng)

    arms_summary = [_arm_summary(arm, arm_items[arm]) for arm in ARMS]

    report: dict[str, Any] = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only",
        "seed": seed,
        "fixtures_source": fixtures_source,
        "query_fixture_count": len(fixtures),
        "arms": list(ARMS),
        "arms_summary": arms_summary,
        "invalid_nearmiss_count": invalid_nearmiss_count,
    }

    # --- Optional: write fixture CONTENT to out-dir (content NOT in report) ---
    if out_dir is not None:
        content_descriptor = _write_fixture_content(out_dir, arm_items)
        report["content_out"] = content_descriptor

    return report


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Deterministically generate enricher control arms (Bead 2.4)."
    )
    ap.add_argument("--query-fixtures", help="Path to a JSON query-fixture file (optional)")
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED, help="Seed for random.Random")
    ap.add_argument("--out-dir", help="Optional dir to write fixture CONTENT (not in report)")
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = ap.parse_args()

    query_fixtures_path = Path(args.query_fixtures) if args.query_fixtures else None
    out_dir = Path(args.out_dir) if args.out_dir else None

    try:
        report = build_report(args.seed, query_fixtures_path, out_dir)
    except MalformedQueryFixtureError as exc:
        report = {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only",
            "seed": args.seed,
            "parse_status": "invalid",
            "error_type": "out_dir_write_error",
            "_error": str(exc),
        }

    report = redact(report)
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=False)
    sys.stdout.write("\n")

    if "_error" in report or report.get("parse_status") == "invalid":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
