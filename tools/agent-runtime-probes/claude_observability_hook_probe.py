#!/usr/bin/env python3
"""Summarize Claude observability hook metadata without transcript or hook payloads.

This probe reads `metadata/hook_events.jsonl` files produced by the local Claude
observability layer. It is historical/local evidence only: it does not execute
Claude, hooks, providers, MCP servers, SSH, or fleet services.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from probelib import SECRET_VALUE, sha256_16


SCHEMA = "agent-runtime-claude-observability-hook-events"
SCHEMA_VERSION = "0.1"
DEFAULT_ROOT = Path.home() / ".claude/observability/sessions"
PATH_KEYS = {"cwd", "path", "package_root", "transcript_path"}
SUPPRESSED_VALUE_KEYS = PATH_KEYS | {"prompt_hash", "error"}


def safe_basename(value: str) -> str:
    basename = value[:80]
    if SECRET_VALUE.search(basename):
        return "<redacted:value>"
    return basename


def classify_path(value: Any) -> str:
    if not isinstance(value, str) or not value:
        return "none"
    if value.startswith("/Users/") or value.startswith("~/"):
        return "home_path"
    if value.startswith("/"):
        return "absolute_path"
    return "relative_or_label"


def hook_identity(hook_value: Any) -> dict[str, Any]:
    if not isinstance(hook_value, str) or not hook_value:
        return {
            "hook_present": False,
            "hook_sha256_16": None,
            "hook_basename": None,
            "hook_label_class": "none",
        }
    if "/" in hook_value:
        label_class = "path_like"
        basename = Path(hook_value).name
    else:
        label_class = "label"
        basename = hook_value
    return {
        "hook_present": True,
        "hook_sha256_16": sha256_16(hook_value),
        "hook_basename": safe_basename(basename),
        "hook_label_class": label_class,
    }


def safe_tool_name(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    # Tool names are routing metadata. Keep only compact label-like values.
    if "/" in value or len(value) > 80:
        return f"tool_hash:{sha256_16(value)}"
    return value


def iter_hook_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted(root.glob("*/**/metadata/hook_events.jsonl"))


def parse_hook_file(path: Path, root: Path) -> dict[str, Any]:
    event_counts: Counter[str] = Counter()
    origin_type_counts: Counter[str] = Counter()
    hook_rows: dict[str, dict[str, Any]] = {}
    data_key_counts: Counter[str] = Counter()
    path_class_counts: Counter[str] = Counter()
    tool_counts: Counter[str] = Counter()
    multi_hook_groups: dict[str, set[str]] = defaultdict(set)
    json_line_count = 0
    invalid_json_lines = 0
    stdout_bytes_total = 0
    stderr_bytes_total = 0
    max_stdout_bytes = 0
    max_stderr_bytes = 0
    suppressed_value_key_counts: Counter[str] = Counter()
    session_hashes: set[str] = set()
    date_label = path.relative_to(root).parts[0] if len(path.relative_to(root).parts) else "unknown"

    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                invalid_json_lines += 1
                continue
            if not isinstance(obj, dict):
                invalid_json_lines += 1
                continue
            json_line_count += 1

            event = obj.get("event")
            if isinstance(event, str):
                event_counts[event] += 1
            origin_type = obj.get("origin_type")
            if isinstance(origin_type, str):
                origin_type_counts[origin_type] += 1
            session_id = obj.get("session_id")
            session_hash = sha256_16(session_id) if isinstance(session_id, str) else "unknown"
            session_hashes.add(session_hash)

            data = obj.get("data") if isinstance(obj.get("data"), dict) else {}
            for key, value in data.items():
                data_key_counts[key] += 1
                if key in SUPPRESSED_VALUE_KEYS and value not in (None, ""):
                    suppressed_value_key_counts[key] += 1
                if key in PATH_KEYS:
                    path_class_counts[f"{key}:{classify_path(value)}"] += 1
            stdout_bytes = data.get("stdout_bytes")
            stderr_bytes = data.get("stderr_bytes")
            if isinstance(stdout_bytes, int):
                stdout_bytes_total += stdout_bytes
                max_stdout_bytes = max(max_stdout_bytes, stdout_bytes)
            if isinstance(stderr_bytes, int):
                stderr_bytes_total += stderr_bytes
                max_stderr_bytes = max(max_stderr_bytes, stderr_bytes)
            tool = safe_tool_name(data.get("tool_name") or data.get("tool"))
            if tool:
                tool_counts[tool] += 1

            identity = hook_identity(obj.get("hook"))
            hook_id = identity["hook_sha256_16"] or "missing"
            row = hook_rows.setdefault(hook_id, {
                "hook_id_sha256_16": hook_id,
                "identity": identity,
                "invocation_count": 0,
                "event_counts": Counter(),
                "origin_type_counts": Counter(),
                "tool_counts": Counter(),
                "stdout_bytes_total": 0,
                "stderr_bytes_total": 0,
                "max_stdout_bytes": 0,
                "max_stderr_bytes": 0,
                "command_hash_count": 0,
            })
            row["invocation_count"] += 1
            if isinstance(event, str):
                row["event_counts"][event] += 1
            if isinstance(origin_type, str):
                row["origin_type_counts"][origin_type] += 1
            if tool:
                row["tool_counts"][tool] += 1
            if isinstance(stdout_bytes, int):
                row["stdout_bytes_total"] += stdout_bytes
                row["max_stdout_bytes"] = max(row["max_stdout_bytes"], stdout_bytes)
            if isinstance(stderr_bytes, int):
                row["stderr_bytes_total"] += stderr_bytes
                row["max_stderr_bytes"] = max(row["max_stderr_bytes"], stderr_bytes)
            if isinstance(data.get("command_hash"), str):
                row["command_hash_count"] += 1

            tool_ref = data.get("tool_ref")
            if isinstance(tool_ref, str) and isinstance(event, str):
                group_source = f"{session_hash}:{event}:{tool_ref}"
                multi_hook_groups[sha256_16(group_source)].add(hook_id)

    rows = []
    for row in hook_rows.values():
        item = dict(row)
        item["event_counts"] = dict(row["event_counts"])
        item["origin_type_counts"] = dict(row["origin_type_counts"])
        item["tool_counts"] = dict(row["tool_counts"])
        rows.append(item)
    rows.sort(key=lambda item: (-item["invocation_count"], item["hook_id_sha256_16"]))

    fanout = [
        {"group_sha256_16": group_id, "hook_identity_count": len(hooks)}
        for group_id, hooks in multi_hook_groups.items()
        if len(hooks) > 1
    ]
    fanout.sort(key=lambda item: (-item["hook_identity_count"], item["group_sha256_16"]))

    return {
        "path_sha256_16": sha256_16(str(path)),
        "path_suffix": f"{date_label}/<session>/metadata/hook_events.jsonl",
        "date_label": date_label,
        "size_bytes": path.stat().st_size,
        "json_line_count": json_line_count,
        "invalid_json_lines": invalid_json_lines,
        "session_count": len(session_hashes),
        "event_counts": dict(event_counts),
        "origin_type_counts": dict(origin_type_counts),
        "hook_identity_count": len(hook_rows),
        "hook_invocation_count": sum(row["invocation_count"] for row in rows),
        "stdout_bytes_total": stdout_bytes_total,
        "stderr_bytes_total": stderr_bytes_total,
        "max_stdout_bytes": max_stdout_bytes,
        "max_stderr_bytes": max_stderr_bytes,
        "data_key_counts": dict(data_key_counts),
        "suppressed_value_key_counts": dict(suppressed_value_key_counts),
        "path_class_counts": dict(path_class_counts),
        "tool_counts": dict(tool_counts),
        "hook_rows": rows,
        "multi_hook_tool_event_summary": {
            "group_count": len(fanout),
            "max_hook_identity_count": max((item["hook_identity_count"] for item in fanout), default=0),
            "groups": fanout[:20],
        },
    }


def merge_counter(target: Counter[str], source: dict[str, int]) -> None:
    for key, value in source.items():
        if isinstance(value, int):
            target[key] += value


def build_report(root: Path = DEFAULT_ROOT, max_files: int | None = None) -> dict[str, Any]:
    files = iter_hook_files(root)
    selected = files[:max_files] if max_files is not None else files
    file_rows = []
    event_counts: Counter[str] = Counter()
    origin_type_counts: Counter[str] = Counter()
    data_key_counts: Counter[str] = Counter()
    suppressed_value_key_counts: Counter[str] = Counter()
    path_class_counts: Counter[str] = Counter()
    tool_counts: Counter[str] = Counter()
    hook_totals: dict[str, dict[str, Any]] = {}
    parse_error_count = 0
    json_line_count = 0
    stdout_bytes_total = 0
    stderr_bytes_total = 0
    multi_hook_group_count = 0
    max_hook_identity_count = 0

    for path in selected:
        try:
            row = parse_hook_file(path, root)
        except OSError:
            parse_error_count += 1
            continue
        file_rows.append({
            "path_sha256_16": row["path_sha256_16"],
            "path_suffix": row["path_suffix"],
            "date_label": row["date_label"],
            "size_bytes": row["size_bytes"],
            "json_line_count": row["json_line_count"],
            "invalid_json_lines": row["invalid_json_lines"],
            "session_count": row["session_count"],
            "hook_invocation_count": row["hook_invocation_count"],
            "hook_identity_count": row["hook_identity_count"],
            "stdout_bytes_total": row["stdout_bytes_total"],
            "stderr_bytes_total": row["stderr_bytes_total"],
            "multi_hook_group_count": row["multi_hook_tool_event_summary"]["group_count"],
        })
        json_line_count += row["json_line_count"]
        parse_error_count += row["invalid_json_lines"]
        stdout_bytes_total += row["stdout_bytes_total"]
        stderr_bytes_total += row["stderr_bytes_total"]
        multi_hook_group_count += row["multi_hook_tool_event_summary"]["group_count"]
        max_hook_identity_count = max(max_hook_identity_count, row["multi_hook_tool_event_summary"]["max_hook_identity_count"])
        merge_counter(event_counts, row["event_counts"])
        merge_counter(origin_type_counts, row["origin_type_counts"])
        merge_counter(data_key_counts, row["data_key_counts"])
        merge_counter(suppressed_value_key_counts, row["suppressed_value_key_counts"])
        merge_counter(path_class_counts, row["path_class_counts"])
        merge_counter(tool_counts, row["tool_counts"])
        for hook_row in row["hook_rows"]:
            hook_id = hook_row["hook_id_sha256_16"]
            aggregate = hook_totals.setdefault(hook_id, {
                "hook_id_sha256_16": hook_id,
                "identity": hook_row["identity"],
                "invocation_count": 0,
                "event_counts": Counter(),
                "origin_type_counts": Counter(),
                "tool_counts": Counter(),
                "stdout_bytes_total": 0,
                "stderr_bytes_total": 0,
                "max_stdout_bytes": 0,
                "max_stderr_bytes": 0,
                "command_hash_count": 0,
            })
            aggregate["invocation_count"] += hook_row["invocation_count"]
            aggregate["stdout_bytes_total"] += hook_row["stdout_bytes_total"]
            aggregate["stderr_bytes_total"] += hook_row["stderr_bytes_total"]
            aggregate["max_stdout_bytes"] = max(aggregate["max_stdout_bytes"], hook_row["max_stdout_bytes"])
            aggregate["max_stderr_bytes"] = max(aggregate["max_stderr_bytes"], hook_row["max_stderr_bytes"])
            aggregate["command_hash_count"] += hook_row["command_hash_count"]
            merge_counter(aggregate["event_counts"], hook_row["event_counts"])
            merge_counter(aggregate["origin_type_counts"], hook_row["origin_type_counts"])
            merge_counter(aggregate["tool_counts"], hook_row["tool_counts"])

    hook_rows = []
    for row in hook_totals.values():
        item = dict(row)
        item["event_counts"] = dict(row["event_counts"])
        item["origin_type_counts"] = dict(row["origin_type_counts"])
        item["tool_counts"] = dict(row["tool_counts"])
        hook_rows.append(item)
    hook_rows.sort(key=lambda item: (-item["invocation_count"], item["hook_id_sha256_16"]))

    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; suppresses cwd/path/package_root/transcript_path, prompt hashes, error text, stdout/stderr content, session ids, and raw hook values except basename",
        "proof_class": "historical_local_claude_observability_metadata",
        "root": {
            "exists": root.exists(),
            "root_sha256_16": sha256_16(str(root)),
            "hook_event_file_count": len(files),
            "scanned_file_count": len(selected),
            "max_files": max_files,
        },
        "summary": {
            "json_line_count": json_line_count,
            "parse_error_count": parse_error_count,
            "hook_identity_count": len(hook_totals),
            "hook_invocation_count": sum(row["invocation_count"] for row in hook_rows),
            "event_counts": dict(event_counts),
            "origin_type_counts": dict(origin_type_counts),
            "stdout_bytes_total": stdout_bytes_total,
            "stderr_bytes_total": stderr_bytes_total,
            "data_key_counts": dict(data_key_counts),
            "suppressed_value_key_counts": dict(suppressed_value_key_counts),
            "path_class_counts": dict(path_class_counts),
            "tool_counts": dict(tool_counts),
            "multi_hook_tool_event_group_count": multi_hook_group_count,
            "multi_hook_tool_event_max_hook_identity_count": max_hook_identity_count,
        },
        "top_hooks": hook_rows[:50],
        "files": file_rows[:100],
        "limitations": [
            "historical observability metadata is not current-turn hook activation proof",
            "metadata/hook_events.jsonl proves only what the local observability layer recorded",
            "raw hook stdout/stderr/additionalContext, prompts, errors, paths, transcripts, and session ids are not emitted",
            "multi-hook tool-event groups are fanout signals, not automatic proof of duplicate side effects",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--max-files", type=int, default=None)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    report = build_report(args.root, args.max_files)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
