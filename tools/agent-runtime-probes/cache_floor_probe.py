#!/usr/bin/env python3
"""cache_floor_probe.py — Bead 0.2b: cache floor eligibility probe.

Given a model ID and a prefix token count, reports whether the prefix clears the
model's minimum cacheable floor using the research-seed registry
(cache_floor_registry.json, Bead 0.2a).

Unknown model → floor_tokens="unknown", risk="unknown_model_conservative". NEVER
defaults to 4096 or any other constant for an unlisted model.
Research-seed floor → risk notes unverified status; floor_status!="local_measured"
is not adoption-sufficient. The adoption-grade `cache_eligible` verdict is gated: it is
a real bool ONLY for a verified (local_measured) floor; for ANY non-verified case (unverified floor OR
unknown model) it is the SINGLE string sentinel "unverified" (never a second "unknown" sentinel — I4) and
`cache_eligible_verified` is False, so a downstream consumer keying on `cache_eligible` cannot read a
confident bool off a provider-unverified floor and cannot be tripped by a dual-sentinel split.

CLI: python3 cache_floor_probe.py --model <id> --prefix-tokens <int>
         [--registry cache_floor_registry.json] [--pretty]
Output: JSON to stdout.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from probelib import redact, load_json, sha256_16

SCHEMA = "agent-runtime-cache-floor"
SCHEMA_VERSION = "0.1"

_DEFAULT_REGISTRY = Path(__file__).parent / "cache_floor_registry.json"


def _load_registry(registry_path: Path) -> tuple[dict | None, dict | None]:
    """Load and validate the floor registry.

    Returns (entries_dict, error_dict). On any load or schema error returns
    (None, error_dict) — never an empty/silent success.
    """
    # H4: NEVER interpolate the raw absolute path into a metadata-only report — it leaks
    # filesystem layout past redact() (which only catches secret-shaped values, not paths).
    # Substitute a sha256_16 of the path so the marker stays diagnostic but non-revealing.
    path_hash = sha256_16(str(registry_path))
    if not registry_path.exists():
        return None, {
            "_error": f"registry not found: sha256_16={path_hash}",
            "error_type": "missing_input",
        }
    raw = load_json(registry_path)
    if raw is None:
        return None, {
            "_error": f"registry not found: sha256_16={path_hash}",
            "error_type": "missing_input",
        }
    if "_error" in raw:
        return None, {
            "_error": raw["_error"],
            "error_type": "malformed_input",
            "parse_status": "invalid",
        }
    if not isinstance(raw, dict):
        return None, {
            "_error": "registry root is not a JSON object",
            "error_type": "malformed_input",
            "parse_status": "invalid",
        }
    entries = raw.get("entries")
    if entries is None or not isinstance(entries, dict):
        return None, {
            "_error": "registry missing 'entries' dict",
            "error_type": "malformed_input",
            "parse_status": "invalid",
        }
    return entries, None


def _validate_prefix_tokens(prefix_tokens: int | None) -> dict | None:
    """Return typed error dict if prefix_tokens is invalid, else None."""
    if prefix_tokens is None:
        return {
            "_error": "prefix_tokens is required",
            "error_type": "missing_input",
        }
    if not isinstance(prefix_tokens, int) or isinstance(prefix_tokens, bool):
        return {
            "_error": f"prefix_tokens must be a non-negative integer, got {prefix_tokens!r}",
            "error_type": "malformed_input",
        }
    if prefix_tokens < 0:
        return {
            "_error": f"prefix_tokens must be >= 0, got {prefix_tokens}",
            "error_type": "malformed_input",
        }
    return None


def build_report(
    model: str,
    prefix_tokens: int,
    registry_path: Path = _DEFAULT_REGISTRY,
) -> dict:
    """Core logic: look up floor and report eligibility.

    Never raises; all error conditions return typed dicts.
    """
    # Validate prefix_tokens
    prefix_error = _validate_prefix_tokens(prefix_tokens)
    if prefix_error is not None:
        return prefix_error

    # Load registry
    entries, reg_error = _load_registry(registry_path)
    if reg_error is not None:
        return reg_error

    assert entries is not None  # guarded above

    entry = entries.get(model)

    if entry is None:
        # Unknown model — conservative, NEVER default to 4096
        return {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only",
            "model": model,
            "floor_tokens": "unknown",
            "floor_status": "unknown",
            "prefix_tokens": prefix_tokens,
            "sub_floor": "unknown",
            # I4: `cache_eligible`'s non-verified sentinel is UNIFORMLY "unverified" (an unknown model is
            # unverified by definition), so it uses ONE sentinel, never an "unknown" vs "unverified" split a
            # consumer could trip on. The model-unknown-ness lives in floor_status / risk, not in a second
            # cache_eligible sentinel.
            "cache_eligible": "unverified",
            # H2: the verdict is not adoption-grade; a downstream consumer must not read a confident bool.
            "cache_eligible_verified": False,
            "risk": "unknown_model_conservative",
        }

    # Validate entry shape
    if not isinstance(entry, dict):
        return {
            "_error": f"registry entry for model {model!r} is not a dict",
            "error_type": "malformed_input",
            "parse_status": "invalid",
        }

    floor_raw = entry.get("floor_tokens")
    status = entry.get("status", "unknown")

    if floor_raw is None or not isinstance(floor_raw, int):
        return {
            "_error": f"registry entry for model {model!r} missing valid floor_tokens",
            "error_type": "malformed_input",
            "parse_status": "invalid",
        }

    floor_tokens: int = floor_raw
    sub_floor: bool = prefix_tokens < floor_tokens
    # Raw threshold comparison — informative, but NOT yet the adoption-grade verdict.
    floor_cleared: bool = not sub_floor

    # H2: the adoption-grade `cache_eligible` signal is only trustworthy when the floor
    # itself was provider/locally VERIFIED. For any floor_status != "local_measured"
    # (e.g. research_seed — provider-unverified, currently 100% of the registry) the
    # floor value is taint, so the machine-readable verdict must carry that taint and a
    # downstream consumer keying on `cache_eligible` must NOT receive a confident bool.
    floor_verified: bool = status == "local_measured"

    # Risk label: unverified research seeds get explicit note
    if status == "local_measured":
        risk = "none" if floor_cleared else "sub_floor"
    elif status == "research_seed":
        risk = "research_seed_floor_unverified"
    else:
        risk = "unknown_floor_status"

    # Gate the adoption-grade signal: real bool only off a verified floor; otherwise the
    # string state "unverified" so no consumer can read it as a confident True/False.
    cache_eligible: bool | str = floor_cleared if floor_verified else "unverified"

    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only",
        "model": model,
        "floor_tokens": floor_tokens,
        "floor_status": status,
        "prefix_tokens": prefix_tokens,
        "sub_floor": sub_floor,
        "cache_eligible": cache_eligible,
        "cache_eligible_verified": floor_verified,
        "risk": risk,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Report cache floor eligibility for a model + prefix token count."
    )
    ap.add_argument("--model", required=True, help="Model ID (e.g. sonnet-4-6)")
    ap.add_argument("--prefix-tokens", required=True, type=int,
                    help="Prefix token count to check against the floor")
    ap.add_argument("--registry", default=str(_DEFAULT_REGISTRY),
                    help="Path to cache_floor_registry.json")
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = ap.parse_args()

    registry_path = Path(args.registry)

    # prefix_tokens validated via argparse int; negatives checked in build_report
    report = build_report(
        model=args.model,
        prefix_tokens=args.prefix_tokens,
        registry_path=registry_path,
    )

    report = redact(report)

    json.dump(report, sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")

    if "_error" in report or report.get("error_type") in {"missing_input", "malformed_input"}:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
