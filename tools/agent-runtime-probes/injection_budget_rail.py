#!/usr/bin/env python3
"""injection_budget_rail.py — Bead 2.6: bound additive enrichment injected per turn.

Caps the TOTAL injected tokens (default 500) and the NUMBER of ranked items (default 5)
admitted into a turn's additive enrichment context, dropping marginal items
deterministically (same input -> same admit/drop split). Items are PRE-RANKED by the
caller (most relevant first); this rail admits in rank order until the token cap OR item
cap is hit, then drops everything past the cap.

REUSE NOTE (deep-impact audit): `runtime_budget_rail.build_report` is a HOST-STATE
diagnostics report, NOT the injection-budget primitive — the token-cap logic here is
genuinely new. Only `runtime_budget_rail.parse_human_number` is imported, for numeric
parsing of human-written caps (e.g. "1K") on the CLI.

UNKNOWN TOKEN COUNTS are adoption-blocking: if any item's token count is unknown/absent,
the report sets budget_status="unknown_tokens_block_adoption". A measurement-only report
may still be emitted, but it cannot be treated as adoption-eligible. Provider-truth tokens
only; any chars/4 derivation must be labeled `heuristic` by the caller before this rail.

CLI: python3 injection_budget_rail.py --items-artifact <file> [--max-tokens N]
         [--max-items N] [--pretty]
Output: JSON (metadata-only) to stdout.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from probelib import redact, load_json, sha256_16
from runtime_budget_rail import parse_human_number

SCHEMA = "agent-runtime-injection-budget-rail"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

DEFAULT_MAX_TOKENS = 500
DEFAULT_MAX_ITEMS = 5

# budget_status values
WITHIN_BUDGET = "within_budget"
TOKEN_CAPPED = "token_capped"
ITEM_CAPPED = "item_capped"
EMPTY = "empty"
UNKNOWN_BLOCK = "unknown_tokens_block_adoption"


class InjectionBudgetError(ValueError):
    """Typed, fail-closed error for malformed injection-budget input."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message

    def as_marker(self) -> dict:
        return {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": REDACTION,
            "error_type": self.error_type,
            "_error": self.message,
            "budget_status": "error",
        }


def _validate_caps(max_tokens: int, max_items: int) -> None:
    """Fail-closed validation of the cap arguments themselves."""
    if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or max_tokens < 0:
        raise InjectionBudgetError(
            "invalid_cap", f"max_tokens must be a non-negative int, got {max_tokens!r}"
        )
    if not isinstance(max_items, int) or isinstance(max_items, bool) or max_items < 0:
        raise InjectionBudgetError(
            "invalid_cap", f"max_items must be a non-negative int, got {max_items!r}"
        )


def _normalize_token_count(value: object) -> int | None:
    """Return a non-negative int token count, None if the count is unknown/absent.

    A genuinely unknown count (None, "unknown") -> None (adoption-blocking, not a crash).
    A malformed count (negative, non-int, bool) -> typed error (fail closed).
    """
    if value is None or value == "unknown":
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise InjectionBudgetError(
            "invalid_token_count",
            f"token count must be a non-negative int or unknown, got {value!r}",
        )
    if value < 0:
        raise InjectionBudgetError(
            "invalid_token_count", f"token count must be non-negative, got {value!r}"
        )
    return value


def apply_injection_budget(
    items: list[dict],
    token_counts: list[int],
    *,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    max_items: int = DEFAULT_MAX_ITEMS,
) -> dict:
    """Cap additive enrichment by total tokens AND item count, deterministically.

    items: pre-ranked (most relevant first).
    token_counts: provider-truth token count per item (parallel to items); a value of
        None or "unknown" marks that item's contribution as unknown (adoption-blocking).
    Returns: {admitted_items, dropped_items, total_admitted_tokens, item_count,
              budget_status}. admitted/dropped item entries carry the ZERO-BASED rank
              index only — never raw item content (metadata-only contract).
    """
    if not isinstance(items, list) or not isinstance(token_counts, list):
        raise InjectionBudgetError(
            "invalid_type", "items and token_counts must both be lists"
        )
    if len(items) != len(token_counts):
        raise InjectionBudgetError(
            "length_mismatch",
            f"items ({len(items)}) and token_counts ({len(token_counts)}) length mismatch",
        )
    _validate_caps(max_tokens, max_items)

    # Empty input is a degraded state, not a crash.
    if not items:
        return {
            "admitted_items": [],
            "dropped_items": [],
            "total_admitted_tokens": 0,
            "item_count": 0,
            "budget_status": EMPTY,
        }

    # Normalize every count first; a malformed count fails closed (raises) before any
    # admit/drop decision. Unknown counts are tolerated here but block adoption below.
    normalized = [_normalize_token_count(tc) for tc in token_counts]
    has_unknown = any(tc is None for tc in normalized)

    admitted: list[dict] = []
    dropped: list[dict] = []
    total_admitted_tokens = 0
    cap_hit: str | None = None  # which cap stopped admission, if any

    for index, tokens in enumerate(normalized):
        # Deterministic: once a cap is hit, every later (lower-ranked) item is dropped.
        if cap_hit is not None:
            dropped.append({"rank_index": index, "reason": cap_hit})
            continue
        # Item cap: this item would be the (max_items+1)-th admitted.
        if len(admitted) >= max_items:
            cap_hit = ITEM_CAPPED
            dropped.append({"rank_index": index, "reason": cap_hit})
            continue
        # Unknown contribution: cannot account for it against the token cap — record it as
        # admitted-with-unknown so the measurement report is complete, but it forces the
        # adoption-blocking status below. token contribution treated as unknown (no add).
        if tokens is None:
            admitted.append({"rank_index": index, "token_contribution": "unknown"})
            continue
        # Token cap: admitting this item would exceed the total token budget.
        if total_admitted_tokens + tokens > max_tokens:
            cap_hit = TOKEN_CAPPED
            dropped.append({"rank_index": index, "reason": cap_hit})
            continue
        total_admitted_tokens += tokens
        admitted.append({"rank_index": index, "token_contribution": tokens})

    if has_unknown:
        budget_status = UNKNOWN_BLOCK
    elif cap_hit is not None:
        budget_status = cap_hit
    else:
        budget_status = WITHIN_BUDGET

    return {
        "admitted_items": admitted,
        "dropped_items": dropped,
        "total_admitted_tokens": total_admitted_tokens,
        "item_count": len(admitted),
        "budget_status": budget_status,
    }


def build_report(
    items: list[dict],
    token_counts: list[int],
    *,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    max_items: int = DEFAULT_MAX_ITEMS,
) -> dict:
    """Wrap apply_injection_budget into the metadata-only CLI report envelope.

    Never emits raw item content — only counts, caps, and the budget status.
    """
    result = apply_injection_budget(
        items, token_counts, max_tokens=max_tokens, max_items=max_items
    )
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": REDACTION,
        "max_tokens": max_tokens,
        "max_items": max_items,
        "admitted_count": result["item_count"],
        "dropped_count": len(result["dropped_items"]),
        "total_admitted_tokens": result["total_admitted_tokens"],
        "budget_status": result["budget_status"],
    }


def _coerce_cap(value: str, default: int) -> int:
    """Parse a CLI cap (e.g. "500" or "1K") into a non-negative int, fail closed."""
    parsed = parse_human_number(value)
    if isinstance(parsed, dict) or parsed is None:
        raise InjectionBudgetError("invalid_cap", f"cannot parse cap {value!r}")
    if isinstance(parsed, float):
        if not parsed.is_integer():
            raise InjectionBudgetError("invalid_cap", f"cap must be integral, got {value!r}")
        parsed = int(parsed)
    if parsed < 0:
        raise InjectionBudgetError("invalid_cap", f"cap must be non-negative, got {value!r}")
    return parsed


def _load_items_artifact(artifact_path: Path) -> tuple[list[dict], list[int]]:
    """Load items + token_counts from a caller-supplied JSON artifact.

    Expected shape: {"items": [...], "token_counts": [...]}. Returns the two parallel
    lists. Fails closed (typed error) on missing/malformed artifact or wrong shape.
    """
    if not artifact_path.exists():
        raise InjectionBudgetError(
            "missing_input", f"items artifact not found: sha256_16={sha256_16(str(artifact_path))}"
        )
    data = load_json(artifact_path)
    if not isinstance(data, dict):
        raise InjectionBudgetError(
            "malformed_input", "items artifact must be a JSON object"
        )
    if "_error" in data:
        raise InjectionBudgetError("malformed_input", str(data["_error"]))
    items = data.get("items")
    token_counts = data.get("token_counts")
    if not isinstance(items, list) or not isinstance(token_counts, list):
        raise InjectionBudgetError(
            "malformed_input",
            "items artifact must carry list fields 'items' and 'token_counts'",
        )
    return items, token_counts


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Bound additive enrichment injected per turn (token + item caps)."
    )
    ap.add_argument("--items-artifact", required=True, help="JSON with items + token_counts")
    ap.add_argument("--max-tokens", default=str(DEFAULT_MAX_TOKENS), help="Total token cap")
    ap.add_argument("--max-items", default=str(DEFAULT_MAX_ITEMS), help="Max admitted items")
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = ap.parse_args()

    try:
        max_tokens = _coerce_cap(args.max_tokens, DEFAULT_MAX_TOKENS)
        max_items = _coerce_cap(args.max_items, DEFAULT_MAX_ITEMS)
        items, token_counts = _load_items_artifact(Path(args.items_artifact))
        report = build_report(
            items, token_counts, max_tokens=max_tokens, max_items=max_items
        )
    except InjectionBudgetError as exc:
        report = exc.as_marker()
        report = redact(report)
        json.dump(report, sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 1

    report = redact(report)
    json.dump(report, sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
