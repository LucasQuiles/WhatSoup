#!/usr/bin/env python3
"""Tests for chain_env_fingerprint — proof-chain Slice 4 environment fingerprint. Standalone.

Keystone (consensus §7 'environment fingerprint'): a chain's verdict is reproducible only under the same
code semantics that produced it. This module hashes a CURATED manifest of the spine's semantic constants
(schema/version/domain-tag/purposes/delta-types/ratio/key-sets) plus the interpreter major.minor, so a
chain bound to fingerprint X can be detected as env-DRIFTED when verified under Y != X — and the manifest
diff names WHICH semantic component changed. The fingerprint is re-derived INDEPENDENTLY here (manifest
rebuilt from mpc constants + stdlib hash), not by calling the module's own hasher.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import chain_env_fingerprint as cef  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402


def _independent_manifest():
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


def _independent_fp(manifest):
    return sha256(cef.ENV_DOMAIN_TAG + mpc.canonical_bytes(manifest)).hexdigest()


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except cef.FingerprintError as exc:
        return exc.error_type
    return None


# --- compute ------------------------------------------------------------------

def test_compute_is_deterministic_and_independently_rederivable():
    fp1 = cef.compute_fingerprint()
    fp2 = cef.compute_fingerprint()
    assert fp1["fingerprint"] == fp2["fingerprint"]
    assert len(fp1["fingerprint"]) == 64 and all(c in "0123456789abcdef" for c in fp1["fingerprint"])
    # independent re-derivation
    assert fp1["fingerprint"] == _independent_fp(_independent_manifest())
    assert fp1["manifest"]["schema_version"] == mpc.SCHEMA_VERSION


# --- self-verify --------------------------------------------------------------

def test_self_verify_passes():
    rep = cef.verify_fingerprint(cef.compute_fingerprint())
    assert rep["overall_verdict"] == "PASS" and rep["drifted_components"] == []


def test_bare_hash_match_passes_and_mismatch_drifts():
    current = cef.compute_fingerprint()["fingerprint"]
    assert cef.verify_fingerprint(current)["overall_verdict"] == "PASS"
    bad = cef.verify_fingerprint("00" * 32)
    assert bad["overall_verdict"] == "FAIL" and bad["reason"] == "env_drift"
    assert bad["drifted_components"] == ["unknown_bare_hash"]


# --- drift detection with component naming ------------------------------------

def test_env_drift_names_changed_component():
    fp = cef.compute_fingerprint()
    # simulate a DIFFERENT environment: bump schema_version in the manifest and re-seal its fingerprint
    declared = {"manifest": dict(fp["manifest"]), "fingerprint": None}
    declared["manifest"]["schema_version"] = "9.9"
    declared["fingerprint"] = _independent_fp(declared["manifest"])  # self-consistent, but != current
    rep = cef.verify_fingerprint(declared)
    assert rep["overall_verdict"] == "FAIL" and rep["reason"] == "env_drift"
    assert "schema_version" in rep["drifted_components"]


def test_fingerprint_manifest_inconsistent_detected():
    # manifest matches current but the declared hash does not correspond to it
    fp = cef.compute_fingerprint()
    declared = {"manifest": dict(fp["manifest"]), "fingerprint": "ab" * 32}
    rep = cef.verify_fingerprint(declared)
    assert rep["overall_verdict"] == "FAIL"
    assert rep["reason"] == "fingerprint_manifest_inconsistent" and rep["drifted_components"] == []


# --- malformed ----------------------------------------------------------------

def test_malformed_declared_is_typed():
    assert _err(cef.verify_fingerprint, 123) == "malformed_fingerprint"
    assert _err(cef.verify_fingerprint, {}) == "malformed_fingerprint"            # no fingerprint
    assert _err(cef.verify_fingerprint, {"fingerprint": 5}) == "malformed_fingerprint"
    assert _err(cef.verify_fingerprint, {"manifest": {}, "fingerprint": 5}) == "malformed_fingerprint"


def test_output_is_metadata_only_and_shape():
    fp = cef.compute_fingerprint()
    # the manifest holds only public code constants — no raw text / secrets
    blob = json.dumps(fp)
    assert "alice@" not in blob
    assert fp["proof_class"] == "deterministic_verifier" and fp["schema"].endswith("env-fingerprint")


# --- CLI e2e ------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["chain_env_fingerprint.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = cef.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_emit_and_verify():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        rc, fp = _run_main(["--emit", "--pretty"])
        assert rc == 0 and "fingerprint" in fp
        fpf = dp / "fp.json"
        fpf.write_text(json.dumps(fp), encoding="utf-8")

        rc, rep = _run_main(["--verify", str(fpf)])
        assert rc == 0 and rep["overall_verdict"] == "PASS"

        # drifted fingerprint -> FAIL
        drift = dict(fp)
        drift["manifest"] = dict(fp["manifest"])
        drift["manifest"]["min_compress_ratio"] = 0.5
        drift["fingerprint"] = _independent_fp(drift["manifest"])
        df = dp / "drift.json"
        df.write_text(json.dumps(drift), encoding="utf-8")
        rc, rep = _run_main(["--verify", str(df)])
        assert rc == 1 and "min_compress_ratio" in rep["drifted_components"]

        rc, rep = _run_main(["--verify", str(dp / "no.json")])
        assert rc == 1 and rep["error_type"] == "missing_fingerprint"
        bad = dp / "bad.json"
        bad.write_text("{nope", encoding="utf-8")
        rc, rep = _run_main(["--verify", str(bad)])
        assert rc == 1 and rep["error_type"] == "malformed_fingerprint_json"
        ml = dp / "ml.json"
        ml.write_text(json.dumps({"no_fp": 1}), encoding="utf-8")
        rc, rep = _run_main(["--verify", str(ml)])
        assert rc == 1 and rep["error_type"] == "malformed_fingerprint"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} chain_env_fingerprint tests passed")
