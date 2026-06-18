#!/usr/bin/env python3
"""chain_lineage_gate — proof-chain Slice 4 retry/fork lineage gate.

Closes the consensus §7 lifecycle gap "retry/fork (parent_chain_id)". A child mutation proof-chain may
CLAIM to be a fork (or retry) of a parent chain branching after the parent's step k. Nothing in the spine
proves that claim: each chain is genesis-bound under its OWN chain_id, and record_hash binds chain_id, so
the parent's and child's record hashes differ even for identical text steps. Left unchecked, a fresh chain
can masquerade as a continuation of a trusted parent (provenance laundering), or a fork can hide where it
actually diverged.

The chain-id-INDEPENDENT linkage is the TEXT hashes. A genuine fork at parent step k resumes from the
parent's text state AFTER step k, so:

    child[0].input_hash == parent[k].output_hash        (text continuity — the anti-laundering proof)

The gate also binds the parent's exact fork record (`parent_fork_record_hash == parent[k].record_hash`),
checks the declared parent_chain_id, forbids self-forking (parent and child share a chain_id), and requires
both chains to independently pass `mutation_proof_chain.verify_chain`. PASS only if every check holds.

HONEST SCOPE: this proves STRUCTURAL + TEXT lineage, not authenticity — an actor who controls both chains
can craft a continuous fake fork; `chain_authenticity` (keyed MAC per chain) is what makes each chain
unforgeable, and the two compose. Reads only `mutation_proof_chain` (NOT a plane verdict gate), leaving the
two_plane_separation + attestation purity guards unaffected. proof_class `deterministic_verifier`;
fail-closed; metadata-only (truncated hashes, indices, booleans, reasons — never raw text).
"""
from __future__ import annotations

import argparse
import hmac
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402

SCHEMA = "agent-runtime-chain-lineage-gate"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

_LINEAGE_KEYS = ("parent_chain_id", "fork_step", "parent_fork_record_hash")


class LineageError(ValueError):
    """Typed, fail-closed error — never green a fork on a malformed lineage declaration."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _validate_lineage(lineage) -> tuple:
    """Validate the lineage declaration; return (parent_chain_id, fork_step, parent_fork_record_hash).
    parent_chain_id is optional (None if absent); fork_step + parent_fork_record_hash are required."""
    if not isinstance(lineage, dict):
        raise LineageError("malformed_lineage", "lineage must be a dict")
    fork_step = lineage.get("fork_step")
    rh = lineage.get("parent_fork_record_hash")
    if not isinstance(fork_step, int) or isinstance(fork_step, bool):
        raise LineageError("malformed_lineage", "fork_step must be an int")
    if not isinstance(rh, str) or not rh:
        raise LineageError("malformed_lineage", "parent_fork_record_hash must be a non-empty string")
    pcid = lineage.get("parent_chain_id")
    if pcid is not None and not isinstance(pcid, str):
        raise LineageError("malformed_lineage", "parent_chain_id must be a string when present")
    return pcid, fork_step, rh


def _empty(error_type: str) -> dict:
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier", "overall_verdict": "FAIL", "error_type": error_type,
    }


def verify_lineage(parent_records: list, child_records: list, lineage: dict) -> dict:
    """Verify that `child` genuinely forks from `parent` at `lineage.fork_step`. Fail-closed; metadata-only."""
    if not isinstance(parent_records, list) or not parent_records or \
       not isinstance(child_records, list) or not child_records:
        return _empty("empty_chain")

    pcid_claim, fork_step, fork_rh_claim = _validate_lineage(lineage)

    parent = [r if isinstance(r, mpc.Attestation) else mpc._record_from_dict(r) for r in parent_records]
    child = [r if isinstance(r, mpc.Attestation) else mpc._record_from_dict(r) for r in child_records]

    reasons: list = []
    if mpc.verify_chain(parent_records)["overall_verdict"] != "PASS":
        reasons.append("parent_chain_invalid")
    if mpc.verify_chain(child_records)["overall_verdict"] != "PASS":
        reasons.append("child_chain_invalid")

    parent_cid = parent[0].chain_id
    child_cid = child[0].chain_id
    if parent_cid == child_cid:
        reasons.append("self_fork")
    if pcid_claim is not None and pcid_claim != parent_cid:
        reasons.append("parent_chain_id_mismatch")

    in_range = 0 <= fork_step < len(parent)
    if not in_range:
        reasons.append("fork_step_out_of_range")

    fork_record_match = False
    text_continuous = False
    if in_range:
        fork_record = parent[fork_step]
        fork_record_match = hmac.compare_digest(fork_rh_claim, fork_record.record_hash)
        if not fork_record_match:
            reasons.append("fork_record_mismatch")
        # the anti-laundering linkage: the child resumes from the parent's post-fork text state.
        text_continuous = hmac.compare_digest(child[0].input_hash, fork_record.output_hash)
        if not text_continuous:
            reasons.append("text_discontinuity")

    overall = "PASS" if not reasons else "FAIL"
    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "parent_chain_id_16": sha256_16(parent_cid),
        "child_chain_id_16": sha256_16(child_cid),
        "fork_step": fork_step,
        "parent_step_count": len(parent),
        "child_step_count": len(child),
        "fork_record_match": fork_record_match,
        "text_continuous": text_continuous,
        # a fork is "divergent" if the parent continued past the fork point (child is an alternative branch)
        "is_divergent_fork": in_range and fork_step < len(parent) - 1,
        "reasons": reasons,
        "recommended_action": "accept_lineage" if overall == "PASS" else "reject_lineage",
        "overall_verdict": overall,
    })


def _load(path: Path, missing: str, malformed: str):
    if not path.exists():
        return None, (missing, f"{path} not found")
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except json.JSONDecodeError as exc:
        return None, (malformed, f"JSONDecodeError: {exc}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Proof-chain retry/fork lineage gate: prove a child chain "
                                             "genuinely forks from its declared parent at the fork step.")
    ap.add_argument("--parent", required=True, help="JSON: parent chain record dicts")
    ap.add_argument("--child", required=True, help="JSON: child chain record dicts")
    ap.add_argument("--lineage", required=True, help="JSON: {parent_chain_id?, fork_step, parent_fork_record_hash}")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    parent, err = _load(Path(args.parent), "missing_parent", "malformed_parent")
    if err:
        return _emit({"schema": SCHEMA, "error_type": err[0], "_error": err[1], "overall_verdict": "FAIL"}, 1)
    child, err = _load(Path(args.child), "missing_child", "malformed_child")
    if err:
        return _emit({"schema": SCHEMA, "error_type": err[0], "_error": err[1], "overall_verdict": "FAIL"}, 1)
    lineage, err = _load(Path(args.lineage), "missing_lineage", "malformed_lineage_json")
    if err:
        return _emit({"schema": SCHEMA, "error_type": err[0], "_error": err[1], "overall_verdict": "FAIL"}, 1)

    try:
        report = verify_lineage(parent, child, lineage)
    except LineageError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message,
                      "overall_verdict": "FAIL"}, 1)
    return _emit(report, 0 if report["overall_verdict"] == "PASS" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
