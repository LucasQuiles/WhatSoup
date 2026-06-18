#!/usr/bin/env python3
"""Tests for block_window_auditor: happy path (19/20/21 block boundary), unhappy paths,
determinism, and CLI e2e.

No-install: stdlib only; no pytest/fixtures.
Follows the test_pi_presence_probe.py / test_usage_truth_probe.py standalone-runner style.
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

import block_window_auditor as probe  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "block_window_auditor.py"


# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------

def _make_stream_jsonl(block_count: int, with_usage: bool = False, cache_read: int = 0) -> str:
    """Build a synthetic stream JSONL with the given number of content_block_start events."""
    lines = []
    # Optional: message_start with usage
    if with_usage:
        lines.append(json.dumps({
            "type": "message_start",
            "message": {
                "usage": {
                    "input_tokens": 50000,
                    "cache_read_input_tokens": cache_read,
                    "cache_creation_input_tokens": 0,
                    "output_tokens": 0,
                }
            },
        }))
    for i in range(block_count):
        lines.append(json.dumps({
            "type": "content_block_start",
            "index": i,
            "content_block": {"type": "text", "text": ""},
        }))
    lines.append(json.dumps({"type": "message_stop"}))
    return "\n".join(lines) + "\n"


def _write_jsonl(content: str) -> Path:
    """Write content to a temp .jsonl file and return its Path."""
    f = tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False)
    f.write(content)
    f.close()
    return Path(f.name)


def _run_main_with_args(path: Path, extra_args: list[str] | None = None) -> tuple[int, dict]:
    """Run probe.main() with --capture <path> [extra_args] and parse stdout as JSON."""
    orig_argv = sys.argv
    args = ["block_window_auditor.py", "--capture", str(path)]
    if extra_args:
        args.extend(extra_args)
    sys.argv = args
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
    return rc, json.loads(buf.getvalue())


# ---------------------------------------------------------------------------
# Happy-path: boundary tests at 19, 20, 21 blocks
# ---------------------------------------------------------------------------

def test_19_blocks_exceeds_false():
    """19 content blocks → exceeds_20_lookback is False."""
    path = _write_jsonl(_make_stream_jsonl(19))
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report["schema"] == "agent-runtime-block-window"
    assert report["schema_version"] == "0.1"
    assert report["redaction"] == "metadata-only"
    assert report["content_blocks"] == 19
    assert report["exceeds_20_lookback"] is False
    assert report["recommended_breakpoint_every"] == 15
    assert report["provider_behavior_hypothesis"] == probe._PROVIDER_HYPOTHESIS
    assert "hypothesis" in report["provider_behavior_hypothesis"]


def test_20_blocks_exceeds_false():
    """20 content blocks → exceeds_20_lookback is False (boundary: window is >20, not >=20)."""
    path = _write_jsonl(_make_stream_jsonl(20))
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report["content_blocks"] == 20
    assert report["exceeds_20_lookback"] is False


def test_21_blocks_exceeds_true():
    """21 content blocks → exceeds_20_lookback flips to True."""
    path = _write_jsonl(_make_stream_jsonl(21))
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report["content_blocks"] == 21
    assert report["exceeds_20_lookback"] is True


def test_risk_field_high_above_20():
    """21 blocks → risk string contains HIGH."""
    path = _write_jsonl(_make_stream_jsonl(21))
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert "HIGH" in report["risk"]


def test_risk_field_low_at_15():
    """15 blocks → risk string contains LOW."""
    path = _write_jsonl(_make_stream_jsonl(15))
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert "LOW" in report["risk"]


def test_risk_field_medium_between_15_and_20():
    """Between 16 and 20 blocks → risk contains MEDIUM."""
    path = _write_jsonl(_make_stream_jsonl(17))
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert "MEDIUM" in report["risk"]


def test_cache_read_zero_unknown_without_floor():
    """No --floor → cache_read_zero_above_floor == 'unknown'."""
    path = _write_jsonl(_make_stream_jsonl(21, with_usage=True, cache_read=0))
    try:
        report = probe.build_report(path, floor=None)
    finally:
        path.unlink(missing_ok=True)
    assert report["cache_read_zero_above_floor"] == "unknown"


def test_cache_read_zero_true_when_zero_read_above_floor():
    """cache_read == 0 and input_tokens > floor → cache_read_zero_above_floor is True (risk flag)."""
    path = _write_jsonl(_make_stream_jsonl(21, with_usage=True, cache_read=0))
    try:
        report = probe.build_report(path, floor=1000)
    finally:
        path.unlink(missing_ok=True)
    assert report["cache_read_zero_above_floor"] is True


def test_cache_read_zero_false_when_cache_hit():
    """cache_read > 0 → cache_read_zero_above_floor is False (no risk)."""
    path = _write_jsonl(_make_stream_jsonl(21, with_usage=True, cache_read=8000))
    try:
        report = probe.build_report(path, floor=1000)
    finally:
        path.unlink(missing_ok=True)
    assert report["cache_read_zero_above_floor"] is False


def test_prefix_tokens_in_report():
    """--prefix-tokens value is annotated in the report metadata."""
    path = _write_jsonl(_make_stream_jsonl(10))
    try:
        report = probe.build_report(path, prefix_tokens=12345)
    finally:
        path.unlink(missing_ok=True)
    assert report.get("prefix_tokens") == 12345


def test_provider_hypothesis_is_string():
    """provider_behavior_hypothesis must be a string labeling claims as hypothesis."""
    path = _write_jsonl(_make_stream_jsonl(5))
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert isinstance(report["provider_behavior_hypothesis"], str)
    # Must clearly indicate it's a hypothesis, not a proof
    lower = report["provider_behavior_hypothesis"].lower()
    assert "hypothesis" in lower or "unverified" in lower


# ---------------------------------------------------------------------------
# UNHAPPY path tests (names/bodies include UNHAPPY_TEST_TERMS)
# ---------------------------------------------------------------------------

def test_missing_file_returns_typed_error():
    """Missing capture file → typed error dict with error_type=missing_input, exit nonzero."""
    path = Path("/nonexistent-block-window-capture-xyz.jsonl")
    report = probe.build_report(path)
    assert "_error" in report
    assert report.get("error_type") == "missing_input"


def test_missing_file_error_has_no_raw_path_only_hash():
    """H4: the _error marker must NOT leak the raw absolute path; a sha256_16 hash stands
    in for the path instead."""
    from probelib import sha256_16
    path = Path("/Users/secretuser/private/captures/leak-me.jsonl")
    report = probe.build_report(path)
    msg = report["_error"]
    assert "/Users/" not in msg
    assert str(path) not in msg
    # The hash of the path IS present (so the marker is still diagnosable).
    assert sha256_16(str(path)) in msg


def test_malformed_jsonl_returns_parse_status_invalid():
    """UNHAPPY_TEST_TERMS: malformed JSONL → parse_status='invalid'."""
    path = _write_jsonl("not json at all\n{\"type\": \"content_block_start\"}\n")
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report.get("parse_status") == "invalid"
    assert report.get("error_type") == "malformed_input"


def test_zero_blocks_returns_degraded_marker():
    """UNHAPPY_TEST_TERMS: 0 content blocks → parse_status='degraded', not absent/error."""
    # A valid JSONL with no content_block_start events
    content = "\n".join([
        json.dumps({"type": "message_start", "message": {}}),
        json.dumps({"type": "message_stop"}),
    ]) + "\n"
    path = _write_jsonl(content)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report.get("parse_status") == "degraded"
    assert report.get("content_blocks") == 0
    assert "degraded" in report.get("risk", "")


def test_oserror_on_read_returns_missing_input_error():
    """OSError during file read → typed missing_input error."""
    path = _write_jsonl(_make_stream_jsonl(5))
    orig_exists = Path.exists
    orig_read_text = Path.read_text

    def fake_exists(self: Path) -> bool:
        return True

    def fake_read_text(self: Path, **kwargs: object) -> str:
        raise OSError("permission denied")

    Path.exists = fake_exists  # type: ignore[method-assign]
    Path.read_text = fake_read_text  # type: ignore[method-assign]
    try:
        report = probe.build_report(path)
    finally:
        Path.exists = orig_exists  # type: ignore[method-assign]
        Path.read_text = orig_read_text  # type: ignore[method-assign]
        path.unlink(missing_ok=True)

    assert report.get("error_type") == "missing_input"
    assert "_error" in report


def test_cli_missing_file_exits_nonzero():
    """CLI: missing capture → exit nonzero and typed error in stdout."""
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--capture", "/nonexistent-block-window.jsonl"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0
    report = json.loads(proc.stdout)
    assert "_error" in report


# ---------------------------------------------------------------------------
# Determinism test
# ---------------------------------------------------------------------------

def test_determinism_identical_input_produces_identical_report():
    """Two calls with identical content produce identical reports (no timestamp/random)."""
    path = _write_jsonl(_make_stream_jsonl(21))
    try:
        report1 = probe.build_report(path)
        report2 = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report1 == report2, f"Reports differ:\n{report1}\n---\n{report2}"


# ---------------------------------------------------------------------------
# CLI e2e tests
# ---------------------------------------------------------------------------

def test_cli_e2e_happy_19_blocks():
    """CLI e2e: 19-block capture → exit 0, valid JSON, exceeds_20_lookback False."""
    path = _write_jsonl(_make_stream_jsonl(19))
    try:
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--capture", str(path)],
            capture_output=True, text=True, timeout=30,
        )
    finally:
        path.unlink(missing_ok=True)
    assert proc.returncode == 0, f"stderr={proc.stderr!r}"
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-block-window"
    assert report["schema_version"] == "0.1"
    assert report["exceeds_20_lookback"] is False


def test_cli_e2e_happy_21_blocks():
    """CLI e2e: 21-block capture → exit 0, valid JSON, exceeds_20_lookback True."""
    path = _write_jsonl(_make_stream_jsonl(21))
    try:
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--capture", str(path)],
            capture_output=True, text=True, timeout=30,
        )
    finally:
        path.unlink(missing_ok=True)
    assert proc.returncode == 0, f"stderr={proc.stderr!r}"
    report = json.loads(proc.stdout)
    assert report["exceeds_20_lookback"] is True
    assert "HIGH" in report["risk"]


def test_cli_e2e_pretty_flag():
    """CLI e2e: --pretty flag produces multi-line indented JSON."""
    path = _write_jsonl(_make_stream_jsonl(10))
    try:
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--capture", str(path), "--pretty"],
            capture_output=True, text=True, timeout=30,
        )
    finally:
        path.unlink(missing_ok=True)
    assert proc.returncode == 0
    lines = proc.stdout.strip().splitlines()
    assert len(lines) > 1, "Expected multi-line pretty-printed JSON"
    json.loads(proc.stdout)  # must still be valid JSON


def test_cli_e2e_floor_arg():
    """CLI e2e: --floor supplied → cache_read_zero_above_floor is a boolean (not 'unknown')."""
    path = _write_jsonl(_make_stream_jsonl(21, with_usage=True, cache_read=0))
    try:
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--capture", str(path), "--floor", "1000"],
            capture_output=True, text=True, timeout=30,
        )
    finally:
        path.unlink(missing_ok=True)
    assert proc.returncode == 0
    report = json.loads(proc.stdout)
    # With floor and usage, cache_read_zero_above_floor is a bool, not 'unknown'
    assert isinstance(report["cache_read_zero_above_floor"], bool)


def test_cli_e2e_prefix_tokens_arg():
    """CLI e2e: --prefix-tokens annotated in report."""
    path = _write_jsonl(_make_stream_jsonl(5))
    try:
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--capture", str(path), "--prefix-tokens", "9876"],
            capture_output=True, text=True, timeout=30,
        )
    finally:
        path.unlink(missing_ok=True)
    assert proc.returncode == 0
    report = json.loads(proc.stdout)
    assert report.get("prefix_tokens") == 9876


# ---------------------------------------------------------------------------
# Internal helper unit tests
# ---------------------------------------------------------------------------

def test_count_content_blocks_zero():
    content = "\n".join([
        json.dumps({"type": "message_start"}),
        json.dumps({"type": "message_stop"}),
    ]) + "\n"
    count, status = probe._count_content_blocks(content)
    assert count == 0
    assert status == "ok"


def test_count_content_blocks_exact():
    content = _make_stream_jsonl(7)
    count, status = probe._count_content_blocks(content)
    assert count == 7
    assert status == "ok"


def test_count_content_blocks_invalid():
    content = "not json\n" + json.dumps({"type": "content_block_start"}) + "\n"
    count, status = probe._count_content_blocks(content)
    assert status == "invalid"
    assert count == 0


def test_compute_cache_read_zero_none_floor_returns_unknown():
    content = _make_stream_jsonl(5, with_usage=True)
    result, _errs = probe._compute_cache_read_zero_above_floor(content, floor=None)
    assert result == "unknown"


def test_compute_cache_read_zero_no_usage_returns_unknown():
    content = _make_stream_jsonl(5, with_usage=False)
    result, _errs = probe._compute_cache_read_zero_above_floor(content, floor=1000)
    assert result == "unknown"


def test_compute_cache_read_zero_true_when_no_hit():
    content = _make_stream_jsonl(5, with_usage=True, cache_read=0)
    result, _errs = probe._compute_cache_read_zero_above_floor(content, floor=1000)
    assert result is True


def test_compute_cache_read_zero_false_with_hit():
    content = _make_stream_jsonl(5, with_usage=True, cache_read=5000)
    result, _errs = probe._compute_cache_read_zero_above_floor(content, floor=1000)
    assert result is False


def test_empty_lines_in_jsonl_skipped():
    """Empty lines in JSONL must be skipped, not cause parse errors."""
    content = "\n\n" + json.dumps({"type": "content_block_start", "index": 0}) + "\n\n"
    count, status = probe._count_content_blocks(content)
    assert status == "ok"
    assert count == 1


def test_count_content_blocks_non_dict_json_skipped():
    """Non-dict JSON values (e.g. numbers, strings) in JSONL are skipped."""
    content = "\n".join([
        "42",
        json.dumps({"type": "content_block_start", "index": 0}),
        '"a string"',
        json.dumps({"type": "content_block_start", "index": 1}),
    ]) + "\n"
    count, status = probe._count_content_blocks(content)
    assert status == "ok"
    assert count == 2


def test_compute_cache_read_zero_message_delta_usage():
    """message_delta event usage block is consumed (inserted at front)."""
    content = "\n".join([
        json.dumps({
            "type": "message_delta",
            "usage": {
                "input_tokens": 5000,
                "cache_read_input_tokens": 0,
                "output_tokens": 100,
            },
        }),
    ]) + "\n"
    result, _errs = probe._compute_cache_read_zero_above_floor(content, floor=1000)
    assert result is True  # cache_read=0 and input > floor


def test_compute_cache_read_zero_bare_usage_event():
    """Bare 'usage' key on non-message_start/delta event is captured."""
    content = "\n".join([
        json.dumps({
            "type": "some_other",
            "usage": {
                "input_tokens": 2000,
                "cache_read_input_tokens": 500,
            },
        }),
    ]) + "\n"
    result, _errs = probe._compute_cache_read_zero_above_floor(content, floor=100)
    assert result is False  # cache_read > 0


def test_compute_cache_read_zero_cache_read_none_returns_unknown():
    """Usage block without cache_read_input_tokens → 'unknown'."""
    content = "\n".join([
        json.dumps({
            "type": "message_start",
            "message": {
                "usage": {
                    "input_tokens": 5000,
                    # no cache_read_input_tokens
                },
            },
        }),
    ]) + "\n"
    result, _errs = probe._compute_cache_read_zero_above_floor(content, floor=1000)
    assert result == "unknown"


def test_compute_cache_read_zero_cache_read_non_castable_returns_unknown():
    """Non-int-castable cache_read_input_tokens → 'unknown'."""
    content = "\n".join([
        json.dumps({
            "type": "message_start",
            "message": {
                "usage": {
                    "input_tokens": 5000,
                    "cache_read_input_tokens": "not-a-number",
                },
            },
        }),
    ]) + "\n"
    result, _errs = probe._compute_cache_read_zero_above_floor(content, floor=1000)
    assert result == "unknown"


def test_compute_cache_read_zero_input_tokens_none_returns_unknown():
    """Usage block without input_tokens → 'unknown'."""
    content = "\n".join([
        json.dumps({
            "type": "message_start",
            "message": {
                "usage": {
                    "cache_read_input_tokens": 0,
                    # no input_tokens
                },
            },
        }),
    ]) + "\n"
    result, _errs = probe._compute_cache_read_zero_above_floor(content, floor=1000)
    assert result == "unknown"


def test_compute_cache_read_zero_input_tokens_non_castable_returns_unknown():
    """Non-int-castable input_tokens → 'unknown'."""
    content = "\n".join([
        json.dumps({
            "type": "message_start",
            "message": {
                "usage": {
                    "input_tokens": "not-a-number",
                    "cache_read_input_tokens": 0,
                },
            },
        }),
    ]) + "\n"
    result, _errs = probe._compute_cache_read_zero_above_floor(content, floor=1000)
    assert result == "unknown"


def test_compute_cache_read_zero_parse_error_in_line_skipped():
    """Malformed JSON lines are skipped (not fatal) in _compute_cache_read_zero_above_floor."""
    content = "\n".join([
        "not json",
        json.dumps({
            "type": "message_start",
            "message": {
                "usage": {
                    "input_tokens": 5000,
                    "cache_read_input_tokens": 0,
                },
            },
        }),
    ]) + "\n"
    result, _errs = probe._compute_cache_read_zero_above_floor(content, floor=1000)
    # Bad line skipped; valid usage still found and evaluated
    assert result is True


def test_compute_cache_read_zero_non_dict_json_skipped():
    """Non-dict JSON values are skipped in _compute_cache_read_zero_above_floor."""
    content = "\n".join([
        "42",
        json.dumps({
            "type": "message_start",
            "message": {
                "usage": {
                    "input_tokens": 3000,
                    "cache_read_input_tokens": 100,
                },
            },
        }),
    ]) + "\n"
    result, _errs = probe._compute_cache_read_zero_above_floor(content, floor=1000)
    assert result is False  # cache_read > 0


# ---------------------------------------------------------------------------
# Direct main() call tests (covers main() body lines, not just subprocess)
# ---------------------------------------------------------------------------

def test_main_direct_call_returns_zero_for_valid_capture():
    """main() called directly returns 0 for valid capture (covers main() body lines)."""
    path = _write_jsonl(_make_stream_jsonl(10))
    try:
        rc, report = _run_main_with_args(path)
    finally:
        path.unlink(missing_ok=True)
    assert rc == 0
    assert report["schema"] == "agent-runtime-block-window"
    assert report["exceeds_20_lookback"] is False


def test_main_direct_call_returns_nonzero_for_missing_file():
    """main() called directly returns 1 for missing capture (covers error branch)."""
    path = Path("/nonexistent-direct-main-test.jsonl")
    rc, report = _run_main_with_args(path)
    assert rc == 1
    assert "_error" in report


def test_main_direct_call_with_floor_arg():
    """main() called directly with --floor arg covers that arg parse branch."""
    path = _write_jsonl(_make_stream_jsonl(5, with_usage=True, cache_read=0))
    try:
        rc, report = _run_main_with_args(path, extra_args=["--floor", "1000"])
    finally:
        path.unlink(missing_ok=True)
    assert rc == 0
    assert isinstance(report["cache_read_zero_above_floor"], bool)


def test_main_direct_call_with_prefix_tokens_arg():
    """main() called directly with --prefix-tokens arg covers that arg parse branch."""
    path = _write_jsonl(_make_stream_jsonl(5))
    try:
        rc, report = _run_main_with_args(path, extra_args=["--prefix-tokens", "1234"])
    finally:
        path.unlink(missing_ok=True)
    assert rc == 0
    assert report.get("prefix_tokens") == 1234


def test_main_direct_call_pretty_flag():
    """main() with --pretty flag outputs multi-line JSON (covers pretty branch)."""
    path = _write_jsonl(_make_stream_jsonl(5))
    buf = io.StringIO()
    orig_argv = sys.argv
    sys.argv = ["block_window_auditor.py", "--capture", str(path), "--pretty"]
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
        path.unlink(missing_ok=True)
    assert rc == 0
    lines = buf.getvalue().strip().splitlines()
    assert len(lines) > 1


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------

def test_malformed_capture_exits_nonzero():
    # SOURCE-BUG FIX: a malformed capture yields parse_status="invalid" / error_type="malformed_input"
    # with NO "_error" key. The CLI exit must be NONZERO (fail-closed). The prior guard
    # `"_error" in report or error_type=="missing_input"` let a malformed capture exit 0 — a fail-open
    # CI exit (a degraded/unparseable run read as clean). Now guarded on the full typed error set.
    path = _write_jsonl("this is not valid jsonl {{{\n")
    try:
        rc, report = _run_main_with_args(path)
    finally:
        path.unlink(missing_ok=True)
    assert rc != 0, "malformed capture must exit nonzero, not be read as a clean run"
    assert report["error_type"] == "malformed_input"


def test_risk_flag_floor_is_exclusive():
    # cache_read_zero_above_floor risk = (cache_read == 0 AND input_tokens > floor), STRICT: input
    # EXACTLY AT the floor is NOT above it -> no risk. A >= weakening would flag an at-floor session.
    at_floor = json.dumps({"type": "message_delta",
                           "usage": {"cache_read_input_tokens": 0, "input_tokens": 1000}}) + "\n"
    above = json.dumps({"type": "message_delta",
                        "usage": {"cache_read_input_tokens": 0, "input_tokens": 1001}}) + "\n"
    assert probe._compute_cache_read_zero_above_floor(at_floor, 1000)[0] is False
    assert probe._compute_cache_read_zero_above_floor(above, 1000)[0] is True


def test_usage_scan_defensive_on_malformed_events():
    # The usage-candidate scan guards each event shape with AND chains; an and->or weakening would
    # index/append a malformed usage and crash. A message_start whose message lacks "usage", and a
    # bare event whose "usage" is not a dict, must both be SKIPPED (-> "unknown"), never crash.
    no_usage_start = json.dumps({"type": "message_start", "message": {"id": "x"}}) + "\n"
    assert probe._compute_cache_read_zero_above_floor(no_usage_start, 1000)[0] == "unknown"
    nondict_usage = json.dumps({"type": "other", "usage": "not_a_dict"}) + "\n"
    assert probe._compute_cache_read_zero_above_floor(nondict_usage, 1000)[0] == "unknown"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} block_window_auditor tests passed")
