#!/usr/bin/env python3
"""Metadata-only runtime budget rail across local agent harnesses.

The rail combines local config ceilings, state-store pressure, instruction
budget estimates, and optional OpenCode aggregate usage stats. It does not read
or emit transcript bodies, tool inputs/outputs, provider payloads, or secrets.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from instruction_budget_auditor import build_report as build_instruction_budget
from probelib import load_json, load_toml, sha256_16

HOME = Path.home()
SCHEMA = "agent-runtime-budget-rail"
SCHEMA_VERSION = "0.1"
STATE_WARN_BYTES = 500 * 1024 * 1024
STATE_HIGH_BYTES = 1024 * 1024 * 1024
CODEX_SESSION_WARN_BYTES = 50 * 1024 * 1024
TOOL_CONCENTRATION_WARN_PCT = 60.0


@dataclass(frozen=True)
class StateSurface:
    harness: str
    label: str
    path: Path
    data_class: str
    sensitivity: str


DEFAULT_STATE_SURFACES = (
    StateSurface("codex", "sessions", HOME / ".codex/sessions", "session_transcripts", "private_transcripts"),
    StateSurface("claude", "observability", HOME / ".claude/observability", "hook_observability", "private_metadata"),
    StateSurface("claude", "archive_sync", HOME / ".claude/archive-sync", "archive_sync", "private_transcripts"),
    StateSurface("opencode", "data", HOME / ".local/share/opencode", "opencode_state", "private_transcripts"),
    StateSurface("opencode", "ocw_cache", HOME / ".cache/ocw", "worker_cache", "private_worker_artifacts"),
    StateSurface("opencode", "config", HOME / ".config/opencode", "config_and_extensions", "config"),
)


def strip_ansi(text: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)


def parse_human_number(text: str) -> float | int | dict[str, str] | None:
    cleaned = text.strip().replace(",", "")
    if not cleaned:
        return None
    multiplier = 1
    if cleaned[-1:] in {"K", "M", "B"}:
        suffix = cleaned[-1]
        cleaned = cleaned[:-1]
        multiplier = {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000}[suffix]
    try:
        value = float(cleaned) * multiplier
    except ValueError as exc:
        return {"_error": type(exc).__name__, "parse_status": "invalid_number"}
    if multiplier > 1:
        return int(round(value))
    if value.is_integer():
        return int(value)
    return value


def parse_cost(text: str) -> float | None:
    match = re.search(r"\$([0-9]+(?:\.[0-9]+)?)", text)
    return float(match.group(1)) if match else None


def clean_box_line(line: str) -> str:
    text = strip_ansi(line)
    text = text.replace("│", " ").replace("├", " ").replace("┤", " ")
    text = text.replace("┌", " ").replace("┐", " ").replace("└", " ").replace("┘", " ")
    text = text.replace("─", " ")
    return re.sub(r"\s+", " ", text).strip()


def parse_label_value(line: str, label: str) -> str | None:
    text = clean_box_line(line)
    if not text.startswith(label):
        return None
    return text[len(label):].strip()


def parse_opencode_stats_output(stdout: str, stderr: str, rc: int, days: int) -> dict[str, Any]:
    lines = strip_ansi(stdout).splitlines()
    section = None
    overview: dict[str, Any] = {}
    cost_tokens: dict[str, Any] = {}
    tools: list[dict[str, Any]] = []
    for raw in lines:
        line = clean_box_line(raw)
        if not line:
            continue
        if line == "OVERVIEW":
            section = "overview"
            continue
        if line == "COST & TOKENS":
            section = "cost_tokens"
            continue
        if line == "MODEL USAGE":
            section = "model_usage"
            continue
        if line == "TOOL USAGE":
            section = "tool_usage"
            continue
        if section == "overview":
            for label, key in (("Sessions", "sessions"), ("Messages", "messages"), ("Days", "days")):
                value = parse_label_value(raw, label)
                if value is not None:
                    overview[key] = parse_human_number(value)
        elif section == "cost_tokens":
            label_map = {
                "Total Cost": "total_cost_usd",
                "Avg Cost/Day": "avg_cost_per_day_usd",
                "Avg Tokens/Session": "avg_tokens_per_session",
                "Median Tokens/Session": "median_tokens_per_session",
                "Input": "input_tokens",
                "Output": "output_tokens",
                "Cache Read": "cache_read_tokens",
                "Cache Write": "cache_write_tokens",
            }
            for label, key in label_map.items():
                value = parse_label_value(raw, label)
                if value is None:
                    continue
                cost_tokens[key] = parse_cost(value) if "Cost" in label else parse_human_number(value)
        elif section == "tool_usage":
            match = re.match(r"([A-Za-z0-9_.-]+)\s+.*?\s([0-9,]+)\s+\(\s*([0-9.]+)%\s*\)", line)
            if match:
                tools.append({
                    "tool_name": match.group(1),
                    "call_count": int(match.group(2).replace(",", "")),
                    "share_pct": float(match.group(3)),
                })

    input_tokens = float(cost_tokens.get("input_tokens") or 0)
    cache_read = float(cost_tokens.get("cache_read_tokens") or 0)
    total_noncache = input_tokens + float(cost_tokens.get("output_tokens") or 0)
    total_with_cache = total_noncache + cache_read + float(cost_tokens.get("cache_write_tokens") or 0)
    return {
        "status": "parsed" if rc == 0 and (overview or cost_tokens or tools) else "not_parsed",
        "days_requested": days,
        "rc": rc,
        "stdout_bytes": len(stdout.encode("utf-8", errors="replace")),
        "stderr_bytes": len(stderr.encode("utf-8", errors="replace")),
        "overview": overview,
        "cost_tokens": cost_tokens,
        "cache_read_to_input_ratio": round(cache_read / input_tokens, 3) if input_tokens else None,
        "cache_share_of_total_with_cache_pct": round((cache_read / total_with_cache) * 100, 2) if total_with_cache else None,
        "top_tools": tools,
        "top_tool_share_pct": tools[0]["share_pct"] if tools else None,
        "limitations": [
            "Parsed from local OpenCode aggregate stats text; model names and raw stats output are not emitted.",
            "OpenCode stats are local historical aggregates, not current-turn budget or task quality proof.",
        ],
    }


def run_opencode_stats(days: int) -> dict[str, Any]:
    if shutil.which("opencode") is None:
        return {"status": "missing_binary", "days_requested": days}
    proc = subprocess.run(
        ["opencode", "stats", "--days", str(days), "--tools", "10", "--models", "10"],
        text=True,
        capture_output=True,
        stdin=subprocess.DEVNULL,
        timeout=120,
        check=False,
    )
    return parse_opencode_stats_output(proc.stdout, proc.stderr, proc.returncode, days)


def directory_stats(path: Path, max_files: int = 200_000) -> dict[str, Any]:
    # Guard entry-point existence/type/size probes: if stat() raises (e.g. permission
    # denied on the path itself), record the error and fall through to the os.walk
    # loop rather than crashing.  The walk may still succeed (or record its own errors).
    stat_error_count = 0
    stat_error_types: Counter[str] = Counter()
    try:
        path_exists = path.exists()
    except OSError as exc:
        stat_error_count += 1
        stat_error_types[type(exc).__name__] += 1
        path_exists = None  # indeterminate — fall through to walk
    if path_exists is False:
        return {"exists": False, "file_count": 0, "directory_count": 0, "total_bytes": 0, "truncated": False}
    if path_exists:
        try:
            is_file = path.is_file()
        except OSError as exc:
            stat_error_count += 1
            stat_error_types[type(exc).__name__] += 1
            is_file = False
        if is_file:
            try:
                size = path.stat().st_size
            except OSError as exc:
                stat_error_count += 1
                stat_error_types[type(exc).__name__] += 1
                size = 0
            return {
                "exists": True,
                "file_count": 1,
                "directory_count": 0,
                "total_bytes": size,
                "truncated": False,
                "stat_error_count": stat_error_count,
                "stat_error_types": dict(sorted(stat_error_types.items())),
                "degraded": stat_error_count > 0,
            }
    total_bytes = 0
    file_count = 0
    directory_count = 0
    newest_mtime: int | None = None
    largest_file_bytes = 0
    largest_file_hash: str | None = None
    truncated = False
    for root, dirs, files in os.walk(path):
        directory_count += len(dirs)
        for name in files:
            candidate = Path(root) / name
            try:
                stat_result = candidate.stat()
            except OSError as exc:
                stat_error_count += 1
                stat_error_types[type(exc).__name__] += 1
                continue
            file_count += 1
            total_bytes += stat_result.st_size
            newest_mtime = max(newest_mtime or 0, int(stat_result.st_mtime))
            if stat_result.st_size > largest_file_bytes:
                largest_file_bytes = stat_result.st_size
                largest_file_hash = sha256_16(str(candidate))
            if file_count >= max_files:
                truncated = True
                break
        if truncated:
            break
    return {
        "exists": True,
        "file_count": file_count,
        "directory_count": directory_count,
        "total_bytes": total_bytes,
        "total_mb": round(total_bytes / (1024 * 1024), 2),
        "newest_mtime": newest_mtime,
        "largest_file_bytes": largest_file_bytes,
        "largest_file_sha256_16": largest_file_hash,
        "stat_error_count": stat_error_count,
        "stat_error_types": dict(sorted(stat_error_types.items())),
        "degraded": stat_error_count > 0,
        "truncated": truncated,
    }


def state_store_rows(surfaces: tuple[StateSurface, ...] = DEFAULT_STATE_SURFACES) -> list[dict[str, Any]]:
    rows = []
    for surface in surfaces:
        stats = directory_stats(surface.path)
        rows.append({
            "harness": surface.harness,
            "label": surface.label,
            "data_class": surface.data_class,
            "sensitivity": surface.sensitivity,
            "path_sha256_16": sha256_16(str(surface.path)),
            **stats,
        })
    return rows


def latest_codex_session_row(session_root: Path = HOME / ".codex/sessions") -> dict[str, Any]:
    candidates = [path for path in session_root.rglob("*.jsonl") if path.is_file()] if session_root.exists() else []
    if not candidates:
        return {"found": False, "session_root_sha256_16": sha256_16(str(session_root))}
    latest = max(candidates, key=lambda path: path.stat().st_mtime)
    return {
        "found": True,
        "session_root_sha256_16": sha256_16(str(session_root)),
        "latest_path_sha256_16": sha256_16(str(latest)),
        "latest_size_bytes": latest.stat().st_size,
        "latest_size_mb": round(latest.stat().st_size / (1024 * 1024), 2),
        "jsonl_file_count": len(candidates),
    }


def codex_budget_config(path: Path = HOME / ".codex/config.toml") -> dict[str, Any]:
    data = load_toml(path)
    if not isinstance(data, dict):
        return {"exists": path.exists(), "parse_status": "not_object_or_missing", "path_sha256_16": sha256_16(str(path))}
    context = data.get("model_context_window")
    compact = data.get("model_auto_compact_token_limit")
    tool_output = data.get("tool_output_token_limit")
    row = {
        "exists": True,
        "parse_status": "ok",
        "path_sha256_16": sha256_16(str(path)),
        "model_context_window": context if isinstance(context, int) else None,
        "model_auto_compact_token_limit": compact if isinstance(compact, int) else None,
        "tool_output_token_limit": tool_output if isinstance(tool_output, int) else None,
    }
    if isinstance(context, int) and context:
        if isinstance(compact, int):
            row["auto_compact_pct_of_context"] = round((compact / context) * 100, 2)
        if isinstance(tool_output, int):
            row["tool_output_pct_of_context"] = round((tool_output / context) * 100, 3)
    return row


def claude_budget_config(path: Path = HOME / ".claude/settings.json") -> dict[str, Any]:
    data = load_json(path)
    if not isinstance(data, dict):
        return {"exists": path.exists(), "parse_status": "not_object_or_missing", "path_sha256_16": sha256_16(str(path))}
    return {
        "exists": True,
        "parse_status": "ok",
        "path_sha256_16": sha256_16(str(path)),
        "autoCompactEnabled": data.get("autoCompactEnabled"),
        "fileCheckpointingEnabled": data.get("fileCheckpointingEnabled"),
        "effortLevel": data.get("effortLevel"),
        "teammateMode": data.get("teammateMode"),
    }


def opencode_budget_config(path: Path = HOME / ".config/opencode/opencode.json") -> dict[str, Any]:
    data = load_json(path)
    if not isinstance(data, dict):
        return {"exists": path.exists(), "parse_status": "not_object_or_missing", "path_sha256_16": sha256_16(str(path))}
    return {
        "exists": True,
        "parse_status": "ok",
        "path_sha256_16": sha256_16(str(path)),
        "has_compaction_key": "compaction" in data,
        "has_snapshot_key": "snapshot" in data,
        "has_disabled_providers_key": "disabled_providers" in data,
        "has_enabled_providers_key": "enabled_providers" in data,
        "default_agent": data.get("default_agent"),
    }


def issue(code: str, severity: str, evidence: dict[str, Any]) -> dict[str, Any]:
    return {"code": code, "severity": severity, "evidence": evidence}


def build_findings(
    codex_config: dict[str, Any],
    state_rows: list[dict[str, Any]],
    latest_codex: dict[str, Any],
    instruction_summary: dict[str, Any],
    opencode_stats: dict[str, Any],
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    total_instruction_tokens = int(instruction_summary.get("total_candidate_estimated_tokens") or 0)
    context = codex_config.get("model_context_window")
    if isinstance(context, int) and context and total_instruction_tokens:
        pct = round((total_instruction_tokens / context) * 100, 3)
        if pct > 1:
            findings.append(issue("instruction_budget_over_1pct_codex_context", "low", {
                "estimated_tokens": total_instruction_tokens,
                "context_window": context,
                "pct": pct,
            }))
    for row in state_rows:
        total_bytes = int(row.get("total_bytes") or 0)
        if total_bytes >= STATE_HIGH_BYTES:
            findings.append(issue("state_store_over_1gb", "high", {
                "harness": row["harness"],
                "label": row["label"],
                "total_mb": row.get("total_mb"),
                "file_count": row.get("file_count"),
            }))
        elif total_bytes >= STATE_WARN_BYTES:
            findings.append(issue("state_store_over_500mb", "medium", {
                "harness": row["harness"],
                "label": row["label"],
                "total_mb": row.get("total_mb"),
                "file_count": row.get("file_count"),
            }))
    if latest_codex.get("found") and int(latest_codex.get("latest_size_bytes") or 0) >= CODEX_SESSION_WARN_BYTES:
        findings.append(issue("large_latest_codex_session_jsonl", "medium", {
            "latest_size_mb": latest_codex.get("latest_size_mb"),
            "threshold_mb": round(CODEX_SESSION_WARN_BYTES / (1024 * 1024), 2),
        }))
    if (opencode_stats.get("top_tool_share_pct") or 0) >= TOOL_CONCENTRATION_WARN_PCT:
        findings.append(issue("opencode_tool_usage_concentrated", "medium", {
            "top_tool_share_pct": opencode_stats.get("top_tool_share_pct"),
            "threshold_pct": TOOL_CONCENTRATION_WARN_PCT,
            "top_tool_name": opencode_stats.get("top_tools", [{}])[0].get("tool_name") if opencode_stats.get("top_tools") else None,
        }))
    ratio = opencode_stats.get("cache_read_to_input_ratio")
    if isinstance(ratio, (int, float)) and ratio >= 2:
        findings.append(issue("opencode_cache_read_exceeds_input_2x", "low", {
            "cache_read_to_input_ratio": ratio,
        }))
    return findings


def build_report(
    *,
    include_opencode_stats: bool = True,
    opencode_days: int = 7,
    opencode_stats_text: str | None = None,
    state_surfaces: tuple[StateSurface, ...] = DEFAULT_STATE_SURFACES,
    instruction_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    codex_config = codex_budget_config()
    claude_config = claude_budget_config()
    opencode_config = opencode_budget_config()
    state_rows = state_store_rows(state_surfaces)
    latest_codex = latest_codex_session_row()
    instruction_report = instruction_report or build_instruction_budget()
    instruction_summary = instruction_report.get("summary", {}) if isinstance(instruction_report, dict) else {}
    if opencode_stats_text is not None:
        opencode_stats = parse_opencode_stats_output(opencode_stats_text, "", 0, opencode_days)
    elif include_opencode_stats:
        opencode_stats = run_opencode_stats(opencode_days)
    else:
        opencode_stats = {"status": "skipped", "days_requested": opencode_days}
    findings = build_findings(codex_config, state_rows, latest_codex, instruction_summary, opencode_stats)
    severity_counts = Counter(str(item["severity"]) for item in findings)
    issue_counts = Counter(str(item["code"]) for item in findings)
    total_state_bytes = sum(int(row.get("total_bytes") or 0) for row in state_rows)
    return {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "proof_class": "local_runtime_budget_metadata",
        "redaction": (
            "metadata-only runtime budget rail; emits config limits, state-store byte/file counts, "
            "path hashes, rough instruction-token estimates, aggregate OpenCode usage counts, "
            "tool names, and findings; does not emit raw transcripts, tool inputs, tool outputs, "
            "provider payloads, raw paths, OpenCode stats text, model names, auth values, or secrets"
        ),
        "thresholds": {
            "state_warn_bytes": STATE_WARN_BYTES,
            "state_high_bytes": STATE_HIGH_BYTES,
            "codex_session_warn_bytes": CODEX_SESSION_WARN_BYTES,
            "tool_concentration_warn_pct": TOOL_CONCENTRATION_WARN_PCT,
        },
        "summary": {
            "finding_count": len(findings),
            "issue_code_counts": dict(sorted(issue_counts.items())),
            "severity_counts": dict(sorted(severity_counts.items())),
            "state_surface_count": len(state_rows),
            "state_total_mb": round(total_state_bytes / (1024 * 1024), 2),
            "instruction_candidate_estimated_tokens": instruction_summary.get("total_candidate_estimated_tokens"),
            "opencode_stats_status": opencode_stats.get("status"),
            "opencode_days": opencode_days,
        },
        "config_limits": {
            "codex": codex_config,
            "claude": claude_config,
            "opencode": opencode_config,
        },
        "state_stores": state_rows,
        "latest_codex_session": latest_codex,
        "instruction_budget_summary": instruction_summary,
        "opencode_stats": opencode_stats,
        "findings": findings,
        "limitations": [
            "Budget rail uses local metadata and aggregate historical stats only; it does not prove current-turn context pressure.",
            "Instruction token counts use the instruction_budget_auditor rough chars/4 estimate, not provider tokenizers.",
            "State-store sizes do not inspect transcript contents or prove retention safety.",
            "OpenCode stats parsing uses local text output and suppresses raw output and model names.",
            "No provider calls, MCP calls, SSH, config mutation, or raw transcript reads are performed.",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Emit a metadata-only runtime budget rail.")
    parser.add_argument("--no-opencode-stats", action="store_true", help="Skip local opencode stats aggregation.")
    parser.add_argument("--opencode-days", type=int, default=7)
    parser.add_argument("--pretty", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(include_opencode_stats=not args.no_opencode_stats, opencode_days=args.opencode_days)
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
