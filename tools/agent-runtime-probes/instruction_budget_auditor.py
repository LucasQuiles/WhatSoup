#!/usr/bin/env python3
"""Metadata-only budget audit for always-on instruction surfaces.

The auditor estimates context pressure from allowlisted instruction files,
embedded Codex developer instructions, and Agent Skill descriptions. It emits
only sizes, hashes, counts, source classes, and review findings.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from config_surface_doctor import SurfaceSpec, expand_specs
from probelib import load_toml, redact, sha256_16
from skill_metadata_inventory_probe import SkillRoot, build_report as build_skill_inventory

HOME = Path.home()
SCHEMA = "agent-runtime-instruction-budget-auditor"
SCHEMA_VERSION = "0.1"
TOKEN_ESTIMATOR = "ceil(chars/4); rough budget signal, not provider tokenizer or billing proof"
LARGE_INSTRUCTION_TOKENS = 2000
VERY_LARGE_INSTRUCTION_TOKENS = 8000
SKILL_METADATA_BULK_TOKENS = 3000


@dataclass(frozen=True)
class InstructionSurface:
    path: Path
    harness: str
    surface: str
    load_mode: str
    loaded_by: str
    evidence: str


def estimate_tokens(chars: int) -> int:
    if chars <= 0:
        return 0
    return math.ceil(chars / 4)


def path_class(path: Path) -> str:
    expanded = path.expanduser()
    try:
        rel = expanded.relative_to(HOME)
    except ValueError:
        if str(expanded).startswith("/Library/Application Support/"):
            return "macos_managed_application_support"
        if str(expanded).startswith("/etc/"):
            return "system_etc"
        return "outside_home"
    parts = rel.parts
    if not parts:
        return "home_root"
    if parts[0] == ".claude":
        return "claude_home"
    if parts[0] == ".codex":
        return "codex_home"
    if parts[:2] == (".config", "opencode"):
        return "opencode_home"
    if parts[:2] == ("LAB", "WhatSoup"):
        return "whatsoup_project"
    if parts[0] == "LAB":
        return "lab_project"
    return "home_other"


def default_instruction_surfaces() -> list[InstructionSurface]:
    rows: list[InstructionSurface] = []
    for spec in expand_specs():
        if spec.surface != "instruction":
            continue
        rows.append(InstructionSurface(
            path=spec.path,
            harness=spec.harness,
            surface=spec.surface,
            load_mode="always_on_candidate",
            loaded_by=spec.loaded_by,
            evidence=spec.active_evidence or "allowlisted instruction surface",
        ))
    return rows


def default_codex_config_paths() -> list[Path]:
    paths = []
    for spec in expand_specs():
        if spec.harness == "codex" and spec.fmt == "toml" and spec.surface in {"settings", "profile"}:
            paths.append(spec.path)
    return sorted(set(paths))


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def summarize_text(text: str) -> dict[str, Any]:
    lines = text.splitlines()
    chars = len(text)
    return {
        "bytes": len(text.encode("utf-8", errors="replace")),
        "chars": chars,
        "estimated_tokens": estimate_tokens(chars),
        "line_count": len(lines),
        "heading_count": sum(1 for line in lines if line.startswith("#")),
        "sha256_16": sha256_16(text),
    }


def instruction_file_rows(surfaces: list[InstructionSurface]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for surface in surfaces:
        path = surface.path.expanduser()
        if not path.exists() or not path.is_file():
            continue
        text = read_text(path)
        summary = summarize_text(text)
        rows.append({
            "surface_kind": "instruction_file",
            "harness": surface.harness,
            "surface": surface.surface,
            "load_mode": surface.load_mode,
            "loaded_by": surface.loaded_by,
            "evidence": surface.evidence,
            "path_basename": redact(path.name),
            "path_class": path_class(path),
            "path_sha256_16": sha256_16(str(path)),
            **summary,
        })
    return rows


def embedded_codex_instruction_rows(config_paths: list[Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in config_paths:
        expanded = path.expanduser()
        if not expanded.exists() or not expanded.is_file():
            continue
        data = load_toml(expanded)
        if not isinstance(data, dict):
            continue
        value = data.get("developer_instructions")
        if not isinstance(value, str) or not value:
            continue
        summary = summarize_text(value)
        rows.append({
            "surface_kind": "embedded_config_instruction",
            "harness": "codex",
            "surface": "developer_instructions",
            "load_mode": "config_embedded_developer_instruction",
            "loaded_by": "Codex config loader",
            "evidence": "developer_instructions key present in TOML",
            "config_key": "developer_instructions",
            "path_basename": redact(expanded.name),
            "path_class": path_class(expanded),
            "path_sha256_16": sha256_16(str(expanded)),
            **summary,
        })
    return rows


def codex_config_status_rows(config_paths: list[Path]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for path in config_paths:
        expanded = path.expanduser()
        if not expanded.exists() or not expanded.is_file():
            continue
        data = load_toml(expanded)
        if isinstance(data, dict) and "_error" in data:
            status = "error"
            error_type = str(data["_error"]).split(":", 1)[0]
            shape = "error"
        elif isinstance(data, dict):
            status = "ok"
            error_type = None
            shape = "object"
        else:
            status = "invalid_shape"
            error_type = type(data).__name__
            shape = type(data).__name__
        rows.append({
            "surface_kind": "codex_config_source",
            "harness": "codex",
            "path_basename": redact(expanded.name),
            "path_class": path_class(expanded),
            "path_sha256_16": sha256_16(str(expanded)),
            "status": status,
            "error_type": error_type,
            "shape": shape,
        })
    return rows


def skill_description_rows(skill_roots: list[SkillRoot] | None, include_present_only_caches: bool) -> list[dict[str, Any]]:
    if skill_roots == []:
        return []
    report = build_skill_inventory(roots=skill_roots, include_present_only_caches=include_present_only_caches)
    rows: list[dict[str, Any]] = []
    for skill in report["skills"]:
        chars = int(skill.get("description_chars") or 0)
        rows.append({
            "surface_kind": "skill_description",
            "harness": skill.get("harness"),
            "source_root": skill.get("source_root"),
            "source_state": skill.get("source_state"),
            "load_mode": "metadata_only_candidate",
            "loaded_by": "Agent Skill metadata loader",
            "evidence": skill.get("evidence"),
            "skill_name": skill.get("name"),
            "name_sha256_16": skill.get("name_sha256_16"),
            "path_sha256_16": skill.get("path_sha256_16"),
            "root_sha256_16": skill.get("root_sha256_16"),
            "description_present": skill.get("description_present"),
            "description_chars": chars,
            "estimated_tokens": estimate_tokens(chars),
            "description_word_count": skill.get("description_word_count"),
            "description_sha256_16": skill.get("description_sha256_16"),
            "trigger_breadth": skill.get("trigger_breadth"),
            "broad_term_count": skill.get("broad_term_count"),
            "description_over_target": skill.get("description_over_target"),
        })
    return rows


def issue(code: str, severity: str, evidence: dict[str, Any]) -> dict[str, Any]:
    return {"code": code, "severity": severity, "evidence": evidence}


def build_findings(instruction_rows: list[dict[str, Any]], embedded_rows: list[dict[str, Any]], skill_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for row in instruction_rows + embedded_rows:
        tokens = int(row.get("estimated_tokens") or 0)
        if tokens > VERY_LARGE_INSTRUCTION_TOKENS:
            findings.append(issue("very_large_instruction_surface", "high", {
                "surface_kind": row["surface_kind"],
                "harness": row["harness"],
                "path_class": row["path_class"],
                "path_basename": row["path_basename"],
                "estimated_tokens": tokens,
                "threshold_tokens": VERY_LARGE_INSTRUCTION_TOKENS,
            }))
        elif tokens > LARGE_INSTRUCTION_TOKENS:
            findings.append(issue("large_instruction_surface", "medium", {
                "surface_kind": row["surface_kind"],
                "harness": row["harness"],
                "path_class": row["path_class"],
                "path_basename": row["path_basename"],
                "estimated_tokens": tokens,
                "threshold_tokens": LARGE_INSTRUCTION_TOKENS,
            }))

    skill_tokens = sum(int(row.get("estimated_tokens") or 0) for row in skill_rows)
    if skill_tokens > SKILL_METADATA_BULK_TOKENS:
        findings.append(issue("skill_description_metadata_bulk", "medium", {
            "skill_count": len(skill_rows),
            "estimated_tokens": skill_tokens,
            "threshold_tokens": SKILL_METADATA_BULK_TOKENS,
        }))

    normalized_hashes: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in instruction_rows:
        normalized_hashes[str(row["sha256_16"])].append(row)
    for digest, rows in normalized_hashes.items():
        if len(rows) <= 1:
            continue
        findings.append(issue("duplicate_instruction_file_hash", "medium", {
            "sha256_16": digest,
            "surface_count": len(rows),
            "path_classes": sorted({str(row["path_class"]) for row in rows}),
            "harnesses": sorted({str(row["harness"]) for row in rows}),
        }))
    return findings


def aggregate_rows(rows: list[dict[str, Any]], key: str) -> dict[str, dict[str, int]]:
    grouped: dict[str, Counter[str]] = defaultdict(Counter)
    for row in rows:
        label = str(row.get(key) or "unknown")
        grouped[label]["count"] += 1
        grouped[label]["chars"] += int(row.get("chars") or row.get("description_chars") or 0)
        grouped[label]["estimated_tokens"] += int(row.get("estimated_tokens") or 0)
    return {label: dict(counter) for label, counter in sorted(grouped.items())}


def top_rows(rows: list[dict[str, Any]], limit: int = 10) -> list[dict[str, Any]]:
    ordered = sorted(rows, key=lambda row: int(row.get("estimated_tokens") or 0), reverse=True)
    out = []
    for row in ordered[:limit]:
        keep = {
            "surface_kind": row.get("surface_kind"),
            "harness": row.get("harness"),
            "load_mode": row.get("load_mode"),
            "estimated_tokens": row.get("estimated_tokens"),
            "chars": row.get("chars", row.get("description_chars")),
            "path_basename": row.get("path_basename"),
            "path_class": row.get("path_class"),
            "path_sha256_16": row.get("path_sha256_16"),
            "skill_name": row.get("skill_name"),
            "name_sha256_16": row.get("name_sha256_16"),
            "source_root": row.get("source_root"),
            "trigger_breadth": row.get("trigger_breadth"),
        }
        out.append({key: value for key, value in keep.items() if value is not None})
    return out


def build_report(
    instruction_surfaces: list[InstructionSurface] | None = None,
    codex_config_paths: list[Path] | None = None,
    skill_roots: list[SkillRoot] | None = None,
    include_present_only_caches: bool = False,
) -> dict[str, Any]:
    instruction_surfaces = default_instruction_surfaces() if instruction_surfaces is None else instruction_surfaces
    codex_config_paths = default_codex_config_paths() if codex_config_paths is None else codex_config_paths
    instruction_rows = instruction_file_rows(instruction_surfaces)
    codex_config_rows = codex_config_status_rows(codex_config_paths)
    embedded_rows = embedded_codex_instruction_rows(codex_config_paths)
    skill_rows = skill_description_rows(skill_roots, include_present_only_caches)

    always_rows = instruction_rows + embedded_rows
    all_rows = always_rows + skill_rows
    total_estimated_tokens = sum(int(row.get("estimated_tokens") or 0) for row in all_rows)
    always_estimated_tokens = sum(int(row.get("estimated_tokens") or 0) for row in always_rows)
    skill_estimated_tokens = sum(int(row.get("estimated_tokens") or 0) for row in skill_rows)
    findings = build_findings(instruction_rows, embedded_rows, skill_rows)
    severity_counts = Counter(str(item["severity"]) for item in findings)
    issue_counts = Counter(str(item["code"]) for item in findings)

    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "proof_class": "local_instruction_budget_metadata",
        "redaction": (
            "metadata-only instruction budget audit; emits byte/char/line/token-estimate counts, "
            "hashes, path classes, basenames, source classes, skill names, and issue codes; "
            "does not emit raw instruction text, raw skill descriptions, skill bodies, raw paths, "
            "config scalar values, prompts, transcripts, provider payloads, or secrets"
        ),
        "token_estimator": TOKEN_ESTIMATOR,
        "thresholds": {
            "large_instruction_tokens": LARGE_INSTRUCTION_TOKENS,
            "very_large_instruction_tokens": VERY_LARGE_INSTRUCTION_TOKENS,
            "skill_metadata_bulk_tokens": SKILL_METADATA_BULK_TOKENS,
        },
        "summary": {
            "instruction_file_count": len(instruction_rows),
            "embedded_config_instruction_count": len(embedded_rows),
            "skill_description_count": len(skill_rows),
            "always_on_candidate_estimated_tokens": always_estimated_tokens,
            "skill_metadata_estimated_tokens": skill_estimated_tokens,
            "total_candidate_estimated_tokens": total_estimated_tokens,
            "surface_count": len(all_rows),
            "finding_count": len(findings),
            "issue_code_counts": dict(sorted(issue_counts.items())),
            "severity_counts": dict(sorted(severity_counts.items())),
            "codex_config_status_counts": dict(sorted(Counter(str(row["status"]) for row in codex_config_rows).items())),
            "by_harness": aggregate_rows(all_rows, "harness"),
            "by_load_mode": aggregate_rows(all_rows, "load_mode"),
            "by_surface_kind": aggregate_rows(all_rows, "surface_kind"),
        },
        "instruction_files": instruction_rows,
        "codex_config_sources": codex_config_rows,
        "embedded_config_instructions": embedded_rows,
        "skill_description_summary": {
            "count": len(skill_rows),
            "estimated_tokens": skill_estimated_tokens,
            "by_source_root": aggregate_rows(skill_rows, "source_root"),
            "by_source_state": aggregate_rows(skill_rows, "source_state"),
            "by_trigger_breadth": aggregate_rows(skill_rows, "trigger_breadth"),
            "top_skill_descriptions": top_rows(skill_rows),
        },
        "top_context_surfaces": top_rows(all_rows),
        "findings": findings,
        "limitations": [
            "Token counts use a rough chars/4 estimator and are not provider-tokenizer or billing proof.",
            "Instruction files are allowlisted loader candidates; this does not prove current-turn model-visible context.",
            "Skill descriptions are metadata-only candidates; large skill lists can be capped or omitted by harnesses.",
            "Embedded config instruction proof currently covers Codex TOML developer_instructions only.",
            "The probe reads local files/config values for sizing but never emits raw text or scalar values.",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit instruction/context budget without dumping instruction text.")
    parser.add_argument("--include-present-only-caches", action="store_true", help="Include known dormant/present-only skill cache roots.")
    parser.add_argument("--pretty", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(include_present_only_caches=args.include_present_only_caches)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
