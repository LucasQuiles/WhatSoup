#!/usr/bin/env python3
"""benefit_backing_gate — proof-chain Slice 3 backed-benefit: claimed value vs measured value.

Completes the Slice 3 "bind benefit to the measurement substrate" requirement. `benefit_meter_gate` asks
whether the meter was OPERATIONAL (a measurement was even possible); this gate asks whether the CLAIMED
benefit value is corroborated by an actual MEASUREMENT. Together they back a `measured` benefit: the meter
was on AND the claimed number matches what it measured.

A step's `measured` benefit (value V on unit U) is BACKED only by a measurement that:
  - is for the same step,
  - is on the same unit U,
  - comes from a real-measurement provenance — provider_truth (provider usage fields) or local_measured (a
    deterministic local count) — never a `heuristic` (chars/4-family) estimate (USAGE-TRUTH), and
  - whose measured value matches V within `tolerance`.
Any unbacked / inflated / wrong-unit / weak-provenance `measured` claim has its EFFECTIVE proof_class
downgraded to `unknown` (adoption-ineligible) and the chain FAILs — closing the "measured: 0.4 was never
actually measured (or was inflated)" hole that defeats the central "benefit is real" thesis. heuristic /
unknown benefits never claimed a measurement, so a measurement on such a step is informational only.

Inputs are NORMALIZED measurement records (the caller extracts them from the substrate probes —
usage_truth_probe / savings_vs_session_length_meter / A1 — and tags provenance), keeping this gate focused
on the backing LOGIC rather than coupling to every probe's output schema. Reads only the declared benefit
via `mutation_proof_chain` (no spine verdict logic); fail-closed; metadata-only; proof_class
`deterministic_verifier`.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402

SCHEMA = "agent-runtime-benefit-backing-gate"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

MEASUREMENT_PROVENANCE = ("provider_truth", "local_measured", "heuristic", "unknown")
# only a REAL measurement backs a `measured` claim; a chars/4-family heuristic never does (USAGE-TRUTH).
BACKING_PROVENANCE = frozenset({"provider_truth", "local_measured"})
DEFAULT_TOLERANCE = 0.05


class BackingError(ValueError):
    """Typed, fail-closed error — never green a chain on a malformed measurement record."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _measurement_map(measurements, step_count: int) -> dict:
    """Validate the measurement sidecar and index it by step. Raises BackingError on any malformed entry."""
    out: dict = {}
    if measurements is None:
        return out
    if not isinstance(measurements, list):
        raise BackingError("malformed_measurement", "measurements must be a list")
    for m in measurements:
        if not isinstance(m, dict):
            raise BackingError("malformed_measurement", "each measurement must be a dict")
        idx = m.get("step_index")
        unit = m.get("unit")
        value = m.get("measured_value")
        prov = m.get("provenance", "unknown")
        if not isinstance(idx, int) or isinstance(idx, bool) or not (0 <= idx < step_count):
            raise BackingError("malformed_measurement", f"step_index out of range: {idx!r}")
        if not isinstance(unit, str) or not unit:
            raise BackingError("malformed_measurement", "measurement.unit must be a non-empty string")
        if not _is_number(value):
            raise BackingError("malformed_measurement", "measurement.measured_value must be a number")
        if prov not in MEASUREMENT_PROVENANCE:
            raise BackingError("malformed_measurement", f"provenance must be one of {MEASUREMENT_PROVENANCE}")
        if idx in out:
            raise BackingError("malformed_measurement", f"duplicate measurement for step {idx}")
        out[idx] = {"unit": unit, "measured_value": float(value), "provenance": prov}
    return out


def _backing_reason(benefit, m, tolerance: float) -> str | None:
    """Return the reason a `measured` claim is UNBACKED, or None if it is backed."""
    if m is None:
        return "unbacked_measured_claim"
    if m["unit"] != benefit.unit:
        return "unit_mismatch"
    if m["provenance"] not in BACKING_PROVENANCE:
        return "weak_provenance"
    if abs(float(benefit.value) - m["measured_value"]) > tolerance:
        return "benefit_claim_mismatch"
    return None


def verify_backing(records: list, measurements: list | None, tolerance: float = DEFAULT_TOLERANCE) -> dict:
    """Verify each `measured` benefit's claimed value against a substrate measurement. Fail-closed;
    metadata-only. PASS iff every `measured` claim is backed (matching unit + real provenance + value within
    tolerance)."""
    if not isinstance(records, list) or not records:
        return {
            "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
            "proof_class": "deterministic_verifier", "step_count": 0,
            "overall_verdict": "FAIL", "error_type": "empty_chain",
        }

    atts = [r if isinstance(r, mpc.Attestation) else mpc._record_from_dict(r) for r in records]
    by_step = _measurement_map(measurements, len(atts))

    steps: list = []
    unbacked: list = []
    for att in atts:
        declared = att.benefit.proof_class
        m = by_step.get(att.step_index)
        if declared == "measured":
            reason = _backing_reason(att.benefit, m, tolerance)
            backed = reason is None
            if not backed:
                unbacked.append(att.step_index)
        else:
            reason, backed = None, True  # non-measured benefits make no measurement claim to back
        steps.append({
            "step_index": att.step_index,
            "declared_purpose": att.declared_purpose,
            "declared_proof_class": declared,
            "benefit_unit": att.benefit.unit,
            "claimed_value": att.benefit.value,
            "measured_value": m["measured_value"] if m else None,
            "measurement_provenance": m["provenance"] if m else None,
            "backed": backed,
            "backing_reason": reason,
            "effective_proof_class": "unknown" if (declared == "measured" and not backed) else declared,
        })

    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "chain_id_16": sha256_16(atts[0].chain_id),
        "step_count": len(atts),
        "tolerance": tolerance,
        "measured_claim_count": sum(1 for a in atts if a.benefit.proof_class == "measured"),
        "unbacked_count": len(unbacked),
        "unbacked_indices": unbacked,
        "steps": steps,
        "recommended_action": "trust_backed_benefits" if not unbacked else "treat_unbacked_as_unknown",
        "overall_verdict": "PASS" if not unbacked else "FAIL",
    })


def _load(path: Path, missing: str, malformed: str):
    if not path.exists():
        return None, (missing, f"{path} not found")
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except json.JSONDecodeError as exc:
        return None, (malformed, f"JSONDecodeError: {exc}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Backed-benefit gate: a `measured` benefit's claimed value must "
                                             "match a real substrate measurement of the same unit.")
    ap.add_argument("--chain", required=True, help="JSON: a list of attestation record dicts")
    ap.add_argument("--measurements", required=True,
                    help="JSON: [{step_index, unit, measured_value, provenance}] substrate measurements")
    ap.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE)
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    records, err = _load(Path(args.chain), "missing_chain", "malformed_chain")
    if err:
        return _emit({"schema": SCHEMA, "error_type": err[0], "_error": err[1], "overall_verdict": "FAIL"}, 1)
    measurements, err = _load(Path(args.measurements), "missing_measurements", "malformed_measurements_json")
    if err:
        return _emit({"schema": SCHEMA, "error_type": err[0], "_error": err[1], "overall_verdict": "FAIL"}, 1)

    try:
        report = verify_backing(records, measurements, tolerance=args.tolerance)
    except BackingError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message,
                      "overall_verdict": "FAIL"}, 1)
    return _emit(report, 0 if report["overall_verdict"] == "PASS" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
