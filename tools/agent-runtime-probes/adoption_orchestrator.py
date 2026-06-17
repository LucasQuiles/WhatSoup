#!/usr/bin/env python3
"""adoption_orchestrator — the two-plane adoption dispatcher (proof-chain Slice 2 adoption tier).

The two planes adopt through SEPARATE gates that MUST NOT share verdict logic (H5):
  - the REDUCER plane (cost) adopts ONLY through B3 `paired_trial_harness` (cost/cache/quality-not-worse),
  - the ENRICHER plane (quality) adopts ONLY through `enricher_lift_gate` (a quality lift gate).

This dispatcher is a PURE PROJECTOR FACADE over those gates. It does NOT compute an adoption verdict of
its own and reuses NO verdict logic from either gate; it only:
  1. ROUTES by declared plane and proves the supplied gate report came from the RIGHT gate for that
     plane (by its `schema`). A reducer request carrying a lift-gate report — or vice versa — is a
     `cross_plane_violation` (the gate-confusion attack), forced to NOT-adopt regardless of what that
     foreign gate concluded.
  2. PROJECTS the gate's own `adoption_eligible` verdict verbatim (never re-derived).
  3. TAGS benefit by AXIS — cost for the reducer, quality for the enricher — and never merges them: a
     reducer adoption can never be justified by a quality-lift field, nor an enricher adoption by a
     token-cost field. The axis-appropriate benefit fields are projected; foreign-axis fields are not.

`adopt` is True iff routing is clean AND the plane's own gate said `adoption_eligible`. Fail-closed:
unknown plane / malformed report -> typed error; unrecognized or cross-plane gate schema -> not-adopt.
The module imports the two gate modules ONLY for their `SCHEMA` constants (single-source binding); it
calls no verdict function from either. Metadata-only output.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, load_json  # noqa: E402
import paired_trial_harness as _b3  # noqa: E402  (SCHEMA constant only — NO verdict logic reused)
import enricher_lift_gate as _lift  # noqa: E402  (SCHEMA constant only — NO verdict logic reused)

SCHEMA = "agent-runtime-adoption-orchestrator"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

# plane -> (the ONLY gate schema that may justify an adoption on that plane, the benefit axis).
PLANE_GATE_SCHEMA = {"reducer": _b3.SCHEMA, "enricher": _lift.SCHEMA}
PLANE_AXIS = {"reducer": "cost", "enricher": "quality"}
KNOWN_GATE_SCHEMAS = frozenset(PLANE_GATE_SCHEMA.values())


class AdoptionError(ValueError):
    """Typed, fail-closed error: never authorize adoption on missing/malformed routing evidence."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _project_benefit(plane: str, report: dict) -> dict:
    """Project ONLY the benefit fields that belong to the plane's axis. Foreign-axis fields are never
    surfaced, so a reducer adoption can never carry a quality-lift benefit (or vice versa)."""
    if plane == "reducer":
        # cost axis lives in B3's nested metrics; project the cost/cache deltas if present.
        metrics = report.get("metrics") or {}
        fields = {k: metrics[k] for k in ("tokens", "cache") if k in metrics}
        return {"axis": "cost", "fields": fields, "present": bool(fields)}
    # enricher quality axis: lift gate exposes these at the top level.
    fields = {k: report[k] for k in ("win_rate_delta_pp", "lift_efficiency") if k in report}
    return {"axis": "quality", "fields": fields, "present": bool(fields)}


def dispatch(plane: str, gate_report: dict) -> dict:
    """Route a plane's adoption request to its gate report and PROJECT the verdict. Fail-closed.

    `gate_report` is the metadata-only report a plane gate already produced (B3 for reducer, lift gate
    for enricher). The dispatcher proves the report's plane and projects its `adoption_eligible`."""
    if plane not in PLANE_GATE_SCHEMA:
        raise AdoptionError("unknown_plane", f"plane must be one of {sorted(PLANE_GATE_SCHEMA)}")
    if not isinstance(gate_report, dict) or "schema" not in gate_report or "adoption_eligible" not in gate_report:
        raise AdoptionError("malformed_report", "gate_report needs a schema + adoption_eligible field")

    expected = PLANE_GATE_SCHEMA[plane]
    observed = gate_report["schema"]
    other_plane_schemas = KNOWN_GATE_SCHEMAS - {expected}

    reasons: list = []
    routing_ok = observed == expected
    cross_plane_violation = observed in other_plane_schemas
    if cross_plane_violation:
        reasons.append("cross_plane_violation")
    elif not routing_ok:
        reasons.append("unrecognized_gate_schema")

    # PROJECT (never recompute) the gate's own verdict; coerce to a strict bool (red-team F5: a truthy
    # non-bool must not pass as adoption).
    raw = gate_report.get("adoption_eligible")
    projected = raw is True
    if not projected:
        reasons.append("gate_not_eligible")

    benefit = _project_benefit(plane, gate_report) if routing_ok else {"axis": PLANE_AXIS[plane],
                                                                        "fields": {}, "present": False}
    adopt = routing_ok and projected
    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "plane": plane,
        "benefit_axis": PLANE_AXIS[plane],
        "expected_gate_schema": expected,
        "observed_gate_schema": observed,
        "routing_ok": routing_ok,
        "cross_plane_violation": cross_plane_violation,
        "projected_adoption_eligible": projected,
        "benefit": benefit,
        "adopt": adopt,
        "reasons": reasons,
        "overall_verdict": "ADOPT" if adopt else "FALLBACK",
    })


def main() -> int:
    ap = argparse.ArgumentParser(description="Two-plane adoption dispatcher (pure-projector facade).")
    ap.add_argument("--plane", choices=("reducer", "enricher"), required=True)
    ap.add_argument("--gate-report", required=True, help="JSON file: a plane gate's metadata report")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    path = Path(args.gate_report)
    report = load_json(path)  # None if missing, {"_error": ...} if unparseable (fail-closed marker)
    if report is None:
        return _emit({"schema": SCHEMA, "error_type": "missing_report",
                      "_error": "gate-report not found", "overall_verdict": "FALLBACK"}, 1)
    if "_error" in report:
        return _emit({"schema": SCHEMA, "error_type": "malformed_report",
                      "_error": report["_error"], "overall_verdict": "FALLBACK"}, 1)
    try:
        result = dispatch(args.plane, report)
    except AdoptionError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message,
                      "overall_verdict": "FALLBACK"}, 1)
    return _emit(result, 0 if result["overall_verdict"] == "ADOPT" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
