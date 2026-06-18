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

from probelib import sha256_16

SCHEMA = "bot-errors-daily-health-artifact-report"
SCHEMA_VERSION = "0.1"

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

PROVIDER_FAILURE_RE = re.compile(r"\bprovider_probe\s+([^:\s]+):.*?\bfailure_class=([A-Za-z0-9_.:-]+)")
TOKEN_FIELD_RE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)=([^ \t\n]+)")


def safe_enum(value: Any, allowed: set[str]) -> str:
    if not isinstance(value, str) or not value.strip():
        return "absent"
    stripped = value.strip()
    return stripped if stripped in allowed else f"other_sha256_16:{sha256_16(stripped)}"


def read_artifact(path: Path | None, use_stdin: bool) -> tuple[str, str]:
    if use_stdin:
        return sys.stdin.read(), "stdin"
    if path is None:
        return "", "none"
    return path.expanduser().read_text(encoding="utf-8", errors="replace"), "file"


def parse_artifact_text(raw: str) -> tuple[dict[str, Any] | None, str, str]:
    if not raw.strip():
        return None, "", "none"
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError:
        return None, raw, "plain_text"
    if isinstance(loaded, dict):
        evidence = loaded.get("evidence")
        return loaded, str(evidence or ""), "event_json"
    return None, raw, "json_non_object"


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
    return re.sub(r"[^A-Za-z0-9_.:-]+", "_", category)[:80] or "unknown"


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


def instance_hash_from_fail_line(line: str) -> str | None:
    stripped = line.strip()
    if stripped.startswith("FAIL "):
        stripped = stripped[len("FAIL "):].strip()
    tokens = stripped.split()
    if len(tokens) < 2:
        return None
    if tokens[0] not in INSTANCE_FAIL_PREFIXES:
        return None
    candidate = tokens[1].rstrip(":")
    if not candidate or "/" in candidate or "\\" in candidate:
        return None
    return sha256_16(candidate)


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


def field_value_counts(lines: list[str], key_prefixes: tuple[str, ...]) -> dict[str, dict[str, int]]:
    counters: dict[str, Counter[str]] = {}
    for line in lines:
        for key, value in TOKEN_FIELD_RE.findall(line):
            if not key.startswith(key_prefixes):
                continue
            safe_value = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value)[:80] or "empty"
            counters.setdefault(key, Counter())[safe_value] += 1
    return {key: dict(sorted(counter.items())) for key, counter in sorted(counters.items())}


def evidence_summary(evidence: str) -> dict[str, Any]:
    lines = evidence.splitlines()
    classes = [classify_line(line) for line in lines]
    category_counts = Counter(normalize_category(line) for line in lines if line.strip())
    failure_categories = Counter(normalize_category(line) for line, cls in zip(lines, classes) if cls == "fail")
    warning_categories = Counter(normalize_category(line) for line, cls in zip(lines, classes) if cls == "warn")
    instance_hashes = sorted({value for line in lines if (value := instance_hash_from_fail_line(line))})
    provider_failure_classes = Counter(match.group(2) for match in PROVIDER_FAILURE_RE.finditer(evidence))
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
    return {
        "line_count": len(lines),
        "nonblank_line_count": sum(1 for line in lines if line.strip()),
        "evidence_bytes": len(evidence.encode("utf-8", errors="replace")),
        "evidence_sha256_16": sha256_16(evidence),
        "line_class_counts": dict(sorted(Counter(classes).items())),
        "category_counts": dict(sorted(category_counts.items())),
        "failure_category_counts": dict(sorted(failure_categories.items())),
        "warning_category_counts": dict(sorted(warning_categories.items())),
        "infra_fail_count": infra_fail_count,
        "inferred_severity_from_lines": inferred_severity,
        "instance_hashes_sha256_16": instance_hashes,
        "instance_hash_count": len(instance_hashes),
        "provider_failure_class_counts": dict(sorted(provider_failure_classes.items())),
        "provider_field_value_counts": field_value_counts(lines, ("provider_probe_signal", "provider_auth_context", "trust_level")),
        "provider_status_counts": field_value_counts(lines, ("status",)).get("status", {}),
        "runtime_manifest_class_counts": dict(sorted(runtime_manifest_classes.items())),
        "plugin_class_counts": dict(sorted(plugin_classes.items())),
    }


def event_summary(event: dict[str, Any] | None) -> dict[str, Any]:
    if not event:
        return {"status": "absent"}
    critical_asset = event.get("criticalAsset") if isinstance(event.get("criticalAsset"), dict) else {}
    safe_asset = {
        key: str(value)
        for key, value in sorted(critical_asset.items())
        if key in SAFE_CRITICAL_ASSET_KEYS and isinstance(value, (str, int, float, bool))
    }
    diagnostics = event.get("diagnostics") if isinstance(event.get("diagnostics"), dict) else {}
    delivery = event.get("delivery") if isinstance(event.get("delivery"), dict) else {}
    return {
        "status": "parsed",
        "schema_version_present": "schemaVersion" in event,
        "event_type": safe_enum(event.get("eventType"), SAFE_EVENT_TYPES),
        "severity": safe_enum(event.get("severity"), SAFE_SEVERITIES),
        "source": safe_enum(event.get("source"), SAFE_SOURCES),
        "alert_source_class": alert_source_class(event.get("alertSource")),
        "instance_sha256_16": sha256_16(str(event.get("instance"))) if event.get("instance") else None,
        "machine_sha256_16": sha256_16(str(event.get("machine"))) if event.get("machine") else None,
        "summary_bytes": len(str(event.get("summary") or "").encode("utf-8", errors="replace")),
        "summary_sha256_16": sha256_16(str(event.get("summary") or "")) if event.get("summary") else None,
        "has_critical_asset": bool(safe_asset),
        "critical_asset_safe_fields": safe_asset,
        "diagnostics_key_count": len(diagnostics),
        "diagnostics_keys": sorted(str(key) for key in diagnostics),
        "delivery_status": safe_enum(delivery.get("status"), {"queued", "sent", "failed", "suppressed"}),
        "process_present": isinstance(event.get("process"), dict),
        "runtime_present": isinstance(event.get("runtime"), dict),
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
    return f"other_sha256_16:{sha256_16(stripped)}"


def build_report(raw: str, source_label: str) -> dict[str, Any]:
    event, evidence, artifact_type = parse_artifact_text(raw)
    parsed = bool(evidence)
    evidence_report = evidence_summary(evidence) if parsed else {}
    event_report = event_summary(event)
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": (
            "metadata-only artifact adapter; suppresses raw evidence, summary, process argv, "
            "diagnostic values, queue paths, socket paths, JIDs, provider output, credential values, "
            "instance names, machine names, and config paths"
        ),
        "artifact": {
            "source": source_label,
            "type": artifact_type,
            "parsed": parsed,
            "raw_bytes": len(raw.encode("utf-8", errors="replace")),
            "raw_sha256_16": sha256_16(raw) if raw else None,
        },
        "event": event_report,
        "evidence": evidence_report,
        "adapter_contract": {
            "safe_fields": [
                "line_class_counts",
                "failure_category_counts",
                "warning_category_counts",
                "provider_failure_class_counts",
                "provider status/signal/context counts",
                "runtime_manifest_class_counts",
                "plugin_class_counts",
                "instance_hash_count",
                "event source/severity/type classes",
                "criticalAsset safe enum fields",
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
    args = parser.parse_args()
    if args.artifact and args.stdin:
        parser.error("choose --artifact or --stdin, not both")
    raw, source_label = read_artifact(args.artifact, args.stdin)
    report = build_report(raw, source_label)
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
