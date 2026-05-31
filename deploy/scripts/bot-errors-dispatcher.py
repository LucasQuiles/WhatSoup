#!/usr/bin/env python3
"""Drain the local BOT ERRORS outbox into the configured WhatSoup line.

The dispatcher is intentionally file based. Producers only need to land a
0600 JSON event in the local outbox; this process owns network delivery,
retry metadata, poison quarantine, and state reporting.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
from typing import Any


BOT_ERRORS_JID = os.environ.get("BOT_ERRORS_JID", "").strip()
DEFAULT_SOCKET = os.environ.get(
    "BOT_ERRORS_SOCKET_PATH",
    "",
).strip()
EMAIL_FALLBACK = os.environ.get(
    "BOT_ERRORS_EMAIL_FALLBACK",
    str(Path.home() / ".claude/scripts/email-alert-fallback.sh"),
)
MAX_MESSAGE_CHARS = int(os.environ.get("BOT_ERRORS_MAX_MESSAGE_CHARS", "5500"))
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


def state_paths() -> dict[str, Path]:
    root = state_root()
    return {
        "root": root,
        "outbox": Path(os.environ.get("BOT_ERRORS_OUTBOX_DIR", root / "outbox")),
        "processing": root / "processing",
        "sent": root / "sent",
        "suppressed": root / "suppressed",
        "quarantine": root / "quarantine",
        "writefail_recovered": root / "writefail-recovered",
        "writefail_quarantine": root / "writefail-quarantine",
        "locks": root / "locks",
        "logs": root / "logs",
        "state": root / "dispatcher-state.json",
    }


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.chmod(0o700)
    except OSError:
        pass


def setup_dirs() -> dict[str, Path]:
    paths = state_paths()
    for key in (
        "root",
        "outbox",
        "processing",
        "sent",
        "suppressed",
        "quarantine",
        "writefail_recovered",
        "writefail_quarantine",
        "locks",
        "logs",
    ):
        ensure_private_dir(paths[key])
    return paths


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    try:
        tmp.chmod(0o600)
    except OSError:
        pass
    os.replace(tmp, path)
    try:
        path.chmod(0o600)
    except OSError:
        pass


def append_dispatch_log(paths: dict[str, Path], payload: dict[str, Any]) -> None:
    ensure_private_dir(paths["logs"])
    log_path = paths["logs"] / "dispatch.jsonl"
    record = {"time": now_iso(), "pid": os.getpid(), **payload}
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")
    try:
        log_path.chmod(0o600)
    except OSError:
        pass


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("event JSON root must be an object")
    return data


def truncate(value: Any, limit: int) -> str:
    text = "" if value is None else str(value)
    if len(text) <= limit:
        return text
    return text[: limit - 32] + f"\n[truncated {len(text) - limit + 32} chars]"


def safe_segment(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    return (cleaned or "unknown")[:80]


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


def json_rpc_call(socket_path: str, method: str, params: dict[str, Any], timeout: float = 15.0) -> dict[str, Any]:
    if not socket_path:
        raise RuntimeError("socket path missing")
    if not os.path.exists(socket_path):
        raise RuntimeError(f"socket missing: {socket_path}")

    init_id = int(time.time() * 1000)
    call_id = init_id + 1
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(socket_path)
        reader = sock.makefile("r", encoding="utf-8", newline="\n")
        writer = sock.makefile("w", encoding="utf-8", newline="\n")

        writer.write(json.dumps({
            "jsonrpc": "2.0",
            "id": init_id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "bot-errors-dispatcher", "version": "1.0.0"},
            },
        }) + "\n")
        writer.flush()
        wait_for_response(reader, init_id, timeout)

        writer.write(json.dumps({
            "jsonrpc": "2.0",
            "id": call_id,
            "method": method,
            "params": params,
        }) + "\n")
        writer.flush()
        return wait_for_response(reader, call_id, timeout)


def wait_for_response(reader: Any, expected_id: int, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = reader.readline()
        if not line:
            raise RuntimeError("socket closed before response")
        msg = json.loads(line)
        if msg.get("id") != expected_id:
            continue
        if "error" in msg:
            raise RuntimeError(f"rpc error: {msg['error']}")
        result = msg.get("result", {})
        if isinstance(result, dict) and result.get("isError") is True:
            raise RuntimeError(f"tool error: {result}")
        return result if isinstance(result, dict) else {"result": result}
    raise RuntimeError("timeout waiting for JSON-RPC response")


def send_whatsapp(text: str, socket_path: str = DEFAULT_SOCKET) -> None:
    dry_capture = os.environ.get("BOT_ERRORS_DRY_SEND_CAPTURE")
    if dry_capture:
        capture_path = Path(dry_capture)
        ensure_private_dir(capture_path.parent)
        with capture_path.open("a", encoding="utf-8") as handle:
            handle.write(text + "\n---\n")
        return

    if not BOT_ERRORS_JID:
        raise RuntimeError("BOT_ERRORS_JID is required for live dispatch")
    if not socket_path:
        raise RuntimeError("BOT_ERRORS_SOCKET_PATH is required for live dispatch")

    result = json_rpc_call(
        socket_path,
        "tools/call",
        {"name": "send_message", "arguments": {"chatJid": BOT_ERRORS_JID, "text": text}},
    )
    if result.get("isError") is True:
        raise RuntimeError(f"send_message returned error: {result}")


def email_fallback(subject: str, body: str) -> bool:
    fallback = Path(EMAIL_FALLBACK)
    if not fallback.exists() or not os.access(fallback, os.X_OK):
        return False
    proc = subprocess.run(
        [str(fallback), "--subject", subject, "--body", body],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
        timeout=20,
        check=False,
    )
    return proc.returncode == 0


def event_line(label: str, value: Any, limit: int = 700) -> str | None:
    if value is None or value == "":
        return None
    rendered = redact(value).replace("@", " at ")
    return f"  > {label}: {truncate(rendered, limit)}"


def format_event(event: dict[str, Any]) -> str:
    event_type = str(event.get("eventType") or "alert")
    severity = str(event.get("severity") or "").lower()
    if event_type == "clear":
        title = "BOT RECOVERY"
    elif severity == "info":
        title = "BOT INFO"
    elif severity == "warning":
        title = "BOT WARNING"
    else:
        title = "BOT ERROR"
    summary = truncate(redact(event.get("summary") or "unspecified bot error").replace("@", " at "), 220)
    process_info = event.get("process") if isinstance(event.get("process"), dict) else {}
    diagnostics = event.get("diagnostics") if isinstance(event.get("diagnostics"), dict) else {}
    delivery = event.get("delivery") if isinstance(event.get("delivery"), dict) else {}
    log_hints = diagnostics.get("logHints") if isinstance(diagnostics.get("logHints"), list) else []
    writefail_recovery = (
        diagnostics.get("writefailRecovery")
        if isinstance(diagnostics.get("writefailRecovery"), dict)
        else None
    )
    writefail_harvest = (
        writefail_recovery.get("harvest")
        if isinstance(writefail_recovery, dict) and isinstance(writefail_recovery.get("harvest"), dict)
        else None
    )

    lines = [
        f"{title} - {summary}",
        event_line("severity", event.get("severity")),
        event_line("machine", event.get("machine")),
        event_line("instance", event.get("instance")),
        event_line("source", event.get("source")),
        event_line("event", event.get("id")),
        event_line("created", event.get("createdAt")),
        event_line(
            "writefail_recovered",
            (
                f"origin={event.get('machine') or event.get('machineName') or 'unknown'} "
                f"harvested_from={writefail_harvest.get('fromHost') if writefail_harvest else 'local'} "
                f"recorded={writefail_recovery.get('recordedAt')} "
                f"failed_target={writefail_recovery.get('failedTarget')} "
                f"breadcrumb={writefail_recovery.get('breadcrumb')}"
            )
            if writefail_recovery
            else None,
            900,
        ),
        event_line("dispatcher_attempts", delivery.get("attempts")),
        event_line("platform", event.get("platform")),
        event_line("pid", process_info.get("pid")),
        event_line("cwd", process_info.get("cwd")),
    ]
    for idx, hint in enumerate(log_hints[:5], start=1):
        lines.append(event_line(f"log_{idx}", hint, 900))
    requested_action = (
        "  > requested_action: none — informational event; no Q remediation required."
        if severity == "info"
        else "  > requested_action: Q investigate, remediate, and report disposition in BOT ERRORS."
    )
    lines.extend([
        event_line("queue", diagnostics.get("queue")),
        event_line("dispatch_log", diagnostics.get("dispatchLog")),
        event_line("evidence", event.get("evidence"), 1800),
        requested_action,
    ])
    text = "\n".join(line for line in lines if line)
    return truncate(text, MAX_MESSAGE_CHARS)


def next_backoff(attempts: int) -> int:
    if attempts <= 1:
        return 60
    if attempts == 2:
        return 300
    return 900


def mark_failure(event: dict[str, Any], error: str) -> dict[str, Any]:
    delivery = event.setdefault("delivery", {})
    if not isinstance(delivery, dict):
        delivery = {}
        event["delivery"] = delivery
    attempts = max(int(delivery.get("attempts") or 0), 1)
    delivery["status"] = "queued"
    delivery["lastError"] = truncate(redact(error), 500)
    delivery["nextAttemptAtEpoch"] = int(time.time()) + next_backoff(attempts)
    return event


def mark_attempt(event: dict[str, Any]) -> dict[str, Any]:
    delivery = event.setdefault("delivery", {})
    if not isinstance(delivery, dict):
        delivery = {}
        event["delivery"] = delivery
    delivery["attempts"] = int(delivery.get("attempts") or 0) + 1
    delivery["status"] = "sending"
    delivery["lastAttemptAt"] = now_iso()
    delivery["nextAttemptAtEpoch"] = 0
    return event


def mark_sent(event: dict[str, Any]) -> dict[str, Any]:
    delivery = event.setdefault("delivery", {})
    if isinstance(delivery, dict):
        delivery["status"] = "sent"
        delivery["sentAt"] = now_iso()
        delivery["lastError"] = None
    return event


def mark_suppressed(event: dict[str, Any], reason: str) -> dict[str, Any]:
    delivery = event.setdefault("delivery", {})
    if isinstance(delivery, dict):
        delivery["status"] = "suppressed"
        delivery["suppressedAt"] = now_iso()
        delivery["suppressedReason"] = reason
        delivery["lastError"] = None
    return event


def reset_delivery(event: dict[str, Any]) -> None:
    event["delivery"] = {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None}


def should_suppress_send(event: dict[str, Any]) -> str | None:
    if os.environ.get("BOT_ERRORS_SEND_DAILY_HEALTH_INFO", "").strip().lower() in {"1", "true", "yes", "on"}:
        return None
    source = str(event.get("source") or "")
    severity = str(event.get("severity") or "").lower()
    if source == "daily-health" and severity == "info":
        return "daily-health info events are retained for heartbeat freshness but not posted to BOT ERRORS"
    return None


def ready(path: Path, quarantine_dir: Path) -> bool:
    try:
        event = read_json(path)
    except Exception as exc:
        quarantine_poison(path, quarantine_dir, f"invalid JSON before claim: {exc}")
        return False
    delivery = event.get("delivery") if isinstance(event.get("delivery"), dict) else {}
    next_attempt = int(delivery.get("nextAttemptAtEpoch") or 0)
    return next_attempt <= int(time.time())


def quarantine_poison(path: Path, quarantine_dir: Path, reason: str) -> Path:
    ensure_private_dir(quarantine_dir)
    dest = quarantine_dir / f"{path.name}.{int(time.time())}.{os.getpid()}.poison"
    try:
        shutil.move(str(path), str(dest))
    except FileNotFoundError:
        return dest
    meta = {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "critical",
        "id": f"poison-{int(time.time())}-{os.getpid()}",
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "instance": "bot-errors-dispatcher",
        "source": "poison-event-quarantine",
        "summary": "BOT ERRORS dispatcher quarantined an unreadable event",
        "evidence": f"source={path}; quarantine={dest}; reason={reason}",
        "diagnostics": {
            "logHints": ["journalctl --user -u bot-errors-dispatcher.service --since '30 minutes ago'"],
            "queue": str(state_root()),
        },
        "delivery": {"attempts": 0, "status": "meta"},
    }
    text = format_event(meta)
    try:
        send_whatsapp(text)
    except Exception:
        email_fallback("BOT ERRORS poison event quarantine", text)
    try:
        append_dispatch_log(state_paths(), {
            "type": "quarantine",
            "sourcePath": str(path),
            "quarantinePath": str(dest),
            "reason": reason,
        })
    except Exception:
        pass
    return dest


def writefail_dirs() -> list[Path]:
    candidates: list[Path] = []
    override = os.environ.get("BOT_ERRORS_WRITEFAIL_DIR")
    if override:
        candidates.append(Path(override))
    candidates.append(state_root() / "writefail")
    candidates.append(Path(os.environ.get("TMPDIR", "/tmp")) / "bot-errors-writefail")
    candidates.append(Path.home() / ".bot-errors-writefail")
    seen: set[str] = set()
    ordered: list[Path] = []
    for path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        ordered.append(path)
    return ordered


def event_already_known(event_id: str, paths: dict[str, Path]) -> bool:
    if not event_id:
        return False
    for key in ("outbox", "processing", "sent", "suppressed", "quarantine"):
        directory = paths[key]
        if not directory.exists():
            continue
        for path in directory.glob("*"):
            if not path.is_file():
                continue
            try:
                if read_json(path).get("id") == event_id:
                    return True
            except Exception:
                continue
    return False


def outbox_path_for_event(event: dict[str, Any], paths: dict[str, Path]) -> Path:
    created = str(event.get("createdAt") or now_iso()).replace("-", "").replace(":", "")
    instance = safe_segment(str(event.get("instance") or "unknown"))
    source = safe_segment(str(event.get("source") or "unknown"))
    event_id = safe_segment(str(event.get("id") or f"recovered-{int(time.time())}-{os.getpid()}"))
    path = paths["outbox"] / f"{created}.{instance}.{source}.{event_id}.json"
    if path.exists():
        path = paths["outbox"] / f"{created}.{instance}.{source}.{event_id}.{int(time.time())}.{os.getpid()}.json"
    return path


def move_writefail(path: Path, target_dir: Path, suffix: str) -> Path:
    ensure_private_dir(target_dir)
    target = target_dir / f"{path.name}.{int(time.time())}.{suffix}"
    if target.exists():
        target = target_dir / f"{path.name}.{int(time.time())}.{os.getpid()}.{suffix}"
    shutil.move(str(path), str(target))
    try:
        target.chmod(0o600)
    except OSError:
        pass
    return target


def recover_writefail_breadcrumbs(paths: dict[str, Path], limit: int = 25) -> int:
    recovered = 0
    scanned = 0
    for base in writefail_dirs():
        if not base.exists():
            continue
        for path in sorted(base.glob("*.writefail")):
            if scanned >= limit:
                return recovered
            scanned += 1
            try:
                crumb = read_json(path)
                if crumb.get("kind") != "outbox_write_failure":
                    raise ValueError("writefail breadcrumb kind is not outbox_write_failure")
                event = crumb.get("event")
                if not isinstance(event, dict):
                    raise ValueError("writefail breadcrumb missing event object")
                event_id = str(event.get("id") or "")
                if event_already_known(event_id, paths):
                    duplicate = move_writefail(path, paths["writefail_recovered"], "duplicate")
                    append_dispatch_log(paths, {
                        "type": "writefail_duplicate",
                        "eventId": event_id,
                        "breadcrumb": str(path),
                        "path": str(duplicate),
                    })
                    continue
                diagnostics = event.setdefault("diagnostics", {})
                if not isinstance(diagnostics, dict):
                    diagnostics = {}
                    event["diagnostics"] = diagnostics
                diagnostics["writefailRecovery"] = {
                    "breadcrumb": str(path),
                    "failedTarget": crumb.get("failedTarget"),
                    "harvest": crumb.get("harvest") if isinstance(crumb.get("harvest"), dict) else None,
                    "reason": crumb.get("reason"),
                    "recordedAt": crumb.get("recordedAt"),
                    "recoveredAt": now_iso(),
                }
                log_hints = diagnostics.get("logHints")
                if isinstance(log_hints, list):
                    log_hints.append(str(path))
                else:
                    diagnostics["logHints"] = [str(path)]
                reset_delivery(event)
                outbox_path = outbox_path_for_event(event, paths)
                try:
                    atomic_write_json(outbox_path, event)
                except Exception as exc:  # noqa: BLE001 - keep breadcrumb for a later retry.
                    append_dispatch_log(paths, {
                        "type": "writefail_requeue_failed",
                        "eventId": event_id,
                        "breadcrumb": str(path),
                        "outboxPath": str(outbox_path),
                        "reason": str(exc),
                    })
                    return recovered
                recovered_path = move_writefail(path, paths["writefail_recovered"], "recovered")
                append_dispatch_log(paths, {
                    "type": "writefail_recovered",
                    "eventId": event_id,
                    "breadcrumb": str(path),
                    "path": str(recovered_path),
                    "outboxPath": str(outbox_path),
                })
                recovered += 1
            except Exception as exc:  # noqa: BLE001 - one bad breadcrumb must not block dispatch.
                try:
                    quarantined = move_writefail(path, paths["writefail_quarantine"], "poison")
                    append_dispatch_log(paths, {
                        "type": "writefail_quarantine",
                        "breadcrumb": str(path),
                        "path": str(quarantined),
                        "reason": str(exc),
                    })
                except Exception:
                    append_dispatch_log(paths, {
                        "type": "writefail_recovery_failed",
                        "breadcrumb": str(path),
                        "reason": str(exc),
                    })
    return recovered


def claim(path: Path, processing_dir: Path) -> Path:
    dest = processing_dir / f"{path.name}.{os.getpid()}.processing"
    os.replace(path, dest)
    return dest


def original_name_from_processing(path: Path) -> str:
    name = path.name
    marker = ".json."
    if marker in name and name.endswith(".processing"):
        return name.split(marker, 1)[0] + ".json"
    if name.endswith(".processing"):
        return name[: -len(".processing")]
    return name


def reclaim_processing(paths: dict[str, Path]) -> int:
    reclaimed = 0
    for path in sorted(paths["processing"].glob("*")):
        if not path.is_file():
            continue
        target = paths["outbox"] / original_name_from_processing(path)
        if target.exists():
            target = paths["outbox"] / f"{int(time.time())}.{path.name}.reclaimed.json"
        os.replace(path, target)
        append_dispatch_log(paths, {"type": "reclaim", "from": str(path), "to": str(target)})
        reclaimed += 1
    return reclaimed


def record_state(paths: dict[str, Path], **updates: Any) -> None:
    counts = {
        "outbox": len(list(paths["outbox"].glob("*.json"))),
        "processing": len(list(paths["processing"].glob("*"))),
        "suppressed": len(list(paths["suppressed"].glob("*"))),
        "quarantine": len(list(paths["quarantine"].glob("*"))),
        "writefail": sum(len(list(path.glob("*.writefail"))) for path in writefail_dirs() if path.exists()),
        "writefailRecovered": len(list(paths["writefail_recovered"].glob("*"))),
        "writefailQuarantine": len(list(paths["writefail_quarantine"].glob("*"))),
    }
    state = {
        "updatedAt": now_iso(),
        "pid": os.getpid(),
        "machine": socket.gethostname(),
        "counts": counts,
        **updates,
    }
    atomic_write_json(paths["state"], state)


def process_one(path: Path, paths: dict[str, Path]) -> tuple[bool, str]:
    claimed = claim(path, paths["processing"])
    try:
        event = read_json(claimed)
    except Exception as exc:
        quarantine_poison(claimed, paths["quarantine"], f"invalid JSON after claim: {exc}")
        return False, "poison"

    diagnostics = event.setdefault("diagnostics", {})
    if isinstance(diagnostics, dict):
        diagnostics["dispatchLog"] = str(paths["logs"] / "dispatch.jsonl")
    event = mark_attempt(event)
    atomic_write_json(claimed, event)
    suppress_reason = should_suppress_send(event)
    if suppress_reason:
        event = mark_suppressed(event, suppress_reason)
        atomic_write_json(claimed, event)
        suppressed_name = f"{path.name}.{int(time.time())}.suppressed"
        suppressed_path = paths["suppressed"] / suppressed_name
        os.replace(claimed, suppressed_path)
        append_dispatch_log(paths, {
            "type": "suppressed",
            "eventId": event.get("id"),
            "path": str(suppressed_path),
            "reason": suppress_reason,
            "source": event.get("source"),
            "severity": event.get("severity"),
            "attempts": event.get("delivery", {}).get("attempts") if isinstance(event.get("delivery"), dict) else None,
        })
        return True, "suppressed"

    text = format_event(event)
    try:
        send_whatsapp(text)
    except Exception as exc:
        event = mark_failure(event, str(exc))
        atomic_write_json(claimed, event)
        os.replace(claimed, paths["outbox"] / path.name)
        append_dispatch_log(paths, {
            "type": "send_failed",
            "eventId": event.get("id"),
            "path": str(paths["outbox"] / path.name),
            "attempts": event.get("delivery", {}).get("attempts") if isinstance(event.get("delivery"), dict) else None,
            "error": str(exc),
        })
        attempts = int(event.get("delivery", {}).get("attempts") or 0)
        if attempts >= 3:
            email_fallback(f"BOT ERRORS delivery failing: {event.get('summary', 'unknown')}", text)
        return False, str(exc)

    event = mark_sent(event)
    atomic_write_json(claimed, event)
    sent_name = f"{path.name}.{int(time.time())}.sent"
    os.replace(claimed, paths["sent"] / sent_name)
    append_dispatch_log(paths, {
        "type": "sent",
        "eventId": event.get("id"),
        "path": str(paths["sent"] / sent_name),
        "attempts": event.get("delivery", {}).get("attempts") if isinstance(event.get("delivery"), dict) else None,
    })
    return True, "sent"


def run_once(max_events: int) -> dict[str, Any]:
    paths = setup_dirs()
    lock_path = paths["locks"] / "dispatcher.lock"
    with lock_path.open("w", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        writefail_recovered = recover_writefail_breadcrumbs(paths)
        reclaimed = reclaim_processing(paths)
        processed = 0
        sent = 0
        suppressed = 0
        failed = 0
        last_error = None
        for path in sorted(paths["outbox"].glob("*.json")):
            if processed >= max_events:
                break
            if not ready(path, paths["quarantine"]):
                continue
            processed += 1
            ok, detail = process_one(path, paths)
            if ok:
                if detail == "suppressed":
                    suppressed += 1
                else:
                    sent += 1
            else:
                failed += 1
                last_error = detail
        record_state(
            paths,
            lastRunAt=now_iso(),
            processed=processed,
            sent=sent,
            suppressed=suppressed,
            failed=failed,
            reclaimed=reclaimed,
            writefailRecovered=writefail_recovered,
            lastError=last_error,
        )
        return {
            "processed": processed,
            "sent": sent,
            "suppressed": suppressed,
            "failed": failed,
            "reclaimed": reclaimed,
            "writefailRecovered": writefail_recovered,
            "lastError": last_error,
        }


def run_daemon(interval: int, max_events: int) -> None:
    while True:
        try:
            result = run_once(max_events)
            print(json.dumps({"time": now_iso(), **result}), flush=True)
        except BlockingIOError:
            print(json.dumps({"time": now_iso(), "skipped": "locked"}), flush=True)
        except Exception as exc:
            paths = setup_dirs()
            record_state(paths, lastRunAt=now_iso(), processed=0, sent=0, failed=1, lastError=str(exc))
            print(json.dumps({"time": now_iso(), "error": str(exc)}), flush=True)
        time.sleep(interval)


def main() -> int:
    parser = argparse.ArgumentParser(description="Drain local BOT ERRORS outbox")
    parser.add_argument("--once", action="store_true", help="process ready events once and exit")
    parser.add_argument("--daemon", action="store_true", help="run continuously")
    parser.add_argument("--interval", type=int, default=30)
    parser.add_argument("--max-events", type=int, default=25)
    parser.add_argument("--format-event", help="format one event JSON file without sending")
    args = parser.parse_args()

    if args.format_event:
        print(format_event(read_json(Path(args.format_event))))
        return 0

    if args.daemon:
        run_daemon(args.interval, args.max_events)
        return 0

    result = run_once(args.max_events)
    print(json.dumps(result, sort_keys=True))
    return 1 if result.get("failed") else 0


if __name__ == "__main__":
    sys.exit(main())
