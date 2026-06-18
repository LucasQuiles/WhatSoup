#!/usr/bin/env python3
"""tests/test_cache_floor_registry.py — Bead 0.2a schema-validation tests.

Validates cache_floor_registry.json structure and research-seed discipline.
No pytest; run with: python3 tests/test_cache_floor_registry.py
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

REGISTRY_PATH = Path(__file__).resolve().parent.parent / "cache_floor_registry.json"

REQUIRED_TOP_KEYS = {"schema", "schema_version", "entries"}
REQUIRED_ENTRY_FIELDS = {"floor_tokens", "status", "source_ref", "captured_utc", "method", "confidence"}
VALID_STATUSES = {"research_seed", "local_measured"}
VALID_CONFIDENCES = {"low", "medium", "high"}
ADOPTION_GRADE_STATUS = "local_measured"

# ---------------------------------------------------------------------------
# Schema validator — returns a list of human-readable violation strings.
# Empty list == valid.
# ---------------------------------------------------------------------------

def validate_registry(obj: object) -> list[str]:
    """Return a list of violation strings. Empty list means the registry is valid."""
    violations: list[str] = []

    if not isinstance(obj, dict):
        return ["root: expected dict, got " + type(obj).__name__]

    for key in REQUIRED_TOP_KEYS:
        if key not in obj:
            violations.append(f"root: missing required key '{key}'")

    schema = obj.get("schema")
    if schema != "agent-runtime-cache-floor-registry":
        violations.append(f"root.schema: expected 'agent-runtime-cache-floor-registry', got {schema!r}")

    schema_version = obj.get("schema_version")
    if not isinstance(schema_version, str) or not schema_version.strip():
        violations.append(f"root.schema_version: must be a non-empty string, got {schema_version!r}")

    entries = obj.get("entries")
    if not isinstance(entries, dict):
        violations.append(f"root.entries: expected dict, got {type(entries).__name__}")
        return violations

    if not entries:
        violations.append("root.entries: must have at least one entry")

    for model_id, entry in entries.items():
        prefix = f"entries.{model_id}"
        if not isinstance(entry, dict):
            violations.append(f"{prefix}: expected dict, got {type(entry).__name__}")
            continue

        for field in REQUIRED_ENTRY_FIELDS:
            if field not in entry:
                violations.append(f"{prefix}: missing required field '{field}'")

        floor_tokens = entry.get("floor_tokens")
        if not isinstance(floor_tokens, int) or isinstance(floor_tokens, bool):
            violations.append(f"{prefix}.floor_tokens: must be int, got {type(floor_tokens).__name__}")
        elif floor_tokens <= 0:
            violations.append(f"{prefix}.floor_tokens: must be positive, got {floor_tokens}")

        status = entry.get("status")
        if status not in VALID_STATUSES:
            violations.append(f"{prefix}.status: must be one of {sorted(VALID_STATUSES)}, got {status!r}")

        confidence = entry.get("confidence")
        if confidence not in VALID_CONFIDENCES:
            violations.append(f"{prefix}.confidence: must be one of {sorted(VALID_CONFIDENCES)}, got {confidence!r}")

        source_ref = entry.get("source_ref")
        if not isinstance(source_ref, str) or not source_ref.strip():
            violations.append(f"{prefix}.source_ref: must be a non-empty string")

        method = entry.get("method")
        if not isinstance(method, str) or not method.strip():
            violations.append(f"{prefix}.method: must be a non-empty string")

        captured_utc = entry.get("captured_utc")
        if not isinstance(captured_utc, str) or not captured_utc.strip():
            violations.append(f"{prefix}.captured_utc: must be a non-empty string")

    return violations


def is_adoption_grade(entry: dict) -> bool:
    """Return True only when the entry has been locally measured and verified."""
    return entry.get("status") == ADOPTION_GRADE_STATUS


# ---------------------------------------------------------------------------
# Tests — each uses assert for correctness, prints PASS <name> on success.
# ---------------------------------------------------------------------------

def test_real_registry_loads_and_validates_clean() -> None:
    """HAPPY: the real registry must parse and validate with ZERO violations."""
    obj = json.loads(REGISTRY_PATH.read_text())
    violations = validate_registry(obj)
    assert violations == [], f"expected 0 violations, got {len(violations)}: {violations}"
    print("PASS test_real_registry_loads_and_validates_clean")


def test_missing_required_field_is_flagged() -> None:
    """UNHAPPY: missing source_ref/method/status must be flagged as violations.

    Proves a research-seed cannot masquerade as a verified entry through
    omission of provenance fields.
    """
    incomplete_entry = {
        "floor_tokens": 1024,
        # status intentionally omitted
        # source_ref intentionally omitted
        "captured_utc": "2026-06-16",
        # method intentionally omitted
        "confidence": "medium",
    }
    obj = {
        "schema": "agent-runtime-cache-floor-registry",
        "schema_version": "0.1",
        "entries": {"test-model": incomplete_entry},
    }
    violations = validate_registry(obj)
    assert len(violations) > 0, "expected violations for missing status/source_ref/method, got none"
    # Confirm each omitted field is mentioned
    violation_text = " ".join(violations)
    assert "status" in violation_text, f"'status' missing field not flagged; violations: {violations}"
    assert "source_ref" in violation_text, f"'source_ref' missing field not flagged; violations: {violations}"
    assert "method" in violation_text, f"'method' missing field not flagged; violations: {violations}"
    print("PASS test_missing_required_field_is_flagged")


def test_research_seed_is_not_adoption_grade() -> None:
    """UNHAPPY: status='research_seed' must return False from is_adoption_grade.

    Also verifies that status='local_measured' returns True (the positive control).
    """
    seed_entry = {
        "floor_tokens": 1024,
        "status": "research_seed",
        "source_ref": "headroom-research/SYNTHESIS-v1.md §3",
        "captured_utc": "2026-06-16",
        "method": "web-research, provider-unverified",
        "confidence": "medium",
    }
    assert not is_adoption_grade(seed_entry), (
        "is_adoption_grade returned True for status='research_seed'; "
        "research seeds must not be flagged as adoption-grade"
    )

    measured_entry = dict(seed_entry, status="local_measured")
    assert is_adoption_grade(measured_entry), (
        "is_adoption_grade returned False for status='local_measured'"
    )
    print("PASS test_research_seed_is_not_adoption_grade")


def test_validate_registry_is_deterministic() -> None:
    """Determinism: validate_registry called twice on the same object yields identical lists."""
    obj = json.loads(REGISTRY_PATH.read_text())
    first = validate_registry(obj)
    second = validate_registry(obj)
    assert first == second, (
        f"non-deterministic validator output:\n  first:  {first!r}\n  second: {second!r}"
    )
    print("PASS test_validate_registry_is_deterministic")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    tests = [
        test_real_registry_loads_and_validates_clean,
        test_missing_required_field_is_flagged,
        test_research_seed_is_not_adoption_grade,
        test_validate_registry_is_deterministic,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except Exception as exc:
            print(f"FAIL {t.__name__}: {exc}", file=sys.stderr)
            failed += 1

    total = len(tests)
    passed = total - failed
    print(f"\n{passed}/{total} passed")
    sys.exit(0 if failed == 0 else 1)
