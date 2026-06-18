#!/usr/bin/env python3
"""Redact OpenCode resolved config without emitting raw values.

The dangerous input is `opencode debug config`: it is a resolved view that can include
merged config, expanded substitutions, provider endpoints, account identifiers, and MCP
environment values. This probe captures that output internally, parses it, and emits only
structure, counts, hashes, and a scalar-redacted config tree.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from probelib import redact, sha256_16 as sha256_16_text


SCHEMA = "opencode-resolved-config-redacted"
SCHEMA_VERSION = "0.2"
HOME = Path.home()
SYSTEM_OPENCODE_ROOT = Path("/Library/Application Support/opencode")
KNOWN_CONFIG_FILENAMES = {
    "opencode.json": "opencode_json",
    "opencode.jsonc": "opencode_jsonc",
}


@dataclass
class RedactionStats:
    total: int = 0
    by_reason: Counter[str] = field(default_factory=Counter)
    leaf_types: Counter[str] = field(default_factory=Counter)

    def mark(self, reason: str, leaf_type: str) -> None:
        self.total += 1
        self.by_reason[reason] += 1
        self.leaf_types[leaf_type] += 1


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_16_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()[:16]


def safe_resolve(path: Path) -> Path:
    return path.expanduser().resolve(strict=False)


def is_under(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def filename_class(path: Path) -> str:
    known = KNOWN_CONFIG_FILENAMES.get(path.name)
    if known:
        return known
    if path.suffix in {".json", ".jsonc"}:
        return f"other{path.suffix.replace('.', '_')}"
    if path.suffix:
        return "other_with_extension"
    return "other_without_extension"


def classify_path(path: Path, cwd: Path) -> str:
    resolved = safe_resolve(path)
    resolved_cwd = safe_resolve(cwd)
    resolved_home = safe_resolve(HOME)
    resolved_system = safe_resolve(SYSTEM_OPENCODE_ROOT)

    if is_under(resolved, resolved_home / ".config/opencode"):
        return "home_opencode_config"
    if is_under(resolved, resolved_cwd / ".opencode"):
        return "project_dot_opencode_config"
    if resolved.parent == resolved_cwd and resolved.name in KNOWN_CONFIG_FILENAMES:
        return "project_root_opencode_config"
    if is_under(resolved, resolved_system):
        return "system_opencode_config"
    if is_under(resolved, resolved_cwd):
        return "project_other"
    if is_under(resolved, resolved_home):
        return "home_other"
    if resolved.is_absolute():
        return "absolute_other"
    return "relative_other"


def path_metadata(path: Path, cwd: Path) -> dict[str, Any]:
    resolved = safe_resolve(path)
    return {
        "path_class": classify_path(resolved, cwd),
        "path_sha256_16": sha256_16_text(str(resolved)),
        "filename_class": filename_class(resolved),
        "exists": resolved.exists(),
    }


def command_shape(cmd: list[str]) -> dict[str, Any]:
    flags = [arg for arg in cmd[1:] if arg.startswith("-")]
    return {
        "command_id": "opencode_debug_config" if cmd[:3] == ["opencode", "debug", "config"] else "other",
        "executable_basename": Path(cmd[0]).name if cmd else None,
        "arg_count": len(cmd),
        "flags": sorted(flags),
    }


def sanitize_metadata(value: Any, cwd: Path, key: str = "") -> Any:
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for child_key, child_value in value.items():
            lowered = str(child_key).lower()
            if lowered == "path" or lowered.endswith("_path"):
                out[f"{child_key}_metadata"] = path_metadata(Path(str(child_value)), cwd)
            elif lowered == "command" and isinstance(child_value, list):
                out["command_shape"] = command_shape([str(part) for part in child_value])
            else:
                out[str(child_key)] = sanitize_metadata(child_value, cwd, str(child_key))
        return out
    if isinstance(value, list):
        return [sanitize_metadata(item, cwd, key) for item in value]
    return redact(value, key)


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


def redact_config_tree(value: Any, key: str = "", stats: RedactionStats | None = None) -> Any:
    """Preserve structure while redacting every scalar leaf.

    `probelib.redact` is still invoked for each scalar leaf first; that content-aware
    pass catches known secret shapes before the stronger resolved-config policy replaces
    all remaining scalar leaves.
    """
    if stats is None:
        stats = RedactionStats()

    if isinstance(value, dict):
        return {str(k): redact_config_tree(v, str(k), stats) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_config_tree(v, key, stats) for v in value]
    if value is None:
        return None

    first_pass = redact(value, key)
    leaf_type = "bool" if isinstance(value, bool) else type(value).__name__
    if first_pass != value:
        stats.mark("probelib_sensitive_key_or_value", leaf_type)
        return placeholder(value, "sensitive")

    stats.mark("scalar_leaf", leaf_type)
    return placeholder(value, "scalar")


def inventory_paths(value: Any, prefix: str = "$", max_paths: int = 5000) -> list[dict[str, Any]]:
    """Return schema/path metadata only: no scalar values."""
    rows: list[dict[str, Any]] = []

    def walk(node: Any, path: str) -> None:
        if len(rows) >= max_paths:
            return
        if isinstance(node, dict):
            rows.append({"path": path, "type": "object", "keys": sorted(map(str, node.keys()))})
            for key, child in node.items():
                walk(child, f"{path}.{key}")
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


def count_substitution_markers(value: Any) -> dict[str, int]:
    counts = {"env": 0, "file": 0}

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)
        elif isinstance(node, str):
            counts["env"] += node.count("{env:")
            counts["file"] += node.count("{file:")

    walk(value)
    return counts


def parse_json_object(text: str) -> Any:
    stripped = text.strip()
    if not stripped:
        raise ValueError("empty stdout")
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise
        return json.loads(stripped[start : end + 1])


def read_file_source(path: Path, cwd: Path) -> tuple[Any | None, dict[str, Any]]:
    data = path.read_bytes()
    metadata = path_metadata(path, cwd) | {
        "bytes": len(data),
        "sha256_16": sha256_16_bytes(data),
    }
    return json.loads(data.decode("utf-8")), metadata


def run_debug_config(timeout: int, pure: bool, cwd: Path) -> tuple[Any | None, dict[str, Any]]:
    cmd = ["opencode", "debug", "config"]
    if pure:
        cmd.append("--pure")
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd),
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return None, {"command_shape": command_shape(cmd), "rc": 127, "status": "error", "error_type": "FileNotFoundError"}
    except subprocess.TimeoutExpired:
        return None, {"command_shape": command_shape(cmd), "rc": 124, "status": "error", "error_type": "TimeoutExpired"}

    stdout_bytes = proc.stdout.encode("utf-8", errors="replace")
    stderr_bytes = proc.stderr.encode("utf-8", errors="replace")
    metadata: dict[str, Any] = {
        "command_shape": command_shape(cmd),
        "rc": proc.returncode,
        "stdout_bytes": len(stdout_bytes),
        "stderr_bytes": len(stderr_bytes),
        "stdout_sha256_16": sha256_16_bytes(stdout_bytes),
        "stderr_sha256_16": sha256_16_bytes(stderr_bytes),
    }
    if proc.returncode != 0:
        metadata.update({"status": "error", "error_type": "nonzero_exit"})
        return None, metadata
    try:
        return parse_json_object(proc.stdout), metadata | {"status": "parsed"}
    except Exception as exc:  # noqa: BLE001 - fail closed, never echo raw stdout/stderr
        metadata.update({"status": "error", "error_type": type(exc).__name__})
        return None, metadata


def candidate_sources(cwd: Path) -> list[dict[str, Any]]:
    paths = [
        HOME / ".config/opencode/opencode.json",
        HOME / ".config/opencode/opencode.jsonc",
        cwd / "opencode.json",
        cwd / "opencode.jsonc",
        cwd / ".opencode/opencode.json",
        cwd / ".opencode/opencode.jsonc",
        Path("/Library/Application Support/opencode/opencode.json"),
        Path("/Library/Application Support/opencode/opencode.jsonc"),
    ]
    rows: list[dict[str, Any]] = []
    seen: set[Path] = set()
    for path in paths:
        resolved = path.expanduser()
        if resolved in seen:
            continue
        seen.add(resolved)
        row: dict[str, Any] = path_metadata(resolved, cwd)
        if resolved.exists() and resolved.is_file():
            stat = resolved.stat()
            row.update({"bytes": stat.st_size, "mtime": int(stat.st_mtime)})
        rows.append(row)
    return rows


def build_report(config: Any | None, source: str, source_metadata: dict[str, Any], cwd: Path) -> dict[str, Any]:
    redaction_stats = RedactionStats()
    report: dict[str, Any] = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "risk": "high",
        "redaction_required": True,
        "source": source,
        "source_metadata": sanitize_metadata(source_metadata, cwd),
        "resolution": {
            "sources_merged": [row for row in candidate_sources(cwd) if row["exists"]],
            "source_count": sum(1 for row in candidate_sources(cwd) if row["exists"]),
            "candidate_sources": candidate_sources(cwd),
            "substitutions_expanded": {
                "env": "unknown",
                "file": "unknown",
                "unexpanded_markers_remaining": {"env": None, "file": None},
            },
            "limitation": "Resolved merge/substitution provenance is inferred from available files; OpenCode does not emit per-source merge proof in this probe output.",
        },
        "redaction": {
            "policy": "probelib.redact first pass, then replace every scalar leaf with a typed placeholder; containers, keys, and list lengths are preserved.",
            "placeholder_format": "<redacted:{reason}:{type}>",
            "redacted_count": 0,
            "redacted_by_reason": {},
            "leaf_types": {},
        },
        "config_sha256_16": None,
        "redacted_config_sha256_16": None,
        "config_inventory": None,
        "config": None,
    }
    if config is None:
        report["parse_status"] = "unavailable"
        return report

    report["parse_status"] = "parsed"
    markers = count_substitution_markers(config)
    report["resolution"]["substitutions_expanded"]["unexpanded_markers_remaining"] = markers
    redacted = redact_config_tree(config, "", redaction_stats)
    report["config_sha256_16"] = sha256_16_text(canonical_json(config))
    report["redacted_config_sha256_16"] = sha256_16_text(canonical_json(redacted))
    report["config_inventory"] = inventory_paths(config)
    report["config"] = redacted
    report["redaction"]["redacted_count"] = redaction_stats.total
    report["redaction"]["redacted_by_reason"] = dict(redaction_stats.by_reason)
    report["redaction"]["leaf_types"] = dict(redaction_stats.leaf_types)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Emit a redacted OpenCode resolved-config report.")
    parser.add_argument("--source", choices=["debug", "file"], default="debug")
    parser.add_argument("--file", type=Path, default=HOME / ".config/opencode/opencode.json")
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--timeout", type=int, default=20)
    parser.add_argument("--pure", action="store_true", help="pass --pure to opencode debug config")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    source_metadata: dict[str, Any]
    config: Any | None
    exit_code = 0
    if args.source == "file":
        try:
            config, source_metadata = read_file_source(args.file.expanduser(), args.cwd.expanduser())
            source_metadata["status"] = "parsed"
        except Exception as exc:  # noqa: BLE001 - never echo raw file content
            config = None
            source_metadata = path_metadata(args.file.expanduser(), args.cwd.expanduser()) | {
                "status": "error",
                "error_type": type(exc).__name__,
            }
            exit_code = 1
    else:
        config, source_metadata = run_debug_config(args.timeout, args.pure, args.cwd.expanduser())
        if config is None:
            exit_code = 1

    report = build_report(config, args.source, source_metadata, args.cwd.expanduser())
    json.dump(report, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
