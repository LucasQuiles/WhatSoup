#!/usr/bin/env python3
"""chain_env_fingerprint — proof-chain Slice 4 environment fingerprint.

Closes the consensus §7 lifecycle field "environment fingerprint". A proof chain's verdict is reproducible
only under the SAME code semantics that produced it: if the spine changes a purpose, a delta rule, the
compression-ratio floor, a domain tag, or its schema version, a chain proven under the old semantics may
not reproduce under the new ones. This module computes a deterministic fingerprint over a CURATED manifest
of the spine's semantic constants (plus the interpreter major.minor) so a chain can be bound to the
environment that produced it, and a verifier can detect ENV DRIFT — and name WHICH semantic component
changed.

The manifest is a curated list of semantic constants, NOT a hash of the source file: cosmetic edits
(comments, whitespace, refactors) leave the fingerprint stable, while a genuine semantic change (new
purpose, changed ratio floor, new schema version, altered purpose->delta rules) flips it. Scope is the
SPINE (`mutation_proof_chain`), which governs how records are produced and verified; the detached tiers
(authenticity / lifecycle / adoption / lineage / outcome) carry their own schema_version on their own
outputs.

proof_class `deterministic_verifier`; metadata-only (the manifest holds only public code constants — no
raw text, no secrets). Imports `mutation_proof_chain` only (NOT a plane verdict gate), leaving the
two_plane_separation + attestation purity guards unaffected.
"""
from __future__ import annotations

import argparse
import hmac
import json
import sys
from hashlib import sha256
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402

SCHEMA = "agent-runtime-chain-env-fingerprint"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

# distinct from every other CAPE domain tag so a fingerprint can never collide with a record hash,
# genesis anchor, keyed signature, seal, or effective-chain commitment.
ENV_DOMAIN_TAG = b"CAPE-MPC-ENV-v0\x00"


class FingerprintError(ValueError):
    """Typed, fail-closed error — never green a verification on a malformed fingerprint declaration."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _manifest() -> dict:
    """The curated semantic manifest of the proof-chain spine + interpreter major.minor. JSON-safe."""
    return {
        "schema": mpc.SCHEMA,
        "schema_version": mpc.SCHEMA_VERSION,
        "domain_tag": mpc.DOMAIN_TAG.hex(),
        "purposes": list(mpc.PURPOSES),
        "proof_classes": list(mpc.PROOF_CLASSES),
        "directions": list(mpc.DIRECTIONS),
        "delta_types": list(mpc.DELTA_TYPES),
        "min_compress_ratio": mpc.MIN_COMPRESS_RATIO,
        "purpose_delta_ok": {k: sorted(v) for k, v in mpc._PURPOSE_DELTA_OK.items()},
        "record_keys": sorted(mpc._RECORD_KEYS),
        "benefit_keys": sorted(mpc._BENEFIT_KEYS),
        "python": f"{sys.version_info.major}.{sys.version_info.minor}",
    }


def _fingerprint_of(manifest: dict) -> str:
    return sha256(ENV_DOMAIN_TAG + mpc.canonical_bytes(manifest)).hexdigest()


def compute_fingerprint() -> dict:
    """Compute the current environment fingerprint (deterministic). Carries the full manifest so a later
    verifier can diff and name drifted components."""
    manifest = _manifest()
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "env_domain": ENV_DOMAIN_TAG.decode("ascii").rstrip("\x00"),
        "fingerprint": _fingerprint_of(manifest),
        "manifest": manifest,
    }


def _drifted_components(declared_manifest: dict, current_manifest: dict) -> list:
    """Names of manifest keys whose values differ (or are present in only one)."""
    keys = sorted(set(declared_manifest) | set(current_manifest))
    return [k for k in keys if declared_manifest.get(k) != current_manifest.get(k)]


def verify_fingerprint(declared, current: dict | None = None) -> dict:
    """Verify a declared fingerprint against the current environment. Fail-closed; metadata-only.

    `declared` may be a full fingerprint dict ({fingerprint, manifest}) or a bare fingerprint hash string.
    PASS iff the declared fingerprint matches the current one; on mismatch the report names drifted
    components (when a declared manifest is available) and distinguishes genuine env drift from a declared
    fingerprint that is inconsistent with its own manifest."""
    current = current or compute_fingerprint()

    if isinstance(declared, str):
        declared_fp, declared_manifest = declared, None
    elif isinstance(declared, dict):
        declared_fp = declared.get("fingerprint")
        declared_manifest = declared.get("manifest")
        if not isinstance(declared_fp, str) or not declared_fp:
            raise FingerprintError("malformed_fingerprint", "declared.fingerprint must be a non-empty string")
        if declared_manifest is not None and not isinstance(declared_manifest, dict):
            raise FingerprintError("malformed_fingerprint", "declared.manifest must be a dict when present")
    else:
        raise FingerprintError("malformed_fingerprint", "declared must be a fingerprint dict or hash string")

    matches = hmac.compare_digest(declared_fp, current["fingerprint"])
    if matches:
        return _report("PASS", None, [], current)

    # mismatch: classify it.
    if declared_manifest is None:
        return _report("FAIL", "env_drift", ["unknown_bare_hash"], current)
    drifted = _drifted_components(declared_manifest, current["manifest"])
    if not drifted:
        # the manifests agree, but the declared hash does not correspond to its manifest.
        return _report("FAIL", "fingerprint_manifest_inconsistent", [], current)
    return _report("FAIL", "env_drift", drifted, current)


def _report(verdict: str, reason: str | None, drifted: list, current: dict) -> dict:
    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "deterministic_verifier",
        "current_fingerprint": current["fingerprint"],
        "reason": reason,
        "drifted_components": drifted,
        "recommended_action": "reproducible_env" if verdict == "PASS" else "reject_env_mismatch",
        "overall_verdict": verdict,
    })


def main() -> int:
    ap = argparse.ArgumentParser(description="Proof-chain environment fingerprint: bind a chain to the "
                                             "spine semantics that produced it; detect env drift.")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--emit", action="store_true", help="print the current environment fingerprint")
    g.add_argument("--verify", metavar="FP_JSON", help="verify a declared fingerprint file against current")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    if args.emit:
        return _emit(compute_fingerprint(), 0)

    path = Path(args.verify)
    if not path.exists():
        return _emit({"schema": SCHEMA, "error_type": "missing_fingerprint",
                      "_error": "fingerprint file not found", "overall_verdict": "FAIL"}, 1)
    try:
        declared = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return _emit({"schema": SCHEMA, "error_type": "malformed_fingerprint_json",
                      "_error": f"JSONDecodeError: {exc}", "overall_verdict": "FAIL"}, 1)
    try:
        report = verify_fingerprint(declared)
    except FingerprintError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message,
                      "overall_verdict": "FAIL"}, 1)
    return _emit(report, 0 if report["overall_verdict"] == "PASS" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
