#!/usr/bin/env python3
"""Append-only run ledger for agent-runtime probe execution.

The ledger records metadata about probe/guard/coverage runs without storing
stdout, stderr, config values, transcripts, or provider payloads.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

TOOL_DIR = Path(__file__).resolve().parent
PROBE_DIR = TOOL_DIR.parent
sys.path.insert(0, str(PROBE_DIR))

from probelib import SECRET_VALUE, redact  # noqa: E402

SCHEMA = "agent-runtime-run-ledger"
SCHEMA_VERSION = "0.1"
EVENT_SCHEMA = "agent-runtime-run-ledger-event"
DEFAULT_LEDGER = PROBE_DIR / "sentinel/ledger.jsonl"
DEFAULT_RECENT_N = 500


def utc_ts() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def canonical_json(obj: dict[str, Any]) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def self_hash(obj: dict[str, Any]) -> str:
    payload = {k: v for k, v in obj.items() if k != "self_hash"}
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()[:16]


def with_self_hash(obj: dict[str, Any]) -> dict[str, Any]:
    hashed = dict(obj)
    hashed["self_hash"] = self_hash(hashed)
    return hashed


def make_header() -> dict[str, Any]:
    return with_self_hash({
        "type": "header",
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "created_ts": utc_ts(),
    })


def normalize_event(event: dict[str, Any]) -> dict[str, Any]:
    safe = redact(dict(event))
    if not isinstance(safe, dict):
        safe = {"_error": "redaction_returned_non_object", "raw_type": type(event).__name__}
    normalized = {
        "type": "run",
        "run_schema": EVENT_SCHEMA,
        "run_schema_version": SCHEMA_VERSION,
        "ts": safe.get("ts") or utc_ts(),
        "kind": safe.get("kind") or "unknown",
        "name": safe.get("name") or "unknown",
        "duration_ms": int(safe.get("duration_ms") or 0),
        "exit": int(safe.get("exit") if safe.get("exit") is not None else -1),
        "schema_version": safe.get("schema_version"),
        "leak_hits": int(safe.get("leak_hits") or 0),
    }
    optional_keys = (
        "coverage_pct",
        "_error",
        "status",
        "stdout_bytes",
        "stderr_bytes",
        "command_hash",
        "schema_parse_status",
        "schema_parse_error_type",
    )
    for key in optional_keys:
        if key in safe and safe[key] is not None:
            normalized[key] = safe[key]
    normalized["status"] = normalized.get("status") or ("pass" if normalized["exit"] == 0 else "fail")
    # Value-level leak scrub: field-name redaction (above) misses a secret/path embedded in a benign-named
    # free-text field (e.g. name / _error). Independently scan + scrub the normalized string values rather
    # than trusting the caller's leak_hits. Clean events are unchanged (no new key, leak_hits intact), so
    # older readers and self-hashes are unaffected; only a genuinely leaky event gains leak_redacted=True.
    scrub_hits = 0
    for key, value in list(normalized.items()):
        scrubbed, hits = _scrub_value(value)
        if hits:
            normalized[key] = scrubbed
            scrub_hits += hits
    if scrub_hits:
        normalized["leak_hits"] = normalized["leak_hits"] + scrub_hits
        normalized["leak_redacted"] = True
    return with_self_hash(normalized)


def count_secret_hits(text: str) -> int:
    if not text:
        return 0
    return len(SECRET_VALUE.findall(text))


# Absolute filesystem paths are the dominant telemetry leak (error messages / names that carry a real
# path). Combined with SECRET_VALUE (the estate's secret-token shapes), this is a lightweight value-level
# leak scrub for the ledger's free-text fields — no heavy SSOT-pattern load on the record hot path.
LEAK_PATH = re.compile(r"/(?:Users|home|root|var|private|tmp|etc|opt)/[^\s\"'<>]+")


def _scrub_value(value: Any) -> tuple[Any, int]:
    """Redact a string value that carries a secret-token shape or an absolute filesystem path. Returns
    (possibly-redacted value, leak hit count). Non-strings and clean strings pass through unchanged."""
    if not isinstance(value, str):
        return value, 0
    hits = len(SECRET_VALUE.findall(value)) + len(LEAK_PATH.findall(value))
    if hits:
        return "<leak_redacted>", hits
    return value, 0


def _json_line(obj: dict[str, Any]) -> bytes:
    return (canonical_json(obj) + "\n").encode("utf-8")


@contextmanager
def locked_ledger(ledger_path: Path) -> Iterator[None]:
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = ledger_path.with_suffix(ledger_path.suffix + ".lock")
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def append_lines(ledger_path: Path, lines: list[dict[str, Any]]) -> None:
    payload = b"".join(_json_line(line) for line in lines)
    fd = os.open(str(ledger_path), os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)


def parse_lines(ledger_path: Path) -> dict[str, Any]:
    if not ledger_path.exists():
        return {"status": "no_ledger", "headers": [], "events": [], "error_type": None}
    headers: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    try:
        raw_lines = ledger_path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        return {"status": "ledger_error", "headers": [], "events": [], "error_type": type(exc).__name__}
    for index, line in enumerate(raw_lines, 1):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            return {"status": "ledger_corrupt", "headers": headers, "events": events, "error_type": "JSONDecodeError", "line": index}
        if not isinstance(obj, dict):
            return {"status": "ledger_corrupt", "headers": headers, "events": events, "error_type": "non_object_line", "line": index}
        if obj.get("self_hash") != self_hash(obj):
            return {"status": "ledger_corrupt", "headers": headers, "events": events, "error_type": "self_hash_mismatch", "line": index}
        if obj.get("type") == "header":
            headers.append(obj)
        elif obj.get("type") == "run":
            events.append(obj)
        else:
            return {"status": "ledger_corrupt", "headers": headers, "events": events, "error_type": "unknown_record_type", "line": index}
    return {"status": "ok", "headers": headers, "events": events, "error_type": None}


def compact_recent(ledger_path: Path, recent_n: int = DEFAULT_RECENT_N) -> dict[str, Any]:
    with locked_ledger(ledger_path):
        return _compact_recent_locked(ledger_path, recent_n)


def _compact_recent_locked(ledger_path: Path, recent_n: int) -> dict[str, Any]:
    parsed = parse_lines(ledger_path)
    if parsed["status"] != "ok":
        return {"status": parsed["status"], "error_type": parsed.get("error_type"), "kept": None}
    events = parsed["events"][-recent_n:] if recent_n >= 0 else parsed["events"]
    records = [make_header(), *events]
    tmp = ledger_path.with_name(f".{ledger_path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        with tmp.open("wb") as handle:
            for record in records:
                handle.write(_json_line(record))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, ledger_path)
    finally:
        if tmp.exists():
            tmp.unlink()
    return {"status": "ok", "error_type": None, "kept": len(events)}


def record(event: dict[str, Any], ledger_path: Path | None = None, recent_n: int = DEFAULT_RECENT_N) -> dict[str, Any]:
    if os.environ.get("AGENT_RUNTIME_LEDGER_DISABLE") == "1":
        return {"status": "disabled", "ledger": None, "error_type": None}
    path = (ledger_path or Path(os.environ.get("AGENT_RUNTIME_LEDGER_PATH", str(DEFAULT_LEDGER)))).expanduser()
    try:
        with locked_ledger(path):
            needs_header = not path.exists() or path.stat().st_size == 0
            lines = [make_header()] if needs_header else []
            lines.append(normalize_event(event))
            append_lines(path, lines)
            rotation = _compact_recent_locked(path, recent_n) if recent_n is not None else {"status": "skipped"}
        return {"status": "ok", "ledger": str(path), "rotation": rotation}
    except Exception as exc:  # diagnostic telemetry must not crash the observed run
        return {"status": "degraded", "ledger": str(path), "_error": f"{type(exc).__name__}: {exc}", "error_type": type(exc).__name__}


def summarize(ledger_path: Path) -> dict[str, Any]:
    parsed = parse_lines(ledger_path.expanduser())
    if parsed["status"] != "ok":
        return {"status": parsed["status"], "error_type": parsed.get("error_type"), "run_count": 0}
    events = parsed["events"]
    run_count = len(events)
    pass_count = sum(1 for event in events if event.get("exit") == 0)
    leak_values = [int(event.get("leak_hits") or 0) for event in events]
    coverage_values = [
        float(event["coverage_pct"])
        for event in events
        if isinstance(event.get("coverage_pct"), (int, float))
    ]
    return {
        "status": "ok",
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "run_count": run_count,
        "pass_rate": round(pass_count / run_count, 4) if run_count else None,
        "leak_trend": {
            "latest": leak_values[-1] if leak_values else None,
            "max": max(leak_values) if leak_values else None,
        },
        "coverage_trend": {
            "latest": coverage_values[-1] if coverage_values else None,
            "min": min(coverage_values) if coverage_values else None,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect or compact the agent-runtime run ledger.")
    parser.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER)
    parser.add_argument("--summary", action="store_true")
    parser.add_argument("--compact", type=int)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    if args.compact is not None:
        result = compact_recent(args.ledger.expanduser(), args.compact)
    else:
        result = summarize(args.ledger.expanduser())
    if not args.summary and args.compact is None:
        result = parse_lines(args.ledger.expanduser())
        result = {k: v for k, v in result.items() if k != "events"}
        result["event_count"] = len(parse_lines(args.ledger.expanduser()).get("events", []))
    json.dump(result, sys.stdout, indent=2 if args.pretty else None, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if result.get("status") in {"ok", "no_ledger"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
