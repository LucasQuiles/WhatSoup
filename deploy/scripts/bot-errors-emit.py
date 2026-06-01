#!/usr/bin/env python3
"""Write a BOT ERRORS event to the local durable outbox."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import re
import shlex
import socket
import sys
import time
import uuid
from typing import Any


SEVERITIES = ("critical", "error", "warning", "info")
EVENT_TYPES = ("alert", "clear")
MAX_EVIDENCE_CHARS = 12000
SECRETISH_ASSIGNMENT = re.compile(
    r"\b(api[_-]?key|token|secret|password|cookie|credential)\b(\s*[:=]\s*)([\"']?)[^\s\"',}]+",
    re.I,
)
AUTHORIZATION_BEARER = re.compile(r"\bAuthorization:\s*Bearer\s+[^\s\"',}]+", re.I)
BEARER_VALUE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+")
AWS_ACCESS_KEY_ID = re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")
GITHUB_TOKEN = re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b")
JWT_VALUE = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")
PEM_PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----", re.S)
URL_USERINFO = re.compile(r"\b(https?://)[^\s/@:]+:[^\s/@]+@", re.I)
PHONE_LIKE = re.compile(r"(^|[^\w])(\+?(?:\d[\d\s().-]{8,}\d))(?![\w])")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def state_root() -> Path:
    return Path(os.environ.get("BOT_ERRORS_STATE_DIR", Path.home() / ".local/state/bot-errors"))


def outbox_dir() -> Path:
    return Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", state_root() / "outbox"))


def writefail_dirs() -> list[Path]:
    """Fallback breadcrumb locations, most-durable-first, for recording a lost
    alert when the primary outbox is unwritable (disk full / RO mount / perms).

    Each candidate is deliberately on a different subtree from the outbox so the
    same failure that defeated the outbox does not also defeat the breadcrumb.
    The first writable one wins.
    """
    candidates: list[Path] = []
    override = os.environ.get("BOT_ERRORS_WRITEFAIL_DIR")
    if override:
        candidates.append(Path(override))
    candidates.append(state_root() / "writefail")
    candidates.append(Path.home() / ".bot-errors-writefail")
    candidates.append(Path(os.environ.get("TMPDIR", "/tmp")) / "bot-errors-writefail")
    # De-dup while preserving order.
    seen: set[str] = set()
    ordered: list[Path] = []
    for path in candidates:
        key = str(path)
        if key not in seen:
            seen.add(key)
            ordered.append(path)
    return ordered


def host_sys_platform() -> str:
    return os.environ.get("BOT_ERRORS_DRY_SYS_PLATFORM", sys.platform)


def host_system() -> str:
    return os.environ.get("BOT_ERRORS_DRY_PLATFORM_SYSTEM", platform.system())


def host_release() -> str:
    return os.environ.get("BOT_ERRORS_DRY_PLATFORM_RELEASE", platform.release())


def is_wsl() -> bool:
    release = host_release().lower()
    return host_sys_platform() == "linux" and (
        "microsoft" in release
        or "wsl" in release
        or bool(os.environ.get("WSL_DISTRO_NAME"))
    )


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.chmod(0o700)
    except OSError:
        pass


def redact(value: Any) -> str:
    text = "" if value is None else str(value)
    text = PEM_PRIVATE_KEY.sub("[REDACTED PEM PRIVATE KEY]", text)
    text = URL_USERINFO.sub(r"\1[REDACTED]@", text)
    text = AWS_ACCESS_KEY_ID.sub("[REDACTED AWS ACCESS KEY]", text)
    text = GITHUB_TOKEN.sub("[REDACTED GITHUB TOKEN]", text)
    text = JWT_VALUE.sub("[REDACTED JWT]", text)
    text = AUTHORIZATION_BEARER.sub("Authorization: Bearer [REDACTED]", text)
    text = SECRETISH_ASSIGNMENT.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}[REDACTED]", text)
    text = BEARER_VALUE.sub("Bearer [REDACTED]", text)
    return PHONE_LIKE.sub(
        lambda m: f"{m.group(1)}[REDACTED PHONE]"
        if 10 <= len(re.sub(r"\D", "", m.group(2))) <= 15
        else m.group(0),
        text,
    )


def truncate(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 32] + f"\n[truncated {len(value) - limit + 32} chars]"


def safe_segment(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    return (cleaned or "unknown")[:80]


def safe_filename(value: str, max_length: int = 180) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    cleaned = cleaned or "unknown"
    if len(cleaned) <= max_length:
        return cleaned
    for suffix in (".writefail", ".json"):
        if cleaned.endswith(suffix) and len(suffix) < max_length:
            stem = cleaned[: max_length - len(suffix)].rstrip("._-:")
            return f"{stem or 'unknown'}{suffix}"
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


def env_keys() -> list[str]:
    patterns = (
        re.compile(r"^LOG_DIR$"),
        re.compile(r"^NODE_ENV$"),
        re.compile(r"^WHATSOUP_"),
        re.compile(r"^BOT_ERRORS_"),
        re.compile(r"^XDG_"),
        re.compile(r"^SYSTEMD_"),
        re.compile(r"^INVOCATION_ID$"),
    )
    return sorted(
        key for key in os.environ
        if any(pattern.search(key) for pattern in patterns)
        and not re.search(r"TOKEN|SECRET|KEY|PASSWORD|COOKIE|CREDENTIAL", key, re.I)
    )


def log_hints(instance: str, explicit: list[str]) -> list[str]:
    hints = [hint for hint in explicit if hint]
    log_dir = os.environ.get("LOG_DIR")
    if log_dir:
        hints.append(str(Path(log_dir) / "whatsoup.log"))
    if instance:
        if host_sys_platform() == "darwin":
            hints.append(f"launchctl print gui/$(id -u)/{instance}")
            hints.append(f"log show --last 30m --predicate 'process == \"{instance}\"'")
        elif is_wsl():
            hints.append(f"ps -eo pid,etime,cmd | grep -F {shlex.quote(instance)}")
            hints.append(str(Path.home() / ".claude/observability/runtime"))
            hints.append(str(Path.home() / ".claude/observability/sessions"))
        else:
            hints.append(f"journalctl --user -u {instance}.service --since '30 minutes ago'")
            hints.append(f"journalctl --user -u whatsoup@{instance}.service --since '30 minutes ago'")
    if host_sys_platform() == "darwin":
        hints.append(str(state_root() / "logs/dispatcher.out.log"))
        hints.append(str(state_root() / "logs/collector.jsonl"))
    elif is_wsl():
        hints.append(str(state_root() / "outbox"))
        hints.append(str(state_root() / "relayed"))
    else:
        hints.append("journalctl --user -u bot-errors-dispatcher.service --since '30 minutes ago'")
    return list(dict.fromkeys(hints))[:8]


def read_evidence(args: argparse.Namespace) -> str:
    parts = [args.evidence or ""]
    for path in args.evidence_file or []:
        try:
            parts.append(Path(path).read_text(encoding="utf-8", errors="replace"))
        except Exception as exc:  # noqa: BLE001 - diagnostics must survive bad evidence paths.
            parts.append(f"[failed to read evidence file {path}: {exc}]")
    return truncate(redact("\n".join(part for part in parts if part)), MAX_EVIDENCE_CHARS)


def parse_diagnostics(values: list[str] | None) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for value in values or []:
        key, sep, val = value.partition("=")
        if not sep:
            parsed[safe_segment(key)] = ""
        else:
            parsed[safe_segment(key)] = redact(val)
    return parsed


def build_event(args: argparse.Namespace) -> dict[str, Any]:
    event_type = args.event_type
    severity = args.severity or ("info" if event_type == "clear" else "critical")
    instance = args.instance.strip() or "unknown"
    source = args.source.strip() or "unknown"
    created = now_iso()
    event_id = args.event_id or str(uuid.uuid4())
    return {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": event_type,
        "severity": severity,
        "createdAt": created,
        "machine": socket.gethostname(),
        "platform": f"{host_system()} {host_release()}",
        "instance": instance,
        "source": source,
        "summary": truncate(redact(args.summary.strip() or f"{event_type} event from {source}"), 500),
        "evidence": read_evidence(args),
        "process": {
            "pid": os.getpid(),
            "ppid": os.getppid(),
            "cwd": os.getcwd(),
            "argv": [redact(part) for part in sys.argv],
            "execPath": sys.executable,
            "python": platform.python_version(),
        },
        "runtime": {
            "envKeys": env_keys(),
            "invocationId": os.environ.get("INVOCATION_ID"),
            "systemdExecPid": os.environ.get("SYSTEMD_EXEC_PID"),
        },
        "diagnostics": {
            "logHints": log_hints(instance, args.log_hint or []),
            "queue": str(outbox_dir()),
            **parse_diagnostics(args.diagnostic),
        },
        "delivery": {
            "attempts": 0,
            "status": "queued",
            "nextAttemptAtEpoch": 0,
            "lastError": None,
        },
    }


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
        try:
            dir_fd = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
        except OSError:
            return
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def write_event(event: dict[str, Any]) -> Path:
    outbox = outbox_dir()
    created = str(event["createdAt"]).replace("-", "").replace(":", "")
    file_name = f"{created}.{safe_segment(str(event['instance']))}.{safe_segment(str(event['source']))}.{event['id']}.json"
    final = safe_child_path(outbox, file_name)
    atomic_write_json(final, event)
    return final


def record_writefail(event: dict[str, Any], exc: BaseException, target: Path) -> Path | None:
    """Best-effort lost-alert breadcrumb when the primary outbox write fails.

    Leaves at least two traces so a disk-full / RO-mount / perms failure on the
    outbox cannot make a qualifying alert vanish silently:
      1. a loud stderr line (captured by journald / launchd for the emitting unit)
      2. a durable breadcrumb file in the first writable fallback dir, carrying the
         already-redacted event so the alert is fully reconstructable / replayable.

    NEVER raises — a breadcrumb failure must not mask the original write failure.
    Returns the breadcrumb path if one was written, else None.
    """
    reason = f"{type(exc).__name__}: {exc}"
    event_id = event.get("id")
    instance = event.get("instance")

    # Trace 1 — loud stderr (always attempted, even if the file write later fails).
    try:
        sys.stderr.write(
            f"[bot-errors] CRITICAL outbox write FAILED for {target}: {redact(reason)}; "
            f"id={event_id} instance={instance} source={event.get('source')} "
            f"severity={event.get('severity')} — recording breadcrumb\n"
        )
        sys.stderr.flush()
    except Exception:  # noqa: BLE001 - stderr must never crash the breadcrumb path.
        pass

    # Trace 2 — durable breadcrumb file in the first writable fallback location.
    breadcrumb = {
        "schemaVersion": 1,
        "kind": "outbox_write_failure",
        "recordedAt": now_iso(),
        "failedTarget": str(target),
        "reason": redact(reason),
        "emitPid": os.getpid(),
        "event": event,
    }
    data = (json.dumps(breadcrumb, indent=2, sort_keys=True) + "\n").encode("utf-8")
    stamp = now_iso().replace("-", "").replace(":", "")
    name = f"{stamp}.{safe_segment(str(instance))}.{safe_segment(str(event_id))}.writefail"
    for base in writefail_dirs():
        tmp_path: Path | None = None
        try:
            path = safe_child_path(base, name)
            tmp_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
            fd = os.open(tmp_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, path)
            try:
                dir_fd = os.open(base, os.O_DIRECTORY | os.O_RDONLY)
            except OSError:
                dir_fd = None
            if dir_fd is not None:
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            try:
                sys.stderr.write(f"[bot-errors] lost-alert breadcrumb written: {path}\n")
                sys.stderr.flush()
            except Exception:  # noqa: BLE001
                pass
            return path
        except Exception:  # noqa: BLE001 - try the next fallback location.
            if tmp_path is not None:
                try:
                    tmp_path.unlink()
                except OSError:
                    pass
            continue

    # Trace 2 failed everywhere — last resort: dump the event to stderr so it is at
    # least in the journal rather than entirely lost.
    try:
        sys.stderr.write(
            "[bot-errors] breadcrumb write failed in ALL fallback dirs; "
            f"lost-event payload follows:\n{json.dumps(event, sort_keys=True)}\n"
        )
        sys.stderr.flush()
    except Exception:  # noqa: BLE001
        pass
    return None


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Enqueue a BOT ERRORS event")
    parser.add_argument("--event-type", choices=EVENT_TYPES, default="alert")
    parser.add_argument("--event-id")
    parser.add_argument("--severity", choices=SEVERITIES)
    parser.add_argument("--instance", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--evidence", default="")
    parser.add_argument("--evidence-file", action="append")
    parser.add_argument("--log-hint", action="append")
    parser.add_argument("--diagnostic", action="append", help="Extra diagnostic key=value; may be repeated")
    parser.add_argument("--print-path", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    event = build_event(args)
    try:
        path = write_event(event)
    except Exception as exc:  # noqa: BLE001 - a lost alert must be recorded, then fail loud.
        record_writefail(event, exc, outbox_dir())
        return 1
    if args.print_path:
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
