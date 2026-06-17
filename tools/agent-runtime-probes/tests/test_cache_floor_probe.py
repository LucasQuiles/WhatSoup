#!/usr/bin/env python3
"""Tests for cache_floor_probe: happy paths, UNHAPPY paths, determinism, and CLI e2e.

No-install: stdlib only; no pytest/fixtures; manual runner style matching
tests/test_pi_presence_probe.py exactly.
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

import cache_floor_probe as probe  # noqa: E402
from probelib import sha256_16  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "cache_floor_probe.py"
REGISTRY_PATH = Path(__file__).resolve().parent.parent / "cache_floor_registry.json"

# ---------------------------------------------------------------------------
# Minimal synthetic registry fixtures (do not depend on real registry values)
# ---------------------------------------------------------------------------

_REGISTRY_SEED = {
    "schema": "agent-runtime-cache-floor-registry",
    "schema_version": "0.1",
    "entries": {
        "test-model-low-floor": {
            "floor_tokens": 512,
            "status": "research_seed",
            "source_ref": "synthetic-fixture",
            "captured_utc": "2026-06-16",
            "method": "synthetic",
            "confidence": "low",
        },
        "test-model-measured": {
            "floor_tokens": 1024,
            "status": "local_measured",
            "source_ref": "synthetic-fixture",
            "captured_utc": "2026-06-16",
            "method": "local-measurement",
            "confidence": "high",
        },
        "test-model-high-floor": {
            "floor_tokens": 4096,
            "status": "research_seed",
            "source_ref": "synthetic-fixture",
            "captured_utc": "2026-06-16",
            "method": "synthetic",
            "confidence": "medium",
        },
    },
}

_MALFORMED_REGISTRY_NO_ENTRIES = {
    "schema": "agent-runtime-cache-floor-registry",
    "schema_version": "0.1",
    # missing 'entries'
}

_MALFORMED_REGISTRY_ENTRIES_NOT_DICT = {
    "schema": "agent-runtime-cache-floor-registry",
    "schema_version": "0.1",
    "entries": "not-a-dict",
}


def _write_registry(data: dict) -> Path:
    f = tempfile.NamedTemporaryFile(
        suffix=".json", mode="w", delete=False, prefix="cfr_fixture_"
    )
    json.dump(data, f)
    f.close()
    return Path(f.name)


def _run_main(model: str, prefix_tokens: int, registry: Path | None = None) -> tuple[int, dict]:
    """Call probe.main() via argv injection; return (rc, report_dict)."""
    reg = str(registry) if registry else str(REGISTRY_PATH)
    orig_argv = sys.argv
    sys.argv = [
        "cache_floor_probe.py",
        "--model", model,
        "--prefix-tokens", str(prefix_tokens),
        "--registry", reg,
    ]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
    return rc, json.loads(buf.getvalue())


# ---------------------------------------------------------------------------
# Happy-path tests: known model above floor
# ---------------------------------------------------------------------------

def test_happy_above_floor_not_sub_floor():
    """Known research_seed model above floor → sub_floor=False, but cache_eligible is
    GATED to 'unverified' (H2): the adoption-grade bool is withheld off an unverified floor."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        report = probe.build_report("test-model-low-floor", 1000, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert report["schema"] == "agent-runtime-cache-floor"
    assert report["schema_version"] == "0.1"
    assert report["redaction"] == "metadata-only"
    assert report["model"] == "test-model-low-floor"
    assert report["floor_tokens"] == 512
    assert report["floor_status"] == "research_seed"
    assert report["prefix_tokens"] == 1000
    assert report["sub_floor"] is False
    # H2: unverified floor → cache_eligible is the taint string, NOT a confident bool
    assert report["cache_eligible"] == "unverified"
    assert report["cache_eligible_verified"] is False


def test_happy_below_floor_is_sub_floor():
    """Known research_seed model below floor → sub_floor=True; cache_eligible GATED to
    'unverified' (H2) even though it is below floor — the floor itself is unverified."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        report = probe.build_report("test-model-high-floor", 100, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert report["sub_floor"] is True
    # H2: unverified floor → never a confident bool, even sub-floor
    assert report["cache_eligible"] == "unverified"
    assert report["cache_eligible_verified"] is False
    assert report["floor_tokens"] == 4096


def test_happy_exactly_at_floor_not_sub_floor():
    """prefix_tokens == floor_tokens → sub_floor=False (not strictly below).
    research_seed floor → cache_eligible still gated to 'unverified' (H2)."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        report = probe.build_report("test-model-low-floor", 512, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert report["sub_floor"] is False
    assert report["cache_eligible"] == "unverified"
    assert report["cache_eligible_verified"] is False


def test_happy_research_seed_risk_unverified():
    """Research-seed entry → risk contains 'research_seed_floor_unverified'."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        report = probe.build_report("test-model-low-floor", 1000, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert report["risk"] == "research_seed_floor_unverified"
    assert report["floor_status"] == "research_seed"


def test_happy_local_measured_risk_none_when_eligible():
    """local_measured entry above floor → risk='none', AND cache_eligible is a real
    verified bool True (H2: verified floors keep the adoption-grade signal)."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        report = probe.build_report("test-model-measured", 2000, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert report["floor_status"] == "local_measured"
    assert report["risk"] == "none"
    assert report["cache_eligible"] is True
    assert report["cache_eligible_verified"] is True


def test_happy_local_measured_risk_sub_floor_when_below():
    """local_measured entry below floor → risk='sub_floor'."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        report = probe.build_report("test-model-measured", 100, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert report["floor_status"] == "local_measured"
    assert report["risk"] == "sub_floor"
    assert report["sub_floor"] is True
    # H2: verified floor below threshold → real bool False (adoption-grade signal kept)
    assert report["cache_eligible"] is False
    assert report["cache_eligible_verified"] is True


def test_happy_zero_prefix_is_sub_floor():
    """prefix_tokens=0 with any positive floor → sub_floor=True (zero is valid input)."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        report = probe.build_report("test-model-low-floor", 0, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert report["sub_floor"] is True
    # H2: research_seed floor → gated, not a confident False
    assert report["cache_eligible"] == "unverified"
    assert report["cache_eligible_verified"] is False


# ---------------------------------------------------------------------------
# UNHAPPY paths — UNHAPPY_TEST_TERMS present; each has assert + error signal
# ---------------------------------------------------------------------------

def test_unknown_model_returns_unknown_floor_tokens_not_4096():
    """UNHAPPY: unknown model → floor_tokens=='unknown' and NEVER 4096 or any int default."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        report = probe.build_report("nonexistent-model-xyz", 5000, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert report["floor_tokens"] == "unknown", (
        f"UNHAPPY: unknown model must not produce a numeric floor; got {report['floor_tokens']!r}"
    )
    assert report["floor_tokens"] != 4096, "UNHAPPY: must never default to 4096"
    assert report["floor_status"] == "unknown"
    assert report["risk"] == "unknown_model_conservative"
    assert report["sub_floor"] == "unknown"
    assert report["cache_eligible"] == "unknown"
    # H2: unknown model is also unverified — never a confident bool
    assert report["cache_eligible_verified"] is False


def test_missing_registry_returns_missing_input_error():
    """UNHAPPY: missing registry file → typed error with error_type=missing_input."""
    report = probe.build_report(
        "any-model",
        1000,
        Path("/nonexistent-registry-xyz.json"),
    )
    assert "_error" in report, "UNHAPPY: missing registry must return _error"
    assert report.get("error_type") == "missing_input"


def test_malformed_registry_no_entries_returns_typed_error():
    """UNHAPPY: registry missing 'entries' key → malformed_input error, parse_status=invalid."""
    reg = _write_registry(_MALFORMED_REGISTRY_NO_ENTRIES)
    try:
        report = probe.build_report("test-model-low-floor", 100, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert "_error" in report, "UNHAPPY: malformed registry must return _error"
    assert report.get("error_type") == "malformed_input"
    assert report.get("parse_status") == "invalid"


def test_malformed_registry_entries_not_dict_returns_typed_error():
    """UNHAPPY: entries not a dict → malformed_input typed error."""
    reg = _write_registry(_MALFORMED_REGISTRY_ENTRIES_NOT_DICT)
    try:
        report = probe.build_report("test-model-low-floor", 100, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert "_error" in report, "UNHAPPY: invalid entries shape must return _error"
    assert report.get("error_type") == "malformed_input"


def test_malformed_registry_invalid_json_returns_typed_error():
    """UNHAPPY: invalid JSON in registry file → parse_status=invalid typed error."""
    with tempfile.NamedTemporaryFile(
        suffix=".json", mode="w", delete=False, prefix="cfr_bad_"
    ) as f:
        f.write("{not valid json at all")
        bad_path = Path(f.name)
    try:
        report = probe.build_report("any-model", 100, bad_path)
    finally:
        bad_path.unlink(missing_ok=True)

    assert "_error" in report or report.get("error_type") == "malformed_input", (
        f"UNHAPPY: invalid JSON must return error; got {report!r}"
    )


def test_negative_prefix_tokens_returns_typed_error():
    """UNHAPPY: negative prefix_tokens → malformed_input typed error."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        report = probe.build_report("test-model-low-floor", -1, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert "_error" in report, "UNHAPPY: negative prefix_tokens must return _error"
    assert report.get("error_type") == "malformed_input"


def test_floor_status_research_seed_not_local_measured():
    """UNHAPPY: research_seed floor is explicitly not adoption-sufficient (floor_status check)."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        report = probe.build_report("test-model-low-floor", 1000, reg)
    finally:
        reg.unlink(missing_ok=True)

    # adoption gate: research_seed is NOT local_measured
    assert report["floor_status"] != "local_measured", (
        "UNHAPPY: research_seed entries must never report as local_measured"
    )
    assert "unverified" in report["risk"], (
        "UNHAPPY: risk label must flag unverified research seed"
    )


# ---------------------------------------------------------------------------
# Determinism test
# ---------------------------------------------------------------------------

def test_determinism_identical_inputs_produce_identical_reports():
    """Two calls with identical inputs produce bit-identical reports (no timestamps/random)."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        r1 = probe.build_report("test-model-low-floor", 600, reg)
        r2 = probe.build_report("test-model-low-floor", 600, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert r1 == r2, f"Reports not identical:\n{r1}\n---\n{r2}"


def test_determinism_unknown_model_reports_identical():
    """Unknown model reports are deterministic across two calls."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        r1 = probe.build_report("ghost-model", 999, reg)
        r2 = probe.build_report("ghost-model", 999, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert r1 == r2


# ---------------------------------------------------------------------------
# CLI e2e tests
# ---------------------------------------------------------------------------

def test_cli_e2e_happy_known_model_above_floor():
    """CLI e2e: known model above floor → exit 0, valid JSON with correct fields."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        proc = subprocess.run(
            [
                sys.executable, str(PROBE_PATH),
                "--model", "test-model-low-floor",
                "--prefix-tokens", "1000",
                "--registry", str(reg),
            ],
            capture_output=True, text=True, timeout=30,
        )
    finally:
        reg.unlink(missing_ok=True)

    assert proc.returncode == 0, f"stderr={proc.stderr!r}"
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-cache-floor"
    assert report["schema_version"] == "0.1"
    assert report["sub_floor"] is False
    # H2: research_seed floor → cache_eligible gated to 'unverified'
    assert report["cache_eligible"] == "unverified"
    assert report["cache_eligible_verified"] is False


def test_cli_e2e_unknown_model_exits_zero_floor_unknown():
    """CLI e2e: unknown model exits 0 (not an error), floor_tokens=='unknown'."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        proc = subprocess.run(
            [
                sys.executable, str(PROBE_PATH),
                "--model", "totally-unknown-model",
                "--prefix-tokens", "5000",
                "--registry", str(reg),
            ],
            capture_output=True, text=True, timeout=30,
        )
    finally:
        reg.unlink(missing_ok=True)

    assert proc.returncode == 0, f"stderr={proc.stderr!r}"
    report = json.loads(proc.stdout)
    assert report["floor_tokens"] == "unknown"
    assert report["risk"] == "unknown_model_conservative"


def test_cli_e2e_missing_registry_exits_nonzero():
    """CLI e2e: missing registry → exit nonzero, _error in output."""
    proc = subprocess.run(
        [
            sys.executable, str(PROBE_PATH),
            "--model", "any-model",
            "--prefix-tokens", "100",
            "--registry", "/nonexistent-registry-e2e.json",
        ],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode != 0
    report = json.loads(proc.stdout)
    assert "_error" in report


def test_cli_e2e_pretty_flag_produces_indented_json():
    """CLI e2e: --pretty flag yields multi-line JSON."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        proc = subprocess.run(
            [
                sys.executable, str(PROBE_PATH),
                "--model", "test-model-measured",
                "--prefix-tokens", "2000",
                "--registry", str(reg),
                "--pretty",
            ],
            capture_output=True, text=True, timeout=30,
        )
    finally:
        reg.unlink(missing_ok=True)

    assert proc.returncode == 0
    lines = proc.stdout.strip().splitlines()
    assert len(lines) > 1, "Expected multi-line pretty JSON"
    json.loads(proc.stdout)  # must still be valid JSON


def test_cli_e2e_real_registry_known_model():
    """CLI e2e: real registry with a known entry (sonnet-4-6) produces valid report."""
    if not REGISTRY_PATH.exists():
        # Skip gracefully if real registry absent (CI without full repo)
        return
    proc = subprocess.run(
        [
            sys.executable, str(PROBE_PATH),
            "--model", "sonnet-4-6",
            "--prefix-tokens", "2000",
            "--registry", str(REGISTRY_PATH),
        ],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, f"stderr={proc.stderr!r}"
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-cache-floor"
    assert isinstance(report["floor_tokens"], int)
    assert report["model"] == "sonnet-4-6"


# ---------------------------------------------------------------------------
# Additional branch coverage tests
# ---------------------------------------------------------------------------

def test_malformed_registry_root_is_list_returns_typed_error():
    """UNHAPPY: registry JSON is a list (not object) → malformed_input typed error."""
    with tempfile.NamedTemporaryFile(
        suffix=".json", mode="w", delete=False, prefix="cfr_list_"
    ) as f:
        json.dump([1, 2, 3], f)
        list_path = Path(f.name)
    try:
        report = probe.build_report("any-model", 100, list_path)
    finally:
        list_path.unlink(missing_ok=True)

    assert "_error" in report, "UNHAPPY: list-root registry must return _error"
    assert report.get("error_type") == "malformed_input"
    assert report.get("parse_status") == "invalid"


def test_malformed_entry_not_dict_returns_typed_error():
    """UNHAPPY: registry entry value is not a dict → malformed_input typed error."""
    bad_entry_registry = {
        "schema": "agent-runtime-cache-floor-registry",
        "schema_version": "0.1",
        "entries": {
            "bad-entry-model": "not-a-dict",
        },
    }
    reg = _write_registry(bad_entry_registry)
    try:
        report = probe.build_report("bad-entry-model", 100, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert "_error" in report, "UNHAPPY: non-dict entry must return _error"
    assert report.get("error_type") == "malformed_input"
    assert report.get("parse_status") == "invalid"


def test_malformed_entry_missing_floor_tokens_returns_typed_error():
    """UNHAPPY: registry entry has no floor_tokens → malformed_input typed error."""
    bad_floor_registry = {
        "schema": "agent-runtime-cache-floor-registry",
        "schema_version": "0.1",
        "entries": {
            "no-floor-model": {
                "status": "research_seed",
                "source_ref": "synthetic",
                # floor_tokens deliberately absent
            },
        },
    }
    reg = _write_registry(bad_floor_registry)
    try:
        report = probe.build_report("no-floor-model", 100, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert "_error" in report, "UNHAPPY: missing floor_tokens in entry must return _error"
    assert report.get("error_type") == "malformed_input"


def test_malformed_entry_floor_tokens_not_int_returns_typed_error():
    """UNHAPPY: floor_tokens is a string → malformed_input typed error."""
    bad_floor_registry = {
        "schema": "agent-runtime-cache-floor-registry",
        "schema_version": "0.1",
        "entries": {
            "str-floor-model": {
                "floor_tokens": "not-an-int",
                "status": "research_seed",
                "source_ref": "synthetic",
            },
        },
    }
    reg = _write_registry(bad_floor_registry)
    try:
        report = probe.build_report("str-floor-model", 100, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert "_error" in report, "UNHAPPY: string floor_tokens must return _error"
    assert report.get("error_type") == "malformed_input"


def test_unknown_floor_status_produces_unknown_floor_status_risk():
    """Entry with unrecognized status → risk='unknown_floor_status'."""
    unusual_status_registry = {
        "schema": "agent-runtime-cache-floor-registry",
        "schema_version": "0.1",
        "entries": {
            "weird-status-model": {
                "floor_tokens": 1024,
                "status": "some_future_status",
                "source_ref": "synthetic",
            },
        },
    }
    reg = _write_registry(unusual_status_registry)
    try:
        report = probe.build_report("weird-status-model", 2000, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert report["risk"] == "unknown_floor_status"
    assert report["floor_status"] == "some_future_status"
    # H2: any non-local_measured status is unverified → cache_eligible gated
    assert report["cache_eligible"] == "unverified"
    assert report["cache_eligible_verified"] is False


def test_load_registry_returns_none_for_empty_file():
    """UNHAPPY: empty file → load_json returns _error dict → missing_input error."""
    with tempfile.NamedTemporaryFile(
        suffix=".json", mode="w", delete=False, prefix="cfr_empty_"
    ) as f:
        # Write empty file so load_json raises JSONDecodeError → _error dict
        f.write("")
        empty_path = Path(f.name)
    try:
        entries, err = probe._load_registry(empty_path)
    finally:
        empty_path.unlink(missing_ok=True)

    # load_json on empty file: JSONDecodeError → returns {"_error": ...}
    # Either way, err should be non-None
    assert entries is None
    assert err is not None


def test_load_registry_when_load_json_returns_none():
    """UNHAPPY: load_json returning None (mocked) → missing_input typed error."""
    import cache_floor_probe as _probe
    import probelib as _probelib

    orig_load_json = _probe.load_json

    def _mock_load_json_none(path):
        return None

    _probe.load_json = _mock_load_json_none
    # need a file that exists so the exists() guard passes
    with tempfile.NamedTemporaryFile(
        suffix=".json", mode="w", delete=False, prefix="cfr_mock_"
    ) as f:
        f.write("{}")
        mock_path = Path(f.name)
    try:
        entries, err = _probe._load_registry(mock_path)
    finally:
        _probe.load_json = orig_load_json
        mock_path.unlink(missing_ok=True)

    assert entries is None, "UNHAPPY: load_json returning None must yield no entries"
    assert err is not None
    assert err["error_type"] == "missing_input"


def test_main_via_argv_injection_happy():
    """main() invoked via argv injection with known model → returns 0."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        rc, report = _run_main("test-model-measured", 2000, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert rc == 0
    assert report["schema"] == "agent-runtime-cache-floor"
    assert report["cache_eligible"] is True


def test_main_via_argv_injection_unknown_model():
    """main() with unknown model → returns 0 (unknown is not an error exit)."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        rc, report = _run_main("totally-unknown", 500, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert rc == 0
    assert report["floor_tokens"] == "unknown"


def test_main_via_argv_injection_missing_registry_exits_nonzero():
    """main() with missing registry → returns 1 (error exit)."""
    rc, report = _run_main("any-model", 100, Path("/nonexistent-registry-main-test.json"))
    assert rc == 1
    assert "_error" in report


def test_main_via_argv_injection_pretty_flag():
    """main() with --pretty produces multi-line JSON."""
    reg = _write_registry(_REGISTRY_SEED)
    orig_argv = sys.argv
    sys.argv = [
        "cache_floor_probe.py",
        "--model", "test-model-low-floor",
        "--prefix-tokens", "1000",
        "--registry", str(reg),
        "--pretty",
    ]
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv = orig_argv
        reg.unlink(missing_ok=True)

    assert rc == 0
    lines = buf.getvalue().strip().splitlines()
    assert len(lines) > 1, "Expected multi-line pretty-printed JSON"
    json.loads(buf.getvalue())  # valid JSON


# ---------------------------------------------------------------------------
# Internal unit tests
# ---------------------------------------------------------------------------

def test_validate_prefix_tokens_none_is_error():
    err = probe._validate_prefix_tokens(None)
    assert err is not None
    assert err["error_type"] == "missing_input"


def test_validate_prefix_tokens_negative_is_error():
    err = probe._validate_prefix_tokens(-5)
    assert err is not None
    assert err["error_type"] == "malformed_input"


def test_validate_prefix_tokens_zero_is_valid():
    assert probe._validate_prefix_tokens(0) is None


def test_validate_prefix_tokens_positive_is_valid():
    assert probe._validate_prefix_tokens(100) is None


def test_validate_prefix_tokens_bool_is_error():
    """bool is a subclass of int but must be rejected (True/False are not token counts)."""
    err = probe._validate_prefix_tokens(True)  # type: ignore[arg-type]
    assert err is not None
    assert err["error_type"] == "malformed_input"


def test_load_registry_returns_entries_for_valid_file():
    reg = _write_registry(_REGISTRY_SEED)
    try:
        entries, err = probe._load_registry(reg)
    finally:
        reg.unlink(missing_ok=True)

    assert err is None
    assert entries is not None
    assert "test-model-low-floor" in entries


def test_load_registry_missing_file_returns_error():
    entries, err = probe._load_registry(Path("/nonexistent-xyz.json"))
    assert entries is None
    assert err is not None
    assert err["error_type"] == "missing_input"


def test_report_schema_fields_present_for_known_model():
    """All required output schema fields are present for a known model."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        report = probe.build_report("test-model-measured", 500, reg)
    finally:
        reg.unlink(missing_ok=True)

    required = {
        "schema", "schema_version", "redaction", "model",
        "floor_tokens", "floor_status", "prefix_tokens",
        "sub_floor", "cache_eligible", "cache_eligible_verified", "risk",
    }
    missing = required - set(report.keys())
    assert not missing, f"Missing required fields: {missing}"


def test_report_schema_fields_present_for_unknown_model():
    """All required output schema fields are present for an unknown model."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        report = probe.build_report("unknown-xyz", 5000, reg)
    finally:
        reg.unlink(missing_ok=True)

    required = {
        "schema", "schema_version", "redaction", "model",
        "floor_tokens", "floor_status", "prefix_tokens",
        "sub_floor", "cache_eligible", "cache_eligible_verified", "risk",
    }
    missing = required - set(report.keys())
    assert not missing, f"Missing required fields for unknown model: {missing}"


# ---------------------------------------------------------------------------
# H2 + H4 regression tests (audit findings)
# ---------------------------------------------------------------------------

def test_h2_research_seed_cache_eligible_is_not_bare_bool():
    """H2 REGRESSION: a research_seed (provider-unverified) floor must NOT emit an
    adoption-grade True/False on `cache_eligible`. The machine-readable verdict must
    carry the taint — either cache_eligible is the string 'unverified' OR the separate
    cache_eligible_verified flag is False. A downstream consumer keying on
    cache_eligible must not get a confident bool off an unverified floor."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        # above floor
        above = probe.build_report("test-model-low-floor", 100000, reg)
        # below floor
        below = probe.build_report("test-model-high-floor", 1, reg)
    finally:
        reg.unlink(missing_ok=True)

    for report in (above, below):
        assert report["floor_status"] == "research_seed"
        # The taint MUST live on the machine-readable verdict, not only in `risk`.
        tainted = (
            report.get("cache_eligible") == "unverified"
            or report.get("cache_eligible_verified") is False
        )
        assert tainted, (
            "H2: research_seed floor leaked an adoption-grade verdict; "
            f"cache_eligible={report.get('cache_eligible')!r} "
            f"cache_eligible_verified={report.get('cache_eligible_verified')!r}"
        )
        # Strongest form: cache_eligible itself is NOT a bare bool for unverified floors.
        assert not isinstance(report.get("cache_eligible"), bool), (
            "H2: cache_eligible must not be a bare bool for an unverified (research_seed) floor"
        )


def test_h2_local_measured_keeps_real_bool_signal():
    """H2: a local_measured (verified) floor KEEPS the adoption-grade bool — the gate
    only withholds the signal for UNVERIFIED floors, it does not break verified ones."""
    reg = _write_registry(_REGISTRY_SEED)
    try:
        report = probe.build_report("test-model-measured", 99999, reg)
    finally:
        reg.unlink(missing_ok=True)

    assert report["floor_status"] == "local_measured"
    assert report["cache_eligible"] is True
    assert isinstance(report["cache_eligible"], bool)
    assert report["cache_eligible_verified"] is True


def test_h4_missing_registry_error_has_no_raw_path_only_hash():
    """H4 REGRESSION: a missing-input error must NOT interpolate the raw absolute path
    into a metadata-only report. The raw /Users/... path string must be ABSENT; a
    sha256_16 hash of the path must be present instead."""
    secret_path = Path("/Users/testuser/secret-private-dir/cache_floor_registry.json")
    report = probe.build_report("any-model", 100, secret_path)

    assert "_error" in report
    blob = json.dumps(report)
    # The raw absolute path must NOT appear anywhere in the emitted report.
    assert str(secret_path) not in blob, (
        f"H4: raw absolute path leaked into error report: {blob!r}"
    )
    assert "/Users/" not in blob, f"H4: a /Users/ path leaked: {blob!r}"
    # A hash of the path must be present (the safe substitute).
    expected_hash = sha256_16(str(secret_path))
    assert expected_hash in blob, (
        f"H4: expected sha256_16 path hash {expected_hash!r} absent from {blob!r}"
    )


def test_h4_all_error_markers_avoid_raw_paths():
    """H4: sweep every _error-producing path-bearing branch and assert no raw /Users/
    absolute path leaks. Covers missing-file and malformed-JSON registry branches."""
    secret_dir = "/Users/testuser/private-leak-probe"

    # Branch 1: missing file
    missing = probe.build_report("m", 1, Path(f"{secret_dir}/missing.json"))
    assert "/Users/" not in json.dumps(missing), missing

    # Branch 2: malformed JSON file (load_json returns {"_error": ...}); the probe must
    # not echo a raw path here either.
    with tempfile.NamedTemporaryFile(
        suffix=".json", mode="w", delete=False, prefix="cfr_h4_"
    ) as f:
        f.write("{broken json")
        bad_path = Path(f.name)
    try:
        malformed = probe.build_report("m", 1, bad_path)
    finally:
        bad_path.unlink(missing_ok=True)
    # The temp path lives under the system tmp dir, not /Users, but assert the raw
    # absolute path string of the bad file is absent regardless.
    assert str(bad_path) not in json.dumps(malformed), malformed


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} cache_floor_probe tests passed")
