#!/usr/bin/env python3
"""Metadata-only linter for Agent Skill descriptions.

This probe reuses the skill inventory discovery layer, reads SKILL.md
frontmatter locally, and emits routing-policy findings without dumping raw
descriptions, skill bodies, raw paths, or provider/runtime payloads.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from probelib import redact, sha256_16
from skill_metadata_inventory_probe import (
    DESCRIPTION_TARGET_CHARS,
    SkillRoot,
    broad_term_hits,
    default_roots,
    parse_frontmatter,
    skill_paths,
    trigger_breadth,
)

SCHEMA = "agent-runtime-skill-description-linter"
SCHEMA_VERSION = "0.1"
MIN_DESCRIPTION_CHARS = 40
MIN_DESCRIPTION_WORDS = 6
NEGATIVE_BOUNDARY_PHRASES = (
    "do not use",
    "don't use",
    "not for",
    "not when",
    "avoid when",
    "skip when",
    "unless",
    "only when",
)
OUTPUT_BOUNDARY_TERMS = (
    "artifact",
    "check",
    "diagnostic",
    "diff",
    "doc",
    "document",
    "edit",
    "fix",
    "implementation",
    "index",
    "inventory",
    "patch",
    "plan",
    "probe",
    "report",
    "summary",
    "test",
    "update",
)
SEVERITY_RANK = {"low": 1, "medium": 2, "high": 3}


def normalize_description(description: str) -> str:
    return re.sub(r"\s+", " ", description.strip().lower())


def contains_phrase(description: str, phrases: tuple[str, ...]) -> bool:
    lowered = description.lower()
    return any(phrase in lowered for phrase in phrases)


def contains_output_boundary(description: str) -> bool:
    lowered = description.lower()
    return any(re.search(rf"\b{re.escape(term)}\b", lowered) for term in OUTPUT_BOUNDARY_TERMS)


def max_severity(issues: list[dict[str, Any]]) -> str | None:
    if not issues:
        return None
    return max((str(issue["severity"]) for issue in issues), key=lambda item: SEVERITY_RANK[item])


def issue(code: str, severity: str, evidence: dict[str, Any]) -> dict[str, Any]:
    return {"code": code, "severity": severity, "evidence": evidence}


def collect_skill_rows(roots: list[SkillRoot]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for root in roots:
        root_path = root.path.expanduser()
        for path in skill_paths(root):
            text = path.read_text(encoding="utf-8", errors="replace")
            frontmatter = parse_frontmatter(text)
            raw_name = frontmatter.get("name") or path.parent.name
            description = frontmatter.get("description") or ""
            normalized = normalize_description(description)
            broad_terms = broad_term_hits(description)
            relative_depth = len(path.relative_to(root_path).parts) - 1 if path.is_relative_to(root_path) else None
            rows.append({
                "source_root": root.source_root,
                "harness": root.harness,
                "source_state": root.source_state,
                "evidence": root.evidence,
                "skill_name": redact(raw_name),
                "name_sha256_16": sha256_16(str(raw_name)),
                "path_sha256_16": sha256_16(str(path)),
                "root_sha256_16": sha256_16(str(root_path)),
                "relative_depth": relative_depth,
                "frontmatter_key_count": len(frontmatter),
                "description_present": bool(description.strip()),
                "description_chars": len(description),
                "description_word_count": len(description.split()),
                "description_sha256_16": sha256_16(description) if description else None,
                "normalized_description_sha256_16": sha256_16(normalized) if normalized else None,
                "broad_terms": broad_terms,
                "broad_term_count": len(broad_terms),
                "trigger_breadth": trigger_breadth(len(description), not bool(description.strip()), broad_terms),
                "has_negative_boundary": contains_phrase(description, NEGATIVE_BOUNDARY_PHRASES) if description else False,
                "has_output_boundary": contains_output_boundary(description) if description else False,
                "_description_for_lint": description,
                "_normalized_description_for_lint": normalized,
            })
    return rows


def duplicate_groups(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        normalized = str(row.get("_normalized_description_for_lint") or "")
        if normalized:
            grouped[normalized].append(row)
    return {key: value for key, value in grouped.items() if len(value) > 1}


def lint_row(row: dict[str, Any], duplicate_group_size: int) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    if not row["description_present"]:
        issues.append(issue("missing_description", "high", {"description_present": False}))
        return issues

    if row["description_chars"] > DESCRIPTION_TARGET_CHARS:
        issues.append(issue(
            "description_over_target",
            "medium",
            {"description_chars": row["description_chars"], "target_chars": DESCRIPTION_TARGET_CHARS},
        ))

    if row["description_chars"] < MIN_DESCRIPTION_CHARS or row["description_word_count"] < MIN_DESCRIPTION_WORDS:
        issues.append(issue(
            "description_too_short",
            "medium",
            {
                "description_chars": row["description_chars"],
                "description_word_count": row["description_word_count"],
                "min_chars": MIN_DESCRIPTION_CHARS,
                "min_words": MIN_DESCRIPTION_WORDS,
            },
        ))

    if row["broad_term_count"]:
        severity = "high" if row["trigger_breadth"] == "broad" else "medium"
        issues.append(issue(
            "broad_trigger_terms",
            severity,
            {"broad_term_count": row["broad_term_count"], "trigger_breadth": row["trigger_breadth"]},
        ))

    if not row["has_negative_boundary"]:
        issues.append(issue("missing_negative_boundary", "low", {"required": True}))

    if not row["has_output_boundary"]:
        issues.append(issue("missing_output_boundary", "low", {"required": True}))

    if duplicate_group_size > 1:
        issues.append(issue(
            "duplicate_normalized_description",
            "medium",
            {"duplicate_group_size": duplicate_group_size},
        ))

    return issues


def public_issue_row(row: dict[str, Any], issues: list[dict[str, Any]], duplicate_group_key: str | None) -> dict[str, Any]:
    return {
        "source_root": row["source_root"],
        "harness": row["harness"],
        "source_state": row["source_state"],
        "evidence": row["evidence"],
        "skill_name": row["skill_name"],
        "name_sha256_16": row["name_sha256_16"],
        "path_sha256_16": row["path_sha256_16"],
        "root_sha256_16": row["root_sha256_16"],
        "relative_depth": row["relative_depth"],
        "frontmatter_key_count": row["frontmatter_key_count"],
        "description_present": row["description_present"],
        "description_chars": row["description_chars"],
        "description_word_count": row["description_word_count"],
        "description_sha256_16": row["description_sha256_16"],
        "normalized_description_sha256_16": row["normalized_description_sha256_16"],
        "trigger_breadth": row["trigger_breadth"],
        "broad_terms": row["broad_terms"],
        "broad_term_count": row["broad_term_count"],
        "has_negative_boundary": row["has_negative_boundary"],
        "has_output_boundary": row["has_output_boundary"],
        "duplicate_description_group_sha256_16": sha256_16(duplicate_group_key) if duplicate_group_key else None,
        "issue_count": len(issues),
        "issue_codes": [str(item["code"]) for item in issues],
        "max_severity": max_severity(issues),
        "issues": issues,
    }


def build_report(roots: list[SkillRoot] | None = None, include_present_only_caches: bool = False) -> dict[str, Any]:
    roots = roots or default_roots(include_present_only_caches=include_present_only_caches)
    rows = collect_skill_rows(roots)
    groups = duplicate_groups(rows)
    group_by_row_hash = {
        (str(row["path_sha256_16"]), str(row["normalized_description_sha256_16"])): normalized
        for normalized, group_rows in groups.items()
        for row in group_rows
    }

    issue_rows: list[dict[str, Any]] = []
    issue_code_counts: Counter[str] = Counter()
    severity_counts: Counter[str] = Counter()
    issue_free_count = 0
    for row in rows:
        duplicate_key = group_by_row_hash.get((str(row["path_sha256_16"]), str(row["normalized_description_sha256_16"])))
        issues = lint_row(row, len(groups.get(str(row.get("_normalized_description_for_lint") or ""), [])))
        if not issues:
            issue_free_count += 1
        else:
            issue_rows.append(public_issue_row(row, issues, duplicate_key))
            issue_code_counts.update(str(item["code"]) for item in issues)
            severity_counts.update(str(item["severity"]) for item in issues)

    source_counts = Counter(str(row["source_root"]) for row in rows)
    state_counts = Counter(str(row["source_state"]) for row in rows)
    breadth_counts = Counter(str(row["trigger_breadth"]) for row in rows)
    duplicate_group_rows = []
    for normalized, group_rows in sorted(groups.items(), key=lambda item: (-len(item[1]), sha256_16(item[0]))):
        duplicate_group_rows.append({
            "normalized_description_sha256_16": sha256_16(normalized),
            "description_sha256_16_values": sorted({str(row["description_sha256_16"]) for row in group_rows if row.get("description_sha256_16")}),
            "skill_count": len(group_rows),
            "skill_name_hashes": sorted(str(row["name_sha256_16"]) for row in group_rows),
            "source_roots": sorted({str(row["source_root"]) for row in group_rows}),
            "source_states": sorted({str(row["source_state"]) for row in group_rows}),
        })

    root_rows = []
    for root in roots:
        paths = skill_paths(root)
        root_rows.append({
            "source_root": root.source_root,
            "harness": root.harness,
            "source_state": root.source_state,
            "evidence": root.evidence,
            "root_exists": root.path.expanduser().exists(),
            "root_sha256_16": sha256_16(str(root.path.expanduser())),
            "skill_count": len(paths),
        })

    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "proof_class": "local_skill_metadata_policy_lint",
        "redaction": (
            "metadata-only skill-description linter; emits skill names, hashes, counts, "
            "source classes, issue codes, severity labels, broad-term labels, and duplicate "
            "description hashes; does not emit raw descriptions, skill bodies, raw paths, "
            "script/reference/asset filenames, transcripts, provider payloads, or secrets"
        ),
        "policy": {
            "description_target_chars": DESCRIPTION_TARGET_CHARS,
            "min_description_chars": MIN_DESCRIPTION_CHARS,
            "min_description_words": MIN_DESCRIPTION_WORDS,
            "negative_boundary_phrase_count": len(NEGATIVE_BOUNDARY_PHRASES),
            "output_boundary_term_count": len(OUTPUT_BOUNDARY_TERMS),
            "severity_rank": SEVERITY_RANK,
        },
        "roots": root_rows,
        "summary": {
            "skill_count": len(rows),
            "issue_free_skill_count": issue_free_count,
            "skills_with_issues": len(issue_rows),
            "issue_instance_count": sum(issue_code_counts.values()),
            "issue_code_counts": dict(sorted(issue_code_counts.items())),
            "severity_counts": dict(sorted(severity_counts.items())),
            "source_root_counts": dict(sorted(source_counts.items())),
            "source_state_counts": dict(sorted(state_counts.items())),
            "trigger_breadth_counts": dict(sorted(breadth_counts.items())),
            "missing_description_count": issue_code_counts.get("missing_description", 0),
            "missing_negative_boundary_count": issue_code_counts.get("missing_negative_boundary", 0),
            "missing_output_boundary_count": issue_code_counts.get("missing_output_boundary", 0),
            "broad_trigger_skill_count": issue_code_counts.get("broad_trigger_terms", 0),
            "description_over_target_count": issue_code_counts.get("description_over_target", 0),
            "duplicate_description_group_count": len(duplicate_group_rows),
            "duplicate_description_skill_count": issue_code_counts.get("duplicate_normalized_description", 0),
        },
        "issues": issue_rows,
        "duplicate_description_groups": duplicate_group_rows,
        "limitations": [
            "Policy findings are heuristics for human review; they do not prove runtime activation quality.",
            "Descriptions are parsed from local SKILL.md frontmatter, not runtime init envelopes.",
            "Enabled plugin candidates come from local settings/config and plugin cache paths, not current-turn tool/context tables.",
            "Negative-boundary and output-boundary checks are lexical and can miss equivalent wording.",
            "No skill is disabled, quarantined, edited, or executed by this probe.",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Lint local SKILL.md descriptions without dumping descriptions or bodies.")
    parser.add_argument("--include-present-only-caches", action="store_true", help="Include known dormant/present-only cache roots.")
    parser.add_argument("--pretty", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(include_present_only_caches=args.include_present_only_caches)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
