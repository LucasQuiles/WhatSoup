"""Bounded metadata-only observations shared by BOT ERRORS offline probes."""
from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any


STATUSES = frozenset({
    "observed",
    "missing",
    "invalid_json",
    "invalid_shape",
    "partial",
    "unsupported_version",
    "read_error",
    "not_applicable",
})
INPUT_MODES = frozenset({"repo_static", "event_json", "plain_text", "none"})
FORMAT_STATUSES = frozenset({
    "valid_json",
    "invalid_json",
    "plain_text",
    "json_non_object",
    "absent",
    "read_error",
    "not_applicable",
})
SCHEMA_STATUSES = frozenset({
    "valid",
    "invalid_shape",
    "missing_required",
    "unsupported_version",
    "partial",
    "not_applicable",
})
INVALID_STATUSES = frozenset({"invalid_json", "invalid_shape", "read_error"})
_SAFE_TOKEN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_SAFE_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$")


def _safe_token(value: str, field: str) -> str:
    if not _SAFE_TOKEN.fullmatch(value):
        raise ValueError(f"{field} must be a bounded token")
    return value


def _safe_count(value: int | None, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field} must be a non-negative integer or None")
    return value


def _safe_refs(refs: Iterable[str]) -> list[str]:
    result: list[str] = []
    for ref in refs:
        if not isinstance(ref, str) or not _SAFE_REF.fullmatch(ref):
            raise ValueError("artifact reference must be a bounded repo-relative path")
        if ref.startswith("/") or "\\" in ref or any(part == ".." for part in ref.split("/")):
            raise ValueError("artifact reference must be a bounded repo-relative path")
        result.append(ref)
    return result


def observation(
    subject: str,
    status: str,
    *,
    input_mode: str = "repo_static",
    format_status: str = "not_applicable",
    schema_status: str = "not_applicable",
    expected: int | None = None,
    observed_valid: int | None = None,
    invalid: int = 0,
    skipped: int = 0,
    unknown: int = 0,
    error_class: str | None = None,
    artifact_refs: Iterable[str] = (),
) -> dict[str, Any]:
    """Return one validated, non-sensitive observation mapping."""
    _safe_token(subject, "subject")
    if status not in STATUSES:
        raise ValueError("status must be a closed observation status")
    if input_mode not in INPUT_MODES:
        raise ValueError("input mode must be a closed observation input mode")
    if format_status not in FORMAT_STATUSES:
        raise ValueError("format status must be a closed observation format status")
    if schema_status not in SCHEMA_STATUSES:
        raise ValueError("schema status must be a closed observation schema status")
    if error_class is not None:
        _safe_token(error_class, "error class")
    return {
        "subject": subject,
        "status": status,
        "inputMode": input_mode,
        "formatStatus": format_status,
        "schemaStatus": schema_status,
        "counts": {
            "expected": _safe_count(expected, "expected"),
            "observed_valid": _safe_count(observed_valid, "observed valid"),
            "invalid": _safe_count(invalid, "invalid"),
            "skipped": _safe_count(skipped, "skipped"),
            "unknown": _safe_count(unknown, "unknown"),
        },
        "error_class": error_class,
        "artifact_refs": _safe_refs(artifact_refs),
    }


def report_verdict(required: Mapping[str, Mapping[str, object]]) -> str:
    """Classify required observations without treating absent evidence as valid."""
    if not required:
        return "inconclusive"
    statuses = [item.get("status") for item in required.values()]
    if any(status not in STATUSES for status in statuses):
        return "invalid"
    if any(status in INVALID_STATUSES for status in statuses):
        return "invalid"
    if any(status != "observed" for status in statuses):
        return "inconclusive"
    return "valid"


def strict_exit_code(report: Mapping[str, object]) -> int:
    """Return the stable strict-mode status code for an emitted report."""
    return 0 if report.get("reportVerdict") == "valid" else 2
