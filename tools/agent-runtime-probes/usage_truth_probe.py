#!/usr/bin/env python3
"""usage_truth_probe.py — Bead 0.1: extract provider-truth token/cache fields.

Consumes a caller-supplied offline capture (response JSON or stream JSONL) and
emits a metadata-only report with provider-truth input_tokens, output_tokens, and
cache fields. NEVER uses chars/4 estimates. Absent fields → "unknown", never 0.

CLI: python3 usage_truth_probe.py --capture <resp.json|stream.jsonl> [--pretty]
Output: JSON to stdout.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from probelib import redact, load_json, sha256_16

SCHEMA = "agent-runtime-usage-truth"
SCHEMA_VERSION = "0.1"

# Fields expected from provider usage blocks
_USAGE_INT_FIELDS = (
    "input_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
)


def _parse_response_json(data: dict) -> dict | None:
    """Extract usage from a single response JSON object."""
    if not isinstance(data, dict):
        return None
    # Top-level usage block (non-streaming response)
    if "usage" in data and isinstance(data["usage"], dict):
        return data["usage"]
    return None


def _parse_stream_jsonl(text: str) -> dict | None:
    """Scan stream JSONL lines for a usage block.

    Prefers the final message_delta event usage (most complete), falls back to
    message_start usage. Returns a dict with:
      - "_usage": the winning usage dict (most complete available), or None
      - "_final_seen": True iff a message_delta (or message_stop) terminal event
        was present in the stream — i.e. the usage is COMPLETE, not a priming
        placeholder.
    On a malformed line returns {"_parse_line_error", "_parse_line_text"}.

    H3: a truncated/partial stream (only message_start, no terminal event)
    carries the priming output_tokens placeholder. The caller must NOT report
    that as a complete stream_usage. We surface "_final_seen" so it can emit
    stream_partial and mark non-final fields "unknown".
    """
    delta_usage: dict | None = None  # from message_delta — final cumulative usage
    start_usage: dict | None = None  # from message_start — priming placeholder
    bare_usage: dict | None = None   # from a bare top-level usage block
    final_seen = False               # message_delta OR message_stop present
    for lineno, raw_line in enumerate(text.splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return {"_parse_line_error": lineno, "_parse_line_text": line[:80]}
        if not isinstance(event, dict):
            continue
        event_type = event.get("type", "")
        # message_delta carries final cumulative usage AND is a terminal marker
        if event_type == "message_delta":
            final_seen = True
            du = event.get("usage")
            if isinstance(du, dict):
                delta_usage = du
        # message_stop is also a terminal marker (may carry no usage)
        elif event_type == "message_stop":
            final_seen = True
            su = event.get("usage")
            if isinstance(su, dict) and delta_usage is None:
                delta_usage = su
        # message_start carries initial (priming) usage — output_tokens placeholder
        elif event_type == "message_start":
            msg = event.get("message", {})
            if isinstance(msg, dict) and isinstance(msg.get("usage"), dict):
                start_usage = msg["usage"]
        # Also handle bare usage blocks at top level
        elif isinstance(event.get("usage"), dict):
            bare_usage = event["usage"]
    usage = delta_usage or bare_usage or start_usage
    if usage is None:
        return None
    return {"_usage": usage, "_final_seen": final_seen}


def _classify_cache_state(
    cache_read: object,
    cache_creation: object,
) -> str:
    """Derive cache_state from read/creation counts.

    warm    = read > 0, creation == 0
    cold    = read == 0, creation > 0
    partial = both > 0
    none    = both present and == 0 (provider reported NO cache activity — a
              present datum, distinct from a missing field)
    unknown = either field ABSENT (field-not-present)

    M4: present-zero (read==0 AND creation==0) is a real "no cache activity"
    observation. Collapsing it to "unknown" conflated it with field-absent.
    It now maps to a distinct "none" state; "unknown" is reserved for ABSENT
    fields only.
    """
    if cache_read == "unknown" or cache_creation == "unknown":
        return "unknown"
    try:
        read_n = int(cache_read)  # type: ignore[arg-type]
        creation_n = int(cache_creation)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return "unknown"
    if read_n > 0 and creation_n == 0:
        return "warm"
    if read_n == 0 and creation_n > 0:
        return "cold"
    if read_n > 0 and creation_n > 0:
        return "partial"
    # read==0 and creation==0: provider reported NO cache activity (present-zero)
    return "none"


def _extract_metrics(usage: dict) -> dict:
    """Pull known int fields from a usage dict; absent → 'unknown'."""
    out: dict[str, object] = {}
    for field in _USAGE_INT_FIELDS:
        val = usage.get(field)
        if val is None:
            out[field] = "unknown"
        else:
            try:
                out[field] = int(val)
            except (TypeError, ValueError):
                out[field] = "unknown"
    return out


def _cache_hit_fraction(
    cache_read: object,
    cache_creation: object,
    input_tokens: object,
) -> object:
    """Compute the true cache-read hit fraction over ALL prompt-token buckets.

    M3: the old `cache_read_to_input_ratio` divided cache_read by `input_tokens`
    alone. Anthropic's usage buckets are DISJOINT — `input_tokens` is the
    *uncached* remainder, not the total — so cache_read/input_tokens was
    unbounded (e.g. 1500/0-uncached) and was NOT the [0,1] hit-fraction the name
    implied. The honest denominator is the total prompt size:
        cache_read + cache_creation + input_tokens
    which yields the genuine fraction of prompt tokens served from cache, in
    [0, 1]. Field is renamed to `cache_read_hit_fraction` to match the math.

    Returns 'unknown' if ANY of the three buckets is absent (can't form an
    honest total), or if the total is 0.
    """
    if "unknown" in (cache_read, cache_creation, input_tokens):
        return "unknown"
    try:
        r = int(cache_read)  # type: ignore[arg-type]
        c = int(cache_creation)  # type: ignore[arg-type]
        i = int(input_tokens)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return "unknown"
    total = r + c + i
    if total == 0:
        return "unknown"
    return round(r / total, 6)


def _load_capture(capture_path: Path) -> tuple[str | None, dict | None]:
    """Load capture from path. Returns (raw_text, error_dict_or_None)."""
    if not capture_path.exists():
        # H4: never leak the raw absolute path into a metadata-only report — hash it.
        return None, {
            "_error": f"capture file not found: path_sha256_16={sha256_16(str(capture_path))}",
            "error_type": "missing_input",
        }
    try:
        raw = capture_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        # H4: the OSError str() may embed the raw path (e.g. "[Errno 13] ... '/Users/...'").
        # Emit only the exception TYPE plus the hashed path, never the raw text.
        return None, {
            "_error": f"{type(exc).__name__}: path_sha256_16={sha256_16(str(capture_path))}",
            "error_type": "missing_input",
        }
    return raw, None


def _detect_format(capture_path: Path) -> str:
    """Guess format from extension."""
    suffix = capture_path.suffix.lower()
    if suffix == ".jsonl":
        return "stream_jsonl"
    return "response_json"


def build_report(capture_path: Path) -> dict:
    """Core logic: parse capture and return the usage truth report dict."""
    raw_text, load_error = _load_capture(capture_path)
    if load_error is not None:
        return load_error

    assert raw_text is not None  # guarded above
    capture_sha256_16 = sha256_16(raw_text)
    fmt = _detect_format(capture_path)

    # --- Parse ---
    usage: dict | None = None
    parse_status: str = "ok"
    parser_class: str | None = None
    usage_source_class: str = "absent"
    stream_final_seen: bool = True  # only meaningful for stream_jsonl

    if fmt == "stream_jsonl":
        parser_class = "stream_jsonl"
        result = _parse_stream_jsonl(raw_text)
        if isinstance(result, dict) and "_parse_line_error" in result:
            parse_status = "invalid"
            usage = None
        elif isinstance(result, dict) and "_usage" in result:
            usage = result["_usage"]
            stream_final_seen = bool(result["_final_seen"])
        else:
            usage = None
    else:
        # response_json
        parser_class = "response_json"
        try:
            data = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            return {
                "schema": SCHEMA,
                "schema_version": SCHEMA_VERSION,
                "redaction": "metadata-only; token/cache counts and class labels only",
                "capture_sha256_16": capture_sha256_16,
                "parse_status": "invalid",
                "parser_class": parser_class,
                "_error": f"JSONDecodeError: {exc}",
                "error_type": "malformed_input",
            }
        if not isinstance(data, dict):
            parse_status = "invalid"
        else:
            usage = _parse_response_json(data)

    if parse_status == "invalid":
        return {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only; token/cache counts and class labels only",
            "capture_sha256_16": capture_sha256_16,
            "parse_status": "invalid",
            "parser_class": parser_class,
            "error_type": "malformed_input",
        }

    # --- Absent usage ---
    if usage is None:
        return {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only; token/cache counts and class labels only",
            "capture_sha256_16": capture_sha256_16,
            "input_tokens": "unknown",
            "cache_read_input_tokens": "unknown",
            "cache_creation_input_tokens": "unknown",
            "output_tokens": "unknown",
            "cache_read_hit_fraction": "unknown",
            "cache_state": "unknown",
            "usage_source_class": "absent",
        }

    # --- Extract metrics ---
    metrics = _extract_metrics(usage)
    input_tokens = metrics["input_tokens"]
    cache_read = metrics["cache_read_input_tokens"]
    cache_creation = metrics["cache_creation_input_tokens"]
    output_tokens = metrics["output_tokens"]

    # H3: a stream with NO terminal event (message_delta/message_stop) carries the
    # message_start priming usage, where output_tokens is a placeholder (typically 0)
    # and is NOT the final count. Never present a partial as a complete stream_usage:
    # mark the non-final field(s) "unknown" and label it stream_partial.
    is_stream_partial = fmt == "stream_jsonl" and not stream_final_seen
    if is_stream_partial:
        output_tokens = "unknown"

    cache_state = _classify_cache_state(cache_read, cache_creation)
    hit_fraction = _cache_hit_fraction(cache_read, cache_creation, input_tokens)

    # Determine usage_source_class from the format / completeness
    if fmt == "stream_jsonl":
        usage_source_class = "stream_partial" if is_stream_partial else "stream_usage"
    else:
        usage_source_class = "response_usage"

    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; token/cache counts and class labels only",
        "capture_sha256_16": capture_sha256_16,
        "input_tokens": input_tokens,
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_creation,
        "output_tokens": output_tokens,
        "cache_read_hit_fraction": hit_fraction,
        "cache_state": cache_state,
        "usage_source_class": usage_source_class,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Extract provider-truth token/cache fields from an offline capture."
    )
    ap.add_argument("--capture", required=True, help="Path to resp.json or stream.jsonl")
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = ap.parse_args()

    capture_path = Path(args.capture)
    report = build_report(capture_path)

    # Apply redaction to the full report before emitting
    report = redact(report)

    json.dump(report, sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")

    # Exit nonzero on error / missing input
    if "_error" in report or report.get("error_type") == "missing_input":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
