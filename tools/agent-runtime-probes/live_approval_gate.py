#!/usr/bin/env python3
"""live_approval_gate — mechanical fail-closed interlock for CAPE live-activation steps.

The activation ladder (shadow run -> E1 calibration -> Phase 5/6 live delivery) must never run a live,
side-effecting, or irreversible step on a documented-but-unenforced promise. This gate turns the
`artifacts/live_approval.json` requirement from a PROCEDURAL checklist item into a MECHANICAL interlock:
a requested live action is APPROVED only if a present, well-formed, in-scope, unexpired, attributed
approval artifact authorizes exactly that action. Anything else -> BLOCKED. The default is BLOCKED;
every error path fails closed (a missing/malformed/ambiguous artifact never greenlights a live step).

This gate does NOT itself perform any live action — it only decides approved|blocked. It is offline,
deterministic (the caller supplies `now_epoch`; the probe never reads the wall clock), and metadata-only
(the report carries the decision, a reason code, the approved scope, the validity window, the grantor,
and a checksum of the artifact bytes — never secrets or raw payloads).

Approval artifact schema (`artifacts/live_approval.json`):
    {
      "schema": "agent-runtime-live-approval",
      "schema_version": "0.1",
      "scope": ["shadow_run"],                 # list of approved action ids
      "granted_by": "q (owner)",               # non-empty attribution
      "reason": "shadow dry-run, offline fixtures, no side effects",   # non-empty rationale
      "issued_at_epoch": 1750000000,           # int; window start (inclusive)
      "expires_at_epoch": 1750600000,          # int; window end (inclusive)
      "plan_ref": "ROADMAP.md@shadow-step"     # optional; bound against an expected_ref when provided
    }
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from probelib import load_json, redact, sha256_16

SCHEMA = "agent-runtime-live-approval-gate"
SCHEMA_VERSION = "0.1"
ARTIFACT_SCHEMA = "agent-runtime-live-approval"

# Blocked reason codes (a closed vocabulary; every non-approval lands on exactly one).
R_MISSING = "artifact_missing"
R_MALFORMED = "artifact_malformed"
R_SCHEMA = "schema_unrecognized"
R_NO_SCOPE = "missing_scope"
R_OUT_OF_SCOPE = "action_out_of_scope"
R_NO_GRANTOR = "missing_grantor"
R_NO_REASON = "missing_reason"
R_NO_WINDOW = "missing_window"
R_BAD_WINDOW = "invalid_window"
R_NOT_YET = "not_yet_valid"
R_EXPIRED = "expired"
R_REF_MISMATCH = "ref_mismatch"
R_APPROVED = "approved"


def _blocked(requested_action: str, reason: str, **extra: Any) -> dict[str, Any]:
    report = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; emits decision/reason-code/scope/window/grantor/checksum, never secrets",
        "requested_action": requested_action,
        "decision": "blocked",
        "reason": reason,
        "artifact_present": extra.pop("artifact_present", False),
        "artifact_checksum_sha256_16": extra.pop("checksum", None),
        "scope": extra.pop("scope", None),
        "validity_window": extra.pop("validity_window", None),
        "granted_by": extra.pop("granted_by", None),
    }
    report.update(extra)
    return redact(report)


def evaluate(
    artifact_path: Path | None,
    requested_action: str,
    now_epoch: int,
    expected_ref: str | None = None,
) -> dict[str, Any]:
    """Decide whether `requested_action` is authorized by the approval artifact at `artifact_path`
    at `now_epoch`. Returns a metadata-only report; decision is "approved" only when every check
    passes, else "blocked" with a reason code. Fail-closed: any absence/malformation -> blocked."""
    if artifact_path is None or not Path(artifact_path).is_file():
        return _blocked(requested_action, R_MISSING)

    raw = Path(artifact_path).read_bytes()
    checksum = sha256_16(raw.decode("utf-8", errors="replace"))
    data = load_json(Path(artifact_path))
    # probelib.load_json returns None (absent) or a {"_error": ...} marker on parse failure; both -> malformed.
    if data is None or not isinstance(data, dict) or "_error" in data:
        return _blocked(requested_action, R_MALFORMED, artifact_present=True, checksum=checksum)

    if data.get("schema") != ARTIFACT_SCHEMA:
        return _blocked(requested_action, R_SCHEMA, artifact_present=True, checksum=checksum)

    scope = data.get("scope")
    if not isinstance(scope, list) or not scope:
        return _blocked(requested_action, R_NO_SCOPE, artifact_present=True, checksum=checksum)
    if requested_action not in scope:
        return _blocked(requested_action, R_OUT_OF_SCOPE, artifact_present=True, checksum=checksum, scope=scope)

    granted_by = data.get("granted_by")
    if not isinstance(granted_by, str) or not granted_by.strip():
        return _blocked(requested_action, R_NO_GRANTOR, artifact_present=True, checksum=checksum, scope=scope)

    reason = data.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        return _blocked(requested_action, R_NO_REASON, artifact_present=True, checksum=checksum, scope=scope)

    issued = data.get("issued_at_epoch")
    expires = data.get("expires_at_epoch")
    # bool is an int subclass; reject it explicitly so a True/False window can't masquerade as a time.
    if not _is_epoch(issued) or not _is_epoch(expires):
        return _blocked(requested_action, R_NO_WINDOW, artifact_present=True, checksum=checksum,
                        scope=scope, granted_by=granted_by)
    window = {"issued_at_epoch": issued, "expires_at_epoch": expires, "now_epoch": now_epoch}
    # A live approval must span positive duration: issued == expires (a zero-width, single-instant
    # window) is pathological for an interlock and is rejected (stricter = safer / more fail-closed).
    if issued >= expires:
        return _blocked(requested_action, R_BAD_WINDOW, artifact_present=True, checksum=checksum,
                        scope=scope, granted_by=granted_by, validity_window=window)
    if now_epoch < issued:
        return _blocked(requested_action, R_NOT_YET, artifact_present=True, checksum=checksum,
                        scope=scope, granted_by=granted_by, validity_window=window)
    if now_epoch > expires:
        return _blocked(requested_action, R_EXPIRED, artifact_present=True, checksum=checksum,
                        scope=scope, granted_by=granted_by, validity_window=window)

    if expected_ref is not None and data.get("plan_ref") != expected_ref:
        return _blocked(requested_action, R_REF_MISMATCH, artifact_present=True, checksum=checksum,
                        scope=scope, granted_by=granted_by, validity_window=window)

    return redact({
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; emits decision/reason-code/scope/window/grantor/checksum, never secrets",
        "requested_action": requested_action,
        "decision": "approved",
        "reason": R_APPROVED,
        "artifact_present": True,
        "artifact_checksum_sha256_16": checksum,
        "scope": scope,
        "validity_window": window,
        "granted_by": granted_by,
    })


def _is_epoch(value: Any) -> bool:
    """True only for a real integer epoch (reject bool — it is an int subclass — and non-ints)."""
    return isinstance(value, int) and not isinstance(value, bool)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--artifact", type=Path, default=None,
                    help="path to live_approval.json (absent/missing -> blocked).")
    ap.add_argument("--action", required=True, help="the live action id being requested (e.g. shadow_run).")
    ap.add_argument("--now-epoch", type=int, required=True,
                    help="caller-supplied current epoch seconds (the probe never reads the wall clock).")
    ap.add_argument("--expected-ref", default=None,
                    help="if set, the artifact's plan_ref must match (anti-stale-reuse).")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args(argv)
    report = evaluate(args.artifact, args.action, args.now_epoch, args.expected_ref)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    # exit 0 only on approval; blocked -> 2 (fail-closed, scriptable as a gate).
    return 0 if report["decision"] == "approved" else 2


if __name__ == "__main__":
    sys.exit(main())
