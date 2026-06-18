#!/usr/bin/env python3
"""enricher_lift_gate.py — Bead 2.5: the H1 make-or-break ADOPTION GATE for the enricher plane.

This is the statistically rigorous decision of whether an additive enricher (added
context for QUALITY) can EVER be adopted. The enricher plane is adopted ONLY on a proven
QUALITY LIFT — never on cost/cache reduction. The reducer plane's B3 paired-trial harness
adopts on a cache-reduction gate; the two planes MUST NOT share verdict logic.

TWO-PLANE SEPARATION (load-bearing): this module DELIBERATELY does NOT
`import paired_trial_harness` (B3) and reuses none of B3's verdict logic. The enricher is
adopted on QUALITY LIFT, never on B3's cache-reduction gate. A future corpus_guard
`two_plane_separation` check (Bead 4.3) will assert that this module never imports B3 —
it is written clean now. (CACHE-NEUTRAL): an additive enricher is cache-NEUTRAL by
design; there is NO cache-positive requirement here. The only cache term in the verdict
is `prefix_churn == false` — added tokens are PRICED INTO the lift (LiftEfficiency), and
prefix churn is reported/gated separately, never rewarded.

VERDICT (`adoption_eligible` true iff ALL of):
  1. comparable_fixtures        — baseline and enriched cover the SAME fixture-id set
                                   (else verdict_status="not_comparable").
  2. evidence_class ∈ {direct_task_outcome, blind_judge_comparison}
                                   — proxy/raw_token_percent/synthetic_only/unknown are
                                   NOT sufficient.
  3. bootstrap_ci_lower > 0      — the paired win-rate-delta bootstrap lower bound (BOTH
                                   percentile AND BCa) must clear zero.
  4. lift_efficiency >= tau      — LiftEfficiency = win_rate_delta_pp / (added_tokens/1000).
  5. controls pass Holm/global   — beats random, near_miss, AND padding under Holm
                                   step-down correction (uncorrected p<0.05 is NOT proof).
  6. judge_noise within thresh   — inter-judge MAD <= 0.15 AND SD <= 0.25 (normalized).
  7. added_tokens <= budget      — provider-truth added tokens within the budget.
  8. prefix_churn == false       — the ONLY cache term (cache-neutral passes).

LiftEfficiency = win_rate_delta_pp / (added_tokens / 1000)   [pp per 1k added tokens]

CONSTANTS (CAPE plan section 7 — implemented EXACTLY):
  - tau_seed = 3.0 pp/1k; the report carries a sensitivity sweep at tau ∈ {1.0,3.0,5.0}
    PLUS the headline verdict at the CLI/seed tau.
  - Minimum n >= 50 paired fixtures per arm for ANY adoption verdict; smaller ->
    verdict_status="inconclusive_sample_size".
  - Bootstrap uses >= 10000 resamples with a FIXED seeded random.Random(BOOTSTRAP_SEED);
    BOTH percentile AND BCa lower bounds are computed. Material divergence between them
    (> CI_DIVERGENCE_THRESHOLD on the win-rate scale) -> "inconclusive_unstable_ci".
  - Controls: Holm step-down correction over {random, near_miss, padding}; uncorrected
    p<0.05 is NOT adoption evidence.
  - Judge noise: scores normalize to [0,1]; inter-judge MAD > 0.15 OR SD > 0.25 ->
    "inconclusive_noise".

UNHAPPY (fail-closed, typed — NO bare return/pass/continue):
  - mismatched fixtures          -> verdict_status="not_comparable".
  - missing any arm/report       -> verdict_status="ineligible".
  - excessive judge noise        -> verdict_status="inconclusive_noise".
  - proxy-only / disallowed class -> adoption_eligible=false (class predicate fails).
  - missing provider tokens      -> verdict_status="inconclusive".
  - n < 50                       -> verdict_status="inconclusive_sample_size".

EMIT (metadata-only): never raw prompt/judge/fixture text — only counts, rates, hashes,
class labels, and named failed predicates.

CLI: python3 enricher_lift_gate.py --baseline <jsonl> --enriched <jsonl>
        --judge-report <json> --random-arm <json> --near-miss-arm <json>
        --padding-arm <json> --usage-report <json> [--tau 3.0] [--pretty]
Output: metadata-only JSON report to stdout.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import statistics
import sys
from pathlib import Path
from typing import Any

from probelib import redact

SCHEMA = "agent-runtime-enricher-lift-gate"
SCHEMA_VERSION = "0.1"

# --- Lift-gate seed constants (CAPE plan section 7 — implement EXACTLY) ---
TAU_SEED = 3.0                       # pp per 1k added tokens (heuristic seed)
TAU_SWEEP = (1.0, 3.0, 5.0)          # reported sensitivity sweep
MIN_PAIRED_N = 50                    # min paired fixtures per arm for any adoption verdict
BOOTSTRAP_RESAMPLES = 10000          # >= 10000 resamples
BOOTSTRAP_SEED = 20260616            # FIXED seed -> deterministic CI (determinism test)
CI_DIVERGENCE_THRESHOLD = 0.1        # material percentile-vs-BCa divergence (win-rate scale)
JUDGE_MAD_THRESHOLD = 0.15           # inter-judge MAD ceiling
JUDGE_SD_THRESHOLD = 0.25            # inter-judge SD ceiling
HOLM_ALPHA = 0.05                    # family-wise alpha for Holm step-down

# Evidence classes that may carry an enricher adoption (CAPE plan section 7 taxonomy).
ALLOWED_EVIDENCE_CLASSES = ("direct_task_outcome", "blind_judge_comparison")
# Classes that are NEVER sufficient on their own (named for the report).
INSUFFICIENT_EVIDENCE_CLASSES = (
    "synthetic_only", "retrieval_proxy_only", "raw_token_percent_only",
    "deterministic_verifier", "proxy", "unknown",
)

CONTROL_ARMS = ("random", "near_miss", "padding")

# Stable arm name used for the MAIN (enriched-over-coin-flip) lift bootstrap. Distinct from
# the control arm names so the main CI and each control draw INDEPENDENT resample streams.
MAIN_LIFT_ARM = "main_lift"


class LiftGateInputError(ValueError):
    """Raised when a required input file is missing or structurally invalid (fail closed)."""


def _stable_arm_seed(arm_name: str, base_seed: int = BOOTSTRAP_SEED) -> int:
    """Derive a DETERMINISTIC, per-arm bootstrap seed from a stable hash of the arm name.

    PRNG-CORRELATION FIX: re-seeding random.Random to the SAME BOOTSTRAP_SEED for the main
    lift AND every control arm produced IDENTICAL (correlated) resample index sequences,
    weakening the independence the Holm family assumes. Here we offset BOOTSTRAP_SEED by a
    stable hash of the arm name so each arm draws an INDEPENDENT resample stream while
    staying FULLY reproducible (same inputs -> identical CI/p-values across runs).

    We use sha256 (the low 64 bits, stable across processes) — NOT Python's builtin hash(),
    which is salted per-process (PYTHONHASHSEED) and would break determinism across runs.
    """
    digest = hashlib.sha256(arm_name.encode("utf-8")).hexdigest()[:16]
    return base_seed + int(digest, 16)


# --------------------------------------------------------------------------- #
# Input loading (typed, fail-closed)
# --------------------------------------------------------------------------- #
def load_jsonl(path: Path) -> list[dict[str, Any]]:
    """Load a JSONL report file into a list of dict records.

    Each non-empty line must be a JSON object. A missing file, unreadable file, or a
    malformed line raises LiftGateInputError (typed) — never a silent empty list that
    would fabricate an empty-but-valid arm.
    """
    if not path.exists():
        raise LiftGateInputError(f"missing_file:{path.name}")
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise LiftGateInputError(f"read_error:{type(exc).__name__}") from exc
    records: list[dict[str, Any]] = []
    for lineno, line in enumerate(raw.splitlines(), 1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise LiftGateInputError(f"jsonl_invalid:{path.name}:{lineno}:{exc.colno}") from exc
        if not isinstance(obj, dict):
            raise LiftGateInputError(f"jsonl_record_not_object:{path.name}:{lineno}")
        records.append(obj)
    return records


def load_json_obj(path: Path) -> dict[str, Any]:
    """Load a single JSON object file. Missing/malformed/non-object -> typed error."""
    if not path.exists():
        raise LiftGateInputError(f"missing_file:{path.name}")
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise LiftGateInputError(f"read_error:{type(exc).__name__}") from exc
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise LiftGateInputError(f"json_invalid:{path.name}:{exc.lineno}:{exc.colno}") from exc
    if not isinstance(obj, dict):
        raise LiftGateInputError(f"json_not_object:{path.name}")
    return obj


# --------------------------------------------------------------------------- #
# Pairing + win-rate
# --------------------------------------------------------------------------- #
def _fixture_id(record: dict[str, Any]) -> Any:
    return record.get("fixture_id")


def fixture_id_set(records: list[dict[str, Any]]) -> set[Any]:
    """Set of fixture ids; a record missing fixture_id raises (fail closed, no silent skip)."""
    ids: set[Any] = set()
    for record in records:
        fid = _fixture_id(record)
        if fid is None:
            raise LiftGateInputError("record_missing_fixture_id")
        ids.add(fid)
    return ids


def paired_outcomes(
    baseline: list[dict[str, Any]],
    enriched: list[dict[str, Any]],
) -> list[int]:
    """Return per-fixture paired WIN indicators for the enriched arm over identical ids.

    A fixture is a WIN (1) when the enriched `score` strictly exceeds the baseline
    `score`, a LOSS (0) otherwise (tie counts as not-a-win — a conservative, fail-closed
    convention that never credits the enricher for parity). The score field is required
    on both sides; absence raises (no zero coercion).
    """
    base_by_id = {_fixture_id(r): r for r in baseline}
    enr_by_id = {_fixture_id(r): r for r in enriched}
    wins: list[int] = []
    for fid in sorted(base_by_id, key=lambda v: str(v)):
        base = base_by_id[fid]
        enr = enr_by_id[fid]
        b_score = base.get("score")
        e_score = enr.get("score")
        if not isinstance(b_score, (int, float)) or not isinstance(e_score, (int, float)):
            raise LiftGateInputError(f"missing_score:{fid}")
        wins.append(1 if float(e_score) > float(b_score) else 0)
    return wins


def win_rate(wins: list[int]) -> float:
    """Win rate in [0,1]. Empty input raises (fail closed, never a fabricated 0.0)."""
    if not wins:
        raise LiftGateInputError("empty_win_vector")
    return sum(wins) / len(wins)


# --------------------------------------------------------------------------- #
# Bootstrap CI: percentile AND BCa
# --------------------------------------------------------------------------- #
def _percentile(sorted_vals: list[float], q: float) -> float:
    """Linear-interpolation percentile (q in [0,1]) over an already-sorted list."""
    if not sorted_vals:
        raise LiftGateInputError("empty_percentile_input")
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = q * (len(sorted_vals) - 1)
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return sorted_vals[lo]
    frac = pos - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


def _normal_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _normal_ppf(p: float) -> float:
    """Inverse standard-normal CDF (Acklam's rational approximation). p in (0,1)."""
    if p <= 0.0:
        return -math.inf
    if p >= 1.0:
        return math.inf
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


def bootstrap_ci_lower(
    deltas: list[float],
    *,
    resamples: int = BOOTSTRAP_RESAMPLES,
    seed: int | None = None,
    arm: str = MAIN_LIFT_ARM,
    alpha: float = 0.05,
) -> dict[str, float]:
    """Paired-bootstrap lower bound of the mean delta — BOTH percentile and BCa.

    `deltas` is the per-fixture paired difference (enriched win indicator minus the
    control win indicator, or the raw win vector for the lift itself). The resample stream
    is seeded by a DETERMINISTIC per-arm seed (`_stable_arm_seed(arm)`) so the main lift CI
    and each control draw INDEPENDENT but fully reproducible resamples (same inputs ->
    byte-identical CI across runs). An explicit `seed` overrides the per-arm derivation.
    Returns {"point","percentile","bca","resamples"} — all on the same [-1,1] win-rate-delta
    scale.
    """
    if not deltas:
        raise LiftGateInputError("empty_bootstrap_input")
    n = len(deltas)
    point = statistics.fmean(deltas)
    rng = random.Random(seed if seed is not None else _stable_arm_seed(arm))
    boot_means: list[float] = []
    for _ in range(resamples):
        total = 0.0
        for _ in range(n):
            total += deltas[rng.randrange(n)]
        boot_means.append(total / n)
    boot_means.sort()

    pct_lower = _percentile(boot_means, alpha)

    # BCa: bias-correction z0 + acceleration a (jackknife). Falls back to percentile-
    # equivalent bounds when the estimate is degenerate (all-equal deltas).
    n_less = sum(1 for m in boot_means if m < point)
    prop = n_less / len(boot_means)
    if prop <= 0.0 or prop >= 1.0:
        bca_lower = pct_lower
    else:
        z0 = _normal_ppf(prop)
        jack_means = []
        full_sum = math.fsum(deltas)
        for i in range(n):
            jack_means.append((full_sum - deltas[i]) / (n - 1))
        jack_mean = statistics.fmean(jack_means)
        num = math.fsum((jack_mean - jm) ** 3 for jm in jack_means)
        den = 6.0 * (math.fsum((jack_mean - jm) ** 2 for jm in jack_means) ** 1.5)
        accel = num / den if den != 0 else 0.0
        z_alpha = _normal_ppf(alpha)
        adj = z0 + (z0 + z_alpha) / (1 - accel * (z0 + z_alpha))
        bca_q = _normal_cdf(adj)
        bca_q = min(max(bca_q, 0.0), 1.0)
        bca_lower = _percentile(boot_means, bca_q)

    return {
        "point": point,
        "percentile": pct_lower,
        "bca": bca_lower,
        "resamples": float(resamples),
    }


# --------------------------------------------------------------------------- #
# Control comparison: paired difference + bootstrap one-sided p, then Holm
# --------------------------------------------------------------------------- #
def _control_wins(arm: dict[str, Any]) -> list[tuple[Any, int]]:
    """Extract (fixture_id, win_indicator) from a control arm report.

    The arm carries `outcomes`: a list of {fixture_id, win} (win in {0,1}). A malformed
    arm raises (fail closed, never an empty silent control that would auto-pass).
    """
    outcomes = arm.get("outcomes")
    if not isinstance(outcomes, list) or not outcomes:
        raise LiftGateInputError("control_arm_missing_outcomes")
    pairs: list[tuple[Any, int]] = []
    for item in outcomes:
        if not isinstance(item, dict):
            raise LiftGateInputError("control_outcome_not_object")
        fid = item.get("fixture_id")
        win = item.get("win")
        if fid is None or win not in (0, 1):
            raise LiftGateInputError("control_outcome_malformed")
        pairs.append((fid, int(win)))
    return pairs


def control_comparison(
    enriched_wins_by_id: dict[Any, int],
    arm: dict[str, Any],
    arm_name: str = "control",
) -> dict[str, Any]:
    """Compare the enriched arm against ONE control over their shared fixture ids.

    Returns {"n","delta_point","p_value"} where delta is mean(enriched_win - control_win)
    over shared ids and p_value is a one-sided bootstrap p that the enricher does NOT beat
    the control (proportion of bootstrap deltas <= 0). Disjoint ids -> typed error.

    PRNG-CORRELATION FIX: the bootstrap stream is seeded by a DETERMINISTIC per-arm seed
    (`_stable_arm_seed(arm_name)`), NOT the shared BOOTSTRAP_SEED, so each control's
    resample index sequence is INDEPENDENT of the main lift CI and of the sibling controls
    — keeping the Holm family's independence assumption honest while staying fully
    reproducible (same inputs -> identical p_value across runs).
    """
    control_by_id = dict(_control_wins(arm))
    shared = sorted((set(enriched_wins_by_id) & set(control_by_id)), key=lambda v: str(v))
    if not shared:
        raise LiftGateInputError("control_no_shared_fixtures")
    deltas = [float(enriched_wins_by_id[fid] - control_by_id[fid]) for fid in shared]
    point = statistics.fmean(deltas)
    rng = random.Random(_stable_arm_seed(arm_name))
    n = len(deltas)
    le_zero = 0
    for _ in range(BOOTSTRAP_RESAMPLES):
        total = 0.0
        for _ in range(n):
            total += deltas[rng.randrange(n)]
        if (total / n) <= 0.0:
            le_zero += 1
    p_value = le_zero / BOOTSTRAP_RESAMPLES
    return {"n": n, "delta_point": point, "p_value": p_value}


def holm_pass(p_values: dict[str, float], alpha: float = HOLM_ALPHA) -> dict[str, Any]:
    """Holm step-down correction over the family of control p-values.

    Every control must clear its Holm-adjusted threshold for the family to PASS.
    Returns {"family_pass": bool, "per_arm": {arm: {"p","threshold","reject_null"}}}.
    Holm: sort p ascending; the i-th (1-based) threshold is alpha/(m - i + 1).

    STOP-ON-FIRST-FAIL (defining property of a step-down procedure): once a sorted
    p-value fails its threshold, the step-down HALTS — that null and EVERY larger-p
    null are ACCEPTED (reject=False). Later arms must NOT be independently tested
    against their own thresholds (doing so OVER-REJECTS and publishes misleading
    per-arm `beats_control` verdicts). We keep iterating only to RECORD the remaining
    arms with reject forced False.
    """
    ordered = sorted(p_values.items(), key=lambda kv: kv[1])
    m = len(ordered)
    per_arm: dict[str, Any] = {}
    family_pass = True
    stopped = False
    for i, (arm, p) in enumerate(ordered, 1):
        threshold = alpha / (m - i + 1)
        if stopped:
            # A prior (smaller-p) arm already failed; Holm accepts all larger-p nulls.
            reject = False
        else:
            reject = p < threshold
            if not reject:
                # First failure: family fails and the step-down stops here onward.
                family_pass = False
                stopped = True
        per_arm[arm] = {"p": p, "threshold": threshold, "reject_null": reject}
    return {"family_pass": family_pass, "per_arm": per_arm}


# --------------------------------------------------------------------------- #
# Judge noise
# --------------------------------------------------------------------------- #
def _normalize_scores(scores: list[float], lo: float, hi: float) -> list[float]:
    """Normalize raw scores into [0,1] given the declared rubric range [lo,hi]."""
    if hi <= lo:
        raise LiftGateInputError("judge_scale_degenerate")
    return [min(max((s - lo) / (hi - lo), 0.0), 1.0) for s in scores]


def judge_noise(judge_report: dict[str, Any]) -> dict[str, Any]:
    """Compute inter-judge MAD and SD over normalized [0,1] scores.

    `judge_report` carries `scale`: {"min","max"} and `per_item`: a list of objects each
    with `judge_scores` (a list of >=2 raw judge scores). MAD is the mean over items of
    the per-item median-absolute-deviation; SD is the mean over items of the per-item
    population stdev. Both on the normalized scale. Malformed -> typed error.
    """
    scale = judge_report.get("scale")
    per_item = judge_report.get("per_item")
    if not isinstance(scale, dict) or not isinstance(per_item, list) or not per_item:
        raise LiftGateInputError("judge_report_malformed")
    lo = scale.get("min")
    hi = scale.get("max")
    if not isinstance(lo, (int, float)) or not isinstance(hi, (int, float)):
        raise LiftGateInputError("judge_scale_missing")
    mads: list[float] = []
    sds: list[float] = []
    for item in per_item:
        if not isinstance(item, dict):
            raise LiftGateInputError("judge_item_not_object")
        raw = item.get("judge_scores")
        if not isinstance(raw, list) or len(raw) < 2 or not all(isinstance(s, (int, float)) for s in raw):
            raise LiftGateInputError("judge_item_scores_invalid")
        norm = _normalize_scores([float(s) for s in raw], float(lo), float(hi))
        med = statistics.median(norm)
        # TRUE median-absolute-deviation: the MEDIAN of the absolute deviations about
        # the median (NOT the mean of them). For >=3 judges these diverge, and the
        # mean-of-deviations is the more LENIENT statistic — using it would let noisier
        # judge panels slip under the 0.15 MAD ceiling the threshold is calibrated to.
        mads.append(statistics.median([abs(s - med) for s in norm]))
        sds.append(statistics.pstdev(norm))
    return {
        "mad": statistics.fmean(mads),
        "sd": statistics.fmean(sds),
        "within_threshold": (statistics.fmean(mads) <= JUDGE_MAD_THRESHOLD
                             and statistics.fmean(sds) <= JUDGE_SD_THRESHOLD),
    }


# --------------------------------------------------------------------------- #
# Usage / token economics
# --------------------------------------------------------------------------- #
def added_tokens_and_churn(usage_report: dict[str, Any]) -> dict[str, Any]:
    """Provider-truth added tokens + prefix churn from the usage report.

    USAGE-TRUTH: economics use provider `usage` fields ONLY. The report must carry
    `baseline_input_tokens` and `enriched_input_tokens` (provider truth); absence ->
    typed error so the gate returns "inconclusive" (never a fabricated 0). `added_tokens`
    is the enriched-minus-baseline input-token delta. `prefix_churn` is the provider
    cache-stability flag (CACHE-NEUTRAL: the ONLY cache term in the verdict).
    """
    base = usage_report.get("baseline_input_tokens")
    enr = usage_report.get("enriched_input_tokens")
    if not isinstance(base, (int, float)) or not isinstance(enr, (int, float)):
        raise LiftGateInputError("usage_missing_provider_tokens")
    churn = usage_report.get("prefix_churn")
    if not isinstance(churn, bool):
        raise LiftGateInputError("usage_missing_prefix_churn")
    budget = usage_report.get("added_tokens_budget")
    if not isinstance(budget, (int, float)):
        raise LiftGateInputError("usage_missing_budget")
    added = float(enr) - float(base)
    return {
        "added_tokens": added,
        "prefix_churn": churn,
        "added_tokens_budget": float(budget),
    }


def lift_efficiency(win_rate_delta_pp: float, added_tokens: float) -> float | None:
    """LiftEfficiency = win_rate_delta_pp / (added_tokens / 1000) [pp per 1k tokens].

    NUMERATOR REFERENCE (load-bearing): `win_rate_delta_pp` is the paired sign-test
    ADVANTAGE OVER A COIN FLIP (0.5) in percentage points — i.e. (paired_win_rate - 0.5) *
    100 — NOT (enriched_win_rate - baseline_win_rate). The pairing already folds the
    baseline in (a "win" is enriched strictly beating baseline on that fixture), so the
    chance reference is 0.5, not the baseline's own win rate.

    added_tokens <= 0 means there is no enrichment cost to price the lift against — return
    None (undefined), which the verdict treats as failing the efficiency predicate rather
    than a divide-by-zero or an unbounded "free lift".
    """
    if added_tokens <= 0:
        return None
    return win_rate_delta_pp / (added_tokens / 1000.0)


def tau_sensitivity(efficiency: float | None, sweep: tuple[float, ...] = TAU_SWEEP) -> dict[str, bool]:
    """For each tau in the sweep, does LiftEfficiency clear it? (sensitivity report)."""
    result: dict[str, bool] = {}
    for tau in sweep:
        result[f"tau_{tau}"] = (efficiency is not None and efficiency >= tau)
    return result


# --------------------------------------------------------------------------- #
# Core verdict
# --------------------------------------------------------------------------- #
def evaluate(
    baseline: list[dict[str, Any]],
    enriched: list[dict[str, Any]],
    judge_report: dict[str, Any],
    random_arm: dict[str, Any],
    near_miss_arm: dict[str, Any],
    padding_arm: dict[str, Any],
    usage_report: dict[str, Any],
    *,
    tau: float = TAU_SEED,
    evidence_class: str | None = None,
) -> dict[str, Any]:
    """Run the full lift gate and return the metadata-only verdict report dict.

    Fail-closed ordering: comparability and sample size are checked FIRST (they change the
    verdict_status), then evidence class, judge noise, usage, bootstrap, controls, and
    finally the conjunction of all adoption predicates. Every failed predicate is NAMED.
    """
    failed_predicates: list[str] = []

    # --- evidence class (taken from the judge report unless overridden) ---
    if evidence_class is None:
        evidence_class = judge_report.get("evidence_class", "unknown")
    if not isinstance(evidence_class, str):
        evidence_class = "unknown"

    # --- comparability: identical fixture id sets ---
    base_ids = fixture_id_set(baseline)
    enr_ids = fixture_id_set(enriched)
    comparable = base_ids == enr_ids
    base_report = _base_report(tau, evidence_class)
    if not comparable:
        failed_predicates.append("comparable_fixtures")
        base_report.update({
            "adoption_eligible": False,
            "verdict_status": "not_comparable",
            "failed_predicates": failed_predicates,
            "fixture_overlap": len(base_ids & enr_ids),
            "baseline_fixture_count": len(base_ids),
            "enriched_fixture_count": len(enr_ids),
        })
        return base_report

    # --- sample size: n >= 50 paired fixtures ---
    n_paired = len(base_ids)
    if n_paired < MIN_PAIRED_N:
        failed_predicates.append("sample_size")
        base_report.update({
            "adoption_eligible": False,
            "verdict_status": "inconclusive_sample_size",
            "failed_predicates": failed_predicates,
            "paired_n": n_paired,
            "min_paired_n": MIN_PAIRED_N,
        })
        return base_report

    # --- paired lift + win-rate delta (pp) ---
    wins = paired_outcomes(baseline, enriched)
    enriched_win_rate = win_rate(wins)
    # LOAD-BEARING REFERENCE (paired sign-test): `enriched_win_rate` is already the PAIRED
    # fraction of fixtures where enriched strictly beats baseline (a sign-test statistic), so
    # the meaningful comparison is its ADVANTAGE OVER A COIN FLIP (0.5), NOT a second
    # win-rate. This is DELIBERATELY `enriched_win_rate - 0.5`, NOT
    # `enriched_win_rate - baseline_win_rate`: a paired win rate above 0.5 means the enricher
    # wins more pairs than it loses (better than chance). The delta is expressed in
    # percentage points and feeds BOTH the LiftEfficiency numerator AND the bootstrap CI
    # (which centers the same win vector at 0.5 below).
    win_rate_delta = enriched_win_rate - 0.5
    win_rate_delta_pp = win_rate_delta * 100.0

    enriched_wins_by_id = dict(zip(sorted(base_ids, key=lambda v: str(v)), wins))

    # --- usage / token economics (provider truth) ---
    try:
        usage = added_tokens_and_churn(usage_report)
    except LiftGateInputError as exc:
        failed_predicates.append("added_tokens")
        base_report.update({
            "adoption_eligible": False,
            "verdict_status": "inconclusive",
            "failed_predicates": failed_predicates,
            "usage_error": str(exc),
        })
        return base_report
    added_tokens = usage["added_tokens"]
    prefix_churn = usage["prefix_churn"]
    budget = usage["added_tokens_budget"]

    efficiency = lift_efficiency(win_rate_delta_pp, added_tokens)
    sweep = tau_sensitivity(efficiency)

    # --- judge noise ---
    try:
        noise = judge_noise(judge_report)
    except LiftGateInputError as exc:
        failed_predicates.append("judge_noise")
        base_report.update({
            "adoption_eligible": False,
            "verdict_status": "inconclusive_noise",
            "failed_predicates": failed_predicates,
            "judge_error": str(exc),
        })
        return base_report
    if not noise["within_threshold"]:
        failed_predicates.append("judge_noise")

    # --- bootstrap CI (percentile + BCa) on the centered win vector ---
    centered = [float(w) - 0.5 for w in wins]
    ci = bootstrap_ci_lower(centered)
    ci_lower_percentile = ci["percentile"]
    ci_lower_bca = ci["bca"]
    divergence = abs(ci_lower_percentile - ci_lower_bca)
    unstable = divergence > CI_DIVERGENCE_THRESHOLD

    # --- controls: Holm over {random, near_miss, padding} ---
    control_reports: dict[str, Any] = {}
    control_p: dict[str, float] = {}
    arm_inputs = {"random": random_arm, "near_miss": near_miss_arm, "padding": padding_arm}
    for arm_name, arm in arm_inputs.items():
        cmp = control_comparison(enriched_wins_by_id, arm, arm_name)
        control_reports[arm_name] = cmp
        control_p[arm_name] = cmp["p_value"]
    holm = holm_pass(control_p)
    control_results = {
        arm: {
            "delta_point": control_reports[arm]["delta_point"],
            "n": control_reports[arm]["n"],
            "p_value": control_reports[arm]["p_value"],
            "holm_threshold": holm["per_arm"][arm]["threshold"],
            "beats_control": holm["per_arm"][arm]["reject_null"],
        }
        for arm in CONTROL_ARMS
    }

    # --- predicate evaluation (every failure NAMED) ---
    if evidence_class not in ALLOWED_EVIDENCE_CLASSES:
        failed_predicates.append("evidence_class")
    if not (ci_lower_percentile > 0 and ci_lower_bca > 0):
        failed_predicates.append("bootstrap_ci_lower")
    if unstable:
        failed_predicates.append("ci_stability")
    if not (efficiency is not None and efficiency >= tau):
        failed_predicates.append("lift_efficiency")
    if not holm["family_pass"]:
        failed_predicates.append("control_correction")
    if added_tokens > budget:
        failed_predicates.append("added_tokens_over_budget")
    if prefix_churn:
        failed_predicates.append("prefix_churn")

    # --- verdict status: prioritize the most informative inconclusive cause ---
    if unstable:
        verdict_status = "inconclusive_unstable_ci"
        adoption_eligible = False
    elif "judge_noise" in failed_predicates:
        verdict_status = "inconclusive_noise"
        adoption_eligible = False
    elif not failed_predicates:
        verdict_status = "adoption_eligible"
        adoption_eligible = True
    else:
        verdict_status = "ineligible"
        adoption_eligible = False

    base_report.update({
        "adoption_eligible": adoption_eligible,
        "verdict_status": verdict_status,
        "paired_n": n_paired,
        "win_rate_delta_pp": win_rate_delta_pp,
        "lift_efficiency": efficiency,
        "ci_lower_percentile": ci_lower_percentile,
        "ci_lower_bca": ci_lower_bca,
        "ci_divergence": divergence,
        "tau_sensitivity": sweep,
        "control_results": control_results,
        "control_family_holm_pass": holm["family_pass"],
        "judge_mad": noise["mad"],
        "judge_sd": noise["sd"],
        "added_tokens": added_tokens,
        "added_tokens_budget": budget,
        "prefix_churn": prefix_churn,
        "failed_predicates": failed_predicates,
    })
    return base_report


def _base_report(tau: float, evidence_class: str) -> dict[str, Any]:
    """The always-present metadata envelope shared by every verdict path."""
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only",
        "tau": tau,
        "tau_seed": TAU_SEED,
        "evidence_class": evidence_class,
        "bootstrap_resamples": BOOTSTRAP_RESAMPLES,
        "bootstrap_seed": BOOTSTRAP_SEED,
        "min_paired_n": MIN_PAIRED_N,
    }


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(
        description="Enricher lift gate (Bead 2.5): adopt an additive enricher ONLY on a "
                    "statistically proven QUALITY LIFT (never on cache reduction)."
    )
    ap.add_argument("--baseline", required=True, help="Baseline reports JSONL (per fixture).")
    ap.add_argument("--enriched", required=True, help="Enriched reports JSONL (same fixtures).")
    ap.add_argument("--judge-report", required=True, help="Blind judge report JSON.")
    ap.add_argument("--random-arm", required=True, help="Random control arm report JSON.")
    ap.add_argument("--near-miss-arm", required=True, help="Near-miss control arm report JSON.")
    ap.add_argument("--padding-arm", required=True, help="Padding control arm report JSON.")
    ap.add_argument("--usage-report", required=True, help="Provider-truth token usage report JSON.")
    ap.add_argument("--tau", type=float, default=TAU_SEED, help="Headline tau (pp/1k).")
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    args = ap.parse_args()

    try:
        baseline = load_jsonl(Path(args.baseline))
        enriched = load_jsonl(Path(args.enriched))
        judge_report = load_json_obj(Path(args.judge_report))
        random_arm = load_json_obj(Path(args.random_arm))
        near_miss_arm = load_json_obj(Path(args.near_miss_arm))
        padding_arm = load_json_obj(Path(args.padding_arm))
        usage_report = load_json_obj(Path(args.usage_report))
        report = evaluate(
            baseline, enriched, judge_report, random_arm, near_miss_arm,
            padding_arm, usage_report, tau=args.tau,
        )
    except LiftGateInputError as exc:
        report = {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only",
            "adoption_eligible": False,
            "verdict_status": "ineligible",
            "error_type": "lift_gate_input_error",
            "_error": str(exc),
            "failed_predicates": ["input_present"],
        }

    report = redact(report)
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=False)
    sys.stdout.write("\n")

    if not report.get("adoption_eligible"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
