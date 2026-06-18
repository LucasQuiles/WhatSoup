#!/usr/bin/env python3
"""Tests for usage_truth_probe: happy path, unhappy paths, determinism, and CLI e2e.

No-install: stdlib only; no pytest/fixtures; manual setattr+try/finally monkeypatch.
Follows the test_pi_presence_probe.py standalone-runner style exactly.
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

import usage_truth_probe as probe  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "usage_truth_probe.py"

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

FULL_RESPONSE_JSON = json.dumps({
    "id": "msg_abc",
    "type": "message",
    "model": "claude-opus-4-5",
    "usage": {
        "input_tokens": 1000,
        "cache_read_input_tokens": 800,
        "cache_creation_input_tokens": 0,
        "output_tokens": 250,
    },
})

STREAM_JSONL_WITH_USAGE = "\n".join([
    json.dumps({"type": "message_start", "message": {
        "usage": {
            "input_tokens": 500,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 500,
            "output_tokens": 0,
        }
    }}),
    json.dumps({"type": "content_block_start"}),
    json.dumps({"type": "message_delta", "usage": {
        "input_tokens": 500,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 500,
        "output_tokens": 120,
    }}),
]) + "\n"

# No usage block at all
RESPONSE_JSON_NO_USAGE = json.dumps({
    "id": "msg_xyz",
    "type": "message",
    "model": "claude-opus-4-5",
    "content": [],
})

# Malformed JSON
MALFORMED_JSON = '{"usage": {broken'

# Malformed JSONL (bad line)
MALFORMED_JSONL = 'not json at all\n{"type": "message_start"}\n'


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _run_main_with_capture(path: Path) -> tuple[int, dict]:
    """Run probe.main() with --capture <path> and parse stdout as JSON."""
    orig_argv = sys.argv
    sys.argv = ["usage_truth_probe.py", "--capture", str(path)]
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

def test_happy_response_json_full_usage():
    """Response JSON with full usage block → exact numeric fields and warm cache_state."""
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write(FULL_RESPONSE_JSON)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)

    assert report["schema"] == "agent-runtime-usage-truth"
    assert report["schema_version"] == "0.1"
    assert report["redaction"] == "metadata-only; token/cache counts and class labels only"
    assert isinstance(report["capture_sha256_16"], str) and len(report["capture_sha256_16"]) == 16
    assert report["input_tokens"] == 1000
    assert report["cache_read_input_tokens"] == 800
    assert report["cache_creation_input_tokens"] == 0
    assert report["output_tokens"] == 250
    # M3: hit fraction over the disjoint total (read+creation+input), bounded [0,1].
    # 800 / (800 + 0 + 1000) = 0.444444
    assert report["cache_read_hit_fraction"] == round(800 / 1800, 6)
    assert "cache_read_to_input_ratio" not in report  # renamed
    assert report["cache_state"] == "warm"
    assert report["usage_source_class"] == "response_usage"


def test_happy_stream_jsonl_full_usage():
    """Stream JSONL with message_delta → message_delta usage wins (cold cache)."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(STREAM_JSONL_WITH_USAGE)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)

    assert report["schema"] == "agent-runtime-usage-truth"
    assert report["input_tokens"] == 500
    assert report["cache_read_input_tokens"] == 0
    assert report["cache_creation_input_tokens"] == 500
    assert report["output_tokens"] == 120
    assert report["cache_state"] == "cold"
    assert report["usage_source_class"] == "stream_usage"


def test_stream_without_message_delta_is_partial_output_unknown():
    """H3: a truncated stream (message_start only, no message_delta/message_stop) must be
    reported as stream_partial with output_tokens 'unknown' — never as a complete
    stream_usage carrying the priming placeholder."""
    truncated = "\n".join([
        json.dumps({"type": "message_start", "message": {"usage": {
            "input_tokens": 500,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 500,
            "output_tokens": 0,  # priming placeholder — NOT the final count
        }}}),
        json.dumps({"type": "content_block_start"}),
        json.dumps({"type": "content_block_delta"}),
        # stream truncated here: no message_delta, no message_stop
    ]) + "\n"
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(truncated)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)

    assert report["usage_source_class"] == "stream_partial"
    # the priming output_tokens=0 must NOT be presented as final
    assert report["output_tokens"] == "unknown"
    # input/cache fields from message_start are stable across the stream — kept as-is
    assert report["input_tokens"] == 500
    assert report["cache_creation_input_tokens"] == 500
    assert report["cache_read_input_tokens"] == 0
    assert report["cache_state"] == "cold"


def test_stream_with_message_stop_is_complete():
    """A stream terminated by message_stop (no message_delta) is COMPLETE, not partial."""
    data = "\n".join([
        json.dumps({"type": "message_start", "message": {"usage": {
            "input_tokens": 300,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "output_tokens": 0,
        }}}),
        json.dumps({"type": "message_delta", "usage": {
            "input_tokens": 300,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "output_tokens": 42,
        }}),
        json.dumps({"type": "message_stop"}),
    ]) + "\n"
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(data)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report["usage_source_class"] == "stream_usage"
    assert report["output_tokens"] == 42
    # M4: present zero read & zero creation → "none", not "unknown"
    assert report["cache_state"] == "none"


def test_stream_message_stop_only_carries_usage_is_complete():
    """message_stop carrying usage (no message_delta) → complete, final-seen, usage used."""
    data = "\n".join([
        json.dumps({"type": "message_start", "message": {"usage": {
            "input_tokens": 200,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "output_tokens": 0,
        }}}),
        json.dumps({"type": "message_stop", "usage": {
            "input_tokens": 200,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "output_tokens": 17,
        }}),
    ]) + "\n"
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(data)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report["usage_source_class"] == "stream_usage"
    assert report["output_tokens"] == 17


def test_happy_warm_cache_hit_fraction():
    """cache_read_hit_fraction is computed over the disjoint total, bounded [0,1]."""
    data = json.dumps({"usage": {
        "input_tokens": 2000,
        "cache_read_input_tokens": 1500,
        "cache_creation_input_tokens": 0,
        "output_tokens": 100,
    }})
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write(data)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report["cache_state"] == "warm"
    # 1500 / (1500 + 0 + 2000) = 0.428571 — bounded in [0,1] under the honest denominator
    frac = report["cache_read_hit_fraction"]
    assert frac == round(1500 / 3500, 6)
    assert 0.0 <= frac <= 1.0
    assert report["input_tokens"] == 2000


def test_happy_partial_cache_state():
    """Both read and creation tokens > 0 → partial cache state."""
    data = json.dumps({"usage": {
        "input_tokens": 1000,
        "cache_read_input_tokens": 400,
        "cache_creation_input_tokens": 100,
        "output_tokens": 50,
    }})
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write(data)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report["cache_state"] == "partial"


# ---------------------------------------------------------------------------
# Unhappy-path tests (names/bodies must contain UNHAPPY_TEST_TERMS)
# ---------------------------------------------------------------------------

def test_missing_file_returns_typed_error():
    """Missing capture file → typed error dict with error_type=missing_input, exit nonzero."""
    path = Path("/nonexistent-usage-capture-xyz.json")
    report = probe.build_report(path)
    assert "_error" in report
    assert report.get("error_type") == "missing_input"


def test_missing_file_error_hashes_path_no_raw_leak():
    """H4: the metadata-only _error must NOT embed the raw absolute path — it is hashed."""
    raw_path = "/Users/secret-person/captures/private-capture-name.json"
    report = probe.build_report(Path(raw_path))
    assert "_error" in report
    err = report["_error"]
    # no raw path fragment of any kind leaks
    assert "/Users/" not in err
    assert "secret-person" not in err
    assert "private-capture-name" not in err
    # the hashed handle is present and is a 16-hex digest
    assert "path_sha256_16=" in err
    digest = err.split("path_sha256_16=", 1)[1]
    assert digest == probe.sha256_16(raw_path)
    assert len(digest) == 16 and all(c in "0123456789abcdef" for c in digest)


def test_absent_usage_block_returns_unknown_not_zero():
    """Absent usage block → usage_source_class=absent and ALL metrics == 'unknown', NOT 0."""
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write(RESPONSE_JSON_NO_USAGE)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)

    assert report.get("usage_source_class") == "absent"
    # critical: must never collapse to 0
    assert report["input_tokens"] == "unknown", f"expected 'unknown', got {report['input_tokens']!r}"
    assert report["cache_read_input_tokens"] == "unknown"
    assert report["cache_creation_input_tokens"] == "unknown"
    assert report["output_tokens"] == "unknown"
    assert report["cache_read_hit_fraction"] == "unknown"
    assert "cache_read_to_input_ratio" not in report  # renamed
    # absent usage block → cache_state "unknown" (fields genuinely ABSENT)
    assert report["cache_state"] == "unknown"


def test_malformed_json_response_returns_parse_status_invalid():
    """Malformed JSON → parse_status='invalid' with parser_class, never empty or silent."""
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write(MALFORMED_JSON)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)

    assert report.get("parse_status") == "invalid"
    assert "parser_class" in report
    assert report.get("error_type") == "malformed_input"


def test_malformed_jsonl_stream_returns_parse_status_invalid():
    """Malformed JSONL line → parse_status='invalid'."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(MALFORMED_JSONL)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)

    assert report.get("parse_status") == "invalid"
    assert "parser_class" in report
    assert report.get("error_type") == "malformed_input"


def test_absent_stream_jsonl_no_usage_events():
    """Stream JSONL with no usage events → absent usage_source_class and all unknown."""
    data = "\n".join([
        json.dumps({"type": "content_block_start"}),
        json.dumps({"type": "ping"}),
    ]) + "\n"
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(data)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)

    assert report.get("usage_source_class") == "absent"
    assert report["input_tokens"] == "unknown"
    assert report["cache_state"] == "unknown"


def test_error_exit_code_for_missing_file():
    """CLI exits nonzero when capture is missing."""
    rc, report = _run_main_with_capture(Path("/nonexistent-capture-file.json"))
    assert rc != 0
    assert "_error" in report


def test_error_exit_code_for_malformed_capture():
    """CLI exits nonzero on MALFORMED (not just missing) input. The exit guard is
    `"_error" in report or error_type == "missing_input"`; a malformed-JSON report carries
    `_error` with error_type="malformed_input", so the load-bearing disjunct HERE is the
    `"_error" in report` term — the missing-file test cannot exercise it because a missing
    file satisfies BOTH terms. A guard that required error_type=="missing_input" too would
    exit 0 on malformed input (a fail-open CI exit code), masking a degraded run."""
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write(MALFORMED_JSON)
        path = Path(f.name)
    try:
        rc, report = _run_main_with_capture(path)
    finally:
        path.unlink(missing_ok=True)
    assert rc != 0, "CLI must exit nonzero on malformed input, not just missing input"
    assert report.get("error_type") == "malformed_input"
    assert "_error" in report


def test_message_delta_usage_wins_over_later_message_stop_usage():
    """Provenance precedence: message_delta carries the authoritative final cumulative usage;
    a later message_stop usage is a FALLBACK only (used iff no delta usage was seen — the guard
    is `isinstance(su, dict) and delta_usage is None`). A stream with BOTH must report the
    message_delta figures, never let message_stop clobber them. (Mutating the guard's `and` to
    `or` would overwrite the authoritative delta usage with the trailing message_stop usage.)"""
    data = "\n".join([
        json.dumps({"type": "message_delta", "usage": {"input_tokens": 1000,
                    "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
                    "output_tokens": 50}}),
        json.dumps({"type": "message_stop", "usage": {"input_tokens": 9999,
                    "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
                    "output_tokens": 9999}}),
    ]) + "\n"
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(data)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report["input_tokens"] == 1000, "message_stop usage clobbered authoritative message_delta usage"
    assert report["output_tokens"] == 50


def test_message_start_without_usage_does_not_crash():
    """Defensive parse: a message_start whose `message` is a dict but carries NO usage field
    must be skipped, not indexed. The guard `isinstance(msg, dict) and isinstance(msg.get(
    "usage"), dict)` short-circuits BEFORE `msg["usage"]`; weakening the `and` to `or` would
    index a missing key (KeyError) on otherwise-valid provider output. The stream still has a
    real message_delta usage, so the report must build cleanly and report those figures."""
    data = "\n".join([
        json.dumps({"type": "message_start", "message": {"id": "msg_x"}}),  # no usage key
        json.dumps({"type": "message_delta", "usage": {"input_tokens": 1234,
                    "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
                    "output_tokens": 7}}),
    ]) + "\n"
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(data)
        path = Path(f.name)
    try:
        report = probe.build_report(path)  # must NOT raise
    finally:
        path.unlink(missing_ok=True)
    assert report["input_tokens"] == 1234


def test_zero_total_tokens_hit_fraction_unknown():
    """All buckets 0 → hit fraction is 'unknown' (avoid division by zero)."""
    data = json.dumps({"usage": {
        "input_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "output_tokens": 10,
    }})
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write(data)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)

    assert report["cache_read_hit_fraction"] == "unknown"
    # M4: present read==0 AND creation==0 is a distinct "none" state, NOT "unknown"
    assert report["cache_state"] == "none"


# ---------------------------------------------------------------------------
# Determinism test
# ---------------------------------------------------------------------------

def test_determinism_identical_input_produces_identical_report():
    """Two calls with identical content produce identical reports (no timestamp, random)."""
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write(FULL_RESPONSE_JSON)
        path = Path(f.name)
    try:
        report1 = probe.build_report(path)
        report2 = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)

    # Both reports must be identical — no ts or random fields to drop
    assert report1 == report2, f"Reports differ:\n{report1}\n---\n{report2}"


# ---------------------------------------------------------------------------
# CLI e2e test
# ---------------------------------------------------------------------------

def test_cli_e2e_happy_response_json():
    """CLI e2e: subprocess run with valid response JSON → valid JSON on stdout, exit 0."""
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write(FULL_RESPONSE_JSON)
        path = Path(f.name)
    try:
        proc = subprocess.run(
            [sys.executable, str(PROBE_PATH), "--capture", str(path)],
            capture_output=True, text=True, timeout=30,
        )
    finally:
        path.unlink(missing_ok=True)

    assert proc.returncode == 0, f"stderr={proc.stderr!r}"
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-usage-truth"
    assert report["schema_version"] == "0.1"
    assert "capture_sha256_16" in report
    assert report["input_tokens"] == 1000
    assert report["usage_source_class"] == "response_usage"


def test_cli_e2e_missing_capture_exits_nonzero():
    """CLI e2e: missing --capture path → exit nonzero and typed error in stdout."""
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--capture", "/nonexistent-e2e-fixture.json"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0
    report = json.loads(proc.stdout)
    assert "_error" in report


def test_cli_e2e_pretty_flag_produces_indented_json():
    """CLI e2e: --pretty flag produces indented JSON (multi-line)."""
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write(FULL_RESPONSE_JSON)
        path = Path(f.name)
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


# ---------------------------------------------------------------------------
# Internal unit tests for helpers
# ---------------------------------------------------------------------------

def test_classify_cache_state_warm():
    assert probe._classify_cache_state(800, 0) == "warm"


def test_classify_cache_state_cold():
    assert probe._classify_cache_state(0, 500) == "cold"


def test_classify_cache_state_partial():
    assert probe._classify_cache_state(200, 300) == "partial"


def test_classify_cache_state_unknown_when_absent():
    assert probe._classify_cache_state("unknown", 0) == "unknown"
    assert probe._classify_cache_state(0, "unknown") == "unknown"


def test_classify_cache_state_none_when_both_present_zero():
    """M4: present read==0 & creation==0 → 'none' (NOT 'unknown')."""
    assert probe._classify_cache_state(0, 0) == "none"


def test_cache_hit_fraction_unknown_when_total_zero():
    assert probe._cache_hit_fraction(0, 0, 0) == "unknown"


def test_cache_hit_fraction_unknown_when_any_field_absent():
    assert probe._cache_hit_fraction("unknown", 0, 1000) == "unknown"
    assert probe._cache_hit_fraction(500, "unknown", 1000) == "unknown"
    assert probe._cache_hit_fraction(500, 0, "unknown") == "unknown"


def test_cache_hit_fraction_bounded_zero_one():
    """M3: even when input_tokens (uncached remainder) is 0, the fraction stays in [0,1].

    Old cache_read/input_tokens would have been unbounded (1500/0 → div-by-zero or inf);
    the honest denominator read+creation+input keeps it bounded.
    """
    # read=1500, creation=500, input=0 → 1500/2000 = 0.75 (was unbounded before)
    frac = probe._cache_hit_fraction(1500, 500, 0)
    assert frac == 0.75
    assert 0.0 <= frac <= 1.0


def test_extract_metrics_absent_fields_become_unknown():
    """Fields not present in usage dict → 'unknown', not 0."""
    metrics = probe._extract_metrics({})
    assert metrics["input_tokens"] == "unknown"
    assert metrics["cache_read_input_tokens"] == "unknown"
    assert metrics["cache_creation_input_tokens"] == "unknown"
    assert metrics["output_tokens"] == "unknown"


def test_detect_format_jsonl_suffix():
    assert probe._detect_format(Path("something.jsonl")) == "stream_jsonl"


def test_detect_format_json_suffix():
    assert probe._detect_format(Path("something.json")) == "response_json"


def test_detect_format_unknown_suffix_defaults_response_json():
    assert probe._detect_format(Path("something.txt")) == "response_json"


def test_classify_cache_state_invalid_type_returns_unknown():
    """TypeError/ValueError in int() coercion → 'unknown', not exception."""
    # object that isn't castable to int
    assert probe._classify_cache_state("not-a-number", 0) == "unknown"
    assert probe._classify_cache_state(0, "not-a-number") == "unknown"


def test_extract_metrics_non_int_value_becomes_unknown():
    """Non-int-castable value in usage dict field → 'unknown', not exception."""
    metrics = probe._extract_metrics({"input_tokens": "not-a-number", "output_tokens": None})
    assert metrics["input_tokens"] == "unknown"
    assert metrics["output_tokens"] == "unknown"


def test_cache_hit_fraction_invalid_type_returns_unknown():
    """Non-int-castable value → 'unknown', not exception."""
    assert probe._cache_hit_fraction("not-a-number", 0, 1000) == "unknown"
    assert probe._cache_hit_fraction(500, "not-a-number", 1000) == "unknown"
    assert probe._cache_hit_fraction(500, 0, "not-a-number") == "unknown"


def test_parse_response_json_non_dict_input_returns_none():
    """_parse_response_json called with non-dict → None."""
    assert probe._parse_response_json([]) is None  # type: ignore[arg-type]
    assert probe._parse_response_json("string") is None  # type: ignore[arg-type]


def test_response_json_array_at_toplevel_parse_status_invalid():
    """JSON that is valid but not a dict (e.g. array) → parse_status='invalid'."""
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write("[1, 2, 3]")
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report.get("parse_status") == "invalid"
    assert report.get("error_type") == "malformed_input"


def test_oserror_on_read_returns_missing_input_error():
    """OSError when reading file → typed missing_input error."""
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write(FULL_RESPONSE_JSON)
        path = Path(f.name)

    orig_exists = Path.exists
    orig_read_text = Path.read_text

    def fake_exists(self):
        return True

    def fake_read_text(self, **kwargs):
        raise OSError("permission denied")

    Path.exists = fake_exists
    Path.read_text = fake_read_text
    try:
        report = probe.build_report(path)
    finally:
        Path.exists = orig_exists
        Path.read_text = orig_read_text
        path.unlink(missing_ok=True)

    assert report.get("error_type") == "missing_input"
    assert "_error" in report


def test_jsonl_empty_line_skipped():
    """Empty lines in JSONL are silently skipped (not a parse error)."""
    data = "\n".join([
        "",
        json.dumps({"type": "message_start", "message": {
            "usage": {
                "input_tokens": 100,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 100,
                "output_tokens": 0,
            }
        }}),
        "",
    ]) + "\n"
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(data)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    # empty lines are skipped; usage should be found
    assert report["input_tokens"] == 100


def test_jsonl_non_dict_event_skipped():
    """JSONL with non-dict JSON values (e.g. number) are skipped, not errored."""
    data = "\n".join([
        "42",  # non-dict JSON — should skip
        json.dumps({"type": "message_start", "message": {
            "usage": {
                "input_tokens": 77,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
                "output_tokens": 10,
            }
        }}),
    ]) + "\n"
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(data)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report["input_tokens"] == 77


def test_jsonl_bare_usage_event_parsed():
    """JSONL event with a bare 'usage' key (not message_start/message_delta/message_stop)
    is captured for its stable fields, but — having no recognized terminal marker — is
    honestly reported as stream_partial with output_tokens 'unknown' (H3)."""
    data = "\n".join([
        json.dumps({"type": "some_other_event", "usage": {
            "input_tokens": 333,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "output_tokens": 22,
        }}),
    ]) + "\n"
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(data)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report["input_tokens"] == 333
    assert report["usage_source_class"] == "stream_partial"
    assert report["output_tokens"] == "unknown"


def test_jsonl_bare_usage_then_message_delta_is_complete():
    """A bare usage event followed by a terminal message_delta → complete; delta wins."""
    data = "\n".join([
        json.dumps({"type": "some_other_event", "usage": {
            "input_tokens": 333,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "output_tokens": 0,
        }}),
        json.dumps({"type": "message_delta", "usage": {
            "input_tokens": 333,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "output_tokens": 88,
        }}),
    ]) + "\n"
    with tempfile.NamedTemporaryFile(suffix=".jsonl", mode="w", delete=False) as f:
        f.write(data)
        path = Path(f.name)
    try:
        report = probe.build_report(path)
    finally:
        path.unlink(missing_ok=True)
    assert report["usage_source_class"] == "stream_usage"
    assert report["output_tokens"] == 88


def test_main_success_returns_zero():
    """main() returns 0 for a valid capture (covers the return 0 branch)."""
    with tempfile.NamedTemporaryFile(suffix=".json", mode="w", delete=False) as f:
        f.write(FULL_RESPONSE_JSON)
        path = Path(f.name)
    try:
        rc, report = _run_main_with_capture(path)
    finally:
        path.unlink(missing_ok=True)
    assert rc == 0
    assert report["schema"] == "agent-runtime-usage-truth"


def test_classify_cache_state_negative_counts_are_unknown_not_silently_bucketed():
    # A negative token count is a malformed measurement (providers never emit one). The
    # classifier fails closed to "unknown" rather than silently bucketing it. Without the
    # `read_n < 0 or creation_n < 0` guard, the `read_n > 0 and creation_n > 0` partial check
    # (L128) misclassifies a mixed-sign input: an 'and'->'or' mutation on it reads
    # (read=1, creation=-2) as "partial". This pins the guard AND keeps the valid present-zero
    # states (0/0 -> none, 1/0 -> warm, 0/1 -> cold) intact so the guard's own `< 0` boundaries
    # cannot be loosened to `<= 0` without a red test.
    assert probe._classify_cache_state(1, -2) == "unknown"   # only creation negative
    assert probe._classify_cache_state(-1, 0) == "unknown"   # only read negative
    assert probe._classify_cache_state(-1, -1) == "unknown"  # both negative
    # valid non-negative states must be unaffected by the guard (the `< 0` must be STRICT —
    # a '<'->'<=' would wrongly flag a present-zero datum as unknown):
    assert probe._classify_cache_state(0, 0) == "none"
    assert probe._classify_cache_state(1, 0) == "warm"
    assert probe._classify_cache_state(0, 1) == "cold"
    assert probe._classify_cache_state(2, 3) == "partial"


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} usage_truth_probe tests passed")
