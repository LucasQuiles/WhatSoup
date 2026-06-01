#!/usr/bin/env python3
"""Drain the local BOT ERRORS outbox into the configured WhatSoup line.

The dispatcher is intentionally file based. Producers only need to land a
0600 JSON event in the local outbox; this process owns network delivery,
retry metadata, poison quarantine, and state reporting.
"""

from __future__ import annotations

import argparse
import calendar
import fcntl
import hashlib
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
RECOVERY_DUPLICATE_SUPPRESSION_REASON = (
    "duplicate recovery/info event retained as audit-only; "
    "earliest matching event in the dedupe window remains dispatchable"
)
TEST_PROVENANCE_SUPPRESSION_REASON = "test-provenance event refused by dispatcher"
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
COMMA_TOKEN_LIST = re.compile(r"\b[A-Za-z0-9_.:-]+(?:\s*,\s*[A-Za-z0-9_.:-]+)+\b")


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
        "storm_collapsed": root / "storm-collapsed",
        "storm_manifests": root / "storm-manifests",
        "suppressed": root / "suppressed",
        "quarantine": root / "quarantine",
        "writefail_recovered": root / "writefail-recovered",
        "writefail_quarantine": root / "writefail-quarantine",
        "locks": root / "locks",
        "logs": root / "logs",
        "state": root / "dispatcher-state.json",
        "meta_state": root / "dispatcher-meta-state.json",
    }


def ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.chmod(0o700)
    except OSError:
        pass


def fsync_dir(path: Path) -> None:
    try:
        dir_fd = os.open(path, os.O_DIRECTORY | os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def setup_dirs() -> dict[str, Path]:
    paths = state_paths()
    for key in (
        "root",
        "outbox",
        "processing",
        "sent",
        "storm_collapsed",
        "storm_manifests",
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
    data = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        fsync_dir(path.parent)
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


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


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


def safe_filename(value: str, max_length: int = 180) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value.strip()).strip("_")
    cleaned = cleaned or "unknown"
    if len(cleaned) <= max_length:
        return cleaned
    for suffix in (".writefail", ".processing", ".suppressed", ".collapsed", ".recovered", ".duplicate", ".poison", ".sent", ".json"):
        if cleaned.endswith(suffix) and len(suffix) < max_length:
            stem = cleaned[: max_length - len(suffix)].rstrip("._-:")
            return f"{stem or 'unknown'}{suffix}"
    return cleaned[:max_length]


def safe_child_path(directory: Path, name: str, max_length: int = 180) -> Path:
    ensure_private_dir(directory)
    directory_resolved = directory.resolve()
    first = directory / safe_filename(name, max_length)
    candidates = [first]
    if first.exists():
        stem = safe_filename(name, min(140, max_length))
        prefix = f"{int(time.time())}.{os.getpid()}"
        candidates = [directory / f"{prefix}.{counter}.{stem}" for counter in range(1000)]
    for target in candidates:
        if target.resolve().parent != directory_resolved:
            raise RuntimeError(f"unsafe child path escaped {directory}: {name}")
        if not target.exists():
            return target
    raise RuntimeError(f"no available child path in {directory}: {name}")


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
    storm = event.get("storm") if isinstance(event.get("storm"), dict) else {}
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
        event_line("affected_hosts", storm.get("affectedHosts")),
        event_line(
            "affected_host_list",
            ", ".join(str(host) for host in storm.get("hosts", []))
            if isinstance(storm.get("hosts"), list)
            else None,
            1800,
        ),
        event_line("storm_manifest", storm.get("manifest"), 900),
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


def is_test_provenance_event(event: dict[str, Any]) -> bool:
    runtime = event.get("runtime") if isinstance(event.get("runtime"), dict) else {}
    provenance = runtime.get("provenance") if isinstance(runtime.get("provenance"), dict) else {}
    return provenance.get("test") is True


def omit_dispatch_log_in_message(event: dict[str, Any]) -> bool:
    diagnostics = event.get("diagnostics") if isinstance(event.get("diagnostics"), dict) else {}
    return diagnostics.get("omitDispatchLogInMessage") is True


def move_suppressed_event(
    path: Path,
    paths: dict[str, Path],
    event: dict[str, Any],
    reason: str,
    log_type: str = "suppressed",
    source_name: str | None = None,
) -> Path:
    event = mark_suppressed(event, reason)
    atomic_write_json(path, event)
    suppressed_name = f"{source_name or path.name}.{int(time.time())}.suppressed"
    suppressed_path = safe_child_path(paths["suppressed"], suppressed_name)
    os.replace(path, suppressed_path)
    fsync_dir(suppressed_path.parent)
    append_dispatch_log(paths, {
        "type": log_type,
        "eventId": event.get("id"),
        "path": str(suppressed_path),
        "reason": reason,
        "source": event.get("source"),
        "severity": event.get("severity"),
        "eventType": event.get("eventType"),
        "attempts": event.get("delivery", {}).get("attempts") if isinstance(event.get("delivery"), dict) else None,
    })
    return suppressed_path


def storm_threshold() -> int:
    return max(0, env_int("BOT_ERRORS_STORM_THRESHOLD", 3))


def storm_window_seconds() -> int:
    return max(1, env_int("BOT_ERRORS_STORM_WINDOW_SECONDS", 120))


def recovery_dedupe_window_seconds() -> int:
    return max(1, env_int("BOT_ERRORS_RECOVERY_DEDUPE_WINDOW_SECONDS", storm_window_seconds()))


def suppressed_max_files() -> int:
    return max(1, env_int("BOT_ERRORS_SUPPRESSED_MAX_FILES", 2000))


def test_provenance_meta_window_seconds() -> int:
    return max(1, env_int("BOT_ERRORS_TEST_PROVENANCE_META_WINDOW_SECONDS", 900))


def created_epoch(event: dict[str, Any]) -> int:
    created = str(event.get("createdAt") or "").strip()
    if created:
        if "." in created and created.endswith("Z"):
            created = created.split(".", 1)[0] + "Z"
        try:
            return int(calendar.timegm(time.strptime(created, "%Y-%m-%dT%H:%M:%SZ")))
        except ValueError:
            pass
    return int(time.time())


def iso_from_epoch(epoch: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def event_host(event: dict[str, Any]) -> str:
    for key in ("machine", "machineName", "host", "hostname", "instance"):
        value = str(event.get(key) or "").strip()
        if value:
            return value
    return "unknown"


def sorted_unique_hosts(events: list[dict[str, Any]]) -> list[str]:
    hosts = {event_host(event) for event in events}
    return sorted(hosts, key=lambda value: value.lower())


def normalize_token_lists(text: str) -> str:
    def sort_match(match: re.Match[str]) -> str:
        items = [item.strip() for item in match.group(0).split(",") if item.strip()]
        return ",".join(sorted(items, key=lambda value: value.lower()))

    return COMMA_TOKEN_LIST.sub(sort_match, text)


def normalized_summary(event: dict[str, Any]) -> str:
    text = redact(event.get("summary") or "unspecified bot error").lower()
    host_tokens = set()
    for key in ("machine", "machineName", "host", "hostname", "instance"):
        raw = str(event.get(key) or "").strip().lower()
        if not raw:
            continue
        host_tokens.add(raw)
        host_tokens.add(raw.split(".", 1)[0])
    for token in sorted(host_tokens, key=len, reverse=True):
        if token:
            text = re.sub(rf"\b{re.escape(token)}\b", "{host}", text)
    text = re.sub(r"\b(?:maclab|mwlab|mini\d{1,2})\b", "{host}", text)
    text = normalize_token_lists(text)
    return re.sub(r"\s+", " ", text).strip()


def recovery_normalized_summary(event: dict[str, Any]) -> str:
    text = str(event.get("summary") or "unspecified bot error").strip().lower()
    return re.sub(r"\s+", " ", text)


def storm_fingerprint(event: dict[str, Any]) -> str:
    parts = [
        str(event.get("source") or "unknown").strip().lower(),
        str(event.get("severity") or "critical").strip().lower(),
        normalized_summary(event),
    ]
    return "\n".join(parts)


def storm_fingerprint_hash(fingerprint: str) -> str:
    return hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:16]


def find_event_path_by_id(event_id: str, paths: dict[str, Path], keys: tuple[str, ...]) -> Path | None:
    if not event_id:
        return None
    for key in keys:
        directory = paths[key]
        if not directory.exists():
            continue
        for path in directory.glob("*"):
            if not path.is_file():
                continue
            try:
                if read_json(path).get("id") == event_id:
                    return path
            except Exception:
                continue
    return None


def is_storm_candidate(event: dict[str, Any]) -> bool:
    if isinstance(event.get("storm"), dict):
        return False
    event_type = str(event.get("eventType") or "alert")
    severity = str(event.get("severity") or "").lower()
    return event_type == "alert" and severity in {"critical", "warning"}


def recovery_identity(event: dict[str, Any]) -> tuple[str, str]:
    host = ""
    for key in ("machine", "machineName", "host", "hostname"):
        host = str(event.get(key) or "").strip().lower()
        if host:
            break
    instance = str(event.get("instance") or "").strip().lower()
    return host, instance


def recovery_episode_fingerprint(event: dict[str, Any]) -> str:
    host, instance = recovery_identity(event)
    parts = [
        str(event.get("source") or "unknown").strip().lower(),
        recovery_normalized_summary(event),
        host,
        instance,
    ]
    return "\n".join(parts)


def recovery_duplicate_fingerprint(event: dict[str, Any]) -> str:
    host, instance = recovery_identity(event)
    parts = [
        str(event.get("eventType") or "alert").strip().lower(),
        str(event.get("severity") or "").strip().lower(),
        str(event.get("source") or "unknown").strip().lower(),
        recovery_normalized_summary(event),
        host,
        instance,
    ]
    return "\n".join(parts)


def is_recovery_dedupe_candidate(event: dict[str, Any]) -> bool:
    event_type = str(event.get("eventType") or "alert").strip().lower()
    severity = str(event.get("severity") or "").strip().lower()
    source = str(event.get("source") or "").strip().lower()
    if source == "daily-health" and severity == "info":
        return False
    return event_type == "clear" or severity == "info"


def is_recovery_episode_barrier(event: dict[str, Any]) -> bool:
    event_type = str(event.get("eventType") or "alert").strip().lower()
    severity = str(event.get("severity") or "").strip().lower()
    return event_type == "alert" and severity in {"critical", "warning"}


def manifest_entry(path: Path, event: dict[str, Any]) -> dict[str, Any]:
    diagnostics = event.get("diagnostics") if isinstance(event.get("diagnostics"), dict) else {}
    log_hints = diagnostics.get("logHints") if isinstance(diagnostics.get("logHints"), list) else []
    return {
        "eventId": event.get("id"),
        "machine": event_host(event),
        "instance": event.get("instance"),
        "source": event.get("source"),
        "severity": event.get("severity"),
        "createdAt": event.get("createdAt"),
        "summary": truncate(redact(event.get("summary")), 700),
        "evidence": truncate(redact(event.get("evidence")), 1800),
        "outboxPath": str(path),
        "logHints": [truncate(redact(hint), 900) for hint in log_hints[:10]],
    }


def mark_collapsed(event: dict[str, Any], digest_id: str, manifest_path: Path) -> dict[str, Any]:
    delivery = event.setdefault("delivery", {})
    if isinstance(delivery, dict):
        delivery["status"] = "storm-collapsed"
        delivery["collapsedAt"] = now_iso()
        delivery["collapsedInto"] = digest_id
        delivery["lastError"] = None
    diagnostics = event.setdefault("diagnostics", {})
    if isinstance(diagnostics, dict):
        diagnostics["stormCollapse"] = {
            "digestId": digest_id,
            "manifest": str(manifest_path),
            "collapsedAt": now_iso(),
        }
    return event


def storm_digest_event(
    paths: dict[str, Path],
    fingerprint: str,
    fingerprint_hash: str,
    bucket_start: int,
    bucket_end: int,
    events: list[dict[str, Any]],
    manifest_path: Path,
) -> dict[str, Any]:
    first = events[0]
    hosts = sorted_unique_hosts(events)
    severity = str(first.get("severity") or "critical").lower()
    source = str(first.get("source") or "unknown")
    summary = normalized_summary(first) or "same fingerprint alert storm"
    digest_id = f"storm-{fingerprint_hash}-{bucket_start}"
    evidence_lines = [
        f"affected_hosts:{len(hosts)}",
        f"hosts:{', '.join(hosts)}",
        f"fingerprint:{fingerprint_hash}",
        f"source:{source}",
        f"severity:{severity}",
        f"window_start_epoch:{bucket_start}",
        f"window_end_epoch:{bucket_end}",
        f"collapsed_events:{len(events)}",
        f"manifest:{manifest_path}",
        f"fingerprint_basis:{fingerprint.replace(chr(10), ' | ')}",
    ]
    return {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": severity,
        "id": digest_id,
        "createdAt": now_iso(),
        "machine": "fleet",
        "platform": "mixed",
        "instance": "storm-collapse",
        "source": source,
        "summary": f"BOT ERRORS storm collapse: {len(hosts)} hosts - {summary}",
        "evidence": "\n".join(evidence_lines),
        "diagnostics": {
            "logHints": [str(manifest_path)],
            "queue": str(paths["outbox"]),
        },
        "storm": {
            "fingerprint": fingerprint_hash,
            "affectedHosts": len(hosts),
            "hosts": hosts,
            "windowStartEpoch": bucket_start,
            "windowEndEpoch": bucket_end,
            "manifest": str(manifest_path),
            "collapsedEvents": len(events),
        },
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }


def storm_digest_outbox_path(paths: dict[str, Path], digest_id: str, source: str, window_start: int) -> Path:
    created = iso_from_epoch(window_start).replace("-", "").replace(":", "")
    instance = safe_segment("storm-collapse")
    source_segment = safe_segment(source or "unknown")
    event_id = safe_segment(digest_id)
    return safe_child_path(paths["outbox"], f"{created}.{instance}.{source_segment}.{event_id}.json")


def merge_manifest_entries(existing: list[Any], additions: list[dict[str, Any]]) -> list[Any]:
    seen: set[tuple[str, str]] = set()
    merged: list[Any] = []
    for entry in existing:
        if isinstance(entry, dict):
            key = (str(entry.get("eventId") or ""), str(entry.get("outboxPath") or ""))
            seen.add(key)
        merged.append(entry)
    for entry in additions:
        key = (str(entry.get("eventId") or ""), str(entry.get("outboxPath") or ""))
        if key in seen:
            continue
        seen.add(key)
        merged.append(entry)
    return merged


def existing_storm_window(
    paths: dict[str, Path],
    fingerprint_hash: str,
    start_epoch: int,
) -> tuple[dict[str, Any], Path] | None:
    for path in sorted(paths["storm_manifests"].glob(f"*.{fingerprint_hash}.json")):
        try:
            manifest = read_json(path)
            if manifest.get("fingerprint") != fingerprint_hash:
                continue
            window_start = int(manifest.get("windowStartEpoch") or 0)
            window_end = int(manifest.get("windowEndEpoch") or 0)
        except Exception:
            continue
        if window_start <= start_epoch < window_end:
            return manifest, path
    return None


def collapse_storm_group(
    paths: dict[str, Path],
    key: tuple[str, int],
    records: list[tuple[Path, dict[str, Any]]],
) -> int:
    fingerprint, requested_start = key
    window = storm_window_seconds()
    fingerprint_hash = storm_fingerprint_hash(fingerprint)
    existing = existing_storm_window(paths, fingerprint_hash, requested_start)
    if existing:
        existing_manifest, manifest_path = existing
        bucket_start = int(existing_manifest.get("windowStartEpoch") or requested_start)
        bucket_end = int(existing_manifest.get("windowEndEpoch") or (bucket_start + window))
        manifest = existing_manifest
    else:
        bucket_start = requested_start
        bucket_end = bucket_start + window
        manifest_path = paths["storm_manifests"] / f"{bucket_start}.{fingerprint_hash}.json"
        manifest = {}
    digest_id = f"storm-{fingerprint_hash}-{bucket_start}"
    events = [event for _, event in records]
    additions = [manifest_entry(path, event) for path, event in records]
    if not manifest and manifest_path.exists():
        try:
            manifest = read_json(manifest_path)
        except Exception:
            manifest = {}
    existing_entries = manifest.get("entries") if isinstance(manifest.get("entries"), list) else []
    existing_collapsed = (
        manifest.get("entriesCollapsed")
        if isinstance(manifest.get("entriesCollapsed"), list)
        else []
    )
    existing_hosts = manifest.get("hosts") if isinstance(manifest.get("hosts"), list) else []
    merged_hosts = sorted(
        {str(host) for host in existing_hosts if str(host)} | set(sorted_unique_hosts(events)),
        key=lambda value: value.lower(),
    )
    manifest = {
        "schemaVersion": 1,
        "kind": "bot_errors_storm_collapse",
        "createdAt": manifest.get("createdAt") or now_iso(),
        "updatedAt": now_iso(),
        "digestId": digest_id,
        "fingerprint": fingerprint_hash,
        "windowStartEpoch": bucket_start,
        "windowEndEpoch": bucket_end,
        "affectedHosts": len(merged_hosts),
        "hosts": merged_hosts,
        "entries": merge_manifest_entries(existing_entries, additions),
    }
    atomic_write_json(manifest_path, manifest)

    known_digest_path = find_event_path_by_id(
        digest_id,
        paths,
        ("outbox", "processing", "sent", "suppressed", "quarantine"),
    )
    digest = storm_digest_event(
        paths, fingerprint, fingerprint_hash, bucket_start, bucket_end, events, manifest_path
    )
    digest_path = known_digest_path or storm_digest_outbox_path(paths, digest_id, str(digest.get("source")), bucket_start)
    if known_digest_path is None:
        atomic_write_json(digest_path, digest)
        append_dispatch_log(paths, {
            "type": "storm_digest_queued",
            "digestId": digest.get("id"),
            "digestPath": str(digest_path),
            "fingerprint": fingerprint_hash,
            "affectedHosts": len(sorted_unique_hosts(events)),
            "collapsedEvents": len(events),
            "manifest": str(manifest_path),
        })
    else:
        append_dispatch_log(paths, {
            "type": "storm_digest_reused",
            "digestId": digest_id,
            "digestPath": str(digest_path),
            "fingerprint": fingerprint_hash,
            "manifest": str(manifest_path),
        })
    manifest["digestOutboxPath"] = str(digest_path)

    collapsed = 0
    collapsed_entries: list[dict[str, Any]] = []
    for path, event in records:
        if not path.exists():
            append_dispatch_log(paths, {
                "type": "storm_collapse_missing_source",
                "digestId": digest.get("id"),
                "sourcePath": str(path),
            })
            continue
        event = mark_collapsed(event, str(digest.get("id")), manifest_path)
        atomic_write_json(path, event)
        target = safe_child_path(
            paths["storm_collapsed"],
            f"{path.name}.{safe_segment(str(digest.get('id')))}.{int(time.time())}.collapsed",
        )
        os.replace(path, target)
        fsync_dir(target.parent)
        collapsed += 1
        collapsed_entries.append({
            "eventId": event.get("id"),
            "sourcePath": str(path),
            "collapsedPath": str(target),
        })
        append_dispatch_log(paths, {
            "type": "storm_collapsed",
            "eventId": event.get("id"),
            "digestId": digest.get("id"),
            "fingerprint": fingerprint_hash,
            "sourcePath": str(path),
            "collapsedPath": str(target),
            "manifest": str(manifest_path),
        })

    manifest["entriesCollapsed"] = merge_manifest_entries(existing_collapsed, collapsed_entries)
    atomic_write_json(manifest_path, manifest)
    return collapsed


def collapse_ready_storms(paths: dict[str, Path]) -> int:
    threshold = storm_threshold()
    if threshold < 2:
        return 0
    window = storm_window_seconds()
    groups: dict[str, list[tuple[Path, dict[str, Any], int]]] = {}
    for path in sorted(paths["outbox"].glob("*.json")):
        if not ready(path, paths["quarantine"]):
            continue
        try:
            event = read_json(path)
        except Exception:
            continue
        if not is_storm_candidate(event):
            continue
        fingerprint = storm_fingerprint(event)
        groups.setdefault(fingerprint, []).append((path, event, created_epoch(event)))

    collapsed = 0
    for fingerprint, records in groups.items():
        remaining = sorted(records, key=lambda record: (record[2], str(record[0])))
        while remaining:
            collapsed_window = False
            for index, (_, _, start_epoch) in enumerate(remaining):
                cluster = [
                    (path, event, epoch)
                    for path, event, epoch in remaining[index:]
                    if start_epoch <= epoch < start_epoch + window
                ]
                events = [event for _, event, _ in cluster]
                if len(sorted_unique_hosts(events)) < threshold:
                    continue
                collapsed += collapse_storm_group(
                    paths,
                    (fingerprint, start_epoch),
                    [(path, event) for path, event, _ in cluster],
                )
                clustered_paths = {path for path, _, _ in cluster}
                remaining = [record for record in remaining if record[0] not in clustered_paths]
                collapsed_window = True
                break
            if not collapsed_window:
                break
    return collapsed


def suppress_ready_recovery_duplicates(paths: dict[str, Path]) -> int:
    window = recovery_dedupe_window_seconds()
    groups: dict[str, list[tuple[Path, dict[str, Any], int]]] = {}
    for path in sorted(paths["outbox"].glob("*.json")):
        if not ready(path, paths["quarantine"]):
            continue
        try:
            event = read_json(path)
        except Exception:
            continue
        if not is_recovery_dedupe_candidate(event) and not is_recovery_episode_barrier(event):
            continue
        groups.setdefault(recovery_episode_fingerprint(event), []).append((path, event, created_epoch(event)))

    suppressed = 0
    for records in groups.values():
        kept_by_duplicate_fingerprint: dict[str, int] = {}
        for path, event, epoch in sorted(records, key=lambda record: (record[2], str(record[0]))):
            if is_recovery_episode_barrier(event):
                kept_by_duplicate_fingerprint.clear()
                append_dispatch_log(paths, {
                    "type": "recovery_dedupe_barrier",
                    "eventId": event.get("id"),
                    "source": event.get("source"),
                    "severity": event.get("severity"),
                    "eventType": event.get("eventType"),
                    "episodeFingerprint": storm_fingerprint_hash(recovery_episode_fingerprint(event)),
                    "createdAtEpoch": epoch,
                })
                continue
            if not is_recovery_dedupe_candidate(event):
                continue
            duplicate_fingerprint = recovery_duplicate_fingerprint(event)
            first_epoch = kept_by_duplicate_fingerprint.get(duplicate_fingerprint)
            if first_epoch is not None and first_epoch <= epoch < first_epoch + window:
                if not path.exists():
                    continue
                move_suppressed_event(
                    path,
                    paths,
                    event,
                    RECOVERY_DUPLICATE_SUPPRESSION_REASON,
                    "recovery_duplicate_suppressed",
                )
                suppressed += 1
                continue
            kept_by_duplicate_fingerprint[duplicate_fingerprint] = epoch
    return suppressed


def prune_suppressed(paths: dict[str, Path]) -> int:
    cap = suppressed_max_files()
    files = [path for path in paths["suppressed"].glob("*") if path.is_file()]
    if len(files) <= cap:
        return 0

    def sort_key(path: Path) -> tuple[int, str]:
        try:
            return path.stat().st_mtime_ns, str(path)
        except OSError:
            return 0, str(path)

    pruned = 0
    for path in sorted(files, key=sort_key)[: len(files) - cap]:
        try:
            path.unlink()
            pruned += 1
        except FileNotFoundError:
            continue
    if pruned:
        fsync_dir(paths["suppressed"])
        append_dispatch_log(paths, {
            "type": "suppressed_pruned",
            "path": str(paths["suppressed"]),
            "maxFiles": cap,
            "pruned": pruned,
        })
    return pruned


def read_meta_state(paths: dict[str, Path]) -> dict[str, Any]:
    try:
        return read_json(paths["meta_state"])
    except Exception:
        return {}


def write_meta_state(paths: dict[str, Path], state: dict[str, Any]) -> None:
    atomic_write_json(paths["meta_state"], state)


def test_provenance_meta_event(paths: dict[str, Path], refused: int, window: int) -> dict[str, Any]:
    now = int(time.time())
    return {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "warning",
        "id": f"dispatcher-test-provenance-refused-{now}",
        "createdAt": now_iso(),
        "machine": socket.gethostname(),
        "platform": sys.platform,
        "instance": "bot-errors-dispatcher",
        "source": "test-provenance-refused",
        "summary": "BOT ERRORS dispatcher refused test-provenance events",
        "evidence": "\n".join([
            f"refused_events:{refused}",
            f"debounce_window_seconds:{window}",
            "disposition: originals retained in suppressed audit state",
            "reason: producer test-provenance event reached dispatcher backstop",
        ]),
        "process": {"pid": os.getpid()},
        "diagnostics": {"omitDispatchLogInMessage": True},
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }


def queue_test_provenance_meta_alert(paths: dict[str, Path], refused: int) -> int:
    if refused <= 0:
        return 0
    now = int(time.time())
    window = test_provenance_meta_window_seconds()
    state = read_meta_state(paths)
    last = int(state.get("testProvenanceMetaAlertAtEpoch") or 0)
    if last and now - last < window:
        append_dispatch_log(paths, {
            "type": "test_provenance_meta_debounced",
            "refused": refused,
            "windowSeconds": window,
        })
        return 0

    event = test_provenance_meta_event(paths, refused, window)
    path = outbox_path_for_event(event, paths)
    atomic_write_json(path, event)
    state["testProvenanceMetaAlertAtEpoch"] = now
    state["testProvenanceMetaAlertEventId"] = event["id"]
    write_meta_state(paths, state)
    append_dispatch_log(paths, {
        "type": "test_provenance_meta_queued",
        "eventId": event["id"],
        "refused": refused,
        "windowSeconds": window,
    })
    return 1


def suppress_test_provenance_events(paths: dict[str, Path]) -> tuple[int, int]:
    suppressed = 0
    for path in sorted(paths["outbox"].glob("*.json")):
        if not ready(path, paths["quarantine"]):
            continue
        try:
            event = read_json(path)
        except Exception:
            continue
        if not is_test_provenance_event(event):
            continue
        move_suppressed_event(
            path,
            paths,
            event,
            TEST_PROVENANCE_SUPPRESSION_REASON,
            "test_provenance_suppressed",
        )
        suppressed += 1
    alerted = queue_test_provenance_meta_alert(paths, suppressed)
    return suppressed, alerted


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
    dest = safe_child_path(quarantine_dir, f"{path.name}.{int(time.time())}.{os.getpid()}.poison")
    try:
        shutil.move(str(path), str(dest))
        fsync_dir(dest.parent)
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


def event_already_known(event_id: str, created_at: str, paths: dict[str, Path]) -> bool:
    if not event_id:
        return False
    for key in ("outbox", "processing", "sent", "storm_collapsed", "suppressed", "quarantine"):
        directory = paths[key]
        if not directory.exists():
            continue
        for path in directory.glob("*"):
            if not path.is_file():
                continue
            try:
                known = read_json(path)
                known_created_at = str(known.get("createdAt") or "")
                if known.get("id") == event_id and (not created_at or not known_created_at or known_created_at == created_at):
                    return True
            except Exception:
                continue
    return False


def outbox_path_for_event(event: dict[str, Any], paths: dict[str, Path]) -> Path:
    created = str(event.get("createdAt") or now_iso()).replace("-", "").replace(":", "")
    instance = safe_segment(str(event.get("instance") or "unknown"))
    source = safe_segment(str(event.get("source") or "unknown"))
    event_id = safe_segment(str(event.get("id") or f"recovered-{int(time.time())}-{os.getpid()}"))
    return safe_child_path(paths["outbox"], f"{created}.{instance}.{source}.{event_id}.json")


def move_writefail(path: Path, target_dir: Path, suffix: str) -> Path:
    target = safe_child_path(target_dir, f"{path.name}.{int(time.time())}.{suffix}")
    shutil.move(str(path), str(target))
    fsync_dir(target.parent)
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
                if event_already_known(event_id, str(event.get("createdAt") or ""), paths):
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
    dest = safe_child_path(processing_dir, f"{path.name}.{os.getpid()}.processing", 240)
    os.replace(path, dest)
    fsync_dir(dest.parent)
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
        target = safe_child_path(paths["outbox"], original_name_from_processing(path))
        os.replace(path, target)
        fsync_dir(target.parent)
        append_dispatch_log(paths, {"type": "reclaim", "from": str(path), "to": str(target)})
        reclaimed += 1
    return reclaimed


def record_state(paths: dict[str, Path], **updates: Any) -> None:
    counts = {
        "outbox": len(list(paths["outbox"].glob("*.json"))),
        "processing": len(list(paths["processing"].glob("*"))),
        "sent": len(list(paths["sent"].glob("*"))),
        "stormCollapsed": len(list(paths["storm_collapsed"].glob("*"))),
        "stormManifests": len(list(paths["storm_manifests"].glob("*"))),
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
    if isinstance(diagnostics, dict) and not omit_dispatch_log_in_message(event):
        diagnostics["dispatchLog"] = str(paths["logs"] / "dispatch.jsonl")
    event = mark_attempt(event)
    atomic_write_json(claimed, event)
    suppress_reason = should_suppress_send(event)
    if suppress_reason:
        move_suppressed_event(claimed, paths, event, suppress_reason, source_name=path.name)
        return True, "suppressed"

    text = format_event(event)
    try:
        send_whatsapp(text)
    except Exception as exc:
        event = mark_failure(event, str(exc))
        atomic_write_json(claimed, event)
        retry_path = safe_child_path(paths["outbox"], path.name)
        os.replace(claimed, retry_path)
        fsync_dir(retry_path.parent)
        append_dispatch_log(paths, {
            "type": "send_failed",
            "eventId": event.get("id"),
            "path": str(retry_path),
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
    sent_path = safe_child_path(paths["sent"], sent_name)
    os.replace(claimed, sent_path)
    fsync_dir(sent_path.parent)
    append_dispatch_log(paths, {
        "type": "sent",
        "eventId": event.get("id"),
        "path": str(sent_path),
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
        test_provenance_suppressed, test_provenance_meta_alerted = suppress_test_provenance_events(paths)
        recovery_deduped = suppress_ready_recovery_duplicates(paths)
        storm_collapsed = collapse_ready_storms(paths)
        processed = 0
        sent = 0
        suppressed = test_provenance_suppressed + recovery_deduped
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
        suppressed_pruned = prune_suppressed(paths)
        record_state(
            paths,
            lastRunAt=now_iso(),
            processed=processed,
            sent=sent,
            suppressed=suppressed,
            failed=failed,
            reclaimed=reclaimed,
            writefailRecovered=writefail_recovered,
            testProvenanceSuppressed=test_provenance_suppressed,
            testProvenanceMetaAlerted=test_provenance_meta_alerted,
            recoveryDeduped=recovery_deduped,
            stormCollapsed=storm_collapsed,
            suppressedPruned=suppressed_pruned,
            lastError=last_error,
        )
        return {
            "processed": processed,
            "sent": sent,
            "suppressed": suppressed,
            "failed": failed,
            "reclaimed": reclaimed,
            "writefailRecovered": writefail_recovered,
            "testProvenanceSuppressed": test_provenance_suppressed,
            "testProvenanceMetaAlerted": test_provenance_meta_alerted,
            "recoveryDeduped": recovery_deduped,
            "stormCollapsed": storm_collapsed,
            "suppressedPruned": suppressed_pruned,
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
