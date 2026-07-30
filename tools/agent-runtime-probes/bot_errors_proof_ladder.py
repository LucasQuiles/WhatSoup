#!/usr/bin/env python3
"""Metadata-only BOT ERRORS proof ladder.

This probe separates repo code presence, static expectations, historical
observations, and live observations for the WhatSoup BOT ERRORS control plane.
It does not SSH, read token files, call providers, inspect live services, or
send BOT ERRORS messages.
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
from probelib import load_json


DEFAULT_REPO = Path.home() / "LAB/WhatSoup"
SCHEMA = "bot-errors-proof-ladder-report"
SCHEMA_VERSION = "0.2"
RUNTIME_MANIFEST = Path("deploy/bot-errors-runtime-manifest.json")
MANAGED_COMPONENTS = Path("deploy/managed-components.json")
HEALTH_PROFILES = Path("deploy/health-profiles")
OBSERVATION_FIELDS = (
    "subject",
    "status",
    "inputMode",
    "formatStatus",
    "schemaStatus",
    "counts",
    "error_class",
    "artifact_refs",
)

COMPONENTS = [
    "q_loop",
    "dispatcher",
    "collector",
    "daily_health",
    "heartbeat_watchdog",
    "deadman",
    "runtime_manifest",
    "managed_components",
]

SCRIPT_PATHS = {
    "q_loop": "deploy/scripts/bot-errors-q-loop.py",
    "dispatcher": "deploy/scripts/bot-errors-dispatcher.py",
    "collector": "deploy/scripts/bot-errors-collector.py",
    "daily_health": "deploy/scripts/bot-errors-health-check.py",
    "heartbeat_watchdog": "deploy/scripts/bot-errors-heartbeat-watchdog.py",
    "deadman": "deploy/scripts/bot-errors-health-check.py",
}

STATIC_EXPECTATION_PATTERNS = {
    "daily_health": ("deploy/scripts/README-bot-errors.md", r"Daily health probe"),
}

PROFILE_EXPECTATION_FIELDS = {
    "q_loop": "expectQLoop",
    "dispatcher": "expectDispatcher",
    "runtime_manifest": "expectRuntimeManifest",
}

HISTORICAL_PATTERNS = {
    "q_loop": ("deploy/scripts/README-bot-errors.md", r"hub collector, dispatcher, q-loop, and health timer were active"),
    "dispatcher": ("deploy/scripts/README-bot-errors.md", r"hub collector, dispatcher, q-loop, and health timer were active"),
    "collector": ("deploy/scripts/README-bot-errors.md", r"hub collector, dispatcher, q-loop, and health timer were active"),
    "daily_health": ("deploy/scripts/README-bot-errors.md", r"hub collector, dispatcher, q-loop, and health timer were active"),
    "runtime_manifest": ("deploy/scripts/README-bot-errors.md", r"matched `8/8` host-local runtime manifest hashes"),
}

WATCHDOG_PATTERNS = {
    "q_loop": ("deploy/scripts/bot-errors-heartbeat-watchdog.py", r'"q_loop"|q_loop_state_path|max_q_loop_age'),
    "dispatcher": ("deploy/scripts/bot-errors-heartbeat-watchdog.py", r'"dispatcher"|dispatcher-state\.json|max_dispatcher_age'),
    "collector": ("deploy/scripts/bot-errors-heartbeat-watchdog.py", r'"collector"|collector-state\.json|max_collector_age'),
    "daily_health": ("deploy/scripts/bot-errors-heartbeat-watchdog.py", r'"daily_health"|daily_health_age|max_daily_health_age'),
}


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


def line_refs(repo: Path, rel_path: str, pattern: str, limit: int = 8) -> list[str]:
    path = repo / rel_path
    if not path.is_file():
        return []
    rx = re.compile(pattern)
    refs: list[str] = []
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError:
        return []
    for idx, line in enumerate(lines, 1):
        if rx.search(line):
            item_ref = ref(path, repo, idx)
            if item_ref is not None:
                refs.append(item_ref)
            if len(refs) >= limit:
                break
    return refs


def file_ref(repo: Path, rel_path: str) -> str | None:
    path = repo / rel_path
    if not path.is_file():
        return None
    return ref(path, repo, 1)


def runtime_manifest_files(repo: Path) -> list[str]:
    return runtime_manifest_summary(repo)["files"]


def load_failure(data: Any) -> tuple[str, str] | None:
    if not isinstance(data, dict) or "_error" not in data:
        return None
    error_name = str(data["_error"]).split(":", 1)[0]
    return ("invalid_json", "json_decode") if error_name == "JSONDecodeError" else ("read_error", "read_error")


def runtime_manifest_summary(repo: Path) -> dict[str, Any]:
    path = repo / RUNTIME_MANIFEST
    if not path.exists():
        return {**observation("runtime_manifest", "missing", format_status="absent", unknown=1), "files": []}
    if not path.is_file():
        return {
            **observation("runtime_manifest", "invalid_shape", schema_status="invalid_shape", error_class="not_regular_file", unknown=1, artifact_refs=(str(RUNTIME_MANIFEST),)),
            "files": [],
        }
    data = load_json(path)
    failure = load_failure(data)
    if failure:
        status, error_class = failure
        return {
            **observation("runtime_manifest", status, format_status="invalid_json" if status == "invalid_json" else "read_error", error_class=error_class, unknown=1, artifact_refs=(str(RUNTIME_MANIFEST),)),
            "files": [],
        }
    if not isinstance(data, dict):
        return {
            **observation("runtime_manifest", "invalid_shape", format_status="valid_json", schema_status="invalid_shape", error_class="root_not_object", unknown=1, artifact_refs=(str(RUNTIME_MANIFEST),)),
            "files": [],
        }
    files = data.get("files")
    if not isinstance(files, list):
        return {
            **observation("runtime_manifest", "invalid_shape", format_status="valid_json", schema_status="invalid_shape", error_class="files_not_list", unknown=1, artifact_refs=(str(RUNTIME_MANIFEST),)),
            "files": [],
        }
    valid_paths: list[str] = []
    invalid_files = 0
    for item in files:
        path_value = item.get("path") if isinstance(item, dict) else None
        if not isinstance(path_value, str) or not path_value:
            invalid_files += 1
            continue
        valid_paths.append(path_value)
    status = "partial" if invalid_files else "observed"
    return {
        **observation("runtime_manifest", status, format_status="valid_json", schema_status="partial" if invalid_files else "valid", expected=len(files), observed_valid=len(valid_paths), invalid=invalid_files, artifact_refs=(str(RUNTIME_MANIFEST),)),
        "files": valid_paths,
    }


def managed_component_names(repo: Path) -> list[str]:
    return managed_component_summary(repo)["names"]


def managed_component_summary(repo: Path) -> dict[str, Any]:
    path = repo / MANAGED_COMPONENTS
    if not path.exists():
        return {**observation("managed_components", "missing", format_status="absent", unknown=1), "names": []}
    if not path.is_file():
        return {
            **observation("managed_components", "invalid_shape", schema_status="invalid_shape", error_class="not_regular_file", unknown=1, artifact_refs=(str(MANAGED_COMPONENTS),)),
            "names": [],
        }
    data = load_json(path)
    failure = load_failure(data)
    if failure:
        status, error_class = failure
        return {
            **observation("managed_components", status, format_status="invalid_json" if status == "invalid_json" else "read_error", error_class=error_class, unknown=1, artifact_refs=(str(MANAGED_COMPONENTS),)),
            "names": [],
        }
    if not isinstance(data, dict):
        return {
            **observation("managed_components", "invalid_shape", format_status="valid_json", schema_status="invalid_shape", error_class="root_not_object", unknown=1, artifact_refs=(str(MANAGED_COMPONENTS),)),
            "names": [],
        }
    protective_services = data.get("protective_services")
    if not isinstance(protective_services, dict):
        return {
            **observation("managed_components", "invalid_shape", format_status="valid_json", schema_status="invalid_shape", error_class="protective_services_not_object", unknown=1, artifact_refs=(str(MANAGED_COMPONENTS),)),
            "names": [],
        }
    entries = protective_services.get("entries")
    if not isinstance(entries, list):
        return {
            **observation("managed_components", "invalid_shape", format_status="valid_json", schema_status="invalid_shape", error_class="entries_not_list", unknown=1, artifact_refs=(str(MANAGED_COMPONENTS),)),
            "names": [],
        }
    valid_names: list[str] = []
    invalid_entries = 0
    for item in entries:
        name = item.get("name") if isinstance(item, dict) else None
        if not isinstance(name, str) or not name:
            invalid_entries += 1
            continue
        valid_names.append(name)
    status = "partial" if invalid_entries else "observed"
    return {
        **observation("managed_components", status, format_status="valid_json", schema_status="partial" if invalid_entries else "valid", expected=len(entries), observed_valid=len(valid_names), invalid=invalid_entries, artifact_refs=(str(MANAGED_COMPONENTS),)),
        "names": valid_names,
    }


def profile_expectation_summary(repo: Path) -> dict[str, Any]:
    profile_dir = repo / HEALTH_PROFILES
    expectations = {component: 0 for component in PROFILE_EXPECTATION_FIELDS}
    if not profile_dir.exists():
        return {**observation("health_profiles", "missing", format_status="absent", unknown=1), "profile_count": 0, "expectations": expectations}
    if not profile_dir.is_dir():
        return {
            **observation("health_profiles", "invalid_shape", schema_status="invalid_shape", error_class="profile_root_not_directory", unknown=1, artifact_refs=(str(HEALTH_PROFILES),)),
            "profile_count": 0,
            "expectations": expectations,
        }
    try:
        paths = sorted(profile_dir.glob("*.json"))
    except OSError:
        return {
            **observation("health_profiles", "read_error", format_status="read_error", error_class="directory_read", unknown=1, artifact_refs=(str(HEALTH_PROFILES),)),
            "profile_count": 0,
            "expectations": expectations,
        }
    valid_profiles = 0
    invalid_profiles = 0
    saw_read_error = False
    saw_invalid_json = False
    saw_invalid_shape = False
    saw_partial = False
    for path in paths:
        data = load_json(path)
        failure = load_failure(data)
        if failure:
            invalid_profiles += 1
            saw_invalid_json = saw_invalid_json or failure[0] == "invalid_json"
            saw_read_error = saw_read_error or failure[0] == "read_error"
            continue
        if not isinstance(data, dict):
            invalid_profiles += 1
            saw_invalid_shape = True
            continue
        invalid_fields = False
        for component, field in PROFILE_EXPECTATION_FIELDS.items():
            value = data.get(field)
            if value is None:
                continue
            if not isinstance(value, bool):
                invalid_fields = True
                continue
            if value:
                expectations[component] += 1
        if invalid_fields:
            invalid_profiles += 1
            saw_partial = True
            continue
        valid_profiles += 1
    if saw_read_error:
        status, format_status, schema_status, error_class = "read_error", "read_error", "not_applicable", "read_error"
    elif saw_invalid_json:
        status, format_status, schema_status, error_class = "invalid_json", "invalid_json", "not_applicable", "json_decode"
    elif saw_invalid_shape:
        status, format_status, schema_status, error_class = "invalid_shape", "valid_json", "invalid_shape", "profile_root_not_object"
    elif saw_partial:
        status, format_status, schema_status, error_class = "partial", "valid_json", "partial", "expectation_not_bool"
    else:
        status, format_status, schema_status, error_class = "observed", "valid_json", "valid", None
    return {
        **observation("health_profiles", status, format_status=format_status, schema_status=schema_status, expected=len(paths), observed_valid=valid_profiles, invalid=invalid_profiles, unknown=1 if status in {"invalid_json", "read_error"} else 0, error_class=error_class, artifact_refs=(str(HEALTH_PROFILES),)),
        "profile_count": valid_profiles,
        "expectations": expectations,
    }


def observation_view(source: dict[str, Any]) -> dict[str, Any]:
    return {field: source[field] for field in OBSERVATION_FIELDS}


def evidence_item(proof_class: str, status: str, refs: list[str], note: str) -> dict[str, Any]:
    return {
        "proof_class": proof_class,
        "status": status,
        "evidence_refs": refs,
        "note": note,
    }


def static_source_status(source: dict[str, Any] | None, fallback_present: bool) -> str:
    if source is None:
        return "present" if fallback_present else "missing"
    status = str(source.get("status") or "invalid_shape")
    if status in {"ok", "observed"}:
        return "present"
    if status in {"missing", "invalid_json", "invalid_shape", "partial", "unsupported_version", "read_error", "not_applicable"}:
        return status
    return "invalid_shape"


def component_report(
    repo: Path,
    component: str,
    manifest_files: list[str],
    managed_names: list[str],
    *,
    manifest_status: dict[str, Any] | None = None,
    managed_status: dict[str, Any] | None = None,
    profile_status: dict[str, Any] | None = None,
) -> dict[str, Any]:
    evidence: list[dict[str, Any]] = []

    script_path = SCRIPT_PATHS.get(component)
    if script_path:
        refs = [file_ref(repo, script_path)] if file_ref(repo, script_path) else []
        evidence.append(evidence_item("code_present", "present" if refs else "missing", [r for r in refs if r], "Repo-local implementation file presence."))

    if component == "deadman":
        refs = line_refs(repo, "deploy/scripts/bot-errors-health-check.py", r"def deadman\(|DEADMAN|deadman-state")
        evidence.append(evidence_item("code_present", "present" if refs else "missing", refs, "Generic BOT ERRORS deadman code in health-check script."))
        design_refs = line_refs(repo, "docs/runbooks/runtime-host-deadman.md", r"DESIGN ONLY|not yet installed|central-dark|runtime-host-deadman")
        evidence.append(evidence_item("design_only", "present" if design_refs else "missing", design_refs, "Nucles-specific deadman runbook status; not live install proof."))

    static_pattern = STATIC_EXPECTATION_PATTERNS.get(component)
    if static_pattern:
        rel_path, pattern = static_pattern
        refs = line_refs(repo, rel_path, pattern)
        evidence.append(evidence_item("static_expectation", "present" if refs else "missing", refs, "Static expectation or documented lane definition."))

    profile_field = PROFILE_EXPECTATION_FIELDS.get(component)
    if profile_field:
        status = static_source_status(profile_status, False)
        expected_count = int((profile_status or {}).get("expectations", {}).get(component, 0))
        if status == "present":
            status = "present" if expected_count else "not_applicable"
        refs = list((profile_status or {}).get("artifact_refs", [])) if status == "present" else []
        note = (
            f"Canonical profile inventory expects this component on {expected_count} role profiles."
            if status == "present"
            else f"Canonical profile inventory status is {status}; component expectation is not asserted."
        )
        evidence.append(evidence_item("static_expectation", status, refs, note))

    watchdog_pattern = WATCHDOG_PATTERNS.get(component)
    if watchdog_pattern:
        rel_path, pattern = watchdog_pattern
        refs = line_refs(repo, rel_path, pattern)
        evidence.append(evidence_item("watchdog_code", "present" if refs else "missing", refs, "Heartbeat watchdog code can check this lane when executed."))

    historical_pattern = HISTORICAL_PATTERNS.get(component)
    if historical_pattern:
        rel_path, pattern = historical_pattern
        refs = line_refs(repo, rel_path, pattern)
        evidence.append(evidence_item("historical_observation_2026_06_13", "present" if refs else "missing", refs, "Historical stability evidence in repo docs; not current live proof."))

    if component == "runtime_manifest":
        manifest_ref = file_ref(repo, "deploy/bot-errors-runtime-manifest.json")
        refs = [manifest_ref] if manifest_ref else []
        status = static_source_status(manifest_status, bool(refs) or bool(manifest_files))
        policy_refs = line_refs(repo, "deploy/bot-errors-runtime-manifest.json", r"observability-only|expectedHeadShaPolicy") if status == "present" else []
        evidence.append(evidence_item("static_manifest", status, refs + policy_refs if status == "present" else [], "Committed runtime manifest is observability/policy input."))
        count_note = f"Committed manifest lists {len(manifest_files)} files." if status == "present" else f"Committed manifest source status is {status}; file count is not asserted."
        evidence.append(evidence_item("manifest_file_count", status, [], count_note))

    if component == "managed_components":
        policy_ref = file_ref(repo, "deploy/managed-components.json")
        refs = [policy_ref] if policy_ref else []
        status = static_source_status(managed_status, bool(refs) or bool(managed_names))
        note = f"Managed-components policy lists {len(managed_names)} protective services." if status == "present" else f"Managed-components policy source status is {status}; service count is not asserted."
        evidence.append(evidence_item("static_policy", status, refs if status == "present" else [], note))

    evidence.append(evidence_item("live_observation", "not_probed", [], "No SSH, service-manager, queue, runtime-manifest, or daily-health live artifact was read by this probe."))

    status_counts = Counter(str(item["status"]) for item in evidence)
    proof_classes = [str(item["proof_class"]) for item in evidence]
    return {
        "component": component,
        "proof_classes": proof_classes,
        "status_counts": dict(sorted(status_counts.items())),
        "evidence": evidence,
        "verdict": "current live state unproven" if status_counts.get("not_probed") else "static evidence only",
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


def build_report(repo: Path) -> dict[str, Any]:
    repo = repo.expanduser().resolve()
    manifest_status = runtime_manifest_summary(repo)
    managed_status = managed_component_summary(repo)
    profile_status = profile_expectation_summary(repo)
    manifest_files = manifest_status["files"]
    managed_names = managed_status["names"]
    components = [
        component_report(
            repo,
            component,
            manifest_files,
            managed_names,
            manifest_status=manifest_status,
            managed_status=managed_status,
            profile_status=profile_status,
        )
        for component in COMPONENTS
    ]
    proof_counter = Counter(
        proof_class
        for component in components
        for proof_class in component["proof_classes"]
    )
    live_not_probed = sum(
        1
        for component in components
        for item in component["evidence"]
        if item["proof_class"] == "live_observation" and item["status"] == "not_probed"
    )
    observations = {
        "runtime_manifest": observation_view(manifest_status),
        "managed_components": observation_view(managed_status),
        "health_profiles": observation_view(profile_status),
    }
    consistency = {
        f"{name}_observed": item["status"] == "observed"
        for name, item in observations.items()
    }
    source_status = {
        name: {"status": item["status"], "error_class": item["error_class"]}
        for name, item in observations.items()
    }

    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "serializationStatus": "emitted",
        "requiredObservations": sorted(observations),
        "observations": observations,
        "reportVerdict": report_verdict(observations),
        "redaction": "metadata-only; no live host, account, credential, queue, process, message, or absolute-path values are read or emitted",
        "summary": {
            "components": len(components),
            "proof_class_counts": dict(sorted(proof_counter.items())),
            "live_observation_not_probed": live_not_probed,
            "runtime_manifest_files": len(manifest_files) if manifest_status["status"] == "observed" else None,
            "managed_protective_services": len(managed_names) if managed_status["status"] == "observed" else None,
            "health_profile_count": profile_status["profile_count"] if profile_status["status"] == "observed" else None,
            "source_status_counts": dict(sorted(Counter(item["status"] for item in observations.values()).items())),
            "consistency_passed": sum(1 for value in consistency.values() if value),
            "consistency_total": len(consistency),
        },
        "source_status": source_status,
        "consistency": consistency,
        "proof_class_definitions": {
            "code_present": "Repo-local code or script exists.",
            "static_expectation": "Config/doc declares the component should exist or be checked.",
            "watchdog_code": "Repo-local watchdog logic can check the lane when executed.",
            "historical_observation_2026_06_13": "README records a past read-only stability observation.",
            "design_only": "Runbook/design artifact exists but does not prove install.",
            "static_manifest": "Committed manifest/policy artifact exists.",
            "static_policy": "Committed managed policy artifact exists.",
            "live_observation": "Current live host/service/queue proof; this probe always reports not_probed.",
        },
        "components": components,
        "gaps": [
            {
                "gap": "live-observation-absent",
                "why_it_matters": "Every component has static/code evidence, but current q-loop/dispatcher/collector/daily-health/deadman runtime health remains unproven.",
                "next_probe": "Redacted artifact ingestion, or explicit approved live proof with bounded metadata and no secrets.",
            },
            {
                "gap": "historical-green-is-not-current-green",
                "why_it_matters": "2026-06-13 stability evidence can guide expectations but cannot prove current host-local scripts or queues.",
                "next_probe": "Record observation timestamp and proof class whenever historical health evidence is reused.",
            },
        ],
    }


if __name__ == "__main__":
    raise SystemExit(main())
