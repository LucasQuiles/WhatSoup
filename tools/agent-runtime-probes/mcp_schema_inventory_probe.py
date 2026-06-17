#!/usr/bin/env python3
"""Metadata-only MCP schema inventory for local agent-runtime research.

Default mode inventories configured MCP surfaces from local files and does not
start MCP servers. With --probe-tools, it starts an allowlisted local stdio MCP
server, performs initialize + tools/list, and emits only tool names and schema
shape metadata. Tool descriptions are hashed/sized, never printed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any

from probelib import load_json, load_toml, redact, sha256_16 as sha16

SCHEMA = "agent-runtime-mcp-schema-inventory"
SCHEMA_VERSION = "0.1"
HOME = Path.home()
SAFE_DEFAULT_PROBE_NAMES = {"playwright", "tmup", "memory"}


def read_json_lenient(path: Path) -> dict[str, Any] | None:
    data = load_json(path)
    return data if isinstance(data, dict) else None


def command_to_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, str):
        return [value]
    return []


def command_summary(command: list[str]) -> dict[str, Any]:
    if not command:
        return {"argc": 0}
    first = command[0]
    suffixes = []
    for arg in command[1:]:
        if arg.startswith("/") or arg.startswith(str(HOME)):
            suffixes.append({"kind": "path", "basename": Path(arg).name, "sha256_16": sha16(arg)})
        elif "://" in arg:
            parsed = urllib.parse.urlparse(arg)
            suffixes.append({"kind": "url", "host": parsed.netloc, "scheme": parsed.scheme})
        elif any(marker in arg.lower() for marker in ("token", "secret", "authorization", "bearer")):
            suffixes.append({"kind": "sensitive_arg", "value": "<redacted>"})
        else:
            suffixes.append({"kind": "arg", "value": arg})
    return {
        "argc": len(command),
        "executable": first if first.startswith("/") else Path(first).name,
        "executable_basename": Path(first).name,
        "args": suffixes,
    }


def resolve_claude_plugin_arg(arg: str, plugin_root: Path) -> str:
    return arg.replace("${CLAUDE_PLUGIN_ROOT}", str(plugin_root))


def classify_transport(entry: dict[str, Any]) -> str:
    if entry.get("url"):
        return "http"
    if entry.get("command"):
        return "stdio"
    return "unknown"


def classify_risk(name: str, command: list[str], url: str | None, env_keys: list[str]) -> dict[str, Any]:
    lowered = name.lower()
    joined = " ".join(command).lower()
    classes: set[str] = set()
    if url or "mcp-remote" in joined or "https://" in joined:
        classes.add("remote")
    if env_keys or lowered in {"pinecone", "render", "google-workspace", "microsoft-365", "microsoft_365", "github"}:
        classes.add("auth_or_secret_backed")
    if lowered in {"whatsapp"} or "whatsapp" in joined:
        classes.add("local_socket_or_private_data")
    if lowered in {"playwright", "chrome"} or "playwright" in joined or "chrome" in joined:
        classes.add("browser_automation")
    if lowered in {"tmup", "memory", "episodic-memory"} or "memory" in joined or "tmup" in joined:
        classes.add("local_state")
    if not classes:
        classes.add("unknown")
    return {
        "risk_classes": sorted(classes),
        "default_probe_allowed": lowered in SAFE_DEFAULT_PROBE_NAMES and not (
            classes & {"remote", "auth_or_secret_backed", "local_socket_or_private_data"}
        ),
    }


def collect_codex() -> list[dict[str, Any]]:
    path = HOME / ".codex/config.toml"
    data = load_toml(path) or {}
    servers = data.get("mcp_servers", {}) if isinstance(data, dict) else {}
    entries = []
    if not isinstance(servers, dict):
        return entries
    for name, spec in sorted(servers.items()):
        if not isinstance(spec, dict):
            continue
        command = command_to_list(spec.get("command"))
        url = spec.get("url") if isinstance(spec.get("url"), str) else None
        env = spec.get("env") if isinstance(spec.get("env"), dict) else {}
        entry = {
            "harness": "codex",
            "server": name,
            "source": "codex_config",
            "source_path": str(path),
            "transport": "http" if url else "stdio",
            "command": command,
            "url": url,
            "env_keys": sorted(env.keys()),
            "enabled_state": "configured",
            "activation_proof": "config_file",
        }
        entry.update(classify_risk(name, command, url, sorted(env.keys())))
        entries.append(entry)
    return entries


def collect_opencode() -> list[dict[str, Any]]:
    path = HOME / ".config/opencode/opencode.json"
    data = read_json_lenient(path) or {}
    servers = data.get("mcp", {}) if isinstance(data, dict) else {}
    entries = []
    if not isinstance(servers, dict):
        return entries
    for name, spec in sorted(servers.items()):
        if not isinstance(spec, dict):
            continue
        command = command_to_list(spec.get("command"))
        url = spec.get("url") if isinstance(spec.get("url"), str) else None
        env = spec.get("environment") if isinstance(spec.get("environment"), dict) else {}
        enabled = spec.get("enabled")
        entry = {
            "harness": "opencode",
            "server": name,
            "source": "opencode_config",
            "source_path": str(path),
            "transport": spec.get("type") or classify_transport({"command": command, "url": url}),
            "command": command,
            "url": url,
            "env_keys": sorted(env.keys()),
            "enabled_state": "enabled" if enabled is True else ("disabled" if enabled is False else "configured"),
            "activation_proof": "config_file",
        }
        entry.update(classify_risk(name, command, url, sorted(env.keys())))
        entries.append(entry)
    return entries


def collect_claude_plugin_mcp() -> list[dict[str, Any]]:
    roots = [
        HOME / ".claude/plugins",
        HOME / ".claude/plugins/cache",
    ]
    manifests: list[Path] = []
    for root in roots:
        if root.exists():
            manifests.extend(root.glob("**/.claude-plugin/plugin.json"))
    entries = []
    seen: set[Path] = set()
    for manifest in sorted(manifests):
        if manifest in seen:
            continue
        seen.add(manifest)
        data = read_json_lenient(manifest) or {}
        plugin_root = manifest.parent.parent
        servers = data.get("mcpServers", {}) if isinstance(data, dict) else {}
        if not isinstance(servers, dict):
            continue
        plugin_name = str(data.get("name") or plugin_root.name)
        for name, spec in sorted(servers.items()):
            if not isinstance(spec, dict):
                continue
            command = command_to_list(spec.get("command"))
            args = [resolve_claude_plugin_arg(str(a), plugin_root) for a in spec.get("args", []) if isinstance(a, str)]
            full_command = command + args
            env = spec.get("env") if isinstance(spec.get("env"), dict) else {}
            entry = {
                "harness": "claude",
                "server": name,
                "plugin": plugin_name,
                "source": "claude_plugin_manifest",
                "source_path": str(manifest),
                "transport": "stdio",
                "command": full_command,
                "url": None,
                "env_keys": sorted(env.keys()),
                "enabled_state": "manifest_present_enabled_unknown",
                "activation_proof": "plugin_manifest_only",
            }
            entry.update(classify_risk(name, full_command, None, sorted(env.keys())))
            entries.append(entry)
    return entries


def side_effect_class_for_tool(name: str) -> str:
    lowered = name.lower()
    destructive = ("delete", "remove", "send", "write", "create", "update", "patch", "post", "put", "insert")
    browser = ("browser", "click", "navigate", "screenshot", "playwright")
    stateful = ("remember", "store", "task", "message", "claim", "dispatch")
    if any(part in lowered for part in destructive):
        return "potential_write_or_external_side_effect"
    if any(part in lowered for part in browser):
        return "browser_or_gui_side_effect"
    if any(part in lowered for part in stateful):
        return "local_state_side_effect"
    return "likely_read_or_compute"


def schema_shape(schema: Any) -> dict[str, Any]:
    if not isinstance(schema, dict):
        return {"type": type(schema).__name__, "sha256_16": sha16(json.dumps(schema, sort_keys=True, default=str))}
    props = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    required = schema.get("required") if isinstance(schema.get("required"), list) else []
    return {
        "type": schema.get("type", "<unspecified>"),
        "property_count": len(props),
        "property_names": sorted(str(k) for k in props.keys()),
        "required_count": len(required),
        "required_names": sorted(str(v) for v in required),
        "has_additional_properties": "additionalProperties" in schema,
        "schema_sha256_16": sha16(json.dumps(schema, sort_keys=True, default=str)),
    }


def summarize_tools(tools: list[Any]) -> list[dict[str, Any]]:
    rows = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = str(tool.get("name") or "")
        description = str(tool.get("description") or "")
        rows.append({
            "name": name,
            "side_effect_class_guess": side_effect_class_for_tool(name),
            "description_bytes": len(description.encode("utf-8")),
            "description_sha256_16": sha16(description) if description else None,
            "input_schema": schema_shape(tool.get("inputSchema")),
            "output_schema_present": isinstance(tool.get("outputSchema"), dict),
        })
    return sorted(rows, key=lambda row: row["name"])


def reader_thread(stream: Any, output: "queue.Queue[str]", sink: dict[str, Any], label: str) -> None:
    byte_count = 0
    digest = hashlib.sha256()
    try:
        for line in iter(stream.readline, ""):
            encoded = line.encode("utf-8", "replace")
            byte_count += len(encoded)
            digest.update(encoded)
            if label == "stdout":
                output.put(line)
    finally:
        sink[f"{label}_bytes"] = byte_count
        sink[f"{label}_sha256_16"] = digest.hexdigest()[:16] if byte_count else None


class McpClient:
    def __init__(self, command: list[str], cwd: Path, timeout: float):
        self.command = command
        self.cwd = cwd
        self.timeout = timeout
        self.next_id = 1
        self.queue: "queue.Queue[str]" = queue.Queue()
        self.io_stats: dict[str, Any] = {}
        self.proc: subprocess.Popen[str] | None = None

    def __enter__(self) -> "McpClient":
        self.proc = subprocess.Popen(
            self.command,
            cwd=str(self.cwd),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=os.environ.copy(),
        )
        assert self.proc.stdout is not None and self.proc.stderr is not None
        threading.Thread(target=reader_thread, args=(self.proc.stdout, self.queue, self.io_stats, "stdout"), daemon=True).start()
        threading.Thread(target=reader_thread, args=(self.proc.stderr, self.queue, self.io_stats, "stderr"), daemon=True).start()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self.proc is None:
            return
        try:
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
        finally:
            self.io_stats["returncode"] = self.proc.poll()

    def send(self, payload: dict[str, Any]) -> None:
        if self.proc is None or self.proc.stdin is None:
            raise RuntimeError("process not started")
        self.proc.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
        self.proc.stdin.flush()

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        request_id = self.next_id
        self.next_id += 1
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            payload["params"] = params
        self.send(payload)
        return self.wait_for_id(request_id)

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self.send(payload)

    def wait_for_id(self, request_id: int) -> dict[str, Any]:
        deadline = time.monotonic() + self.timeout
        ignored = 0
        empty_polls = 0
        while time.monotonic() < deadline:
            if self.proc is not None and self.proc.poll() is not None and self.queue.empty():
                raise RuntimeError(f"process exited before response id={request_id}")
            try:
                line = self.queue.get(timeout=0.1)
            except queue.Empty:
                empty_polls += 1
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                ignored += 1
                continue
            if msg.get("id") == request_id:
                msg["_ignored_stdout_lines"] = ignored
                msg["_empty_poll_count"] = empty_polls
                return msg
        raise TimeoutError(f"timed out waiting for response id={request_id}")


def probe_tools(entry: dict[str, Any], timeout: float) -> dict[str, Any]:
    command = entry.get("command") or []
    if not isinstance(command, list) or not command:
        return {"status": "skipped", "reason": "no_stdio_command"}
    if entry.get("transport") not in {"stdio", "local"}:
        return {"status": "skipped", "reason": "not_stdio"}
    started = time.monotonic()
    try:
        with McpClient([str(c) for c in command], HOME, timeout) as client:
            init = client.request("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "agent-runtime-mcp-schema-inventory", "version": SCHEMA_VERSION},
            })
            if "error" in init:
                return {
                    "status": "error",
                    "phase": "initialize",
                    "error_code": init["error"].get("code") if isinstance(init.get("error"), dict) else None,
                    "error_message_sha256_16": sha16(json.dumps(init.get("error"), sort_keys=True, default=str)),
                    "io": client.io_stats,
                }
            client.notify("notifications/initialized")
            tools: list[Any] = []
            cursor: str | None = None
            pages = 0
            while pages < 5:
                params = {"cursor": cursor} if cursor else {}
                resp = client.request("tools/list", params)
                pages += 1
                if "error" in resp:
                    return {
                        "status": "error",
                        "phase": "tools/list",
                        "error_code": resp["error"].get("code") if isinstance(resp.get("error"), dict) else None,
                        "error_message_sha256_16": sha16(json.dumps(resp.get("error"), sort_keys=True, default=str)),
                        "io": client.io_stats,
                    }
                result = resp.get("result") if isinstance(resp.get("result"), dict) else {}
                page_tools = result.get("tools") if isinstance(result.get("tools"), list) else []
                tools.extend(page_tools)
                next_cursor = result.get("nextCursor")
                cursor = str(next_cursor) if next_cursor else None
                if not cursor:
                    break
            shutdown_status = "ok"
            shutdown_error_type = None
            try:
                client.request("shutdown", {})
                client.notify("notifications/exit")
            except Exception as exc:  # noqa: BLE001 - cleanup status is metadata only
                shutdown_status = "error"
                shutdown_error_type = type(exc).__name__
            elapsed_ms = int((time.monotonic() - started) * 1000)
            return {
                "status": "ok",
                "shutdown_status": shutdown_status,
                "shutdown_error_type": shutdown_error_type,
                "tool_count": len(tools),
                "pages": pages,
                "elapsed_ms": elapsed_ms,
                "tools": summarize_tools(tools),
                "server_capabilities_keys": sorted((init.get("result") or {}).get("capabilities", {}).keys())
                if isinstance(init.get("result"), dict) and isinstance((init.get("result") or {}).get("capabilities"), dict)
                else [],
                "io": client.io_stats,
            }
    except Exception as exc:
        return {
            "status": "error",
            "phase": "transport",
            "error_type": type(exc).__name__,
            "error_message_sha256_16": sha16(str(exc)),
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        }


def select_probe_entries(entries: list[dict[str, Any]], requested: set[str], allow_secret_backed: bool) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for entry in sorted(entries, key=lambda e: (e.get("server") not in SAFE_DEFAULT_PROBE_NAMES, e.get("harness"), e.get("server"))):
        name = str(entry.get("server", "")).lower()
        if requested:
            if name not in requested and str(entry.get("server", "")) not in requested:
                continue
        elif name not in SAFE_DEFAULT_PROBE_NAMES:
            continue
        risks = set(entry.get("risk_classes") or [])
        if not allow_secret_backed and risks & {"remote", "auth_or_secret_backed", "local_socket_or_private_data"}:
            continue
        command_key = " ".join(str(c) for c in entry.get("command") or [])
        key = (name, command_key)
        if key in seen:
            continue
        seen.add(key)
        selected.append(entry)
    return selected


def public_entry(entry: dict[str, Any]) -> dict[str, Any]:
    public = {k: v for k, v in entry.items() if k not in {"command", "url"}}
    public["command_summary"] = command_summary(entry.get("command") or [])
    if entry.get("url"):
        parsed = urllib.parse.urlparse(str(entry["url"]))
        public["url_summary"] = {"scheme": parsed.scheme, "host": parsed.netloc}
    return redact(public)


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    entries = collect_codex() + collect_opencode() + collect_claude_plugin_mcp()
    requested = {s.lower() for s in args.server}
    selected = select_probe_entries(entries, requested, args.allow_secret_backed)
    probe_results = []
    if args.probe_tools:
        for entry in selected:
            result = probe_tools(entry, args.timeout)
            probe_results.append({
                "harness": entry.get("harness"),
                "server": entry.get("server"),
                "source": entry.get("source"),
                "source_path": entry.get("source_path"),
                "transport": entry.get("transport"),
                "risk_classes": entry.get("risk_classes"),
                "schema_probe": result,
            })
    skipped = []
    for entry in entries:
        name = str(entry.get("server", "")).lower()
        if args.probe_tools and any(r.get("server") == entry.get("server") and r.get("harness") == entry.get("harness") for r in probe_results):
            continue
        risks = set(entry.get("risk_classes") or [])
        reason = "not_requested"
        if args.probe_tools and not requested and name not in SAFE_DEFAULT_PROBE_NAMES:
            reason = "outside_safe_default_allowlist"
        if args.probe_tools and not args.allow_secret_backed and risks & {"remote", "auth_or_secret_backed", "local_socket_or_private_data"}:
            reason = "secret_remote_or_private_data_backed"
        skipped.append({
            "harness": entry.get("harness"),
            "server": entry.get("server"),
            "reason": reason,
            "risk_classes": entry.get("risk_classes"),
        })
    tool_count_total = sum(
        (r.get("schema_probe") or {}).get("tool_count", 0)
        for r in probe_results
        if (r.get("schema_probe") or {}).get("status") == "ok"
    )
    by_harness: dict[str, int] = {}
    for entry in entries:
        harness = str(entry.get("harness"))
        by_harness[harness] = by_harness.get(harness, 0) + 1
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "redaction": "metadata-only; no auth values, headers, cookies, tool descriptions, tool outputs, prompt bodies, or provider payloads; descriptions are hash/size only",
        "proof_class": "static_config" if not args.probe_tools else "static_config_plus_mcp_tools_list_for_selected_stdio_servers",
        "summary": {
            "configured_entry_count": len(entries),
            "configured_by_harness": dict(sorted(by_harness.items())),
            "probe_tools_requested": bool(args.probe_tools),
            "probe_selected_count": len(selected) if args.probe_tools else 0,
            "probe_ok_count": sum(1 for r in probe_results if (r.get("schema_probe") or {}).get("status") == "ok"),
            "probe_tool_count_total": tool_count_total,
            "skipped_count": len(skipped),
        },
        "safe_default_probe_names": sorted(SAFE_DEFAULT_PROBE_NAMES),
        "configured_servers": [public_entry(e) for e in entries],
        "schema_probes": redact(probe_results),
        "skipped": redact(skipped),
        "limitations": [
            "MCP tools/list proves server schema advertisement for selected local stdio servers only, not that the current model turn has those schemas registered.",
            "Default probing skips remote, secret-backed, browser-private, and local-private-data servers unless explicitly requested.",
            "Tool side-effect classes are conservative name-based guesses and must be reviewed before policy enforcement.",
            "Tool descriptions are not emitted because MCP descriptions can contain prompt-injection text or sensitive implementation detail.",
        ],
        "verdict": "partial_schema_inventory_landed" if args.probe_tools else "static_inventory_only",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--probe-tools", action="store_true", help="Start selected stdio MCP servers and call tools/list.")
    parser.add_argument("--server", action="append", default=[], help="Server name to probe; repeatable. Defaults to safe local set.")
    parser.add_argument("--allow-secret-backed", action="store_true", help="Permit probing auth/remote/private-data-backed MCPs. Still emits metadata only.")
    parser.add_argument("--timeout", type=float, default=10.0, help="Per JSON-RPC response timeout in seconds.")
    args = parser.parse_args(argv)
    report = build_report(args)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
