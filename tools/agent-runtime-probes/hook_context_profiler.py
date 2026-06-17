#!/usr/bin/env python3
"""Profile Claude hook events by name and byte count, suppressing raw content.

Default mode is a dry run. `--input-jsonl` parses an existing stream-json capture
offline. `--run` executes a small Claude prompt and can call the provider, so keep it
explicit and out of automated gates unless that tradeoff is intended.
"""

from __future__ import annotations

import argparse
import json
import shlex
import shutil
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any

from probelib import sha256_16


SCHEMA = "agent-runtime-hook-context-profile"
SCHEMA_VERSION = "0.3"
PROMPT = "Reply exactly OK. Do not call tools."
HOOK_MARKER_KEYS = {
    "hook_event_name",
    "hookEventName",
    "hook_name",
    "hookName",
    "hookSpecificOutput",
}
CONTENT_KEYS = {"stdout", "stderr", "additionalContext"}


def walk(obj: Any):
    if isinstance(obj, dict):
        yield obj
        for value in obj.values():
            yield from walk(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from walk(value)


def split_command(command: str) -> list[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return command.split()


def command_identity(command: str | None) -> dict[str, Any]:
    if not command:
        return {
            "command_present": False,
            "command_sha256_16": None,
            "executable_basename": None,
            "script_or_path_basename": None,
            "argv_count": 0,
        }
    argv = split_command(command)
    pathish = next((part for part in argv if part.startswith("/")), argv[0] if argv else "")
    return {
        "command_present": True,
        "command_sha256_16": sha256_16(command),
        "executable_basename": Path(argv[0]).name if argv else None,
        "script_or_path_basename": Path(pathish).name if pathish else None,
        "argv_count": len(argv),
    }


def command_shape() -> dict[str, Any]:
    return {
        "binary": "claude",
        "mode": "print_prompt_stream_json_verbose_include_hook_events",
        "prompt_bytes": len(PROMPT.encode("utf-8")),
        "provider_call_when_run": True,
    }


def is_hookish(item: dict[str, Any]) -> bool:
    if any(key in item for key in HOOK_MARKER_KEYS):
        return True
    if isinstance(item.get("type"), str) and "hook" in item["type"].lower():
        return True
    return False


def content_bytes(value: Any) -> int:
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    if isinstance(value, (dict, list)):
        return len(json.dumps(value, sort_keys=True, default=str).encode("utf-8"))
    return 0


def parse_stream_json(text: str) -> dict[str, Any]:
    event_counts: Counter[str] = Counter()
    hook_invocations: Counter[str] = Counter()
    hook_rows: dict[str, dict[str, Any]] = {}
    exit_codes: Counter[str] = Counter()
    invalid_json_lines = 0
    parsed_json_lines = 0

    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            invalid_json_lines += 1
            continue
        parsed_json_lines += 1
        for item in walk(obj):
            if not isinstance(item, dict) or not is_hookish(item):
                continue
            event = item.get("hook_event_name") or item.get("hookEventName") or item.get("event")
            if isinstance(event, str):
                event_counts[event] += 1

            command = item.get("command") if isinstance(item.get("command"), str) else None
            hook_name = item.get("hook_name") or item.get("hookName")
            identity_source = command or (str(hook_name) if isinstance(hook_name, str) else None) or str(event or "unknown")
            hook_id = sha256_16(identity_source)
            row = hook_rows.setdefault(hook_id, {
                "hook_id_sha256_16": hook_id,
                "identity": command_identity(command),
                "invocation_count": 0,
                "event_counts": Counter(),
                "stdout_bytes": 0,
                "stderr_bytes": 0,
                "additional_context_bytes": 0,
                "exit_codes": Counter(),
            })
            row["invocation_count"] += 1
            hook_invocations[hook_id] += 1
            if isinstance(event, str):
                row["event_counts"][event] += 1
            for key in CONTENT_KEYS:
                bytes_count = content_bytes(item.get(key))
                if key == "stdout":
                    row["stdout_bytes"] += bytes_count
                elif key == "stderr":
                    row["stderr_bytes"] += bytes_count
                elif key == "additionalContext":
                    row["additional_context_bytes"] += bytes_count
            nested = item.get("hookSpecificOutput")
            if isinstance(nested, dict):
                row["additional_context_bytes"] += content_bytes(nested.get("additionalContext"))
            code = item.get("exit_code") if "exit_code" in item else item.get("exitCode")
            if code is not None:
                exit_codes[str(code)] += 1
                row["exit_codes"][str(code)] += 1

    rows: list[dict[str, Any]] = []
    for row in hook_rows.values():
        row = dict(row)
        row["event_counts"] = dict(row["event_counts"])
        row["exit_codes"] = dict(row["exit_codes"])
        rows.append(row)
    rows.sort(key=lambda value: value["hook_id_sha256_16"])

    duplicate_groups: list[dict[str, Any]] = []
    for row in rows:
        if row["invocation_count"] <= 1:
            continue
        duplicate_groups.append({
            "hook_id_sha256_16": row["hook_id_sha256_16"],
            "identity": row["identity"],
            "invocation_count": row["invocation_count"],
            "extra_invocation_count": row["invocation_count"] - 1,
            "event_counts": row["event_counts"],
            "exit_codes": row["exit_codes"],
            "stdout_bytes": row["stdout_bytes"],
            "stderr_bytes": row["stderr_bytes"],
            "additional_context_bytes": row["additional_context_bytes"],
        })

    return {
        "parsed_json_lines": parsed_json_lines,
        "invalid_json_lines": invalid_json_lines,
        "event_counts": dict(event_counts),
        "hook_invocation_count": sum(hook_invocations.values()),
        "unique_hook_count": len(hook_rows),
        "exit_codes": dict(exit_codes),
        "hook_rows": rows,
        "duplicate_summary": {
            "duplicate_group_count": len(duplicate_groups),
            "extra_invocation_count": sum(row["extra_invocation_count"] for row in duplicate_groups),
            "groups": duplicate_groups,
        },
        "raw_content_suppressed": True,
    }


def build_report(*, mode: str, stream_text: str = "", rc: int | None = None, stderr_text: str = "") -> dict[str, Any]:
    parsed = parse_stream_json(stream_text) if stream_text else {
        "parsed_json_lines": 0,
        "invalid_json_lines": 0,
        "event_counts": {},
        "hook_invocation_count": 0,
        "unique_hook_count": 0,
        "exit_codes": {},
        "hook_rows": [],
        "duplicate_summary": {
            "duplicate_group_count": 0,
            "extra_invocation_count": 0,
            "groups": [],
        },
        "raw_content_suppressed": True,
    }
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; hook stdout/stderr/additionalContext content is suppressed and represented as byte totals",
        "mode": mode,
        "proof_class": "live_provider_run" if mode == "run" else ("offline_stream_parse" if mode == "input_jsonl" else "dry_run"),
        "command_shape": command_shape(),
        "rc": rc,
        "stdout_bytes_total": len(stream_text.encode("utf-8")),
        "stderr_bytes_total": len(stderr_text.encode("utf-8")),
        "stream_summary": parsed,
        "limitations": [
            "dry-run mode does not execute Claude or hooks",
            "input-jsonl mode proves parser behavior only, not current hook activation",
            "--run can call the provider and should not be used as an automated gate without explicit intent",
            "raw hook stdout, stderr, and additionalContext content are never emitted",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="store_true", help="execute a Claude prompt with hook events")
    parser.add_argument("--input-jsonl", type=Path, help="parse an existing stream-json capture offline")
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()

    if args.input_jsonl:
        try:
            stream_text = args.input_jsonl.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            print(json.dumps({
                "schema": SCHEMA,
                "schema_version": SCHEMA_VERSION,
                "error": f"{type(exc).__name__}: {exc}",
            }, indent=2))
            return 1
        print(json.dumps(build_report(mode="input_jsonl", stream_text=stream_text), indent=2, sort_keys=True))
        return 0

    cmd = [
        "claude",
        "-p",
        PROMPT,
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-hook-events",
    ]
    if not args.run:
        print(json.dumps(build_report(mode="dry_run"), indent=2, sort_keys=True))
        return 0

    if shutil.which("claude") is None:
        print(json.dumps({"schema": SCHEMA, "schema_version": SCHEMA_VERSION, "error": "claude not found on PATH"}, indent=2))
        return 1
    proc = subprocess.run(cmd, text=True, capture_output=True, timeout=args.timeout, check=False)
    report = build_report(mode="run", stream_text=proc.stdout, stderr_text=proc.stderr, rc=proc.returncode)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
