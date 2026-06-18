#!/usr/bin/env python3
"""Export OpenCode topology with config value redaction."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from probelib import du, load_json, redact, run, sqlite_counts


HOME = Path.home()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="run OpenCode diagnostics that connect to local state/MCP")
    args = parser.parse_args()

    config_path = HOME / ".config/opencode/opencode.json"
    config = load_json(config_path) or {}
    mcp = config.get("mcp") if isinstance(config, dict) else {}
    report: dict[str, Any] = {
        "schema": "agent-runtime-opencode-topology",
        "schema_version": "0.1",
        "version": run(["opencode", "--version"], timeout=10),
        "config_path": str(config_path),
        "config_keys": sorted(config.keys()) if isinstance(config, dict) else None,
        "model": config.get("model") if isinstance(config, dict) else None,
        "small_model": config.get("small_model") if isinstance(config, dict) else None,
        "default_agent": config.get("default_agent") if isinstance(config, dict) else None,
        "plugins": config.get("plugin") if isinstance(config, dict) else None,
        "mcp_servers": {
            name: redact(
                {
                    "type": item.get("type"),
                    "enabled": item.get("enabled"),
                    "command": item.get("command"),
                    "environment_keys": sorted((item.get("environment") or {}).keys()),
                }
            )
            for name, item in (mcp or {}).items()
            if isinstance(item, dict)
        },
        "resource_counts": {
            "skills": len(list((HOME / ".config/opencode/skills").glob("*/SKILL.md"))),
            "agents": len(list((HOME / ".config/opencode/agents").glob("*.md"))),
            "plugin_files": len([p for p in (HOME / ".config/opencode/plugins").glob("**/*") if p.is_file()]),
        },
        "state_sizes": {
            "config": du(HOME / ".config/opencode"),
            "data": du(HOME / ".local/share/opencode"),
            "cache": du(HOME / ".cache/opencode"),
            "state": du(HOME / ".local/state/opencode"),
            "ocw_cache": du(HOME / ".cache/ocw"),
        },
        "db_counts": sqlite_counts(
            HOME / ".local/share/opencode/opencode.db",
            ["session", "message", "part", "event", "project", "todo"],
        ),
        "ocw_wrappers": {
            name: str(path)
            for name in ("ocw", "ocw-batch", "ocw-panel", "ocw-verify")
            if (path := Path(HOME / ".local/bin" / name)).exists()
        },
    }
    if args.live:
        report["paths"] = run(["opencode", "debug", "paths"], timeout=20)
        report["mcp_list"] = run(["opencode", "mcp", "list"], timeout=30)
        report["auth_list"] = run(["opencode", "auth", "list"], timeout=30)
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
