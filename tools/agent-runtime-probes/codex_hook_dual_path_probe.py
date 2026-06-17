#!/usr/bin/env python3
"""Metadata-only Codex hook dual-path reconciliation.

Codex can have hook definitions in the current TOML config and in the older
hooks.json file. This probe compares those surfaces without running hooks and
without emitting raw command strings. It is static proof only: runtime duplicate
execution remains a separate controlled-hook-profiler question.
"""
from __future__ import annotations

import argparse
import json
import shlex
from pathlib import Path
from typing import Any

from probelib import load_json, load_toml, redact, sha256_16 as sha16


SCHEMA = "agent-runtime-codex-hook-dual-path"
SCHEMA_VERSION = "0.1"
HOME = Path.home()
DEFAULT_CONFIG_TOML = HOME / ".codex/config.toml"
DEFAULT_HOOKS_JSON = HOME / ".codex/hooks.json"


def event_slug(name: str) -> str:
    out = []
    for idx, char in enumerate(name):
        if char.isupper() and idx > 0:
            out.append("_")
        out.append(char.lower())
    return "".join(out)


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
            "script_or_path_sha256_16": None,
            "argv_count": 0,
        }
    argv = split_command(command)
    pathish = next((part for part in argv if part.startswith("/")), argv[0] if argv else "")
    return {
        "command_present": True,
        "command_sha256_16": sha16(command),
        "executable_basename": Path(argv[0]).name if argv else None,
        "script_or_path_basename": Path(pathish).name if pathish else None,
        "script_or_path_sha256_16": sha16(pathish) if pathish else None,
        "argv_count": len(argv),
    }


def normalize_config_entries(config: dict[str, Any] | None, config_path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not isinstance(config, dict):
        return [], {"trusted_state_count": 0, "trusted_state_entry_hashes": []}
    hooks = config.get("hooks")
    if not isinstance(hooks, dict):
        return [], {"trusted_state_count": 0, "trusted_state_entry_hashes": []}
    state = hooks.get("state") if isinstance(hooks.get("state"), dict) else {}
    entries: list[dict[str, Any]] = []
    for event_name, groups in hooks.items():
        if event_name == "state" or not isinstance(groups, list):
            continue
        eslug = event_slug(str(event_name))
        for group_index, group in enumerate(groups):
            if not isinstance(group, dict):
                continue
            matcher = group.get("matcher")
            hook_defs = group.get("hooks") if isinstance(group.get("hooks"), list) else []
            for hook_index, hook in enumerate(hook_defs):
                if not isinstance(hook, dict):
                    continue
                command = hook.get("command") if isinstance(hook.get("command"), str) else None
                trust_key = f"{config_path}:{eslug}:{group_index}:{hook_index}"
                trusted = state.get(trust_key) if isinstance(state, dict) else None
                trusted_hash = trusted.get("trusted_hash") if isinstance(trusted, dict) else None
                entries.append({
                    "source": "config_toml",
                    "event": str(event_name),
                    "event_slug": eslug,
                    "group_index": group_index,
                    "hook_index": hook_index,
                    "matcher": matcher if isinstance(matcher, str) else None,
                    "type": hook.get("type"),
                    "timeout_present": "timeout" in hook,
                    "status_message_present": "statusMessage" in hook,
                    "trusted_state_present": isinstance(trusted, dict),
                    "trusted_hash_sha256_16": sha16(str(trusted_hash)) if trusted_hash else None,
                    "identity": command_identity(command),
                })
    state_keys = sorted(str(key) for key in state) if isinstance(state, dict) else []
    return entries, {
        "trusted_state_count": len(state_keys),
        "trusted_state_entry_hashes": [sha16(key) for key in state_keys],
    }


def normalize_legacy_entries(data: Any) -> list[dict[str, Any]]:
    raw_entries = data if isinstance(data, list) else []
    entries: list[dict[str, Any]] = []
    for group_index, group in enumerate(raw_entries):
        if not isinstance(group, dict):
            continue
        event_name = str(group.get("type") or group.get("event") or "unknown")
        matcher = group.get("matcher")
        hook_defs = group.get("hooks") if isinstance(group.get("hooks"), list) else []
        if not hook_defs and isinstance(group.get("command"), str):
            hook_defs = [{"command": group["command"]}]
        for hook_index, hook in enumerate(hook_defs):
            if not isinstance(hook, dict):
                continue
            command = hook.get("command") if isinstance(hook.get("command"), str) else None
            entries.append({
                "source": "hooks_json",
                "event": event_name,
                "event_slug": event_slug(event_name),
                "group_index": group_index,
                "hook_index": hook_index,
                "matcher": matcher if isinstance(matcher, str) else None,
                "type": hook.get("type"),
                "timeout_present": "timeout" in hook,
                "status_message_present": "statusMessage" in hook,
                "trusted_state_present": False,
                "trusted_hash_sha256_16": None,
                "identity": command_identity(command),
            })
    return entries


def matcher_set(entries: list[dict[str, Any]]) -> set[str]:
    return {str(entry["matcher"]) for entry in entries if entry.get("matcher")}


def compare_entries(config_entries: list[dict[str, Any]], legacy_entries: list[dict[str, Any]]) -> dict[str, Any]:
    config_matchers = matcher_set(config_entries)
    legacy_matchers = matcher_set(legacy_entries)
    overlap = sorted(config_matchers & legacy_matchers)
    drift_rows = []
    duplicate_rows = []
    for matcher in overlap:
        config_for_matcher = [entry for entry in config_entries if entry.get("matcher") == matcher]
        legacy_for_matcher = [entry for entry in legacy_entries if entry.get("matcher") == matcher]
        config_path_hashes = {
            entry.get("identity", {}).get("script_or_path_sha256_16")
            for entry in config_for_matcher
        }
        legacy_path_hashes = {
            entry.get("identity", {}).get("script_or_path_sha256_16")
            for entry in legacy_for_matcher
        }
        path_hash_overlap = bool(config_path_hashes & legacy_path_hashes)
        row = {
            "matcher": matcher,
            "config_command_count": len(config_for_matcher),
            "legacy_command_count": len(legacy_for_matcher),
            "same_script_or_path": path_hash_overlap,
            "config_script_basenames": sorted({
                str(entry.get("identity", {}).get("script_or_path_basename"))
                for entry in config_for_matcher
            }),
            "legacy_script_basenames": sorted({
                str(entry.get("identity", {}).get("script_or_path_basename"))
                for entry in legacy_for_matcher
            }),
        }
        duplicate_rows.append(row)
        if not path_hash_overlap:
            drift_rows.append(row)
    return {
        "config_matcher_count": len(config_matchers),
        "legacy_matcher_count": len(legacy_matchers),
        "overlap_matchers": overlap,
        "config_only_matchers": sorted(config_matchers - legacy_matchers),
        "legacy_only_matchers": sorted(legacy_matchers - config_matchers),
        "legacy_is_subset_by_matcher": legacy_matchers <= config_matchers,
        "legacy_is_subset_by_command_path": bool(legacy_entries) and not drift_rows and legacy_matchers <= config_matchers,
        "potential_duplicate_matchers": overlap,
        "same_matcher_different_command_path": bool(drift_rows),
        "path_drift": drift_rows,
        "overlap_details": duplicate_rows,
        "missing_config_trusted_state_count": len([
            entry for entry in config_entries if not entry.get("trusted_state_present")
        ]),
        "runtime_invocation_proof": "not_probed",
    }


def config_parse_status(value: Any) -> dict[str, Any]:
    if value is None:
        return {"parse_status": "missing", "error_type": None}
    if isinstance(value, dict) and "_error" in value:
        return {"parse_status": "error", "error_type": str(value["_error"]).split(":", 1)[0]}
    if isinstance(value, dict):
        return {"parse_status": "ok", "error_type": None}
    return {"parse_status": "invalid_shape", "error_type": type(value).__name__}


def hooks_json_parse_status(value: Any) -> dict[str, Any]:
    if value is None:
        return {"parse_status": "missing", "error_type": None}
    if isinstance(value, dict) and "_error" in value:
        return {"parse_status": "error", "error_type": str(value["_error"]).split(":", 1)[0]}
    if isinstance(value, list):
        return {"parse_status": "ok", "error_type": None}
    return {"parse_status": "invalid_shape", "error_type": type(value).__name__}


def build_report(config_path: Path, hooks_json_path: Path) -> dict[str, Any]:
    config = load_toml(config_path)
    legacy = load_json(hooks_json_path)
    config_entries, trusted_state = normalize_config_entries(config, config_path)
    legacy_entries = normalize_legacy_entries(legacy)
    comparison = compare_entries(config_entries, legacy_entries)
    config_status = config_parse_status(config)
    hooks_status = hooks_json_parse_status(legacy)
    verdict = "static-dual-path-reconciled-runtime-unproven"
    if comparison["same_matcher_different_command_path"]:
        verdict = "static-drift-detected-runtime-unproven"
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; no raw hook command strings, status messages, trusted hash values, provider payloads, or secret values",
        "proof_class": "static-local-config",
        "config_toml": {
            "path": str(config_path),
            "exists": config_path.exists(),
            **config_status,
            "hook_command_count": len(config_entries),
            "events": sorted({entry["event"] for entry in config_entries}),
            "trusted_state": trusted_state,
            "entries": config_entries,
        },
        "hooks_json": {
            "path": str(hooks_json_path),
            "exists": hooks_json_path.exists(),
            **hooks_status,
            "hook_command_count": len(legacy_entries),
            "events": sorted({entry["event"] for entry in legacy_entries}),
            "entries": legacy_entries,
        },
        "comparison": comparison,
        "verdict": verdict,
        "limitations": [
            "does not execute hooks",
            "does not prove Codex runtime merge order",
            "does not prove duplicate hook execution",
            "does not inspect hidden provider payloads",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_TOML)
    parser.add_argument("--hooks-json", type=Path, default=DEFAULT_HOOKS_JSON)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    report = redact(build_report(args.config.expanduser(), args.hooks_json.expanduser()))
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
