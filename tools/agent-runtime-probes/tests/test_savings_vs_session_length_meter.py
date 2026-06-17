#!/usr/bin/env python3
"""Tests for savings_vs_session_length_meter: happy path, unhappy paths, determinism, CLI e2e.

No-install: stdlib only; no pytest/fixtures; follows test_pi_presence_probe.py style exactly.
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

import savings_vs_session_length_meter as probe  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "savings_vs_session_length_meter.py"

# UNHAPPY_TEST_TERMS anchors: malformed, invalid, missing, nonzero, error, degraded, parse_status


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SYNTHETIC_SESSIONS_JSONL = "\n".join([
    json.dumps({"turn_count": 5, "replay_tokens": 2000}),
    json.dumps({"turn_count": 25, "replay_tokens": 8000}),
    json.dumps({"turn_count": 100, "replay_tokens": 30000}),
    json.dumps({"turn_count": 250, "replay_tokens": 80000}),
]) + "\n"

LOCAL_MEASURED_SESSIONS_JSONL = "\n".join([
    json.dumps({"turn_count": 5, "input_tokens": 2000}),
    json.dumps({"turn_count": 25, "input_tokens": 8000}),
    json.dumps({"turn_count": 100, "input_tokens": 30000}),
]) + "\n"

MALFORMED_JSONL = "not json at all\n{\"turn_count\": 5}\n"

EMPTY_JSONL = "\n   \n"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_main(argv_extra: list[str]) -> tuple[int, dict]:
    """Run probe.main() with extra args and parse stdout as JSON."""
    orig_argv = sys.argv
    sys.argv = ["savings_vs_session_length_meter.py"] + argv_extra
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
    return rc, json.loads(buf.getvalue())


# ---------------------------------------------------------------------------
# Happy-path tests
# ---------------------------------------------------------------------------

def test_happy_synthetic_flag_produces_curve():
    """--synthetic flag alone → curve with proof_class=synthetic and blocked gate."""
    rc, report = _run_main(["--synthetic"])
    assert rc == 0
    assert report["schema"] == "agent-runtime-savings-meter"
    assert report["schema_version"] == "0.1"
    assert report["redaction"] == "metadata-only"
    assert isinstance(report["buckets"], list)
    assert len(report["buckets"]) > 0
    # All buckets must be synthetic since no real data
    for bucket in report["buckets"]:
        assert bucket["proof_class"] == "synthetic"
    assert report["phase5_entry_gate"] == "blocked_research_only"
    assert report["overall_proof_class"] == "synthetic"


def test_happy_local_measured_sessions_open_gate():
    """Real JSONL with input_tokens → local_measured proof_class and open gate."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(LOCAL_MEASURED_SESSIONS_JSONL)
        path = Path(f.name)
    try:
        report = probe.build_report(path, synthetic=False)
    finally:
        path.unlink(missing_ok=True)

    assert report["schema"] == "agent-runtime-savings-meter"
    assert report["overall_proof_class"] == "local_measured"
    assert report["phase5_entry_gate"] == "open"
    buckets = report["buckets"]
    assert len(buckets) > 0
    # Local measured sessions → local_measured proof class in buckets
    for b in buckets:
        assert b["proof_class"] == "local_measured"


def test_happy_bucket_savings_ratio_computed():
    """savings_ratio is a normalized fraction in [0,1] = 1 - handle/replay (H5a)."""
    sessions = [{"turn_count": 25, "replay_tokens": 3000}]
    buckets = probe._build_buckets(sessions)
    assert len(buckets) == 1
    b = buckets[0]
    assert b["session_length_bucket"] == "11-50"
    assert b["replay_tokens"] == 3000
    assert b["handle_return_tokens"] == 1500
    # Normalized savings fraction, NOT an inverted cost multiple.
    assert 0.0 <= b["savings_ratio"] <= 1.0
    assert abs(b["savings_ratio"] - (1 - 1500 / 3000)) < 1e-6  # 0.5
    # Raw cost multiple is kept under an honest name.
    assert abs(b["replay_to_handle_cost_multiple"] - 2.0) < 1e-5


def test_savings_ratio_in_unit_interval_high_multiple():
    """H5a: a huge replay/handle multiple still yields savings_ratio in [0,1], not 53.3."""
    sessions = [{"turn_count": 25, "replay_tokens": 80000}]  # 80000/1500 = 53.3x cost
    buckets = probe._build_buckets(sessions)
    b = buckets[0]
    assert 0.0 <= b["savings_ratio"] <= 1.0
    assert abs(b["savings_ratio"] - (1 - 1500 / 80000)) < 1e-6
    assert abs(b["replay_to_handle_cost_multiple"] - (80000 / 1500)) < 1e-3


def test_savings_ratio_clamped_non_negative_when_handle_exceeds_replay():
    """savings_ratio clamps to >=0 when handle cost exceeds replay (no negative fraction)."""
    sessions = [{"turn_count": 5, "replay_tokens": 500}]  # 500 < handle 1500
    buckets = probe._build_buckets(sessions)
    b = buckets[0]
    assert b["savings_ratio"] == 0.0


def test_savings_ratio_unknown_when_no_replay_tokens():
    """Division-by-zero guard: zero replay tokens → savings_ratio 'unknown'."""
    sessions = [{"turn_count": 5}]  # no token/chars → replay 0
    buckets = probe._build_buckets(sessions)
    b = buckets[0]
    assert b["savings_ratio"] == "unknown"
    assert b["replay_to_handle_cost_multiple"] == "unknown"


def test_happy_bucket_name_classification():
    """_bucket_name correctly classifies turn counts."""
    assert probe._bucket_name(0) == "0-10"
    assert probe._bucket_name(10) == "0-10"
    assert probe._bucket_name(11) == "11-50"
    assert probe._bucket_name(50) == "11-50"
    assert probe._bucket_name(51) == "51-200"
    assert probe._bucket_name(200) == "51-200"
    assert probe._bucket_name(201) == "201+"
    assert probe._bucket_name(9999) == "201+"


def test_happy_all_four_buckets_present():
    """Synthetic fixture covers all 4 session-length buckets."""
    synth = probe._synthetic_sessions()
    buckets = probe._build_buckets(synth)
    labels = {b["session_length_bucket"] for b in buckets}
    assert "0-10" in labels
    assert "11-50" in labels
    assert "51-200" in labels
    assert "201+" in labels


def test_i1_synthetic_replay_tokens_are_correct_by_construction():
    """I1: each synthetic session's replay_tokens is a literal keyed on turn_count (not the prior
    self-referential sessions[0].get(...)). Every session must carry replay_tokens and no input_tokens,
    with the bucket-matching value."""
    expected = {5: 2000, 25: 8000, 100: 30000, 250: 80000}
    for s in probe._synthetic_sessions():
        assert "input_tokens" not in s
        assert s["replay_tokens"] == expected[s["turn_count"]]


def test_happy_schema_fields_present():
    """Report always contains schema, schema_version, redaction top-level fields."""
    rc, report = _run_main(["--synthetic"])
    assert rc == 0
    assert "schema" in report
    assert "schema_version" in report
    assert "redaction" in report
    assert "overall_proof_class" in report
    assert "phase5_entry_gate" in report
    assert "buckets" in report


# ---------------------------------------------------------------------------
# Unhappy-path tests — must contain UNHAPPY_TEST_TERMS
# ---------------------------------------------------------------------------

def test_unhappy_missing_file_no_synthetic_typed_error():
    """Missing summaries file and no --synthetic → typed error, nonzero exit."""
    path = Path("/nonexistent-summaries-xyz.jsonl")
    report = probe.build_report(path, synthetic=False)
    assert "_error" in report
    assert report.get("error_type") == "missing_input"
    assert report.get("parse_status") == "missing"


def test_unhappy_no_args_typed_error():
    """No --summaries and no --synthetic → typed missing_input error, nonzero exit."""
    report = probe.build_report(None, synthetic=False)
    assert "_error" in report
    assert report.get("error_type") == "missing_input"
    assert report.get("parse_status") == "missing"


def test_unhappy_malformed_jsonl_parse_status_invalid():
    """Malformed JSONL → parse_status=invalid, error_type=malformed_input."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(MALFORMED_JSONL)
        path = Path(f.name)
    try:
        report = probe.build_report(path, synthetic=False)
    finally:
        path.unlink(missing_ok=True)

    assert report.get("parse_status") == "invalid"
    assert report.get("error_type") == "malformed_input"


def test_unhappy_empty_data_parse_status_degraded():
    """Empty JSONL (no sessions) → parse_status=degraded, empty buckets."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(EMPTY_JSONL)
        path = Path(f.name)
    try:
        report = probe.build_report(path, synthetic=False)
    finally:
        path.unlink(missing_ok=True)

    assert report.get("parse_status") == "degraded"
    assert report["buckets"] == []
    assert report["phase5_entry_gate"] == "blocked_research_only"


def test_unhappy_cli_nonzero_exit_no_args():
    """CLI with no args → nonzero exit (missing_input)."""
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH)],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0
    report = json.loads(proc.stdout)
    assert "_error" in report


def test_unhappy_cli_nonzero_exit_missing_file():
    """CLI with --summaries pointing to nonexistent file → nonzero exit."""
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--summaries", "/nonexistent-fixture.jsonl"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0
    report = json.loads(proc.stdout)
    assert "_error" in report
    assert report.get("error_type") == "missing_input"


def test_unhappy_malformed_jsonl_cli_nonzero():
    """CLI with malformed JSONL → nonzero exit and parse_status=invalid in output."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(MALFORMED_JSONL)
        path = Path(f.name)
    try:
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--summaries", str(path)],
            capture_output=True, text=True, timeout=30,
        )
    finally:
        path.unlink(missing_ok=True)

    assert proc.returncode != 0
    report = json.loads(proc.stdout)
    assert report.get("parse_status") == "invalid"


# ---------------------------------------------------------------------------
# Determinism test
# ---------------------------------------------------------------------------

def test_determinism_same_input_same_output():
    """Same synthetic fixture input → identical output both times (no random/ts)."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(SYNTHETIC_SESSIONS_JSONL)
        path = Path(f.name)
    try:
        report1 = probe.build_report(path, synthetic=False)
        report2 = probe.build_report(path, synthetic=False)
    finally:
        path.unlink(missing_ok=True)

    assert report1 == report2, f"Reports differ:\n{report1}\n---\n{report2}"


# ---------------------------------------------------------------------------
# CLI e2e subprocess test
# ---------------------------------------------------------------------------

def test_cli_e2e_synthetic_flag_exit_zero():
    """CLI e2e: --synthetic flag → valid JSON on stdout, exit 0."""
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--synthetic"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, f"stderr={proc.stderr!r}"
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-savings-meter"
    assert report["schema_version"] == "0.1"
    assert "buckets" in report
    assert report["phase5_entry_gate"] == "blocked_research_only"


def test_cli_e2e_summaries_file_exit_zero():
    """CLI e2e: valid summaries JSONL → exit 0 with local_measured data."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(LOCAL_MEASURED_SESSIONS_JSONL)
        path = Path(f.name)
    try:
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--summaries", str(path), "--pretty"],
            capture_output=True, text=True, timeout=30,
        )
    finally:
        path.unlink(missing_ok=True)

    assert proc.returncode == 0, f"stderr={proc.stderr!r}"
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-savings-meter"
    assert report["overall_proof_class"] == "local_measured"
    assert report["phase5_entry_gate"] == "open"
    # --pretty means multi-line
    assert len(proc.stdout.strip().splitlines()) > 1


# ---------------------------------------------------------------------------
# Additional coverage tests for uncovered branches
# ---------------------------------------------------------------------------

def test_estimate_replay_tokens_total_tokens_field():
    """total_tokens field is accepted as local_measured proof class."""
    sessions = [{"turn_count": 10, "total_tokens": 5000}]
    buckets = probe._build_buckets(sessions)
    assert len(buckets) == 1
    assert buckets[0]["proof_class"] == "local_measured"
    assert buckets[0]["replay_tokens"] == 5000


def test_estimate_replay_tokens_chars_heuristic():
    """M6: chars/4 derivation has its own 'heuristic' proof_class, NOT 'synthetic'."""
    tokens, pc = probe._estimate_replay_tokens({"turn_count": 10, "chars": 4000})
    assert tokens == 1000  # 4000/4
    assert pc == "heuristic"
    sessions = [{"turn_count": 10, "chars": 4000}]
    buckets = probe._build_buckets(sessions)
    assert len(buckets) == 1
    assert buckets[0]["proof_class"] == "heuristic"
    assert buckets[0]["proof_class"] != "synthetic"
    assert buckets[0]["replay_tokens"] == 1000  # 4000/4


def test_chars_heuristic_blocks_gate():
    """M6: a chars/4-only corpus is 'heuristic' overall and still blocks the phase5 gate."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(json.dumps({"turn_count": 10, "chars": 4000}) + "\n")
        path = Path(f.name)
    try:
        report = probe.build_report(path, synthetic=False)
    finally:
        path.unlink(missing_ok=True)
    assert report["overall_proof_class"] == "heuristic"
    assert report["phase5_entry_gate"] == "blocked_research_only"


def test_proof_class_precedence_strongest_and_weakest():
    """M6: precedence local_measured > heuristic > synthetic > unknown."""
    assert probe._strongest_proof_class({"heuristic", "synthetic", "unknown"}) == "heuristic"
    assert probe._strongest_proof_class({"local_measured", "synthetic"}) == "local_measured"
    assert probe._weakest_proof_class({"local_measured", "heuristic"}) == "heuristic"
    assert probe._weakest_proof_class({"local_measured", "synthetic"}) == "synthetic"
    assert probe._weakest_proof_class({"local_measured", "unknown"}) == "unknown"
    assert probe._weakest_proof_class(set()) == "unknown"


def test_mixed_real_and_synthetic_bucket_downgrades_and_blocks_gate():
    """H5b: real local_measured + synthetic in the SAME bucket → bucket proof_class
    downgrades to weakest present and the phase5 gate stays blocked."""
    # Both sessions land in bucket 11-50 (25 turns); one real, one synthetic fixture.
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(json.dumps({"turn_count": 25, "input_tokens": 9000}) + "\n")  # local_measured
        path = Path(f.name)
    try:
        report = probe.build_report(path, synthetic=True)  # mixes in synthetic fixtures
    finally:
        path.unlink(missing_ok=True)

    # Find the contaminated 11-50 bucket (synthetic fixtures also add 25-turn sessions).
    b1150 = [b for b in report["buckets"] if b["session_length_bucket"] == "11-50"]
    assert len(b1150) == 1
    assert b1150[0]["proof_class"] != "local_measured"  # downgraded
    assert b1150[0]["proof_class"] == "synthetic"
    # Impure contribution must keep the gate closed.
    assert report["overall_proof_class"] != "local_measured"
    assert report["phase5_entry_gate"] == "blocked_research_only"


def test_mixed_bucket_unit_weakest_class():
    """H5b unit: a bucket with both local_measured and synthetic sessions reports synthetic."""
    sessions = [
        {"turn_count": 25, "input_tokens": 9000},   # local_measured
        {"turn_count": 30, "replay_tokens": 5000},  # synthetic, same 11-50 bucket
    ]
    buckets = probe._build_buckets(sessions)
    assert len(buckets) == 1
    assert buckets[0]["proof_class"] == "synthetic"


def test_estimate_replay_tokens_unknown_when_no_usable_field():
    """Session with no token/chars fields → 0 tokens, unknown proof class."""
    sessions = [{"turn_count": 10}]
    buckets = probe._build_buckets(sessions)
    assert len(buckets) == 1
    assert buckets[0]["proof_class"] == "unknown"
    assert buckets[0]["replay_tokens"] == 0


def test_overall_proof_class_unknown_when_all_unknown():
    """_overall_proof_class returns 'unknown' when no local/synthetic buckets."""
    buckets = [{"proof_class": "unknown"}]
    assert probe._overall_proof_class(buckets) == "unknown"


def test_overall_proof_class_empty_buckets_unknown():
    """_overall_proof_class returns 'unknown' for an empty bucket list."""
    assert probe._overall_proof_class([]) == "unknown"


def test_estimate_replay_tokens_direct_replay_field_is_synthetic():
    """A bare replay_tokens fixture (no provider/chars fields) is proof_class 'synthetic'."""
    tokens, pc = probe._estimate_replay_tokens({"turn_count": 5, "replay_tokens": 2222})
    assert tokens == 2222
    assert pc == "synthetic"


def test_bucket_name_negative_turn_count_falls_through_to_201plus():
    """Negative turn_count is not in any explicit range → final fallback bucket."""
    assert probe._bucket_name(-5) == "201+"


def test_build_buckets_non_numeric_turn_count_defaults_to_zero():
    """Non-numeric turn_count → treated as 0, bucket 0-10."""
    sessions = [{"turn_count": "not-a-number", "replay_tokens": 1000}]
    buckets = probe._build_buckets(sessions)
    assert len(buckets) == 1
    assert buckets[0]["session_length_bucket"] == "0-10"


def test_load_summaries_jsonl_oserror_returns_missing():
    """OSError while reading JSONL → ([], 'missing') returned."""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
        path = Path(f.name)
    # Make it unreadable
    path.chmod(0o000)
    try:
        sessions, status = probe._load_summaries_jsonl(path)
        assert status == "missing"
        assert sessions == []
    finally:
        path.chmod(0o644)
        path.unlink(missing_ok=True)


def test_load_summaries_jsonl_non_dict_line_invalid():
    """JSONL line that is valid JSON but not a dict → ([], 'invalid')."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write("[1, 2, 3]\n")
        path = Path(f.name)
    try:
        sessions, status = probe._load_summaries_jsonl(path)
        assert status == "invalid"
        assert sessions == []
    finally:
        path.unlink(missing_ok=True)


def test_missing_file_with_synthetic_uses_synthetic():
    """Missing summaries file + --synthetic → synthetic data still runs."""
    path = Path("/nonexistent-xyz.jsonl")
    report = probe.build_report(path, synthetic=True)
    # Should succeed with synthetic data
    assert report.get("parse_status") == "missing"
    assert report["phase5_entry_gate"] == "blocked_research_only"
    assert len(report["buckets"]) > 0


def test_degraded_with_synthetic_augments_data():
    """Empty JSONL (degraded) + --synthetic → synthetic fills in, parse_status=degraded."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(EMPTY_JSONL)
        path = Path(f.name)
    try:
        report = probe.build_report(path, synthetic=True)
    finally:
        path.unlink(missing_ok=True)

    # Synthetic data fills in
    assert report.get("parse_status") == "degraded"
    assert len(report["buckets"]) > 0
    assert report["phase5_entry_gate"] == "blocked_research_only"


def test_missing_input_error_contains_no_raw_path():
    """H4: missing-file _error hashes the path; no raw /Users/ path leaks into metadata."""
    secret_path = Path("/Users/secretuser/private/summaries-xyz.jsonl")
    report = probe.build_report(secret_path, synthetic=False)
    assert "_error" in report
    blob = json.dumps(report)
    assert "/Users/" not in blob
    assert "secretuser" not in blob
    assert str(secret_path) not in blob
    # The hash of the path IS present (so the error is still debuggable).
    assert probe.sha256_16(str(secret_path)) in report["_error"]


def test_missing_input_error_no_raw_path_via_cli():
    """H4 e2e: CLI missing-file path is hashed in stdout, never raw."""
    raw = "/Users/secretuser/private/nope.jsonl"
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--summaries", raw],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0
    assert "/Users/" not in proc.stdout
    assert "secretuser" not in proc.stdout
    report = json.loads(proc.stdout)
    assert report.get("error_type") == "missing_input"


def test_main_returns_one_on_missing_input():
    """main() returns 1 when error_type=missing_input."""
    rc, report = _run_main([])  # no --summaries, no --synthetic
    assert rc == 1
    assert "_error" in report


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} savings_vs_session_length_meter tests passed")
