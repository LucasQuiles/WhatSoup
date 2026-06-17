#!/usr/bin/env python3
"""Read-only diagnostic for `.mcp.json` parseability and safe shape.

This probe exists because a zero-byte `/Users/testuser/.mcp.json` can explain Claude MCP
parse diagnostics, but it is not itself an active server list. The probe never mutates
the file and never emits raw JSON values, command strings, URLs, env values, headers,
cookies, or provider payloads.
"""
from __future__ import annotations

import argparse
import json
import stat
from collections import Counter
from pathlib import Path
from typing import Any

from probelib import sha256_16


SCHEMA = "agent-runtime-mcp-json-diagnostic"
SCHEMA_VERSION = "0.1"
DEFAULT_PATH = Path.home() / ".mcp.json"


def mode_class(path: Path) -> str | None:
    if not path.exists():
        return None
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode == 0o600:
        return "private_0600"
    if mode & 0o077:
        return "group_or_world_accessible"
    return "owner_only_nonstandard"


def size_class(size: int | None) -> str:
    if size is None:
        return "missing"
    if size == 0:
        return "zero_byte"
    if size < 1024:
        return "small"
    if size < 1024 * 1024:
        return "medium"
    return "large"


def transport_class(spec: Any) -> str:
    if not isinstance(spec, dict):
        return "non_object_spec"
    if isinstance(spec.get("url"), str):
        return "http"
    if isinstance(spec.get("command"), str) or isinstance(spec.get("command"), list):
        return "stdio"
    return "unknown"


def env_key_count(spec: Any) -> int:
    if not isinstance(spec, dict):
        return 0
    env = spec.get("env") or spec.get("environment")
    return len(env) if isinstance(env, dict) else 0


def summarize_mcp_servers(data: dict[str, Any]) -> dict[str, Any]:
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        return {
            "mcp_servers_present": "mcpServers" in data,
            "mcp_servers_shape": type(servers).__name__ if "mcpServers" in data else "missing",
            "server_count": 0,
            "server_name_hashes": [],
            "transport_counts": {},
            "env_key_count_total": 0,
        }
    transports = Counter()
    env_total = 0
    for spec in servers.values():
        transports[transport_class(spec)] += 1
        env_total += env_key_count(spec)
    return {
        "mcp_servers_present": True,
        "mcp_servers_shape": "object",
        "server_count": len(servers),
        "server_name_hashes": sorted(sha256_16(str(name)) for name in servers),
        "transport_counts": dict(sorted(transports.items())),
        "env_key_count_total": env_total,
    }


def diagnose_path(path: Path) -> dict[str, Any]:
    exists = path.exists()
    size = path.stat().st_size if exists else None
    base: dict[str, Any] = {
        "path": str(path),
        "path_sha256_16": sha256_16(str(path)),
        "exists": exists,
        "size_bytes": size,
        "size_class": size_class(size),
        "mode_class": mode_class(path),
        "content_sha256_16": sha256_16(path.read_bytes().hex()) if exists else None,
    }
    if not exists:
        base.update({
            "parse_status": "missing",
            "shape": "absent",
            "fault_class": "not_present",
            "recommended_action": "no_action_if_not_needed",
        })
        return base
    if size == 0:
        base.update({
            "parse_status": "invalid",
            "shape": "empty",
            "fault_class": "zero_byte_invalid_json",
            "recommended_action": "remove_if_unneeded_or_replace_with_valid_json_object",
        })
        return base
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError as exc:
        base.update({
            "parse_status": "invalid",
            "shape": "unknown",
            "fault_class": "json_decode_error",
            "error_class": type(exc).__name__,
            "error_line": exc.lineno,
            "error_column": exc.colno,
            "recommended_action": "repair_or_remove_after_confirming_loader_intent",
        })
        return base
    if not isinstance(data, dict):
        base.update({
            "parse_status": "valid_non_object",
            "shape": type(data).__name__,
            "fault_class": "valid_json_wrong_top_level_shape",
            "recommended_action": "replace_with_object_shape_if_used_by_mcp_loader",
        })
        return base
    summary = summarize_mcp_servers(data)
    base.update({
        "parse_status": "valid_object",
        "shape": "object",
        "top_level_key_count": len(data),
        "top_level_key_hashes": sorted(sha256_16(str(key)) for key in data),
        "mcp_server_summary": summary,
        "fault_class": "none",
        "recommended_action": "review_loader_precedence_before_editing",
    })
    return base


def build_report(paths: list[Path]) -> dict[str, Any]:
    rows = [diagnose_path(path.expanduser()) for path in paths]
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; emits path hashes, size/mode classes, parse status, key hashes, server-name hashes, transport counts, and env-key counts; no raw JSON values, command strings, URLs, env values, headers, cookies, or payloads",
        "proof_class": "local_file_metadata_parseability",
        "summary": {
            "path_count": len(rows),
            "exists_count": sum(1 for row in rows if row["exists"]),
            "parse_status_counts": dict(Counter(str(row["parse_status"]) for row in rows)),
            "fault_class_counts": dict(Counter(str(row["fault_class"]) for row in rows)),
        },
        "paths": rows,
        "limitations": [
            "does not mutate, remove, or repair files",
            "does not run claude mcp list or any MCP server",
            "does not prove loader precedence or current-turn tool registration",
            "does not emit raw MCP server names, commands, URLs, env values, or JSON content",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", action="append", default=None, help="MCP JSON path to diagnose; may be repeated")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    paths = [Path(item) for item in args.path] if args.path else [DEFAULT_PATH]
    report = build_report(paths)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
