#!/usr/bin/env python3
"""Metadata-only BOT ERRORS daily-health artifact adapter.

This probe parses a caller-supplied BOT ERRORS daily-health event JSON or plain
evidence text into counts/classes. It does not read live queues or default host
paths, SSH, call providers, run health checks, or send BOT ERRORS messages.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from bot_errors_probe_observation import observation, report_verdict, strict_exit_code

SCHEMA = "bot-errors-daily-health-artifact-report"
SCHEMA_VERSION = "0.2"
SUPPORTED_EVENT_SCHEMA_VERSION = 1
REQUIRED_EVENT_FIELDS = ("schemaVersion", "eventType", "severity", "source", "evidence")

INSTANCE_FAIL_PREFIXES = {
    "health",
    "socket",
    "service",
    "service_enabled",
    "auth_bond",
    "provider_probe",
    "primary_phone_state",
    "profile_coverage",
    "profile_coverage_service",
    "tree_provenance",
}

INFRA_FAIL_PREFIXES = {"disk", "dns", "rustdesk", "clock"}
SAFE_EVENT_TYPES = {"alert", "clear", "observation"}
SAFE_SEVERITIES = {"critical", "error", "warning", "info"}
SAFE_SOURCES = {
    "daily-health",
    "daily-health-fail",
    "heartbeat-watchdog",
    "storm-collapse",
    "source-update",
    "tree-provenance",
}
SAFE_CRITICAL_ASSET_KEYS = {
    "code",
    "assetKind",
    "domain",
    "recoverability",
    "confidence",
}
SAFE_EVIDENCE_CATEGORIES = {
    *INSTANCE_FAIL_PREFIXES,
    *INFRA_FAIL_PREFIXES,
    "config",
    "machine",
    "plugin_coverage",
    "plugin_dir",
    "plugins",
    "profile",
    "runtime_manifest",
}
SAFE_PROVIDER_FAILURE_CLASSES = {
    "provider_auth_required",
    "provider_compatibility_degraded",
    "provider_compatibility_unsupported",
    "provider_credential_missing",
    "provider_probe_failed",
    "provider_rate_limit",
    "provider_timeout",
    "provider_usage_limit",
}
SAFE_PROVIDER_STATUS_VALUES = {
    "advisory_contradicted",
    "advisory_inconclusive",
    "missing",
    "not_applicable",
    "ok",
    "present",
    "skipped",
    "timeout",
    "user_interaction_required",
}
PROVIDER_FIELD_KEYS = {
    "provider_auth_context",
    "provider_probe_signal",
    "status",
    "trust_level",
}

PROVIDER_FAILURE_RE = re.compile(r"\bprovider_probe\s+([^:\s]+):.*?\bfailure_class=([A-Za-z0-9_.:-]+)")
TOKEN_FIELD_RE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)=([^ \t\n]+)")


def safe_enum(value: Any, allowed: set[str]) -> str:
    if not isinstance(value, str) or not value.strip():
        return "absent"
    stripped = value.strip()
    return stripped if stripped in allowed else "other"


def read_artifact(path: Path | None, use_stdin: bool) -> tuple[str, str]:
    if use_stdin:
        return sys.stdin.read(), "stdin"
    if path is None:
        return "", "none"
    try:
        return path.expanduser().read_text(encoding="utf-8", errors="replace"), "file"
    except OSError:
        return "", "read_error"


def looks_like_json(raw: str) -> bool:
    stripped = raw.strip()
    if not stripped:
        return False
    if stripped.startswith("\ufeff"):
        return True
    if stripped[0] in "{[\"":
        return True
    if stripped in {"true", "false", "null"}:
        return True
    return re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?", stripped) is not None


def parse_artifact_text(raw: str, input_mode: str = "auto") -> tuple[dict[str, Any] | None, str, str]:
    if not raw.strip():
        return None, "", "none"
    if input_mode == "plain-text" or (input_mode == "auto" and not looks_like_json(raw)):
        return None, raw, "plain_text"
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError:
        return None, "", "invalid_json"
    if isinstance(loaded, dict):
        evidence = loaded.get("evidence")
        return loaded, evidence if isinstance(evidence, str) else "", "event_json"
    return None, "", "json_non_object"


def normalize_category(line: str) -> str:
    stripped = line.strip()
    if stripped.startswith("FAIL "):
        stripped = stripped[len("FAIL "):].strip()
    elif stripped.startswith("WARN "):
        stripped = stripped[len("WARN "):].strip()
    if not stripped:
        return "empty"
    category = stripped.split()[0].rstrip(":")
    if "/" in category or "\\" in category:
        return "path_like"
    return category if category in SAFE_EVIDENCE_CATEGORIES else "other"


def classify_line(line: str) -> str:
    stripped = line.strip()
    if not stripped:
        return "blank"
    if stripped.startswith("FAIL ") or " FAIL " in stripped:
        return "fail"
    if stripped.startswith("WARN ") or " WARN " in stripped:
        return "warn"
    if stripped.startswith("config ") and "invalid JSON" in stripped:
        return "fail"
    return "info"


def has_instance_reference_from_fail_line(line: str) -> bool:
    stripped = line.strip()
    if stripped.startswith("FAIL "):
        stripped = stripped[len("FAIL "):].strip()
    tokens = stripped.split()
    if len(tokens) < 2:
        return False
    if tokens[0] not in INSTANCE_FAIL_PREFIXES:
        return False
    candidate = tokens[1].rstrip(":")
    if not candidate or "/" in candidate or "\\" in candidate:
        return False
    return True


def classify_runtime_manifest_line(line: str) -> str | None:
    if "runtime_manifest" not in line:
        return None
    lower = line.lower()
    if line.startswith("FAIL runtime_manifest"):
        if "unsupported schemaversion" in lower:
            return "fail_unsupported_schema"
        if "files must be a list" in lower:
            return "fail_files_not_list"
        if "duplicate path" in lower:
            return "fail_duplicate_path"
        if "missing_marker" in lower:
            return "fail_missing_marker"
        if "missing path" in lower:
            return "fail_missing_path"
        if "invalid expected sha256" in lower:
            return "fail_invalid_expected_hash"
        if "cannot hash" in lower or "cannot read" in lower:
            return "fail_unreadable"
        return "fail_other"
    if "sha256=" in lower and "expected=" in lower:
        return "hash_check_line"
    if line.startswith("runtime_manifest:"):
        return "summary_line"
    return "other"


def classify_plugin_line(line: str) -> str | None:
    if "plugin" not in line:
        return None
    if line.startswith("FAIL plugin_coverage"):
        if "enabledPlugins must be an object or null" in line:
            return "coverage_fail_invalid_enabled_plugins"
        return "coverage_fail_missing"
    if line.startswith("plugin_coverage"):
        if "inherits global" in line:
            return "coverage_inherits_global"
        if " ok " in f" {line} ":
            return "coverage_ok"
        return "coverage_other"
    if line.startswith("FAIL plugin_dir"):
        return "plugin_dir_fail"
    if line.startswith("OK plugin_dir"):
        return "plugin_dir_ok"
    if line.startswith("FAIL plugins settings"):
        return "settings_fail"
    if line.startswith("plugins settings: missing"):
        return "settings_missing"
    if line.startswith("plugins settings:"):
        return "settings_present"
    if line.startswith("plugins: no instance configs"):
        return "no_instance_configs"
    if line.startswith("plugins ") and "skipped" in line:
        return "instance_skipped"
    if line.startswith("FAIL plugins"):
        return "instance_fail"
    return "other"


def provider_field_summary(lines: list[str]) -> tuple[dict[str, int], dict[str, int]]:
    field_counts: Counter[str] = Counter()
    status_counts: Counter[str] = Counter()
    for line in lines:
        for key, value in TOKEN_FIELD_RE.findall(line):
            if key not in PROVIDER_FIELD_KEYS:
                continue
            field_counts[key] += 1
            if key == "status":
                status_counts[safe_enum(value, SAFE_PROVIDER_STATUS_VALUES)] += 1
    return dict(sorted(field_counts.items())), dict(sorted(status_counts.items()))


def evidence_summary(evidence: str) -> dict[str, Any]:
    lines = evidence.splitlines()
    classes = [classify_line(line) for line in lines]
    category_counts = Counter(normalize_category(line) for line in lines if line.strip())
    failure_categories = Counter(normalize_category(line) for line, cls in zip(lines, classes) if cls == "fail")
    warning_categories = Counter(normalize_category(line) for line, cls in zip(lines, classes) if cls == "warn")
    instance_reference_count = sum(1 for line in lines if has_instance_reference_from_fail_line(line))
    provider_failure_classes = Counter(
        match.group(2) if match.group(2) in SAFE_PROVIDER_FAILURE_CLASSES else "other"
        for match in PROVIDER_FAILURE_RE.finditer(evidence)
    )
    runtime_manifest_classes = Counter(
        cls for line in lines if (cls := classify_runtime_manifest_line(line)) is not None
    )
    plugin_classes = Counter(cls for line in lines if (cls := classify_plugin_line(line)) is not None)
    infra_fail_count = sum(
        count for category, count in failure_categories.items() if category in INFRA_FAIL_PREFIXES
    )
    fail_count = classes.count("fail")
    warn_count = classes.count("warn")
    inferred_severity = "critical" if fail_count and infra_fail_count != fail_count else "warning" if fail_count or warn_count else "info"
    provider_field_counts, provider_status_counts = provider_field_summary(lines)
    return {
        "line_count": len(lines),
        "nonblank_line_count": sum(1 for line in lines if line.strip()),
        "evidence_bytes": len(evidence.encode("utf-8", errors="replace")),
        "line_class_counts": dict(sorted(Counter(classes).items())),
        "category_counts": dict(sorted(category_counts.items())),
        "failure_category_counts": dict(sorted(failure_categories.items())),
        "warning_category_counts": dict(sorted(warning_categories.items())),
        "infra_fail_count": infra_fail_count,
        "inferred_severity_from_lines": inferred_severity,
        "instance_reference_count": instance_reference_count,
        "provider_failure_class_counts": dict(sorted(provider_failure_classes.items())),
        "provider_field_counts": provider_field_counts,
        "provider_status_class_counts": provider_status_counts,
        "runtime_manifest_class_counts": dict(sorted(runtime_manifest_classes.items())),
        "plugin_class_counts": dict(sorted(plugin_classes.items())),
    }


def event_observation(event: dict[str, Any] | None, artifact_type: str) -> dict[str, Any]:
    if artifact_type == "none":
        return observation("daily_health_artifact", "missing", input_mode="none", format_status="absent", unknown=1)
    if artifact_type == "plain_text":
        return observation("daily_health_artifact", "not_applicable", input_mode="plain_text", format_status="plain_text", unknown=1)
    if artifact_type == "read_error":
        return observation("daily_health_artifact", "read_error", input_mode="none", format_status="read_error", error_class="artifact_read", unknown=1)
    if artifact_type == "invalid_json":
        return observation("daily_health_artifact", "invalid_json", input_mode="event_json", format_status="invalid_json", error_class="json_decode", unknown=1)
    if artifact_type == "json_non_object":
        return observation("daily_health_artifact", "invalid_shape", input_mode="event_json", format_status="valid_json", schema_status="invalid_shape", error_class="root_not_object", unknown=1)
    if not isinstance(event, dict):
        return observation("daily_health_artifact", "invalid_shape", input_mode="event_json", format_status="valid_json", schema_status="invalid_shape", error_class="root_not_object", unknown=1)

    valid_fields = 0
    invalid_fields = 0
    missing_required = False
    unsupported_version = False
    for field in REQUIRED_EVENT_FIELDS:
        value = event.get(field)
        if field not in event:
            invalid_fields += 1
            missing_required = True
            continue
        if field == "schemaVersion":
            if isinstance(value, bool) or not isinstance(value, int):
                invalid_fields += 1
            elif value != SUPPORTED_EVENT_SCHEMA_VERSION:
                invalid_fields += 1
                unsupported_version = True
            else:
                valid_fields += 1
            continue
        if field == "eventType":
            valid = isinstance(value, str) and value in SAFE_EVENT_TYPES
        elif field == "severity":
            valid = isinstance(value, str) and value in SAFE_SEVERITIES
        elif field == "source":
            valid = isinstance(value, str) and value in SAFE_SOURCES
        else:
            valid = isinstance(value, str)
        if valid:
            valid_fields += 1
        else:
            invalid_fields += 1
    if missing_required:
        return observation("daily_health_artifact", "invalid_shape", input_mode="event_json", format_status="valid_json", schema_status="missing_required", expected=len(REQUIRED_EVENT_FIELDS), observed_valid=valid_fields, invalid=invalid_fields, error_class="missing_required")
    if unsupported_version:
        return observation("daily_health_artifact", "unsupported_version", input_mode="event_json", format_status="valid_json", schema_status="unsupported_version", expected=len(REQUIRED_EVENT_FIELDS), observed_valid=valid_fields, invalid=invalid_fields, error_class="unsupported_schema_version")
    if invalid_fields:
        return observation("daily_health_artifact", "invalid_shape", input_mode="event_json", format_status="valid_json", schema_status="invalid_shape", expected=len(REQUIRED_EVENT_FIELDS), observed_valid=valid_fields, invalid=invalid_fields, error_class="invalid_event_field")
    return observation("daily_health_artifact", "observed", input_mode="event_json", format_status="valid_json", schema_status="valid", expected=len(REQUIRED_EVENT_FIELDS), observed_valid=valid_fields)


def event_summary(event: dict[str, Any] | None, observation_status: str) -> dict[str, Any]:
    if not event or observation_status != "observed":
        return {"status": observation_status}
    critical_asset = event.get("criticalAsset") if isinstance(event.get("criticalAsset"), dict) else {}
    diagnostics = event.get("diagnostics") if isinstance(event.get("diagnostics"), dict) else {}
    delivery = event.get("delivery") if isinstance(event.get("delivery"), dict) else {}
    return {
        "status": "observed",
        "event_type": safe_enum(event.get("eventType"), SAFE_EVENT_TYPES),
        "severity": safe_enum(event.get("severity"), SAFE_SEVERITIES),
        "source": safe_enum(event.get("source"), SAFE_SOURCES),
        "alert_source_class": alert_source_class(event.get("alertSource")),
        "summary_bytes": len(str(event.get("summary") or "").encode("utf-8", errors="replace")),
        "has_critical_asset": bool(critical_asset),
        "critical_asset_known_field_count": sum(1 for key in critical_asset if key in SAFE_CRITICAL_ASSET_KEYS),
        "diagnostics_key_count": len(diagnostics),
        "delivery_status": safe_enum(delivery.get("status"), {"queued", "sent", "failed", "suppressed"}),
    }


def alert_source_class(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return "absent"
    stripped = value.strip()
    for prefix in ("provider_probe:", "runtime_manifest:", "primary_phone:", "daily-health:", "daily-health-fail:"):
        if stripped.startswith(prefix):
            return prefix.rstrip(":")
    if stripped == "source_update":
        return "source_update"
    return "other"


def artifact_source_label(value: str) -> str:
    return value if value in {"file", "stdin", "none", "read_error"} else "caller_supplied"


def build_report(raw: str, source_label: str, input_mode: str = "auto") -> dict[str, Any]:
    event, evidence, artifact_type = (None, "", "read_error") if source_label == "read_error" else parse_artifact_text(raw, input_mode)
    artifact_observation = event_observation(event, artifact_type)
    observations = {"daily_health_artifact": artifact_observation}
    can_summarize_evidence = artifact_type == "plain_text" or artifact_observation["status"] == "observed"
    evidence_report = evidence_summary(evidence) if evidence and can_summarize_evidence else {}
    event_report = event_summary(event, artifact_observation["status"])
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "serializationStatus": "emitted",
        "requiredObservations": sorted(observations),
        "observations": observations,
        "reportVerdict": report_verdict(observations),
        "redaction": (
            "metadata-only artifact adapter; suppresses raw evidence, hashes, identifiers, summary text, "
            "diagnostic names and values, paths, process details, provider output, and credential material"
        ),
        "artifact": {
            "source": artifact_source_label(source_label),
            "type": artifact_type,
            "inputMode": artifact_observation["inputMode"],
            "formatStatus": artifact_observation["formatStatus"],
            "schemaStatus": artifact_observation["schemaStatus"],
            "raw_bytes": len(raw.encode("utf-8", errors="replace")),
            "evidence_available": bool(evidence_report),
        },
        "event": event_report,
        "evidence": evidence_report,
        "adapter_contract": {
            "safe_fields": [
                "line_class_counts",
                "failure_category_counts",
                "warning_category_counts",
                "provider_failure_class_counts",
                "provider field-presence and bounded status counts",
                "runtime_manifest_class_counts",
                "plugin_class_counts",
                "instance_reference_count",
                "event source/severity/type classes",
                "criticalAsset field count",
            ],
            "forbidden_fields": [
                "raw evidence lines",
                "raw summary",
                "credential values",
                "provider stdout/stderr",
                "process argv values",
                "diagnostic values",
                "outbox payload text",
                "socket paths",
                "JIDs",
                "token files",
                "instance config values",
                "machine or instance names",
                "raw or linkable hashes",
            ],
        },
        "limitations": [
            "Parses only a caller-supplied artifact or stdin.",
            "Does not prove artifact freshness, deployment state, service health, queue health, or provider status.",
            "Does not run health-check, SSH, service managers, providers, MCP, or BOT ERRORS sends.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", type=Path, help="path to a BOT ERRORS event JSON or plain evidence text")
    parser.add_argument("--stdin", action="store_true", help="read artifact from stdin")
    parser.add_argument("--pretty", action="store_true", help="pretty-print JSON")
    parser.add_argument("--input-mode", choices=("auto", "event-json", "plain-text"), default="auto", help="interpret input as auto-detected JSON event or explicit plain text")
    parser.add_argument("--strict", action="store_true", help="exit 2 unless required evidence is valid")
    args = parser.parse_args()
    if args.artifact and args.stdin:
        parser.error("choose --artifact or --stdin, not both")
    raw, source_label = read_artifact(args.artifact, args.stdin)
    report = build_report(raw, source_label, args.input_mode)
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return strict_exit_code(report) if args.strict else 0


if __name__ == "__main__":
    raise SystemExit(main())
