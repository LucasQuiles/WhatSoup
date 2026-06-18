#!/usr/bin/env python3
"""Metadata-only reducer for recorded Codex session tool-table evidence.

This probe reads a caller-supplied Codex JSON/JSONL artifact, or the newest local
Codex session JSONL, and emits tool names, channel counts, namespace counts, and
recorded MCP server-name reconciliation against static Codex config. It does not
emit transcript text, tool inputs, tool outputs, provider payloads, raw paths, or
config values.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from model_todo_provenance_probe import (
    aggregate_tool_artifacts,
    latest_codex_session_path,
    reconcile_mcp_tool_names,
)
from probelib import load_toml, redact, sha256_16 as sha16


SCHEMA = "agent-runtime-codex-session-tool-table"
SCHEMA_VERSION = "0.1"
HOME = Path.home()


def classify_tool_namespace(name: str) -> str:
    if name.startswith("mcp__"):
        return "mcp"
    if name.startswith("functions.") or name.startswith("multi_tool_use."):
        return "developer_tool_namespace"
    if name.startswith("browser_"):
        return "browser_harness_tool"
    if name.startswith("update_") or name in {"apply_patch", "exec_command", "write_stdin", "view_image"}:
        return "codex_harness_tool"
    if name in {"create_goal", "get_goal", "update_goal"}:
        return "goal_harness_tool"
    if name in {"spawn_agent", "wait_agent", "multi_agent_v1"}:
        return "subagent_harness_tool"
    if name.startswith("microsoft_"):
        return "microsoft_docs_tool"
    return "other_or_unknown"


def namespace_counts(names: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for name in names:
        namespace = classify_tool_namespace(name)
        counts[namespace] = counts.get(namespace, 0) + 1
    return dict(sorted(counts.items()))


def artifact_tool_sets(tool_scan: dict[str, Any]) -> dict[str, set[str]]:
    merged: dict[str, set[str]] = {}
    for artifact in tool_scan.get("artifacts", []):
        channels = artifact.get("channels") if isinstance(artifact, dict) else None
        if not isinstance(channels, dict):
            continue
        for channel, names in channels.items():
            if not isinstance(names, list):
                continue
            for name in names:
                if isinstance(name, str):
                    merged.setdefault(channel, set()).add(name)
    return merged


def build_tool_table(tool_scan: dict[str, Any]) -> dict[str, Any]:
    channel_sets = artifact_tool_sets(tool_scan)
    all_names = sorted({name for names in channel_sets.values() for name in names})
    active_names = sorted(channel_sets.get("active_schema_or_request_tool", set()))
    used_names = sorted(channel_sets.get("tool_use_event", set()))
    result_names = sorted(channel_sets.get("tool_result_event", set()))
    deferred_names = sorted(channel_sets.get("deferred_or_search_result", set()))
    active_set = set(active_names)
    used_set = set(used_names)

    return {
        "tool_name_count": len(all_names),
        "tool_names": all_names,
        "namespace_counts": namespace_counts(all_names),
        "channel_counts": {key: len(values) for key, values in sorted(channel_sets.items())},
        "channels": {key: sorted(values) for key, values in sorted(channel_sets.items())},
        "active_or_request_tool_count": len(active_names),
        "tool_use_event_count": len(used_names),
        "tool_result_event_count": len(result_names),
        "deferred_or_search_result_count": len(deferred_names),
        "active_not_used_names": sorted(active_set - used_set),
        "used_not_active_names": sorted(used_set - active_set),
        "used_and_active_names": sorted(active_set & used_set),
        "completeness": {
            "has_active_or_request_channel": bool(active_names),
            "has_tool_use_channel": bool(used_names),
            "verdict": "recorded-session-tool-evidence-not-complete-active-table",
            "reason": "Codex session JSONL proves recorded/requested/executed tool names only; it does not prove complete current-turn availability or permission/hook allowance.",
        },
    }


def selected_artifact_paths(args: argparse.Namespace) -> tuple[list[Path], dict[Path, str], dict[str, Any]]:
    paths = [Path(item).expanduser() for item in args.artifact]
    source_classes = {path: "caller_supplied_artifact" for path in paths}
    session_root = Path(args.session_root).expanduser()
    latest = latest_codex_session_path(session_root) if args.latest else None
    if latest is not None:
        paths.append(latest)
        source_classes[latest] = "latest_codex_session_jsonl"
    session_summary = {
        "latest_requested": bool(args.latest),
        "session_root_sha256_16": sha16(str(session_root)),
        "latest_found": latest is not None,
        "latest_path_sha256_16": sha16(str(latest)) if latest else None,
        "latest_size_bytes": latest.stat().st_size if latest else None,
    }
    return paths, source_classes, session_summary


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    paths, source_classes, session_summary = selected_artifact_paths(args)
    codex_config = load_toml(Path(args.codex_config).expanduser())
    codex_config_obj = codex_config if isinstance(codex_config, dict) else {}
    tool_scan = aggregate_tool_artifacts(paths, source_classes)
    tool_table = build_tool_table(tool_scan) if tool_scan.get("status") == "parsed" else {
        "tool_name_count": 0,
        "tool_names": [],
        "namespace_counts": {},
        "channel_counts": {},
        "channels": {},
        "completeness": {
            "verdict": "no-artifact-parsed",
            "reason": "pass --latest or --artifact to parse recorded tool metadata",
        },
    }
    report = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; emits tool names, channels, counts, path hashes, byte sizes, and static config server names; no transcripts, tool inputs, tool outputs, provider payloads, raw paths, or config values",
        "proof_class": "recorded_codex_session_metadata" if paths else "not_probed",
        "session": session_summary,
        "artifact_scan": tool_scan,
        "tool_table": tool_table,
        "mcp_tool_config_reconciliation": reconcile_mcp_tool_names(tool_scan, codex_config_obj),
        "limitations": [
            "recorded Codex session JSONL is not a complete current-turn active tool table unless captured as such by the harness",
            "tool names are emitted, but tool descriptions, arguments, outputs, transcript text, and provider payloads are suppressed",
            "static Codex MCP config comparison does not prove runtime callability, auth state, hook allowance, or source of stale/harness-injected tool names",
        ],
    }
    return redact(report)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--latest", action="store_true", help="parse the newest local Codex session JSONL")
    parser.add_argument("--artifact", action="append", default=[], help="parse caller-supplied JSON/JSONL tool evidence")
    parser.add_argument("--session-root", default=str(HOME / ".codex/sessions"))
    parser.add_argument("--codex-config", default=str(HOME / ".codex/config.toml"))
    args = parser.parse_args(argv)
    report = build_report(args)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=not args.pretty))
    return 0


if __name__ == "__main__":
    sys.exit(main())
