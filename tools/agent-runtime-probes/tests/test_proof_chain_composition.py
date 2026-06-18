#!/usr/bin/env python3
"""Slice 4 closeout — whole-proof-chain COMPOSITION test (capstone). Standalone.

Each proof-chain tier is unit-tested in isolation; this proves they COMPOSE coherently on ONE real chain
(the "every mutation carries a provable proof of purpose AND benefit" thesis as a working pipeline) AND
that a single tamper at any layer is caught by EXACTLY the gate responsible for it — no gate papers over
another's failure. The eight tiers:

  spine            mutation_proof_chain.verify_chain        — integrity / continuity
  authenticity     chain_authenticity.{sign,verify}_*       — producer keyed MAC (+ bound outcome)
  lifecycle/seal   chain_lifecycle_gate.{seal,verify_*}     — terminal seal (F2) + DoS cap + no-op
  lineage          chain_lineage_gate.verify_lineage        — retry/fork descends from parent
  meter            benefit_meter_gate.verify_benefit_meters — measured benefit needs an operational meter
  adoption         partial_adoption_gate.compute_effective_chain — effective applied chain
  outcome          chain_outcome_gate.verify_outcome        — typed terminal state (structural)
  env              chain_env_fingerprint.{compute,verify}_* — reproducibility binding
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import mutation_proof_chain as mpc       # noqa: E402
import chain_authenticity as ca          # noqa: E402
import chain_lifecycle_gate as clg       # noqa: E402
import chain_lineage_gate as lin         # noqa: E402
import benefit_meter_gate as bmg         # noqa: E402
import partial_adoption_gate as pag      # noqa: E402
import chain_outcome_gate as cog         # noqa: E402
import chain_env_fingerprint as cef      # noqa: E402

KEY = b"composition-producer-key-high-entropy"
START = "user alice@example.com asked about the 2026 deadline and the refund policy in detail"
T_MASK = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the 2026 deadline and the refund policy in detail"
T_COMPRESS = "user __CAPE_0123456789abcdef_EMAIL_1__ asked about the 2026 deadline"
T_FORK = "user __CAPE_0123456789abcdef_EMAIL_1__ asked"


def _build(cid, transforms, start=START):
    prev_text, prev_hash = start, mpc.genesis_anchor(cid)
    recs = []
    for i, (purpose, new_text) in enumerate(transforms):
        a = mpc.attest_step(chain_id=cid, step_index=i, prev_record_hash=prev_hash, prev_text=prev_text,
                            new_text=new_text, declared_purpose=purpose,
                            benefit=mpc.Benefit(0.3, "token_fraction", "decrease", "measured", "ev"),
                            determinism_ok=True)
        recs.append(a.as_dict())
        prev_text, prev_hash = new_text, a.record_hash
    return recs


def _chain():
    return _build("composition-chain", [("mask", T_MASK), ("compress", T_COMPRESS)])


COMPLETED = {"status": "completed"}
METERS = [{"step_index": 0, "status": "operational"}, {"step_index": 1, "status": "operational"}]


def test_all_tiers_compose_on_one_real_chain():
    recs = _chain()

    # 1) spine: integrity + continuity
    assert mpc.verify_chain(recs)["overall_verdict"] == "PASS"

    # 2) lifecycle: seal (F2) + DoS cap + no-op accounting
    seal = clg.seal_chain(recs)
    life = clg.verify_lifecycle(recs, seal)
    assert life["overall_verdict"] == "PASS" and life["seal_status"] == "verified"

    # 3) authenticity: producer MAC binding a COMPLETED outcome
    sig = ca.sign_chain(recs, KEY, outcome=COMPLETED)
    auth = ca.verify_signed_chain(recs, sig, KEY, outcome=COMPLETED)
    assert auth["mac_verified"] is True and auth["outcome_bound"] is True

    # 4) outcome gate: structural typing agrees
    assert cog.verify_outcome(recs, COMPLETED)["overall_verdict"] == "PASS"

    # 5) meter: both measured steps are operationally backed
    assert bmg.verify_benefit_meters(recs, METERS)["overall_verdict"] == "PASS"

    # 6) adoption: full effective chain
    eff = pag.compute_effective_chain(recs, [{"step_index": 0, "decision": "adopt"},
                                             {"step_index": 1, "decision": "adopt"}])
    assert eff["overall_verdict"] == "PASS" and eff["adopted_count"] == 2

    # 7) env fingerprint: reproducible under the producing semantics
    assert cef.verify_fingerprint(cef.compute_fingerprint())["overall_verdict"] == "PASS"

    # 8) lineage: a genuine fork off step 0 verifies against the parent
    child = _build("composition-fork", [("compress", T_FORK)], start=T_MASK)
    parent_fork_rh = mpc._record_from_dict(recs[0]).record_hash
    lineage = {"parent_chain_id": "composition-chain", "fork_step": 0, "parent_fork_record_hash": parent_fork_rh}
    assert lin.verify_lineage(recs, child, lineage)["overall_verdict"] == "PASS"


def test_each_single_tamper_is_caught_by_its_own_tier():
    recs = _chain()
    seal = clg.seal_chain(recs)
    sig = ca.sign_chain(recs, KEY, outcome=COMPLETED)

    # (a) TRUNCATION: a prefix still passes the SPINE (F2), but the seal catches it.
    truncated = recs[:1]
    assert mpc.verify_chain(truncated)["overall_verdict"] == "PASS"          # spine blind to truncation
    assert clg.verify_lifecycle(truncated, seal)["overall_verdict"] == "FAIL"  # seal is not

    # (b) OUTCOME RELABEL: structural outcome gate accepts it, but the MAC binding catches it.
    relabel = {"status": "failed", "failed_at_step": 2, "failure_class": "forged"}
    assert cog.verify_outcome(recs, relabel)["overall_verdict"] == "PASS"     # structurally consistent
    assert ca.verify_signed_chain(recs, sig, KEY, outcome=relabel)["mac_verified"] is False  # MAC is not

    # (c) UNBACKED MEASURED BENEFIT: the meter gate catches a measured claim with no operational meter.
    assert bmg.verify_benefit_meters(recs, [])["overall_verdict"] == "FAIL"

    # (d) BROKEN BACK-POINTER: the spine catches it AND authenticity refuses to lend a MAC verdict.
    broken = [dict(r) for r in recs]
    broken[1]["prev_record_hash"] = "00" * 32
    assert mpc.verify_chain(broken)["overall_verdict"] == "FAIL"
    assert ca.verify_signed_chain(broken, sig, KEY, outcome=COMPLETED)["mac_verified"] is False

    # (e) FAKE FORK (provenance laundering): a child that never branched from the parent fails lineage.
    fake = _build("fake-fork", [("mask", T_MASK)], start=START)  # resumes from START, not the parent's T_MASK
    parent_fork_rh = mpc._record_from_dict(recs[0]).record_hash
    lineage = {"parent_chain_id": "composition-chain", "fork_step": 0, "parent_fork_record_hash": parent_fork_rh}
    rep = lin.verify_lineage(recs, fake, lineage)
    assert rep["overall_verdict"] == "FAIL" and "text_discontinuity" in rep["reasons"]


def test_outcome_gate_and_mac_compose_for_full_outcome_assurance():
    """The composition that closes the relabel gap: structural typing (outcome gate) + authenticity (MAC).
    A 'failed' chain is typed AND signed; flipping it to 'completed' fails the MAC even though both the
    structural gate and the bare chain still pass."""
    recs = _chain()
    failed = {"status": "failed", "failed_at_step": 2, "failure_class": "anchor_loss"}
    sig = ca.sign_chain(recs, KEY, outcome=failed)
    # genuine: typed + authenticated agree
    assert cog.verify_outcome(recs, failed)["overall_verdict"] == "PASS"
    assert ca.verify_signed_chain(recs, sig, KEY, outcome=failed)["mac_verified"] is True
    # adversary flips to completed: structural gate still PASS, but the MAC rejects the relabel
    assert cog.verify_outcome(recs, COMPLETED)["overall_verdict"] == "PASS"
    assert ca.verify_signed_chain(recs, sig, KEY, outcome=COMPLETED)["mac_verified"] is False


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} proof_chain_composition tests passed")
