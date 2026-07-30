#!/usr/bin/env python3
"""Metadata-only BOT ERRORS health-check surface inventory.

This probe maps what the committed WhatSoup BOT ERRORS health-check script can
observe and emit. It does not run the health check, SSH, call providers, read
live queues, read credential files, or send BOT ERRORS messages.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from bot_errors_probe_observation import observation, report_verdict, strict_exit_code
from probelib import git_head, load_json, sha256_16

SCHEMA = "bot-errors-health-surface-report"
SCHEMA_VERSION = "0.2"
DEFAULT_REPO = Path.home() / "LAB/WhatSoup"
HEALTH_SCRIPT = Path("deploy/scripts/bot-errors-health-check.py")
RUNTIME_MANIFEST = Path("deploy/bot-errors-runtime-manifest.json")
MANAGED_COMPONENTS = Path("deploy/managed-components.json")

KEY_FUNCTIONS = [
    "daily",
    "plugin_inventory",
    "provider_probe_inventory",
    "provider_probe_target_inventory",
    "opencode_provider_probe_inventory",
    "runtime_manifest_inventory",
    "critical_asset_from_health_evidence",
    "alert_source_from_health_evidence",
    "emit_per_instance_health_failures",
    "deadman",
]

SAFE_SOURCE_PREFIXES = [
    "provider_probe",
    "runtime_manifest",
    "source_update",
    "primary_phone",
    "daily-health",
    "daily-health-fail",
]


def read_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return path.read_text(encoding="utf-8", errors="replace").splitlines()


def rel(path: Path, repo: Path) -> str | None:
    try:
        return str(path.relative_to(repo))
    except ValueError:
        return None


def ref(path: Path, repo: Path, line: int | None = None) -> str | None:
    relative = rel(path, repo)
    if relative is None:
        return None
    suffix = f":{line}" if line else ""
    return f"{relative}{suffix}"


def line_refs(repo: Path, rel_path: Path, pattern: str, limit: int = 8) -> list[str]:
    path = repo / rel_path
    rx = re.compile(pattern)
    refs: list[str] = []
    for idx, line in enumerate(read_lines(path), 1):
        if rx.search(line):
            item_ref = ref(path, repo, idx)
            if item_ref is not None:
                refs.append(item_ref)
            if len(refs) >= limit:
                break
    return refs


def parse_functions(source: str) -> dict[str, dict[str, Any]]:
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return {"_parse_error": {"_error": "SyntaxError", "line": exc.lineno, "offset": exc.offset}}
    functions: dict[str, dict[str, Any]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            functions[node.name] = {
                "line": node.lineno,
                "end_line": getattr(node, "end_lineno", node.lineno),
            }
    return functions


def function_body(source_lines: list[str], fn: dict[str, Any] | None) -> str:
    if not fn:
        return ""
    start = max(1, int(fn["line"])) - 1
    end = max(start + 1, int(fn.get("end_line") or fn["line"]))
    return "\n".join(source_lines[start:end])


def source_hash(lines: list[str], start: int, end: int) -> str:
    snippet = "\n".join(lines[max(0, start - 1):max(0, end)])
    return sha256_16(snippet)


def function_inventory(repo: Path, source_lines: list[str], functions: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    path = repo / HEALTH_SCRIPT
    for name in KEY_FUNCTIONS:
        fn = functions.get(name)
        if not fn:
            items.append({"name": name, "present": False})
            continue
        line = int(fn["line"])
        end_line = int(fn.get("end_line") or line)
        items.append({
            "name": name,
            "present": True,
            "ref": ref(path, repo, line),
            "line_count": max(1, end_line - line + 1),
            "body_sha256_16": source_hash(source_lines, line, end_line),
        })
    return items


def argparse_flags(source: str) -> list[str]:
    flags = set()
    for match in re.finditer(r"parser\.add_argument\(\s*['\"](--[A-Za-z0-9][A-Za-z0-9_-]*)['\"]", source):
        flags.add(match.group(1))
    return sorted(flags)


def daily_surfaces(source_lines: list[str], functions: dict[str, dict[str, Any]]) -> dict[str, Any]:
    body = function_body(source_lines, functions.get("daily"))
    inventory_calls = sorted(set(re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*_inventory)\(", body)))
    service_labels = sorted(set(re.findall(r"service_health_line\(\s*[\r\n ]*['\"]([^'\"]+)['\"]", body)))
    explicit_lines = sorted(
        label for label in ["dispatcher_enabled", "q_loop_enabled", "personal_socket", "machine", "profile"]
        if label in body
    )
    outbox_sources = sorted(set(re.findall(r"source=['\"]([^'\"]+)['\"]", body)))
    return {
        "inventory_call_count": len(inventory_calls),
        "inventory_calls": inventory_calls,
        "service_labels": service_labels,
        "explicit_lines": explicit_lines,
        "outbox_sources": outbox_sources,
    }


def provider_surfaces(source: str, source_lines: list[str], functions: dict[str, dict[str, Any]]) -> dict[str, Any]:
    provider_body = "\n".join(
        function_body(source_lines, functions.get(name))
        for name in [
            "classify_provider_probe_failure",
            "provider_probe_inventory",
            "provider_probe_target_inventory",
            "opencode_provider_probe_inventory",
            "provider_probe_contradicted_by_live_service",
            "provider_probe_inconclusive_due_to_headless_auth",
        ]
    )
    failure_classes = sorted(set(re.findall(r"['\"](provider_[A-Za-z0-9_]+)['\"]", provider_body)))
    failure_classes = [item for item in failure_classes if item.startswith("provider_")]
    context_markers = sorted(set(re.findall(r"(provider_auth_context=[A-Za-z0-9_:-]+)", source)))
    signal_markers = sorted(set(re.findall(r"(provider_probe_signal=[A-Za-z0-9_:-]+)", source)))
    live_markers = sorted(set(re.findall(r"['\"](live_provider_[A-Za-z0-9_]+)=", source)))
    health_markers = sorted(set(re.findall(r"['\"](health_provider_[A-Za-z0-9_]+)=", source)))
    return {
        "failure_classes": failure_classes,
        "failure_class_count": len(failure_classes),
        "provider_auth_context_markers": context_markers,
        "provider_probe_signal_markers": signal_markers,
        "live_session_marker_keys": live_markers,
        "health_session_marker_keys": health_markers,
        "supports_opencode_probe_path": "opencode_provider_probe_inventory" in source,
        "supports_claude_probe_path": "claude-cli" in source and "provider_probe_target_inventory" in source,
    }


def alert_surfaces(source: str, source_lines: list[str], functions: dict[str, dict[str, Any]]) -> dict[str, Any]:
    body = "\n".join(
        function_body(source_lines, functions.get(name))
        for name in ["critical_asset_from_health_evidence", "alert_source_from_health_evidence"]
    )
    critical_codes = sorted(set(re.findall(r"['\"]([A-Z][A-Z0-9_]{6,})['\"]", body)))
    alert_prefixes = sorted(prefix for prefix in SAFE_SOURCE_PREFIXES if prefix in body)
    return {
        "critical_asset_codes": critical_codes,
        "critical_asset_code_count": len(critical_codes),
        "alert_source_prefixes": alert_prefixes,
    }


def plugin_surfaces(source_lines: list[str], functions: dict[str, dict[str, Any]]) -> dict[str, Any]:
    body = function_body(source_lines, functions.get("plugin_inventory"))
    emitted_prefixes = sorted(set(re.findall(r"['\"](?:FAIL )?([A-Za-z_]+(?: [A-Za-z_]+)?):", body)))
    return {
        "present": bool(body),
        "emitted_prefixes": emitted_prefixes,
        "checks_user_scope_keys": "user_scope_keys" in body,
        "checks_enabled_plugins": "enabledPlugins" in body,
        "checks_plugin_dirs": "pluginDirs" in body,
        "path_values_suppressed_by_probe": True,
    }


def manifest_surface(repo: Path) -> dict[str, Any]:
    path = repo / RUNTIME_MANIFEST
    manifest = load_json(path)
    if manifest is None:
        return {
            **observation("runtime_manifest", "missing", format_status="absent", unknown=1),
            "file_count": 0,
            "marker_category_counts": {},
        }
    if isinstance(manifest, dict) and "_error" in manifest:
        return {
            **observation("runtime_manifest", "invalid_json", format_status="invalid_json", error_class="json_decode", unknown=1),
            "file_count": 0,
            "marker_category_counts": {},
        }
    if not isinstance(manifest, dict):
        return {
            **observation("runtime_manifest", "invalid_shape", format_status="valid_json", schema_status="invalid_shape", error_class="root_not_object", unknown=1, artifact_refs=(str(RUNTIME_MANIFEST),)),
            "file_count": 0,
            "marker_category_counts": {},
        }
    files = manifest.get("files")
    if not isinstance(files, list):
        return {
            **observation("runtime_manifest", "invalid_shape", format_status="valid_json", schema_status="invalid_shape", error_class="files_not_list", unknown=1, artifact_refs=(str(RUNTIME_MANIFEST),)),
            "file_count": 0,
            "marker_category_counts": {},
        }
    marker_counter: Counter[str] = Counter()
    valid_files = 0
    invalid_files = 0
    for item in files:
        if not isinstance(item, dict):
            invalid_files += 1
            continue
        valid_files += 1
        markers = item.get("mustContain")
        marker_list = markers if isinstance(markers, list) else [markers] if isinstance(markers, str) else []
        for marker in marker_list:
            if not isinstance(marker, str):
                continue
            lowered = marker.lower()
            if "redact" in lowered:
                marker_counter["redaction_markers"] += 1
            if "provider" in lowered:
                marker_counter["provider_markers"] += 1
            if "plugin" in lowered:
                marker_counter["plugin_markers"] += 1
            if "manifest" in lowered:
                marker_counter["runtime_manifest_markers"] += 1
            if "jsonl" in lowered or "private" in lowered:
                marker_counter["private_log_markers"] += 1
    status = "partial" if invalid_files else "observed"
    return {
        **observation("runtime_manifest", status, format_status="valid_json", schema_status="partial" if invalid_files else "valid", expected=len(files), observed_valid=valid_files, invalid=invalid_files, artifact_refs=(str(RUNTIME_MANIFEST),)),
        "file_count": valid_files,
        "marker_category_counts": dict(sorted(marker_counter.items())),
    }


def managed_surface(repo: Path) -> dict[str, Any]:
    path = repo / MANAGED_COMPONENTS
    data = load_json(path)
    if data is None:
        return {
            **observation("managed_components", "missing", format_status="absent", unknown=1),
            "protective_service_count": 0,
            "purpose_category_counts": {},
        }
    if isinstance(data, dict) and "_error" in data:
        return {
            **observation("managed_components", "invalid_json", format_status="invalid_json", error_class="json_decode", unknown=1),
            "protective_service_count": 0,
            "purpose_category_counts": {},
        }
    if not isinstance(data, dict):
        return {
            **observation("managed_components", "invalid_shape", format_status="valid_json", schema_status="invalid_shape", error_class="root_not_object", unknown=1, artifact_refs=(str(MANAGED_COMPONENTS),)),
            "protective_service_count": 0,
            "purpose_category_counts": {},
        }
    protective = data.get("protective_services")
    if not isinstance(protective, dict):
        return {
            **observation("managed_components", "invalid_shape", format_status="valid_json", schema_status="invalid_shape", error_class="protective_services_not_object", unknown=1, artifact_refs=(str(MANAGED_COMPONENTS),)),
            "protective_service_count": 0,
            "purpose_category_counts": {},
        }
    entries = protective.get("entries")
    if not isinstance(entries, list):
        return {
            **observation("managed_components", "invalid_shape", format_status="valid_json", schema_status="invalid_shape", error_class="entries_not_list", unknown=1, artifact_refs=(str(MANAGED_COMPONENTS),)),
            "protective_service_count": 0,
            "purpose_category_counts": {},
        }
    purpose_counter: Counter[str] = Counter()
    valid_entries = 0
    invalid_entries = 0
    for item in entries:
        if not isinstance(item, dict):
            invalid_entries += 1
            continue
        valid_entries += 1
        purpose = str(item.get("purpose") or "").lower()
        if "health" in purpose or "restart" in purpose:
            purpose_counter["health_or_restart"] += 1
        if "manifest" in purpose or "drift" in purpose:
            purpose_counter["manifest_or_drift"] += 1
        if "token" in purpose or "auth" in purpose:
            purpose_counter["credential_backup"] += 1
    status = "partial" if invalid_entries else "observed"
    return {
        **observation("managed_components", status, format_status="valid_json", schema_status="partial" if invalid_entries else "valid", expected=len(entries), observed_valid=valid_entries, invalid=invalid_entries, artifact_refs=(str(MANAGED_COMPONENTS),)),
        "protective_service_count": valid_entries,
        "purpose_category_counts": dict(sorted(purpose_counter.items())),
    }


def build_report(repo: Path) -> dict[str, Any]:
    repo = repo.expanduser().resolve()
    script_path = repo / HEALTH_SCRIPT
    source_lines = read_lines(script_path)
    source = "\n".join(source_lines)
    functions = parse_functions(source)
    function_parse_error = functions.get("_parse_error") if isinstance(functions.get("_parse_error"), dict) else None
    function_items = function_inventory(repo, source_lines, functions)
    missing_functions = [item["name"] for item in function_items if not item.get("present")]
    daily = daily_surfaces(source_lines, functions)
    provider = provider_surfaces(source, source_lines, functions)
    alerts = alert_surfaces(source, source_lines, functions)
    plugins = plugin_surfaces(source_lines, functions)
    manifest = manifest_surface(repo)
    managed = managed_surface(repo)
    health_script = observation(
        "health_script",
        "invalid_shape" if function_parse_error else "observed" if script_path.exists() else "missing",
        format_status="not_applicable",
        schema_status="invalid_shape" if function_parse_error else "not_applicable",
        error_class="syntax_error" if function_parse_error else None,
        unknown=1 if not script_path.exists() or function_parse_error else 0,
        artifact_refs=(str(HEALTH_SCRIPT),) if script_path.exists() else (),
    )
    observations = {
        "health_script": health_script,
        "runtime_manifest": manifest,
        "managed_components": managed,
    }
    consistency = {
        "health_script_present": script_path.exists(),
        "key_functions_present": not missing_functions,
        "daily_has_plugin_inventory": "plugin_inventory" in daily["inventory_calls"],
        "daily_has_provider_probe_path": bool(provider["failure_classes"]),
        "daily_has_runtime_manifest_inventory": "runtime_manifest_inventory" in daily["inventory_calls"],
        "critical_asset_codes_present": bool(alerts["critical_asset_codes"]),
        "runtime_manifest_observed": manifest["status"] == "observed",
        "managed_components_observed": managed["status"] == "observed",
    }
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "serializationStatus": "emitted",
        "requiredObservations": sorted(observations),
        "observations": observations,
        "reportVerdict": report_verdict(observations),
        "head": git_head(repo),
        "redaction": (
            "metadata-only source/static inventory; does not run health check, SSH, "
            "provider CLIs, service managers, queue readers, credential readers, or BOT ERRORS sends; "
            "does not emit source lines, paths from health output, commands, config values, or credential material"
        ),
        "source": {
            "health_script_ref": ref(script_path, repo, 1) if script_path.exists() else None,
            "health_script_line_count": len(source_lines),
            "health_script_sha256_16": sha256_16(source),
            "function_parse_error": function_parse_error,
            "functions": function_items,
            "argparse_flags": argparse_flags(source),
        },
        "daily_health_surfaces": daily,
        "provider_probe_surfaces": provider,
        "alert_surfaces": alerts,
        "plugin_surfaces": plugins,
        "runtime_manifest_surface": manifest,
        "managed_components_surface": managed,
        "consistency": consistency,
        "summary": {
            "key_functions_present": len(function_items) - len(missing_functions),
            "key_functions_missing": len(missing_functions),
            "daily_inventory_call_count": daily["inventory_call_count"],
            "provider_failure_class_count": provider["failure_class_count"],
            "critical_asset_code_count": alerts["critical_asset_code_count"],
            "runtime_manifest_file_count": manifest.get("file_count", 0),
            "managed_protective_service_count": managed.get("protective_service_count", 0),
            "consistency_passed": sum(1 for value in consistency.values() if value),
            "consistency_total": len(consistency),
        },
        "adapter_opportunities": [
            {
                "name": "daily-health-ledger-adapter",
                "proof_class": "future_live_observation_or_redacted_artifact",
                "safe_fields": [
                    "event_type",
                    "severity",
                    "source",
                    "alert_source",
                    "failure_category_counts",
                    "provider_failure_class_counts",
                    "plugin_coverage_counts",
                    "runtime_manifest_status_counts",
                    "queue_age_classes",
                    "service_expected_loaded_counts",
                ],
                "forbidden_fields": [
                    "raw evidence lines",
                    "credential values",
                    "provider stdout/stderr",
                    "outbox payload text",
                    "socket paths",
                    "JIDs",
                    "token files",
                    "instance config values",
                ],
            },
        ],
        "limitations": [
            "Source/static proof only.",
            "No live host, queue, service-manager, provider, MCP, SSH, or BOT ERRORS send proof.",
            "Does not prove the committed health-check vintage matches any deployed host-local copy.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=DEFAULT_REPO)
    parser.add_argument("--pretty", action="store_true", help="pretty-print JSON")
    parser.add_argument("--strict", action="store_true", help="exit 2 unless required evidence is valid")
    args = parser.parse_args()
    report = build_report(args.repo)
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return strict_exit_code(report) if args.strict else 0


if __name__ == "__main__":
    raise SystemExit(main())
