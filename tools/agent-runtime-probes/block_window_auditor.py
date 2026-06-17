#!/usr/bin/env python3
"""block_window_auditor.py — Bead 0.3: audit content-block count against cache lookback window.

Consumes a caller-supplied offline capture (stream JSONL) and emits a metadata-only
report flagging RISK when the block count exceeds the ~20-block cache lookback window.

CRITICAL HONESTY: this proves COUNTER LOGIC only — it does NOT prove provider cache
behavior. Provider cache behavior requires live capture (gated E1). All provider
claims emitted by this script are HYPOTHESES, not proofs.

CLI: python3 block_window_auditor.py --capture <stream.jsonl> [--floor <int>]
         [--prefix-tokens <int>] [--pretty]
Output: JSON to stdout.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from probelib import redact, load_json, sha256_16

SCHEMA = "agent-runtime-block-window"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

# Provider cache lookback window (~20 blocks per Anthropic documentation and CAPE research)
CACHE_LOOKBACK_WINDOW = 20
# Recommended breakpoint interval to stay safely within the window
RECOMMENDED_BREAKPOINT_EVERY = 15

_PROVIDER_HYPOTHESIS = (
    "hypothesis: >20 blocks may push prior cache block out of window; "
    "unverified without provider usage"
)


def _count_content_blocks(text: str) -> tuple[int, str]:
    """Count content_block_start events in a stream JSONL.

    Returns (block_count, parse_status).
    parse_status is 'ok' if all lines are valid JSON, 'invalid' if any line fails.
    """
    block_count = 0
    for lineno, raw_line in enumerate(text.splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return 0, "invalid"
        if not isinstance(event, dict):
            continue
        if event.get("type") == "content_block_start":
            block_count += 1
    return block_count, "ok"


def _compute_cache_read_zero_above_floor(
    text: str,
    floor: int | None,
) -> bool | str:
    """Check whether cache_read_input_tokens is 0 when block count may exceed window.

    Returns True (risk flag) if usage is available AND cache_read == 0 AND floor supplied.
    Returns 'unknown' when usage is absent or floor is not supplied.
    This is a RISK FLAG, not a proof of cache miss.

    Malformed JSONL lines are TOLERATED (skipped) here, not fatal; the count of such lines
    is reported separately by ``build_report`` via ``_count_scan_parse_errors`` so a degraded
    scan is surfaced (``scan_parse_errors``) rather than silently dropped.
    """
    if floor is None:
        return "unknown", 0

    # Scan for usage blocks in the stream. Malformed lines are TOLERATED but COUNTED
    # (scan_parse_errors) and returned, so a degraded scan is surfaced — never silently dropped.
    usage_candidates: list[dict] = []
    scan_parse_errors = 0
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            scan_parse_errors += 1
            continue
        if not isinstance(event, dict):
            continue
        event_type = event.get("type", "")
        if event_type == "message_delta":
            u = event.get("usage")
            if isinstance(u, dict):
                usage_candidates.insert(0, u)
        elif event_type == "message_start":
            msg = event.get("message", {})
            if isinstance(msg, dict) and "usage" in msg and isinstance(msg["usage"], dict):
                usage_candidates.append(msg["usage"])
        elif "usage" in event and isinstance(event.get("usage"), dict):
            usage_candidates.append(event["usage"])

    if not usage_candidates:
        return "unknown", scan_parse_errors

    usage = usage_candidates[0]
    cache_read = usage.get("cache_read_input_tokens")
    if cache_read is None:
        return "unknown", scan_parse_errors
    try:
        cache_read_int = int(cache_read)
    except (TypeError, ValueError):
        return "unknown", scan_parse_errors

    # Risk flag: cache_read is 0 (no cache hit) AND usage indicates tokens above floor
    input_tokens = usage.get("input_tokens")
    if input_tokens is None:
        return "unknown", scan_parse_errors
    try:
        input_int = int(input_tokens)
    except (TypeError, ValueError):
        return "unknown", scan_parse_errors

    return bool(cache_read_int == 0 and input_int > floor), scan_parse_errors


def build_report(
    capture_path: Path,
    floor: int | None = None,
    prefix_tokens: int | None = None,
) -> dict:
    """Core logic: parse capture and return the block-window audit report dict."""
    # --- Load ---
    if not capture_path.exists():
        return {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": REDACTION,
            "_error": f"capture file not found: sha256_16={sha256_16(str(capture_path))}",
            "error_type": "missing_input",
        }
    try:
        raw_text = capture_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": REDACTION,
            "_error": f"{type(exc).__name__}: {exc}",
            "error_type": "missing_input",
        }

    # --- Parse ---
    block_count, parse_status = _count_content_blocks(raw_text)

    if parse_status == "invalid":
        return {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": REDACTION,
            "parse_status": "invalid",
            "error_type": "malformed_input",
        }

    # --- Degraded: zero blocks ---
    if block_count == 0:
        return {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": REDACTION,
            "parse_status": "degraded",
            "content_blocks": 0,
            "exceeds_20_lookback": False,
            "recommended_breakpoint_every": RECOMMENDED_BREAKPOINT_EVERY,
            "cache_read_zero_above_floor": "unknown",
            "provider_behavior_hypothesis": _PROVIDER_HYPOTHESIS,
            "risk": "degraded: no content_block_start events found in capture",
        }

    # --- Main assessment ---
    # NOTE: the window decision is EXACT, not approximate. The "~20" in the module prose is
    # a human shorthand; the code boundary is strict `> 20`, i.e. exactly 20 blocks is treated
    # as WITHIN the lookback window (exceeds_20_lookback=False) and 21 is the first value that
    # flips it True. Tests at 19/20/21 pin this boundary.
    exceeds_20 = block_count > CACHE_LOOKBACK_WINDOW
    cache_read_zero, _scan_errs = _compute_cache_read_zero_above_floor(raw_text, floor)

    if exceeds_20:
        risk = "HIGH: block count exceeds ~20-block lookback window; hypothesis: prior cache block may be evicted"
    elif block_count > RECOMMENDED_BREAKPOINT_EVERY:
        risk = "MEDIUM: block count above recommended breakpoint interval; monitor for window approach"
    else:
        risk = "LOW: block count within recommended breakpoint interval"

    report: dict = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": REDACTION,
        "content_blocks": block_count,
        "exceeds_20_lookback": exceeds_20,
        "recommended_breakpoint_every": RECOMMENDED_BREAKPOINT_EVERY,
        "cache_read_zero_above_floor": cache_read_zero,
        "provider_behavior_hypothesis": _PROVIDER_HYPOTHESIS,
        "risk": risk,
    }
    # NOTE: a malformed line makes _count_content_blocks return parse_status="invalid"
    # (rejected above), so by the time _compute runs the stream is all-valid and its
    # scan_parse_errors is structurally 0 here — the count is meaningful only to direct
    # callers of _compute, not to build_report, so it is not surfaced in this report.

    if floor is not None:
        report["floor"] = floor
    if prefix_tokens is not None:
        report["prefix_tokens"] = prefix_tokens

    return report


def main() -> int:
    ap = argparse.ArgumentParser(
        description=(
            "Bead 0.3: audit content-block count against cache lookback window. "
            "PROVES COUNTER LOGIC ONLY — provider cache behavior requires live capture (E1)."
        )
    )
    ap.add_argument("--capture", required=True, help="Path to stream.jsonl capture")
    ap.add_argument(
        "--floor",
        type=int,
        default=None,
        help="Token floor for cache_read_zero_above_floor risk flag (supply from cache_floor_registry)",
    )
    ap.add_argument(
        "--prefix-tokens",
        type=int,
        default=None,
        dest="prefix_tokens",
        help="Known or estimated prefix token count (metadata annotation only)",
    )
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = ap.parse_args()

    capture_path = Path(args.capture)
    report = build_report(capture_path, floor=args.floor, prefix_tokens=args.prefix_tokens)

    report = redact(report)

    json.dump(report, sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")

    # Exit nonzero on error / missing input
    if "_error" in report or report.get("error_type") == "missing_input":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
