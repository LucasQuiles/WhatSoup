#!/usr/bin/env python3
"""partial_adoption_gate — proof-chain Slice 4 partial adoption / effective-chain projector.

Closes the consensus §7 lifecycle gap "partial adoption (per-step adopt|skip|replace_with_prior +
effective_chain_hash)". A mutation proof chain proves the LINEAR application of ALL its steps, but at
runtime some steps fall back (a reducer step fails its gate -> verbatim; an enricher step is dropped).
What was actually APPLIED is therefore a sub-derivation of what was proven. This gate folds per-step
decisions into the EFFECTIVE applied text and a tamper-evident `effective_chain_hash`.

Decisions (one per step):
  - adopt  : take this step's output as the new in-force text.
  - skip   : do not apply this step; in-force text is unchanged.
  - revert : apply-then-rollback; in-force text is unchanged (distinct from skip only in PROVENANCE,
             which is recorded — so the commitment distinguishes skip from revert).

LOAD-BEARING INVARIANT (fail-closed): a step proves a transform input(i) -> output(i). You may ADOPT it
only if its proven input still matches the current in-force text. Once an upstream step is skipped/reverted
the in-force text diverges from what a later step's proof assumed, so a later ADOPT is INCOHERENT
(`adopt_input_discontinuity`) — you cannot adopt a proof that is for a different input. This is why partial
adoption in a linear chain is, in practice, prefix-adoption: skipping mid-chain invalidates the proofs of
the steps that depended on the skipped output.

The effective-chain identity commits (domain-separated) to chain_id + original input + the ordered
(step_index, decision, in_force_after) tuples + the effective output, so any two different decision-sets
over the same chain yield distinct identities, and truncation/reordering of the decision list is detected.

Reuses `mutation_proof_chain` only (verify_chain for the base, canonical_bytes for the commitment) — NOT a
plane verdict gate, so the two_plane_separation + attestation purity guards are unaffected. proof_class
`deterministic_verifier`; fail-closed; metadata-only (hashes/indices/enums/reasons, never raw text).
"""
from __future__ import annotations

import argparse
import json
import sys
from hashlib import sha256
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402

SCHEMA = "agent-runtime-partial-adoption-gate"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

EFF_DOMAIN_TAG = b"CAPE-MPC-EFFCHAIN-v0\x00"
DECISIONS = ("adopt", "skip", "revert")


class AdoptionError(ValueError):
    """Typed, fail-closed error — never green an effective chain on a malformed decision set."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _decision_map(decisions, step_count: int) -> dict:
    """Validate the decision set: exactly one decision per step, covering [0, step_count), each in the
    enum. Raises AdoptionError on any malformed/missing/duplicate/out-of-range/extra entry."""
    if not isinstance(decisions, list) or len(decisions) != step_count:
        raise AdoptionError("malformed_decisions", f"need exactly {step_count} decisions, one per step")
    out: dict = {}
    for entry in decisions:
        if not isinstance(entry, dict):
            raise AdoptionError("malformed_decisions", "each decision must be a dict")
        idx = entry.get("step_index")
        decision = entry.get("decision")
        if not isinstance(idx, int) or isinstance(idx, bool) or not (0 <= idx < step_count):
            raise AdoptionError("malformed_decisions", f"step_index out of range: {idx!r}")
        if decision not in DECISIONS:
            raise AdoptionError("malformed_decisions", f"decision must be one of {DECISIONS}: {decision!r}")
        if idx in out:
            raise AdoptionError("malformed_decisions", f"duplicate decision for step {idx}")
        out[idx] = decision
    return out


def compute_effective_chain(records: list, decisions: list) -> dict:
    """Fold per-step adopt/skip/revert decisions into the effective applied text + a tamper-evident
    effective_chain_hash. Fail-closed; metadata-only. PASS iff the base chain verifies AND every ADOPT's
    proven input matches the in-force text at that point (a coherent applied derivation)."""
    if not isinstance(records, list) or not records:
        return {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "proof_class": "deterministic_verifier", "overall_verdict": "FAIL", "error_type": "empty_chain",
        }

    atts = [r if isinstance(r, mpc.Attestation) else mpc._record_from_dict(r) for r in records]
    decision_by_step = _decision_map(decisions, len(atts))

    reasons: list = []
    if mpc.verify_chain(records)["overall_verdict"] != "PASS":
        reasons.append("base_chain_invalid")

    in_force = atts[0].input_hash
    steps: list = []
    tuples: list = []  # the commitment body (must mirror the test's independent re-derivation)
    adopted = 0
    for att in atts:
        decision = decision_by_step[att.step_index]
        incoherent = False
        if decision == "adopt":
            if att.input_hash == in_force:
                in_force = att.output_hash
                adopted += 1
            else:
                incoherent = True  # cannot adopt a proof whose input is not the in-force text
        # skip / revert / incoherent-adopt all leave in_force unchanged
        if incoherent:
            reasons.append("adopt_input_discontinuity")
        steps.append({
            "step_index": att.step_index,
            "decision": decision,
            "declared_purpose": att.declared_purpose,
            "in_force_after_16": sha256_16(in_force),
            "incoherent": incoherent,
        })
        tuples.append([att.step_index, decision, in_force])

    body = {
        "chain_id": atts[0].chain_id,
        "original_input_hash": atts[0].input_hash,
        "decisions": tuples,
        "effective_output_hash": in_force,
    }
    effective_chain_hash = sha256(EFF_DOMAIN_TAG + mpc.canonical_bytes(body)).hexdigest()

    overall = "PASS" if not reasons else "FAIL"
    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "chain_id_16": sha256_16(atts[0].chain_id),
        "step_count": len(atts),
        "adopted_count": adopted,
        "skipped_count": sum(1 for s in steps if s["decision"] == "skip"),
        "reverted_count": sum(1 for s in steps if s["decision"] == "revert"),
        "effective_output_hash_16": sha256_16(in_force),
        "effective_chain_hash": effective_chain_hash,
        "steps": steps,
        # dedupe reasons while preserving order
        "reasons": list(dict.fromkeys(reasons)),
        "recommended_action": "apply_effective_chain" if overall == "PASS" else "reject_decision_set",
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
    ap = argparse.ArgumentParser(description="Partial-adoption / effective-chain projector: fold per-step "
                                             "adopt/skip/revert into the effective applied chain.")
    ap.add_argument("--chain", required=True, help="JSON: a list of attestation record dicts")
    ap.add_argument("--decisions", required=True, help="JSON: [{step_index, decision}] one per step")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    records, err = _load(Path(args.chain), "missing_chain", "malformed_chain")
    if err:
        return _emit({"schema": SCHEMA, "error_type": err[0], "_error": err[1], "overall_verdict": "FAIL"}, 1)
    decisions, err = _load(Path(args.decisions), "missing_decisions", "malformed_decisions_json")
    if err:
        return _emit({"schema": SCHEMA, "error_type": err[0], "_error": err[1], "overall_verdict": "FAIL"}, 1)

    try:
        report = compute_effective_chain(records, decisions)
    except AdoptionError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message,
                      "overall_verdict": "FAIL"}, 1)
    return _emit(report, 0 if report["overall_verdict"] == "PASS" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
