#!/usr/bin/env python3
"""Run a command and enqueue a BOT ERRORS event if it fails."""

from __future__ import annotations

import argparse
import getpass
import hashlib
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

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.bot_errors_envelope import new_event_fields
from lib.bot_errors_redaction import redact_bot_errors_text, redact_json_value as redact_shared_json_value
from lib.durable_json import (
    JsonVersion,
    durable_json_target,
    operation_id,
    publish_event_json,
    require_advance,
)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def state_root() -> Path:
    explicit = os.environ.get("BOT_ERRORS_STATE_DIR")
    if explicit and explicit.strip():
        return Path(explicit)
    test_state = test_state_root()
    return test_state or (Path.home() / ".local/state/bot-errors")


STRONG_TEST_SIGNAL_KEYS = ("VITEST", "VITEST_WORKER_ID", "JEST_WORKER_ID", "PYTEST_CURRENT_TEST")


def env_value(key: str) -> str | None:
    value = os.environ.get(key)
    return value.strip() if value and value.strip() else None


def strong_test_signals() -> list[str]:
    return [key for key in STRONG_TEST_SIGNAL_KEYS if env_value(key)]


def provenance_signals() -> list[str]:
    signals = strong_test_signals()
    if os.environ.get("NODE_ENV", "").strip().lower() == "test":
        signals.append("NODE_ENV")
    return sorted(set(signals))


def test_state_root() -> Path | None:
    if not strong_test_signals():
        return None
    cwd_hash = hashlib.sha256(os.getcwd().encode("utf-8")).hexdigest()[:12]
    worker = safe_segment(env_value("VITEST_WORKER_ID") or env_value("JEST_WORKER_ID") or f"pid-{os.getpid()}")
    return Path(os.environ.get("TMPDIR", "/tmp")) / "whatsoup-vitest-bot-errors" / f"{cwd_hash}.{worker}"


def canonical_path(path: Path) -> Path:
    try:
        return path.expanduser().resolve(strict=True)
    except OSError:
        try:
            return path.expanduser().parent.resolve(strict=True) / path.name
        except OSError:
            return path.expanduser().absolute()


def live_outbox_candidates() -> list[Path]:
    candidates = [Path.home() / ".local/state/bot-errors/outbox"]
    override = env_value("BOT_ERRORS_LIVE_OUTBOX_DIR")
    if override:
        candidates.append(Path(override))
    return [canonical_path(path) for path in candidates]


def test_live_outbox_allowed() -> bool:
    return os.environ.get("BOT_ERRORS_ALLOW_TEST_LIVE_OUTBOX", "").strip().lower() in {"1", "true", "yes", "on"}


def resolve_outbox_dir() -> tuple[Path, dict[str, Any]]:
    explicit_outbox = env_value("BOT_ERRORS_OUTBOX_DIR")
    explicit_state = env_value("BOT_ERRORS_STATE_DIR")
    test_state = test_state_root()
    policy = "default"
    outbox = Path.home() / ".local/state/bot-errors/outbox"
    if explicit_outbox:
        outbox = Path(explicit_outbox)
        policy = "explicit-outbox"
    elif explicit_state:
        outbox = Path(explicit_state) / "outbox"
        policy = "explicit-state"
    elif test_state:
        outbox = test_state / "outbox"
        policy = "test-default"
    original = outbox
    if strong_test_signals() and not test_live_outbox_allowed() and canonical_path(outbox) in live_outbox_candidates():
        outbox = (test_state or (Path(os.environ.get("TMPDIR", "/tmp")) / "whatsoup-vitest-bot-errors" / f"pid-{os.getpid()}")) / "outbox"
        policy = "test-redirect"
    provenance = {
        "producer": "python-runner",
        "test": bool(strong_test_signals()),
        "signals": provenance_signals(),
        "strongSignals": strong_test_signals(),
        "outboxPolicy": policy,
        "liveOutboxRedirected": outbox != original,
        "resolvedOutbox": str(outbox),
    }
    return outbox, provenance


def outbox_dir() -> Path:
    return resolve_outbox_dir()[0]


def runtime_provenance() -> dict[str, Any]:
    return resolve_outbox_dir()[1]



def writefail_dirs() -> list[Path]:
    candidates: list[Path] = []
    override = os.environ.get("BOT_ERRORS_WRITEFAIL_DIR")
    if override:
        candidates.append(Path(override))
    candidates.append(state_root() / "writefail")
    candidates.append(Path.home() / ".bot-errors-writefail")
    candidates.append(Path(os.environ.get("TMPDIR", "/tmp")) / "bot-errors-writefail")
    seen: set[str] = set()
    ordered: list[Path] = []
    for path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        ordered.append(path)
    return ordered


def ensure_private_dir(path: Path) -> None:
    try:
        path.lstat()
    except FileNotFoundError:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    else:
        if path.is_symlink():
            raise RuntimeError(f"refusing to use private directory through symlink: {path}")
        if not os.path.isdir(path):
            raise RuntimeError(f"refusing to use private directory over non-directory path: {path}")
    try:
        path.chmod(0o700)
    except OSError:
        pass


def redact(value: Any) -> str:
    return redact_bot_errors_text(value, credential_path_marker="[REDACTED CREDENTIAL PATH]")


def truncate(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[-limit:]


def safe_segment(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    return (cleaned or "unknown")[:80]


def safe_filename(value: str, max_length: int = 180) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    cleaned = cleaned or "unknown"
    if len(cleaned) <= max_length:
        return cleaned
    if cleaned.endswith(".json") and max_length > len(".json"):
        stem = cleaned[: max_length - len(".json")].rstrip("._-:")
        return f"{stem or 'unknown'}.json"
    return cleaned[:max_length]


def safe_child_path(directory: Path, name: str) -> Path:
    ensure_private_dir(directory)
    directory_resolved = directory.resolve()
    first = directory / safe_filename(name)
    candidates = [first]
    if first.exists():
        stem = safe_filename(name, 140)
        prefix = f"{int(time.time())}.{os.getpid()}"
        candidates = [directory / f"{prefix}.{counter}.{stem}" for counter in range(1000)]
    for target in candidates:
        if target.resolve().parent != directory_resolved:
            raise RuntimeError(f"unsafe child path escaped {directory}: {name}")
        if not target.exists():
            return target
    raise RuntimeError(f"no available child path in {directory}: {name}")


def parse_diagnostics(values: list[str] | None) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for value in values or []:
        key, sep, val = value.partition("=")
        parsed[safe_segment(key)] = redact(val if sep else "")
    return parsed


def redact_json_value(value: Any) -> Any:
    return redact_shared_json_value(value, redact)


def write_event(event: dict[str, Any]) -> Path:
    outbox = outbox_dir()
    created = str(event["createdAt"]).replace("-", "").replace(":", "")
    path = safe_child_path(outbox, ".".join([
        created,
        safe_segment(str(event["instance"])),
        safe_segment(str(event["source"])),
        safe_segment(str(event["id"])),
        "json",
    ]))
    publication_target = durable_json_target(
        trusted_root=path.parent.resolve(strict=True),
        relative_path=path.name,
    )
    absent = JsonVersion(False, None, None, None)
    publication_operation = operation_id(
        publication_target,
        event,
        component="runner.event",
        predecessor=absent,
    )
    publication = publish_event_json(
        publication_target,
        event,
        component="runner.event",
        operation_id=publication_operation,
    )
    require_advance(publication)
    return path


def record_writefail(event: dict[str, Any], exc: BaseException, target: Path) -> Path | None:
    reason = f"{type(exc).__name__}: {exc}"
    event_id = event.get("id")
    instance = event.get("instance")
    try:
        sys.stderr.write(
            f"[bot-errors-runner] CRITICAL outbox write FAILED for {redact(str(target))}: {redact(reason)}; "
            f"id={event_id} instance={instance} source={event.get('source')} "
            f"severity={event.get('severity')} - recording breadcrumb\n"
        )
        sys.stderr.flush()
    except Exception:
        pass

    breadcrumb = {
        "schemaVersion": 1,
        "kind": "outbox_write_failure",
        "recordedAt": now_iso(),
        "failedTarget": redact(str(target)),
        "reason": redact(reason),
        "emitPid": os.getpid(),
        "event": redact_json_value(event),
    }
    stamp = now_iso().replace("-", "").replace(":", "")
    name = f"{stamp}.{safe_segment(str(instance))}.{safe_segment(str(event_id))}.writefail"
    for base in writefail_dirs():
        try:
            path = safe_child_path(base, name)
            publication_target = durable_json_target(
                trusted_root=path.parent.resolve(strict=True),
                relative_path=path.name,
            )
            absent = JsonVersion(False, None, None, None)
            publication_operation = operation_id(
                publication_target,
                breadcrumb,
                component="runner.writefail",
                predecessor=absent,
            )
            publication = publish_event_json(
                publication_target,
                breadcrumb,
                component="runner.writefail",
                operation_id=publication_operation,
            )
            require_advance(publication)
            try:
                sys.stderr.write(f"[bot-errors-runner] lost-alert breadcrumb written: {redact(str(path))}\n")
                sys.stderr.flush()
            except Exception:
                pass
            return path
        except Exception:
            continue

    try:
        lost_payload = json.dumps(redact_json_value(event), sort_keys=True)
        sys.stderr.write(
            "[bot-errors-runner] breadcrumb write failed in ALL fallback dirs; "
            f"lost-event payload follows:\n{lost_payload}\n"
        )
        sys.stderr.flush()
    except Exception:
        pass
    return None


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


def build_failure_event(
    args: argparse.Namespace,
    command: list[str],
    returncode: int,
    duration_ms: int,
    stdout: str,
    stderr: str,
    failure: str,
) -> dict[str, Any]:
    event_id = args.event_id or f"process-{safe_segment(args.instance)}-{safe_segment(args.source)}-{int(time.time())}-{uuid.uuid4().hex[:8]}"
    return {
        **new_event_fields("observation" if args.severity == "info" else "alert", args.severity),
        "id": event_id,
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
        "runtime": {"provenance": runtime_provenance()},
        "diagnostics": {
            "logHints": log_hints(args),
            "queue": str(outbox_dir()),
            **parse_diagnostics(args.diagnostic),
        },
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }


def emit_failure(
    args: argparse.Namespace,
    command: list[str],
    returncode: int,
    duration_ms: int,
    stdout: str,
    stderr: str,
    failure: str,
) -> Path:
    event = build_failure_event(args, command, returncode, duration_ms, stdout, stderr, failure)
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
        sys.stdout.write(redact(stdout))
    if stderr:
        sys.stderr.write(redact(stderr))
    if returncode != 0:
        event = build_failure_event(args, args.command, returncode, duration_ms, stdout, stderr, failure)
        try:
            path = write_event(event)
        except Exception as exc:  # noqa: BLE001 - the wrapped failure must not vanish if outbox write fails.
            record_writefail(event, exc, outbox_dir())
        else:
            print(f"bot-errors-runner: queued failure alert {path}", file=sys.stderr)
    return returncode


if __name__ == "__main__":
    raise SystemExit(main())
