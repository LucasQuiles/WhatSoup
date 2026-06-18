#!/usr/bin/env python3
"""Redact Codex local/effective config surfaces without emitting raw values.

Codex does not expose a `debug config` command in the checked local version. This probe
therefore builds a conservative metadata view from local TOML/JSON files, managed-policy
presence checks, and optional redacted `codex doctor --json` metadata. It preserves
structure, counts, hashes, and key names where safe; scalar values and path-like keys are
suppressed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from probelib import load_json, load_toml, redact, sha256_16


SCHEMA = "codex-effective-config-redacted"
SCHEMA_VERSION = "0.1"
HOME = Path.home()
MANAGED_REQUIREMENTS = [
    Path("/etc/codex/requirements.toml"),
    Path("/Library/Application Support/Codex/requirements.toml"),
]


@dataclass
class RedactionStats:
    total: int = 0
    by_reason: Counter[str] = field(default_factory=Counter)
    leaf_types: Counter[str] = field(default_factory=Counter)
    redacted_keys: int = 0

    def mark_leaf(self, reason: str, leaf_type: str) -> None:
        self.total += 1
        self.by_reason[reason] += 1
        self.leaf_types[leaf_type] += 1

    def mark_key(self) -> None:
        self.redacted_keys += 1
        self.by_reason["path_like_key"] += 1


def sha256_16_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()[:16]


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def placeholder(value: Any, reason: str) -> str:
    if isinstance(value, bool):
        kind = "bool"
    elif isinstance(value, int) and not isinstance(value, bool):
        kind = "int"
    elif isinstance(value, float):
        kind = "float"
    elif isinstance(value, str):
        kind = "str"
    else:
        kind = type(value).__name__
    return f"<redacted:{reason}:{kind}>"


def key_is_path_like(key: str) -> bool:
    return (
        key.startswith("/")
        or key.startswith("~")
        or str(HOME) in key
        or "\\Users\\" in key
        or ".toml:" in key
        or ".json:" in key
    )


def safe_key(key: Any, stats: RedactionStats | None = None) -> str:
    text = str(key)
    if key_is_path_like(text):
        if stats is not None:
            stats.mark_key()
        return f"<redacted:key:{sha256_16(text)}>"
    return text


def redact_config_tree(value: Any, key: str = "", stats: RedactionStats | None = None) -> Any:
    """Preserve containers while suppressing every scalar leaf and path-like key."""
    if stats is None:
        stats = RedactionStats()
    if isinstance(value, dict):
        return {safe_key(k, stats): redact_config_tree(v, str(k), stats) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_config_tree(v, key, stats) for v in value]
    if value is None:
        return None

    first_pass = redact(value, key)
    leaf_type = "bool" if isinstance(value, bool) else type(value).__name__
    if first_pass != value:
        stats.mark_leaf("probelib_sensitive_key_or_value", leaf_type)
        return placeholder(value, "sensitive")
    stats.mark_leaf("scalar_leaf", leaf_type)
    return placeholder(value, "scalar")


def inventory_paths(value: Any, prefix: str = "$", stats: RedactionStats | None = None, max_paths: int = 5000) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    def walk(node: Any, path: str) -> None:
        if len(rows) >= max_paths:
            return
        if isinstance(node, dict):
            keys = [safe_key(k, stats) for k in node.keys()]
            rows.append({"path": path, "type": "object", "keys": sorted(keys)})
            for key, child in node.items():
                walk(child, f"{path}.{safe_key(key, stats)}")
        elif isinstance(node, list):
            rows.append({"path": path, "type": "array", "length": len(node)})
            for idx, child in enumerate(node[:50]):
                walk(child, f"{path}[{idx}]")
            if len(node) > 50:
                rows.append({"path": f"{path}[50:]", "type": "array_truncated", "omitted": len(node) - 50})
        else:
            kind = "null" if node is None else ("bool" if isinstance(node, bool) else type(node).__name__)
            rows.append({"path": path, "type": kind})

    walk(value, prefix)
    if len(rows) >= max_paths:
        rows.append({"path": "$", "type": "inventory_truncated", "max_paths": max_paths})
    return rows


def file_meta(path: Path) -> dict[str, Any]:
    row: dict[str, Any] = {"path": str(path), "exists": path.exists()}
    if path.exists() and path.is_file():
        data = path.read_bytes()
        stat = path.stat()
        row.update({"bytes": len(data), "mtime": int(stat.st_mtime), "sha256_16": sha256_16_bytes(data)})
    return row


def source_row(path: Path, source_class: str) -> dict[str, Any]:
    meta = file_meta(path)
    data: Any | None
    if path.suffix == ".toml":
        data = load_toml(path)
    elif path.suffix in {".json", ".jsonl"}:
        data = load_json(path)
    else:
        data = None

    error_type = str(data["_error"]).split(":", 1)[0] if isinstance(data, dict) and "_error" in data else None
    stats = RedactionStats()
    row: dict[str, Any] = {
        "source_class": source_class,
        "file": meta,
        "parse_status": "missing" if data is None else ("error" if isinstance(data, dict) and "_error" in data else "parsed"),
        "error_type": error_type,
        "top_level_keys": sorted(data.keys()) if isinstance(data, dict) else [],
        "config_sha256_16": None,
        "redacted_config_sha256_16": None,
        "redaction": {"redacted_count": 0, "redacted_key_count": 0, "by_reason": {}, "leaf_types": {}},
        "inventory": None,
        "config": None,
    }
    if data is None:
        return row

    redacted = redact_config_tree(data, stats=stats)
    row["config_sha256_16"] = sha256_16(canonical_json(data))
    row["redacted_config_sha256_16"] = sha256_16(canonical_json(redacted))
    row["inventory"] = inventory_paths(data, stats=RedactionStats())
    row["config"] = redacted
    row["redaction"] = {
        "redacted_count": stats.total,
        "redacted_key_count": stats.redacted_keys,
        "by_reason": dict(stats.by_reason),
        "leaf_types": dict(stats.leaf_types),
    }
    return row


def codex_sources(codex_home: Path) -> list[tuple[Path, str]]:
    rows: list[tuple[Path, str]] = [(codex_home / "config.toml", "base_config")]
    rows.extend((p, "profile_config") for p in sorted(codex_home.glob("*.config.toml")))
    rows.extend((p, "agent_config") for p in sorted((codex_home / "agents").glob("*.toml")))
    rows.append((codex_home / "hooks.json", "legacy_hooks_json"))
    rows.append((codex_home / "version.json", "version_cache_json"))
    return rows


def summarize_base_config(config: Any | None) -> dict[str, Any]:
    if isinstance(config, dict) and "_error" in config:
        return {"available": False, "status": "error", "error_type": str(config["_error"]).split(":", 1)[0]}
    if not isinstance(config, dict):
        return {"available": False}
    hooks = config.get("hooks") if isinstance(config.get("hooks"), dict) else {}
    hooks_state = hooks.get("state") if isinstance(hooks.get("state"), dict) else {}
    mcp = config.get("mcp_servers") if isinstance(config.get("mcp_servers"), dict) else {}
    projects = config.get("projects") if isinstance(config.get("projects"), dict) else {}
    plugins = config.get("plugins") if isinstance(config.get("plugins"), dict) else {}
    return {
        "available": True,
        "top_level_key_count": len(config),
        "hook_events": sorted(k for k, v in hooks.items() if k != "state" and isinstance(v, list)),
        "hook_command_groups": sum(len(v) for k, v in hooks.items() if k != "state" and isinstance(v, list)),
        "trusted_hook_state_count": len(hooks_state),
        "mcp_server_names": sorted(mcp.keys()),
        "mcp_server_count": len(mcp),
        "project_trust_entry_count": len(projects),
        "project_key_hashes": sorted(sha256_16(str(k)) for k in projects.keys()),
        "plugin_ids": sorted(plugins.keys()),
        "plugin_count": len(plugins),
    }


def summarize_legacy_hooks(data: Any | None) -> dict[str, Any]:
    if isinstance(data, dict) and "_error" in data:
        return {"available": False, "status": "error", "error_type": str(data["_error"]).split(":", 1)[0]}
    if isinstance(data, list):
        events = sorted({str(item.get("type")) for item in data if isinstance(item, dict) and item.get("type")})
        command_count = 0
        matcher_count = 0
        for item in data:
            if not isinstance(item, dict):
                continue
            matcher_count += 1 if item.get("matcher") else 0
            hooks = item.get("hooks")
            if isinstance(hooks, list):
                command_count += len(hooks)
        return {
            "available": True,
            "shape": "list",
            "events": events,
            "hook_group_count": len(data),
            "matcher_count": matcher_count,
            "command_count": command_count,
        }
    if isinstance(data, dict):
        events = sorted(data.keys())
        group_count = 0
        command_count = 0
        for value in data.values():
            if isinstance(value, list):
                group_count += len(value)
                command_count += sum(len(item.get("hooks") or []) for item in value if isinstance(item, dict))
        return {
            "available": True,
            "shape": "object",
            "events": events,
            "hook_group_count": group_count,
            "command_count": command_count,
        }
    return {"available": False}


def parse_doctor_json(path: Path | None, run_doctor: bool, timeout: int) -> tuple[Any | None, dict[str, Any]]:
    if path is not None:
        data = path.read_bytes()
        return json.loads(data.decode("utf-8")), {
            "source": "file",
            "path": str(path),
            "bytes": len(data),
            "sha256_16": sha256_16_bytes(data),
            "status": "parsed",
        }
    if not run_doctor:
        return None, {"source": "not_run", "status": "not_run"}
    cmd = ["codex", "doctor", "--json"]
    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError:
        return None, {"source": "command", "command": cmd, "rc": 127, "status": "error", "error_type": "FileNotFoundError"}
    except subprocess.TimeoutExpired:
        return None, {"source": "command", "command": cmd, "rc": 124, "status": "error", "error_type": "TimeoutExpired"}
    metadata = {
        "source": "command",
        "command": cmd,
        "rc": proc.returncode,
        "stdout_bytes": len(proc.stdout.encode("utf-8", errors="replace")),
        "stderr_bytes": len(proc.stderr.encode("utf-8", errors="replace")),
        "stdout_sha256_16": sha256_16(proc.stdout),
        "stderr_sha256_16": sha256_16(proc.stderr),
        "warning": "codex doctor may perform provider/network reachability checks; use only when that is approved for the audit.",
    }
    if proc.returncode != 0:
        metadata.update({"status": "error", "error_type": "nonzero_exit"})
        return None, metadata
    try:
        return json.loads(proc.stdout), metadata | {"status": "parsed"}
    except Exception as exc:  # noqa: BLE001 - never echo raw stdout
        metadata.update({"status": "error", "error_type": type(exc).__name__})
        return None, metadata


def doctor_summary(data: Any | None, metadata: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "metadata": metadata,
        "available": isinstance(data, dict),
        "warning": "doctor details are reduced to ids/categories/statuses/detail-key names; raw details are not emitted.",
    }
    if not isinstance(data, dict):
        return result
    checks = data.get("checks") if isinstance(data.get("checks"), dict) else {}
    rows = []
    for check_id, check in sorted(checks.items()):
        if not isinstance(check, dict):
            continue
        details = check.get("details") if isinstance(check.get("details"), dict) else {}
        rows.append({
            "id": str(check_id),
            "category": check.get("category"),
            "status": check.get("status"),
            "durationMs": check.get("durationMs"),
            "detail_keys": sorted(map(str, details.keys())),
            "issue_count": len(check.get("issues") or []),
        })
    return result | {
        "schemaVersion": data.get("schemaVersion"),
        "overallStatus": data.get("overallStatus"),
        "codexVersion": data.get("codexVersion"),
        "check_count": len(rows),
        "checks": rows,
    }


def build_report(codex_home: Path, cwd: Path, doctor: Any | None = None, doctor_metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    sources = [source_row(path, source_class) for path, source_class in codex_sources(codex_home)]
    base_config = next((row for row in sources if row["source_class"] == "base_config"), None)
    legacy_hooks = next((row for row in sources if row["source_class"] == "legacy_hooks_json"), None)
    managed = [file_meta(path) | {"source_class": "managed_requirements"} for path in MANAGED_REQUIREMENTS]
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "proof_class": "local_file_config_plus_optional_doctor_metadata",
        "redaction": "metadata-only; scalar config leaves and path-like dictionary keys are redacted; doctor details reduced to ids/statuses/detail-key names",
        "codex_home": {"path": str(codex_home), "exists": codex_home.exists()},
        "cwd": {"path": str(cwd), "exists": cwd.exists()},
        "sources": sources,
        "managed_requirements": managed,
        "summary": {
            "source_count": len(sources),
            "parsed_source_count": sum(1 for row in sources if row["parse_status"] == "parsed"),
            "missing_source_count": sum(1 for row in sources if row["parse_status"] == "missing"),
            "base_config": summarize_base_config(load_toml(codex_home / "config.toml")),
            "legacy_hooks": summarize_legacy_hooks(load_json(codex_home / "hooks.json")),
            "managed_requirements_present_count": sum(1 for row in managed if row["exists"]),
        },
        "doctor": doctor_summary(doctor, doctor_metadata or {"source": "not_run", "status": "not_run"}),
        "limitations": [
            "This is not a full resolved runtime config proof because local Codex 0.139.0 has no `codex debug config` command.",
            "`codex doctor --json` is optional because it can perform provider/network reachability checks.",
            "No raw hook command strings, trusted hashes, auth values, prompt bodies, provider payloads, or session transcripts are emitted.",
            "`debug prompt-input` is intentionally not run here because it renders model-visible context and needs a separate synthetic-only probe.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Emit a redacted Codex config-surface report.")
    parser.add_argument("--codex-home", type=Path, default=Path(os.environ.get("CODEX_HOME", HOME / ".codex")))
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--doctor-json", type=Path, default=None, help="parse a saved codex doctor --json file instead of running doctor")
    parser.add_argument("--run-doctor", action="store_true", help="run codex doctor --json; may perform provider/network reachability checks")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    doctor, metadata = parse_doctor_json(args.doctor_json, args.run_doctor, args.timeout)
    report = build_report(args.codex_home.expanduser(), args.cwd.expanduser(), doctor, metadata)
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
