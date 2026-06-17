#!/usr/bin/env python3
"""Tests for chain_lineage_gate — proof-chain Slice 4 retry/fork lineage. Standalone.

Keystone (consensus §7 'retry/fork (parent_chain_id)'): a child chain that CLAIMS to fork from a parent at
step k must PROVE it: (a) its first step resumes from the parent's actual text state after step k
(child[0].input_hash == parent[k].output_hash — the chain-id-independent linkage), and (b) it binds the
parent's exact fork record. A fresh chain that never branched from the parent (provenance laundering) or a
fork that hides where it really diverged fails the text-continuity check. record_hash binds chain_id, so the
cross-chain linkage MUST be the text hashes, not record hashes — these tests assert exactly that contract.
"""
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import chain_lineage_gate as clg  # noqa: E402
import mutation_proof_chain as mpc  # noqa: E402

START = "user alice@example.com asked about the deadline and the refund policy in detail"
T_MASK = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline and the refund policy in detail"
T_COMPRESS = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the deadline"
T_FORK = "user __CAPE_0123456789abcdef_EMAIL_1__ asked"  # a DIFFERENT (shorter) deletion from T_MASK


def _attest(cid, idx, prev_hash, prev_text, new_text, purpose):
    return mpc.attest_step(
        chain_id=cid, step_index=idx, prev_record_hash=prev_hash, prev_text=prev_text,
        new_text=new_text, declared_purpose=purpose,
        benefit=mpc.Benefit(0.2, "token_fraction", "decrease", "measured", "ev:x"),
        determinism_ok=True,
    )


def _build(cid, transforms, start=START):
    prev_text, prev_hash = start, mpc.genesis_anchor(cid)
    recs = []
    for i, (purpose, new_text) in enumerate(transforms):
        a = _attest(cid, i, prev_hash, prev_text, new_text, purpose)
        recs.append(a.as_dict())
        prev_text, prev_hash = new_text, a.record_hash
    return recs


def _parent(cid="parent-chain"):
    return _build(cid, [("mask", T_MASK), ("compress", T_COMPRESS)])


def _err(fn, *a, **k):
    try:
        fn(*a, **k)
    except clg.LineageError as exc:
        return exc.error_type
    return None


def _lineage(parent, fork_step, *, parent_chain_id="parent-chain", record_hash=None):
    p = [mpc._record_from_dict(r) for r in parent]
    if record_hash is not None:
        rh = record_hash
    elif 0 <= fork_step < len(p):
        rh = p[fork_step].record_hash
    else:
        rh = "ff" * 32  # placeholder for an out-of-range fork_step test
    return {"parent_chain_id": parent_chain_id, "fork_step": fork_step, "parent_fork_record_hash": rh}


# --- valid fork ---------------------------------------------------------------

def test_valid_fork_at_step0_passes():
    parent = _parent()
    # child forks after parent step 0 (text state = T_MASK), then does a DIFFERENT compress
    child = _build("child-fork", [("compress", T_FORK)], start=T_MASK)
    rep = clg.verify_lineage(parent, child, _lineage(parent, 0))
    assert rep["overall_verdict"] == "PASS"
    assert rep["text_continuous"] is True and rep["fork_record_match"] is True
    assert rep["fork_step"] == 0


def test_valid_fork_at_later_step():
    parent = _parent()
    # fork after parent step 1 (text state = T_COMPRESS)
    child = _build("child-late", [("canonicalize", T_COMPRESS)], start=T_COMPRESS)
    rep = clg.verify_lineage(parent, child, _lineage(parent, 1))
    assert rep["overall_verdict"] == "PASS" and rep["text_continuous"] is True


# --- anti-laundering: text discontinuity --------------------------------------

def test_text_discontinuity_fails():
    parent = _parent()
    # child claims to fork at step 0 (expects T_MASK) but actually starts from START -> laundering
    child = _build("child-fake", [("mask", T_MASK)], start=START)
    rep = clg.verify_lineage(parent, child, _lineage(parent, 0))
    assert rep["overall_verdict"] == "FAIL"
    assert "text_discontinuity" in rep["reasons"]


def test_fork_record_mismatch_fails():
    parent = _parent()
    child = _build("child-fork", [("compress", T_FORK)], start=T_MASK)
    bad = _lineage(parent, 0, record_hash="deadbeef" * 8)
    rep = clg.verify_lineage(parent, child, bad)
    assert rep["overall_verdict"] == "FAIL" and "fork_record_mismatch" in rep["reasons"]


# --- structural guards --------------------------------------------------------

def test_self_fork_rejected():
    parent = _parent("same-id")
    child = _build("same-id", [("compress", T_FORK)], start=T_MASK)  # same chain_id as parent
    rep = clg.verify_lineage(parent, child, _lineage(parent, 0, parent_chain_id="same-id"))
    assert rep["overall_verdict"] == "FAIL" and "self_fork" in rep["reasons"]


def test_parent_chain_id_mismatch_fails():
    parent = _parent()
    child = _build("child-fork", [("compress", T_FORK)], start=T_MASK)
    rep = clg.verify_lineage(parent, child, _lineage(parent, 0, parent_chain_id="not-the-parent"))
    assert rep["overall_verdict"] == "FAIL" and "parent_chain_id_mismatch" in rep["reasons"]


def test_fork_step_out_of_range_fails():
    parent = _parent()
    child = _build("child-fork", [("compress", T_FORK)], start=T_MASK)
    rep = clg.verify_lineage(parent, child, _lineage(parent, 9))
    assert rep["overall_verdict"] == "FAIL" and "fork_step_out_of_range" in rep["reasons"]


def test_invalid_parent_or_child_fails_closed():
    parent = _parent()
    child = _build("child-fork", [("compress", T_FORK)], start=T_MASK)
    bad_parent = [dict(r) for r in parent]
    bad_parent[1]["record_hash"] = "00" * 32
    rep = clg.verify_lineage(bad_parent, child, _lineage(parent, 0))
    assert rep["overall_verdict"] == "FAIL" and "parent_chain_invalid" in rep["reasons"]

    bad_child = [dict(r) for r in child]
    bad_child[0]["record_hash"] = "00" * 32
    rep = clg.verify_lineage(parent, bad_child, _lineage(parent, 0))
    assert rep["overall_verdict"] == "FAIL" and "child_chain_invalid" in rep["reasons"]


# --- malformed input ----------------------------------------------------------

def test_malformed_lineage_and_empty_chains():
    parent = _parent()
    child = _build("child-fork", [("compress", T_FORK)], start=T_MASK)
    assert _err(clg.verify_lineage, parent, child, {"fork_step": 0}) == "malformed_lineage"   # missing record hash
    assert _err(clg.verify_lineage, parent, child, {"parent_fork_record_hash": "x"}) == "malformed_lineage"
    assert _err(clg.verify_lineage, parent, child, "nope") == "malformed_lineage"
    assert _err(clg.verify_lineage, parent, child, {"fork_step": "x", "parent_fork_record_hash": "y"}) == "malformed_lineage"
    assert clg.verify_lineage([], child, _lineage(parent, 0))["error_type"] == "empty_chain"
    assert clg.verify_lineage(parent, [], _lineage(parent, 0))["error_type"] == "empty_chain"


def test_output_is_metadata_only():
    parent = _parent()
    child = _build("child-fork", [("compress", T_FORK)], start=T_MASK)
    blob = json.dumps(clg.verify_lineage(parent, child, _lineage(parent, 0)))
    assert "alice@example.com" not in blob and "refund policy" not in blob


# --- CLI e2e ------------------------------------------------------------------

def _run_main(argv):
    saved = sys.argv
    sys.argv = ["chain_lineage_gate.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = clg.main()
    finally:
        sys.argv = saved
    return rc, json.loads(buf.getvalue())


def test_main_pass_fail_and_errors():
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        parent = _parent("cli-parent")
        child = _build("cli-child", [("compress", T_FORK)], start=T_MASK)
        pf, cf, lf = dp / "p.json", dp / "c.json", dp / "l.json"
        pf.write_text(json.dumps(parent), encoding="utf-8")
        cf.write_text(json.dumps(child), encoding="utf-8")
        lf.write_text(json.dumps(_lineage(parent, 0, parent_chain_id="cli-parent")), encoding="utf-8")

        rc, rep = _run_main(["--parent", str(pf), "--child", str(cf), "--lineage", str(lf), "--pretty"])
        assert rc == 0 and rep["overall_verdict"] == "PASS"

        # a fake-fork child (starts from START) -> FAIL
        fake = dp / "fake.json"
        fake.write_text(json.dumps(_build("cli-fake", [("mask", T_MASK)], start=START)), encoding="utf-8")
        rc, rep = _run_main(["--parent", str(pf), "--child", str(fake), "--lineage", str(lf)])
        assert rc == 1 and "text_discontinuity" in rep["reasons"]

        rc, rep = _run_main(["--parent", str(dp / "no.json"), "--child", str(cf), "--lineage", str(lf)])
        assert rc == 1 and rep["error_type"] == "missing_parent"
        rc, rep = _run_main(["--parent", str(pf), "--child", str(dp / "no.json"), "--lineage", str(lf)])
        assert rc == 1 and rep["error_type"] == "missing_child"
        rc, rep = _run_main(["--parent", str(pf), "--child", str(cf), "--lineage", str(dp / "no.json")])
        assert rc == 1 and rep["error_type"] == "missing_lineage"

        bad = dp / "bad.json"
        bad.write_text("{nope", encoding="utf-8")
        rc, rep = _run_main(["--parent", str(bad), "--child", str(cf), "--lineage", str(lf)])
        assert rc == 1 and rep["error_type"] == "malformed_parent"
        rc, rep = _run_main(["--parent", str(pf), "--child", str(cf), "--lineage", str(bad)])
        assert rc == 1 and rep["error_type"] == "malformed_lineage_json"

        # malformed lineage content (missing field) routed through main -> typed error
        ml = dp / "ml.json"
        ml.write_text(json.dumps({"fork_step": 0}), encoding="utf-8")
        rc, rep = _run_main(["--parent", str(pf), "--child", str(cf), "--lineage", str(ml)])
        assert rc == 1 and rep["error_type"] == "malformed_lineage"


def test_lineage_empty_record_hash_is_malformed():
    # parent_fork_record_hash must be a NON-EMPTY string (guard `not isinstance(rh,str) or not rh`).
    # An and-weakening would accept an empty hash (isinstance is True, so the conjunction is False),
    # admitting a lineage declaration with no real fork anchor.
    parent = _parent()
    child = _build("child-fork", [("compress", T_FORK)], start=T_MASK)
    bad = _lineage(parent, 0, record_hash="")
    assert _err(clg.verify_lineage, parent, child, bad) == "malformed_lineage"


def test_fork_at_last_parent_step_is_not_divergent():
    # is_divergent_fork = `in_range AND fork_step < len(parent) - 1`: a fork at the LAST parent step
    # means the parent did NOT continue past the fork point, so it is NOT divergent. An or-weakening
    # or a <= weakening (true at the last step) would mislabel it divergent.
    parent = _parent()  # 2 records -> last step index 1 == len(parent)-1
    child = _build("child-late", [("canonicalize", T_COMPRESS)], start=T_COMPRESS)
    rep = clg.verify_lineage(parent, child, _lineage(parent, 1))
    assert rep["overall_verdict"] == "PASS"
    assert rep["is_divergent_fork"] is False


def test_lineage_recommended_action_mirrors_verdict():
    # recommended_action is "accept_lineage" iff overall == "PASS" (else "reject_lineage"). Flipping
    # the == would invert the label on both a clean fork and a discontinuity.
    parent = _parent()
    child = _build("child-fork", [("compress", T_FORK)], start=T_MASK)
    ok = clg.verify_lineage(parent, child, _lineage(parent, 0))
    assert ok["overall_verdict"] == "PASS" and ok["recommended_action"] == "accept_lineage"
    fake = _build("child-fake", [("mask", T_MASK)], start=START)  # text discontinuity -> FAIL
    bad = clg.verify_lineage(parent, fake, _lineage(parent, 0))
    assert bad["overall_verdict"] == "FAIL" and bad["recommended_action"] == "reject_lineage"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} chain_lineage_gate tests passed")
