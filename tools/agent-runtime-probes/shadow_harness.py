#!/usr/bin/env python3
"""shadow_harness — Phase 4 bead 4.2: provably side-effect-free shadow ("log-would-do") mode.

The boundary object that makes a dry-run safe. Any code run in shadow mode must route every side-effecting
operation through a `ShadowBoundary`; in shadow mode each operation (egress / write / inject /
provider_call / external_call) RECORDS the attempt (metadata-only) and then RAISES `SideEffectError`. The
record is written BEFORE the raise, so even a SWALLOWED SideEffectError leaves a trace — a pipeline that
tries a side effect and ignores the error still fails the shadow run.

`run_shadow(fn)` runs `fn(boundary)` and returns a metadata-only verdict:
  - no attempts            -> PASS  / no_side_effects     (a clean compute-only pipeline)
  - >=1 attempt recorded   -> FAIL  / side_effect_attempted (lists the attempted action types)
  - the pipeline crashes   -> FAIL  / run_error            (fail-closed: a crashing shadow run is not clean)

HONEST SCOPE: this is a BOUNDARY-OBJECT contract, not a syscall sandbox (sandboxing is a documented
non-goal). It proves no side effect occurs THROUGH the boundary; code that bypasses the boundary to touch
raw I/O is out of scope (the estate's policy is that side-effecting ops MUST go through the boundary, and
the redaction auditor + guards police the rest). proof_class `deterministic_verifier`; metadata-only
(action types + summary HASHES, never raw targets/payloads).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact, sha256_16  # noqa: E402

SCHEMA = "agent-runtime-shadow-harness"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

SIDE_EFFECT_TYPES = ("egress", "write", "inject", "provider_call", "external_call")


class SideEffectError(Exception):
    """Raised when shadowed code attempts a real side effect. Carries the action type."""

    def __init__(self, action_type: str, message: str) -> None:
        super().__init__(message)
        self.action_type = action_type


class ShadowBoundary:
    """Side-effecting operations are RECORDED (metadata-only) then BLOCKED with SideEffectError."""

    def __init__(self) -> None:
        self.attempts: list = []

    def _block(self, action_type: str, summary: str):
        # record BEFORE raising so a swallowed error still leaves a trace; summary is HASHED (no raw target)
        self.attempts.append({"action_type": action_type, "summary_sha256_16": sha256_16(str(summary))})
        raise SideEffectError(action_type, f"shadow mode blocks side effect: {action_type}")

    def egress(self, target, payload=""):
        self._block("egress", f"{target}")

    def write(self, path, content=""):
        self._block("write", f"{path}")

    def inject(self, target, context=""):
        self._block("inject", f"{target}")

    def provider_call(self, model, request=""):
        self._block("provider_call", f"{model}")

    def external_call(self, argv):
        summary = " ".join(map(str, argv)) if isinstance(argv, (list, tuple)) else str(argv)
        self._block("external_call", summary)


def run_shadow(fn) -> dict:
    """Run `fn(boundary)` in shadow mode and return a metadata-only side-effect verdict. Fail-closed."""
    boundary = ShadowBoundary()
    status, error_type, propagated = None, None, None
    try:
        fn(boundary)
    except SideEffectError as exc:
        # NOT a silent swallow: the attempt is already recorded in boundary.attempts and drives the FAIL
        # verdict below; we keep a typed marker of which action propagated.
        propagated = exc.action_type
    except Exception as exc:  # a crashing shadow run is not "clean" — fail closed with a typed marker
        status, error_type = "run_error", type(exc).__name__

    attempts = boundary.attempts
    if status == "run_error":
        verdict = "FAIL"
    elif attempts:
        status, verdict = "side_effect_attempted", "FAIL"
    else:
        status, verdict = "no_side_effects", "PASS"

    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "status": status,
        "attempt_count": len(attempts),
        "attempted_action_types": sorted({a["action_type"] for a in attempts}),
        "attempts": attempts,
        "propagated_action_type": propagated,
        "error_type": error_type,
        "overall_verdict": verdict,
    })


def _selftest() -> dict:
    """Prove the harness: a clean run PASSes and a violating run is BLOCKED."""
    clean = run_shadow(lambda b: {"computed": 42})
    violating = run_shadow(lambda b: b.egress("https://example.invalid", "payload"))
    ok = clean["overall_verdict"] == "PASS" and violating["overall_verdict"] == "FAIL"
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "clean_run": clean,
        "violating_run": violating,
        "overall_verdict": "PASS" if ok else "FAIL",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Shadow harness selftest: prove shadow mode blocks side effects.")
    ap.add_argument("--selftest", action="store_true", required=True, help="run the harness selftest")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()
    report = _selftest()
    json.dump(redact(report), sys.stdout, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0 if report["overall_verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
