#!/usr/bin/env python3
"""Metadata-only inventory of local Agent Skill surfaces.

This probe inventories SKILL.md frontmatter and packaging shape without dumping
skill bodies or descriptions. It separates direct skill roots from enabled
plugin-cache candidates and optional present-only caches.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import tomllib
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from probelib import load_json, redact, sha256_16

HOME = Path.home()
SCHEMA = "agent-runtime-skill-metadata-inventory"
SCHEMA_VERSION = "0.1"
DESCRIPTION_TARGET_CHARS = 350
BROAD_TERMS = (
    "analyze",
    "audit",
    "optimize",
    "improve",
    "review",
    "manage",
    "general",
    "comprehensive",
    "everything",
    "anything",
    "all",
    "across",
    "multiple",
    "various",
    "workflow",
)


@dataclass(frozen=True)
class SkillRoot:
    path: Path
    source_root: str
    harness: str
    source_state: str
    evidence: str


def strip_quotes(value: str) -> str:
    text = value.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
        return text[1:-1]
    return text


def parse_frontmatter(text: str) -> dict[str, str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    out: dict[str, str] = {}
    for line in lines[1:120]:
        if line.strip() == "---":
            break
        if ":" not in line or line.startswith((" ", "\t")):
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        if key:
            out[key] = strip_quotes(value)
    return out


def bounded_file_count(path: Path, limit: int = 500) -> int:
    if not path.exists() or not path.is_dir():
        return 0
    count = 0
    for candidate in path.rglob("*"):
        if candidate.is_file():
            count += 1
            if count >= limit:
                return count
    return count


def enabled_claude_plugin_roots() -> list[SkillRoot]:
    settings = load_json(HOME / ".claude/settings.json") or {}
    installed = load_json(HOME / ".claude/plugins/installed_plugins.json") or {}
    enabled = settings.get("enabledPlugins") if isinstance(settings, dict) else {}
    plugins = installed.get("plugins") if isinstance(installed, dict) else {}
    roots: list[SkillRoot] = []
    if not isinstance(enabled, dict) or not isinstance(plugins, dict):
        return roots
    for plugin_id, is_enabled in sorted(enabled.items()):
        if not is_enabled:
            continue
        entries = plugins.get(plugin_id)
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict) or not entry.get("installPath"):
                continue
            skills_dir = Path(str(entry["installPath"])) / "skills"
            roots.append(SkillRoot(
                path=skills_dir,
                source_root="claude_enabled_plugin_skills",
                harness="claude",
                source_state="enabled_plugin_candidate",
                evidence="settings.enabledPlugins + installed_plugins.installPath",
            ))
    return roots


def enabled_codex_plugin_roots() -> list[SkillRoot]:
    config_path = HOME / ".codex/config.toml"
    if not config_path.exists():
        return []
    try:
        data = tomllib.loads(config_path.read_text())
    except Exception as exc:
        return [SkillRoot(
            path=config_path,
            source_root="codex_enabled_plugin_skills",
            harness="codex",
            source_state="config_parse_error",
            evidence=f"_error:{type(exc).__name__}",
        )]
    plugins = data.get("plugins")
    if not isinstance(plugins, dict):
        return []
    roots: list[SkillRoot] = []
    for plugin_id, config in sorted(plugins.items()):
        if not isinstance(config, dict) or config.get("enabled") is not True:
            continue
        if "@" not in plugin_id:
            continue
        name, marketplace = plugin_id.split("@", 1)
        base = HOME / ".codex/plugins/cache" / marketplace / name
        for skills_dir in sorted(base.glob("*/skills")):
            roots.append(SkillRoot(
                path=skills_dir,
                source_root="codex_enabled_plugin_skills",
                harness="codex",
                source_state="enabled_plugin_candidate",
                evidence="config.toml plugins.*.enabled + plugin cache path",
            ))
    return roots


def default_roots(include_present_only_caches: bool = False) -> list[SkillRoot]:
    roots = [
        SkillRoot(HOME / ".claude/skills", "claude_personal_skills", "claude", "direct_loader_candidate", "direct skill root"),
        SkillRoot(HOME / ".codex/skills", "codex_direct_skills", "codex", "direct_loader_candidate", "direct skill root"),
        SkillRoot(HOME / ".config/opencode/skills", "opencode_direct_skills", "opencode", "direct_loader_candidate", "direct skill root"),
    ]
    roots.extend(enabled_claude_plugin_roots())
    roots.extend(enabled_codex_plugin_roots())
    if include_present_only_caches:
        roots.append(SkillRoot(
            HOME / ".codex/.tmp/plugins/plugins",
            "codex_tmp_plugin_cache_skills",
            "codex",
            "present_only_cache",
            "cache path only; not enabled proof",
        ))
    return dedupe_roots(roots)


def dedupe_roots(roots: list[SkillRoot]) -> list[SkillRoot]:
    out: dict[tuple[Path, str, str], SkillRoot] = {}
    for root in roots:
        out.setdefault((root.path.expanduser(), root.source_root, root.source_state), root)
    return list(out.values())


def skill_paths(root: SkillRoot) -> list[Path]:
    expanded = root.path.expanduser()
    if not expanded.exists() or not expanded.is_dir():
        return []
    return sorted(path for path in expanded.rglob("SKILL.md") if path.is_file())


def broad_term_hits(description: str) -> list[str]:
    lowered = description.lower()
    hits = set()
    for term in BROAD_TERMS:
        if re.search(rf"\b{re.escape(term)}\b", lowered):
            hits.add(term)
    return sorted(hits)


def trigger_breadth(description_chars: int, missing_description: bool, broad_terms: list[str]) -> str:
    if missing_description or description_chars == 0:
        return "broad"
    if description_chars > 600 or len(broad_terms) >= 3:
        return "broad"
    if description_chars > DESCRIPTION_TARGET_CHARS or broad_terms:
        return "medium"
    return "narrow"


def summarize_skill(path: Path, root: SkillRoot) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8", errors="replace")
    frontmatter = parse_frontmatter(text)
    raw_name = frontmatter.get("name") or path.parent.name
    safe_name = redact(raw_name)
    description = frontmatter.get("description") or ""
    terms = broad_term_hits(description)
    skill_dir = path.parent
    return {
        "source_root": root.source_root,
        "harness": root.harness,
        "source_state": root.source_state,
        "evidence": root.evidence,
        "path_sha256_16": sha256_16(str(path)),
        "root_sha256_16": sha256_16(str(root.path.expanduser())),
        "relative_depth": len(path.relative_to(root.path.expanduser()).parts) - 1 if path.is_relative_to(root.path.expanduser()) else None,
        "is_symlink": path.is_symlink(),
        "name": safe_name,
        "name_sha256_16": sha256_16(str(raw_name)),
        "frontmatter_keys": sorted(frontmatter),
        "frontmatter_key_count": len(frontmatter),
        "description_present": bool(description.strip()),
        "description_chars": len(description),
        "description_word_count": len(description.split()),
        "description_sha256_16": sha256_16(description) if description else None,
        "description_over_target": len(description) > DESCRIPTION_TARGET_CHARS,
        "broad_terms": terms,
        "broad_term_count": len(terms),
        "trigger_breadth": trigger_breadth(len(description), not bool(description.strip()), terms),
        "body_bytes": len(text.encode("utf-8", errors="replace")),
        "has_allowed_tools": "allowed-tools" in frontmatter,
        "scripts_file_count": bounded_file_count(skill_dir / "scripts"),
        "references_file_count": bounded_file_count(skill_dir / "references"),
        "assets_file_count": bounded_file_count(skill_dir / "assets"),
    }


def percentile(values: list[int], pct: int) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil((pct / 100) * len(ordered)) - 1))
    return ordered[index]


def build_report(roots: list[SkillRoot] | None = None, include_present_only_caches: bool = False) -> dict[str, Any]:
    roots = roots or default_roots(include_present_only_caches=include_present_only_caches)
    root_rows = []
    rows: list[dict[str, Any]] = []
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
        rows.extend(summarize_skill(path, root) for path in paths)

    name_counts = Counter(str(row.get("name")) for row in rows)
    for row in rows:
        row["duplicate_name_count"] = name_counts[str(row.get("name"))]

    description_lengths = [int(row["description_chars"]) for row in rows]
    source_counts = Counter(str(row["source_root"]) for row in rows)
    state_counts = Counter(str(row["source_state"]) for row in rows)
    breadth_counts = Counter(str(row["trigger_breadth"]) for row in rows)
    over_target = sum(1 for row in rows if row.get("description_over_target"))
    missing_descriptions = sum(1 for row in rows if not row.get("description_present"))
    duplicate_names = sorted(name for name, count in name_counts.items() if count > 1)

    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": (
            "metadata-only skill inventory; emits skill names, frontmatter key names, counts, "
            "description lengths/hashes, broad-term labels, source-root classes, path hashes, "
            "and packaging counts; does not emit raw descriptions, skill bodies, raw paths, "
            "script/reference/asset filenames, transcripts, provider payloads, or secrets"
        ),
        "description_target_chars": DESCRIPTION_TARGET_CHARS,
        "roots": root_rows,
        "summary": {
            "skill_count": len(rows),
            "root_count": len(root_rows),
            "source_root_counts": dict(sorted(source_counts.items())),
            "source_state_counts": dict(sorted(state_counts.items())),
            "trigger_breadth_counts": dict(sorted(breadth_counts.items())),
            "missing_description_count": missing_descriptions,
            "description_over_target_count": over_target,
            "description_chars_p50": percentile(description_lengths, 50),
            "description_chars_p90": percentile(description_lengths, 90),
            "description_chars_p99": percentile(description_lengths, 99),
            "duplicate_name_count": len(duplicate_names),
            "duplicate_name_hashes": [sha256_16(name) for name in duplicate_names],
            "scripts_backed_skill_count": sum(1 for row in rows if row.get("scripts_file_count")),
            "references_backed_skill_count": sum(1 for row in rows if row.get("references_file_count")),
            "assets_backed_skill_count": sum(1 for row in rows if row.get("assets_file_count")),
        },
        "skills": rows,
        "limitations": [
            "Does not prove current-turn model-visible skill list or activation.",
            "Enabled plugin candidates come from local settings/config and plugin cache paths, not runtime init envelopes.",
            "Present-only caches are omitted unless --include-present-only-caches is set.",
            "Broad-trigger scoring is heuristic and should guide review, not auto-disablement.",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inventory local SKILL.md metadata without dumping bodies.")
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
