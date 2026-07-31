#!/usr/bin/env python3
"""Secret-safe inventory of behavior-defining agent config surfaces.

This is an allowlisted control-plane inventory. It intentionally avoids broad
home-directory JSON/YAML scans because caches, transcripts, generated records,
and auth stores look config-like but are not safe configuration inputs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tomllib
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any


HOME = Path.home()


@dataclass(frozen=True)
class SurfaceSpec:
    path: Path
    harness: str
    surface: str
    fmt: str
    loaded_by: str
    edit_posture: str
    risk: str
    redaction_required: bool = True
    active_evidence: str = ""


def expand_specs() -> list[SurfaceSpec]:
    specs: list[SurfaceSpec] = [
        SurfaceSpec(HOME / ".claude/settings.json", "claude", "settings", "json", "Claude Code settings loader", "editable_with_probe", "high", active_evidence="claude settings"),
        SurfaceSpec(HOME / ".claude/settings.local.json", "claude", "settings", "json", "Claude Code local settings loader", "editable_machine_local", "high", active_evidence="claude settings"),
        SurfaceSpec(HOME / ".claude/.mcp.json", "claude", "mcp", "json", "Claude user MCP loader", "editable_with_mcp_probe", "high", active_evidence="claude mcp list"),
        SurfaceSpec(Path("/Library/Application Support/ClaudeCode/managed-settings.d"), "claude", "managed_settings_dropin_dir", "directory", "Claude managed settings drop-in loader", "audit_only", "high", active_evidence="filesystem presence"),
        SurfaceSpec(Path("/Library/Application Support/ClaudeCode/managed-settings.json"), "claude", "managed_settings", "json", "Claude managed settings loader", "audit_only", "high", active_evidence="checked managed path"),
        SurfaceSpec(Path("/Library/Application Support/ClaudeCode/managed-mcp.json"), "claude", "managed_mcp", "json", "Claude managed MCP loader", "audit_only", "high", active_evidence="checked managed path"),
        SurfaceSpec(Path("/etc/claude-code/managed-settings.json"), "claude", "managed_settings", "json", "Claude managed settings loader on Linux/WSL", "audit_only", "high", active_evidence="checked managed path"),
        SurfaceSpec(HOME / ".mcp.json", "claude", "mcp", "json", "Claude project/user MCP candidate", "repair_decision_only", "medium", active_evidence="parse status only"),
        SurfaceSpec(HOME / "AGENTS.md", "shared", "instruction", "markdown", "Codex/OpenCode shared instruction discovery", "editable_budgeted", "medium"),
        SurfaceSpec(HOME / "CLAUDE.md", "shared", "instruction", "markdown", "Claude shared instruction discovery", "editable_budgeted", "medium"),
        SurfaceSpec(HOME / ".claude/CLAUDE.md", "claude", "instruction", "markdown", "Claude memory/instruction loader", "editable_budgeted", "medium"),
        SurfaceSpec(HOME / ".claude/statusline.py", "claude", "statusline_script", "script", "Claude statusLine command", "editable_with_fixture", "medium", active_evidence="settings statusLine.command"),
        SurfaceSpec(HOME / ".claude/context_overhead.py", "claude", "context_budget_estimator", "script", "Local context/cost estimator", "editable_with_unit_probe", "medium"),
        SurfaceSpec(HOME / ".claude/config/secret-patterns.json", "claude", "secret_policy", "json", "Claude secret scanner/scrubber hooks", "editable_with_synthetic_secret_fixture", "high"),
        SurfaceSpec(HOME / ".claude/model-catalog.json", "claude", "model_catalog", "json", "Claude/Codex model refresh hooks", "generated_review_only", "medium"),
        SurfaceSpec(HOME / ".claude/scripts/instruction_audit_config.json", "claude", "hook_policy", "json", "Claude instruction audit hooks", "editable_with_fixture", "medium"),
        SurfaceSpec(HOME / ".claude/plugins/blocklist.json", "claude", "plugin_policy", "json", "Claude plugin installer", "editable_with_plugin_probe", "medium", active_evidence="claude plugin list"),
        SurfaceSpec(HOME / ".claude/plugins/installed_plugins.json", "claude", "plugin_registry", "json", "Claude plugin registry", "generated_review_only", "medium", active_evidence="claude plugin list"),
        SurfaceSpec(HOME / ".claude/plugins/known_marketplaces.json", "claude", "plugin_marketplace_registry", "json", "Claude plugin marketplace registry", "editable_with_plugin_probe", "medium", active_evidence="claude plugin marketplace/list"),
        SurfaceSpec(HOME / ".codex/config.toml", "codex", "settings", "toml", "Codex config loader", "editable_with_probe", "high", active_evidence="codex doctor / codex mcp list"),
        SurfaceSpec(Path("/etc/codex/requirements.toml"), "codex", "managed_requirements", "toml", "Codex managed requirements loader", "audit_only", "high", active_evidence="checked managed path"),
        SurfaceSpec(Path("/Library/Application Support/Codex/requirements.toml"), "codex", "managed_requirements", "toml", "Codex managed requirements loader", "audit_only", "high", active_evidence="checked managed path"),
        SurfaceSpec(HOME / ".codex/hooks.json", "codex", "hooks_legacy", "json", "Codex legacy hook loader", "legacy_review_only", "medium"),
        SurfaceSpec(HOME / ".codex/rules/default.rules", "codex", "policy", "rules", "Codex command policy loader", "editable_with_canary", "high"),
        SurfaceSpec(HOME / ".codex/AGENTS.md", "codex", "instruction", "markdown", "Codex instruction loader", "editable_budgeted", "medium"),
        SurfaceSpec(HOME / ".codex/skills/.claude-skill-sync-manifest.json", "codex", "skill_sync_manifest", "json", "Codex/Claude skill sync process", "generated_review_only", "medium"),
        SurfaceSpec(HOME / ".config/opencode/opencode.json", "opencode", "settings", "json", "OpenCode config merger", "editable_with_schema_probe", "high", active_evidence="opencode mcp list"),
        SurfaceSpec(Path("/Library/Application Support/opencode/opencode.json"), "opencode", "managed_settings", "json", "OpenCode managed config", "audit_only", "high", active_evidence="checked managed path"),
        SurfaceSpec(Path("/Library/Application Support/opencode/opencode.jsonc"), "opencode", "managed_settings", "json", "OpenCode managed config", "audit_only", "high", active_evidence="checked managed path"),
        SurfaceSpec(HOME / ".config/opencode/tui.json", "opencode", "tui", "json", "OpenCode TUI config", "editable_low_risk", "low"),
        SurfaceSpec(HOME / ".config/opencode/package.json", "opencode", "plugin_dependency_manifest", "json", "OpenCode local plugin dependency resolver", "editable_with_supply_chain_review", "high"),
        SurfaceSpec(HOME / ".config/opencode/package-lock.json", "opencode", "plugin_dependency_lock", "json", "OpenCode local plugin dependency resolver", "generated_review_only", "medium"),
        SurfaceSpec(HOME / ".config/opencode/bun.lock", "opencode", "plugin_dependency_lock", "lock", "OpenCode local plugin dependency resolver", "generated_review_only", "medium"),
        SurfaceSpec(HOME / ".claude/plugins/tmup/config/policy.yaml", "tmup", "orchestration_policy", "yaml", "tmup plugin", "editable_with_runtime_doctor", "high"),
        SurfaceSpec(HOME / ".claude/plugins/tmup/config/runtime-contract.json", "tmup", "runtime_contract", "json", "tmup SQLite runtime", "editable_only_with_tests", "high"),
        SurfaceSpec(HOME / "LAB/WhatSoup/src/lib/provider-ids.json", "whatsoup", "provider_roster", "json", "WhatSoup provider registry", "source_edit_with_tests", "medium"),
        SurfaceSpec(HOME / "LAB/WhatSoup/deploy/bot-errors-expected-fleet.json", "whatsoup", "fleet_expected_manifest", "json", "WhatSoup BOT ERRORS expected-fleet monitor", "policy_review", "medium"),
        SurfaceSpec(HOME / "LAB/WhatSoup/deploy/bot-errors-runtime-manifest.json", "whatsoup", "fleet_runtime_manifest", "json", "WhatSoup deploy/runtime protection", "generated_or_policy_review", "medium"),
        SurfaceSpec(HOME / "LAB/WhatSoup/deploy/managed-components.json", "whatsoup", "managed_components", "json", "WhatSoup deploy/runtime protection", "policy_review", "medium"),
        SurfaceSpec(HOME / "LAB/WhatSoup/scripts/service-units-baseline.json", "whatsoup", "service_baseline", "json", "WhatSoup service audit scripts", "policy_review", "medium"),
        SurfaceSpec(HOME / "LAB/WhatSoup/docker-compose.yml", "whatsoup", "service_config", "yaml", "Docker Compose", "editable_with_service_probe", "high"),
        SurfaceSpec(HOME / "LAB/WhatSoup/CLAUDE.md", "whatsoup", "instruction", "markdown", "Claude project instruction loader", "editable_budgeted", "medium"),
        SurfaceSpec(HOME / "LAB/WhatSoup/AGENTS.md", "whatsoup", "instruction", "markdown", "Codex/OpenCode instruction loader", "editable_budgeted", "medium"),
    ]

    for path in sorted((HOME / ".codex").glob("*.config.toml")):
        specs.append(SurfaceSpec(path, "codex", "profile", "toml", "Codex profile overlay", "editable_low_blast_radius", "medium", active_evidence="codex --profile"))

    for path in sorted((HOME / ".claude/hooks").glob("*.py")):
        specs.append(SurfaceSpec(path, "claude", "hook_script", "script", "Claude settings/plugin hook command", "editable_with_hook_fixture", "high"))

    for path in sorted((HOME / ".claude/scripts").glob("*")):
        if path.is_file() and path.suffix in {".py", ".sh"}:
            specs.append(SurfaceSpec(path, "claude", "operator_or_hook_script", "script", "Claude hook/operator script", "editable_with_fixture", "high"))

    for pattern in ("*/hooks/hooks.json", "*/.claude-plugin/hooks/hooks.json"):
        for path in sorted((HOME / ".claude/plugins").glob(pattern)):
            specs.append(SurfaceSpec(path, "claude", "plugin_hook_config", "json", "Claude plugin hook loader", "editable_with_hook_profiler", "high", active_evidence="claude plugin list plus hook event stream"))

    for path in sorted((HOME / ".claude/plugins").glob("*/agents/*.md")):
        specs.append(SurfaceSpec(path, "claude", "plugin_agent", "markdown", "Claude plugin agent loader", "editable_with_agent_probe", "medium", active_evidence="claude agents / plugin list"))

    for path in sorted((HOME / ".claude/plugins").glob("*/commands/*.md")):
        specs.append(SurfaceSpec(path, "claude", "plugin_command", "markdown", "Claude plugin slash-command loader", "editable_with_command_probe", "medium", active_evidence="claude plugin list / slash command list"))

    for path in sorted((HOME / "LAB/WhatSoup/deploy/health-profiles").glob("*.json")):
        specs.append(SurfaceSpec(path, "whatsoup", "fleet_health_profile", "json", "WhatSoup BOT ERRORS health profile", "policy_review", "medium"))

    for path in sorted((HOME / ".codex/agents").glob("*.toml")):
        specs.append(SurfaceSpec(path, "codex", "subagent", "toml", "Codex subagent loader", "editable_with_worker_probe", "medium"))

    for path in sorted((HOME / ".codex/skills").glob("**/SKILL.md")):
        specs.append(SurfaceSpec(path, "codex", "skill", "markdown", "Codex skill loader", "editable_with_skill_lint", "medium"))

    for path in sorted((HOME / ".codex/plugins/cache").glob("*/*/*/.codex-plugin/plugin.json")):
        specs.append(SurfaceSpec(path, "codex", "plugin_manifest", "json", "Codex plugin loader", "cache_or_enabled_review", "medium", active_evidence="codex plugin list"))

    for path in sorted((HOME / ".claude/skills").glob("*/SKILL.md")):
        specs.append(SurfaceSpec(path, "claude", "skill", "markdown", "Claude skill loader", "editable_with_skill_lint", "medium"))

    for path in sorted((HOME / ".claude/plugins").glob("*/.claude-plugin/plugin.json")):
        specs.append(SurfaceSpec(path, "claude", "plugin_manifest", "json", "Claude plugin loader", "editable_with_plugin_probe", "medium", active_evidence="claude plugin list"))

    for path in sorted((HOME / ".config/opencode/agents").glob("*.md")):
        specs.append(SurfaceSpec(path, "opencode", "agent", "markdown", "OpenCode agent loader", "editable_with_agent_probe", "medium", active_evidence="opencode agent list"))

    for path in sorted((HOME / ".config/opencode/instructions").glob("*.md")):
        specs.append(SurfaceSpec(path, "opencode", "instruction", "markdown", "OpenCode instruction loader", "editable_budgeted", "medium"))

    for path in sorted((HOME / ".config/opencode/skills").glob("*/SKILL.md")):
        specs.append(SurfaceSpec(path, "opencode", "skill", "markdown", "OpenCode skill loader", "editable_with_skill_lint", "medium"))

    for path in sorted((HOME / ".config/opencode/themes").glob("*.json")):
        specs.append(SurfaceSpec(path, "opencode", "theme", "json", "OpenCode TUI theme loader", "editable_low_blast_radius", "low", redaction_required=False))

    for path in sorted((HOME / ".config/opencode/scripts").glob("*")):
        if path.is_file():
            specs.append(SurfaceSpec(path, "opencode", "diagnostic_script", "script", "OpenCode operator scripts", "editable_with_dry_run", "medium"))

    for path in sorted((HOME / ".config/opencode/plugins").rglob("*")):
        if path.is_file() and path.suffix in {".js", ".ts", ".json", ".md"}:
            fmt = "markdown" if path.suffix == ".md" else (path.suffix.lstrip(".") or "text")
            specs.append(SurfaceSpec(path, "opencode", "plugin", fmt, "OpenCode plugin loader", "editable_with_plugin_probe", "high"))

    for pattern in ("com.q*.plist", "com.qfleet*.plist", "com.maclab*.plist"):
        for path in sorted((HOME / "Library/LaunchAgents").glob(pattern)):
            specs.append(SurfaceSpec(path, "launchd", "scheduled_service", "plist", "launchd", "audit_only_without_approval", "high"))

    wrapper_names = {
        "google-workspace-mcp",
        "mcp-codex-health",
        "mcp-codex-health-alert",
        "mcp-orphan-reaper",
        "mcp-orphan-sweep",
        "pinecone-mcp",
        "playwright-mcp",
        "reapply-pinecone-mcp-config",
        "render-mcp",
        "revert-pinecone-mcp-config",
        "whatsapp-mcp",
        "with-pinecone-env",
        "sync-pinecone-key-to-settings",
    }
    for name in sorted(wrapper_names):
        specs.append(SurfaceSpec(HOME / ".local/bin" / name, "shared", "wrapper", "script", "shell/launchd/MCP configs", "editable_with_dry_run", "high"))

    dedup: dict[Path, SurfaceSpec] = {}
    for spec in specs:
        dedup.setdefault(spec.path, spec)
    return list(dedup.values())


def file_hash(path: Path) -> tuple[str | None, str | None]:
    try:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        return digest[:16], None
    except OSError as exc:
        return None, type(exc).__name__


def stat_info(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"exists": False}
    st = path.stat()
    digest, hash_error = file_hash(path)
    return {
        "exists": True,
        "bytes": st.st_size,
        "mode": stat.filemode(st.st_mode),
        "mtime": int(st.st_mtime),
        "sha256_16": digest,
        "hash_status": "error" if hash_error else "ok",
        "hash_error_type": hash_error,
    }


def parse_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text())
    if isinstance(data, dict):
        return {"parse_status": "valid", "shape": "object", "top_level_keys": sorted(data.keys()), "top_level_key_count": len(data)}
    if isinstance(data, list):
        return {"parse_status": "valid", "shape": "array", "item_count": len(data), "item_types": sorted({type(item).__name__ for item in data})}
    return {"parse_status": "valid", "shape": type(data).__name__}


def parse_toml(path: Path) -> dict[str, Any]:
    data = tomllib.loads(path.read_text())
    return {"parse_status": "valid", "shape": "object", "top_level_keys": sorted(data.keys()), "top_level_key_count": len(data)}


def parse_plist(path: Path) -> dict[str, Any]:
    proc = subprocess.run(
        ["/usr/bin/plutil", "-convert", "json", "-o", "-", str(path)],
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    if proc.returncode != 0:
        return {
            "parse_status": "invalid",
            "error_type": "plutil",
            "error": (proc.stderr or proc.stdout).strip().splitlines()[0] if (proc.stderr or proc.stdout).strip() else "plutil failed",
        }
    data = json.loads(proc.stdout)
    out: dict[str, Any] = {"parse_status": "valid", "shape": type(data).__name__}
    if isinstance(data, dict):
        out["top_level_keys"] = sorted(data.keys())
        out["top_level_key_count"] = len(data)
        out["label"] = data.get("Label")
        out["argv0"] = data.get("ProgramArguments", [None])[0] if isinstance(data.get("ProgramArguments"), list) else None
        out["argv_count"] = len(data.get("ProgramArguments", [])) if isinstance(data.get("ProgramArguments"), list) else 0
        out["environment_keys"] = sorted((data.get("EnvironmentVariables") or {}).keys()) if isinstance(data.get("EnvironmentVariables"), dict) else []
        out["has_run_at_load"] = "RunAtLoad" in data
        out["has_start_interval"] = "StartInterval" in data
        out["has_start_calendar_interval"] = "StartCalendarInterval" in data
    return out


def parse_markdown(path: Path) -> dict[str, Any]:
    text = path.read_text(errors="replace")
    lines = text.splitlines()
    out: dict[str, Any] = {"parse_status": "text", "line_count": len(lines)}
    if lines and lines[0].strip() == "---":
        keys: list[str] = []
        for line in lines[1:80]:
            if line.strip() == "---":
                break
            match = re.match(r"^([A-Za-z0-9_-]+):", line)
            if match:
                keys.append(match.group(1))
        out["frontmatter_keys"] = sorted(set(keys))
        out["frontmatter_key_count"] = len(set(keys))
    return out


def parse_yaml_keys(path: Path) -> dict[str, Any]:
    keys: list[str] = []
    line_count = 0
    for line in path.read_text(errors="replace").splitlines():
        line_count += 1
        if line.startswith((" ", "\t", "#", "-")):
            continue
        match = re.match(r"^([A-Za-z0-9_.-]+):", line)
        if match:
            keys.append(match.group(1))
    return {"parse_status": "keys_only", "shape": "yaml_text", "top_level_keys": sorted(set(keys)), "top_level_key_count": len(set(keys)), "line_count": line_count}


def parse_script(path: Path) -> dict[str, Any]:
    text = path.read_text(errors="replace")
    lines = text.splitlines()
    shebang = lines[0] if lines and lines[0].startswith("#!") else None
    return {
        "parse_status": "text",
        "line_count": len(lines),
        "shebang": shebang,
        "executable": os.access(path, os.X_OK),
    }


def parse_directory(path: Path) -> dict[str, Any]:
    entries = list(path.iterdir())
    files = [entry for entry in entries if entry.is_file()]
    dirs = [entry for entry in entries if entry.is_dir()]
    return {
        "parse_status": "directory",
        "entry_count": len(entries),
        "file_count": len(files),
        "directory_count": len(dirs),
        "json_file_count": sum(1 for entry in files if entry.suffix == ".json"),
    }


def parse_surface(path: Path, fmt: str) -> dict[str, Any]:
    if not path.exists():
        return {"parse_status": "missing"}
    try:
        if fmt == "json":
            return parse_json(path)
        if fmt == "toml":
            return parse_toml(path)
        if fmt == "plist":
            return parse_plist(path)
        if fmt == "markdown":
            return parse_markdown(path)
        if fmt in {"yaml", "yml"}:
            return parse_yaml_keys(path)
        if fmt in {"script", "rules", "js", "ts", "python", "shell", "lock"}:
            return parse_script(path)
        if fmt == "directory":
            return parse_directory(path)
    except Exception as exc:  # noqa: BLE001 - diagnostic script
        return {"parse_status": "invalid", "error_type": type(exc).__name__, "error": str(exc).splitlines()[0]}
    return {"parse_status": "unparsed"}


def summarize(surfaces: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "surface_count": len(surfaces),
        "existing_count": sum(1 for item in surfaces if item.get("exists")),
        "missing_count": sum(1 for item in surfaces if not item.get("exists")),
        "by_harness": dict(Counter(item["harness"] for item in surfaces)),
        "by_surface": dict(Counter(item["surface"] for item in surfaces)),
        "by_format": dict(Counter(item["format"] for item in surfaces)),
        "by_risk": dict(Counter(item["risk"] for item in surfaces)),
        "by_parse_status": dict(Counter(item.get("parse_status", "unknown") for item in surfaces)),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--include-missing", action="store_true", help="include expected but absent files")
    parser.add_argument("--pretty", action="store_true", help="pretty-print JSON")
    args = parser.parse_args()

    surfaces: list[dict[str, Any]] = []
    for spec in expand_specs():
        info = stat_info(spec.path)
        parsed = parse_surface(spec.path, spec.fmt)
        item = {
            "path": str(spec.path),
            "harness": spec.harness,
            "surface": spec.surface,
            "format": spec.fmt,
            "loaded_by": spec.loaded_by,
            "edit_posture": spec.edit_posture,
            "risk": spec.risk,
            "redaction_required": spec.redaction_required,
            "active_evidence": spec.active_evidence or None,
            **info,
            **parsed,
        }
        if item["exists"] or args.include_missing:
            surfaces.append(item)

    report = {
        "schema": "agent-runtime-config-surface-report",
        "schema_version": "0.1",
        "redaction": "metadata-only; no scalar config values, auth values, raw prompts, transcripts, or provider payloads",
        "allowlist_only": True,
        "summary": summarize(surfaces),
        "surfaces": surfaces,
    }
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
