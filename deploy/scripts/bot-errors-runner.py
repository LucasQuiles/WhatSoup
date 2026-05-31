#!/usr/bin/env python3
"""Run a command and enqueue a BOT ERRORS event if it fails."""

from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
import platform
import re
import shlex
import socket
import subprocess
import sys
import time
import uuid
from typing import Any


SECRETISH_ASSIGNMENT = re.compile(
    r"\b(api[_-]?key|token|secret|password|cookie|credential)\b(\s*[:=]\s*)([\"']?)[^\s\"',}]+",
    re.I,
)
AUTHORIZATION_BEARER = re.compile(r"\bAuthorization:\s*Bearer\s+[^\s\"',}]+", re.I)
BEARER_VALUE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def state_root() -> Path:
    return Path(os.environ.get("BOT_ERRORS_STATE_DIR", Path.home() / ".local/state/bot-errors"))


def outbox_dir() -> Path:
    return Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", state_root() / "outbox"))


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.chmod(0o700)
    except OSError:
        pass


def redact(value: Any) -> str:
    text = "" if value is None else str(value)
    text = AUTHORIZATION_BEARER.sub("Authorization: Bearer [REDACTED]", text)
    text = SECRETISH_ASSIGNMENT.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}[REDACTED]", text)
    return BEARER_VALUE.sub("Bearer [REDACTED]", text)


def truncate(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[-limit:]


def safe_segment(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    return (cleaned or "unknown")[:80]


def parse_diagnostics(values: list[str] | None) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for value in values or []:
        key, sep, val = value.partition("=")
        parsed[safe_segment(key)] = redact(val if sep else "")
    return parsed


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    data = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def write_event(event: dict[str, Any]) -> Path:
    outbox = outbox_dir()
    ensure_private_dir(outbox)
    created = str(event["createdAt"]).replace("-", "").replace(":", "")
    path = outbox / ".".join([
        created,
        safe_segment(str(event["instance"])),
        safe_segment(str(event["source"])),
        safe_segment(str(event["id"])),
        "json",
    ])
    atomic_write_json(path, event)
    return path


def log_hints(args: argparse.Namespace) -> list[str]:
    hints = list(args.log_hint or [])
    service = os.environ.get("INVOCATION_ID")
    if service:
        hints.append(f"systemd_invocation_id={service}")
    unit = os.environ.get("BOT_ERRORS_UNIT") or os.environ.get("SYSTEMD_UNIT")
    if unit:
        hints.append(f"journalctl --user -u {unit} --since '30 minutes ago'")
    label = os.environ.get("BOT_ERRORS_LAUNCHD_LABEL")
    if label:
        hints.append(f"launchctl print gui/$(id -u)/{label}")
    hints.append(str(state_root() / "logs"))
    return list(dict.fromkeys(redact(hint) for hint in hints if hint))[:10]


def build_evidence(
    args: argparse.Namespace,
    command: list[str],
    returncode: int,
    duration_ms: int,
    stdout: str,
    stderr: str,
    failure: str,
) -> str:
    limit = args.capture_limit
    parts = [
        f"failure={failure}",
        f"host={socket.gethostname()}",
        f"user={getpass.getuser()}",
        f"uid={os.getuid()}",
        f"instance={args.instance}",
        f"source={args.source}",
        f"cwd={args.cwd or os.getcwd()}",
        f"command={shlex.join(command)}",
        f"exit_code={returncode}",
        f"duration_ms={duration_ms}",
    ]
    if args.diagnostic:
        parts.append("diagnostics:")
        parts.extend(f"  {item}" for item in args.diagnostic)
    if stdout:
        parts.append("stdout_tail:")
        parts.append(truncate(stdout, limit))
    if stderr:
        parts.append("stderr_tail:")
        parts.append(truncate(stderr, limit))
    return redact("\n".join(parts))


def emit_failure(
    args: argparse.Namespace,
    command: list[str],
    returncode: int,
    duration_ms: int,
    stdout: str,
    stderr: str,
    failure: str,
) -> Path:
    event_id = args.event_id or f"process-{safe_segment(args.instance)}-{safe_segment(args.source)}-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    event = {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": "alert",
        "severity": args.severity,
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": f"{platform.system()} {platform.release()}",
        "instance": args.instance,
        "source": args.source,
        "summary": redact(args.summary),
        "evidence": build_evidence(args, command, returncode, duration_ms, stdout, stderr, failure),
        "process": {
            "pid": os.getpid(),
            "ppid": os.getppid(),
            "cwd": os.getcwd(),
            "argv": [redact(part) for part in sys.argv],
            "execPath": sys.executable,
        },
        "diagnostics": {
            "logHints": log_hints(args),
            "queue": str(outbox_dir()),
            **parse_diagnostics(args.diagnostic),
        },
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    return write_event(event)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a command and emit BOT ERRORS on failure")
    parser.add_argument("--instance", required=True)
    parser.add_argument("--source", default="process-exit")
    parser.add_argument("--summary", required=True)
    parser.add_argument("--severity", default="critical", choices=("critical", "error", "warning", "info"))
    parser.add_argument("--event-id")
    parser.add_argument("--cwd")
    parser.add_argument("--timeout", type=float)
    parser.add_argument("--capture-limit", type=int, default=12_000)
    parser.add_argument("--log-hint", action="append")
    parser.add_argument("--diagnostic", action="append")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.command and args.command[0] == "--":
        args.command = args.command[1:]
    if not args.command:
        parser.error("command required after --")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    started = time.monotonic()
    stdout = ""
    stderr = ""
    failure = "nonzero_exit"
    try:
        proc = subprocess.run(
            args.command,
            cwd=args.cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=args.timeout,
            check=False,
        )
        stdout = proc.stdout or ""
        stderr = proc.stderr or ""
        returncode = proc.returncode
    except FileNotFoundError as exc:
        returncode = 127
        stderr = str(exc)
        failure = "exec_not_found"
    except subprocess.TimeoutExpired as exc:
        returncode = 124
        stdout = (exc.stdout or "") if isinstance(exc.stdout, str) else (exc.stdout or b"").decode(errors="replace")
        stderr = (exc.stderr or "") if isinstance(exc.stderr, str) else (exc.stderr or b"").decode(errors="replace")
        failure = "timeout"
    duration_ms = int((time.monotonic() - started) * 1000)
    if stdout:
        sys.stdout.write(stdout)
    if stderr:
        sys.stderr.write(stderr)
    if returncode != 0:
        path = emit_failure(args, args.command, returncode, duration_ms, stdout, stderr, failure)
        print(f"bot-errors-runner: queued failure alert {path}", file=sys.stderr)
    return returncode


if __name__ == "__main__":
    raise SystemExit(main())
