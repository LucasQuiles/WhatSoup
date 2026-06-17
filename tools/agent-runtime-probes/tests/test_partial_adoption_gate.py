#!/usr/bin/env python3
"""Tests for partial_adoption_gate — proof-chain Slice 4 partial adoption / effective chain. Standalone.

Keystone (consensus §7 'partial adoption: per-step adopt|skip|replace_with_prior + effective_chain_hash'):
a proof chain proves the LINEAR application of ALL steps, but at runtime some steps fall back. This gate
folds per-step decisions {adopt, skip, revert} into the EFFECTIVE applied text and a tamper-evident
effective_chain_hash. The load-bearing invariant: an ADOPT whose proven input no longer matches the
in-force text (because an upstream step was skipped/reverted) is INCOHERENT and fails closed — you cannot
adopt a step whose proof is for a different input. SKIP and REVERT leave the in-force text unchanged but
are recorded distinctly, so the commitment distinguishes them. The expected commitment is re-derived
INDEPENDENTLY here (a second fold in the test), not by calling the module's fold.
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

import partial_adoption_gate as pag  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402

START = "user alice@example.com asked about the deadline and the refund policy in detail"
T_MASK = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline and the refund policy in detail"
T_COMPRESS = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline"


def _chain(cid="adopt-fixture"):
    g = mpc.genesis_anchor(cid)
    a0 = mpc.attest_step(chain_id=cid, step_index=0, prev_record_hash=g, prev_text=START, new_text=T_MASK,
                         declared_purpose="mask",
                         benefit=mpc.Benefit(0.0, "leak_count", "decrease", "measured", "ev"), determinism_ok=True)
    a1 = mpc.attest_step(chain_id=cid, step_index=1, prev_record_hash=a0.record_hash, prev_text=T_MASK,
                         new_text=T_COMPRESS, declared_purpose="compress",
                         benefit=mpc.Benefit(0.4, "token_fraction", "decrease", "measured", "ev"), determinism_ok=True)
    return [a0.as_dict(), a1.as_dict()]


def _dec(pairs):
    return [{"step_index": i, "decision": d} for i, d in pairs]


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except pag.AdoptionError as exc:
        return exc.error_type
    return None


def _expected_commitment(records, decisions):
    """Independent re-derivation: fold the decisions a SECOND time here and rebuild the commitment."""
    atts = [mpc._record_from_dict(r) for r in records]
    by_step = {d["step_index"]: d["decision"] for d in decisions}
    in_force = atts[0].input_hash
    tuples = []
    for a in atts:
        d = by_step[a.step_index]
        if d == "adopt" and a.input_hash == in_force:
            in_force = a.output_hash
        # skip / revert / incoherent-adopt leave in_force unchanged
        tuples.append([a.step_index, d, in_force])
    body = {"chain_id": atts[0].chain_id, "original_input_hash": atts[0].input_hash,
            "decisions": tuples, "effective_output_hash": in_force}
    return sha256(pag.EFF_DOMAIN_TAG + mpc.canonical_bytes(body)).hexdigest()


# --- the fold -----------------------------------------------------------------

def test_all_adopt_full_effective_chain():
    recs = _chain()
    rep = pag.compute_effective_chain(recs, _dec([(0, "adopt"), (1, "adopt")]))
    assert rep["overall_verdict"] == "PASS"
    assert rep["adopted_count"] == 2
    assert rep["effective_chain_hash"] == _expected_commitment(recs, _dec([(0, "adopt"), (1, "adopt")]))
    assert rep["effective_output_hash_16"] == mpc.sha256_16(mpc._record_from_dict(recs[1]).output_hash)


def test_prefix_adoption_then_skip():
    recs = _chain()
    rep = pag.compute_effective_chain(recs, _dec([(0, "adopt"), (1, "skip")]))
    assert rep["overall_verdict"] == "PASS" and rep["adopted_count"] == 1
    # effective output is the step-0 output (T_MASK), since step 1 was skipped
    assert rep["effective_output_hash_16"] == mpc.sha256_16(mpc._record_from_dict(recs[0]).output_hash)


def test_adopt_after_skip_is_incoherent():
    recs = _chain()
    # skip step 0, then adopt step 1 — step1's proven input is output(0), but in-force is the original
    rep = pag.compute_effective_chain(recs, _dec([(0, "skip"), (1, "adopt")]))
    assert rep["overall_verdict"] == "FAIL"
    assert any(s.get("incoherent") for s in rep["steps"])
    assert "adopt_input_discontinuity" in rep["reasons"]


def test_all_skip_is_verbatim():
    recs = _chain()
    rep = pag.compute_effective_chain(recs, _dec([(0, "skip"), (1, "skip")]))
    assert rep["overall_verdict"] == "PASS" and rep["adopted_count"] == 0
    # nothing applied -> effective output is the original input
    assert rep["effective_output_hash_16"] == mpc.sha256_16(mpc._record_from_dict(recs[0]).input_hash)


def test_skip_and_revert_same_output_distinct_commitment():
    recs = _chain()
    skip = pag.compute_effective_chain(recs, _dec([(0, "adopt"), (1, "skip")]))
    revert = pag.compute_effective_chain(recs, _dec([(0, "adopt"), (1, "revert")]))
    # identical effective output...
    assert skip["effective_output_hash_16"] == revert["effective_output_hash_16"]
    assert skip["overall_verdict"] == revert["overall_verdict"] == "PASS"
    # ...but DISTINCT effective-chain identity (the decision is committed)
    assert skip["effective_chain_hash"] != revert["effective_chain_hash"]


# --- malformed / fail-closed --------------------------------------------------

def test_malformed_decisions():
    recs = _chain()
    assert _err(pag.compute_effective_chain, recs, _dec([(0, "adopt")])) == "malformed_decisions"  # missing step 1
    assert _err(pag.compute_effective_chain, recs, _dec([(0, "adopt"), (1, "adopt"), (2, "skip")])) == "malformed_decisions"
    assert _err(pag.compute_effective_chain, recs, _dec([(0, "adopt"), (0, "skip")])) == "malformed_decisions"  # dup
    assert _err(pag.compute_effective_chain, recs, _dec([(0, "adopt"), (1, "bogus")])) == "malformed_decisions"
    assert _err(pag.compute_effective_chain, recs, ["not-a-dict", {}]) == "malformed_decisions"
    assert _err(pag.compute_effective_chain, recs, "nope") == "malformed_decisions"


def test_base_chain_invalid_fails_closed():
    recs = _chain()
    recs[1]["record_hash"] = "00" * 32
    rep = pag.compute_effective_chain(recs, _dec([(0, "adopt"), (1, "adopt")]))
    assert rep["overall_verdict"] == "FAIL" and "base_chain_invalid" in rep["reasons"]


def test_empty_chain_fails():
    assert pag.compute_effective_chain([], [])["error_type"] == "empty_chain"


def test_output_is_metadata_only():
    recs = _chain()
    blob = json.dumps(pag.compute_effective_chain(recs, _dec([(0, "adopt"), (1, "revert")])))
    assert "alice@example.com" not in blob and "refund policy" not in blob


# --- CLI e2e ------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["partial_adoption_gate.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = pag.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_pass_fail_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        recs = _chain("cli-chain")
        cf = dp / "chain.json"
        cf.write_text(json.dumps(recs), encoding="utf-8")
        df = dp / "dec.json"
        df.write_text(json.dumps(_dec([(0, "adopt"), (1, "adopt")])), encoding="utf-8")

        rc, rep = _run_main(["--chain", str(cf), "--decisions", str(df), "--pretty"])
        assert rc == 0 and rep["overall_verdict"] == "PASS"

        df2 = dp / "dec2.json"
        df2.write_text(json.dumps(_dec([(0, "skip"), (1, "adopt")])), encoding="utf-8")
        rc, rep = _run_main(["--chain", str(cf), "--decisions", str(df2)])
        assert rc == 1 and "adopt_input_discontinuity" in rep["reasons"]

        rc, rep = _run_main(["--chain", str(dp / "no.json"), "--decisions", str(df)])
        assert rc == 1 and rep["error_type"] == "missing_chain"
        rc, rep = _run_main(["--chain", str(cf), "--decisions", str(dp / "no.json")])
        assert rc == 1 and rep["error_type"] == "missing_decisions"

        bad = dp / "bad.json"
        bad.write_text("{nope", encoding="utf-8")
        rc, rep = _run_main(["--chain", str(bad), "--decisions", str(df)])
        assert rc == 1 and rep["error_type"] == "malformed_chain"
        rc, rep = _run_main(["--chain", str(cf), "--decisions", str(bad)])
        assert rc == 1 and rep["error_type"] == "malformed_decisions_json"

        mal = dp / "mal.json"
        mal.write_text(json.dumps(_dec([(0, "adopt")])), encoding="utf-8")  # missing step 1
        rc, rep = _run_main(["--chain", str(cf), "--decisions", str(mal)])
        assert rc == 1 and rep["error_type"] == "malformed_decisions"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} partial_adoption_gate tests passed")
