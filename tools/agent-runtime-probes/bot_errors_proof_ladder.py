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

from probelib import git_head, load_json


DEFAULT_REPO = Path.home() / "LAB/WhatSoup"

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
    "q_loop": ("deploy/health-profiles/runtime-host.json", r'"expectQLoop"\s*:\s*true'),
    "dispatcher": ("deploy/health-profiles/runtime-host.json", r'"expectDispatcher"\s*:\s*true'),
    "daily_health": ("deploy/scripts/README-bot-errors.md", r"Daily health probe"),
    "runtime_manifest": ("deploy/health-profiles/runtime-host.json", r'"expectRuntimeManifest"\s*:\s*true'),
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


def rel(path: Path, repo: Path) -> str:
    try:
        return str(path.relative_to(repo))
    except ValueError:
        return str(path)


def ref(path: Path, repo: Path, line: int | None = None) -> str:
    suffix = f":{line}" if line else ""
    return f"{rel(path, repo)}{suffix}"


def line_refs(repo: Path, rel_path: str, pattern: str, limit: int = 8) -> list[str]:
    path = repo / rel_path
    if not path.exists():
        return []
    rx = re.compile(pattern)
    refs: list[str] = []
    for idx, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
        if rx.search(line):
            refs.append(ref(path, repo, idx))
            if len(refs) >= limit:
                break
    return refs


def file_ref(repo: Path, rel_path: str) -> str | None:
    path = repo / rel_path
    if not path.exists():
        return None
    return ref(path, repo, 1)


def runtime_manifest_files(repo: Path) -> list[str]:
    return runtime_manifest_summary(repo)["files"]


def runtime_manifest_summary(repo: Path) -> dict[str, Any]:
    path = repo / "deploy/bot-errors-runtime-manifest.json"
    if not path.exists():
        return {"status": "missing", "error_type": None, "files": []}
    data = load_json(path)
    if isinstance(data, dict) and "_error" in data:
        return {"status": "invalid_json", "error_type": str(data["_error"]).split(":", 1)[0], "files": []}
    if not isinstance(data, dict):
        return {"status": "invalid_shape", "error_type": type(data).__name__, "files": []}
    files = data.get("files")
    if not isinstance(files, list):
        return {"status": "invalid_shape", "error_type": "files_not_list", "files": []}
    return {
        "status": "ok",
        "error_type": None,
        "files": [str(item.get("path")) for item in files if isinstance(item, dict) and item.get("path")],
    }


def managed_component_names(repo: Path) -> list[str]:
    return managed_component_summary(repo)["names"]


def managed_component_summary(repo: Path) -> dict[str, Any]:
    path = repo / "deploy/managed-components.json"
    if not path.exists():
        return {"status": "missing", "error_type": None, "names": []}
    data = load_json(path)
    if isinstance(data, dict) and "_error" in data:
        return {"status": "invalid_json", "error_type": str(data["_error"]).split(":", 1)[0], "names": []}
    if not isinstance(data, dict):
        return {"status": "invalid_shape", "error_type": type(data).__name__, "names": []}
    entries = data.get("protective_services", {}).get("entries", [])
    if not isinstance(entries, list):
        return {"status": "invalid_shape", "error_type": "entries_not_list", "names": []}
    return {
        "status": "ok",
        "error_type": None,
        "names": [str(item.get("name")) for item in entries if isinstance(item, dict) and item.get("name")],
    }


def evidence_item(proof_class: str, status: str, refs: list[str], note: str) -> dict[str, Any]:
    return {
        "proof_class": proof_class,
        "status": status,
        "evidence_refs": refs,
        "note": note,
    }


def component_report(repo: Path, component: str, manifest_files: list[str], managed_names: list[str]) -> dict[str, Any]:
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
        refs = [ref(repo / "deploy/bot-errors-runtime-manifest.json", repo, 1)]
        policy_refs = line_refs(repo, "deploy/bot-errors-runtime-manifest.json", r"observability-only|expectedHeadShaPolicy")
        evidence.append(evidence_item("static_manifest", "present", refs + policy_refs, "Committed runtime manifest is observability/policy input."))
        evidence.append(evidence_item("manifest_file_count", "present", [], f"Committed manifest lists {len(manifest_files)} files."))

    if component == "managed_components":
        refs = [ref(repo / "deploy/managed-components.json", repo, 1)]
        evidence.append(evidence_item("static_policy", "present", refs, f"Managed-components policy lists {len(managed_names)} protective services."))

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
    args = parser.parse_args()

    repo = args.repo.expanduser().resolve()
    report = build_report(repo)
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def build_report(repo: Path) -> dict[str, Any]:
    manifest_status = runtime_manifest_summary(repo)
    managed_status = managed_component_summary(repo)
    manifest_files = manifest_status["files"]
    managed_names = managed_status["names"]
    components = [component_report(repo, component, manifest_files, managed_names) for component in COMPONENTS]
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

    return {
        "schema": "bot-errors-proof-ladder-report",
        "schema_version": "0.1",
        "repo": str(repo),
        "head": git_head(repo),
        "redaction": "metadata-only; no SSH, service-manager calls, auth files, token values, queue reads, provider calls, or BOT ERRORS sends",
        "summary": {
            "components": len(components),
            "proof_class_counts": dict(sorted(proof_counter.items())),
            "live_observation_not_probed": live_not_probed,
            "runtime_manifest_files": len(manifest_files),
            "managed_protective_services": len(managed_names),
            "source_status_counts": dict(sorted(Counter([manifest_status["status"], managed_status["status"]]).items())),
        },
        "source_status": {
            "runtime_manifest": {
                "status": manifest_status["status"],
                "error_type": manifest_status["error_type"],
            },
            "managed_components": {
                "status": managed_status["status"],
                "error_type": managed_status["error_type"],
            },
        },
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
                "next_probe": "Redacted daily-health/runtime-manifest artifact ingestion, or explicit SSH-approved live proof with names, ages, statuses, hashes, and no secrets.",
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
