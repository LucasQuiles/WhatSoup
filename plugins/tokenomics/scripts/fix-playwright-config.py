#!/usr/bin/env python3
"""Normalize the Playwright MCP config for the tokenomics pilot.

This script only edits ~/.config/playwright-mcp/config.json when the file
already exists and at least one managed value differs. Hosts without Playwright
MCP config are a no-op.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any


INTENDED_VALUES: tuple[tuple[str, str, str], ...] = (
    ("snapshot", "mode", "full"),
    ("output", "mode", "file"),
    ("console", "level", "warning"),
)


def playwright_config_path() -> Path:
    return Path.home() / ".config" / "playwright-mcp" / "config.json"


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":")))


def needs_change(config: dict[str, Any]) -> bool:
    for section, key, intended in INTENDED_VALUES:
        value = config.get(section)
        if not isinstance(value, dict) or value.get(key) != intended:
            return True
    return False


def enforce_values(config: dict[str, Any]) -> dict[str, Any]:
    updated = dict(config)
    for section, key, intended in INTENDED_VALUES:
        existing = updated.get(section)
        section_data = dict(existing) if isinstance(existing, dict) else {}
        section_data[key] = intended
        updated[section] = section_data
    return updated


def write_atomic(path: Path, config: dict[str, Any]) -> None:
    tmp_name: str | None = None
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=str(path.parent),
        delete=False,
    ) as handle:
        tmp_name = handle.name
        json.dump(config, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def main() -> int:
    path = playwright_config_path()
    if not path.exists():
        emit({"changed": False, "reason": "no playwright-mcp config found"})
        return 0

    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        emit({"changed": False, "reason": f"invalid playwright-mcp config JSON: {err}"})
        return 0
    except OSError as err:
        emit({"changed": False, "reason": f"failed to read playwright-mcp config: {err}"})
        return 0

    if not isinstance(config, dict):
        emit({"changed": False, "reason": "invalid playwright-mcp config JSON: top-level value is not an object"})
        return 0

    if not needs_change(config):
        emit({"changed": False})
        return 0

    updated = enforce_values(config)
    try:
        write_atomic(path, updated)
    except OSError as err:
        emit({"changed": False, "reason": f"failed to write playwright-mcp config: {err}"})
        return 1

    emit({"changed": True})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
