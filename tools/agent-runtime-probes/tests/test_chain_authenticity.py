#!/usr/bin/env python3
"""Tests for chain_authenticity — keyed-MAC producer authenticity (proof-chain Slice 2). Standalone.

Keystone (closes red-team F1/F3): a chain that PASSES the integrity verifier but is signed with the
WRONG key (a forger who minted a self-consistent chain under a public genesis) must verify as
NOT authentic; only the holder of the producer key produces a verifying signature; any edit /
truncation / reorder breaks the MAC. The expected MAC is re-derived INDEPENDENTLY with the stdlib
hmac here, never by calling the module's own signer (no f(x)==f(x)).
"""
import hmac
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import chain_authenticity as ca  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402

KEY = b"producer-secret-key-high-entropy-0001"
WRONG = b"attacker-guessed-key-9999"


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except ca.AuthenticityError as exc:
        return exc.error_type
    return None


def _build_chain():
    """A real 2-step chain via the spine: a mask step then a compress step. Returns record dicts."""
    cid = "auth-fixture-chain"
    g = mpc.genesis_anchor(cid)
    t0 = "user alice@example.com asked about the deadline and the refund policy in detail"
    t1 = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline and the refund policy in detail"
    t2 = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline"  # deletion (compress)
    a0 = mpc.attest_step(
        chain_id=cid, step_index=0, prev_record_hash=g, prev_text=t0, new_text=t1,
        declared_purpose="mask",
        benefit=mpc.Benefit(0.0, "leak_count", "decrease", "measured", "ev:mask"),
        determinism_ok=True,
    )
    a1 = mpc.attest_step(
        chain_id=cid, step_index=1, prev_record_hash=a0.record_hash, prev_text=t1, new_text=t2,
        declared_purpose="compress",
        benefit=mpc.Benefit(0.40, "token_fraction", "decrease", "measured", "ev:compress"),
        determinism_ok=True,
    )
    return [a0.as_dict(), a1.as_dict()]


def _independent_mac(records, key):
    atts = [mpc._record_from_dict(r) for r in records]
    body = {
        "schema": ca.SCHEMA, "alg": ca.ALG, "chain_id": atts[0].chain_id,
        "record_count": len(atts), "record_hashes": [a.record_hash for a in atts],
    }
    msg = ca.SIG_DOMAIN_TAG + mpc.canonical_bytes(body)
    return hmac.new(key, msg, sha256).hexdigest()


# --- key coercion --------------------------------------------------------------

def test_empty_or_bad_key_fails_closed():
    chain = _build_chain()
    assert _err(ca.sign_chain, chain, "") == "bad_key"
    assert _err(ca.sign_chain, chain, b"") == "bad_key"
    assert _err(ca.sign_chain, chain, 12345) == "bad_key"


def test_str_and_bytes_keys_are_equivalent():
    chain = _build_chain()
    s_str = ca.sign_chain(chain, "abc")
    s_bytes = ca.sign_chain(chain, b"abc")
    assert s_str["signature"] == s_bytes["signature"]


# --- sign_chain ----------------------------------------------------------------

def test_sign_matches_independent_hmac():
    chain = _build_chain()
    sig = ca.sign_chain(chain, KEY, signer_label="prod-2026")
    assert sig["signature"] == _independent_mac(chain, KEY)
    assert sig["alg"] == "HMAC-SHA256" and sig["record_count"] == 2
    assert sig["signer_label"] == "prod-2026"


def test_signature_object_carries_no_key_material():
    chain = _build_chain()
    sig = ca.sign_chain(chain, KEY)
    blob = json.dumps(sig)
    # neither the raw key nor any hash of the key may appear in the artifact
    assert KEY.decode() not in blob
    assert ca.sha256_16(KEY.decode()) not in blob
    assert sha256(KEY).hexdigest() not in blob


def test_sign_refuses_empty_and_unverified_chains():
    assert _err(ca.sign_chain, [], KEY) == "empty_chain"
    chain = _build_chain()
    chain[1]["prev_record_hash"] = "deadbeef" * 8  # break the back-pointer -> chain won't verify
    assert _err(ca.sign_chain, chain, KEY) == "unverified_chain"


# --- verify_signed_chain (the authenticity proof) ------------------------------

def _independent_mac_with_outcome(records, key, outcome):
    atts = [mpc._record_from_dict(r) for r in records]
    body = {
        "schema": ca.SCHEMA, "alg": ca.ALG, "chain_id": atts[0].chain_id,
        "record_count": len(atts), "record_hashes": [a.record_hash for a in atts],
        "outcome": {"status": outcome["status"], "failed_at_step": outcome.get("failed_at_step"),
                    "failure_class": outcome.get("failure_class")},
    }
    return hmac.new(key, ca.SIG_DOMAIN_TAG + mpc.canonical_bytes(body), sha256).hexdigest()


# --- outcome-marker authentication (closes the chain_outcome_gate relabel gap) -------------------

_FAILED = {"status": "failed", "failed_at_step": 2, "failure_class": "anchor_loss"}


def test_outcome_bound_signature_verifies_and_matches_independent_mac():
    chain = _build_chain()
    sig = ca.sign_chain(chain, KEY, outcome=_FAILED)
    assert sig["outcome_bound"] is True and sig["outcome_status"] == "failed"
    assert sig["signature"] == _independent_mac_with_outcome(chain, KEY, _FAILED)
    # the no-outcome MAC must DIFFER (binding actually changed the signed bytes)
    assert sig["signature"] != _independent_mac(chain, KEY)
    rep = ca.verify_signed_chain(chain, sig, KEY, outcome=_FAILED)
    assert rep["mac_verified"] is True and rep["reasons"] == [] and rep["outcome_bound"] is True


def test_outcome_relabel_breaks_the_mac():
    chain = _build_chain()
    sig = ca.sign_chain(chain, KEY, outcome=_FAILED)
    # an attacker relabels the outcome completed<-failed and presents the original signature
    rep = ca.verify_signed_chain(chain, sig, KEY, outcome={"status": "completed"})
    assert rep["mac_verified"] is False
    assert "outcome_status_mismatch" in rep["reasons"] and "signature_mismatch" in rep["reasons"]


def test_stripping_a_bound_outcome_breaks_the_mac():
    chain = _build_chain()
    sig = ca.sign_chain(chain, KEY, outcome=_FAILED)
    rep = ca.verify_signed_chain(chain, sig, KEY)  # verify with NO outcome (marker stripped)
    assert rep["mac_verified"] is False and "outcome_binding_mismatch" in rep["reasons"]


def test_attaching_outcome_to_unbound_signature_breaks_the_mac():
    chain = _build_chain()
    sig = ca.sign_chain(chain, KEY)  # signed WITHOUT an outcome (outcome_bound False)
    rep = ca.verify_signed_chain(chain, sig, KEY, outcome=_FAILED)  # attacker attaches one
    assert rep["mac_verified"] is False and "outcome_binding_mismatch" in rep["reasons"]


def test_malformed_outcome_is_rejected_on_sign_and_verify():
    chain = _build_chain()
    assert _err(ca.sign_chain, chain, KEY, "", {}) == "malformed_outcome"          # no status
    assert _err(ca.sign_chain, chain, KEY, "", {"status": 5}) == "malformed_outcome"
    sig = ca.sign_chain(chain, KEY, outcome=_FAILED)
    assert _err(ca.verify_signed_chain, chain, sig, KEY, {"status": ""}) == "malformed_outcome"


def test_genuine_signature_is_authentic():
    chain = _build_chain()
    sig = ca.sign_chain(chain, KEY)
    rep = ca.verify_signed_chain(chain, sig, KEY)
    assert rep["mac_verified"] is True and rep["overall_verdict"] == "PASS"
    assert rep["sig_match"] is True and rep["reasons"] == []


def test_wrong_key_is_not_authentic_even_when_chain_verifies():
    # THE F1/F3 KEYSTONE: forger minted a self-consistent chain (it verifies) but lacks the key.
    chain = _build_chain()
    assert mpc.verify_chain(chain)["overall_verdict"] == "PASS"  # integrity passes ...
    sig = ca.sign_chain(chain, KEY)
    rep = ca.verify_signed_chain(chain, sig, WRONG)               # ... authenticity does not
    assert rep["mac_verified"] is False and rep["overall_verdict"] == "FAIL"
    assert rep["sig_match"] is False and "signature_mismatch" in rep["reasons"]


def test_edited_chain_breaks_the_mac():
    chain = _build_chain()
    sig = ca.sign_chain(chain, KEY)
    # re-mint a DIFFERENT but internally-valid chain (different chain_id) and present the old signature
    cid2 = "different-chain-id"
    g = mpc.genesis_anchor(cid2)
    t0, t1 = "alpha beta gamma delta", "alpha beta gamma"
    a0 = mpc.attest_step(chain_id=cid2, step_index=0, prev_record_hash=g, prev_text=t0, new_text=t1,
                         declared_purpose="compress",
                         benefit=mpc.Benefit(0.25, "token_fraction", "decrease", "measured", "ev:x"),
                         determinism_ok=True)
    forged = [a0.as_dict()]
    rep = ca.verify_signed_chain(forged, sig, KEY)
    assert rep["mac_verified"] is False
    assert "record_count_mismatch" in rep["reasons"] and "chain_id_mismatch" in rep["reasons"]


def test_truncated_chain_breaks_the_mac():
    chain = _build_chain()
    sig = ca.sign_chain(chain, KEY)
    rep = ca.verify_signed_chain([chain[0]], sig, KEY)  # drop the last step
    assert rep["mac_verified"] is False and rep["sig_match"] is False


def test_malformed_signature_object_fails_closed():
    chain = _build_chain()
    assert _err(ca.verify_signed_chain, chain, "not-a-dict", KEY) == "malformed_signature"
    assert _err(ca.verify_signed_chain, chain, {"signature": "x"}, KEY) == "malformed_signature"


def test_alg_mismatch_is_reported_and_not_authentic():
    chain = _build_chain()
    sig = ca.sign_chain(chain, KEY)
    sig["alg"] = "HMAC-SHA512"
    rep = ca.verify_signed_chain(chain, sig, KEY)
    assert rep["mac_verified"] is False and "alg_mismatch" in rep["reasons"]


def test_verify_is_metadata_only():
    chain = _build_chain()
    sig = ca.sign_chain(chain, KEY)
    rep = ca.verify_signed_chain(chain, sig, KEY)
    blob = json.dumps(rep)
    assert KEY.decode() not in blob and sig["signature"] not in blob  # full sig not echoed


# --- CLI e2e -------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["chain_authenticity.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = ca.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_sign_then_verify_roundtrip_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        chain_f = dp / "chain.json"
        chain_f.write_text(json.dumps(_build_chain()), encoding="utf-8")
        key_f = dp / "key.bin"
        key_f.write_bytes(KEY)
        sig_f = dp / "sig.json"

        rc, sig = _run_main(["--chain", str(chain_f), "--mode", "sign", "--key-file", str(key_f),
                             "--signer-label", "prod", "--pretty"])
        assert rc == 0 and sig["alg"] == "HMAC-SHA256"
        sig_f.write_text(json.dumps(sig), encoding="utf-8")

        rc, rep = _run_main(["--chain", str(chain_f), "--mode", "verify", "--key-file", str(key_f),
                             "--signature", str(sig_f)])
        assert rc == 0 and rep["mac_verified"] is True

        # wrong key file -> verify fails
        wrong_f = dp / "wrong.bin"
        wrong_f.write_bytes(WRONG)
        rc, rep = _run_main(["--chain", str(chain_f), "--mode", "verify", "--key-file", str(wrong_f),
                             "--signature", str(sig_f)])
        assert rc == 1 and rep["mac_verified"] is False

        # verify without --signature
        rc, rep = _run_main(["--chain", str(chain_f), "--mode", "verify", "--key-file", str(key_f)])
        assert rc == 1 and rep["error_type"] == "missing_signature"

        # missing chain file
        rc, rep = _run_main(["--chain", str(dp / "nope.json"), "--mode", "sign", "--key-file", str(key_f)])
        assert rc == 1 and rep["error_type"] == "missing_input" and "/Users/" not in rep["_error"]

        # malformed chain JSON
        mal = dp / "mal.json"
        mal.write_text("{not json", encoding="utf-8")
        rc, rep = _run_main(["--chain", str(mal), "--mode", "sign", "--key-file", str(key_f)])
        assert rc == 1 and rep["error_type"] == "malformed_chain"

        # signing an unverified chain via CLI -> AuthenticityError surfaced, rc 1
        broken = _build_chain()
        broken[1]["prev_record_hash"] = "00" * 32
        bf = dp / "broken.json"
        bf.write_text(json.dumps(broken), encoding="utf-8")
        rc, rep = _run_main(["--chain", str(bf), "--mode", "sign", "--key-file", str(key_f)])
        assert rc == 1 and rep["error_type"] == "unverified_chain"


def test_verify_unverified_chain_reports_reason():
    # a broken chain still parses but does not verify -> the reason surfaces (not just signature_mismatch)
    chain = _build_chain()
    sig = ca.sign_chain(chain, KEY)
    broken = [dict(r) for r in chain]
    broken[1]["prev_record_hash"] = "00" * 32
    rep = ca.verify_signed_chain(broken, sig, KEY)
    assert rep["mac_verified"] is False and "unverified_chain" in rep["reasons"]


def test_main_outcome_bound_roundtrip_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        chain_f = dp / "chain.json"
        chain_f.write_text(json.dumps(_build_chain()), encoding="utf-8")
        key_f = dp / "key.bin"
        key_f.write_bytes(KEY)
        out_f = dp / "outcome.json"
        out_f.write_text(json.dumps(_FAILED), encoding="utf-8")

        # sign WITH outcome
        rc, sig = _run_main(["--chain", str(chain_f), "--mode", "sign", "--key-file", str(key_f),
                             "--outcome", str(out_f)])
        assert rc == 0 and sig["outcome_bound"] is True and sig["outcome_status"] == "failed"
        sig_f = dp / "sig.json"
        sig_f.write_text(json.dumps(sig), encoding="utf-8")

        # verify WITH the same outcome -> authentic
        rc, rep = _run_main(["--chain", str(chain_f), "--mode", "verify", "--key-file", str(key_f),
                             "--signature", str(sig_f), "--outcome", str(out_f)])
        assert rc == 0 and rep["mac_verified"] is True

        # verify WITHOUT the outcome (stripped) -> FAIL
        rc, rep = _run_main(["--chain", str(chain_f), "--mode", "verify", "--key-file", str(key_f),
                             "--signature", str(sig_f)])
        assert rc == 1 and "outcome_binding_mismatch" in rep["reasons"]

        # --outcome file missing
        rc, rep = _run_main(["--chain", str(chain_f), "--mode", "sign", "--key-file", str(key_f),
                             "--outcome", str(dp / "no.json")])
        assert rc == 1 and rep["error_type"] == "missing_outcome"

        # --outcome malformed JSON
        bad = dp / "bad.json"
        bad.write_text("{nope", encoding="utf-8")
        rc, rep = _run_main(["--chain", str(chain_f), "--mode", "sign", "--key-file", str(key_f),
                             "--outcome", str(bad)])
        assert rc == 1 and rep["error_type"] == "malformed_outcome_json"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} chain_authenticity tests passed")
