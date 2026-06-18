#!/usr/bin/env python3
"""Compare Claude Code init tool surfaces across modes without dumping prompts."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


PROMPT = "Reply exactly OK. Do not call tools."
SCHEMA = "agent-runtime-tool-surface-diff"
SCHEMA_VERSION = "0.2"


MODES: dict[str, list[str]] = {
    "default": [],
    "safe-mode": ["--safe-mode"],
    "bare": ["--bare"],
    "tools-empty": ["--tools", ""],
}


def find_init(obj: Any) -> dict[str, Any] | None:
    if isinstance(obj, dict):
        event_type = str(obj.get("type") or obj.get("event") or "").lower()
        if "tools" in obj and (
            "model" in obj
            or "permissionMode" in obj
            or "permission_mode" in obj
            or event_type == "init"
        ):
            return obj
        for value in obj.values():
            found = find_init(value)
            if found:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = find_init(value)
            if found:
                return found
    return None


def normalize_tool(tool: Any) -> str | None:
    if isinstance(tool, str):
        return tool
    if isinstance(tool, dict):
        for key in ("name", "tool_name", "id"):
            value = tool.get(key)
            if isinstance(value, str):
                return value
    return None


def run_mode(name: str, extra: list[str], timeout: int) -> dict[str, Any]:
    cmd = ["claude", "-p", PROMPT, "--output-format", "stream-json", "--verbose", *extra]
    proc = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout, check=False)
    init: dict[str, Any] | None = None
    invalid_json_lines = 0
    for line in proc.stdout.splitlines():
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            invalid_json_lines += 1
            continue
        init = find_init(obj)
        if init:
            break
    tools = []
    if init:
        tools = sorted(filter(None, (normalize_tool(t) for t in init.get("tools", []))))
    return {
        "mode": name,
        "proof_class": "live_provider_run",
        "cmd": cmd,
        "rc": proc.returncode,
        "init_found": init is not None,
        "model": init.get("model") if init else None,
        "permission_mode": (init.get("permissionMode") or init.get("permission_mode")) if init else None,
        "tool_count": len(tools),
        "mcp_tool_count": sum(1 for name in tools if name.startswith("mcp__")),
        "core_tool_count": sum(1 for name in tools if not name.startswith("mcp__")),
        "tools": tools,
        "stderr_bytes": len(proc.stderr.encode()),
        "invalid_json_lines_until_init": invalid_json_lines,
    }


def tool_summary(tools: list[str]) -> dict[str, Any]:
    return {
        "tool_count": len(tools),
        "mcp_tool_count": sum(1 for name in tools if name.startswith("mcp__")),
        "core_tool_count": sum(1 for name in tools if not name.startswith("mcp__")),
        "tools": tools,
    }


def parse_stream_json(text: str, *, source_class: str = "caller_supplied_stream_json") -> dict[str, Any]:
    init: dict[str, Any] | None = None
    parsed_json_lines = 0
    invalid_json_lines = 0
    digest = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16] if text else None
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            invalid_json_lines += 1
            continue
        parsed_json_lines += 1
        init = find_init(obj)
        if init:
            break
    tools = []
    if init:
        tools = sorted(filter(None, (normalize_tool(t) for t in init.get("tools", []))))
    return {
        "mode": "input-jsonl",
        "proof_class": "offline_stream_json_parse",
        "source_class": source_class,
        "input_bytes": len(text.encode("utf-8", errors="replace")),
        "input_sha256_16": digest,
        "parsed_json_lines_until_init": parsed_json_lines,
        "invalid_json_lines_until_init": invalid_json_lines,
        "init_found": init is not None,
        "model": init.get("model") if init else None,
        "permission_mode": (init.get("permissionMode") or init.get("permission_mode")) if init else None,
        **tool_summary(tools),
        "artifact_assumption": "offline stream-json proves only the supplied capture; it is not current-turn availability unless the capture is current and complete",
    }


def build_dry_run_report() -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "dry-run only; live mode suppresses prompts/provider payloads and emits tool names/counts plus stderr byte counts",
        "dry_run": True,
        "modes": MODES,
        "prompt": PROMPT,
        "limitations": [
            "dry-run mode does not execute Claude or parse artifacts",
            "--input-jsonl parses caller-supplied stream-json offline",
            "--run can call the provider and should not be used as an automated gate without explicit intent",
        ],
    }


def build_input_report(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return {
            "schema": SCHEMA,
            "schema_version": SCHEMA_VERSION,
            "redaction": "metadata-only; no prompt bodies, provider payloads, tool descriptions, tool inputs, or tool outputs",
            "error": type(exc).__name__,
            "path_sha256_16": hashlib.sha256(str(path).encode("utf-8", errors="replace")).hexdigest()[:16],
        }
    parsed = parse_stream_json(text)
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; no prompt bodies, provider payloads, tool descriptions, tool inputs, or tool outputs",
        "path_sha256_16": hashlib.sha256(str(path).encode("utf-8", errors="replace")).hexdigest()[:16],
        "result": parsed,
        "limitations": [
            "input-jsonl mode proves parser behavior and supplied-capture contents only",
            "it does not prove live/current Claude tool registration unless the supplied capture is current and complete",
            "tool schemas/descriptions are not emitted",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="store_true", help="execute Claude init probes; may contact provider/auth path")
    parser.add_argument("--input-jsonl", type=Path, help="parse an existing Claude stream-json capture offline")
    parser.add_argument("--timeout", type=int, default=45)
    args = parser.parse_args()

    if args.input_jsonl:
        print(json.dumps(build_input_report(args.input_jsonl), indent=2, sort_keys=True))
        return 0
    if shutil.which("claude") is None:
        print(json.dumps({"error": "claude not found on PATH"}, indent=2))
        return 1
    if not args.run:
        print(json.dumps(build_dry_run_report(), indent=2))
        return 0

    results = []
    for name, extra in MODES.items():
        results.append(run_mode(name, extra, args.timeout))

    by_mode = {item["mode"]: set(item["tools"]) for item in results}
    default = by_mode.get("default", set())
    diff = {}
    for name, tools in by_mode.items():
        diff[name] = {
            "removed_vs_default": sorted(default - tools),
            "added_vs_default": sorted(tools - default),
        }
    print(json.dumps({
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; no prompt bodies beyond the fixed synthetic prompt, provider payloads, raw stderr, or hidden prompt text",
        "results": results,
        "diff": diff,
        "limitations": [
            "--run can call the provider and depends on current auth/config state",
            "init_found=false means the stream did not expose the expected init envelope, not that tools are absent",
        ],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
