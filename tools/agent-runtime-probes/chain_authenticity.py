#!/usr/bin/env python3
"""chain_authenticity — keyed-MAC producer authenticity for the CAPE proof chain (Slice 2).

WHY (red-team F1/F3): the attestation spine (`mutation_proof_chain`) proves INTEGRITY and CONSISTENCY
— that a chain has not been edited and is internally continuous. It does NOT prove AUTHENTICITY: the
genesis anchor is `sha256(DOMAIN_TAG + "GENESIS:" + chain_id)`, which is PUBLIC, so anyone can mint a
fully self-consistent chain under any chain_id and `verify_chain` will pass it. "Tamper-evident for a
given chain" is therefore the honest scope of the spine alone; "forgery-resistant" is not.

This module closes that gap with a DETACHED keyed MAC. A producer holding a secret key signs the whole
ordered chain (HMAC-SHA256 over a domain-separated canonical message binding chain_id, record count,
and every record hash in order). Only a key-holder can produce a signature that verifies; any edit,
truncation, extension, or reorder changes the signed message and breaks the MAC. The signature is
DETACHED — it lives in its own object, never inside the Attestation records — so the spine's closed
field set, `verify_chain`, and the attestation purity guard are all untouched (this layer is allowed
to carry verdicts and import hmac precisely because it is NOT part of the plane-agnostic spine).

HONEST SCOPE: this proves "signed by a holder of key K over exactly this chain". It is only as strong
as the secrecy and entropy of K and the producer's key management (out of scope here — caller-supplied
key). No key-derived material is written into the artifact (no key_id hash), so a tampered chain and a
wrong key are INDISTINGUISHABLE to a verifier — deliberate: it denies a forgery/key-guessing oracle.
An optional non-secret `key_label` is carried for rotation hygiene only. Comparison is constant-time.

Fail-closed: an empty/unverified chain is never signed; an empty key is rejected; a malformed signature
object is a typed error; verification defaults to NOT-authentic on any failure. Metadata-only output.
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

SCHEMA = "agent-runtime-chain-authenticity"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

ALG = "HMAC-SHA256"
# Domain separation: a CAPE chain signature can never be confused with any other HMAC over the same
# bytes (record hashes, genesis anchors, etc.). Distinct from mutation_proof_chain.DOMAIN_TAG.
SIG_DOMAIN_TAG = b"CAPE-MPC-SIG-v0\x00"


class AuthenticityError(ValueError):
    """Typed, fail-closed error: never sign/verify optimistically on missing/malformed evidence."""

    def __init__(self, error_type: str, message: str) -> None:
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def _key_bytes(key) -> bytes:
    """Coerce a caller-supplied key to non-empty bytes, else fail closed (no keyless signing)."""
    if isinstance(key, str):
        key = key.encode("utf-8")
    if not isinstance(key, (bytes, bytearray)) or len(key) == 0:
        raise AuthenticityError("bad_key", "key must be a non-empty str or bytes")
    return bytes(key)


def _ordered_atts(records: list):
    """Normalize records to Attestation objects (reusing the spine's loader) and verify integrity.

    Signing or verifying an UNVERIFIED chain is refused — authenticity must never be lent to a chain
    that is not even self-consistent (that would let a MAC paper over a broken back-pointer)."""
    if not isinstance(records, list) or not records:
        raise AuthenticityError("empty_chain", "records must be a non-empty list")
    report = mpc.verify_chain(records)
    atts = [r if isinstance(r, mpc.Attestation) else mpc._record_from_dict(r) for r in records]
    return atts, report


def _signed_message(atts: list) -> bytes:
    """The exact bytes the MAC is taken over: domain tag + canonical (chain_id, count, ordered hashes).

    Binding EVERY record hash in order (not just the terminal hash) makes truncation, extension, and
    reorder all detectable independently of the hash-chain's own continuity checks."""
    body = {
        "schema": SCHEMA,
        "alg": ALG,
        "chain_id": atts[0].chain_id,
        "record_count": len(atts),
        "record_hashes": [a.record_hash for a in atts],
    }
    return SIG_DOMAIN_TAG + mpc.canonical_bytes(body)


def sign_chain(records: list, key, signer_label: str = "") -> dict:
    """Produce a DETACHED authenticity signature over a verified chain. Fail-closed.

    Refuses to sign an empty/unverified chain or an empty key. `signer_label` is a NON-SECRET rotation
    hint only (never derived from the key). The returned object carries NO key material.
    (Field is `signer_label`, not `key_label`, to avoid the shared redactor blanking it as a secret.)"""
    kb = _key_bytes(key)
    atts, report = _ordered_atts(records)
    if report["overall_verdict"] != "PASS":
        raise AuthenticityError("unverified_chain", "refusing to sign a chain that does not verify")
    signature = hmac.new(kb, _signed_message(atts), sha256).hexdigest()
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "alg": ALG, "sig_domain": "CAPE-MPC-SIG-v0",
        "chain_id_16": sha256_16(atts[0].chain_id),
        "record_count": len(atts),
        "terminal_record_hash_16": sha256_16(atts[-1].record_hash),
        "signer_label": signer_label,
        "signature": signature,
    }


_SIG_KEYS = frozenset({
    "schema", "schema_version", "redaction", "alg", "sig_domain", "chain_id_16",
    "record_count", "terminal_record_hash_16", "signer_label", "signature",
})


def verify_signed_chain(records: list, signature_obj: dict, key) -> dict:
    """Verify chain integrity AND producer authenticity. Metadata-only, fail-closed.

    `authentic` is True only if ALL hold: the chain verifies, the recomputed MAC matches the supplied
    signature (constant-time), and the signature's bound metadata (alg, record_count, chain_id) agrees
    with the chain. A tampered chain and a wrong key both yield authentic=False with no oracle as to
    which (deliberate)."""
    if not isinstance(signature_obj, dict):
        raise AuthenticityError("malformed_signature", "signature_obj must be a dict")
    missing = _SIG_KEYS - set(signature_obj)
    if missing:
        raise AuthenticityError("malformed_signature", f"signature missing fields: {sorted(missing)}")
    kb = _key_bytes(key)
    atts, chain_report = _ordered_atts(records)
    chain_ok = chain_report["overall_verdict"] == "PASS"

    reasons: list = []
    if not chain_ok:
        reasons.append("unverified_chain")
    if signature_obj["alg"] != ALG:
        reasons.append("alg_mismatch")
    if signature_obj["record_count"] != len(atts):
        reasons.append("record_count_mismatch")
    if signature_obj["chain_id_16"] != sha256_16(atts[0].chain_id):
        reasons.append("chain_id_mismatch")

    expected = hmac.new(kb, _signed_message(atts), sha256).hexdigest()
    sig_match = hmac.compare_digest(expected, str(signature_obj["signature"]))
    if not sig_match:
        reasons.append("signature_mismatch")

    # authentic requires chain_ok AND a matching MAC AND agreement of the signature's bound metadata.
    # (A metadata mismatch would already have broken sig_match, since the same fields feed the MAC
    # message; the explicit checks make the failure diagnosable rather than a bare signature_mismatch.)
    meta_ok = not ({"alg_mismatch", "record_count_mismatch", "chain_id_mismatch"} & set(reasons))
    authentic = chain_ok and sig_match and meta_ok
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "chain_verdict": chain_report["overall_verdict"],
        "chain_id_16": sha256_16(atts[0].chain_id),
        "record_count": len(atts),
        "sig_match": sig_match,
        "mac_verified": authentic,  # the producer-authenticity verdict (named to dodge the redactor)
        "reasons": reasons,
        "overall_verdict": "PASS" if authentic else "FAIL",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Keyed-MAC producer authenticity for the CAPE proof chain.")
    ap.add_argument("--chain", required=True, help="JSON file: a list of attestation record dicts")
    ap.add_argument("--mode", choices=("sign", "verify"), required=True)
    ap.add_argument("--key-file", required=True, help="file whose RAW bytes are the producer secret key")
    ap.add_argument("--signature", help="signature JSON file (required for --mode verify)")
    ap.add_argument("--signer-label", default="", help="non-secret rotation hint stamped into the signature")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    cp = Path(args.chain)
    kp = Path(args.key_file)
    if not cp.exists() or not kp.exists():
        return _emit({"schema": SCHEMA, "error_type": "missing_input",
                      "_error": f"chain/key not found: chain_sha={sha256_16(str(cp))}",
                      "overall_verdict": "FAIL"}, 1)
    try:
        records = json.loads(cp.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return _emit({"schema": SCHEMA, "error_type": "malformed_chain",
                      "_error": f"JSONDecodeError: {exc}", "overall_verdict": "FAIL"}, 1)
    key = kp.read_bytes()

    try:
        if args.mode == "sign":
            return _emit(sign_chain(records, key, signer_label=args.signer_label), 0)
        if not args.signature or not Path(args.signature).exists():
            return _emit({"schema": SCHEMA, "error_type": "missing_signature",
                          "_error": "--signature file required for verify", "overall_verdict": "FAIL"}, 1)
        sig = json.loads(Path(args.signature).read_text(encoding="utf-8"))
        report = verify_signed_chain(records, sig, key)
        return _emit(report, 0 if report["overall_verdict"] == "PASS" else 1)
    except AuthenticityError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message,
                      "overall_verdict": "FAIL"}, 1)


if __name__ == "__main__":
    raise SystemExit(main())
