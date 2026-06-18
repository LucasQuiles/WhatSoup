#!/usr/bin/env python3
"""experiment_e2_additive_through_b3 — E2 (plan bead 3.1): additive-through-B3 characterization.

Characterizes how the B3 paired-trial reducer gate (`paired_trial_harness`) responds to an ADDITIVE-only
intervention — one that adds uncached context tokens with no quality gain. Adding context drops the
`cache_read_to_input_ratio`, so B3's `cache_not_worse` predicate fails and the intervention is NOT
adoption-eligible (CACHE-NEUTRAL: additive context is not free when it churns the cache). A contrast
improving-reducer arm (fewer tokens, better cache) IS adopted, showing B3 rejects on the cost/cache merits
rather than rejecting everything.

HONEST SCOPE (E2-PROOF assumption): this CHARACTERIZES B3's rejection behavior under additive context. It
does NOT prove plane separation (a reducer being routed to the reducer gate vs an enricher being routed to
the lift gate) — that proof is `adoption_orchestrator` + the `two_plane_separation` guard (bead 4.3). The
report carries that caveat in `scope` so the result is not overstated.

Run through `experiment_harness` (pre-registered criterion `additive_b3_adoptions == 0`). proof_class
`blind_judge_comparison`; metadata-only (predicate names / counts / verdicts, never raw fixtures or paths).
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probelib import redact  # noqa: E402
import paired_trial_harness as b3  # noqa: E402
import experiment_harness as eh  # noqa: E402

SCHEMA = "agent-runtime-experiment-e2"
SCHEMA_VERSION = "0.1"
REDACTION = "metadata-only"

EXPERIMENT_ID = "E2"
_SCOPE = ("characterizes B3 rejection of additive-only context; this is NOT a plane separation proof "
          "(see adoption_orchestrator / two_plane_separation, bead 4.3)")


def _event(fixture_id: str, *, reducer_id: str, input_tokens: int, cache_read: int, ratio: float,
           quality_pass: bool = True, quality_score: float = 1.0) -> dict:
    return {
        "task_fixture_id": fixture_id, "task_group": "group_a", "reducer_id": reducer_id,
        "evidence_class": "quality_and_cache_and_canary", "quality_pass": quality_pass,
        "quality_score": quality_score, "input_tokens_est": input_tokens, "output_tokens_est": 150,
        "cost_est": 0.01, "cache_read": cache_read, "cache_write": 10,
        "cache_read_to_input_ratio": ratio, "raw_output_bytes": 2000, "reduced_output_bytes": 1200,
        "retry_count": 0, "duration_ms": 1000, "rollback_rule": f"revert reducer_id={reducer_id}",
    }


def _baseline():
    return [_event("fx1", reducer_id="baseline", input_tokens=400, cache_read=100, ratio=0.8),
            _event("fx2", reducer_id="baseline", input_tokens=400, cache_read=100, ratio=0.8)]


def _additive():
    # added uncached context tokens, no quality gain -> cache_read_to_input_ratio DROPS
    return [_event("fx1", reducer_id="additive_ctx", input_tokens=650, cache_read=100, ratio=0.55),
            _event("fx2", reducer_id="additive_ctx", input_tokens=650, cache_read=100, ratio=0.55)]


def _improving():
    # genuine cost-reducer: fewer tokens, better cache ratio, no quality regression
    return [_event("fx1", reducer_id="r_reduce", input_tokens=300, cache_read=140, ratio=0.85),
            _event("fx2", reducer_id="r_reduce", input_tokens=300, cache_read=140, ratio=0.85)]


def _canary(reducer_id: str) -> dict:
    return {"schema": "agent-runtime-compaction-survival-canary", "reducer_id": reducer_id,
            "summary": {"verdict": "pass", "pass_count": 6, "fail_count": 0}}


_HANDLE = {"schema": "agent-runtime-raw-output-handle-protocol",
           "metadata": {"handle": "a" * 64, "store_status": "stored", "reduced_applied": True}}


def _evaluate_arm(work: Path, intervention_events, reducer_id: str) -> dict:
    bp, ip, cp, hp = work / "b.jsonl", work / "i.jsonl", work / "c.json", work / "h.json"
    bp.write_text("\n".join(json.dumps(e) for e in _baseline()) + "\n", encoding="utf-8")
    ip.write_text("\n".join(json.dumps(e) for e in intervention_events) + "\n", encoding="utf-8")
    cp.write_text(json.dumps(_canary(reducer_id)), encoding="utf-8")
    hp.write_text(json.dumps(_HANDLE), encoding="utf-8")
    return b3.evaluate(b3.parse_paired_trial_jsonl(bp), b3.parse_paired_trial_jsonl(ip),
                       b3.load_side_report(cp), b3.load_side_report(hp))


def run_trial() -> dict:
    """Route an additive-only intervention and a contrast improving-reducer through B3; report verdicts.
    JSONL fixtures are written to a scratch tempdir (auto-removed) — never into a caller path."""
    with tempfile.TemporaryDirectory() as wd:
        work = Path(wd)
        additive = _evaluate_arm(work, _additive(), "additive_ctx")
        reducer = _evaluate_arm(work, _improving(), "r_reduce")
    add_ok = bool(additive["adoption_eligible"])
    red_ok = bool(reducer["adoption_eligible"])
    return {
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "proof_class": "blind_judge_comparison",
        "additive_adoption_eligible": add_ok,
        "additive_failed_predicates": additive["failed_predicates"],
        "additive_b3_adoptions": int(add_ok),
        "reducer_adoption_eligible": red_ok,
        "reducer_b3_adoptions": int(red_ok),
        "scope": _SCOPE,
    }


def experiment(store_dir: str) -> dict:
    """Register the immutable criterion, run the trial, evaluate through the harness."""
    prediction = {
        "experiment_id": EXPERIMENT_ID,
        "hypothesis": "B3 does not adopt an additive-only intervention (added uncached context churns the "
                      "cache, failing cache_not_worse), while it adopts a genuine cost-reducer",
        "success_criterion": {"metric": "additive_b3_adoptions", "comparator": "eq", "threshold": 0},
    }
    eh.register_prediction(prediction, store_dir)
    metrics = run_trial()
    harness_report = eh.write_result(EXPERIMENT_ID, metrics, store_dir)
    return redact({
        "schema": SCHEMA, "schema_version": SCHEMA_VERSION, "redaction": REDACTION,
        "experiment_id": EXPERIMENT_ID,
        "harness": harness_report,
        "metrics": metrics,
    })


def main() -> int:
    ap = argparse.ArgumentParser(description="E2 additive-through-B3 characterization (run through the harness).")
    ap.add_argument("--run", action="store_true", required=True, help="run the experiment")
    ap.add_argument("--store-dir", required=True, help="caller-controlled prediction store directory")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    def _emit(obj: dict, rc: int) -> int:
        json.dump(redact(obj), sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return rc

    try:
        report = experiment(args.store_dir)
    except eh.PredictionError as exc:
        return _emit({"schema": SCHEMA, "error_type": exc.error_type, "_error": exc.message,
                      "overall_verdict": "FAIL"}, 1)
    ok = report["harness"]["overall_verdict"] == "PASS"
    return _emit(report, 0 if ok else 1)


if __name__ == "__main__":
    raise SystemExit(main())
