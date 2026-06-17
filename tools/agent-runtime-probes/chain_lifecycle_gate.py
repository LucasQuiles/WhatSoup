#!/usr/bin/env python3
"""chain_lifecycle_gate — proof-chain Slice 4 lifecycle gate (terminal seal + DoS cap + no-op/expand).

This tier sits OVER a spine-verified mutation proof chain (`mutation_proof_chain.verify_chain`) and adds
the lifecycle invariants the spine deliberately does not carry — without touching the spine's CLOSED,
purity-guard-pinned `Attestation` field set. Three coherent Slice-4 items:

1. TERMINAL SEAL (closes red-team F2 'chain truncation — any prefix is a valid chain'). Because each
   record only binds to its predecessor, every PREFIX of a valid chain is itself a valid chain, so the
   spine verifier cannot detect that the last N steps were dropped (hiding a mutation). `seal_chain`
   emits a detached commitment over (chain_id, step_count, EVERY record hash in order); `verify_lifecycle`
   recompares it, so truncation, extension, and same-length swaps are all detected against the seal.
   HONEST SCOPE: the seal is UNKEYED — it closes ACCIDENTAL truncation and any truncation by a party that
   does not control the seal's distribution. Against a malicious re-sealing actor, the seal must itself be
   signed: `chain_authenticity` (Slice 2) keyed-MACs the same (chain_id, record_count, record_hashes)
   binding. The two compose: this gate is the structural commitment; the MAC is the authenticity over it.

2. MAX-CHAIN DoS CAP: the spine verifier will walk an arbitrarily long chain. A chain longer than
   `max_steps` is rejected fail-closed (a runaway / adversarial chain is a memory+CPU DoS).

3. NO-OP / EXPANDING ACCOUNTING: counts identity (no-op), expanding, and reducing deltas; a run of more
   than `max_consecutive_noops` identity steps is a do-nothing loop (waste / liveness-DoS) and fails the
   gate. Expansion is reported but NOT auto-failed (an enricher legitimately expands; only the keyed
   benefit/lift gates judge whether an expansion is worth it).

proof_class `deterministic_verifier`; fail-closed; metadata-only (truncated hashes, counts, enums,
reasons — never raw text). Imports `mutation_proof_chain` only (NOT a plane verdict gate), so the
two_plane_separation guard is not engaged and the attestation purity guard (which scans only
mutation_proof_chain.py) is unaffected.
"""
from __future__ import annotations

import argparse
import hmac
import json
import sys
from hashlib import sha256
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402

SCHEMA = "agent-runtime-chain-lifecycle-gate"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

# Distinct from mutation_proof_chain.DOMAIN_TAG and chain_authenticity.SIG_DOMAIN_TAG: a seal commitment
# must never collide with a record hash, a genesis anchor, or a keyed signature pre-image.
SEAL_DOMAIN_TAG = b"CAPE-MPC-SEAL-v0\x00"

MAX_CHAIN_STEPS = 64           # DoS cap: an output assembled from more than this many mutations is rejected
MAX_CONSECUTIVE_NOOPS = 2      # more than this many identity steps in a row is a do-nothing loop

_NOOP_DELTAS = frozenset({"identity"})
_REDUCING_DELTAS = frozenset({"deletion", "length_reduction"})
_EXPANDING_DELTAS = frozenset({"prefix_changed", "suffix_appended", "middle_insertion", "length_expansion"})


class LifecycleError(ValueError):
    """Typed, fail-closed error — never green a chain on a missing/malformed lifecycle input."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _atts(records: list) -> list:
    """Parse records into Attestations (fail-closed via mpc on malformed shape)."""
    return [r if isinstance(r, mpc.Attestation) else mpc._record_from_dict(r) for r in records]


def _commitment(atts: list) -> str:
    """The seal commitment: a domain-tagged hash over chain_id + length + EVERY record hash in order.
    Binding every hash (not just the terminal) makes truncation, extension, and reorder all detectable."""
    body = {
        "chain_id": atts[0].chain_id,
        "step_count": len(atts),
        "record_hashes": [a.record_hash for a in atts],
    }
    return sha256(SEAL_DOMAIN_TAG + mpc.canonical_bytes(body)).hexdigest()


def seal_chain(records: list) -> dict:
    """Produce a detached terminal seal for a chain. Raises LifecycleError on an empty chain."""
    if not isinstance(records, list) or not records:
        raise LifecycleError("empty_chain", "cannot seal an empty chain")
    atts = _atts(records)
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "seal_domain": SEAL_DOMAIN_TAG.decode("ascii").rstrip("\x00"),
        "proof_class": "deterministic_verifier",
        "chain_id_16": sha256_16(atts[0].chain_id),
        "step_count": len(atts),
        "terminal_record_hash_16": sha256_16(atts[-1].record_hash),
        "commitment": _commitment(atts),
    }


def _check_seal(atts: list, seal: dict) -> tuple[str, list]:
    """Compare a chain against a seal. Returns (status, reasons)."""
    if (not isinstance(seal, dict) or not isinstance(seal.get("commitment"), str)
            or not isinstance(seal.get("step_count"), int)
            or not isinstance(seal.get("terminal_record_hash_16"), str)):
        return "malformed_seal", ["malformed_seal"]
    reasons: list = []
    if seal["step_count"] != len(atts):
        reasons.append("step_count_mismatch")
    if seal["terminal_record_hash_16"] != sha256_16(atts[-1].record_hash):
        reasons.append("terminal_record_mismatch")
    # constant-time compare of the full commitment (length+terminal+every record hash).
    if not hmac.compare_digest(seal["commitment"], _commitment(atts)):
        reasons.append("commitment_mismatch")
    return ("verified" if not reasons else "mismatch"), reasons


def verify_lifecycle(records: list, seal: dict | None = None, *,
                     max_steps: int = MAX_CHAIN_STEPS,
                     max_consecutive_noops: int = MAX_CONSECUTIVE_NOOPS) -> dict:
    """Lifecycle gate over a chain: spine verification + DoS cap + no-op/expand accounting + optional
    terminal-seal check. Fail-closed; metadata-only. PASS only if the spine is valid, the chain is within
    the DoS cap, there is no no-op loop, and (if a seal is supplied) the seal verifies."""
    if not isinstance(records, list) or not records:
        return {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "proof_class": "deterministic_verifier", "step_count": 0,
            "overall_verdict": "FAIL", "error_type": "empty_chain",
        }

    atts = _atts(records)
    base = mpc.verify_chain(records)
    lifecycle_reasons: list = []
    if base["overall_verdict"] != "PASS":
        lifecycle_reasons.append("base_chain_invalid")

    # DoS cap.
    within_dos_cap = len(atts) <= max_steps
    if not within_dos_cap:
        lifecycle_reasons.append("chain_too_long")

    # no-op / expand / reduce accounting.
    noop = expanding = reducing = 0
    run = best_run = 0
    for a in atts:
        if a.delta_type in _NOOP_DELTAS:
            noop += 1
            run += 1
            best_run = max(best_run, run)
        else:
            run = 0
            if a.delta_type in _EXPANDING_DELTAS:
                expanding += 1
            elif a.delta_type in _REDUCING_DELTAS:
                reducing += 1
    if best_run > max_consecutive_noops:
        lifecycle_reasons.append("noop_loop")

    # optional seal.
    if seal is None:
        seal_status, seal_reasons = "unsealed", []
    else:
        seal_status, seal_reasons = _check_seal(atts, seal)

    sealed_ok = seal is None or seal_status == "verified"
    overall = "PASS" if (not lifecycle_reasons and sealed_ok) else "FAIL"
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "chain_id_16": sha256_16(atts[0].chain_id),
        "step_count": len(atts),
        "base_verdict": base["overall_verdict"],
        "within_dos_cap": within_dos_cap,
        "max_steps": max_steps,
        "noop_count": noop,
        "expanding_count": expanding,
        "reducing_count": reducing,
        "max_consecutive_noops_observed": best_run,
        "seal_status": seal_status,
        "seal_reasons": seal_reasons,
        "lifecycle_reasons": lifecycle_reasons,
        "recommended_action": "accept" if overall == "PASS" else "reject",
        "overall_verdict": overall,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Proof-chain lifecycle gate: terminal seal (F2 truncation), "
                                             "max-chain DoS cap, no-op/expand accounting.")
    ap.add_argument("--chain", required=True, help="JSON: a list of attestation record dicts")
    ap.add_argument("--seal", action="store_true", help="emit a terminal seal for the chain (instead of verifying)")
    ap.add_argument("--verify-seal", metavar="SEAL_JSON", help="verify the chain against this seal file")
    ap.add_argument("--max-steps", type=int, default=MAX_CHAIN_STEPS)
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    path = Path(args.chain)
    if not path.exists():
        return _emit({"schema": SCHEMA, "error_type": "missing_chain",
                      "_error": "chain not found", "overall_verdict": "FAIL"}, 1)
    try:
        records = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return _emit({"schema": SCHEMA, "error_type": "malformed_chain",
                      "_error": f"JSONDecodeError: {exc}", "overall_verdict": "FAIL"}, 1)

    try:
        if args.seal:
            return _emit(seal_chain(records), 0)
        seal = None
        if args.verify_seal:
            sp = Path(args.verify_seal)
            if not sp.exists():
                return _emit({"schema": SCHEMA, "error_type": "missing_seal",
                              "_error": "seal not found", "overall_verdict": "FAIL"}, 1)
            seal = json.loads(sp.read_text(encoding="utf-8"))
        report = verify_lifecycle(records, seal, max_steps=args.max_steps)
    except LifecycleError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message,
                      "overall_verdict": "FAIL"}, 1)
    except json.JSONDecodeError as exc:
        return _emit({"schema": SCHEMA, "error_type": "malformed_seal",
                      "_error": f"JSONDecodeError: {exc}", "overall_verdict": "FAIL"}, 1)
    return _emit(report, 0 if report["overall_verdict"] == "PASS" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
