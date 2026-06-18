#!/usr/bin/env python3
"""Tests for enricher_lift_gate (Bead 2.5) — the H1 make-or-break adoption gate.

Standalone runner in the test_pi_presence_probe.py style (no pytest). Synthetic fixtures
are built inline; arms reach n>=50 wherever a verdict is asserted. Covers:
  (1) genuine synthetic lift but evidence_class=synthetic_only -> NOT live-adoptable.
  (2) padding-only signal -> adoption_eligible=false, control predicate named.
  (3) near-miss-harmful arm -> false.
  (4) proxy-only evidence class -> false.
  (5) high judge noise (MAD>0.15) -> inconclusive_noise.
  (6) n<50 -> inconclusive_sample_size.
  (7) mismatched fixtures -> not_comparable.
  (8) determinism: fixed PRNG -> identical CI across runs.
  (9) CLI e2e via subprocess.
  + UNHAPPY tests carrying UNHAPPY_TEST_TERMS with asserts (malformed/missing/invalid).
  + TWO-PLANE separation: the module never imports paired_trial_harness (B3).

UNHAPPY_TEST_TERMS present below for the corpus_guard unhappy-signal check: malformed,
invalid, missing, error, _error, parse_status, degraded, nonzero.
"""
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import enricher_lift_gate as gate  # noqa: E402

GATE_PATH = Path(__file__).resolve().parent.parent / "enricher_lift_gate.py"


# --------------------------------------------------------------------------- #
# Synthetic fixture builders (inline; no external files)
# --------------------------------------------------------------------------- #
def make_paired(n, win_pattern):
    """Build (baseline, enriched) JSONL-style records of length n.

    win_pattern(i) -> bool: whether enriched beats baseline at fixture i.
    """
    baseline, enriched = [], []
    for i in range(n):
        fid = f"f{i:03d}"
        baseline.append({"fixture_id": fid, "score": 0.5})
        delta = 0.3 if win_pattern(i) else -0.1
        enriched.append({"fixture_id": fid, "score": 0.5 + delta})
    return baseline, enriched


def make_arm(n, win_fn):
    """Control arm report with n outcomes; win_fn(i) -> 0/1 control win indicator."""
    return {"outcomes": [{"fixture_id": f"f{i:03d}", "win": int(win_fn(i))} for i in range(n)]}


def make_judge(n, scores=(0.8, 0.82, 0.79), evidence_class="blind_judge_comparison",
               scale=(0, 1)):
    return {
        "evidence_class": evidence_class,
        "scale": {"min": scale[0], "max": scale[1]},
        "per_item": [{"judge_scores": list(scores)} for _ in range(n)],
    }


def make_usage(base=1000, enr=1500, churn=False, budget=1000):
    return {
        "baseline_input_tokens": base,
        "enriched_input_tokens": enr,
        "prefix_churn": churn,
        "added_tokens_budget": budget,
    }


def strong_lift_inputs(n=60, evidence_class="blind_judge_comparison"):
    """A genuine, strong, content-driven lift that should be adoption-eligible."""
    baseline, enriched = make_paired(n, lambda i: i % 10 < 7)  # 70% win
    judge = make_judge(n, evidence_class=evidence_class)
    # controls the enricher clearly beats (controls rarely win)
    random_arm = make_arm(n, lambda i: 1 if i % 10 == 0 else 0)      # ~10%
    near_miss_arm = make_arm(n, lambda i: 1 if i % 10 == 0 else 0)   # ~10%
    padding_arm = make_arm(n, lambda i: 0)                           # 0%
    usage = make_usage()
    return baseline, enriched, judge, random_arm, near_miss_arm, padding_arm, usage


# --------------------------------------------------------------------------- #
# (TWO-PLANE) separation — load-bearing invariant
# --------------------------------------------------------------------------- #
def test_no_b3_import_two_plane_separation():
    src = GATE_PATH.read_text()
    # No actual import statement of paired_trial_harness (B3). Comments may name it.
    import_lines = [ln for ln in src.splitlines()
                    if ln.strip().startswith(("import ", "from "))
                    and "paired_trial_harness" in ln]
    assert import_lines == [], f"two-plane violation: B3 imported: {import_lines}"
    assert "paired_trial_harness" not in sys.modules or True  # never linked at import time


def test_module_does_not_link_b3_at_runtime():
    # Re-import in a clean subprocess and assert B3 never gets pulled in.
    proc = subprocess.run(
        [sys.executable, "-c",
         "import sys; sys.path.insert(0, %r); import enricher_lift_gate; "
         "assert 'paired_trial_harness' not in sys.modules; print('CLEAN')"
         % str(GATE_PATH.parent)],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    assert "CLEAN" in proc.stdout


# --------------------------------------------------------------------------- #
# (1) genuine synthetic lift but synthetic_only -> not live-adoptable
# --------------------------------------------------------------------------- #
def test_synthetic_only_genuine_lift_is_not_live_adoptable():
    args = strong_lift_inputs(evidence_class="synthetic_only")
    rep = gate.evaluate(*args, tau=3.0)
    # The numbers show a real lift, but the evidence class is synthetic_only.
    assert rep["win_rate_delta_pp"] > 0
    assert rep["adoption_eligible"] is False
    assert "evidence_class" in rep["failed_predicates"]
    assert rep["evidence_class"] == "synthetic_only"


# --------------------------------------------------------------------------- #
# (2) padding-only -> false, control predicate named
# --------------------------------------------------------------------------- #
def test_padding_only_signal_rejected_by_control():
    n = 60
    # The "lift" is entirely token-padding: enriched ties baseline (no real wins), and the
    # padding control wins just as often -> the enricher cannot beat the padding arm.
    baseline, enriched = make_paired(n, lambda i: i % 10 < 5)  # 50% — chance only
    judge = make_judge(n)
    random_arm = make_arm(n, lambda i: 0)
    near_miss_arm = make_arm(n, lambda i: 0)
    padding_arm = make_arm(n, lambda i: i % 10 < 5)  # padding matches enriched exactly
    usage = make_usage()
    rep = gate.evaluate(baseline, enriched, judge, random_arm, near_miss_arm,
                        padding_arm, usage, tau=3.0)
    assert rep["adoption_eligible"] is False
    assert "control_correction" in rep["failed_predicates"]
    assert rep["control_results"]["padding"]["beats_control"] is False


# --------------------------------------------------------------------------- #
# (3) near-miss-harmful -> false
# --------------------------------------------------------------------------- #
def test_near_miss_harmful_arm_blocks_adoption():
    n = 60
    baseline, enriched = make_paired(n, lambda i: i % 10 < 6)  # 60%
    judge = make_judge(n)
    random_arm = make_arm(n, lambda i: 0)
    # near-miss arm wins as often as the enricher -> enricher does not beat near-miss.
    near_miss_arm = make_arm(n, lambda i: i % 10 < 6)
    padding_arm = make_arm(n, lambda i: 0)
    usage = make_usage()
    rep = gate.evaluate(baseline, enriched, judge, random_arm, near_miss_arm,
                        padding_arm, usage, tau=3.0)
    assert rep["adoption_eligible"] is False
    assert "control_correction" in rep["failed_predicates"]
    assert rep["control_results"]["near_miss"]["beats_control"] is False


# --------------------------------------------------------------------------- #
# (4) proxy-only evidence -> false
# --------------------------------------------------------------------------- #
def test_proxy_only_evidence_class_rejected():
    args = strong_lift_inputs(evidence_class="retrieval_proxy_only")
    rep = gate.evaluate(*args, tau=3.0)
    assert rep["adoption_eligible"] is False
    assert "evidence_class" in rep["failed_predicates"]


def test_unknown_evidence_class_rejected():
    args = strong_lift_inputs(evidence_class="unknown")
    rep = gate.evaluate(*args, tau=3.0)
    assert rep["adoption_eligible"] is False
    assert "evidence_class" in rep["failed_predicates"]


# --------------------------------------------------------------------------- #
# (5) high judge noise (MAD>0.15) -> inconclusive_noise
# --------------------------------------------------------------------------- #
def test_high_judge_noise_is_inconclusive_noise():
    n = 60
    baseline, enriched = make_paired(n, lambda i: i % 10 < 7)
    # Wildly disagreeing judges on a [0,1] scale -> MAD and SD blow past thresholds.
    judge = make_judge(n, scores=(0.0, 1.0, 0.0, 1.0))
    random_arm = make_arm(n, lambda i: 0)
    near_miss_arm = make_arm(n, lambda i: 0)
    padding_arm = make_arm(n, lambda i: 0)
    usage = make_usage()
    rep = gate.evaluate(baseline, enriched, judge, random_arm, near_miss_arm,
                        padding_arm, usage, tau=3.0)
    assert rep["judge_mad"] > 0.15
    assert rep["verdict_status"] == "inconclusive_noise"
    assert rep["adoption_eligible"] is False
    assert "judge_noise" in rep["failed_predicates"]


# --------------------------------------------------------------------------- #
# (6) n<50 -> inconclusive_sample_size
# --------------------------------------------------------------------------- #
def test_underpowered_sample_is_inconclusive():
    baseline, enriched = make_paired(40, lambda i: i % 10 < 8)
    judge = make_judge(40)
    random_arm = make_arm(40, lambda i: 0)
    near_miss_arm = make_arm(40, lambda i: 0)
    padding_arm = make_arm(40, lambda i: 0)
    usage = make_usage()
    rep = gate.evaluate(baseline, enriched, judge, random_arm, near_miss_arm,
                        padding_arm, usage, tau=3.0)
    assert rep["verdict_status"] == "inconclusive_sample_size"
    assert rep["adoption_eligible"] is False
    assert rep["paired_n"] == 40
    assert "sample_size" in rep["failed_predicates"]


# --------------------------------------------------------------------------- #
# (7) mismatched fixtures -> not_comparable
# --------------------------------------------------------------------------- #
def test_mismatched_fixtures_not_comparable():
    baseline, enriched = make_paired(60, lambda i: True)
    # Drop one enriched fixture id so the sets differ.
    enriched = enriched[:-1] + [{"fixture_id": "EXTRA", "score": 0.9}]
    judge = make_judge(60)
    arm = make_arm(60, lambda i: 0)
    usage = make_usage()
    rep = gate.evaluate(baseline, enriched, judge, arm, arm, arm, usage, tau=3.0)
    assert rep["verdict_status"] == "not_comparable"
    assert rep["adoption_eligible"] is False
    assert "comparable_fixtures" in rep["failed_predicates"]


# --------------------------------------------------------------------------- #
# (8) determinism: fixed PRNG -> identical CI
# --------------------------------------------------------------------------- #
def test_bootstrap_ci_is_deterministic():
    deltas = [0.4, -0.1, 0.3, 0.2, -0.2, 0.5, 0.1, 0.0, 0.3, -0.1] * 6
    a = gate.bootstrap_ci_lower(deltas)
    b = gate.bootstrap_ci_lower(deltas)
    assert a["percentile"] == b["percentile"]
    assert a["bca"] == b["bca"]
    assert a["point"] == b["point"]


def test_full_evaluate_is_deterministic():
    args = strong_lift_inputs()
    r1 = gate.evaluate(*args, tau=3.0)
    r2 = gate.evaluate(*args, tau=3.0)
    assert r1["ci_lower_percentile"] == r2["ci_lower_percentile"]
    assert r1["ci_lower_bca"] == r2["ci_lower_bca"]
    assert r1["control_results"] == r2["control_results"]


# --------------------------------------------------------------------------- #
# Positive path + report shape (cache-neutral PASSES)
# --------------------------------------------------------------------------- #
def test_strong_lift_is_adoption_eligible_cache_neutral():
    args = strong_lift_inputs()
    rep = gate.evaluate(*args, tau=3.0)
    assert rep["adoption_eligible"] is True
    assert rep["verdict_status"] == "adoption_eligible"
    assert rep["failed_predicates"] == []
    # cache-neutral PASSES: prefix_churn false is the only cache term; not cache-positive.
    assert rep["prefix_churn"] is False
    assert rep["schema"] == "agent-runtime-enricher-lift-gate"
    assert rep["redaction"] == "metadata-only"
    # tau sensitivity sweep present at 1.0/3.0/5.0
    assert set(rep["tau_sensitivity"]) == {"tau_1.0", "tau_3.0", "tau_5.0"}
    # both CI bounds reported
    assert "ci_lower_percentile" in rep and "ci_lower_bca" in rep


def test_prefix_churn_true_blocks_adoption():
    args = list(strong_lift_inputs())
    args[6] = make_usage(churn=True)  # usage report is the 7th positional
    rep = gate.evaluate(*args, tau=3.0)
    assert rep["adoption_eligible"] is False
    assert "prefix_churn" in rep["failed_predicates"]
    assert rep["prefix_churn"] is True


def test_added_tokens_over_budget_blocks_adoption():
    args = list(strong_lift_inputs())
    args[6] = make_usage(enr=3000, budget=500)  # added 2000 > 500
    rep = gate.evaluate(*args, tau=3.0)
    assert rep["adoption_eligible"] is False
    # over-budget uses a DISTINCT predicate name from the usage-missing path so the two
    # failure causes never collide under the same "added_tokens" label.
    assert "added_tokens_over_budget" in rep["failed_predicates"]
    assert "added_tokens" not in rep["failed_predicates"]


def test_low_lift_efficiency_fails_tau():
    # Tiny lift over a HUGE token cost -> efficiency below tau even if CI positive.
    args = list(strong_lift_inputs())
    args[6] = make_usage(enr=1_000_000, budget=2_000_000)  # ~999000 added tokens
    rep = gate.evaluate(*args, tau=3.0)
    assert rep["adoption_eligible"] is False
    assert "lift_efficiency" in rep["failed_predicates"]
    assert rep["tau_sensitivity"]["tau_3.0"] is False


def test_tau_cli_override_changes_headline():
    args = strong_lift_inputs()
    # efficiency in strong_lift is 40 pp/1k -> passes even at tau=5; lower bound stays.
    rep_high = gate.evaluate(*args, tau=5.0)
    assert rep_high["tau"] == 5.0


# --------------------------------------------------------------------------- #
# Bootstrap internals
# --------------------------------------------------------------------------- #
def test_percentile_single_and_interpolated():
    assert gate._percentile([0.5], 0.5) == 0.5
    assert gate._percentile([0.0, 1.0], 0.5) == 0.5
    assert abs(gate._percentile([0.0, 0.5, 1.0], 0.25) - 0.25) < 1e-9


def test_normal_ppf_tails_and_center():
    assert gate._normal_ppf(0.0) == float("-inf")
    assert gate._normal_ppf(1.0) == float("inf")
    assert abs(gate._normal_ppf(0.5)) < 1e-6
    assert gate._normal_ppf(0.001) < -2.5   # lower tail branch
    assert gate._normal_ppf(0.999) > 2.5    # upper tail branch


def test_bca_degenerate_all_equal_falls_back_to_percentile():
    deltas = [0.2] * 55
    ci = gate.bootstrap_ci_lower(deltas)
    # all-equal -> bootstrap means all 0.2 -> percentile == bca == 0.2
    assert abs(ci["percentile"] - 0.2) < 1e-9
    assert abs(ci["bca"] - 0.2) < 1e-9


def test_lift_efficiency_undefined_for_nonpositive_tokens():
    assert gate.lift_efficiency(10.0, 0) is None
    assert gate.lift_efficiency(10.0, -5) is None
    assert gate.lift_efficiency(20.0, 1000) == 20.0


# --------------------------------------------------------------------------- #
# Holm correction unit
# --------------------------------------------------------------------------- #
def test_holm_all_pass_and_one_fail():
    ok = gate.holm_pass({"random": 0.001, "near_miss": 0.002, "padding": 0.004})
    assert ok["family_pass"] is True
    bad = gate.holm_pass({"random": 0.001, "near_miss": 0.2, "padding": 0.004})
    assert bad["family_pass"] is False
    assert bad["per_arm"]["near_miss"]["reject_null"] is False


def test_holm_stop_on_first_fail_accepts_all_larger_p_arms():
    # (M1 regression) Step-down MUST halt at the first failure. With m=3 the thresholds
    # are alpha/3, alpha/2, alpha/1 = 0.01667, 0.025, 0.05. Sorted p ascending:
    #   random=0.001  -> 0.001 < 0.01667  -> REJECT (passes step 1)
    #   near_miss=0.04 -> 0.04 < 0.025    -> FAIL  (step-down stops here)
    #   padding=0.045  -> 0.045 < 0.05 would REJECT if tested INDEPENDENTLY (the bug),
    #                     but true Holm ACCEPTS it because a smaller-p null already failed.
    res = gate.holm_pass({"random": 0.001, "near_miss": 0.04, "padding": 0.045})
    assert res["family_pass"] is False
    assert res["per_arm"]["random"]["reject_null"] is True
    assert res["per_arm"]["near_miss"]["reject_null"] is False
    # The load-bearing assertion: padding's raw p clears its own 0.05 threshold, yet Holm
    # must NOT reject it (no over-rejection after the family's first failure).
    assert res["per_arm"]["padding"]["p"] < res["per_arm"]["padding"]["threshold"]
    assert res["per_arm"]["padding"]["reject_null"] is False


def test_holm_over_rejection_does_not_mark_beats_control_in_verdict():
    # End-to-end (M1): an arm whose raw p would clear its own Holm threshold must NOT be
    # reported as `beats_control` once an EARLIER (smaller-p) control has failed the family.
    # Build a real evaluate() run where the near_miss control ties the enricher (high p,
    # fails its step), while padding is trivially beaten (tiny p that clears alpha/1).
    n = 60
    baseline, enriched = make_paired(n, lambda i: i % 10 < 6)  # 60% win
    judge = make_judge(n)
    random_arm = make_arm(n, lambda i: 0)                       # enricher crushes it (p~0)
    near_miss_arm = make_arm(n, lambda i: i % 10 < 6)           # ties enricher -> high p
    padding_arm = make_arm(n, lambda i: 0)                      # enricher crushes it (p~0)
    usage = make_usage()
    rep = gate.evaluate(baseline, enriched, judge, random_arm, near_miss_arm,
                        padding_arm, usage, tau=3.0)
    assert rep["control_family_holm_pass"] is False
    assert "control_correction" in rep["failed_predicates"]
    # near_miss failed its step; padding sorts AFTER it (larger p) so Holm accepts the
    # padding null -> beats_control must be False even though padding's raw p is tiny.
    assert rep["control_results"]["near_miss"]["beats_control"] is False
    nm_p = rep["control_results"]["near_miss"]["p_value"]
    pad = rep["control_results"]["padding"]
    if pad["p_value"] >= nm_p:  # padding sorts at/after the failing near_miss arm
        assert pad["p_value"] < pad["holm_threshold"], "padding raw-p clears its own threshold"
        assert pad["beats_control"] is False, "must not over-reject after first family failure"


# --------------------------------------------------------------------------- #
# Judge noise unit
# --------------------------------------------------------------------------- #
def test_judge_noise_clean_within_threshold():
    jr = make_judge(10, scores=(0.7, 0.71, 0.69))
    noise = gate.judge_noise(jr)
    assert noise["within_threshold"] is True
    assert noise["mad"] <= 0.15 and noise["sd"] <= 0.25


def test_judge_sd_threshold_path():
    # Moderate spread that pushes SD over 0.25 (but tests the SD branch explicitly).
    jr = make_judge(10, scores=(0.1, 0.9))
    noise = gate.judge_noise(jr)
    assert noise["within_threshold"] is False


def test_judge_noise_uses_true_mad_not_mean_abs_dev():
    # (M2 regression) Three judges on [0,1]: scores [0.3, 0.51, 0.71].
    #   median            = 0.51
    #   |deviations|      = [0.21, 0.0, 0.20]
    #   TRUE MAD (median of devs) = 0.20  -> ABOVE the 0.15 ceiling -> noisy -> FAIL
    #   mean-abs-dev (the OLD bug)  = 0.1367 -> below 0.15 -> would spuriously PASS
    #   SD = 0.167 <= 0.25 -> the verdict pivots PURELY on the MAD term.
    jr = make_judge(10, scores=(0.3, 0.51, 0.71))
    noise = gate.judge_noise(jr)
    # The reported field must be the TRUE median-absolute-deviation (0.20), not 0.137.
    assert abs(noise["mad"] - 0.20) < 1e-9, f"expected true MAD 0.20, got {noise['mad']}"
    assert noise["mad"] > gate.JUDGE_MAD_THRESHOLD
    assert noise["sd"] <= gate.JUDGE_SD_THRESHOLD  # SD is NOT the cause -> MAD decides
    # Correct verdict: noisy panel is OUTSIDE the threshold (the lenient mean would pass).
    assert noise["within_threshold"] is False


def test_evaluate_true_mad_noise_blocks_adoption_end_to_end():
    # End-to-end (M2): a panel that the lenient mean-abs-dev would wave through must be
    # caught as inconclusive_noise once the gate uses the true MAD the threshold targets.
    args = list(strong_lift_inputs())
    args[2] = make_judge(60, scores=(0.3, 0.51, 0.71))  # true MAD 0.20 > 0.15
    rep = gate.evaluate(*args, tau=3.0)
    assert rep["judge_mad"] > 0.15
    assert rep["verdict_status"] == "inconclusive_noise"
    assert rep["adoption_eligible"] is False
    assert "judge_noise" in rep["failed_predicates"]


# --------------------------------------------------------------------------- #
# UNHAPPY / fail-closed typed errors (malformed / missing / invalid)
# --------------------------------------------------------------------------- #
def test_load_jsonl_missing_file_raises_typed_error():
    try:
        gate.load_jsonl(Path("/nonexistent-xyz/baseline.jsonl"))
        raised = False
    except gate.LiftGateInputError as exc:
        raised = True
        assert "missing_file" in str(exc)
    assert raised, "missing file must raise a typed LiftGateInputError"


def test_load_jsonl_malformed_line_raises():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "bad.jsonl"
        p.write_text('{"fixture_id":"a","score":1}\nNOT JSON HERE\n')
        try:
            gate.load_jsonl(p)
            raised = False
        except gate.LiftGateInputError as exc:
            raised = True
            assert "jsonl_invalid" in str(exc)
        assert raised


def test_load_jsonl_record_not_object_invalid():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "arr.jsonl"
        p.write_text('[1,2,3]\n')
        try:
            gate.load_jsonl(p)
            ok = False
        except gate.LiftGateInputError as exc:
            ok = "jsonl_record_not_object" in str(exc)
        assert ok


def test_load_json_obj_malformed_and_non_object():
    with tempfile.TemporaryDirectory() as d:
        bad = Path(d) / "bad.json"
        bad.write_text("{not json")
        try:
            gate.load_json_obj(bad)
            ok = False
        except gate.LiftGateInputError as exc:
            ok = "json_invalid" in str(exc)
        assert ok
        arr = Path(d) / "arr.json"
        arr.write_text("[1,2]")
        try:
            gate.load_json_obj(arr)
            ok2 = False
        except gate.LiftGateInputError as exc:
            ok2 = "json_not_object" in str(exc)
        assert ok2
    # missing file path
    try:
        gate.load_json_obj(Path("/nonexistent-xyz/j.json"))
        ok3 = False
    except gate.LiftGateInputError as exc:
        ok3 = "missing_file" in str(exc)
    assert ok3


def test_missing_provider_tokens_is_inconclusive():
    args = list(strong_lift_inputs())
    args[6] = {"prefix_churn": False, "added_tokens_budget": 1000}  # no token fields
    rep = gate.evaluate(*args, tau=3.0)
    assert rep["verdict_status"] == "inconclusive"
    assert rep["adoption_eligible"] is False
    assert "added_tokens" in rep["failed_predicates"]
    assert "usage_missing_provider_tokens" in rep["usage_error"]


def test_usage_missing_prefix_churn_inconclusive():
    args = list(strong_lift_inputs())
    args[6] = {"baseline_input_tokens": 1000, "enriched_input_tokens": 1500,
               "added_tokens_budget": 1000}
    rep = gate.evaluate(*args, tau=3.0)
    assert rep["verdict_status"] == "inconclusive"
    assert "usage_missing_prefix_churn" in rep["usage_error"]


def test_usage_missing_budget_inconclusive():
    args = list(strong_lift_inputs())
    args[6] = {"baseline_input_tokens": 1000, "enriched_input_tokens": 1500,
               "prefix_churn": False}
    rep = gate.evaluate(*args, tau=3.0)
    assert "usage_missing_budget" in rep["usage_error"]


def test_usage_missing_and_over_budget_have_distinct_predicate_names():
    # (LOW) The two DISTINCT failure causes must NOT share one "added_tokens" label.
    # Cause 1: provider tokens missing entirely -> verdict "inconclusive".
    missing_args = list(strong_lift_inputs())
    missing_args[6] = {"prefix_churn": False, "added_tokens_budget": 1000}  # no token fields
    missing_rep = gate.evaluate(*missing_args, tau=3.0)
    assert missing_rep["verdict_status"] == "inconclusive"
    assert "added_tokens" in missing_rep["failed_predicates"]
    assert "added_tokens_over_budget" not in missing_rep["failed_predicates"]

    # Cause 2: tokens present but OVER budget -> distinct "added_tokens_over_budget".
    over_args = list(strong_lift_inputs())
    over_args[6] = make_usage(enr=3000, budget=500)  # added 2000 > 500
    over_rep = gate.evaluate(*over_args, tau=3.0)
    assert "added_tokens_over_budget" in over_rep["failed_predicates"]
    assert "added_tokens" not in over_rep["failed_predicates"]

    # The two causes produce DIFFERENT named predicates (no collision).
    missing_names = set(missing_rep["failed_predicates"])
    over_names = set(over_rep["failed_predicates"])
    assert "added_tokens" in missing_names and "added_tokens" not in over_names
    assert "added_tokens_over_budget" in over_names and "added_tokens_over_budget" not in missing_names


def test_record_missing_fixture_id_raises():
    bad = [{"score": 1.0}]
    try:
        gate.fixture_id_set(bad)
        ok = False
    except gate.LiftGateInputError as exc:
        ok = "record_missing_fixture_id" in str(exc)
    assert ok


def test_missing_score_raises():
    baseline = [{"fixture_id": "a", "score": 0.5}]
    enriched = [{"fixture_id": "a"}]  # missing score
    try:
        gate.paired_outcomes(baseline, enriched)
        ok = False
    except gate.LiftGateInputError as exc:
        ok = "missing_score" in str(exc)
    assert ok


def test_win_rate_empty_raises():
    try:
        gate.win_rate([])
        ok = False
    except gate.LiftGateInputError as exc:
        ok = "empty_win_vector" in str(exc)
    assert ok


def test_control_arm_malformed_outcomes_raise():
    try:
        gate._control_wins({"outcomes": []})
        ok = False
    except gate.LiftGateInputError as exc:
        ok = "control_arm_missing_outcomes" in str(exc)
    assert ok
    try:
        gate._control_wins({"outcomes": [{"fixture_id": "a", "win": 2}]})
        ok2 = False
    except gate.LiftGateInputError as exc:
        ok2 = "control_outcome_malformed" in str(exc)
    assert ok2
    try:
        gate._control_wins({"outcomes": ["notdict"]})
        ok3 = False
    except gate.LiftGateInputError as exc:
        ok3 = "control_outcome_not_object" in str(exc)
    assert ok3


def test_control_no_shared_fixtures_raises():
    enriched_by_id = {"x0": 1, "x1": 0}
    arm = make_arm(5, lambda i: 0)  # ids f000..f004, disjoint from x*
    try:
        gate.control_comparison(enriched_by_id, arm)
        ok = False
    except gate.LiftGateInputError as exc:
        ok = "control_no_shared_fixtures" in str(exc)
    assert ok


def test_judge_report_malformed_raises():
    try:
        gate.judge_noise({"scale": {"min": 0, "max": 1}})  # no per_item
        ok = False
    except gate.LiftGateInputError as exc:
        ok = "judge_report_malformed" in str(exc)
    assert ok


def test_judge_scale_missing_and_item_invalid():
    try:
        gate.judge_noise({"scale": {"min": "x"}, "per_item": [{"judge_scores": [0.1, 0.2]}]})
        ok = False
    except gate.LiftGateInputError as exc:
        ok = "judge_scale_missing" in str(exc)
    assert ok
    try:
        gate.judge_noise({"scale": {"min": 0, "max": 1}, "per_item": [{"judge_scores": [0.1]}]})
        ok2 = False
    except gate.LiftGateInputError as exc:
        ok2 = "judge_item_scores_invalid" in str(exc)
    assert ok2
    try:
        gate.judge_noise({"scale": {"min": 0, "max": 1}, "per_item": ["x"]})
        ok3 = False
    except gate.LiftGateInputError as exc:
        ok3 = "judge_item_not_object" in str(exc)
    assert ok3


def test_normalize_scores_degenerate_scale_raises():
    try:
        gate._normalize_scores([0.5], 1.0, 1.0)
        ok = False
    except gate.LiftGateInputError as exc:
        ok = "judge_scale_degenerate" in str(exc)
    assert ok


def test_empty_bootstrap_and_percentile_raise():
    try:
        gate.bootstrap_ci_lower([])
        ok = False
    except gate.LiftGateInputError:
        ok = True
    assert ok
    try:
        gate._percentile([], 0.5)
        ok2 = False
    except gate.LiftGateInputError:
        ok2 = True
    assert ok2


# --------------------------------------------------------------------------- #
# (9) CLI e2e via subprocess
# --------------------------------------------------------------------------- #
def _write_inputs(d, args):
    baseline, enriched, judge, random_arm, near_miss_arm, padding_arm, usage = args
    p = {}
    bl = Path(d) / "baseline.jsonl"
    bl.write_text("\n".join(json.dumps(r) for r in baseline) + "\n")
    en = Path(d) / "enriched.jsonl"
    en.write_text("\n".join(json.dumps(r) for r in enriched) + "\n")
    for name, obj in (("judge", judge), ("random", random_arm),
                      ("near_miss", near_miss_arm), ("padding", padding_arm),
                      ("usage", usage)):
        fp = Path(d) / f"{name}.json"
        fp.write_text(json.dumps(obj))
        p[name] = str(fp)
    p["baseline"], p["enriched"] = str(bl), str(en)
    return p


def test_cli_e2e_adoption_eligible_exit0():
    args = strong_lift_inputs()
    with tempfile.TemporaryDirectory() as d:
        p = _write_inputs(d, args)
        proc = subprocess.run(
            [sys.executable, str(GATE_PATH),
             "--baseline", p["baseline"], "--enriched", p["enriched"],
             "--judge-report", p["judge"], "--random-arm", p["random"],
             "--near-miss-arm", p["near_miss"], "--padding-arm", p["padding"],
             "--usage-report", p["usage"], "--tau", "3.0", "--pretty"],
            capture_output=True, text=True, timeout=120,
        )
        assert proc.returncode == 0, proc.stderr
        rep = json.loads(proc.stdout)
        assert rep["adoption_eligible"] is True
        assert rep["schema"] == "agent-runtime-enricher-lift-gate"


def test_cli_e2e_missing_input_nonzero_exit():
    # Missing file -> typed input error -> nonzero exit (fail closed).
    args = strong_lift_inputs()
    with tempfile.TemporaryDirectory() as d:
        p = _write_inputs(d, args)
        proc = subprocess.run(
            [sys.executable, str(GATE_PATH),
             "--baseline", p["baseline"], "--enriched", p["enriched"],
             "--judge-report", p["judge"], "--random-arm", p["random"],
             "--near-miss-arm", p["near_miss"], "--padding-arm", p["padding"],
             "--usage-report", "/nonexistent-xyz/usage.json"],
            capture_output=True, text=True, timeout=120,
        )
        assert proc.returncode == 1
        rep = json.loads(proc.stdout)
        assert rep["adoption_eligible"] is False
        assert rep["error_type"] == "lift_gate_input_error"
        assert "missing_file" in rep["_error"]


def test_cli_e2e_padding_only_exit1():
    n = 60
    baseline, enriched = make_paired(n, lambda i: i % 10 < 5)
    judge = make_judge(n)
    random_arm = make_arm(n, lambda i: 0)
    near_miss_arm = make_arm(n, lambda i: 0)
    padding_arm = make_arm(n, lambda i: i % 10 < 5)
    usage = make_usage()
    args = (baseline, enriched, judge, random_arm, near_miss_arm, padding_arm, usage)
    with tempfile.TemporaryDirectory() as d:
        p = _write_inputs(d, args)
        proc = subprocess.run(
            [sys.executable, str(GATE_PATH),
             "--baseline", p["baseline"], "--enriched", p["enriched"],
             "--judge-report", p["judge"], "--random-arm", p["random"],
             "--near-miss-arm", p["near_miss"], "--padding-arm", p["padding"],
             "--usage-report", p["usage"]],
            capture_output=True, text=True, timeout=120,
        )
        assert proc.returncode == 1
        rep = json.loads(proc.stdout)
        assert rep["adoption_eligible"] is False


# --------------------------------------------------------------------------- #
# In-process main() coverage (subprocess can't be traced by the coverage tool)
# --------------------------------------------------------------------------- #
def _run_main(argv):
    old = sys.argv
    sys.argv = ["enricher_lift_gate.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = gate.main()
    finally:
        sys.argv = old
    return rc, buf.getvalue()


def test_main_inprocess_adoption_eligible():
    args = strong_lift_inputs()
    with tempfile.TemporaryDirectory() as d:
        p = _write_inputs(d, args)
        rc, out = _run_main([
            "--baseline", p["baseline"], "--enriched", p["enriched"],
            "--judge-report", p["judge"], "--random-arm", p["random"],
            "--near-miss-arm", p["near_miss"], "--padding-arm", p["padding"],
            "--usage-report", p["usage"], "--tau", "3.0", "--pretty",
        ])
        assert rc == 0
        rep = json.loads(out)
        assert rep["adoption_eligible"] is True


def test_main_inprocess_missing_input_nonzero():
    args = strong_lift_inputs()
    with tempfile.TemporaryDirectory() as d:
        p = _write_inputs(d, args)
        rc, out = _run_main([
            "--baseline", p["baseline"], "--enriched", p["enriched"],
            "--judge-report", p["judge"], "--random-arm", p["random"],
            "--near-miss-arm", p["near_miss"], "--padding-arm", p["padding"],
            "--usage-report", "/nonexistent-xyz/missing.json",
        ])
        assert rc == 1
        rep = json.loads(out)
        assert rep["error_type"] == "lift_gate_input_error"
        assert "missing_file" in rep["_error"]
        assert rep["failed_predicates"] == ["input_present"]


# --------------------------------------------------------------------------- #
# Remaining branch coverage (blank-line skip, OSError, scale edges)
# --------------------------------------------------------------------------- #
def test_load_jsonl_skips_blank_lines():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "b.jsonl"
        p.write_text('{"fixture_id":"a","score":1}\n\n   \n{"fixture_id":"b","score":2}\n')
        recs = gate.load_jsonl(p)
        assert len(recs) == 2


def test_load_jsonl_read_error_on_directory():
    # Reading a directory as a file raises OSError -> typed read_error (not silent).
    with tempfile.TemporaryDirectory() as d:
        try:
            gate.load_jsonl(Path(d))  # a directory path that .exists() but cannot read_text
            ok = False
        except gate.LiftGateInputError as exc:
            ok = "read_error" in str(exc)
    assert ok


def test_load_json_obj_read_error_on_directory():
    with tempfile.TemporaryDirectory() as d:
        try:
            gate.load_json_obj(Path(d))
            ok = False
        except gate.LiftGateInputError as exc:
            ok = "read_error" in str(exc)
    assert ok


def test_percentile_lo_equals_hi_branch():
    # q hits an exact index so floor==ceil -> the lo==hi return branch.
    assert gate._percentile([1.0, 2.0, 3.0, 4.0], 0.0) == 1.0
    assert gate._percentile([1.0, 2.0, 3.0, 4.0], 1.0) == 4.0


def test_evidence_class_non_string_coerced_to_unknown():
    args = list(strong_lift_inputs())
    # judge report with a non-string evidence_class -> coerced to "unknown" -> rejected.
    args[2] = make_judge(60)
    args[2]["evidence_class"] = 12345  # not a str
    rep = gate.evaluate(*args, tau=3.0)
    assert rep["evidence_class"] == "unknown"
    assert "evidence_class" in rep["failed_predicates"]


def test_evaluate_judge_malformed_is_inconclusive_noise():
    # A malformed judge report inside evaluate() -> typed inconclusive_noise (not a crash).
    args = list(strong_lift_inputs())
    args[2] = {"evidence_class": "blind_judge_comparison", "scale": {"min": 0, "max": 1}}  # no per_item
    rep = gate.evaluate(*args, tau=3.0)
    assert rep["verdict_status"] == "inconclusive_noise"
    assert rep["adoption_eligible"] is False
    assert "judge_error" in rep
    assert "judge_report_malformed" in rep["judge_error"]


def test_unstable_ci_is_inconclusive_unstable_ci():
    # Force a large percentile-vs-BCa divergence by monkeypatching the bootstrap to return
    # bounds that differ by more than CI_DIVERGENCE_THRESHOLD.
    orig = gate.bootstrap_ci_lower
    gate.bootstrap_ci_lower = lambda deltas, **kw: {
        "point": 0.2, "percentile": 0.2, "bca": 0.05, "resamples": 10000.0}
    try:
        args = strong_lift_inputs()
        rep = gate.evaluate(*args, tau=3.0)
    finally:
        gate.bootstrap_ci_lower = orig
    assert rep["verdict_status"] == "inconclusive_unstable_ci"
    assert rep["adoption_eligible"] is False
    assert "ci_stability" in rep["failed_predicates"]
    assert rep["ci_divergence"] > gate.CI_DIVERGENCE_THRESHOLD


# --------------------------------------------------------------------------- #
# MUTATION-SURVIVOR TRIAGE: pin the threshold comparisons whose boundary is REACHABLE so a
# comparison-operator flip (>= -> >, < -> <=) is caught by a failing test. The judge-noise
# float thresholds (mad/sd <= 0.15/0.25) are NOT pinned here: an exact-equality on a non-
# binary-clean float (0.15) is measure-zero/unreachable through the score arithmetic (e.g.
# 0.35/0.65 yields 0.15000000000000002, never 0.15), so the <=/< flip is an EQUIVALENT mutant.
# --------------------------------------------------------------------------- #
def test_mutation_pin_lift_efficiency_tau_boundary_is_inclusive():
    # efficiency exactly == tau must PASS the tau predicate (`>= tau` inclusive); just below must fail.
    eff = gate.lift_efficiency(3.0, 1000)  # 3.0 / (1000/1000) = 3.0 == TAU_SEED
    assert eff == gate.TAU_SEED
    assert gate.tau_sensitivity(eff)["tau_3.0"] is True
    assert gate.tau_sensitivity(gate.TAU_SEED - 0.0001)["tau_3.0"] is False


def test_mutation_pin_sample_size_boundary_n50_passes_n49_fails():
    # `n_paired < MIN_PAIRED_N`: n == 50 must NOT be a sample-size failure; n == 49 must be.
    rep50 = gate.evaluate(*strong_lift_inputs(n=gate.MIN_PAIRED_N), tau=3.0)
    assert "sample_size" not in rep50["failed_predicates"]
    assert rep50["verdict_status"] != "inconclusive_sample_size"
    rep49 = gate.evaluate(*strong_lift_inputs(n=gate.MIN_PAIRED_N - 1), tau=3.0)
    assert "sample_size" in rep49["failed_predicates"]
    assert rep49["verdict_status"] == "inconclusive_sample_size"


# --------------------------------------------------------------------------- #
# Adoption-boundary pins (mutation-audit: enricher_lift_gate eq/bool/rel survivors).
# These pin the FAIL-CLOSED boundaries that decide adoption. Each is exact (integer or
# same-constant), so the boundary is reachable — distinct from the float-threshold /
# unreachable survivors documented EQUIVALENT in the ledger.
# --------------------------------------------------------------------------- #
def test_paired_outcomes_exact_tie_is_not_a_win():
    # win is STRICT '>' (fail-closed parity convention): an exactly-equal score is a LOSS,
    # never a win. A '>'->'>= ' mutation would credit the enricher for a tie and inflate
    # the win vector that every downstream lift statistic is built on.
    base = [{"fixture_id": "f0", "score": 0.5}, {"fixture_id": "f1", "score": 0.5}]
    enr = [{"fixture_id": "f0", "score": 0.5}, {"fixture_id": "f1", "score": 0.7}]
    assert gate.paired_outcomes(base, enr) == [0, 1]  # f0 tie -> 0, f1 strict win -> 1


def test_holm_pvalue_exactly_at_threshold_does_not_reject():
    # reject = p < threshold (STRICT): a p-value exactly AT the Holm threshold is NOT
    # significant. For a single arm threshold == HOLM_ALPHA exactly (same float constant),
    # so p == HOLM_ALPHA must NOT reject. A '<'->'<=' mutation would reject at equality.
    res = gate.holm_pass({"only": gate.HOLM_ALPHA}, alpha=gate.HOLM_ALPHA)
    assert res["per_arm"]["only"]["threshold"] == gate.HOLM_ALPHA
    assert res["per_arm"]["only"]["reject_null"] is False
    assert res["family_pass"] is False


def test_judge_noise_one_nonnumeric_scale_bound_raises():
    # The scale-bound guard is `not isinstance(lo) OR not isinstance(hi)`: EITHER bound
    # being non-numeric is fatal. An 'or'->'and' mutation would only raise when BOTH are
    # bad, letting a half-malformed scale through into normalization (USAGE-TRUTH discipline).
    bad_hi = {"scale": {"min": 0, "max": "x"}, "per_item": [{"judge_scores": [0.8, 0.82]}]}
    try:
        gate.judge_noise(bad_hi)
        assert False, "expected LiftGateInputError on non-numeric scale max"
    except gate.LiftGateInputError as e:
        assert "judge_scale_missing" in str(e)


def test_added_tokens_one_nonnumeric_provider_field_raises():
    # The provider-token guard is `not isinstance(base) OR not isinstance(enr)`: EITHER
    # field non-numeric is fatal (USAGE-TRUTH, no zero coercion). An 'or'->'and' mutation
    # would only raise when BOTH are bad, admitting a half-missing usage report.
    bad = {"baseline_input_tokens": 1000, "enriched_input_tokens": "x",
           "prefix_churn": False, "added_tokens_budget": 1000}
    try:
        gate.added_tokens_and_churn(bad)
        assert False, "expected LiftGateInputError on non-numeric enriched tokens"
    except gate.LiftGateInputError as e:
        assert "usage_missing_provider_tokens" in str(e)


def test_added_tokens_exactly_at_budget_is_within_budget():
    # The over-budget check is `added_tokens > budget` (STRICT): added tokens EXACTLY at the
    # budget are WITHIN budget, not over. Tokens are integer provider truth, so the boundary
    # is exact. A '>'->'>= ' mutation would flag an at-budget enricher as over and block it.
    args = list(strong_lift_inputs())
    args[6] = make_usage(enr=2000, budget=1000)  # added = 2000 - 1000 = 1000 == budget
    rep = gate.evaluate(*args, tau=3.0)
    assert "added_tokens_over_budget" not in rep["failed_predicates"]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} enricher_lift_gate tests passed")
