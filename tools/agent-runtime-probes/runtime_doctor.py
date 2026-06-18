#!/usr/bin/env python3
"""Secret-safe runtime summary for local agent harnesses."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

from probelib import du, load_json, load_toml, redact, run, sqlite_counts


HOME = Path.home()


def load_status(value: Any) -> dict[str, Any]:
    if value is None:
        return {"status": "missing", "error_type": None, "shape": "absent"}
    if isinstance(value, dict) and "_error" in value:
        return {"status": "error", "error_type": str(value["_error"]).split(":", 1)[0], "shape": "error"}
    if isinstance(value, dict):
        return {"status": "ok", "error_type": None, "shape": "object"}
    return {"status": "invalid_shape", "error_type": type(value).__name__, "shape": type(value).__name__}


def command_version(binary: str, *args: str) -> dict[str, Any]:
    path = shutil.which(binary)
    result: dict[str, Any] = {"path": path}
    if path:
        result["version"] = run([binary, *args], timeout=10)
    return result


def summarize_claude(live: bool) -> dict[str, Any]:
    settings = load_json(HOME / ".claude/settings.json")
    summary: dict[str, Any] = {
        "binary": command_version("claude", "--version"),
        "settings_path": str(HOME / ".claude/settings.json"),
        "settings_status": load_status(settings),
        "settings_keys": sorted(settings.keys()) if isinstance(settings, dict) else None,
        "selected_settings": redact(
            {
                key: settings.get(key)
                for key in (
                    "model",
                    "effortLevel",
                    "teammateMode",
                    "autoCompactEnabled",
                    "fileCheckpointingEnabled",
                    "statusLine",
                    "enabledPlugins",
                    "mcpServers",
                )
                if isinstance(settings, dict) and key in settings
            }
        )
        if isinstance(settings, dict)
        else settings,
        "state_sizes": {
            ".claude/tasks": du(HOME / ".claude/tasks"),
            ".claude/observability": du(HOME / ".claude/observability"),
            ".claude/archive-sync": du(HOME / ".claude/archive-sync"),
        },
    }
    if live:
        summary["mcp_list"] = run(["claude", "mcp", "list"], timeout=30)
        summary["plugin_list"] = run(["claude", "plugin", "list"], timeout=30)
    return summary


def summarize_codex(live: bool) -> dict[str, Any]:
    config = load_toml(HOME / ".codex/config.toml")
    summary: dict[str, Any] = {
        "binary": command_version("codex", "--version"),
        "config_path": str(HOME / ".codex/config.toml"),
        "config_status": load_status(config),
        "config_keys": sorted(config.keys()) if isinstance(config, dict) else None,
        "selected_settings": redact(
            {
                key: config.get(key)
                for key in (
                    "model",
                    "approval_policy",
                    "sandbox_mode",
                    "model_context_window",
                    "model_auto_compact_token_limit",
                    "tool_output_token_limit",
                    "profiles",
                    "mcp_servers",
                )
                if isinstance(config, dict) and key in config
            }
        )
        if isinstance(config, dict)
        else config,
        "state_sizes": {
            ".codex/sessions": du(HOME / ".codex/sessions"),
            ".codex/.tmp/plugins": du(HOME / ".codex/.tmp/plugins"),
        },
    }
    if live:
        summary["mcp_list"] = run(["codex", "mcp", "list"], timeout=30)
    return summary


def summarize_opencode(live: bool) -> dict[str, Any]:
    config_path = HOME / ".config/opencode/opencode.json"
    config = load_json(config_path)
    mcp = config.get("mcp") if isinstance(config, dict) else {}
    plugins = config.get("plugin") if isinstance(config, dict) else None
    summary: dict[str, Any] = {
        "binary": command_version("opencode", "--version"),
        "config_path": str(config_path),
        "config_status": load_status(config),
        "config_keys": sorted(config.keys()) if isinstance(config, dict) else None,
        "model": config.get("model") if isinstance(config, dict) else None,
        "small_model": config.get("small_model") if isinstance(config, dict) else None,
        "default_agent": config.get("default_agent") if isinstance(config, dict) else None,
        "plugins": plugins,
        "mcp_servers": {
            name: redact(
                {
                    "type": server.get("type"),
                    "enabled": server.get("enabled"),
                    "command": server.get("command"),
                    "environment_keys": sorted((server.get("environment") or {}).keys()),
                }
            )
            for name, server in (mcp or {}).items()
            if isinstance(server, dict)
        },
        "resource_counts": {
            "skills": len(list((HOME / ".config/opencode/skills").glob("*/SKILL.md"))),
            "agents": len(list((HOME / ".config/opencode/agents").glob("*.md"))),
            "plugins_files": len(list((HOME / ".config/opencode/plugins").glob("**/*"))),
        },
        "state_sizes": {
            ".config/opencode": du(HOME / ".config/opencode"),
            ".local/share/opencode": du(HOME / ".local/share/opencode"),
            ".cache/opencode": du(HOME / ".cache/opencode"),
            ".local/state/opencode": du(HOME / ".local/state/opencode"),
            ".cache/ocw": du(HOME / ".cache/ocw"),
        },
        "db_counts": sqlite_counts(
            HOME / ".local/share/opencode/opencode.db",
            ["session", "message", "part", "event", "project", "todo"],
        ),
        "ocw_wrappers": {
            name: shutil.which(name)
            for name in ("ocw", "ocw-batch", "ocw-panel", "ocw-verify")
        },
    }
    if live:
        summary["paths"] = run(["opencode", "debug", "paths"], timeout=20)
        summary["mcp_list"] = run(["opencode", "mcp", "list"], timeout=30)
        summary["auth_list"] = run(["opencode", "auth", "list"], timeout=30)
        summary["stats_7d"] = run(["opencode", "stats", "--days", "7", "--tools", "10", "--models", "10"], timeout=60)
    return summary


def summarize_pi() -> dict[str, Any]:
    return {
        "binary": command_version("pi", "--version"),
        "known_paths": {
            "~/.pi": (HOME / ".pi").exists(),
            "~/.pi/agent": (HOME / ".pi/agent").exists(),
            "~/.config/pi": (HOME / ".config/pi").exists(),
        },
        "state_sizes": {
            ".pi": du(HOME / ".pi"),
            ".config/pi": du(HOME / ".config/pi"),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="run CLI diagnostics that may connect to local MCP/state")
    args = parser.parse_args()

    report = {
        "schema": "agent-runtime-runtime-doctor",
        "schema_version": "0.1",
        "cwd": os.getcwd(),
        "live": args.live,
        "claude": summarize_claude(args.live),
        "codex": summarize_codex(args.live),
        "opencode": summarize_opencode(args.live),
        "pi": summarize_pi(),
    }
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
