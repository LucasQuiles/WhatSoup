#!/usr/bin/env python3
"""Read-only launchd plist metadata inventory.

This probe summarizes LaunchAgent/LaunchDaemon plist files without loading,
unloading, kickstarting, or querying launchd. It emits labels/paths/arguments as
hashes or classes, environment key names only, and schedule/restart/log shapes.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

from probelib import load_json, sha256_16

SCHEMA = "agent-runtime-launchd-plist-inventory"
SCHEMA_VERSION = "0.1"
DEFAULT_USER_ROOT = Path.home() / "Library/LaunchAgents"
SYSTEM_ROOTS = [Path("/Library/LaunchAgents"), Path("/Library/LaunchDaemons")]
WHATSOUP_MANAGED = Path.home() / "LAB/WhatSoup/deploy/managed-components.json"

SENSITIVE_ENV_PARTS = ("token", "secret", "key", "password", "credential", "auth", "cookie")
PLIST_TOKEN = re.compile(
    r"<key>(.*?)</key>|<string>(.*?)</string>|<integer>(.*?)</integer>|"
    r"<true\s*/>|<false\s*/>|<dict>|</dict>|<array>|</array>",
    re.S,
)


def classify_root(path: Path) -> str:
    expanded = path.expanduser()
    text = str(expanded)
    home = str(Path.home())
    if text.startswith(f"{home}/Library/LaunchAgents"):
        return "user_launch_agents"
    if text.startswith("/Library/LaunchAgents"):
        return "system_launch_agents"
    if text.startswith("/Library/LaunchDaemons"):
        return "system_launch_daemons"
    return "other"


def classify_path_value(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return "absent"
    text = value.strip()
    home = str(Path.home())
    if text.startswith(home) or text.startswith("~"):
        return "home_path"
    if text.startswith("/Users/"):
        return "other_user_path"
    if text.startswith("/usr/") or text.startswith("/bin/") or text.startswith("/sbin/"):
        return "system_binary_path"
    if text.startswith("/opt/") or text.startswith("/nix/"):
        return "managed_prefix_path"
    if text.startswith("/tmp/") or text.startswith("/private/tmp/") or text.startswith("/var/folders/"):
        return "temp_path"
    if text.startswith("/"):
        return "absolute_path"
    return "relative_or_command"


def label_prefix_class(label: Any) -> str:
    if not isinstance(label, str) or not label.strip():
        return "absent"
    text = label.strip()
    if text.startswith("com.whatsoup."):
        return "com.whatsoup"
    if text.startswith("com.examplefleet."):
        return "com.examplefleet"
    if text.startswith("com.tailscale."):
        return "com.tailscale"
    if text.startswith("homebrew."):
        return "homebrew"
    if text.startswith("com.apple."):
        return "com.apple"
    parts = text.split(".")
    return ".".join(parts[:2]) if len(parts) >= 2 else "other"


def keepalive_shape(value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"type": "bool", "enabled": value}
    if isinstance(value, dict):
        return {"type": "dict", "keys": sorted(str(key) for key in value), "key_count": len(value)}
    if value is None:
        return {"type": "absent"}
    return {"type": type(value).__name__}


def calendar_shape(value: Any) -> dict[str, Any]:
    if value is None:
        return {"type": "absent", "entry_count": 0, "keys": []}
    entries = value if isinstance(value, list) else [value]
    keys = sorted({str(key) for item in entries if isinstance(item, dict) for key in item})
    return {"type": "list" if isinstance(value, list) else type(value).__name__, "entry_count": len(entries), "keys": keys}


def sensitive_env_key_count(keys: list[str]) -> int:
    return sum(1 for key in keys if any(part in key.lower() for part in SENSITIVE_ENV_PARTS))


def tokenized_xml_plist(raw: str) -> list[tuple[str, Any]]:
    tokens: list[tuple[str, Any]] = []
    for match in PLIST_TOKEN.finditer(raw):
        if match.group(1) is not None:
            tokens.append(("key", html.unescape(match.group(1))))
        elif match.group(2) is not None:
            tokens.append(("string", html.unescape(match.group(2))))
        elif match.group(3) is not None:
            try:
                tokens.append(("integer", int(match.group(3))))
            except ValueError:
                tokens.append(("string", match.group(3)))
        else:
            text = match.group(0)
            if text.startswith("<true"):
                tokens.append(("bool", True))
            elif text.startswith("<false"):
                tokens.append(("bool", False))
            elif text == "<dict>":
                tokens.append(("dict_start", None))
            elif text == "</dict>":
                tokens.append(("dict_end", None))
            elif text == "<array>":
                tokens.append(("array_start", None))
            elif text == "</array>":
                tokens.append(("array_end", None))
    return tokens


def parse_value(tokens: list[tuple[str, Any]], index: int) -> tuple[Any, int]:
    if index >= len(tokens):
        return None, index
    kind, value = tokens[index]
    if kind in {"string", "integer", "bool"}:
        return value, index + 1
    if kind == "dict_start":
        result: dict[str, Any] = {}
        index += 1
        while index < len(tokens) and tokens[index][0] != "dict_end":
            key_kind, key_value = tokens[index]
            if key_kind != "key":
                index += 1
                continue
            parsed, index = parse_value(tokens, index + 1)
            result[str(key_value)] = parsed
        return result, index + 1 if index < len(tokens) else index
    if kind == "array_start":
        result: list[Any] = []
        index += 1
        while index < len(tokens) and tokens[index][0] != "array_end":
            parsed, index = parse_value(tokens, index)
            result.append(parsed)
        return result, index + 1 if index < len(tokens) else index
    return None, index + 1


def fallback_parse_xml_plist(raw: str) -> dict[str, Any]:
    tokens = tokenized_xml_plist(raw)
    for index, token in enumerate(tokens):
        if token[0] == "dict_start":
            parsed, _ = parse_value(tokens, index)
            if isinstance(parsed, dict):
                return parsed
    raise ValueError("no top-level dict found")


def load_plist_object(path: Path, raw: bytes) -> tuple[Any, str | None, str | None]:
    plutil_error_class: str | None = None
    try:
        proc = subprocess.run(
            ["plutil", "-convert", "json", "-o", "-", str(path)],
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return json.loads(proc.stdout), None, None
        plutil_error_class = f"plutil_rc_{proc.returncode}"
    except Exception as exc:
        plutil_error_class = type(exc).__name__
    try:
        return fallback_parse_xml_plist(raw.decode("utf-8", errors="replace")), None, plutil_error_class
    except Exception as exc:
        return None, type(exc).__name__, plutil_error_class


def summarize_plist(path: Path, root: Path) -> dict[str, Any]:
    raw = path.read_bytes()
    data, error_class, fallback_error_class = load_plist_object(path, raw)
    if error_class is not None:
        return {
            "path_sha256_16": sha256_16(str(path)),
            "root_class": classify_root(root),
            "parse_status": "error",
            "parse_error_class": error_class,
            "parse_fallback_error_class": fallback_error_class,
            "raw_bytes": len(raw),
            "raw_sha256_16": sha256_16(raw.decode("utf-8", errors="replace")),
        }
    if not isinstance(data, dict):
        return {
            "path_sha256_16": sha256_16(str(path)),
            "root_class": classify_root(root),
            "parse_status": "not_object",
            "parse_fallback_error_class": fallback_error_class,
            "raw_bytes": len(raw),
            "raw_sha256_16": sha256_16(raw.decode("utf-8", errors="replace")),
        }
    label = data.get("Label")
    args = data.get("ProgramArguments")
    env = data.get("EnvironmentVariables")
    env_keys = sorted(str(key) for key in env) if isinstance(env, dict) else []
    program = data.get("Program")
    first_arg = args[0] if isinstance(args, list) and args else None
    log_values = [data.get("StandardOutPath"), data.get("StandardErrorPath")]
    return {
        "path_sha256_16": sha256_16(str(path)),
        "root_class": classify_root(root),
        "parse_status": "ok",
        "parse_fallback_error_class": fallback_error_class,
        "raw_bytes": len(raw),
        "raw_sha256_16": sha256_16(raw.decode("utf-8", errors="replace")),
        "label_sha256_16": sha256_16(str(label)) if label else None,
        "label_prefix_class": label_prefix_class(label),
        "program_present": isinstance(program, str) and bool(program.strip()),
        "program_path_class": classify_path_value(program),
        "program_sha256_16": sha256_16(program) if isinstance(program, str) and program else None,
        "program_arguments_count": len(args) if isinstance(args, list) else 0,
        "program_first_arg_path_class": classify_path_value(first_arg),
        "program_first_arg_sha256_16": sha256_16(str(first_arg)) if first_arg else None,
        "env_key_count": len(env_keys),
        "env_keys": env_keys,
        "sensitive_env_key_count": sensitive_env_key_count(env_keys),
        "run_at_load": bool(data.get("RunAtLoad")) if "RunAtLoad" in data else None,
        "keepalive": keepalive_shape(data.get("KeepAlive")),
        "start_interval_seconds": data.get("StartInterval") if isinstance(data.get("StartInterval"), int) else None,
        "start_calendar_interval": calendar_shape(data.get("StartCalendarInterval")),
        "working_directory_present": isinstance(data.get("WorkingDirectory"), str),
        "working_directory_path_class": classify_path_value(data.get("WorkingDirectory")),
        "working_directory_sha256_16": sha256_16(data["WorkingDirectory"]) if isinstance(data.get("WorkingDirectory"), str) else None,
        "log_path_count": sum(1 for value in log_values if isinstance(value, str) and value.strip()),
        "log_path_classes": sorted(classify_path_value(value) for value in log_values if isinstance(value, str) and value.strip()),
    }


def find_plists(root: Path) -> list[Path]:
    expanded = root.expanduser()
    if not expanded.exists() or not expanded.is_dir():
        return []
    return sorted(path for path in expanded.glob("*.plist") if path.is_file())


def managed_components_summary(path: Path) -> dict[str, Any]:
    data = load_json(path.expanduser())
    if data is None:
        return {"status": "missing", "error_type": None, "protective_service_count": 0}
    if isinstance(data, dict) and "_error" in data:
        return {"status": "invalid_json", "error_type": str(data["_error"]).split(":", 1)[0], "protective_service_count": 0}
    if not isinstance(data, dict):
        return {"status": "invalid_shape", "error_type": type(data).__name__, "protective_service_count": 0}
    protective = data.get("protective_services")
    entries = protective.get("entries") if isinstance(protective, dict) else []
    if not isinstance(entries, list):
        entries = []
    label_classes = Counter()
    purpose_classes = Counter()
    for item in entries:
        if not isinstance(item, dict):
            continue
        label_classes[label_prefix_class(item.get("label_pattern") or item.get("name"))] += 1
        purpose = str(item.get("purpose") or "").lower()
        if "health" in purpose or "restart" in purpose:
            purpose_classes["health_or_restart"] += 1
        if "manifest" in purpose or "drift" in purpose:
            purpose_classes["manifest_or_drift"] += 1
        if "token" in purpose or "auth" in purpose:
            purpose_classes["credential_backup"] += 1
    return {
        "status": "parsed",
        "protective_service_count": len(entries),
        "label_prefix_class_counts": dict(sorted(label_classes.items())),
        "purpose_class_counts": dict(sorted(purpose_classes.items())),
        "source_path_sha256_16": sha256_16(str(path.expanduser())),
    }


def build_report(roots: list[Path], managed_components: Path | None = WHATSOUP_MANAGED) -> dict[str, Any]:
    root_rows = []
    plists: list[dict[str, Any]] = []
    for root in roots:
        found = find_plists(root)
        root_rows.append({
            "root_class": classify_root(root),
            "root_sha256_16": sha256_16(str(root.expanduser())),
            "exists": root.expanduser().exists(),
            "plist_count": len(found),
        })
        plists.extend(summarize_plist(path, root) for path in found)
    label_classes = Counter(str(item.get("label_prefix_class")) for item in plists)
    parse_counts = Counter(str(item.get("parse_status")) for item in plists)
    root_classes = Counter(str(item.get("root_class")) for item in plists)
    schedule_counts = {
        "run_at_load_true": sum(1 for item in plists if item.get("run_at_load") is True),
        "keepalive_present": sum(1 for item in plists if item.get("keepalive", {}).get("type") != "absent"),
        "start_interval_present": sum(1 for item in plists if item.get("start_interval_seconds") is not None),
        "start_calendar_present": sum(1 for item in plists if item.get("start_calendar_interval", {}).get("type") != "absent"),
    }
    env_key_counter: Counter[str] = Counter()
    for item in plists:
        for key in item.get("env_keys", []):
            env_key_counter[str(key)] += 1
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": (
            "metadata-only plist inventory; emits label/path/argument/working-dir/log hashes or classes, "
            "environment key names only, and schedule/restart/log shapes; no plist value bodies, raw paths, "
            "program arguments, env values, service load state, launchctl output, or credential material"
        ),
        "roots": root_rows,
        "summary": {
            "root_count": len(roots),
            "plist_count": len(plists),
            "parse_status_counts": dict(sorted(parse_counts.items())),
            "root_class_counts": dict(sorted(root_classes.items())),
            "label_prefix_class_counts": dict(sorted(label_classes.items())),
            "env_key_unique_count": len(env_key_counter),
            "sensitive_env_key_total": sum(int(item.get("sensitive_env_key_count") or 0) for item in plists),
            **schedule_counts,
        },
        "environment_key_counts": dict(sorted(env_key_counter.items())),
        "plists": plists,
        "whatsoup_managed_components": managed_components_summary(managed_components) if managed_components else {"status": "skipped"},
        "limitations": [
            "Read-only plist file metadata only.",
            "Does not call launchctl, load/unload jobs, inspect loaded state, read process state, or prove current service health.",
            "Does not prove remote/bot-host launchd state unless pointed at a copied artifact tree.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", action="append", type=Path, help="LaunchAgent/LaunchDaemon root to scan; repeatable")
    parser.add_argument("--include-system", action="store_true", help="also scan /Library LaunchAgents/Daemons")
    parser.add_argument("--managed-components", type=Path, default=WHATSOUP_MANAGED, help="WhatSoup managed-components JSON path")
    parser.add_argument("--no-managed-components", action="store_true", help="skip managed-components summary")
    parser.add_argument("--pretty", action="store_true", help="pretty-print JSON")
    args = parser.parse_args()
    roots = [Path(item) for item in args.root] if args.root else [DEFAULT_USER_ROOT]
    if args.include_system:
        roots.extend(SYSTEM_ROOTS)
    managed = None if args.no_managed_components else args.managed_components
    report = build_report(roots, managed)
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
