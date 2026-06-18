#!/usr/bin/env python3
"""Metadata-only monitor for managed/admin config insertion points.

This probe watches high-precedence harness policy locations that can outrank
user config. It reports presence, parse shape, size classes, and hashes without
dumping managed payload values or raw filesystem paths.
"""

from __future__ import annotations

import argparse
import json
import stat
from collections import Counter
from pathlib import Path
from typing import Any

from config_surface_doctor import SurfaceSpec, expand_specs
from probelib import sha256_16

SCHEMA = "agent-runtime-managed-config-presence"
SCHEMA_VERSION = "0.1"
MANAGED_HARNESSES = {"claude", "codex", "opencode"}
MANAGED_SURFACES = {
    "managed_mcp",
    "managed_requirements",
    "managed_settings",
    "managed_settings_dropin_dir",
}


def managed_specs(specs: list[SurfaceSpec] | None = None) -> list[SurfaceSpec]:
    specs = expand_specs() if specs is None else specs
    out = []
    for spec in specs:
        if spec.harness in MANAGED_HARNESSES and spec.surface in MANAGED_SURFACES:
            out.append(spec)
    return sorted(out, key=lambda item: (item.harness, item.surface, str(item.path)))


def size_class(size: int | None) -> str | None:
    if size is None:
        return None
    if size == 0:
        return "zero_byte"
    if size < 1024:
        return "small"
    if size < 1024 * 1024:
        return "medium"
    return "large"


def mode_class(path: Path) -> str | None:
    if not path.exists():
        return None
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        return "group_or_world_accessible"
    return "owner_private"


def path_class(path: Path) -> str:
    text = str(path)
    if text.startswith("/Library/Application Support/ClaudeCode/"):
        return "macos_claudecode_managed"
    if text.startswith("/Library/Application Support/Codex/"):
        return "macos_codex_managed"
    if text.startswith("/Library/Application Support/opencode/"):
        return "macos_opencode_managed"
    if text.startswith("/etc/claude-code/"):
        return "system_etc_claude"
    if text.startswith("/etc/codex/"):
        return "system_etc_codex"
    return "other_managed_path"


def parse_json_shape(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    if isinstance(data, dict):
        keys = sorted(str(key) for key in data.keys())
        return {
            "parse_status": "valid",
            "shape": "object",
            "top_level_key_count": len(keys),
            "top_level_key_hashes": [sha256_16(key) for key in keys],
        }
    if isinstance(data, list):
        return {
            "parse_status": "valid",
            "shape": "array",
            "item_count": len(data),
            "item_type_hashes": sorted({sha256_16(type(item).__name__) for item in data}),
        }
    return {"parse_status": "valid", "shape": type(data).__name__}


def parse_toml_shape(path: Path) -> dict[str, Any]:
    import tomllib

    data = tomllib.loads(path.read_text(encoding="utf-8", errors="replace"))
    if not isinstance(data, dict):
        return {"parse_status": "valid", "shape": type(data).__name__}
    keys = sorted(str(key) for key in data.keys())
    return {
        "parse_status": "valid",
        "shape": "object",
        "top_level_key_count": len(keys),
        "top_level_key_hashes": [sha256_16(key) for key in keys],
    }


def directory_shape(path: Path) -> dict[str, Any]:
    entries = list(path.iterdir())
    files = [entry for entry in entries if entry.is_file()]
    dirs = [entry for entry in entries if entry.is_dir()]
    return {
        "parse_status": "directory",
        "entry_count": len(entries),
        "file_count": len(files),
        "directory_count": len(dirs),
        "json_file_count": sum(1 for item in files if item.suffix == ".json"),
        "toml_file_count": sum(1 for item in files if item.suffix == ".toml"),
    }


def shape_for(path: Path, fmt: str) -> dict[str, Any]:
    if not path.exists():
        return {"parse_status": "missing"}
    try:
        if path.is_dir():
            return directory_shape(path)
        if fmt in {"json", "jsonc"}:
            return parse_json_shape(path)
        if fmt == "toml":
            return parse_toml_shape(path)
    except Exception as exc:  # noqa: BLE001 - diagnostic script
        return {"parse_status": "invalid", "error_class": type(exc).__name__}
    return {"parse_status": "unparsed"}


def payload_status(row: dict[str, Any]) -> str:
    if not row["exists"]:
        return "missing_no_checked_payload"
    if row["is_directory"] and row.get("entry_count", 0) == 0:
        return "empty_directory_policy_insertion_point"
    if row["is_file"] and row.get("size_class") == "zero_byte":
        return "zero_byte_payload_invalid_or_empty"
    if row.get("parse_status") == "invalid":
        return "present_invalid_payload"
    if row.get("parse_status") in {"valid", "directory"}:
        return "present_payload_or_dropin_review_required"
    return "present_unparsed_review_required"


def summarize_path(spec: SurfaceSpec) -> dict[str, Any]:
    path = spec.path
    exists = path.exists()
    is_dir = path.is_dir() if exists else False
    is_file = path.is_file() if exists else False
    byte_size = path.stat().st_size if exists else None
    shape = shape_for(path, spec.fmt)
    row: dict[str, Any] = {
        "harness": spec.harness,
        "surface": spec.surface,
        "format": spec.fmt,
        "loaded_by": spec.loaded_by,
        "active_evidence": spec.active_evidence or None,
        "risk": spec.risk,
        "edit_posture": spec.edit_posture,
        "path_basename": path.name,
        "path_class": path_class(path),
        "path_sha256_16": sha256_16(str(path)),
        "exists": exists,
        "is_directory": is_dir,
        "is_file": is_file,
        "size_class": size_class(byte_size),
        "mode_class": mode_class(path),
        "content_sha256_16": sha256_16(path.read_text(encoding="utf-8", errors="replace")) if is_file and byte_size is not None and byte_size <= 1024 * 1024 else None,
        **shape,
    }
    row["payload_status"] = payload_status(row)
    return row


def build_report(specs: list[SurfaceSpec] | None = None) -> dict[str, Any]:
    rows = [summarize_path(spec) for spec in managed_specs(specs)]
    status_counts = Counter(str(row["payload_status"]) for row in rows)
    harness_counts = Counter(str(row["harness"]) for row in rows)
    parse_counts = Counter(str(row.get("parse_status")) for row in rows)
    present_review_count = sum(1 for row in rows if str(row["payload_status"]).startswith("present_"))
    verdict = "managed_payload_present_review_required" if present_review_count else "no_checked_managed_payload_present"
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "proof_class": "local_managed_config_presence",
        "redaction": (
            "metadata-only managed config monitor; emits harness/surface labels, path classes, "
            "basenames, hashes, size/mode classes, parse shapes, key hashes, and payload status; "
            "does not emit raw managed config values, raw paths, raw key names, auth values, "
            "prompts, transcripts, provider payloads, or secrets"
        ),
        "summary": {
            "verdict": verdict,
            "managed_surface_count": len(rows),
            "existing_count": sum(1 for row in rows if row["exists"]),
            "missing_count": sum(1 for row in rows if not row["exists"]),
            "present_review_count": present_review_count,
            "empty_directory_count": status_counts.get("empty_directory_policy_insertion_point", 0),
            "missing_no_checked_payload_count": status_counts.get("missing_no_checked_payload", 0),
            "invalid_payload_count": status_counts.get("present_invalid_payload", 0),
            "by_harness": dict(sorted(harness_counts.items())),
            "by_payload_status": dict(sorted(status_counts.items())),
            "by_parse_status": dict(sorted(parse_counts.items())),
        },
        "surfaces": rows,
        "limitations": [
            "Presence proof only; does not prove loader precedence, cloud policy, MDM state, or current-turn runtime behavior.",
            "Missing local files mean no checked local managed payload, not absence of every possible enterprise/cloud policy.",
            "Present payloads require a separate redacted semantic review before treating user config as overridden.",
            "The probe is read-only and does not create, remove, repair, or mutate managed config paths.",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Monitor high-precedence managed config insertion points without dumping values.")
    parser.add_argument("--pretty", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report()
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
