#!/usr/bin/env python3
"""Metadata-only tmup policy/runtime drift probe.

This compares tmup's local worker policy and agent templates with the current
Codex/OpenCode local config surfaces. It does not launch tmup, touch tmux panes,
read task/message payloads, or call providers.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tomllib
from pathlib import Path
from typing import Any

from probelib import load_json, load_toml, redact, run, sha256_16


SCHEMA = "agent-runtime-tmup-policy-runtime-diff"
SCHEMA_VERSION = "0.1"
HOME = Path.home()
PLUGIN_ROOT = HOME / ".claude/plugins/tmup"
CODEX_ROOT = HOME / ".codex"
OPENCODE_ROOT = HOME / ".config/opencode"

MODEL_TOKEN = re.compile(
    r"\b(?:gpt-\d+(?:\.\d+)?(?:-[a-z0-9]+)?|claude-[a-z0-9-]+|"
    r"(?:minimax|deepseek|openai|anthropic)/[A-Za-z0-9._/-]+)\b",
    re.I,
)
EXCLUDED_MODEL_TOKENS = {"claude-native"}

SELECTED_TMUP_TEXT_FILES = [
    "config/policy.yaml",
    "agents/codex/tmup-tier1.toml",
    "agents/codex/tmup-tier2.toml",
    "scripts/lib/config.sh",
    "scripts/dispatch-agent.sh",
    "commands/tmup.md",
    "skills/tmup/SKILL.md",
    "skills/tmup/REFERENCE.md",
]


def strip_inline_comment(line: str) -> str:
    quote: str | None = None
    escaped = False
    out: list[str] = []
    for ch in line:
        if escaped:
            out.append(ch)
            escaped = False
            continue
        if ch == "\\" and quote:
            out.append(ch)
            escaped = True
            continue
        if ch in ("'", '"'):
            if quote == ch:
                quote = None
            elif quote is None:
                quote = ch
            out.append(ch)
            continue
        if ch == "#" and quote is None:
            break
        out.append(ch)
    return "".join(out).rstrip()


def parse_scalar(value: str) -> Any:
    value = value.strip()
    if not value:
        return None
    if value in {"true", "false"}:
        return value == "true"
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [parse_scalar(part.strip()) for part in inner.split(",")]
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    return value


def parse_simple_yaml(path: Path) -> dict[str, Any]:
    values: dict[str, Any] = {}
    stack: list[tuple[int, str]] = []
    if not path.exists():
        return values
    for raw in path.read_text(errors="replace").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        line = strip_inline_comment(raw)
        if not line.strip():
            continue
        item = re.match(r"^(\s*)-\s+(.+?)\s*$", line)
        if item and stack:
            key = ".".join(k for _, k in stack)
            values.setdefault(key, []).append(parse_scalar(item.group(2)))
            continue
        match = re.match(r"^(\s*)([A-Za-z0-9_-]+):\s*(.*?)\s*$", line)
        if not match:
            continue
        indent = len(match.group(1))
        key = match.group(2)
        rest = match.group(3)
        while stack and stack[-1][0] >= indent:
            stack.pop()
        dotted = ".".join([*(k for _, k in stack), key])
        if rest:
            values[dotted] = parse_scalar(rest)
        else:
            values.setdefault(dotted, [])
            stack.append((indent, key))
    return values


def read_toml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with path.open("rb") as handle:
            data = tomllib.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception as exc:  # diagnostic script
        return {"_error": f"{type(exc).__name__}: {exc}"}


def source_ref(path: Path, root: Path) -> dict[str, Any]:
    try:
        rel = path.relative_to(root).as_posix()
    except ValueError:
        rel = path.name
    text = path.read_text(errors="replace") if path.exists() else ""
    return {
        "relative_path": rel,
        "relative_path_sha256_16": sha256_16(rel),
        "exists": path.exists(),
        "sha256_16": sha256_16(text) if text else None,
        "line_count": len(text.splitlines()) if text else 0,
    }


def summarize_toml_agent(path: Path, root: Path) -> dict[str, Any]:
    data = read_toml(path)
    description = data.get("description") if isinstance(data.get("description"), str) else ""
    instructions = data.get("developer_instructions") if isinstance(data.get("developer_instructions"), str) else ""
    return {
        **source_ref(path, root),
        "name": data.get("name"),
        "model": data.get("model"),
        "model_reasoning_effort": data.get("model_reasoning_effort"),
        "sandbox_mode": data.get("sandbox_mode"),
        "description_bytes": len(description.encode("utf-8")),
        "description_sha256_16": sha256_16(description) if description else None,
        "developer_instruction_bytes": len(instructions.encode("utf-8")),
        "developer_instruction_sha256_16": sha256_16(instructions) if instructions else None,
        "has_developer_instructions": bool(instructions),
        "parse_error": data.get("_error"),
    }


def parse_frontmatter(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    lines = path.read_text(errors="replace").splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    body: list[str] = []
    for line in lines[1:]:
        if line.strip() == "---":
            break
        body.append(line)
    tmp = "\n".join(body)
    fake = Path("__frontmatter__.yaml")
    # Reuse the small parser without writing a temp file.
    values: dict[str, Any] = {}
    stack: list[tuple[int, str]] = []
    for raw in tmp.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        line = strip_inline_comment(raw)
        if not line.strip():
            continue
        item = re.match(r"^(\s*)-\s+(.+?)\s*$", line)
        if item and stack:
            key = ".".join(k for _, k in stack)
            values.setdefault(key, []).append(parse_scalar(item.group(2)))
            continue
        match = re.match(r"^(\s*)([A-Za-z0-9_-]+):\s*(.*?)\s*$", line)
        if not match:
            continue
        indent = len(match.group(1))
        key = match.group(2)
        rest = match.group(3)
        while stack and stack[-1][0] >= indent:
            stack.pop()
        dotted = ".".join([*(k for _, k in stack), key])
        if rest:
            values[dotted] = parse_scalar(rest)
        else:
            values.setdefault(dotted, [])
            stack.append((indent, key))
    values["_source_parser"] = fake.name
    return values


def summarize_opencode_agent(path: Path, root: Path) -> dict[str, Any]:
    fm = parse_frontmatter(path)
    text = path.read_text(errors="replace") if path.exists() else ""
    return {
        **source_ref(path, root),
        "agent_id": path.stem,
        "mode": fm.get("mode"),
        "permission_edit": fm.get("permission.edit"),
        "permission_bash": fm.get("permission.bash"),
        "has_model_pin": "model" in fm,
        "description_bytes": len(str(fm.get("description", "")).encode("utf-8")),
        "description_sha256_16": sha256_16(str(fm.get("description", ""))) if fm.get("description") else None,
        "body_bytes": len(text.encode("utf-8")),
        "body_sha256_16": sha256_16(text) if text else None,
    }


def summarize_codex_config(codex_root: Path) -> dict[str, Any]:
    base = load_toml(codex_root / "config.toml") or {}
    profiles: dict[str, Any] = {}
    for path in sorted(codex_root.glob("*.config.toml")):
        data = load_toml(path) or {}
        profiles[path.stem.replace(".config", "")] = {
            "model": data.get("model"),
            "model_reasoning_effort": data.get("model_reasoning_effort"),
            "sandbox_mode": data.get("sandbox_mode"),
            "keys": sorted(k for k in data.keys() if not k.startswith("_")),
            "path_sha256_16": sha256_16(path.name),
        }
    agents = [
        summarize_toml_agent(path, codex_root)
        for path in sorted((codex_root / "agents").glob("tmup-tier*.toml"))
    ] if (codex_root / "agents").exists() else []
    migrations = base.get("notice", {}).get("model_migrations", {}) if isinstance(base.get("notice"), dict) else {}
    return {
        "config": source_ref(codex_root / "config.toml", codex_root),
        "base": {
            "model": base.get("model"),
            "model_reasoning_effort": base.get("model_reasoning_effort"),
            "model_reasoning_summary": base.get("model_reasoning_summary"),
            "model_verbosity": base.get("model_verbosity"),
            "approval_policy": base.get("approval_policy"),
            "sandbox_mode": base.get("sandbox_mode"),
            "model_context_window": base.get("model_context_window"),
            "model_auto_compact_token_limit": base.get("model_auto_compact_token_limit"),
            "tool_output_token_limit": base.get("tool_output_token_limit"),
            "web_search": base.get("web_search"),
        },
        "agents_config": base.get("agents", {}) if isinstance(base.get("agents"), dict) else {},
        "model_migrations": migrations,
        "profiles": profiles,
        "tmup_agents": agents,
    }


def summarize_opencode_config(opencode_root: Path) -> dict[str, Any]:
    data = load_json(opencode_root / "opencode.json") or {}
    mcp = data.get("mcp") if isinstance(data.get("mcp"), dict) else {}
    plugins = data.get("plugin") if isinstance(data.get("plugin"), list) else []
    agents = [
        summarize_opencode_agent(path, opencode_root)
        for path in sorted((opencode_root / "agents").glob("tmup-tier*.md"))
    ] if (opencode_root / "agents").exists() else []
    return {
        "config": source_ref(opencode_root / "opencode.json", opencode_root),
        "model": data.get("model"),
        "small_model": data.get("small_model"),
        "default_agent": data.get("default_agent"),
        "mcp_count": len(mcp),
        "mcp_names": sorted(mcp.keys()),
        "plugin_count": len(plugins),
        "plugin_names": sorted(str(item) for item in plugins),
        "tmup_agents": agents,
    }


def summarize_tmup_policy(plugin_root: Path) -> dict[str, Any]:
    policy_path = plugin_root / "config/policy.yaml"
    values = parse_simple_yaml(policy_path)
    plugin_agents = [
        summarize_toml_agent(path, plugin_root)
        for path in sorted((plugin_root / "agents/codex").glob("tmup-tier*.toml"))
    ] if (plugin_root / "agents/codex").exists() else []
    return {
        "policy": source_ref(policy_path, plugin_root),
        "values": {
            "codex.model": values.get("codex.model"),
            "codex.model_preference": values.get("codex.model_preference"),
            "codex.context_window": values.get("codex.context_window"),
            "codex.auto_compact_token_limit": values.get("codex.auto_compact_token_limit"),
            "codex.approval_policy": values.get("codex.approval_policy"),
            "codex.sandbox": values.get("codex.sandbox"),
            "codex.reasoning_effort": values.get("codex.reasoning_effort"),
            "codex.reasoning_summary": values.get("codex.reasoning_summary"),
            "codex.plan_mode_reasoning_effort": values.get("codex.plan_mode_reasoning_effort"),
            "codex.verbosity": values.get("codex.verbosity"),
            "codex.service_tier": values.get("codex.service_tier"),
            "codex.tool_output_token_limit": values.get("codex.tool_output_token_limit"),
            "codex.web_search": values.get("codex.web_search"),
            "codex.history_persistence": values.get("codex.history_persistence"),
            "codex.shell_env_inherit": values.get("codex.shell_env_inherit"),
            "codex.shell_snapshot": values.get("codex.shell_snapshot"),
            "codex.enable_request_compression": values.get("codex.enable_request_compression"),
            "codex.background_terminal_max_timeout": values.get("codex.background_terminal_max_timeout"),
            "codex.subagents.max_threads": values.get("codex.subagents.max_threads"),
            "codex.subagents.max_depth": values.get("codex.subagents.max_depth"),
            "codex.subagents.job_max_runtime_seconds": values.get("codex.subagents.job_max_runtime_seconds"),
        },
        "plugin_codex_agents": plugin_agents,
    }


def model_mentions(plugin_root: Path) -> dict[str, Any]:
    totals: dict[str, int] = {}
    files: list[dict[str, Any]] = []
    for rel in SELECTED_TMUP_TEXT_FILES:
        path = plugin_root / rel
        if not path.exists():
            files.append({"relative_path": rel, "exists": False})
            continue
        per_file: dict[str, Any] = {}
        for line_no, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
            for token in MODEL_TOKEN.findall(line):
                normalized = token.lower()
                if normalized in EXCLUDED_MODEL_TOKENS:
                    continue
                totals[normalized] = totals.get(normalized, 0) + 1
                entry = per_file.setdefault(normalized, {"count": 0, "line_numbers": [], "line_hashes": []})
                entry["count"] += 1
                entry["line_numbers"].append(line_no)
                entry["line_hashes"].append(sha256_16(line))
        files.append({
            **source_ref(path, plugin_root),
            "model_mentions": per_file,
        })
    return {"totals": dict(sorted(totals.items())), "files": files}


def executable_versions(skip: bool) -> dict[str, Any]:
    if skip:
        return {
            "skipped": True,
            "codex": {"present": None},
            "opencode": {"present": None},
            "yq": {"present": shutil.which("yq") is not None},
        }
    versions: dict[str, Any] = {"skipped": False}
    for name in ("codex", "opencode"):
        present = shutil.which(name) is not None
        info: dict[str, Any] = {"present": present}
        if present:
            result = run([name, "--version"], timeout=10)
            output = str(result.get("stdout") or result.get("stderr") or "")
            info.update({
                "rc": result.get("rc"),
                "version_text": output[:120],
                "version_text_sha256_16": sha256_16(output),
            })
        versions[name] = info
    versions["yq"] = {"present": shutil.which("yq") is not None}
    return versions


def compare_scalar(findings: list[dict[str, Any]], key: str, tmup_value: Any, codex_key: str, codex_value: Any) -> None:
    if tmup_value is None or codex_value is None:
        return
    if tmup_value == codex_value:
        findings.append({
            "kind": f"{key}_matches_codex_base",
            "severity": "ok",
            "tmup_field": key,
            "codex_field": codex_key,
        })
    else:
        findings.append({
            "kind": f"{key}_tmup_override_or_drift",
            "severity": "info",
            "tmup_field": key,
            "codex_field": codex_key,
            "tmup_value": tmup_value,
            "codex_value": codex_value,
        })


def build_findings(tmup: dict[str, Any], codex: dict[str, Any], opencode: dict[str, Any], mentions: dict[str, Any], yq_present: bool | None) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    tmup_values = tmup["values"]
    codex_base = codex["base"]
    codex_model = codex_base.get("model")
    policy_model = tmup_values.get("codex.model")
    if policy_model == "auto" and codex_model:
        findings.append({
            "kind": "policy_model_auto_tracks_codex_config",
            "severity": "ok",
            "tmup_field": "codex.model",
            "codex_field": "model",
            "effective_model": codex_model,
        })
    elif policy_model and codex_model and policy_model != codex_model:
        findings.append({
            "kind": "policy_model_pin_differs_from_codex_base",
            "severity": "warn",
            "tmup_field": "codex.model",
            "codex_field": "model",
            "tmup_value": policy_model,
            "codex_value": codex_model,
        })
    preferences = tmup_values.get("codex.model_preference") or []
    if isinstance(preferences, list) and codex_model in preferences:
        findings.append({
            "kind": "policy_model_preference_contains_codex_base",
            "severity": "ok",
            "preference_count": len(preferences),
        })
    compare_scalar(findings, "codex.context_window", tmup_values.get("codex.context_window"), "model_context_window", codex_base.get("model_context_window"))
    compare_scalar(findings, "codex.auto_compact_token_limit", tmup_values.get("codex.auto_compact_token_limit"), "model_auto_compact_token_limit", codex_base.get("model_auto_compact_token_limit"))
    compare_scalar(findings, "codex.approval_policy", tmup_values.get("codex.approval_policy"), "approval_policy", codex_base.get("approval_policy"))
    compare_scalar(findings, "codex.sandbox", tmup_values.get("codex.sandbox"), "sandbox_mode", codex_base.get("sandbox_mode"))
    compare_scalar(findings, "codex.reasoning_effort", tmup_values.get("codex.reasoning_effort"), "model_reasoning_effort", codex_base.get("model_reasoning_effort"))
    compare_scalar(findings, "codex.tool_output_token_limit", tmup_values.get("codex.tool_output_token_limit"), "tool_output_token_limit", codex_base.get("tool_output_token_limit"))
    compare_scalar(findings, "codex.web_search", tmup_values.get("codex.web_search"), "web_search", codex_base.get("web_search"))
    agents_cfg = codex.get("agents_config", {})
    compare_scalar(findings, "codex.subagents.max_threads", tmup_values.get("codex.subagents.max_threads"), "agents.max_threads", agents_cfg.get("max_threads"))
    compare_scalar(findings, "codex.subagents.max_depth", tmup_values.get("codex.subagents.max_depth"), "agents.max_depth", agents_cfg.get("max_depth"))
    compare_scalar(findings, "codex.subagents.job_max_runtime_seconds", tmup_values.get("codex.subagents.job_max_runtime_seconds"), "agents.job_max_runtime_seconds", agents_cfg.get("job_max_runtime_seconds"))

    installed_by_name = {agent.get("name"): agent for agent in codex.get("tmup_agents", []) if agent.get("name")}
    mismatches: list[dict[str, Any]] = []
    legacy_models: set[str] = set()
    migrations = codex.get("model_migrations", {})
    for source_agent in tmup.get("plugin_codex_agents", []):
        name = source_agent.get("name")
        source_model = source_agent.get("model")
        installed_model = installed_by_name.get(name, {}).get("model")
        if source_model and source_model != codex_model:
            legacy_models.add(str(source_model))
        if installed_model and source_model != installed_model:
            mismatches.append({
                "name": name,
                "plugin_model": source_model,
                "installed_model": installed_model,
                "migration_target": migrations.get(source_model),
            })
    if mismatches:
        findings.append({
            "kind": "plugin_codex_agent_model_mismatch_with_installed_agents",
            "severity": "warn",
            "count": len(mismatches),
            "rows": mismatches,
        })
    installed_align = [
        agent.get("name") for agent in codex.get("tmup_agents", [])
        if agent.get("model") == codex_model and codex_model
    ]
    if installed_align:
        findings.append({
            "kind": "installed_codex_tmup_agents_align_current_base_model",
            "severity": "ok",
            "count": len(installed_align),
            "agent_names": sorted(installed_align),
        })
    if legacy_models:
        findings.append({
            "kind": "plugin_codex_agent_legacy_model_mentions",
            "severity": "warn",
            "models": sorted(legacy_models),
            "mapped_by_codex_migration_notice": sorted(m for m in legacy_models if m in migrations),
            "unmapped_by_codex_migration_notice": sorted(m for m in legacy_models if m not in migrations),
        })
    mention_totals = mentions.get("totals", {})
    legacy_doc_models = sorted(
        model for model in mention_totals
        if model.startswith("gpt-") and codex_model and model != str(codex_model).lower()
    )
    if legacy_doc_models:
        findings.append({
            "kind": "tmup_selected_files_legacy_model_mentions",
            "severity": "info",
            "models": legacy_doc_models,
            "mention_counts": {model: mention_totals[model] for model in legacy_doc_models},
        })
    opencode_tmup_agents = opencode.get("tmup_agents", [])
    if opencode_tmup_agents:
        findings.append({
            "kind": "opencode_tmup_agents_present",
            "severity": "info",
            "count": len(opencode_tmup_agents),
            "model_pin_count": len([agent for agent in opencode_tmup_agents if agent.get("has_model_pin")]),
            "permission_pairs": sorted({
                f"edit={agent.get('permission_edit')},bash={agent.get('permission_bash')}"
                for agent in opencode_tmup_agents
            }),
        })
    findings.append({
        "kind": "tmup_policy_yaml_loader_state",
        "severity": "ok" if yq_present else "warn",
        "yq_present": yq_present,
        "note": "scripts/lib/config.sh falls back to built-in defaults if yq is unavailable",
    })
    return findings


def build_report(plugin_root: Path, codex_root: Path, opencode_root: Path, skip_versions: bool) -> dict[str, Any]:
    tmup = summarize_tmup_policy(plugin_root)
    codex = summarize_codex_config(codex_root)
    opencode = summarize_opencode_config(opencode_root)
    mentions = model_mentions(plugin_root)
    versions = executable_versions(skip_versions)
    findings = build_findings(tmup, codex, opencode, mentions, versions.get("yq", {}).get("present"))
    report = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; suppresses raw instructions, prompts, task/message payloads, command bodies, environment values, absolute paths, and provider payloads",
        "proof_class": "static-local-config-policy-diff",
        "sources": {
            "tmup_plugin_root_sha256_16": sha256_16(str(plugin_root.expanduser())),
            "codex_root_sha256_16": sha256_16(str(codex_root.expanduser())),
            "opencode_root_sha256_16": sha256_16(str(opencode_root.expanduser())),
        },
        "runtime_commands": versions,
        "tmup": tmup,
        "codex": codex,
        "opencode": opencode,
        "tmup_selected_file_model_mentions": mentions,
        "findings": findings,
        "verdict": {
            "status": "tmup-policy-runtime-diff-landed",
            "remaining_gap": "does not launch tmup workers, execute hooks, inspect tmux panes, call providers, or prove live worker behavior",
        },
    }
    return redact(report)


def main() -> int:
    parser = argparse.ArgumentParser(description="Emit metadata-only tmup policy/runtime drift report.")
    parser.add_argument("--plugin-root", type=Path, default=PLUGIN_ROOT)
    parser.add_argument("--codex-root", type=Path, default=CODEX_ROOT)
    parser.add_argument("--opencode-root", type=Path, default=OPENCODE_ROOT)
    parser.add_argument("--skip-version-commands", action="store_true")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    report = build_report(
        args.plugin_root.expanduser(),
        args.codex_root.expanduser(),
        args.opencode_root.expanduser(),
        args.skip_version_commands,
    )
    try:
        json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
        sys.stdout.write("\n")
    except BrokenPipeError:
        try:
            sys.stdout.close()
        except OSError:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
