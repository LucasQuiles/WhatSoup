#!/usr/bin/env python3
"""Stdout-preserving probe runner that records run metadata to the run ledger."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

TOOL_DIR = Path(__file__).resolve().parent
PROBE_DIR = TOOL_DIR.parent
sys.path.insert(0, str(TOOL_DIR))

import run_ledger  # noqa: E402

COVERAGE_RE = re.compile(r"OVERALL:\s+\d+/\d+\s+=\s+([0-9.]+)%")


def command_hash(argv: list[str]) -> str:
    return hashlib.sha256(json.dumps(argv, separators=(",", ":"), ensure_ascii=True).encode("utf-8")).hexdigest()[:16]


def resolve_command(command: list[str]) -> tuple[list[str], str, str]:
    if not command:
        raise ValueError("missing command")
    first = command[0]
    first_path = Path(first).expanduser()
    if first.endswith(".py"):
        script = first_path if first_path.exists() else PROBE_DIR / first
        if not script.exists():
            script = TOOL_DIR / first
        kind = "coverage" if script.name == "coverage_check.py" else ("guard" if script.name == "corpus_guard.py" else "probe")
        return [sys.executable, str(script), *command[1:]], kind, script.name
    return command, "command", Path(first).name


def extract_json_schema_info(stdout: str) -> dict[str, Any]:
    text = stdout.strip()
    if not text:
        return {"schema_version": None, "schema_parse_status": "empty", "schema_parse_error_type": None}
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return {"schema_version": None, "schema_parse_status": "non_json", "schema_parse_error_type": type(exc).__name__}
    if isinstance(data, dict) and isinstance(data.get("schema_version"), str):
        return {"schema_version": data["schema_version"], "schema_parse_status": "ok", "schema_parse_error_type": None}
    return {"schema_version": None, "schema_parse_status": "wrong_shape", "schema_parse_error_type": type(data).__name__}


def extract_json_schema(stdout: str) -> str | None:
    return extract_json_schema_info(stdout)["schema_version"]


def extract_coverage_pct(stdout: str) -> float | None:
    match = COVERAGE_RE.search(stdout)
    return float(match.group(1)) if match else None


def write_degraded(status: dict[str, Any]) -> None:
    marker = {"status": "degraded", "_error": status.get("_error") or status.get("error_type") or "ledger_write_failed"}
    print(f"RUN_LEDGER_DEGRADED {json.dumps(marker, sort_keys=True)}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a probe/command and ledger metadata while preserving stdout.")
    parser.add_argument("--ledger", type=Path, default=None)
    parser.add_argument("--recent-n", type=int, default=run_ledger.DEFAULT_RECENT_N)
    parser.add_argument("--kind", choices=["probe", "guard", "coverage", "command"], default=None)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    try:
        argv, inferred_kind, name = resolve_command(command)
    except ValueError as exc:
        print(f"runp error: {exc}", file=sys.stderr)
        return 2

    started = time.monotonic()
    try:
        proc = subprocess.run(argv, text=True, capture_output=True, check=False)
        stdout = proc.stdout
        stderr = proc.stderr
        exit_code = proc.returncode
    except FileNotFoundError as exc:
        stdout = ""
        stderr = f"{type(exc).__name__}: {exc}\n"
        exit_code = 127
    duration_ms = int((time.monotonic() - started) * 1000)

    sys.stdout.write(stdout)
    sys.stderr.write(stderr)

    schema_info = extract_json_schema_info(stdout)
    event = {
        "kind": args.kind or inferred_kind,
        "name": name,
        "duration_ms": duration_ms,
        "exit": exit_code,
        "schema_version": schema_info["schema_version"],
        "schema_parse_status": schema_info["schema_parse_status"],
        "schema_parse_error_type": schema_info["schema_parse_error_type"],
        "leak_hits": run_ledger.count_secret_hits(stdout) + run_ledger.count_secret_hits(stderr),
        "coverage_pct": extract_coverage_pct(stdout),
        "stdout_bytes": len(stdout.encode("utf-8", errors="replace")),
        "stderr_bytes": len(stderr.encode("utf-8", errors="replace")),
        "command_hash": command_hash(argv),
    }
    status = run_ledger.record(event, ledger_path=args.ledger, recent_n=args.recent_n)
    if status.get("status") not in {"ok", "disabled"}:
        write_degraded(status)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
