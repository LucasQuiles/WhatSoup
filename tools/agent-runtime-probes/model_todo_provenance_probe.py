#!/usr/bin/env python3
"""Metadata-only provenance probe for model and Todo/Task claims.

This probe exists to prevent two recurring research mistakes:

1. Treating Claude `fallbackModel` config as proof of the current primary model.
2. Treating historical TodoWrite / Task* transcript notes as product/version facts.

Default mode reads selected local config and reference docs only. Optional artifact
or Codex-session modes parse caller-selected JSON/JSONL records into tool names and
channels only. The probe never prints transcript text, provider payloads, tool
inputs, or tool outputs.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from probelib import load_json, load_toml, redact, run, sha256_16 as sha16_text


SCHEMA = "agent-runtime-model-todo-provenance"
SCHEMA_VERSION = "0.3"
HOME = Path.home()

DEFAULT_DOC_PATHS = [
    HOME / "AGENT-RUNTIME-00-RUNNER.md",
    HOME / "AGENT-RUNTIME-CURRENT-STATE.md",
    HOME / "AGENT-RUNTIME-VALIDATION-GAPS.md",
    HOME / "AGENT-RUNTIME-TOPOLOGY.md",
    HOME / "AGENT-RUNTIME-MECHANISMS.md",
    HOME / "AGENT-RUNTIME-AUDIT-FINDINGS-2026-06-14.md",
    HOME / "AGENT-RUNTIME-GOALS.md",
]

DEFAULT_CLAUDE_REFERENCE = (
    HOME
    / ".claude/plugins/cache/superpowers-marketplace/superpowers-developing-for-claude-code"
    / "0.3.1/skills/working-with-claude-code/references/settings.md"
)

CLAIM_PATTERNS = {
    "fable": re.compile(r"\bfable\b|claude-fable", re.I),
    "opus_4_8": re.compile(r"opus-4-8|claude-opus-4-8", re.I),
    "fallback_model": re.compile(r"fallbackModel|fallback model", re.I),
    "primary_model": re.compile(r"primary model|current primary|default model", re.I),
    "todowrite": re.compile(r"\bTodoWrite\b", re.I),
    "task_family": re.compile(r"\bTask(Create|Update|List|Get|Output)\b"),
    "version_2_1_142": re.compile(r"\bv?2\.1\.142\b"),
    "disabled_default": re.compile(r"disabled by default|officially disabled|disabled as of", re.I),
}

TOOL_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.:\-]{0,96}$")
SCHEMA_LIST_KEYS = {"tools", "tool_schemas", "available_tools", "functions"}
SEARCH_RESULT_KEYS = {"results", "matches", "deferred_tools", "search_results"}
TASK_TOOL_NAMES = ("Task", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop")


def safe_tool_name(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if not candidate or "/" in candidate or "@" in candidate:
        return None
    return candidate if TOOL_NAME.match(candidate) else None


def value_kind(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def safe_model_list(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def add_tool_name(channels: dict[str, set[str]], channel: str, value: Any) -> None:
    name = safe_tool_name(value)
    if name:
        channels.setdefault(channel, set()).add(name)


def extract_schema_name(item: Any) -> str | None:
    if isinstance(item, str):
        return safe_tool_name(item)
    if not isinstance(item, dict):
        return None
    direct = safe_tool_name(item.get("name")) or safe_tool_name(item.get("tool_name"))
    if direct:
        return direct
    function = item.get("function")
    if isinstance(function, dict):
        return safe_tool_name(function.get("name"))
    return None


def collect_tool_names(value: Any, channels: dict[str, set[str]], parent_key: str = "") -> None:
    if isinstance(value, list):
        lowered_parent = parent_key.lower()
        if lowered_parent in SCHEMA_LIST_KEYS:
            for item in value:
                add_tool_name(channels, "active_schema_or_request_tool", extract_schema_name(item))
        elif lowered_parent in SEARCH_RESULT_KEYS:
            for item in value:
                add_tool_name(channels, "deferred_or_search_result", extract_schema_name(item))
        for item in value:
            collect_tool_names(item, channels, parent_key)
        return

    if not isinstance(value, dict):
        return

    event_type = str(value.get("type") or value.get("event") or "").lower()
    if "tool_use" in event_type or "tool_call" in event_type or event_type == "function_call":
        add_tool_name(channels, "tool_use_event", value.get("name"))
        add_tool_name(channels, "tool_use_event", value.get("tool_name"))
        function = value.get("function")
        if isinstance(function, dict):
            add_tool_name(channels, "tool_use_event", function.get("name"))
    elif "tool_result" in event_type:
        add_tool_name(channels, "tool_result_event", value.get("name"))
        add_tool_name(channels, "tool_result_event", value.get("tool_name"))

    for key, item in value.items():
        lowered_key = key.lower()
        if lowered_key in SCHEMA_LIST_KEYS and isinstance(item, list):
            for schema_item in item:
                add_tool_name(channels, "active_schema_or_request_tool", extract_schema_name(schema_item))
        elif lowered_key in SEARCH_RESULT_KEYS and isinstance(item, list):
            for result_item in item:
                add_tool_name(channels, "deferred_or_search_result", extract_schema_name(result_item))
        elif lowered_key in {"tool", "tool_use", "tooluse", "tool_call", "toolcall"}:
            add_tool_name(channels, "tool_use_event", extract_schema_name(item))
        collect_tool_names(item, channels, key)


def parse_artifact_objects(text: str) -> tuple[list[Any], int, str]:
    document_error_type: str | None = None
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed, 0, "json-list"
        return [parsed], 0, "json-object"
    except json.JSONDecodeError as exc:
        document_error_type = type(exc).__name__

    objects: list[Any] = []
    errors = 0
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            objects.append(json.loads(stripped))
        except json.JSONDecodeError:
            errors += 1
    mode = "jsonl-after-json-error" if document_error_type else "jsonl"
    return objects, errors, mode


def target_matches(name: str) -> list[str]:
    lowered = name.lower()
    matches: list[str] = []
    if name == "TodoWrite":
        matches.append("TodoWrite")
    if name in TASK_TOOL_NAMES:
        matches.append("Task_family")
    if "tmup" in lowered and "task" in lowered:
        matches.append("tmup_task_tools")
    if name in {"update_plan", "functions.update_plan"} or lowered.endswith(".update_plan"):
        matches.append("codex_update_plan")
    if name in {"ToolSearch", "tool_search", "tool_search_tool"}:
        matches.append("tool_search")
    return matches


def normalize_mcp_server_name(name: str) -> str:
    return name.strip().lower().replace("_", "-")


def mcp_server_from_tool_name(name: str) -> str | None:
    if not name.startswith("mcp__"):
        return None
    remainder = name[len("mcp__"):]
    if not remainder:
        return None
    return normalize_mcp_server_name(remainder.split("__", 1)[0])


def summarize_target_matrix(channels: dict[str, set[str]]) -> dict[str, Any]:
    matrix: dict[str, dict[str, Any]] = {
        "TodoWrite": {"observed_channels": set(), "observed_names": set()},
        "Task_family": {"observed_channels": set(), "observed_names": set()},
        "tmup_task_tools": {"observed_channels": set(), "observed_names": set()},
        "codex_update_plan": {"observed_channels": set(), "observed_names": set()},
        "tool_search": {"observed_channels": set(), "observed_names": set()},
    }
    for channel, names in channels.items():
        for name in names:
            for target in target_matches(name):
                matrix[target]["observed_channels"].add(channel)
                matrix[target]["observed_names"].add(name)
    return {
        target: {
            "status": "observed" if row["observed_names"] else "not_observed_in_artifact",
            "observed_channels": sorted(row["observed_channels"]),
            "observed_names": sorted(row["observed_names"]),
        }
        for target, row in matrix.items()
    }


def configured_codex_mcp_servers(config: dict[str, Any]) -> list[str]:
    servers = config.get("mcp_servers") if isinstance(config, dict) else None
    if not isinstance(servers, dict):
        return []
    return sorted(normalize_mcp_server_name(name) for name in servers if isinstance(name, str))


def reconcile_mcp_tool_names(tool_scan: dict[str, Any], codex_config: dict[str, Any]) -> dict[str, Any]:
    configured = configured_codex_mcp_servers(codex_config)
    if tool_scan.get("status") != "parsed":
        return {
            "status": "not_provided",
            "proof_class": "not_run",
            "configured_codex_mcp_servers": configured,
            "verdict": "requires-tool-artifact",
            "limitation": "no tool artifact or latest Codex session was parsed",
        }

    observed_by_channel: dict[str, set[str]] = {}
    observed_tool_names: set[str] = set()
    for artifact in tool_scan.get("artifacts", []):
        channels = artifact.get("channels") if isinstance(artifact, dict) else None
        if not isinstance(channels, dict):
            continue
        for channel, names in channels.items():
            if not isinstance(names, list):
                continue
            for name in names:
                if not isinstance(name, str):
                    continue
                server = mcp_server_from_tool_name(name)
                if server is None:
                    continue
                observed_by_channel.setdefault(channel, set()).add(server)
                observed_tool_names.add(name)

    observed = sorted({server for servers in observed_by_channel.values() for server in servers})
    configured_set = set(configured)
    observed_set = set(observed)
    unconfigured = sorted(observed_set - configured_set)
    matched = sorted(observed_set & configured_set)
    configured_not_observed = sorted(configured_set - observed_set)

    if unconfigured:
        verdict = "recorded-mcp-tool-not-in-current-codex-config"
    elif observed:
        verdict = "recorded-mcp-tools-match-current-codex-config"
    else:
        verdict = "no-recorded-mcp-tool-names"

    return {
        "status": "compared",
        "proof_class": "recorded_tool_names_vs_static_codex_config",
        "configured_codex_mcp_servers": configured,
        "observed_mcp_servers": observed,
        "observed_mcp_tool_name_count": len(observed_tool_names),
        "observed_mcp_tool_names": sorted(observed_tool_names),
        "observed_mcp_servers_by_channel": {key: sorted(values) for key, values in sorted(observed_by_channel.items())},
        "matched_observed_servers": matched,
        "unconfigured_observed_servers": unconfigured,
        "configured_not_observed_servers": configured_not_observed,
        "verdict": verdict,
        "limitation": "recorded session/artifact tool names are not a complete active tool table; configured_not_observed is non-absence",
    }


def tool_artifact_summary(path: Path) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "path_sha256_16": sha16_text(str(path)),
        "path_suffix": path.suffix,
        "exists": path.exists(),
        "parse_status": "not-read",
    }
    if not path.exists():
        summary["parse_status"] = "missing"
        return summary
    try:
        text = path.read_text(errors="replace")
    except OSError as exc:
        summary["parse_status"] = "read-error"
        summary["error_class"] = type(exc).__name__
        return summary

    objects, parse_errors, parse_mode = parse_artifact_objects(text)
    channels: dict[str, set[str]] = {}
    for obj in objects:
        collect_tool_names(obj, channels)
    channel_names = {key: sorted(values) for key, values in sorted(channels.items())}
    all_names = sorted({name for names in channels.values() for name in names})

    summary.update(
        {
            "parse_status": "ok" if objects else "no-json-objects",
            "parse_mode": parse_mode,
            "input_bytes": len(text.encode("utf-8", errors="replace")),
            "json_object_count": len(objects),
            "json_parse_error_count": parse_errors,
            "tool_name_count": len(all_names),
            "tool_names": all_names,
            "channels": channel_names,
            "channel_counts": {key: len(values) for key, values in channel_names.items()},
            "target_matrix": summarize_target_matrix(channels),
        }
    )
    return summary


def latest_codex_session_path(root: Path) -> Path | None:
    if not root.exists():
        return None
    candidates = [path for path in root.glob("**/*.jsonl") if path.is_file()]
    if not candidates:
        return None
    return max(candidates, key=lambda path: (path.stat().st_mtime, str(path)))


def aggregate_tool_artifacts(paths: list[Path], source_classes: dict[Path, str] | None = None) -> dict[str, Any]:
    if not paths:
        return {
            "status": "not_provided",
            "verdict": "current-turn TodoWrite/Task* callability remains unprobed",
            "artifact_assumption": "provide --tool-artifact with a controlled init/tool-table capture to classify observed tool names",
        }
    source_classes = source_classes or {}
    artifacts = []
    for path in paths:
        artifact = tool_artifact_summary(path)
        artifact["source_class"] = source_classes.get(path, "caller_supplied_artifact")
        artifacts.append(artifact)
    aggregate_channels: dict[str, set[str]] = {}
    for artifact in artifacts:
        channels = artifact.get("channels")
        if isinstance(channels, dict):
            for channel, names in channels.items():
                if isinstance(names, list):
                    for name in names:
                        add_tool_name(aggregate_channels, channel, name)
    return {
        "status": "parsed",
        "artifact_count": len(artifacts),
        "artifacts": artifacts,
        "aggregate_target_matrix": summarize_target_matrix(aggregate_channels),
        "artifact_assumption": "non-observation is not absence unless the supplied capture is known to be a complete active tool table; Codex session JSONL proves executed/recorded events only",
    }


def command_summary(binary: str) -> dict[str, Any]:
    return redact(run([binary, "--version"], timeout=10))


def claude_settings_summary(path: Path) -> dict[str, Any]:
    data = load_json(path)
    if not isinstance(data, dict):
        return {"path": str(path), "exists": path.exists(), "parse_status": "not-object-or-missing"}

    model_present = "model" in data
    model_value = data.get("model")
    fallback_values = safe_model_list(data.get("fallbackModel"))
    model_is_set = isinstance(model_value, str) and bool(model_value.strip())
    verdict = "primary-model-configured"
    if not model_is_set and fallback_values:
        verdict = "fallback-only-static-config-primary-unproven"
    elif not model_is_set:
        verdict = "no-static-primary-model-config-found"

    return {
        "path": str(path),
        "exists": True,
        "parse_status": "ok",
        "settings_key_count": len(data),
        "model_field_present": model_present,
        "model_value_kind": value_kind(model_value) if model_present else "missing",
        "model_value": model_value if model_is_set else None,
        "fallbackModel_present": "fallbackModel" in data,
        "fallbackModel_count": len(fallback_values),
        "fallbackModel_values": fallback_values,
        "verdict": verdict,
    }


def codex_config_summary(path: Path, profile_paths: list[Path]) -> dict[str, Any]:
    config = load_toml(path)
    profiles: dict[str, Any] = {}
    for profile_path in profile_paths:
        parsed = load_toml(profile_path)
        if isinstance(parsed, dict):
            profiles[profile_path.name] = {
                key: parsed.get(key)
                for key in ("model", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity")
                if key in parsed
            }
        else:
            profiles[profile_path.name] = {"exists": profile_path.exists(), "parse_status": "not-object-or-missing"}

    if not isinstance(config, dict):
        return {
            "path": str(path),
            "exists": path.exists(),
            "parse_status": "not-object-or-missing",
            "profiles": redact(profiles),
        }

    return {
        "path": str(path),
        "exists": True,
        "parse_status": "ok",
        "model": config.get("model"),
        "model_reasoning_effort": config.get("model_reasoning_effort"),
        "model_reasoning_summary": config.get("model_reasoning_summary"),
        "model_verbosity": config.get("model_verbosity"),
        "model_context_window": config.get("model_context_window"),
        "model_auto_compact_token_limit": config.get("model_auto_compact_token_limit"),
        "tool_output_token_limit": config.get("tool_output_token_limit"),
        "mcp_server_count": len(configured_codex_mcp_servers(config)),
        "mcp_server_names": configured_codex_mcp_servers(config),
        "profiles": redact(profiles),
    }


def matching_terms(line: str) -> list[str]:
    return [name for name, pattern in CLAIM_PATTERNS.items() if pattern.search(line)]


def scan_text_file(path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "path": str(path),
        "exists": path.exists(),
        "matches": [],
        "term_counts": {name: 0 for name in CLAIM_PATTERNS},
    }
    if not path.exists():
        return result
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
        return result
    for lineno, line in enumerate(lines, start=1):
        terms = matching_terms(line)
        if not terms:
            continue
        for term in terms:
            result["term_counts"][term] += 1
        result["matches"].append(
            {
                "line": lineno,
                "terms": terms,
                "line_sha256_16": sha16_text(line),
            }
        )
    result["match_count"] = len(result["matches"])
    return result


def aggregate_counts(scans: list[dict[str, Any]]) -> dict[str, int]:
    aggregate = {name: 0 for name in CLAIM_PATTERNS}
    for scan in scans:
        counts = scan.get("term_counts")
        if isinstance(counts, dict):
            for key in aggregate:
                aggregate[key] += int(counts.get(key) or 0)
    return aggregate


def task_tool_reference_summary(path: Path) -> dict[str, Any]:
    scan = scan_text_file(path)
    counts = scan.get("term_counts") if isinstance(scan.get("term_counts"), dict) else {}
    return {
        "path": str(path),
        "exists": path.exists(),
        "todowrite_refs": int(counts.get("todowrite") or 0),
        "task_family_refs": int(counts.get("task_family") or 0),
        "matches": scan.get("matches", []),
        "verdict": "local-reference-lists-todowrite-taxonomy-not-session-callability"
        if int(counts.get("todowrite") or 0) > 0 else "no-local-reference-todowrite-hit",
    }


def artifact_target(tool_scan: dict[str, Any], target: str) -> dict[str, Any] | None:
    matrix = tool_scan.get("aggregate_target_matrix")
    if not isinstance(matrix, dict):
        return None
    row = matrix.get(target)
    return row if isinstance(row, dict) else None


def tool_callability_verdict(tool_scan: dict[str, Any], target: str) -> dict[str, Any]:
    if tool_scan.get("status") != "parsed":
        return {
            "verdict": "not-probed",
            "reason": "requires current init/tool table or controlled ToolSearch/runtime envelope",
        }
    row = artifact_target(tool_scan, target)
    if row and row.get("status") == "observed":
        return {
            "verdict": "observed-in-supplied-artifact",
            "observed_channels": row.get("observed_channels", []),
            "observed_names": row.get("observed_names", []),
            "reason": "caller-supplied artifact contained matching tool names; source/origin class still depends on channel and artifact provenance",
        }
    return {
        "verdict": "not-observed-in-supplied-artifact",
        "reason": "non-observation is not absence unless the supplied artifact is known to be a complete active tool table",
    }


def claim_verdicts(
    claude: dict[str, Any],
    doc_counts: dict[str, int],
    reference: dict[str, Any],
    tool_scan: dict[str, Any],
) -> dict[str, Any]:
    fallback_values = claude.get("fallbackModel_values") if isinstance(claude.get("fallbackModel_values"), list) else []
    model_value = claude.get("model_value")
    version_todo_combo = doc_counts.get("version_2_1_142", 0) > 0 and doc_counts.get("todowrite", 0) > 0
    disabled_combo = version_todo_combo and doc_counts.get("disabled_default", 0) > 0

    return {
        "claude_primary_model": {
            "verdict": "static-config-primary-proven" if model_value else "static-config-primary-unproven",
            "reason": "model is set in checked Claude settings" if model_value
            else "checked Claude settings expose fallbackModel values but no set primary model",
        },
        "opus_4_8_claim": {
            "verdict": "fallback-member-not-primary-proof"
            if "claude-opus-4-8" in fallback_values else "not-found-in-checked-fallback-list",
            "reason": "fallbackModel ordering is failover metadata unless a runtime/provider envelope proves active selection",
        },
        "fable_primary_claim": {
            "verdict": "no-checked-static-config-proof",
            "reason": "fable mentions in checked docs are treated as claim references, not current config proof",
            "doc_match_count": doc_counts.get("fable", 0),
        },
        "v2_1_142_todowrite_disabled_claim": {
            "verdict": "demote-unsubstantiated-product-fact" if disabled_combo else "no-supported-product-fact-found",
            "reason": "checked docs may mention the phrase, but this probe found no changelog/source-of-truth proof",
        },
        "todowrite_taxonomy": {
            "verdict": reference.get("verdict"),
            "reason": "local reference evidence can prove documented taxonomy only; it does not prove current session registration",
        },
        "todowrite_current_callability": {
            **tool_callability_verdict(tool_scan, "TodoWrite"),
        },
        "taskcreate_family_origin": {
            **tool_callability_verdict(tool_scan, "Task_family"),
            "static_reason": "historical/session notes are not enough to classify builtin vs deferred vs MCP vs harness source",
        },
    }


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    docs = [Path(item).expanduser() for item in args.doc]
    profile_paths = [Path(item).expanduser() for item in args.codex_profile]
    tool_artifact_paths = [Path(item).expanduser() for item in getattr(args, "tool_artifact", [])]
    artifact_sources = {path: "caller_supplied_artifact" for path in tool_artifact_paths}
    codex_session_root = Path(getattr(args, "codex_session_root", HOME / ".codex/sessions")).expanduser()
    latest_session = latest_codex_session_path(codex_session_root) if getattr(args, "latest_codex_session", False) else None
    if latest_session is not None and latest_session not in artifact_sources:
        tool_artifact_paths.append(latest_session)
        artifact_sources[latest_session] = "latest_codex_session_jsonl"
    doc_scans = [scan_text_file(path) for path in docs]
    doc_counts = aggregate_counts(doc_scans)
    claude = claude_settings_summary(Path(args.claude_settings).expanduser())
    codex_config = load_toml(Path(args.codex_config).expanduser())
    reference = task_tool_reference_summary(Path(args.claude_reference).expanduser())
    tool_scan = aggregate_tool_artifacts(tool_artifact_paths, artifact_sources)
    commands = {}
    if not getattr(args, "skip_commands", False):
        commands = {
            "claude_version": command_summary("claude"),
            "codex_version": command_summary("codex"),
        }
    report = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; emits config model names, tool names, counts, line numbers, hashes, and channel labels; no transcripts/provider payloads/tool inputs/tool outputs",
        "commands": commands,
        "claude_settings": redact(claude),
        "codex_config": redact(codex_config_summary(Path(args.codex_config).expanduser(), profile_paths)),
        "doc_scan": {
            "doc_count": len(doc_scans),
            "aggregate_term_counts": doc_counts,
            "docs": doc_scans,
        },
        "local_claude_tool_reference": reference,
        "tool_artifact_scan": tool_scan,
        "mcp_tool_config_reconciliation": reconcile_mcp_tool_names(
            tool_scan,
            codex_config if isinstance(codex_config, dict) else {},
        ),
        "codex_session_scan": {
            "requested": bool(getattr(args, "latest_codex_session", False)),
            "root_sha256_16": sha16_text(str(codex_session_root)),
            "latest_found": latest_session is not None,
            "latest_path_sha256_16": sha16_text(str(latest_session)) if latest_session else None,
            "latest_size_bytes": latest_session.stat().st_size if latest_session else None,
            "proof_class": "metadata_only_local_codex_session_jsonl" if latest_session else "not_run_or_not_found",
        },
        "claim_verdicts": claim_verdicts(claude, doc_counts, reference, tool_scan),
        "limitations": [
            "does not prove current provider route or selected model",
            "does not capture raw provider request payloads",
            "default mode does not read JSONL transcripts or historical assistant bodies",
            "default mode does not prove current-turn tool schema registration or ToolSearch behavior",
            "optional --tool-artifact consumes caller-supplied JSON/JSONL and emits names/counts only; artifact completeness is caller-owned",
            "optional --latest-codex-session reads the newest local Codex JSONL session and emits tool-name/channel metadata only; it proves executed/recorded events, not complete tool availability",
            "mcp_tool_config_reconciliation compares recorded mcp__ tool-name prefixes with static Codex config only; it does not prove current configured MCP callability or explain stale/harness-injected tool origins",
            "does not execute claude -p or any provider-backed prompt",
        ],
    }
    return redact(report)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--skip-commands", action="store_true", help="do not run local version commands")
    parser.add_argument("--claude-settings", default=str(HOME / ".claude/settings.json"))
    parser.add_argument("--codex-config", default=str(HOME / ".codex/config.toml"))
    parser.add_argument(
        "--codex-profile",
        action="append",
        default=[str(HOME / ".codex/quick.config.toml"), str(HOME / ".codex/deep.config.toml"), str(HOME / ".codex/review.config.toml")],
    )
    parser.add_argument("--claude-reference", default=str(DEFAULT_CLAUDE_REFERENCE))
    parser.add_argument("--doc", action="append", default=[str(path) for path in DEFAULT_DOC_PATHS])
    parser.add_argument(
        "--tool-artifact",
        action="append",
        default=[],
        help="metadata-only parse of caller-supplied init/tool-table JSON or JSONL captures",
    )
    parser.add_argument(
        "--latest-codex-session",
        action="store_true",
        help="metadata-only parse of the newest local Codex session JSONL; emits tool names/channels only",
    )
    parser.add_argument("--codex-session-root", default=str(HOME / ".codex/sessions"))
    args = parser.parse_args()

    report = build_report(args)
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=not args.pretty)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
