#!/usr/bin/env python3
"""paired_trial_harness.py — B3 adoption-eligibility verdict for the pre-reducer gate.

The final gate before a live token-reducer may be adopted. It consumes two paired-trial
reports run over IDENTICAL task fixtures (`--baseline` vs `--intervention`), plus the B2
`--canary-report` (corruption-detection proof) and the B1 `--handle-report` (reversibility
proof), and emits a deterministic, data-driven `adoption_eligible` verdict.

Honoring the B3-LEDGER blocking assumption: this probe defines its OWN paired-trial event
schema and does NOT overload `tools/run_ledger`. `run_ledger.summarize` records only
kind/name/duration/exit/coverage and drops the very fields adoption needs (task ids, token
counters, cost, cache ratios, reducer ids), so it is attached only as SUPPLEMENTAL run-health
when `--run-ledger` is supplied — never as the comparison source of truth.

Required paired-trial event schema (each JSONL line in baseline/intervention):
    {task_fixture_id, task_group, reducer_id, evidence_class, quality_pass,
     quality_score?, input_tokens_est?, output_tokens_est?, cost_est?,
     cache_read?, cache_write?, cache_read_to_input_ratio?, raw_output_bytes?,
     reduced_output_bytes?, retry_count, duration_ms}
Missing a REQUIRED field on any event -> not_comparable.

Adoption verdict (`adoption_eligible`) = ALL of:
    same task fixture set, quality not worse, cache not worse, retry not worse,
    canary pass (from --canary-report), handle present (from --handle-report),
    rollback_rule present, evidence_class NOT raw-output-only.
EXPLICITLY false if the only evidence is raw-output-%; every failed predicate is named.

Token estimates are labeled HEURISTIC (chars/4 family); they are never treated as provider
truth and adoption is never decided from heuristic metrics alone.

Fail-closed everywhere: malformed/missing JSONL -> typed parse_status/error_type; mismatched
task fixtures -> not_comparable; missing canary/handle/rollback report -> ineligible; missing
cache metrics -> ineligible_for_adoption unless explicitly scoped measurement_only.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from probelib import redact

SCHEMA = "agent-runtime-paired-trial-harness"
SCHEMA_VERSION = "0.1"

# Required on every paired-trial event; a missing one makes the runs not_comparable.
REQUIRED_EVENT_FIELDS = (
    "task_fixture_id",
    "task_group",
    "reducer_id",
    "evidence_class",
    "quality_pass",
    "retry_count",
    "duration_ms",
)
# Cache fields whose absence makes the run ineligible_for_adoption unless measurement_only.
CACHE_FIELDS = ("cache_read", "cache_write", "cache_read_to_input_ratio")

# evidence_class values that mean "the ONLY evidence is the raw-output byte/percent saving" —
# adoption is EXPLICITLY false for these (a reducer cannot be adopted on raw-% alone).
RAW_OUTPUT_ONLY_CLASSES = frozenset({
    "raw_output_only",
    "raw_output_percent_only",
    "raw_percent_only",
    "raw_bytes_only",
})


class ParseError(Exception):
    """Raised when a paired-trial JSONL file cannot be parsed into typed events."""


# --------------------------------------------------------------------------- parsing


def parse_paired_trial_jsonl(path: Path) -> dict[str, Any]:
    """Parse a paired-trial JSONL file into typed events. Fail-closed: a missing file,
    malformed JSON, a non-object line, or any event missing a REQUIRED field produces a typed
    parse_status (never a silent empty list). Returns a dict with status/events/error metadata.
    """
    if not path.exists():
        return {"parse_status": "missing", "error_type": "FileNotFoundError",
                "events": [], "line_count": 0}
    try:
        text = path.read_text(errors="replace")
    except OSError as exc:
        return {"parse_status": "read_error", "error_type": type(exc).__name__,
                "events": [], "line_count": 0}

    events: list[dict[str, Any]] = []
    missing_field_lines: list[dict[str, Any]] = []
    line_no = 0
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            continue
        line_no += 1
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError as exc:
            return {"parse_status": "invalid", "error_type": "JSONDecodeError",
                    "parser_class": "json", "line": line_no, "detail_class": exc.__class__.__name__,
                    "events": [], "line_count": line_no}
        if not isinstance(obj, dict):
            return {"parse_status": "invalid", "error_type": "non_object_line",
                    "parser_class": "json", "line": line_no,
                    "events": [], "line_count": line_no}
        absent = [f for f in REQUIRED_EVENT_FIELDS if f not in obj]
        if absent:
            missing_field_lines.append({"line": line_no, "missing": absent})
            continue
        events.append(obj)

    if missing_field_lines:
        return {"parse_status": "missing_required_fields", "error_type": "missing_required_fields",
                "missing_field_lines": missing_field_lines, "events": events,
                "line_count": line_no}
    if not events:
        return {"parse_status": "empty", "error_type": "no_events",
                "events": [], "line_count": line_no}
    return {"parse_status": "ok", "error_type": None, "events": events, "line_count": line_no}


def load_side_report(path: Path | None) -> dict[str, Any]:
    """Load a B1/B2 side report (JSON). Fail-closed: missing -> typed status, malformed ->
    typed parse_status; never a silent empty dict."""
    if path is None:
        return {"present": False, "parse_status": "absent", "error_type": "not_provided",
                "report": None}
    if not path.exists():
        return {"present": False, "parse_status": "missing", "error_type": "FileNotFoundError",
                "report": None}
    try:
        report = json.loads(path.read_text(errors="replace"))
    except json.JSONDecodeError:
        return {"present": False, "parse_status": "invalid", "error_type": "JSONDecodeError",
                "report": None}
    except OSError as exc:
        return {"present": False, "parse_status": "read_error", "error_type": type(exc).__name__,
                "report": None}
    if not isinstance(report, dict):
        return {"present": False, "parse_status": "invalid", "error_type": "non_object_report",
                "report": None}
    return {"present": True, "parse_status": "ok", "error_type": None, "report": report}


# --------------------------------------------------------------------------- side-report verdicts


def canary_passed(side: dict[str, Any],
                  intervention_reducer_id: str | None = None) -> dict[str, Any]:
    """Derive canary-pass from a B2 reducer-canary report. A canary passes only when the
    report is present, parseable, its summary verdict is explicitly 'pass', AND the canary
    actually ran the SAME reducer as the intervention paired-trial events. Anything else
    (absent, malformed, fail, unknown shape, reducer mismatch/missing) is a non-pass —
    fail-closed.

    `intervention_reducer_id` is the reducer id the intervention events claim. The B2 report
    now carries a top-level `reducer_id`; if it is missing the canary cannot prove it tested
    THIS candidate reducer, so it is treated as unproven (fail-closed)."""
    if not side.get("present"):
        return {"canary_pass": False, "reason": f"canary_report_{side.get('parse_status')}"}
    report = side["report"]
    summary = report.get("summary")
    verdict = summary.get("verdict") if isinstance(summary, dict) else report.get("verdict")
    canary_reducer_id = report.get("reducer_id")
    if verdict != "pass":
        if verdict == "fail":
            return {"canary_pass": False, "reason": "canary_verdict_fail",
                    "canary_reducer_id": canary_reducer_id,
                    "intervention_reducer_id": intervention_reducer_id}
        return {"canary_pass": False, "reason": "canary_verdict_unknown_shape",
                "canary_reducer_id": canary_reducer_id,
                "intervention_reducer_id": intervention_reducer_id}
    # Verdict is pass — but only honor it if the canary proved it ran THIS reducer.
    if not isinstance(canary_reducer_id, str) or not canary_reducer_id:
        return {"canary_pass": False, "reason": "canary_reducer_mismatch",
                "canary_reducer_id": canary_reducer_id,
                "intervention_reducer_id": intervention_reducer_id,
                "mismatch_detail": "canary_report_missing_reducer_id"}
    if canary_reducer_id != intervention_reducer_id:
        return {"canary_pass": False, "reason": "canary_reducer_mismatch",
                "canary_reducer_id": canary_reducer_id,
                "intervention_reducer_id": intervention_reducer_id,
                "mismatch_detail": "reducer_id_differs"}
    return {"canary_pass": True, "reason": "canary_verdict_pass",
            "canary_reducer_id": canary_reducer_id,
            "intervention_reducer_id": intervention_reducer_id}


def intervention_reducer_id_of(events: list[dict[str, Any]]) -> str | None:
    """The reducer id the intervention events claim. Defined only when every intervention
    event agrees on a single non-empty reducer_id; ambiguity/absence -> None (fail-closed,
    so the canary reducer-match check cannot be satisfied by a guessed id)."""
    ids = {str(e.get("reducer_id")) for e in events
           if isinstance(e.get("reducer_id"), str) and e.get("reducer_id")}
    if len(ids) == 1:
        return ids.pop()
    return None


def handle_present(side: dict[str, Any]) -> dict[str, Any]:
    """Derive handle-present from a B1 raw-output-handle report. A handle is present only when
    the report is present, parseable, and exposes a stored content-addressed handle. Absent /
    malformed / store-error reports yield handle_present=False — fail-closed."""
    if not side.get("present"):
        return {"handle_present": False, "reason": f"handle_report_{side.get('parse_status')}"}
    report = side["report"]
    metadata = report.get("metadata")
    handle = None
    store_status = None
    if isinstance(metadata, dict):
        handle = metadata.get("handle")
        store_status = metadata.get("store_status")
    if handle is None:
        # B1 round-trip demos also surface the handle under a top-level "roundtrip" block.
        roundtrip = report.get("roundtrip")
        if isinstance(roundtrip, dict):
            handle = roundtrip.get("handle")
            store_status = store_status or "stored"
    if isinstance(handle, str) and handle and store_status not in {"store_error"}:
        return {"handle_present": True, "reason": "handle_stored"}
    return {"handle_present": False, "reason": "handle_absent_or_store_error"}


# --------------------------------------------------------------------------- deltas


def _pass_rate(events: list[dict[str, Any]]) -> float:
    passes = sum(1 for e in events if e.get("quality_pass") is True)
    return round(passes / len(events), 6) if events else 0.0


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 6) if values else None


def _present_floats(events: list[dict[str, Any]], field: str) -> list[float]:
    out: list[float] = []
    for e in events:
        v = e.get(field)
        if isinstance(v, bool):  # bool is an int subclass; never treat True/False as a number
            continue
        if isinstance(v, (int, float)):
            out.append(float(v))
    return out


def _scalar_float(v: Any) -> float | None:
    """Coerce a single field value to float, rejecting bools (an int subclass). Absent or
    non-numeric -> None (the per-fixture comparison treats it as 'no measured datum')."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def _sum_or_none(events: list[dict[str, Any]], field: str) -> float | None:
    vals = _present_floats(events, field)
    return round(sum(vals), 6) if vals else None


def _delta(intervention: float | None, baseline: float | None) -> float | None:
    if intervention is None or baseline is None:
        return None
    return round(intervention - baseline, 6)


def _index_by_fixture(events: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Index events by task_fixture_id (last event wins on a duplicate id). The caller has
    already proven the fixture-id MULTISETS are equal, so this pairs identical fixtures."""
    return {str(e["task_fixture_id"]): e for e in events}


def per_fixture_quality(base: list[dict[str, Any]], interv: list[dict[str, Any]]) -> dict[str, Any]:
    """Pair baseline/intervention events by task_fixture_id and evaluate quality PER FIXTURE.

    Spec mandates trials over IDENTICAL task fixtures so comparison is per-fixture, never an
    aggregate that can hide a fixture that regressed (t1 breaks) behind one that improved (t2
    flips). Emits the set of fixture ids that regressed in quality_pass, in quality_score, and
    in retry_count, plus the boolean `no_per_fixture_quality_regression` predicate datum.
    """
    base_by = _index_by_fixture(base)
    interv_by = _index_by_fixture(interv)
    common = sorted(set(base_by) & set(interv_by))

    pass_regressions: list[str] = []
    score_regressions: list[dict[str, Any]] = []
    retry_regressions: list[dict[str, Any]] = []
    for fid in common:
        b, i = base_by[fid], interv_by[fid]
        # quality_pass regression: passed on baseline, no longer passes on intervention.
        if b.get("quality_pass") is True and i.get("quality_pass") is not True:
            pass_regressions.append(fid)
        # quality_score regression: a measured per-fixture score drop (bools filtered out).
        b_score = _scalar_float(b.get("quality_score"))
        i_score = _scalar_float(i.get("quality_score"))
        if b_score is not None and i_score is not None and i_score < b_score:
            score_regressions.append({"fixture": fid,
                                      "delta": round(i_score - b_score, 6)})
        # retry spike: a per-fixture retry rise the SUM could otherwise hide.
        b_retry = _scalar_float(b.get("retry_count"))
        i_retry = _scalar_float(i.get("retry_count"))
        if b_retry is not None and i_retry is not None and i_retry > b_retry:
            retry_regressions.append({"fixture": fid,
                                      "delta": round(i_retry - b_retry, 6)})

    return {
        "paired_fixture_count": len(common),
        "pass_regression_fixtures": pass_regressions,
        "score_regression_fixtures": score_regressions,
        "retry_regression_fixtures": retry_regressions,
        "no_per_fixture_quality_regression": not pass_regressions,
        "no_per_fixture_score_regression": not score_regressions,
        "no_per_fixture_retry_regression": not retry_regressions,
        "proof_class": "measured",
    }


def quality_delta(base: list[dict[str, Any]], interv: list[dict[str, Any]]) -> dict[str, Any]:
    base_rate, interv_rate = _pass_rate(base), _pass_rate(interv)
    base_score = _mean(_present_floats(base, "quality_score"))
    interv_score = _mean(_present_floats(interv, "quality_score"))
    out = {
        "baseline_pass_rate": base_rate,
        "intervention_pass_rate": interv_rate,
        "pass_rate_delta": round(interv_rate - base_rate, 6),
        "baseline_mean_score": base_score,
        "intervention_mean_score": interv_score,
        "score_delta": _delta(interv_score, base_score),
        "proof_class": "measured",
    }
    # Aggregate pass-rate/score deltas can hide a per-fixture regression (t1 breaks, t2 flips,
    # delta nets to zero). Pair PER FIXTURE so adoption cannot pass on a netted aggregate.
    out["per_fixture"] = per_fixture_quality(base, interv)
    return out


def cache_delta(base: list[dict[str, Any]], interv: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {"proof_class": "measured"}
    # A cache delta is comparable only when BOTH sides expose a given metric. If the
    # intervention (or baseline) carries no cache metrics at all, no cache comparison is
    # possible and the trial is cache-incomplete (ineligible unless measurement_only).
    comparable_any = False
    for field in CACHE_FIELDS:
        b = _sum_or_none(base, field) if field != "cache_read_to_input_ratio" \
            else _mean(_present_floats(base, field))
        i = _sum_or_none(interv, field) if field != "cache_read_to_input_ratio" \
            else _mean(_present_floats(interv, field))
        out[f"baseline_{field}"] = b
        out[f"intervention_{field}"] = i
        out[f"{field}_delta"] = _delta(i, b)
        if b is not None and i is not None:
            comparable_any = True
    out["cache_metrics_present"] = comparable_any
    return out


def token_cost_delta(base: list[dict[str, Any]], interv: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {
        # token estimates are heuristic (chars/4 family) — NEVER provider truth.
        "token_proof_class": "heuristic",
        "cost_proof_class": "measured",
    }
    for field in ("input_tokens_est", "output_tokens_est"):
        b, i = _sum_or_none(base, field), _sum_or_none(interv, field)
        out[f"baseline_{field}"] = b
        out[f"intervention_{field}"] = i
        out[f"{field}_delta"] = _delta(i, b)
    b_cost, i_cost = _sum_or_none(base, "cost_est"), _sum_or_none(interv, "cost_est")
    out["baseline_cost_est"] = b_cost
    out["intervention_cost_est"] = i_cost
    out["cost_est_delta"] = _delta(i_cost, b_cost)
    return out


def retry_delta(base: list[dict[str, Any]], interv: list[dict[str, Any]]) -> dict[str, Any]:
    b, i = _sum_or_none(base, "retry_count"), _sum_or_none(interv, "retry_count")
    return {"baseline_retry_total": b, "intervention_retry_total": i,
            "retry_delta": _delta(i, b), "proof_class": "measured"}


def duration_delta(base: list[dict[str, Any]], interv: list[dict[str, Any]]) -> dict[str, Any]:
    b, i = _sum_or_none(base, "duration_ms"), _sum_or_none(interv, "duration_ms")
    return {"baseline_duration_ms": b, "intervention_duration_ms": i,
            "duration_delta_ms": _delta(i, b), "proof_class": "measured"}


# --------------------------------------------------------------------------- evidence class


def evidence_class_of(events: list[dict[str, Any]]) -> dict[str, Any]:
    classes = sorted({str(e.get("evidence_class")) for e in events})
    raw_only = bool(classes) and all(c in RAW_OUTPUT_ONLY_CLASSES for c in classes)
    return {"evidence_classes": classes, "raw_output_only": raw_only}


def rollback_rule_of(events: list[dict[str, Any]]) -> dict[str, Any]:
    """A rollback rule is present when every intervention event carries a non-empty
    rollback_rule (the reducer can be safely backed out). Optional field; absence -> ineligible.
    """
    rules = [e.get("rollback_rule") for e in events]
    present = bool(events) and all(isinstance(r, str) and r.strip() for r in rules)
    return {"rollback_rule_present": present,
            "rollback_rule_classes": sorted({str(r) for r in rules if isinstance(r, str) and r.strip()})}


# --------------------------------------------------------------------------- verdict


def evaluate(
    base_parsed: dict[str, Any],
    interv_parsed: dict[str, Any],
    canary_side: dict[str, Any],
    handle_side: dict[str, Any],
    measurement_only: bool = False,
) -> dict[str, Any]:
    """Compute the adoption verdict from parsed paired-trial reports + B1/B2 side reports.

    Returns a metadata-only report. `adoption_eligible` is True iff EVERY named predicate
    passes; each failed predicate is named in `failed_predicates`. not_comparable / ineligible
    statuses short-circuit to adoption_eligible=False with the underlying reason.
    """
    # 1) Comparability: both sides must parse cleanly into events.
    if base_parsed["parse_status"] != "ok" or interv_parsed["parse_status"] != "ok":
        return _verdict_report(
            status="not_comparable", adoption_eligible=False,
            failed_predicates=["paired_trial_parse"],
            detail={"baseline_parse_status": base_parsed["parse_status"],
                    "intervention_parse_status": interv_parsed["parse_status"],
                    "baseline_error_type": base_parsed.get("error_type"),
                    "intervention_error_type": interv_parsed.get("error_type")},
        )

    base, interv = base_parsed["events"], interv_parsed["events"]
    base_ids = sorted(str(e["task_fixture_id"]) for e in base)
    interv_ids = sorted(str(e["task_fixture_id"]) for e in interv)

    # 2) Same task fixture set (identical multiset of fixture ids).
    same_fixture_set = base_ids == interv_ids
    if not same_fixture_set:
        return _verdict_report(
            status="not_comparable", adoption_eligible=False,
            failed_predicates=["same_task_fixture_set"],
            detail={
                "only_in_baseline": sorted(set(base_ids) - set(interv_ids)),
                "only_in_intervention": sorted(set(interv_ids) - set(base_ids)),
                "baseline_fixture_count": len(base_ids),
                "intervention_fixture_count": len(interv_ids),
            },
        )

    # 3) Measured deltas.
    quality = quality_delta(base, interv)
    cache = cache_delta(base, interv)
    tokens = token_cost_delta(base, interv)
    retries = retry_delta(base, interv)
    durations = duration_delta(base, interv)
    evidence = evidence_class_of(interv)
    rollback = rollback_rule_of(interv)
    # F2: the canary may only be honored if it actually tested THIS intervention's reducer.
    interv_reducer_id = intervention_reducer_id_of(interv)
    canary = canary_passed(canary_side, interv_reducer_id)
    handle = handle_present(handle_side)

    # F3: measurement_only is an audit scope, NEVER an adoption grant. Short-circuit BEFORE any
    # adoption verdict so a measurement-only run with absent cache metrics + good quality cannot
    # be reported as adoption_eligible.
    if measurement_only:
        return _verdict_report(
            status="measurement_only_no_adoption", adoption_eligible=False,
            failed_predicates=["measurement_only_no_adoption"],
            detail={"measurement_only": True,
                    "note": "measurement-only scope is for auditing cache-incomplete trials; it "
                            "never grants adoption eligibility"},
            metrics={"quality": quality, "cache": cache, "tokens": tokens,
                     "retries": retries, "durations": durations,
                     "evidence": evidence, "rollback": rollback,
                     "canary": canary, "handle": handle},
        )

    # 4) Cache-metric gate: absent cache metrics -> ineligible_for_adoption (measurement_only
    # already short-circuited above, so here cache metrics are simply unproven -> ineligible).
    if not cache["cache_metrics_present"]:
        return _verdict_report(
            status="ineligible_for_adoption", adoption_eligible=False,
            failed_predicates=["cache_metrics_present"],
            detail={"note": "no cache metrics in paired trial; scope --measurement-only to proceed"},
            metrics={"quality": quality, "cache": cache, "tokens": tokens,
                     "retries": retries, "durations": durations,
                     "evidence": evidence, "rollback": rollback,
                     "canary": canary, "handle": handle},
        )

    # 5) Adoption predicates — each is a boolean over a MEASURED datum, never a heuristic alone.
    per_fixture = quality["per_fixture"]
    predicates = {
        "same_task_fixture_set": same_fixture_set,
        "quality_not_worse": quality["pass_rate_delta"] >= 0
        and (quality["score_delta"] is None or quality["score_delta"] >= 0),
        # F1: aggregate pass-rate/score is not enough — no fixture may regress PER FIXTURE.
        "no_per_fixture_quality_regression": per_fixture["no_per_fixture_quality_regression"]
        and per_fixture["no_per_fixture_score_regression"],
        # cache not worse: read must not drop, write must not rise, read-to-input ratio not drop.
        # F3: absence is never 'not worse' — _cache_not_worse fails-closed when unproven.
        "cache_not_worse": _cache_not_worse(cache),
        "cache_unproven": cache["cache_metrics_present"],
        "retry_not_worse": (retries["retry_delta"] is None) or (retries["retry_delta"] <= 0),
        # F1: a per-fixture retry spike must not be hidden by the aggregate sum.
        "no_per_fixture_retry_regression": per_fixture["no_per_fixture_retry_regression"],
        "canary_pass": canary["canary_pass"],
        "handle_present": handle["handle_present"],
        "rollback_rule_present": rollback["rollback_rule_present"],
        "evidence_not_raw_output_only": not evidence["raw_output_only"],
    }
    failed = sorted(name for name, ok in predicates.items() if not ok)
    adoption_eligible = not failed

    status = "adoption_eligible" if adoption_eligible else "ineligible"
    if not adoption_eligible and (
        not canary["canary_pass"] and canary["reason"].startswith("canary_report_")
        or not handle["handle_present"] and handle["reason"].startswith("handle_report_")
    ):
        # Missing/absent canary or handle REPORT (not merely a failing verdict) -> ineligible.
        status = "ineligible"

    return _verdict_report(
        status=status, adoption_eligible=adoption_eligible,
        failed_predicates=failed,
        detail={"task_fixture_count": len(base_ids),
                "measurement_only": measurement_only,
                "predicates": predicates},
        metrics={"quality": quality, "cache": cache, "tokens": tokens,
                 "retries": retries, "durations": durations,
                 "evidence": evidence, "rollback": rollback,
                 "canary": canary, "handle": handle},
    )


def _cache_not_worse(cache: dict[str, Any]) -> bool:
    """Cache is 'not worse' iff a cache comparison was actually possible AND no measured cache
    signal moved in the harmful direction: cache_read must not fall, cache_write must not rise,
    and read-to-input ratio must not fall.

    Absence is NOT 'not worse'. If BOTH sides lack every cache metric (no delta is comparable),
    there is nothing to prove cache health from, so this fails-closed (the verdict layer names a
    `cache_unproven` predicate). A None delta on a single metric (present on one side, absent on
    the other) is still treated as 'no harmful movement proven' for THAT metric."""
    if not cache.get("cache_metrics_present"):
        # No comparable cache metric on either side — absence is never 'not worse'.
        return False
    read_d = cache.get("cache_read_delta")
    write_d = cache.get("cache_write_delta")
    ratio_d = cache.get("cache_read_to_input_ratio_delta")
    if read_d is not None and read_d < 0:
        return False
    if write_d is not None and write_d > 0:
        return False
    if ratio_d is not None and ratio_d < 0:
        return False
    return True


def _verdict_report(
    *,
    status: str,
    adoption_eligible: bool,
    failed_predicates: list[str],
    detail: dict[str, Any],
    metrics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    report = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; emits task-fixture ids, pass-rates, byte/token/cost/cache "
                     "deltas, retry/duration deltas, class labels, and named predicates — never "
                     "raw prompts, transcripts, provider payloads, reduced text, or secrets",
        "status": status,
        "adoption_eligible": adoption_eligible,
        "failed_predicates": failed_predicates,
        "detail": detail,
        "metrics": metrics or {},
        "token_estimate_label": "heuristic; chars/4 family, not provider truth",
    }
    return redact(report)


# --------------------------------------------------------------------------- CLI


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    base_parsed = parse_paired_trial_jsonl(Path(args.baseline))
    interv_parsed = parse_paired_trial_jsonl(Path(args.intervention))
    canary_side = load_side_report(Path(args.canary_report) if args.canary_report else None)
    handle_side = load_side_report(Path(args.handle_report) if args.handle_report else None)
    report = evaluate(base_parsed, interv_parsed, canary_side, handle_side,
                      measurement_only=args.measurement_only)
    # Supplemental run-health (B3-LEDGER): run_ledger is attached read-only, never as the
    # comparison source of truth. Absence/parse-failure degrades to a typed marker.
    if args.run_ledger:
        report["supplemental_run_health"] = _supplemental_run_health(Path(args.run_ledger))
    return report


def _supplemental_run_health(ledger_path: Path) -> dict[str, Any]:
    """Attach run_ledger.summarize purely as supplemental run-health. Fail-closed: an import or
    summarize failure becomes a typed degraded marker, never silently dropped."""
    try:
        from tools import run_ledger  # imported lazily; optional supplemental evidence
        summary = run_ledger.summarize(ledger_path)
        return {"source": "run_ledger.summarize", "supplemental_only": True, "summary": summary}
    except Exception as exc:  # supplemental evidence must never crash the adoption verdict
        return {"source": "run_ledger.summarize", "supplemental_only": True,
                "status": "degraded", "error_type": type(exc).__name__}


def main_argv(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="B3 paired-trial harness: deterministic reducer adoption-eligibility verdict.")
    ap.add_argument("--baseline", required=True, help="baseline paired-trial JSONL report.")
    ap.add_argument("--intervention", required=True, help="intervention paired-trial JSONL report.")
    ap.add_argument("--canary-report", default=None, help="B2 reducer-canary JSON report.")
    ap.add_argument("--handle-report", default=None, help="B1 raw-output-handle JSON report.")
    ap.add_argument("--run-ledger", default=None,
                    help="optional run ledger for SUPPLEMENTAL run-health only (never comparison).")
    ap.add_argument("--measurement-only", action="store_true",
                    help="scope the run as measurement-only when cache metrics are absent.")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args(argv)

    report = build_report(args)
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    # Exit nonzero whenever adoption is not eligible so the gate is scriptable.
    return 0 if report.get("adoption_eligible") else 1


def main() -> int:
    return main_argv(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
