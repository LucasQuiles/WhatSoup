#!/usr/bin/env python3
"""Estate redaction capstone — prove the metadata-only invariant holds end-to-end. Standalone.

Every CAPE probe CLAIMS metadata-only; `output_redaction_auditor` enforces it. This capstone feeds
SENSITIVE-shaped inputs (raw filesystem paths, path-bearing answers) through the probes that PROCESS
sensitive data, captures their ACTUAL emitted reports, and audits them ALL — proving no probe echoes the
sensitive shape into its report even when fed it. A negative control proves the capstone would catch a leak.

Scope: the proof-chain + reducer-gate + governance reports (no plane VERDICT gates imported, so the
two_plane_separation guard is unaffected). It exercises the report shapes that carry the highest leak risk
(those derived from real prompt/path content).
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import mutation_proof_chain as mpc          # noqa: E402
import compression_governor as cg           # noqa: E402
import anchor_preservation_gate as ag       # noqa: E402
import chain_lifecycle_gate as clg          # noqa: E402
import chain_outcome_gate as cog            # noqa: E402
import benefit_meter_gate as bmg            # noqa: E402
import partial_adoption_gate as pag         # noqa: E402
import output_redaction_auditor as ora      # noqa: E402

# sensitive-shaped content: an absolute path + a host, embedded in prompt-like text
SENS = ("deploy from /Users/testuser/agent-runtime-probes onto build.internal.example "
        "and the audit safety rule must never be disabled")
COMP = "deploy from /Users/testuser/agent-runtime-probes onto build.internal.example"


def _sensitive_chain():
    cid = "capstone-chain"
    g = mpc.genesis_anchor(cid)
    t0 = "user /Users/testuser/agent-runtime-probes ran the audit on build.internal.example today"
    t1 = "user /Users/testuser/agent-runtime-probes ran the audit"  # deletion (compress)
    a0 = mpc.attest_step(chain_id=cid, step_index=0, prev_record_hash=g, prev_text=t0, new_text=t1,
                         declared_purpose="compress",
                         benefit=mpc.Benefit(0.3, "token_fraction", "decrease", "measured", "ev"),
                         determinism_ok=True)
    return [a0.as_dict()]


def _collect_reports() -> list:
    """Run sensitive inputs through the probes; return their emitted reports."""
    reports = []
    # reducer gates fed path/host-bearing text
    reports.append(cg.govern(SENS, COMP, content_class="prose"))
    reports.append(ag.gate(SENS, COMP, [{"kind": "negation", "text": "must never be disabled"}]))
    # proof chain over sensitive text
    recs = _sensitive_chain()
    reports.append(mpc.verify_chain(recs))
    reports.append(clg.verify_lifecycle(recs, clg.seal_chain(recs)))
    reports.append(cog.verify_outcome(recs, {"status": "completed"}))
    reports.append(bmg.verify_benefit_meters(recs, [{"step_index": 0, "status": "operational"}]))
    reports.append(pag.compute_effective_chain(recs, [{"step_index": 0, "decision": "adopt"}]))
    return reports


def test_no_probe_leaks_sensitive_shapes_into_its_report():
    reports = _collect_reports()
    audit = ora.audit_reports(reports)
    assert audit["overall_verdict"] == "PASS", audit
    assert audit["total_leak_count"] == 0
    assert audit["report_count"] == len(reports)


def test_capstone_inputs_actually_contained_the_sensitive_shape():
    # guard against a vacuous pass: the INPUTS really did carry a leakable path (so a non-redacting probe
    # WOULD have leaked it). We assert the auditor flags the raw input, but not the probe reports.
    raw_input_as_report = {"_demo_raw_input": SENS}
    assert ora.audit_report(raw_input_as_report)["overall_verdict"] == "FAIL"


def test_negative_control_a_leaky_report_is_caught():
    # if any probe HAD echoed the path, the capstone would fail — prove the auditor catches that shape
    leaky = {"schema": "agent-runtime-foo", "overall_verdict": "PASS",
             "detail": "wrote /Users/testuser/agent-runtime-probes/out"}
    assert ora.audit_report(leaky)["overall_verdict"] == "FAIL"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} estate_redaction_capstone tests passed")
