#!/usr/bin/env python3
"""benefit_meter_gate — proof-chain Slice 4 benefit-meter integrity gate.

Closes the consensus §7 lifecycle gap "non-operational meter ⇒ benefit=unknown". A mutation proof-chain
step may DECLARE a benefit with proof_class `measured`, but a measured claim is only honest if the METER
that produced that measurement was OPERATIONAL at the time. A `measured` benefit whose meter was
non-operational / degraded / absent is an OVERCLAIM: this gate downgrades its EFFECTIVE proof_class to
`unknown` (which the adoption tier treats as ineligible) and fails the chain's benefit-integrity check.

This directly defends the central thesis ("benefit is real"): without it, a pipeline — or an adversary —
can stamp `measured` on a benefit that was never actually measured, laundering an unearned "provably
better" verdict. heuristic/unknown benefits never claimed a measurement, so meter status does not touch
them (a meter entry on such a step is recorded as informational only).

Scope: this is the benefit-backing LENS only; it composes with the other proof-chain gates (verify_chain
for continuity, chain_lifecycle_gate for the terminal seal / DoS cap, chain_authenticity for the keyed
MAC, adoption_orchestrator for plane routing) — each a single focused check. It reads only the declared
benefit proof_class per step (via the spine), never the spine's verdict logic; it imports
`mutation_proof_chain` (NOT a plane verdict gate), so the two_plane_separation + attestation purity guards
are unaffected. proof_class `deterministic_verifier`; fail-closed; metadata-only.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402

SCHEMA = "agent-runtime-benefit-meter-gate"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

METER_STATES = ("operational", "degraded", "non_operational", "absent")
# only an OPERATIONAL meter backs a `measured` benefit; anything else downgrades it.
BACKED = frozenset({"operational"})


class MeterGateError(ValueError):
    """Typed, fail-closed error — never green a chain on a malformed meter-status declaration."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _status_map(meter_statuses, step_count: int) -> dict:
    """Validate the meter-status sidecar and index it by step. Raises MeterGateError on any malformed
    entry (non-dict, missing/typed step_index, out-of-range step, unknown status, duplicate step)."""
    out: dict = {}
    if meter_statuses is None:
        return out
    if not isinstance(meter_statuses, list):
        raise MeterGateError("malformed_meter_status", "meter_statuses must be a list")
    for entry in meter_statuses:
        if not isinstance(entry, dict):
            raise MeterGateError("malformed_meter_status", "each meter status must be a dict")
        idx = entry.get("step_index")
        status = entry.get("status")
        if not isinstance(idx, int) or isinstance(idx, bool) or not (0 <= idx < step_count):
            raise MeterGateError("malformed_meter_status", f"step_index out of range: {idx!r}")
        if status not in METER_STATES:
            raise MeterGateError("malformed_meter_status", f"status must be one of {METER_STATES}: {status!r}")
        if idx in out:
            raise MeterGateError("malformed_meter_status", f"duplicate meter status for step {idx}")
        out[idx] = status
    return out


def verify_benefit_meters(records: list, meter_statuses: list | None) -> dict:
    """Project each step's EFFECTIVE benefit proof_class given meter status. Fail-closed; metadata-only.

    A `measured` benefit is kept only if its step has an OPERATIONAL meter; otherwise it is downgraded to
    `unknown` and the chain FAILs (a measured overclaim was detected and corrected). PASS iff no measured
    benefit was unbacked."""
    if not isinstance(records, list) or not records:
        return {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "proof_class": "deterministic_verifier", "step_count": 0,
            "overall_verdict": "FAIL", "error_type": "empty_chain",
        }

    atts = [r if isinstance(r, mpc.Attestation) else mpc._record_from_dict(r) for r in records]
    status_by_step = _status_map(meter_statuses, len(atts))

    steps: list = []
    downgraded: list = []
    for att in atts:
        declared = att.benefit.proof_class
        status = status_by_step.get(att.step_index, "absent" if declared == "measured" else None)
        is_downgrade = declared == "measured" and status not in BACKED
        effective = "unknown" if is_downgrade else declared
        if is_downgrade:
            downgraded.append(att.step_index)
        steps.append({
            "step_index": att.step_index,
            "declared_purpose": att.declared_purpose,
            "declared_proof_class": declared,
            "meter_status": status,
            "effective_proof_class": effective,
            "downgraded": is_downgrade,
            "benefit_unit": att.benefit.unit,
            "benefit_direction": att.benefit.direction,
        })

    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "chain_id_16": sha256_16(atts[0].chain_id),
        "step_count": len(atts),
        "measured_step_count": sum(1 for a in atts if a.benefit.proof_class == "measured"),
        "downgrade_count": len(downgraded),
        "downgraded_indices": downgraded,
        "steps": steps,
        "recommended_action": "trust_measured_benefits" if not downgraded else "treat_downgraded_as_unknown",
        "overall_verdict": "PASS" if not downgraded else "FAIL",
    })


def _load(path: Path, missing: str, malformed: str):
    """Load+parse a JSON file or return a typed (error_type, message). Returns (obj, None) on success."""
    if not path.exists():
        return None, (missing, f"{path} not found")
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except json.JSONDecodeError as exc:
        return None, (malformed, f"JSONDecodeError: {exc}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Benefit-meter integrity gate: a `measured` benefit without an "
                                             "operational meter is downgraded to `unknown` and fails.")
    ap.add_argument("--chain", required=True, help="JSON: a list of attestation record dicts")
    ap.add_argument("--meters", help="JSON: [{step_index, status, meter_id?}] meter-status sidecar")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    records, err = _load(Path(args.chain), "missing_chain", "malformed_chain")
    if err:
        return _emit({"schema": SCHEMA, "error_type": err[0], "_error": err[1], "overall_verdict": "FAIL"}, 1)

    meters = None
    if args.meters:
        meters, err = _load(Path(args.meters), "missing_meters", "malformed_meters")
        if err:
            return _emit({"schema": SCHEMA, "error_type": err[0], "_error": err[1], "overall_verdict": "FAIL"}, 1)

    try:
        report = verify_benefit_meters(records, meters)
    except MeterGateError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message,
                      "overall_verdict": "FAIL"}, 1)
    return _emit(report, 0 if report["overall_verdict"] == "PASS" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
