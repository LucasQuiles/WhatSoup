#!/usr/bin/env python3
"""savings_vs_session_length_meter.py — Bead 0.4: retrieval-over-replay savings curve.

Quantifies the LOCAL replay-cost-vs-session-length curve (retrieval-over-replay savings)
from offline run/usage summaries or synthetic fixtures. MECHANICAL Phase-5 entry gate.

CLI: --summaries <jsonl-of-per-turn-usage> [--synthetic] [--pretty]
Output: JSON to stdout.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from probelib import redact, load_json, sha256_16

SCHEMA = "agent-runtime-savings-meter"
SCHEMA_VERSION = "0.1"

# Session-length buckets (turn count ranges)
_BUCKETS = [
    ("0-10", 0, 10),
    ("11-50", 11, 50),
    ("51-200", 51, 200),
    ("201+", 201, None),
]

# Heuristic handle-return token cost per session (1-2k distilled summary)
_HANDLE_RETURN_TOKENS = 1500

# Proof-class precedence, strongest..weakest. Only local_measured is gate-opening;
# heuristic (chars/4) and synthetic (fabricated fixtures) and unknown all block.
_PROOF_PRECEDENCE = ("local_measured", "heuristic", "synthetic", "unknown")


def _strongest_proof_class(classes) -> str:
    """Return the strongest proof class present (defaults to 'unknown')."""
    for candidate in _PROOF_PRECEDENCE:
        if candidate in classes:
            return candidate
    return "unknown"


def _weakest_proof_class(classes) -> str:
    """Return the weakest proof class present (defaults to 'unknown').

    A bucket mixing real and synthetic/heuristic sessions must report the weakest
    class so an impure bucket can never claim 'local_measured'.
    """
    for candidate in reversed(_PROOF_PRECEDENCE):
        if candidate in classes:
            return candidate
    return "unknown"


def _bucket_name(turn_count: int) -> str:
    """Map turn count to a bucket label."""
    for label, lo, hi in _BUCKETS:
        if hi is None:
            if turn_count >= lo:
                return label
        elif lo <= turn_count <= hi:
            return label
    return "201+"


def _estimate_replay_tokens(session: dict) -> tuple[int, str]:
    """Estimate replay tokens from a session summary dict.

    Returns (token_count, proof_class).
    Prefers provider-truth token fields; falls back to chars/4 heuristic.
    """
    # Try provider-truth fields first
    input_tok = session.get("input_tokens")
    if input_tok is not None and isinstance(input_tok, (int, float)) and input_tok > 0:
        return int(input_tok), "local_measured"
    # Try total_tokens
    total_tok = session.get("total_tokens")
    if total_tok is not None and isinstance(total_tok, (int, float)) and total_tok > 0:
        return int(total_tok), "local_measured"
    # Fall back to chars/4 heuristic — distinct from fabricated synthetic fixtures
    chars = session.get("chars") or session.get("session_chars") or 0
    if isinstance(chars, (int, float)) and chars > 0:
        return int(chars / 4), "heuristic"
    # Synthetic fixture: use replay_tokens directly if present
    replay_tok = session.get("replay_tokens")
    if replay_tok is not None and isinstance(replay_tok, (int, float)) and replay_tok > 0:
        return int(replay_tok), "synthetic"
    return 0, "unknown"


def _build_buckets(sessions: list[dict]) -> list[dict]:
    """Aggregate sessions into per-bucket curves."""
    bucket_data: dict[str, dict] = {
        label: {"replay_sum": 0, "handle_sum": 0, "count": 0, "proof_classes": set()}
        for label, _, _ in _BUCKETS
    }

    for session in sessions:
        turn_count = session.get("turn_count") or session.get("turns") or session.get("num_turns") or 0
        if not isinstance(turn_count, (int, float)):
            turn_count = 0
        turn_count = int(turn_count)
        label = _bucket_name(turn_count)
        replay_tokens, proof_class = _estimate_replay_tokens(session)
        handle_tokens = _HANDLE_RETURN_TOKENS

        bucket_data[label]["replay_sum"] += replay_tokens
        bucket_data[label]["handle_sum"] += handle_tokens
        bucket_data[label]["count"] += 1
        bucket_data[label]["proof_classes"].add(proof_class)

    result = []
    for label, _, _ in _BUCKETS:
        bd = bucket_data[label]
        count = bd["count"]
        if count == 0:
            continue
        replay = bd["replay_sum"]
        handle = bd["handle_sum"]
        # savings_ratio: fraction of replay tokens saved by returning a handle instead
        # (normalized to [0,1], clamped >=0). Division-by-zero guarded on replay.
        savings_ratio: object
        cost_multiple: object
        if replay > 0:
            savings_ratio = round(max(0.0, 1 - handle / replay), 6)
            cost_multiple = round(replay / handle, 6) if handle > 0 else "unknown"
        else:
            savings_ratio = "unknown"
            cost_multiple = "unknown"

        # Determine bucket proof class as the WEAKEST class present so that a bucket
        # contaminated by any non-local_measured session cannot masquerade as proven.
        # Precedence (strongest..weakest): local_measured > heuristic > synthetic > unknown.
        proof_class = _weakest_proof_class(bd["proof_classes"])

        result.append({
            "session_length_bucket": label,
            "session_count": count,
            "replay_tokens": replay,
            "handle_return_tokens": handle,
            "savings_ratio": savings_ratio,
            "replay_to_handle_cost_multiple": cost_multiple,
            "proof_class": proof_class,
        })
    return result


def _overall_proof_class(buckets: list[dict]) -> str:
    """Derive overall proof class as the WEAKEST bucket class present.

    The gate must not open if ANY contributing bucket is impure, so the overall
    class is the weakest class across all buckets (precedence:
    local_measured > heuristic > synthetic > unknown). Empty -> unknown.
    """
    if not buckets:
        return "unknown"
    return _weakest_proof_class({b["proof_class"] for b in buckets})


def _phase5_gate(overall_proof_class: str, synthetic_only: bool) -> str:
    """Return phase5_entry_gate value."""
    if synthetic_only or overall_proof_class != "local_measured":
        return "blocked_research_only"
    return "open"


def _load_summaries_jsonl(path: Path) -> tuple[list[dict], str]:
    """Load JSONL summaries file. Returns (sessions, parse_status)."""
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:  # typed error: missing_input
        return [], "missing"

    sessions = []
    for lineno, raw_line in enumerate(raw.splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            return [], "invalid"
        if not isinstance(obj, dict):
            return [], "invalid"
        sessions.append(obj)

    if not sessions:
        return [], "degraded"
    return sessions, "ok"


def _synthetic_sessions() -> list[dict]:
    """Generate synthetic fixture sessions covering all buckets."""
    sessions = []
    # Bucket 0-10: 5 turns, 2000 tokens
    for _ in range(3):
        sessions.append({"turn_count": 5, "input_tokens": 2000})
    # Bucket 11-50: 25 turns, 8000 tokens
    for _ in range(5):
        sessions.append({"turn_count": 25, "input_tokens": 8000})
    # Bucket 51-200: 100 turns, 30000 tokens
    for _ in range(4):
        sessions.append({"turn_count": 100, "input_tokens": 30000})
    # Bucket 201+: 250 turns, 80000 tokens
    for _ in range(2):
        sessions.append({"turn_count": 250, "input_tokens": 80000})
    # Override proof class to synthetic for fixture sessions
    for s in sessions:
        del s["input_tokens"]
        s["replay_tokens"] = sessions[0].get("replay_tokens", 2000) if s["turn_count"] == 5 else (
            8000 if s["turn_count"] == 25 else (
                30000 if s["turn_count"] == 100 else 80000
            )
        )
    return sessions


def build_report(summaries_path: Path | None, synthetic: bool) -> dict:
    """Core logic: load summaries and return the savings meter report dict."""
    sessions: list[dict] = []
    parse_status: str = "ok"
    has_real_data = False

    if summaries_path is not None:
        if not summaries_path.exists():
            if not synthetic:
                return {
                    "schema": SCHEMA,
                    "schema_version": SCHEMA_VERSION,
                    "redaction": "metadata-only",
                    "_error": f"summaries file not found (path sha256_16={sha256_16(str(summaries_path))})",
                    "error_type": "missing_input",
                    "parse_status": "missing",
                }
            # synthetic fallback when file missing but --synthetic requested
            parse_status = "missing"
        else:
            loaded, parse_status = _load_summaries_jsonl(summaries_path)
            if parse_status == "invalid":
                return {
                    "schema": SCHEMA,
                    "schema_version": SCHEMA_VERSION,
                    "redaction": "metadata-only",
                    "parse_status": "invalid",
                    "error_type": "malformed_input",
                }
            if parse_status == "degraded":
                if not synthetic:
                    return {
                        "schema": SCHEMA,
                        "schema_version": SCHEMA_VERSION,
                        "redaction": "metadata-only",
                        "parse_status": "degraded",
                        "buckets": [],
                        "overall_proof_class": "unknown",
                        "phase5_entry_gate": "blocked_research_only",
                    }
                # synthetic will fill in below
            elif parse_status == "ok":
                sessions = loaded
                has_real_data = True
    elif not synthetic:
        # No summaries path AND no --synthetic → fail-closed typed error
        return {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only",
            "_error": "no --summaries file provided and --synthetic not set",
            "error_type": "missing_input",
            "parse_status": "missing",
        }

    # Augment with synthetic data if requested
    if synthetic:
        synth = _synthetic_sessions()
        sessions = sessions + synth

    buckets = _build_buckets(sessions)
    overall = _overall_proof_class(buckets)

    # phase5 gate: blocked unless real local_measured data exists (not synthetic-only)
    gate = _phase5_gate(overall, synthetic_only=not has_real_data)

    report: dict = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only",
        "overall_proof_class": overall,
        "phase5_entry_gate": gate,
        "buckets": buckets,
    }
    if parse_status not in ("ok",):
        report["parse_status"] = parse_status

    return report


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Quantify retrieval-over-replay savings vs session length."
    )
    ap.add_argument("--summaries", default=None, help="Path to JSONL of per-turn usage summaries")
    ap.add_argument("--synthetic", action="store_true", help="Include synthetic fixture data")
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = ap.parse_args()

    summaries_path = Path(args.summaries) if args.summaries else None
    report = build_report(summaries_path, synthetic=args.synthetic)

    # Apply redaction to the full report before emitting
    report = redact(report)

    json.dump(report, sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")

    # Exit nonzero on missing_input or malformed_input
    if "_error" in report or report.get("error_type") in ("missing_input", "malformed_input"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
