#!/usr/bin/env python3
"""substrate_measurement_adapter — Slice 3 live-extraction glue (substrate outputs -> backing records).

The thin adapter that closes the Slice 3 loop: it maps measurement-substrate outputs into the normalized
`{step_index, unit, measured_value, provenance}` records that `benefit_backing_gate` consumes, tagging the
correct provenance and failing closed (an absent/`unknown` provider field yields NO measurement — never a
fabricated number).

Sources:
  - "usage_truth"        -> provider_truth token_fraction REDUCTION from two usage_truth_probe metric dicts.
                            Total provider input = input_tokens + cache_read_input_tokens +
                            cache_creation_input_tokens (Anthropic's buckets are DISJOINT — summing only
                            input_tokens was the historical M3 bug); reduction = (before-after)/before. Any
                            `unknown` field, or a non-positive before-total, yields None (fail closed).
  - "deterministic_count"-> local_measured: a deterministic local count reduction (before-after) on the
                            caller-named unit (e.g. leak_count from a sanitizer/PI probe).
  - "heuristic_estimate" -> heuristic: a chars/4-family estimate, tagged so the backing gate REJECTS it as
                            backing for a `measured` claim (USAGE-TRUTH).

This adapter binds to the substrate's actual field names (reuses `usage_truth_probe`'s usage-field tuple),
so a rename there surfaces here. It carries NO verdict logic of its own — `benefit_backing_gate` judges
whether the extracted measurement backs a claim. proof_class `deterministic_verifier`; metadata-only.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact  # noqa: E402
import usage_truth_probe as utp  # noqa: E402  (reuse the substrate's canonical usage-field names)

SCHEMA = "agent-runtime-substrate-measurement-adapter"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

# The disjoint provider INPUT buckets only — token-fraction reduction is about INPUT (prompt) economics;
# `output_tokens` (the model's response) is deliberately excluded. Asserted to be a subset of the
# substrate's canonical field tuple so a rename there fails loudly here rather than silently mis-summing.
USAGE_FIELDS = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
assert set(USAGE_FIELDS) <= set(utp._USAGE_INT_FIELDS), "usage_truth_probe input-bucket field names drifted"
PROVENANCE_BY_SOURCE = {
    "usage_truth": "provider_truth",
    "deterministic_count": "local_measured",
    "heuristic_estimate": "heuristic",
}


class AdapterError(ValueError):
    """Typed, fail-closed error — never fabricate a measurement from a malformed extraction spec."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _total_input(metrics) -> int | None:
    """Disjoint-bucket provider-input total; None if any field is absent/'unknown'/non-int."""
    if not isinstance(metrics, dict):
        return None
    total = 0
    for f in USAGE_FIELDS:
        v = metrics.get(f)
        if v is None or v == "unknown" or not _is_number(v):
            return None
        total += int(v)
    return total


def token_reduction(before, after) -> float | None:
    """Provider-truth token-fraction reduction (before-after)/before over the disjoint-bucket total.
    None (fail closed) if either total is uncomputable or the before-total is non-positive."""
    tb, ta = _total_input(before), _total_input(after)
    if tb is None or ta is None or tb <= 0:
        return None
    return round((tb - ta) / tb, 6)


def extract(item) -> dict | None:
    """Map one extraction spec to a normalized measurement record, or None if uncomputable (fail closed).
    Raises AdapterError on a malformed/unknown spec (never a silent skip of a structurally-bad item)."""
    if not isinstance(item, dict):
        raise AdapterError("malformed_item", "each item must be a dict")
    idx = item.get("step_index")
    source = item.get("source")
    if not isinstance(idx, int) or isinstance(idx, bool) or idx < 0:
        raise AdapterError("malformed_item", f"step_index must be a non-negative int: {idx!r}")
    if source not in PROVENANCE_BY_SOURCE:
        raise AdapterError("unknown_source", f"source must be one of {sorted(PROVENANCE_BY_SOURCE)}: {source!r}")

    if source == "usage_truth":
        value = token_reduction(item.get("before"), item.get("after"))
        if value is None:
            return None  # absent/unknown provider usage -> no measurement (the backing gate downgrades)
        unit = "token_fraction"
    elif source == "deterministic_count":
        before, after = item.get("before"), item.get("after")
        unit = item.get("unit")
        if not isinstance(unit, str) or not unit or not _is_number(before) or not _is_number(after):
            raise AdapterError("malformed_item", "deterministic_count needs unit + numeric before/after")
        value = float(before) - float(after)
    else:  # heuristic_estimate
        unit = item.get("unit")
        raw = item.get("value")
        if not isinstance(unit, str) or not unit or not _is_number(raw):
            raise AdapterError("malformed_item", "heuristic_estimate needs unit + numeric value")
        value = float(raw)

    return {"step_index": idx, "unit": unit, "measured_value": value, "provenance": PROVENANCE_BY_SOURCE[source]}


def build_measurements(items) -> list:
    """Extract a list of specs into normalized measurement records, dropping the uncomputable ones."""
    if not isinstance(items, list):
        raise AdapterError("malformed_item", "items must be a list")
    out = [extract(it) for it in items]
    return [m for m in out if m is not None]


def main() -> int:
    ap = argparse.ArgumentParser(description="Extract substrate measurements into benefit_backing_gate records.")
    ap.add_argument("--items", required=True,
                    help="JSON: [{step_index, source, ...}] extraction specs (usage_truth / deterministic_count "
                         "/ heuristic_estimate)")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    path = Path(args.items)
    if not path.exists():
        return _emit({"schema": SCHEMA, "error_type": "missing_items", "_error": "items file not found"}, 1)
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return _emit({"schema": SCHEMA, "error_type": "malformed_items_json", "_error": f"JSONDecodeError: {exc}"}, 1)
    try:
        measurements = build_measurements(items)
    except AdapterError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message}, 1)
    return _emit({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "measurement_count": len(measurements),
        "measurements": measurements,
    }, 0)


if __name__ == "__main__":
    raise SystemExit(main())
