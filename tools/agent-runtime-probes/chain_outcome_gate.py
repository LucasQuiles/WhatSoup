#!/usr/bin/env python3
"""chain_outcome_gate — proof-chain Slice 4 mid-chain-failure typed state.

Closes the consensus §7 lifecycle gap "mid-chain failure (partial chain)". A chain of k recorded steps is
ambiguous on its own: it could be (a) a normally completed plan, (b) a chain that ABORTED because step k
failed (and so produced no record for it), or (c) a maliciously truncated chain. The terminal seal
(`chain_lifecycle_gate`, closes F2) already rules out (c) — truncation is detected against the seal. This
gate types the rest: it validates that a declared terminal-outcome marker is STRUCTURALLY CONSISTENT with
the recorded steps (right status shape, right failure index).

HONEST SCOPE (integrity, NOT authenticity — verified via adversarial review): this gate checks the
CONSISTENCY of a DECLARED outcome; it does NOT authenticate it. The marker carries no binding to the chain,
so the SAME k records accept both a `completed` and a `failed@k` marker — `failed_at_step == k` is trivially
satisfiable for every k-record chain, so it cannot by itself flag a forged relabel (`completed -> failed`,
status swap, or a stripped marker). Detecting outcome TAMPER requires binding the marker into the producer
keyed MAC (`chain_authenticity`); the two compose — this gate is the structural-consistency check, the MAC
is the authenticity over it. This is the same integrity-vs-authenticity boundary as the spine's F1/F3.

Outcome marker: {status in [completed, failed, aborted], failed_at_step?, failure_class?}
  - completed : the chain ran to its planned end; it carries NO failure marker.
  - failed    : a step's own gate/validation failed (internal). Requires failed_at_step + failure_class.
  - aborted   : an external interruption (budget, timeout, kill). Requires failed_at_step + failure_class.

LOAD-BEARING INVARIANT (fail-closed): because `attest_step` emits NO record for a step that fails, a
failed/aborted outcome MUST name `failed_at_step == recorded_step_count` — the failure is at the step
BEYOND the last record. A failure index INSIDE the recorded range is a contradiction (a record exists for a
step claimed to have failed); a `completed` status carrying any failure marker is also a contradiction. The
special case of failure at the very first step (`failed_at_step == 0`) is the only valid empty-records
outcome.

Reuses `mutation_proof_chain.verify_chain` (the recorded steps must independently verify) — NOT a plane
verdict gate, so the two_plane_separation + attestation purity guards are unaffected. proof_class
`deterministic_verifier`; fail-closed; metadata-only (counts/enums/reasons, never raw text).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402

SCHEMA = "agent-runtime-chain-outcome-gate"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

OUTCOMES = ("completed", "failed", "aborted")
_FAILURE_STATES = frozenset({"failed", "aborted"})


class OutcomeError(ValueError):
    """Typed, fail-closed error — never green a chain on a malformed outcome marker."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _validate_outcome(outcome) -> tuple:
    """Validate the outcome marker's SHAPE (structural). Returns (status, failed_at_step, failure_class).
    Semantic consistency (index vs recorded count) is checked later as a verdict, not here."""
    if not isinstance(outcome, dict):
        raise OutcomeError("malformed_outcome", "outcome must be a dict")
    status = outcome.get("status")
    if status not in OUTCOMES:
        raise OutcomeError("malformed_outcome", f"status must be one of {OUTCOMES}: {status!r}")
    fas = outcome.get("failed_at_step")
    fclass = outcome.get("failure_class")
    if status in _FAILURE_STATES:
        if not isinstance(fas, int) or isinstance(fas, bool) or fas < 0:
            raise OutcomeError("malformed_outcome", f"{status} requires a non-negative int failed_at_step")
        if not isinstance(fclass, str) or not fclass:
            raise OutcomeError("malformed_outcome", f"{status} requires a non-empty failure_class")
    return status, fas, fclass


def verify_outcome(records: list, outcome: dict) -> dict:
    """Validate a chain's terminal-outcome marker against the recorded steps. Fail-closed; metadata-only."""
    status, failed_at_step, failure_class = _validate_outcome(outcome)
    recorded = len(records) if isinstance(records, list) else 0

    reasons: list = []
    chain_id_16 = None

    if recorded == 0:
        # the only valid empty-records outcome is a failure at the very first step
        if not (status in _FAILURE_STATES and failed_at_step == 0):
            return {
                "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
                "proof_class": "deterministic_verifier", "recorded_step_count": 0, "status": status,
                "overall_verdict": "FAIL",
                "error_type": "empty_completed_chain" if status == "completed" else "empty_chain_bad_index",
            }
    else:
        atts = [r if isinstance(r, mpc.Attestation) else mpc._record_from_dict(r) for r in records]
        chain_id_16 = sha256_16(atts[0].chain_id)
        if mpc.verify_chain(records)["overall_verdict"] != "PASS":
            reasons.append("base_chain_invalid")

    if status in _FAILURE_STATES:
        # the failure is at the step beyond the last record: failed_at_step must equal recorded count.
        if failed_at_step != recorded:
            reasons.append("inconsistent_failure_index")
    else:  # completed
        if outcome.get("failed_at_step") is not None or outcome.get("failure_class") is not None:
            reasons.append("spurious_failure_marker")

    overall = "PASS" if not reasons else "FAIL"
    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "chain_id_16": chain_id_16,
        "recorded_step_count": recorded,
        "status": status,
        "is_partial": status in _FAILURE_STATES,
        "failed_at_step": failed_at_step,
        "failure_class": failure_class,
        "reasons": reasons,
        "recommended_action": "accept_outcome" if overall == "PASS" else "reject_outcome",
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
    ap = argparse.ArgumentParser(description="Proof-chain terminal-outcome gate: type a chain as completed / "
                                             "failed / aborted and enforce the failure-index invariant.")
    ap.add_argument("--chain", required=True, help="JSON: a list of attestation record dicts")
    ap.add_argument("--outcome", required=True, help="JSON: {status, failed_at_step?, failure_class?}")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    records, err = _load(Path(args.chain), "missing_chain", "malformed_chain")
    if err:
        return _emit({"schema": SCHEMA, "error_type": err[0], "_error": err[1], "overall_verdict": "FAIL"}, 1)
    outcome, err = _load(Path(args.outcome), "missing_outcome", "malformed_outcome_json")
    if err:
        return _emit({"schema": SCHEMA, "error_type": err[0], "_error": err[1], "overall_verdict": "FAIL"}, 1)

    try:
        report = verify_outcome(records, outcome)
    except OutcomeError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message,
                      "overall_verdict": "FAIL"}, 1)
    return _emit(report, 0 if report["overall_verdict"] == "PASS" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
