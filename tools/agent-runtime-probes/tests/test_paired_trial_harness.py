#!/usr/bin/env python3
"""Tests for paired_trial_harness (B3 adoption-eligibility verdict).

No pytest fixtures: synthetic JSONL/JSON fixtures are built with tempfile + manual
setattr/try-finally, and the standalone __main__ runner prints PASS <name>.

Load-bearing adoption-gate proofs asserted here:
  - clean improving intervention with full evidence -> adoption_eligible=True;
  - baseline-vs-CORRUPTING (canary fail) -> adoption_eligible=False, failing predicate named;
  - raw-output-%-ONLY evidence -> adoption_eligible=False (named predicate);
  - mismatched task fixtures -> not_comparable;
  - missing handle / rollback -> ineligible (named predicate);
  - >=1 UNHAPPY path (malformed/missing JSONL) asserts a typed parse_status;
  - DETERMINISM: same input -> byte-identical report (sans ts; none present);
  - CLI e2e subprocess over tempfile fixtures.
"""
import io
import json
import os
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import paired_trial_harness as probe  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "paired_trial_harness.py"


# --------------------------------------------------------------------------- fixture builders


def _event(fixture_id, *, quality_pass=True, quality_score=1.0, cache_read=100, cache_write=10,
           ratio=0.8, retry=0, duration=1000, evidence_class="quality_and_cache_and_canary",
           rollback="revert reducer_id=r1", input_tokens=400, output_tokens=200, cost=0.01,
           reducer_id="r1", raw_bytes=2000, reduced_bytes=1200):
    """Build one paired-trial event with all required + optional fields populated."""
    ev = {
        "task_fixture_id": fixture_id,
        "task_group": "group_a",
        "reducer_id": reducer_id,
        "evidence_class": evidence_class,
        "quality_pass": quality_pass,
        "quality_score": quality_score,
        "input_tokens_est": input_tokens,
        "output_tokens_est": output_tokens,
        "cost_est": cost,
        "cache_read": cache_read,
        "cache_write": cache_write,
        "cache_read_to_input_ratio": ratio,
        "raw_output_bytes": raw_bytes,
        "reduced_output_bytes": reduced_bytes,
        "retry_count": retry,
        "duration_ms": duration,
    }
    if rollback is not None:
        ev["rollback_rule"] = rollback
    return ev


def _write_jsonl(path: Path, events):
    path.write_text("\n".join(json.dumps(e) for e in events) + "\n")


def _write_json(path: Path, obj):
    path.write_text(json.dumps(obj))


def _baseline_events():
    return [_event("fx1", reducer_id="baseline"), _event("fx2", reducer_id="baseline")]


def _improving_intervention_events():
    # Better caching, fewer tokens, no quality/retry regression; full non-raw evidence.
    return [
        _event("fx1", cache_read=140, cache_write=8, ratio=0.85, input_tokens=300,
               output_tokens=150, cost=0.008, reduced_bytes=900),
        _event("fx2", cache_read=140, cache_write=8, ratio=0.85, input_tokens=300,
               output_tokens=150, cost=0.008, reduced_bytes=900),
    ]


def _canary_pass_report(reducer_id="r1"):
    # The B2 canary report now carries the top-level reducer_id it actually exercised; the B3
    # gate honors a pass only when this matches the intervention events' reducer_id.
    return {"schema": "agent-runtime-compaction-survival-canary",
            "reducer_id": reducer_id,
            "summary": {"verdict": "pass", "pass_count": 6, "fail_count": 0}}


def _canary_fail_report(reducer_id="r1"):
    return {"schema": "agent-runtime-compaction-survival-canary",
            "reducer_id": reducer_id,
            "summary": {"verdict": "fail", "pass_count": 5, "fail_count": 1,
                        "fail_reasons": {"compacted_missing_required_anchor": 1}}}


def _handle_present_report():
    return {"schema": "agent-runtime-raw-output-handle-protocol",
            "metadata": {"handle": "a" * 64, "store_status": "stored", "reduced_applied": True}}


def _handle_absent_report():
    return {"schema": "agent-runtime-raw-output-handle-protocol",
            "metadata": {"handle": None, "store_status": "store_error"}}


def _build(d, base_events, interv_events, canary, handle, measurement_only=False):
    """Materialize fixtures in dir d and return the evaluated report."""
    bp = Path(d) / "base.jsonl"
    ip = Path(d) / "int.jsonl"
    cp = Path(d) / "canary.json"
    hp = Path(d) / "handle.json"
    _write_jsonl(bp, base_events)
    _write_jsonl(ip, interv_events)
    _write_json(cp, canary)
    _write_json(hp, handle)
    base_parsed = probe.parse_paired_trial_jsonl(bp)
    interv_parsed = probe.parse_paired_trial_jsonl(ip)
    return probe.evaluate(
        base_parsed, interv_parsed,
        probe.load_side_report(cp), probe.load_side_report(hp),
        measurement_only=measurement_only,
    )


# --------------------------------------------------------------------------- adoption-gate proofs


def test_clean_improving_intervention_is_adoption_eligible():
    with TemporaryDirectory() as d:
        report = _build(d, _baseline_events(), _improving_intervention_events(),
                        _canary_pass_report(), _handle_present_report())
    assert report["status"] == "adoption_eligible"
    assert report["adoption_eligible"] is True
    assert report["failed_predicates"] == []
    assert report["metrics"]["quality"]["pass_rate_delta"] >= 0
    assert report["metrics"]["cache"]["cache_read_delta"] >= 0


def test_corrupting_intervention_canary_fail_is_not_adoption_eligible():
    # Baseline vs a CORRUPTING intervention: the B2 canary reports a FAIL. Even with otherwise
    # improving metrics, adoption must be false and the canary predicate must be named.
    with TemporaryDirectory() as d:
        report = _build(d, _baseline_events(), _improving_intervention_events(),
                        _canary_fail_report(), _handle_present_report())
    assert report["adoption_eligible"] is False
    assert "canary_pass" in report["failed_predicates"]
    assert report["metrics"]["canary"]["reason"] == "canary_verdict_fail"


def test_raw_output_only_evidence_is_not_adoption_eligible():
    # Even with great savings + canary pass + handle, raw-output-%-ONLY evidence is rejected.
    raw_only = [
        _event("fx1", evidence_class="raw_output_only"),
        _event("fx2", evidence_class="raw_output_percent_only"),
    ]
    with TemporaryDirectory() as d:
        report = _build(d, _baseline_events(), raw_only,
                        _canary_pass_report(), _handle_present_report())
    assert report["adoption_eligible"] is False
    assert "evidence_not_raw_output_only" in report["failed_predicates"]
    assert report["metrics"]["evidence"]["raw_output_only"] is True


def test_mismatched_task_fixtures_is_not_comparable():
    mismatched = [_event("fx1"), _event("DIFFERENT_FX")]
    with TemporaryDirectory() as d:
        report = _build(d, _baseline_events(), mismatched,
                        _canary_pass_report(), _handle_present_report())
    assert report["status"] == "not_comparable"
    assert report["adoption_eligible"] is False
    assert "same_task_fixture_set" in report["failed_predicates"]
    assert "DIFFERENT_FX" in report["detail"]["only_in_intervention"]


def test_missing_handle_report_is_ineligible():
    with TemporaryDirectory() as d:
        bp, ip = Path(d) / "b.jsonl", Path(d) / "i.jsonl"
        cp = Path(d) / "c.json"
        _write_jsonl(bp, _baseline_events())
        _write_jsonl(ip, _improving_intervention_events())
        _write_json(cp, _canary_pass_report())
        # handle report path not supplied at all -> absent.
        report = probe.evaluate(
            probe.parse_paired_trial_jsonl(bp), probe.parse_paired_trial_jsonl(ip),
            probe.load_side_report(cp), probe.load_side_report(None),
        )
    assert report["status"] == "ineligible"
    assert report["adoption_eligible"] is False
    assert "handle_present" in report["failed_predicates"]


def test_missing_rollback_rule_is_not_eligible():
    no_rollback = [
        _event("fx1", rollback=None),
        _event("fx2", rollback=None),
    ]
    with TemporaryDirectory() as d:
        report = _build(d, _baseline_events(), no_rollback,
                        _canary_pass_report(), _handle_present_report())
    assert report["adoption_eligible"] is False
    assert "rollback_rule_present" in report["failed_predicates"]
    assert report["metrics"]["rollback"]["rollback_rule_present"] is False


# --------------------------------------------------------------------------- regression / worse-metric gates


def test_quality_regression_blocks_adoption():
    worse = [
        _event("fx1", quality_pass=False, quality_score=0.2),
        _event("fx2", quality_pass=True, quality_score=0.9),
    ]
    with TemporaryDirectory() as d:
        report = _build(d, _baseline_events(), worse,
                        _canary_pass_report(), _handle_present_report())
    assert report["adoption_eligible"] is False
    assert "quality_not_worse" in report["failed_predicates"]


def test_cache_regression_blocks_adoption():
    # Intervention HURTS caching (cache_read drops) -> cache_not_worse fails.
    worse_cache = [
        _event("fx1", cache_read=10, ratio=0.3),
        _event("fx2", cache_read=10, ratio=0.3),
    ]
    with TemporaryDirectory() as d:
        report = _build(d, _baseline_events(), worse_cache,
                        _canary_pass_report(), _handle_present_report())
    assert report["adoption_eligible"] is False
    assert "cache_not_worse" in report["failed_predicates"]
    assert report["metrics"]["cache"]["cache_read_delta"] < 0


def test_retry_regression_blocks_adoption():
    more_retries = [_event("fx1", retry=3), _event("fx2", retry=3)]
    with TemporaryDirectory() as d:
        report = _build(d, _baseline_events(), more_retries,
                        _canary_pass_report(), _handle_present_report())
    assert report["adoption_eligible"] is False
    assert "retry_not_worse" in report["failed_predicates"]


def test_handle_absent_report_blocks_adoption():
    with TemporaryDirectory() as d:
        report = _build(d, _baseline_events(), _improving_intervention_events(),
                        _canary_pass_report(), _handle_absent_report())
    assert report["adoption_eligible"] is False
    assert "handle_present" in report["failed_predicates"]
    assert report["metrics"]["handle"]["handle_present"] is False


def test_missing_cache_metrics_is_ineligible_for_adoption_unless_measurement_only():
    no_cache = [
        _event("fx1", cache_read=None, cache_write=None, ratio=None),
        _event("fx2", cache_read=None, cache_write=None, ratio=None),
    ]
    # Stripping cache fields entirely (None values get filtered as absent metrics).
    for e in no_cache:
        for f in ("cache_read", "cache_write", "cache_read_to_input_ratio"):
            e.pop(f, None)
    with TemporaryDirectory() as d:
        report = _build(d, _baseline_events(), no_cache,
                        _canary_pass_report(), _handle_present_report())
        assert report["status"] == "ineligible_for_adoption"
        assert "cache_metrics_present" in report["failed_predicates"]
        # measurement_only scope moves past the cache gate but NEVER grants adoption (F3):
        # the status becomes measurement_only_no_adoption and adoption stays False.
        report2 = _build(d, _baseline_events(), no_cache,
                         _canary_pass_report(), _handle_present_report(),
                         measurement_only=True)
        assert report2["status"] == "measurement_only_no_adoption"
        assert report2["adoption_eligible"] is False


# --------------------------------------------------------------------------- UNHAPPY: malformed / missing JSONL


def test_malformed_baseline_jsonl_yields_typed_parse_status_not_comparable():
    with TemporaryDirectory() as d:
        bad = Path(d) / "bad.jsonl"
        bad.write_text("{not valid json at all\n")
        parsed = probe.parse_paired_trial_jsonl(bad)
        assert parsed["parse_status"] == "invalid"
        assert parsed["error_type"] == "JSONDecodeError"
        good = Path(d) / "good.jsonl"
        _write_jsonl(good, _baseline_events())
        report = probe.evaluate(parsed, probe.parse_paired_trial_jsonl(good),
                                probe.load_side_report(None), probe.load_side_report(None))
        assert report["status"] == "not_comparable"
        assert "paired_trial_parse" in report["failed_predicates"]


def test_missing_baseline_file_is_missing_parse_status():
    with TemporaryDirectory() as d:
        parsed = probe.parse_paired_trial_jsonl(Path(d) / "nope.jsonl")
        assert parsed["parse_status"] == "missing"
        assert parsed["error_type"] == "FileNotFoundError"


def test_event_missing_required_field_marks_missing_required_fields():
    with TemporaryDirectory() as d:
        p = Path(d) / "partial.jsonl"
        ev = _event("fx1")
        ev.pop("retry_count")  # drop a REQUIRED field
        _write_jsonl(p, [ev])
        parsed = probe.parse_paired_trial_jsonl(p)
        assert parsed["parse_status"] == "missing_required_fields"
        assert parsed["missing_field_lines"][0]["missing"] == ["retry_count"]


def test_non_object_jsonl_line_is_invalid():
    with TemporaryDirectory() as d:
        p = Path(d) / "list.jsonl"
        p.write_text("[1, 2, 3]\n")
        parsed = probe.parse_paired_trial_jsonl(p)
        assert parsed["parse_status"] == "invalid"
        assert parsed["error_type"] == "non_object_line"


def test_empty_jsonl_is_empty_parse_status():
    with TemporaryDirectory() as d:
        p = Path(d) / "empty.jsonl"
        p.write_text("\n   \n")
        parsed = probe.parse_paired_trial_jsonl(p)
        assert parsed["parse_status"] == "empty"


def test_jsonl_read_error_is_typed():
    with TemporaryDirectory() as d:
        p = Path(d) / "exists.jsonl"
        _write_jsonl(p, _baseline_events())
        orig = probe.Path.read_text
        probe.Path.read_text = lambda self, *a, **k: (_ for _ in ()).throw(OSError("denied"))
        try:
            parsed = probe.parse_paired_trial_jsonl(p)
        finally:
            probe.Path.read_text = orig
        assert parsed["parse_status"] == "read_error"
        assert parsed["error_type"] == "OSError"


def test_side_report_malformed_is_typed_and_non_pass():
    with TemporaryDirectory() as d:
        bad = Path(d) / "bad.json"
        bad.write_text("{not json")
        side = probe.load_side_report(bad)
        assert side["parse_status"] == "invalid"
        assert probe.canary_passed(side)["canary_pass"] is False
        assert probe.handle_present(side)["handle_present"] is False


def test_side_report_missing_file_is_typed():
    with TemporaryDirectory() as d:
        side = probe.load_side_report(Path(d) / "nope.json")
        assert side["parse_status"] == "missing"
        assert side["error_type"] == "FileNotFoundError"


def test_side_report_read_error_is_typed():
    with TemporaryDirectory() as d:
        p = Path(d) / "exists.json"
        _write_json(p, _canary_pass_report())
        orig = probe.Path.read_text
        probe.Path.read_text = lambda self, *a, **k: (_ for _ in ()).throw(OSError("denied"))
        try:
            side = probe.load_side_report(p)
        finally:
            probe.Path.read_text = orig
        assert side["parse_status"] == "read_error"
        assert side["error_type"] == "OSError"


def test_side_report_non_object_is_invalid():
    with TemporaryDirectory() as d:
        p = Path(d) / "list.json"
        p.write_text("[1,2,3]")
        side = probe.load_side_report(p)
        assert side["parse_status"] == "invalid"
        assert side["error_type"] == "non_object_report"


def test_canary_unknown_shape_is_non_pass():
    side = {"present": True, "parse_status": "ok", "report": {"summary": {"verdict": "weird"}}}
    assert probe.canary_passed(side, "r1")["canary_pass"] is False
    assert probe.canary_passed(side, "r1")["reason"] == "canary_verdict_unknown_shape"


def test_canary_top_level_verdict_pass_supported():
    # A top-level verdict pass is honored only when the report's reducer_id matches the
    # intervention's; this report carries the same reducer the intervention claims.
    side = {"present": True, "parse_status": "ok",
            "report": {"verdict": "pass", "reducer_id": "r1"}}
    assert probe.canary_passed(side, "r1")["canary_pass"] is True


def test_handle_from_roundtrip_block_supported():
    side = {"present": True, "parse_status": "ok",
            "report": {"roundtrip": {"handle": "b" * 64, "byte_identical": True}}}
    assert probe.handle_present(side)["handle_present"] is True


# --------------------------------------------------------------------------- determinism


def test_determinism_same_input_same_report():
    with TemporaryDirectory() as d:
        r1 = _build(d, _baseline_events(), _improving_intervention_events(),
                    _canary_pass_report(), _handle_present_report())
        r2 = _build(d, _baseline_events(), _improving_intervention_events(),
                    _canary_pass_report(), _handle_present_report())
    # No ts/duration fields exist in the report; byte-identical JSON proves determinism.
    assert json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)


# --------------------------------------------------------------------------- supplemental run-health


def test_supplemental_run_ledger_degrades_typed_on_bad_path():
    with TemporaryDirectory() as d:
        bp, ip = Path(d) / "b.jsonl", Path(d) / "i.jsonl"
        _write_jsonl(bp, _baseline_events())
        _write_jsonl(ip, _improving_intervention_events())
        cp, hp = Path(d) / "c.json", Path(d) / "h.json"
        _write_json(cp, _canary_pass_report())
        _write_json(hp, _handle_present_report())
        args = probe.argparse.Namespace(
            baseline=str(bp), intervention=str(ip), canary_report=str(cp),
            handle_report=str(hp), run_ledger=str(Path(d) / "no-such-ledger.jsonl"),
            measurement_only=False, pretty=False)
        report = probe.build_report(args)
        assert "supplemental_run_health" in report
        health = report["supplemental_run_health"]
        assert health["supplemental_only"] is True


def test_supplemental_run_ledger_import_failure_is_typed_degraded():
    # Force the lazy import path to raise; assert a typed degraded marker (never silent).
    with TemporaryDirectory() as d:
        orig_modules = dict(sys.modules)
        sys.modules["tools"] = None  # importing attributes off None raises -> degraded marker
        try:
            health = probe._supplemental_run_health(Path(d) / "ledger.jsonl")
        finally:
            sys.modules.clear()
            sys.modules.update(orig_modules)
        assert health["supplemental_only"] is True
        assert health.get("status") == "degraded" or "summary" in health


# --------------------------------------------------------------------------- CLI / main()


def test_main_argv_eligible_returns_zero():
    with TemporaryDirectory() as d:
        bp, ip = Path(d) / "b.jsonl", Path(d) / "i.jsonl"
        cp, hp = Path(d) / "c.json", Path(d) / "h.json"
        _write_jsonl(bp, _baseline_events())
        _write_jsonl(ip, _improving_intervention_events())
        _write_json(cp, _canary_pass_report())
        _write_json(hp, _handle_present_report())
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = probe.main_argv(["--baseline", str(bp), "--intervention", str(ip),
                                  "--canary-report", str(cp), "--handle-report", str(hp),
                                  "--pretty"])
        assert rc == 0
        report = json.loads(buf.getvalue())
        assert report["adoption_eligible"] is True
        assert report["schema"] == "agent-runtime-paired-trial-harness"


def test_main_argv_corrupting_returns_nonzero():
    with TemporaryDirectory() as d:
        bp, ip = Path(d) / "b.jsonl", Path(d) / "i.jsonl"
        cp, hp = Path(d) / "c.json", Path(d) / "h.json"
        _write_jsonl(bp, _baseline_events())
        _write_jsonl(ip, _improving_intervention_events())
        _write_json(cp, _canary_fail_report())
        _write_json(hp, _handle_present_report())
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = probe.main_argv(["--baseline", str(bp), "--intervention", str(ip),
                                  "--canary-report", str(cp), "--handle-report", str(hp)])
        assert rc == 1
        assert json.loads(buf.getvalue())["adoption_eligible"] is False


def test_main_wrapper_delegates_to_main_argv():
    with TemporaryDirectory() as d:
        bp, ip = Path(d) / "b.jsonl", Path(d) / "i.jsonl"
        _write_jsonl(bp, _baseline_events())
        _write_jsonl(ip, _improving_intervention_events())
        orig = sys.argv
        sys.argv = ["paired_trial_harness.py", "--baseline", str(bp), "--intervention", str(ip)]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = probe.main()
        finally:
            sys.argv = orig
        # No cache gate issue here (events carry cache); but no canary/handle -> ineligible.
        assert rc == 1
        assert json.loads(buf.getvalue())["adoption_eligible"] is False


def test_cli_e2e_subprocess_corrupting_is_nonzero_and_names_predicate():
    with TemporaryDirectory() as d:
        bp, ip = Path(d) / "b.jsonl", Path(d) / "i.jsonl"
        cp, hp = Path(d) / "c.json", Path(d) / "h.json"
        _write_jsonl(bp, _baseline_events())
        _write_jsonl(ip, _improving_intervention_events())
        _write_json(cp, _canary_fail_report())
        _write_json(hp, _handle_present_report())
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--baseline", str(bp), "--intervention", str(ip),
             "--canary-report", str(cp), "--handle-report", str(hp)],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 1, proc.stderr
        report = json.loads(proc.stdout)
        assert report["schema"] == "agent-runtime-paired-trial-harness"
        assert report["adoption_eligible"] is False
        assert "canary_pass" in report["failed_predicates"]


def test_cli_e2e_subprocess_eligible_is_zero():
    with TemporaryDirectory() as d:
        bp, ip = Path(d) / "b.jsonl", Path(d) / "i.jsonl"
        cp, hp = Path(d) / "c.json", Path(d) / "h.json"
        _write_jsonl(bp, _baseline_events())
        _write_jsonl(ip, _improving_intervention_events())
        _write_json(cp, _canary_pass_report())
        _write_json(hp, _handle_present_report())
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--baseline", str(bp), "--intervention", str(ip),
             "--canary-report", str(cp), "--handle-report", str(hp)],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 0, proc.stderr
        assert json.loads(proc.stdout)["adoption_eligible"] is True


# --------------------------------------------------------------------------- F1/F2/F3 gate-hole regressions


def test_f1_per_fixture_quality_swap_blocks_adoption():
    # F1: aggregate pass-rate is identical (one pass, one fail on each side) yet the reducer
    # BROKE fixture fx1 (was pass, now fail) and merely flipped fx2 (was fail, now pass).
    # A paired PER-FIXTURE comparison must catch the fx1 regression that the aggregate hides.
    baseline = [
        _event("fx1", quality_pass=True, quality_score=0.9),
        _event("fx2", quality_pass=False, quality_score=0.4),
    ]
    intervention = [
        _event("fx1", quality_pass=False, quality_score=0.3),  # REGRESSED
        _event("fx2", quality_pass=True, quality_score=0.95),   # improved
    ]
    with TemporaryDirectory() as d:
        report = _build(d, baseline, intervention,
                        _canary_pass_report(), _handle_present_report())
    # Aggregate pass-rate delta is exactly zero — the old gate would have let this through.
    assert report["metrics"]["quality"]["pass_rate_delta"] == 0
    assert report["adoption_eligible"] is False
    assert "no_per_fixture_quality_regression" in report["failed_predicates"]
    pf = report["metrics"]["quality"]["per_fixture"]
    assert "fx1" in pf["pass_regression_fixtures"]
    assert pf["no_per_fixture_quality_regression"] is False


def test_f1_per_fixture_retry_spike_not_hidden_by_sum():
    # F1: a per-fixture retry SPIKE on fx1 is masked in the aggregate sum by fx2 dropping to 0.
    baseline = [_event("fx1", retry=2), _event("fx2", retry=2)]
    intervention = [_event("fx1", retry=4), _event("fx2", retry=0)]  # sum unchanged (4)
    with TemporaryDirectory() as d:
        report = _build(d, baseline, intervention,
                        _canary_pass_report(), _handle_present_report())
    # Aggregate retry delta nets to zero, so retry_not_worse alone would pass.
    assert report["metrics"]["retries"]["retry_delta"] == 0
    assert report["adoption_eligible"] is False
    assert "no_per_fixture_retry_regression" in report["failed_predicates"]
    pf = report["metrics"]["quality"]["per_fixture"]
    assert any(r["fixture"] == "fx1" for r in pf["retry_regression_fixtures"])


def test_f3_measurement_only_never_grants_adoption():
    # F3: measurement-only + zero cache fields + otherwise-good quality/canary/handle/rollback
    # must NOT yield adoption_eligible=true. measurement-only is an audit scope, never a grant.
    no_cache = [_event("fx1"), _event("fx2")]
    for e in no_cache:
        for f in ("cache_read", "cache_write", "cache_read_to_input_ratio"):
            e.pop(f, None)
    with TemporaryDirectory() as d:
        report = _build(d, _baseline_events(), no_cache,
                        _canary_pass_report(), _handle_present_report(),
                        measurement_only=True)
    assert report["adoption_eligible"] is False
    assert report["status"] == "measurement_only_no_adoption"
    assert "measurement_only_no_adoption" in report["failed_predicates"]


def test_f3_both_sides_missing_cache_metric_is_cache_unproven_not_ok():
    # F3 (cache absence): with cache metrics absent on BOTH sides but measurement_only NOT set,
    # _cache_not_worse must fail-closed (absence is never 'not worse'). The cache gate reports
    # ineligible_for_adoption, and _cache_not_worse(cache) returns False for the unproven cache.
    no_cache = [_event("fx1"), _event("fx2")]
    for e in no_cache:
        for f in ("cache_read", "cache_write", "cache_read_to_input_ratio"):
            e.pop(f, None)
    base_no_cache = [_event("fx1", reducer_id="baseline"),
                     _event("fx2", reducer_id="baseline")]
    for e in base_no_cache:
        for f in ("cache_read", "cache_write", "cache_read_to_input_ratio"):
            e.pop(f, None)
    with TemporaryDirectory() as d:
        report = _build(d, base_no_cache, no_cache,
                        _canary_pass_report(), _handle_present_report())
    assert report["adoption_eligible"] is False
    assert report["status"] == "ineligible_for_adoption"
    # The unproven cache must NOT silently pass _cache_not_worse.
    assert probe._cache_not_worse(report["metrics"]["cache"]) is False


def test_f2_canary_reducer_mismatch_blocks_adoption():
    # F2: the canary report tested reducer_id="identity" but the intervention events claim
    # reducer_id="candidate_x". Even with verdict=pass, the canary must NOT be honored.
    intervention = [
        _event("fx1", reducer_id="candidate_x"),
        _event("fx2", reducer_id="candidate_x"),
    ]
    with TemporaryDirectory() as d:
        report = _build(d, _baseline_events(), intervention,
                        _canary_pass_report(reducer_id="identity"),
                        _handle_present_report())
    assert report["adoption_eligible"] is False
    assert "canary_pass" in report["failed_predicates"]
    assert report["metrics"]["canary"]["reason"] == "canary_reducer_mismatch"
    assert report["metrics"]["canary"]["canary_reducer_id"] == "identity"
    assert report["metrics"]["canary"]["intervention_reducer_id"] == "candidate_x"


def test_f2_canary_missing_reducer_id_is_unproven_fail_closed():
    # F2 (graceful): a canary report with NO reducer_id cannot prove it tested THIS reducer.
    side = {"present": True, "parse_status": "ok",
            "report": {"summary": {"verdict": "pass"}}}  # no reducer_id
    out = probe.canary_passed(side, "candidate_x")
    assert out["canary_pass"] is False
    assert out["reason"] == "canary_reducer_mismatch"
    assert out["mismatch_detail"] == "canary_report_missing_reducer_id"


def test_f2_ambiguous_intervention_reducer_id_is_none_fail_closed():
    # F2: when intervention events disagree on reducer_id, the id is ambiguous (None), so the
    # canary reducer-match cannot be satisfied even by a canary that names a real reducer.
    mixed = [_event("fx1", reducer_id="a"), _event("fx2", reducer_id="b")]
    assert probe.intervention_reducer_id_of(mixed) is None
    with TemporaryDirectory() as d:
        report = _build(d, _baseline_events(), mixed,
                        _canary_pass_report(reducer_id="a"), _handle_present_report())
    assert report["adoption_eligible"] is False
    assert "canary_pass" in report["failed_predicates"]
    assert report["metrics"]["canary"]["reason"] == "canary_reducer_mismatch"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} paired_trial_harness tests passed")
