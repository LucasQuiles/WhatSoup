#!/usr/bin/env python3
"""Tests for chain_lifecycle_gate — proof-chain Slice 4 lifecycle gate. Standalone.

Keystone (closes red-team F2 'chain truncation — any prefix is a valid chain'): a TRUNCATED chain still
passes the spine integrity verifier (a prefix is internally consistent), but verifying it against the
ORIGINAL chain's terminal seal must FAIL — the seal commits to length + terminal + every record hash, so
dropping (or appending, or swapping) records is detected. The expected seal commitment is re-derived
INDEPENDENTLY here with stdlib sha256 + mpc.canonical_bytes, never by calling the module's own sealer
(no f(x)==f(x)). Also covers the max-chain DoS cap and no-op/expanding lifecycle accounting.
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

import chain_lifecycle_gate as clg  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402
from probelib import sha256_16  # noqa: E402

START = "user alice@example.com asked about the deadline and the refund policy in detail"
T_MASK = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline and the refund policy in detail"
T_COMPRESS = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline"


def _attest(cid, idx, prev_hash, prev_text, new_text, purpose):
    return mpc.attest_step(
        chain_id=cid, step_index=idx, prev_record_hash=prev_hash, prev_text=prev_text,
        new_text=new_text, declared_purpose=purpose,
        benefit=mpc.Benefit(0.2, "token_fraction", "decrease", "measured", "ev:x"),
        determinism_ok=True,
    )


def _build(cid, transforms):
    """transforms: list of (purpose, new_text). Start text is START; builds a continuous chain."""
    prev_text, prev_hash = START, mpc.genesis_anchor(cid)
    recs = []
    for i, (purpose, new_text) in enumerate(transforms):
        a = _attest(cid, i, prev_hash, prev_text, new_text, purpose)
        recs.append(a.as_dict())
        prev_text, prev_hash = new_text, a.record_hash
    return recs


def _mask_compress(cid="lifecycle-fixture"):
    return _build(cid, [("mask", T_MASK), ("compress", T_COMPRESS)])


def _independent_commitment(records):
    atts = [mpc._record_from_dict(r) for r in records]
    body = {"chain_id": atts[0].chain_id, "step_count": len(atts),
            "record_hashes": [a.record_hash for a in atts]}
    return sha256(clg.SEAL_DOMAIN_TAG + mpc.canonical_bytes(body)).hexdigest()


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except clg.LifecycleError as exc:
        return exc.error_type
    return None


# --- the seal -----------------------------------------------------------------

def test_seal_commits_to_length_terminal_and_records():
    recs = _mask_compress()
    seal = clg.seal_chain(recs)
    assert seal["step_count"] == 2
    assert seal["commitment"] == _independent_commitment(recs)  # independent re-derivation
    assert seal["terminal_record_hash_16"] == sha256_16(mpc._record_from_dict(recs[-1]).record_hash)
    assert seal["chain_id_16"] == sha256_16("lifecycle-fixture")


def test_seal_empty_chain_fails_closed():
    assert _err(clg.seal_chain, []) == "empty_chain"


# --- F2: truncation / extension / swap detection against the seal -------------

def test_full_chain_with_matching_seal_passes():
    recs = _mask_compress()
    seal = clg.seal_chain(recs)
    rep = clg.verify_lifecycle(recs, seal)
    assert rep["overall_verdict"] == "PASS"
    assert rep["seal_status"] == "verified"
    assert rep["base_verdict"] == "PASS"


def test_truncation_is_detected_against_original_seal():
    recs = _mask_compress()
    seal = clg.seal_chain(recs)
    truncated = recs[:1]  # drop the terminal record — a valid PREFIX (spine still passes)
    assert mpc.verify_chain(truncated)["overall_verdict"] == "PASS"  # F2: prefix is self-consistent
    rep = clg.verify_lifecycle(truncated, seal)
    assert rep["overall_verdict"] == "FAIL"
    assert rep["seal_status"] == "mismatch"
    assert "step_count_mismatch" in rep["seal_reasons"]
    assert "commitment_mismatch" in rep["seal_reasons"]


def test_extension_is_detected_against_original_seal():
    cid = "lifecycle-extend"
    recs = _mask_compress(cid)
    seal = clg.seal_chain(recs)
    # append a valid third step; the extended chain is internally consistent but longer than the seal
    extended = _build(cid, [("mask", T_MASK), ("compress", T_COMPRESS),
                            ("inject", T_COMPRESS + " [ctx]")])
    assert mpc.verify_chain(extended)["overall_verdict"] == "PASS"
    rep = clg.verify_lifecycle(extended, seal)
    assert rep["overall_verdict"] == "FAIL" and rep["seal_status"] == "mismatch"
    assert "step_count_mismatch" in rep["seal_reasons"]


def test_seal_mismatch_on_different_chain_same_length():
    seal = clg.seal_chain(_mask_compress("chain-A"))
    other = _mask_compress("chain-B")  # same length, valid, different chain_id+hashes
    rep = clg.verify_lifecycle(other, seal)
    assert rep["overall_verdict"] == "FAIL"
    assert "commitment_mismatch" in rep["seal_reasons"]


def test_malformed_seal_fails_closed():
    recs = _mask_compress()
    assert clg.verify_lifecycle(recs, {"step_count": 2})["seal_status"] == "malformed_seal"
    assert clg.verify_lifecycle(recs, {"commitment": 123, "step_count": 2,
                                       "terminal_record_hash_16": "x"})["overall_verdict"] == "FAIL"


# --- max-chain DoS cap --------------------------------------------------------

def test_dos_cap_rejects_overlong_chain():
    recs = _build("dos", [("mask", T_MASK), ("compress", T_COMPRESS),
                          ("canonicalize", T_COMPRESS)])
    rep = clg.verify_lifecycle(recs, max_steps=2)
    assert rep["overall_verdict"] == "FAIL"
    assert rep["within_dos_cap"] is False
    assert "chain_too_long" in rep["lifecycle_reasons"]
    # at the cap it passes
    assert clg.verify_lifecycle(recs, max_steps=3)["within_dos_cap"] is True


# --- no-op / expanding accounting --------------------------------------------

def test_noop_loop_rejected_but_bounded_noops_pass():
    # mask then two consecutive identity (canonicalize no-op) steps
    recs = _build("noop", [("mask", T_MASK), ("canonicalize", T_MASK), ("canonicalize", T_MASK)])
    loop = clg.verify_lifecycle(recs, max_consecutive_noops=1)
    assert loop["overall_verdict"] == "FAIL" and "noop_loop" in loop["lifecycle_reasons"]
    assert loop["noop_count"] == 2
    ok = clg.verify_lifecycle(recs, max_consecutive_noops=2)
    assert ok["overall_verdict"] == "PASS" and ok["max_consecutive_noops_observed"] == 2


def test_expanding_and_reducing_counts():
    recs = _build("counts", [("mask", T_MASK), ("compress", T_COMPRESS),
                             ("inject", T_COMPRESS + " [ctx note appended here]")])
    rep = clg.verify_lifecycle(recs)
    assert rep["reducing_count"] == 1   # the compress deletion
    assert rep["expanding_count"] == 1  # the inject suffix
    assert rep["noop_count"] == 0


# --- base-chain + fail-closed -------------------------------------------------

def test_base_chain_invalid_fails_closed():
    recs = _mask_compress()
    recs[1]["record_hash"] = "deadbeef" * 8  # corrupt the terminal record hash
    rep = clg.verify_lifecycle(recs)
    assert rep["overall_verdict"] == "FAIL"
    assert rep["base_verdict"] == "FAIL"
    assert "base_chain_invalid" in rep["lifecycle_reasons"]


def test_empty_chain_fails():
    rep = clg.verify_lifecycle([])
    assert rep["overall_verdict"] == "FAIL" and rep["error_type"] == "empty_chain"


def test_unsealed_still_runs_lifecycle_checks():
    recs = _build("unsealed", [("mask", T_MASK), ("compress", T_COMPRESS),
                               ("canonicalize", T_COMPRESS)])
    rep = clg.verify_lifecycle(recs, max_steps=2)  # no seal
    assert rep["seal_status"] == "unsealed"
    assert rep["overall_verdict"] == "FAIL" and "chain_too_long" in rep["lifecycle_reasons"]


def test_output_is_metadata_only():
    recs = _mask_compress()
    seal = clg.seal_chain(recs)
    blob = json.dumps([clg.verify_lifecycle(recs, seal), seal])
    assert "alice@example.com" not in blob and "refund policy" not in blob


# --- CLI e2e ------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["chain_lifecycle_gate.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = clg.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_seal_verify_and_truncation():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        recs = _mask_compress("cli-chain")
        chain_f = dp / "chain.json"
        chain_f.write_text(json.dumps(recs), encoding="utf-8")

        # --seal mode emits a seal
        rc, seal = _run_main(["--chain", str(chain_f), "--seal"])
        assert rc == 0 and seal["step_count"] == 2 and "commitment" in seal
        seal_f = dp / "seal.json"
        seal_f.write_text(json.dumps(seal), encoding="utf-8")

        # verify full chain against the seal -> PASS
        rc, rep = _run_main(["--chain", str(chain_f), "--verify-seal", str(seal_f), "--pretty"])
        assert rc == 0 and rep["overall_verdict"] == "PASS"

        # verify a truncated chain against the original seal -> FAIL (F2)
        trunc_f = dp / "trunc.json"
        trunc_f.write_text(json.dumps(recs[:1]), encoding="utf-8")
        rc, rep = _run_main(["--chain", str(trunc_f), "--verify-seal", str(seal_f)])
        assert rc == 1 and rep["seal_status"] == "mismatch"

        # missing + malformed files
        rc, rep = _run_main(["--chain", str(dp / "nope.json")])
        assert rc == 1 and rep["error_type"] == "missing_chain"
        bad = dp / "bad.json"
        bad.write_text("{nope", encoding="utf-8")
        rc, rep = _run_main(["--chain", str(bad)])
        assert rc == 1 and rep["error_type"] == "malformed_chain"


def test_main_seal_error_branches():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        recs = _mask_compress("cli-err")
        chain_f = dp / "chain.json"
        chain_f.write_text(json.dumps(recs), encoding="utf-8")

        # --verify-seal pointing at a nonexistent seal file -> missing_seal
        rc, rep = _run_main(["--chain", str(chain_f), "--verify-seal", str(dp / "nope.json")])
        assert rc == 1 and rep["error_type"] == "missing_seal"

        # --verify-seal pointing at malformed JSON -> malformed_seal
        bad_seal = dp / "bad-seal.json"
        bad_seal.write_text("{not json", encoding="utf-8")
        rc, rep = _run_main(["--chain", str(chain_f), "--verify-seal", str(bad_seal)])
        assert rc == 1 and rep["error_type"] == "malformed_seal"

        # --seal on an empty chain -> LifecycleError(empty_chain) caught in main
        empty_f = dp / "empty.json"
        empty_f.write_text("[]", encoding="utf-8")
        rc, rep = _run_main(["--chain", str(empty_f), "--seal"])
        assert rc == 1 and rep["error_type"] == "empty_chain"


def test_accepts_attestation_objects_directly():
    # seal_chain / verify_lifecycle accept Attestation instances, not only dicts
    cid = "obj-chain"
    g = mpc.genesis_anchor(cid)
    a0 = _attest(cid, 0, g, START, T_MASK, "mask")
    atts = [a0]
    seal = clg.seal_chain(atts)
    assert clg.verify_lifecycle(atts, seal)["overall_verdict"] == "PASS"


def test_lifecycle_recommended_action_mirrors_verdict():
    # recommended_action is "accept" iff overall == "PASS" (else "reject"); flipping the == inverts
    # the label on both a sealed-and-matching chain and a truncated one.
    recs = _mask_compress()
    seal = clg.seal_chain(recs)
    ok = clg.verify_lifecycle(recs, seal)
    assert ok["overall_verdict"] == "PASS" and ok["recommended_action"] == "accept"
    bad = clg.verify_lifecycle(recs[:1], seal)  # truncation -> seal mismatch -> FAIL
    assert bad["overall_verdict"] == "FAIL" and bad["recommended_action"] == "reject"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} chain_lifecycle_gate tests passed")
