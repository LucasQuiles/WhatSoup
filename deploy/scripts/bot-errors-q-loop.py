#!/usr/bin/env python3
"""Durable BOT ERRORS coordination loop for Lucas/Q/Codex.

This is an operational guardrail, not the final incident bus. It keeps a
stateful polling loop alive while the bus is designed, implemented, and tested.
It watches the BOT ERRORS chat, records Q/Codex activity, posts bounded steering
checkpoints, and uses dynamic sleep intervals so active sessions are polled more
aggressively than idle periods.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import json
import os
import re
import socket
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.bot_errors_redaction import redact_bot_errors_text, redact_json_value as redact_shared_json_value


BOT_ERRORS_JID = os.environ.get("BOT_ERRORS_JID", "").strip()
BOT_ERRORS_EXPECTED_JID = os.environ.get("BOT_ERRORS_EXPECTED_JID", "").strip()
BOT_ERRORS_KEY = os.environ.get("BOT_ERRORS_KEY") or (
    BOT_ERRORS_JID.replace("@", "_at_") if BOT_ERRORS_JID else ""
)
DEFAULT_DB = os.environ.get("BOT_ERRORS_DB", "")
DEFAULT_SOCKET = os.environ.get("BOT_ERRORS_SOCKET", "")
STATE_DIR = Path(os.environ.get("BOT_ERRORS_Q_LOOP_STATE_DIR", Path.home() / ".local/state/bot-errors-q-loop"))
STATE_FILE = STATE_DIR / "state.json"
EVENT_LOG = STATE_DIR / "events.jsonl"
ACTIVITY_LOG = STATE_DIR / "activity.jsonl"
LOCK_FILE = STATE_DIR / "loop.lock"

REQUIRED_MESSAGE_COLUMNS = {
    "pk",
    "is_from_me",
    "sender_jid",
    "sender_name",
    "timestamp",
    "content_text",
    "content",
    "conversation_key",
}

CRITICAL_DELIVERY_SLA_SECONDS = 5 * 60
ACTIVE_WAIT_SECONDS = 15
AWAITING_Q_WAIT_SECONDS = 30
RECENT_ACTIVITY_WAIT_SECONDS = 60
IDLE_WAIT_SECONDS = 5 * 60
# INVARIANT: the heartbeat (state.json updated_at) is refreshed once per loop
# iteration, immediately before sleeping for next_wait_seconds. The independent
# heartbeat watchdog flags the loop stale at BOT_ERRORS_MAX_Q_LOOP_AGE (600s).
# The idle backoff must therefore stay strictly below that threshold (with margin
# for poll/processing/systemd jitter) or a healthy idle loop trips a false-positive
# stale alert. 480s leaves a 120s margin under the 600s watchdog deadline.
# Enforced by tests/scripts/bot-errors-q-loop.test.ts.
MAX_IDLE_WAIT_SECONDS = 8 * 60
# Frame headers are single-sourced: the composers below and the self-reminder
# exclusion both derive from these constants so they cannot drift apart.
BOOTSTRAP_HEADER = "Codex -> Q / durable coordination loop online"
NUDGE_HEADER = "Codex -> Q / gate nudge"
CHECKPOINT_HEADER = "Codex -> Q / hourly SDLC checkpoint"

# The loop's own REPEATING reminder frames must never re-arm the awaiting-Q
# clock: each nudge re-arming the clock turns one unanswered ask into a
# permanent 15/30-minute stale/recovered sawtooth at the heartbeat watchdog.
# Own frames always continue "<header>\n\n"; matching the bare header would
# also swallow legitimate asks that extend it ("... gate nudge escalation").
# The one-shot bootstrap frame is deliberately NOT excluded: it carries the
# original ask, and history replay after a state reset must be able to
# reconstruct the awaiting clock from it.
SELF_REMINDER_PREFIXES = (
    NUDGE_HEADER + "\n\n",
    CHECKPOINT_HEADER + "\n\n",
)

NUDGE_AFTER_SECONDS = 20 * 60
NUDGE_COOLDOWN_SECONDS = 45 * 60
CHECKPOINT_AFTER_SECONDS = 60 * 60

GROUP_JID_RE = re.compile(r"^\d+@g\.us$")
PHONE_JID_RE = re.compile(r"^\d+@s\.whatsapp\.net$")
LID_RE = re.compile(r"^[A-Za-z0-9_-]+@lid$")


def target_kind(target: str) -> str:
    value = str(target or "").strip()
    if not value:
        return "missing"
    if GROUP_JID_RE.match(value):
        return "group"
    if PHONE_JID_RE.match(value):
        return "phone_jid"
    if LID_RE.match(value):
        return "lid"
    return "unknown"


def q_loop_target_coverage(intended_target: str, bridged_targets: list[str] | tuple[str, ...] | None = None) -> dict[str, Any]:
    bot_errors_target = str(BOT_ERRORS_JID or "").strip()
    intended = str(intended_target or "").strip()
    targets_equal = bool(bot_errors_target and intended and bot_errors_target == intended)
    bridge_targets = {str(target or "").strip() for target in (bridged_targets or [])}
    route_bridge_present = bool(intended and intended in bridge_targets)
    if not bot_errors_target:
        coverage = "missing_bot_errors_target"
    elif not intended:
        coverage = "missing_intended_target"
    elif targets_equal:
        coverage = "covered"
    elif route_bridge_present:
        coverage = "bridged"
    else:
        coverage = "routing_mismatch"
    return {
        "bot_errors_target_present": bool(bot_errors_target),
        "bot_errors_target_kind": target_kind(bot_errors_target),
        "intended_target_present": bool(intended),
        "intended_target_kind": target_kind(intended),
        "targets_equal": targets_equal,
        "route_bridge_present": route_bridge_present,
        "coverage": coverage,
    }


def q_response_wait_diagnostic(
    state: dict[str, Any],
    current: int | None = None,
    stale_after_seconds: int = NUDGE_AFTER_SECONDS,
) -> dict[str, Any]:
    observed_at = now() if current is None else int(current)
    waiting_since = int(state.get("awaiting_q_since", 0) or 0)
    last_q_message_at = int(state.get("last_q_message_at", 0) or 0)
    awaiting_q = waiting_since > 0
    awaiting_age = max(0, observed_at - waiting_since) if awaiting_q else 0
    if not awaiting_q:
        status = "not_waiting"
    elif awaiting_age >= stale_after_seconds:
        status = "stale_awaiting_q"
    else:
        status = "awaiting_q"
    return {
        "awaiting_q": awaiting_q,
        "awaiting_q_age_seconds": awaiting_age,
        "last_q_message_age_seconds": max(0, observed_at - last_q_message_at) if last_q_message_at > 0 else None,
        "phase": str(state.get("phase") or "unknown"),
        "status": status,
    }


def record_target_coverage(state: dict[str, Any]) -> None:
    intended_target = BOT_ERRORS_EXPECTED_JID or BOT_ERRORS_JID
    diagnostic = q_loop_target_coverage(intended_target)
    state["target_coverage"] = diagnostic
    log_event("target_coverage", diagnostic)


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


BOT_ERRORS_REQUIRE_EXPECTED = env_flag("BOT_ERRORS_REQUIRE_EXPECTED", True)
Q_LOOP_LOG_MAX_BYTES = max(4096, env_int("BOT_ERRORS_Q_LOOP_LOG_MAX_BYTES", 2 * 1024 * 1024))
Q_LOOP_LOG_BACKUPS = max(1, min(20, env_int("BOT_ERRORS_Q_LOOP_LOG_BACKUPS", 3)))


def now() -> int:
    return int(time.time())


def iso(ts: int | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(ts or now()))


def default_state() -> dict[str, Any]:
    current = now()
    return {
        "version": 1,
        "started_at": current,
        "updated_at": current,
        "last_seen_pk": 0,
        "last_activity_at": current,
        "last_q_message_at": 0,
        "last_q_unavailable_at": 0,
        "last_q_unavailable_reason": "",
        "last_outbound_at": 0,
        "last_poll_error_at": 0,
        "last_poll_error": "",
        "consecutive_poll_failures": 0,
        "last_nudge_at": 0,
        "last_checkpoint_at": 0,
        "idle_cycles": 0,
        "awaiting_q_since": 0,
        "scope_approved_at": 0,
        "blocked_since": 0,
        "phase": "sdlc_design_gate",
        "sent": {},
        "next_wait_seconds": ACTIVE_WAIT_SECONDS,
        "sla": {
            "critical_delivery_seconds": CRITICAL_DELIVERY_SLA_SECONDS,
            "active_wait_seconds": ACTIVE_WAIT_SECONDS,
            "awaiting_q_wait_seconds": AWAITING_Q_WAIT_SECONDS,
            "idle_wait_seconds": IDLE_WAIT_SECONDS,
            "max_idle_wait_seconds": MAX_IDLE_WAIT_SECONDS,
        },
    }


def load_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
        return default_state()
    try:
        assert_private_regular_for_read(STATE_FILE, "q-loop state")
        loaded = json.loads(STATE_FILE.read_text())
    except Exception as exc:  # noqa: BLE001 - operational daemon must recover.
        kind = "state_integrity_failed" if isinstance(exc, OSError) else "state_corrupt"
        log_event(kind, {"error": str(exc), "path": str(STATE_FILE)})
        backup = STATE_FILE.with_suffix(f".corrupt.{now()}.json")
        try:
            if not STATE_FILE.is_symlink():
                STATE_FILE.replace(backup)
        except Exception:
            pass
        return default_state()
    state = default_state()
    state.update(loaded)
    state["sent"] = dict(loaded.get("sent", {}))
    state["sla"] = dict(loaded.get("sla", {})) | default_state()["sla"]
    return state


def save_state(state: dict[str, Any]) -> None:
    ensure_private_dir(STATE_DIR)
    state["updated_at"] = now()
    atomic_write_json(STATE_FILE, redact_json_value(state))


def log_event(kind: str, data: dict[str, Any]) -> None:
    record = {"ts": now(), "time": iso(), "kind": kind, **redact_json_value(data)}
    append_private_jsonl(EVENT_LOG, record)


def append_activity(record: dict[str, Any]) -> None:
    append_private_jsonl(ACTIVITY_LOG, {"ts": now(), "time": iso(), **redact_json_value(record)})


def redact_text(value: str) -> str:
    return redact_bot_errors_text(value, credential_path_marker="[REDACTED CREDENTIAL PATH]")


def redact_json_value(value: Any) -> Any:
    return redact_shared_json_value(value, redact_text)


def ensure_private_dir(path: Path) -> None:
    try:
        stat = path.lstat()
    except FileNotFoundError:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    else:
        if path.is_symlink():
            raise RuntimeError(f"refusing to use q-loop state directory through symlink: {path}")
        if not os.path.isdir(path):
            raise RuntimeError(f"refusing to use q-loop state directory over non-directory path: {path}")
    try:
        path.chmod(0o700)
    except OSError:
        pass


def assert_regular_or_missing(path: Path, label: str) -> None:
    try:
        stat = path.lstat()
    except FileNotFoundError:
        return
    if path.is_symlink():
        raise OSError(f"refusing to write {label} through symlink: {path}")
    if not os.path.isfile(path):
        raise OSError(f"refusing to write {label} over non-regular path: {path}")


def assert_private_regular_for_read(path: Path, label: str) -> None:
    stat = path.lstat()
    if path.is_symlink():
        raise OSError(f"refusing to read {label} through symlink: {path}")
    if not os.path.isfile(path):
        raise OSError(f"refusing to read {label} from non-regular path: {path}")
    mode = stat.st_mode & 0o777
    if mode & 0o077:
        raise OSError(f"refusing to read non-private {label}: {path} mode={mode:o}")


def unlink_symlink_or_regular(path: Path) -> None:
    try:
        stat = path.lstat()
    except FileNotFoundError:
        return
    if path.is_symlink() or os.path.isfile(path):
        path.unlink()
        return
    raise OSError(f"refusing to replace non-regular q-loop log backup: {path}")


def rotate_log_if_needed(path: Path) -> None:
    assert_regular_or_missing(path, "q-loop log")
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        return
    if size < Q_LOOP_LOG_MAX_BYTES:
        return
    oldest = path.with_name(f"{path.name}.{Q_LOOP_LOG_BACKUPS}")
    unlink_symlink_or_regular(oldest)
    for index in range(Q_LOOP_LOG_BACKUPS - 1, 0, -1):
        source = path.with_name(f"{path.name}.{index}")
        target = path.with_name(f"{path.name}.{index + 1}")
        try:
            source_stat = source.lstat()
        except FileNotFoundError:
            continue
        if source.is_symlink():
            source.unlink()
            continue
        if not os.path.isfile(source):
            raise OSError(f"refusing to rotate non-regular q-loop log backup: {source}")
        unlink_symlink_or_regular(target)
        source.replace(target)
        try:
            target.chmod(0o600)
        except OSError:
            pass
    first_backup = path.with_name(f"{path.name}.1")
    unlink_symlink_or_regular(first_backup)
    path.replace(first_backup)
    try:
        first_backup.chmod(0o600)
    except OSError:
        pass
    fsync_parent(path)


def append_private_jsonl(path: Path, record: dict[str, Any]) -> None:
    ensure_private_dir(path.parent)
    rotate_log_if_needed(path)
    payload = (json.dumps(record, sort_keys=True) + "\n").encode("utf-8")
    flags = os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "ab") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            path.chmod(0o600)
        except OSError:
            pass
        fsync_parent(path)
    except BaseException:
        raise


def fsync_parent(path: Path) -> None:
    try:
        fd = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    ensure_private_dir(path.parent)
    assert_regular_or_missing(path, "q-loop state")
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    assert_regular_or_missing(tmp, "q-loop state temp")
    data = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        assert_regular_or_missing(path, "q-loop state")
        os.replace(tmp, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass
        fsync_parent(path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def db_connect(db_path: str) -> sqlite3.Connection:
    path = Path(db_path).expanduser()
    uri = path.resolve().as_uri() + "?mode=ro"
    return sqlite3.connect(uri, uri=True)


def validate_db(db_path: str) -> str | None:
    path = Path(db_path).expanduser()
    if not path.exists():
        return f"BOT ERRORS DB missing: {path}"
    if not path.is_file():
        return f"BOT ERRORS DB is not a file: {path}"
    try:
        conn = db_connect(str(path))
        try:
            row = conn.execute(
                "select 1 from sqlite_master where type = 'table' and name = 'messages'"
            ).fetchone()
            columns = {
                str(column[1])
                for column in conn.execute("pragma table_info(messages)").fetchall()
            } if row is not None else set()
        finally:
            conn.close()
    except sqlite3.Error as exc:
        return f"BOT ERRORS DB unreadable: {path}: {exc}"
    if row is None:
        return f"BOT ERRORS DB missing messages table: {path}"
    missing_columns = sorted(REQUIRED_MESSAGE_COLUMNS - columns)
    if missing_columns:
        return f"BOT ERRORS DB messages table missing required columns: {path}: {', '.join(missing_columns)}"
    return None


def read_messages(db_path: str, after_pk: int) -> list[dict[str, Any]]:
    conn = db_connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            select
              pk,
              is_from_me,
              sender_jid,
              coalesce(sender_name, '') as sender_name,
              timestamp,
              coalesce(content_text, content, '') as body
            from messages
            where conversation_key = ?
              and pk > ?
            order by pk asc
            limit 100
            """,
            (BOT_ERRORS_KEY, after_pk),
        ).fetchall()
    finally:
        conn.close()
    return [dict(row) for row in rows]


def latest_message_pk(db_path: str) -> int:
    conn = db_connect(db_path)
    try:
        row = conn.execute(
            "select coalesce(max(pk), 0) from messages where conversation_key = ?",
            (BOT_ERRORS_KEY,),
        ).fetchone()
    finally:
        conn.close()
    return int(row[0] if row else 0)


def bootstrap_cursor_pk(db_path: str) -> tuple[int, int]:
    lookback = max(0, env_int("BOT_ERRORS_Q_LOOP_BOOTSTRAP_LOOKBACK_MESSAGES", 50))
    if lookback == 0:
        return latest_message_pk(db_path), 0
    conn = db_connect(db_path)
    try:
        rows = conn.execute(
            """
            select pk
            from messages
            where conversation_key = ?
            order by pk desc
            limit ?
            """,
            (BOT_ERRORS_KEY, lookback),
        ).fetchall()
    finally:
        conn.close()
    if not rows:
        return 0, lookback
    oldest_replayed_pk = min(int(row[0]) for row in rows)
    return max(0, oldest_replayed_pk - 1), lookback


def socket_rpc_lock_path() -> Path:
    default_root = Path(os.environ.get("BOT_ERRORS_STATE_DIR", Path.home() / ".local/state/bot-errors"))
    return Path(os.environ.get("BOT_ERRORS_SOCKET_RPC_LOCK", default_root / "socket-rpc.lock")).expanduser()


@contextmanager
def socket_rpc_lock(timeout: float):
    path = socket_rpc_lock_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    deadline = time.monotonic() + timeout
    locked = False
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"timeout waiting for socket RPC lock: {path}")
                time.sleep(0.05)
        yield
    finally:
        if locked:
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def rpc_call(socket_path: str, name: str, args: dict[str, Any], timeout: float = 15.0) -> dict[str, Any]:
    init_id = 1
    call_id = 2
    init = {
        "jsonrpc": "2.0",
        "id": init_id,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "bot-errors-q-loop", "version": "1.0.0"},
        },
    }
    call = {
        "jsonrpc": "2.0",
        "id": call_id,
        "method": "tools/call",
        "params": {"name": name, "arguments": args},
    }
    with socket_rpc_lock(timeout):
        deadline = time.monotonic() + timeout
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(socket_path)
            sock.sendall((json.dumps(init) + "\n").encode())
            buffer = b""
            initialized = False
            while time.monotonic() < deadline:
                chunk = sock.recv(65536)
                if not chunk:
                    raise RuntimeError("socket closed before response")
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not line.strip():
                        continue
                    msg = json.loads(line.decode())
                    if msg.get("id") == init_id and not initialized:
                        if "error" in msg:
                            raise RuntimeError(f"initialize failed: {msg['error']}")
                        initialized = True
                        sock.sendall((json.dumps(call) + "\n").encode())
                        continue
                    if msg.get("id") == call_id:
                        if "error" in msg:
                            raise RuntimeError(f"tool call failed: {msg['error']}")
                        return msg.get("result", {})
    raise TimeoutError(f"timeout calling {name}")


def validate_bot_errors_target() -> str | None:
    if not BOT_ERRORS_JID:
        return "BOT_ERRORS_JID is required for live Q-loop send"
    if not GROUP_JID_RE.match(BOT_ERRORS_JID):
        return "BOT_ERRORS_JID must be a WhatsApp group JID for live Q-loop send"
    if BOT_ERRORS_REQUIRE_EXPECTED and not BOT_ERRORS_EXPECTED_JID:
        return "BOT_ERRORS_EXPECTED_JID is required for live Q-loop send"
    if BOT_ERRORS_EXPECTED_JID and BOT_ERRORS_JID != BOT_ERRORS_EXPECTED_JID:
        return "BOT_ERRORS_JID does not match BOT_ERRORS_EXPECTED_JID for live Q-loop send"
    return None


def send_message(socket_path: str, text: str) -> bool:
    try:
        target_error = validate_bot_errors_target()
        if target_error:
            raise RuntimeError(target_error)
        result = rpc_call(socket_path, "send_message", {"chatJid": BOT_ERRORS_JID, "text": text})
        if result.get("isError") is True:
            detail = json.dumps(result, sort_keys=True)[:500]
            raise RuntimeError(f"send_message returned error: {detail}")
    except Exception as exc:  # noqa: BLE001 - log and keep daemon alive.
        log_event("send_failed", {"error": str(exc), "preview": text[:240]})
        return False
    log_event("send_ok", {"result": result, "preview": text[:240]})
    return True


def message_role(message: dict[str, Any]) -> str:
    if int(message.get("is_from_me") or 0) == 1:
        body = str(message.get("body") or "")
        if body.startswith("Codex ->"):
            return "codex"
        if body.startswith("Lucas ->"):
            return "lucas"
        return "outbound"
    sender = str(message.get("sender_name") or "")
    sender_jid = str(message.get("sender_jid") or "")
    q_lid = os.environ.get("BOT_ERRORS_Q_LID", "").strip()
    if sender.lower() == "q" or (q_lid and sender_jid == q_lid):
        return "q"
    return "participant"


def q_unavailable_reason(body: str) -> str | None:
    if re.search(r"\byou(?:'|’)ve hit your session limit\b", body, re.I):
        return "session_limit"
    if re.search(r"\bsession limit\b.*\bresets\b", body, re.I):
        return "session_limit"
    return None


def persist_activity_state(state: dict[str, Any], reason: str, persist_state: Any | None) -> None:
    if persist_state is None:
        return
    persist_state(state)
    log_event(
        "activity_state_persisted",
        {
            "reason": reason,
            "phase": state.get("phase"),
            "blocked_since": state.get("blocked_since"),
            "last_seen_pk": state.get("last_seen_pk"),
        },
    )


def classify_activity(state: dict[str, Any], messages: list[dict[str, Any]], persist_state: Any | None = None) -> None:
    for message in messages:
        pk = int(message["pk"])
        body = str(message.get("body") or "")
        ts = int(message.get("timestamp") or now())
        role = message_role(message)
        state["last_seen_pk"] = max(int(state.get("last_seen_pk", 0)), pk)
        state["last_activity_at"] = max(int(state.get("last_activity_at", 0)), ts)
        append_activity({"pk": pk, "role": role, "sender": message.get("sender_name", ""), "body": body[:4000]})
        if role == "q":
            state["last_q_message_at"] = max(int(state.get("last_q_message_at", 0)), ts)
            unavailable_reason = q_unavailable_reason(body)
            if unavailable_reason:
                state["last_q_unavailable_at"] = ts
                state["last_q_unavailable_reason"] = unavailable_reason
                state["blocked_since"] = ts
                state["awaiting_q_since"] = 0
                state["phase"] = f"q_unavailable_{unavailable_reason}"
                persist_activity_state(state, f"q_unavailable_{unavailable_reason}", persist_state)
            elif re.search(r"\bAPPROVED SCOPE\b", body, re.I):
                state["scope_approved_at"] = ts
                state["blocked_since"] = 0
                state["awaiting_q_since"] = 0
                state["phase"] = "sdlc_spec_and_preslice"
                persist_activity_state(state, "q_approved_scope", persist_state)
            elif re.search(r"\bAPPROVED\b", body, re.I):
                state["blocked_since"] = 0
                state["awaiting_q_since"] = 0
                state["phase"] = "monitoring"
                persist_activity_state(state, "q_approved", persist_state)
            elif re.search(r"(?im)^\s*(?:[*_`]+)?BLOCKED\b", body):
                state["blocked_since"] = ts
                state["awaiting_q_since"] = 0
                state["phase"] = "blocked_by_q"
                persist_activity_state(state, "q_blocked", persist_state)
            elif re.search(r"\b(no response needed|standing by|no post warranted|nothing new|no actionable change|monitoring continues|continuing (?:to )?monitor(?:/poll)?)\b", body, re.I):
                state["awaiting_q_since"] = 0
                state["phase"] = "monitoring"
                persist_activity_state(state, "q_monitoring", persist_state)
        if role in {"codex", "lucas", "outbound"}:
            state["last_outbound_at"] = max(int(state.get("last_outbound_at", 0)), ts)
            if (
                ("reply" in body.lower() or "approve" in body.lower() or "blocked" in body.lower())
                and not body.startswith(SELF_REMINDER_PREFIXES)
            ):
                state["awaiting_q_since"] = ts
                persist_activity_state(state, "outbound_awaiting_q", persist_state)


def maybe_send_bootstrap(state: dict[str, Any], socket_path: str) -> bool:
    if state["sent"].get("daemon_online"):
        return False
    text = (
        BOOTSTRAP_HEADER + "\n\n"
        "I installed a supervised dynamic polling loop for BOT ERRORS coordination. "
        "It records chat activity, SDLC phase state, outbound asks, Q approvals/blocks, "
        "and adjusts wait time based on activity: 15s while active, 30s while waiting on Q, "
        "60s after recent activity, 5-15m when idle.\n\n"
        "This is not the incident bus; it is the conductor loop that keeps the 8-12h "
        "design/implementation/test validation moving and auditable while Lucas is away.\n\n"
        "Current approved gate: write the SDLC design spec with concrete SLAs, run the four "
        "pre-slice hotfix/checks, then start Slice 1 schema + writer. Completion remains blocked "
        "until Q verifies each gate with evidence."
    )
    if send_message(socket_path, text):
        state["sent"]["daemon_online"] = now()
        state["last_outbound_at"] = now()
        state["awaiting_q_since"] = now()
        return True
    return False


def maybe_send_nudge(state: dict[str, Any], socket_path: str) -> bool:
    waiting_since = int(state.get("awaiting_q_since", 0))
    if waiting_since <= 0:
        return False
    current = now()
    if current - waiting_since < NUDGE_AFTER_SECONDS:
        return False
    if current - int(state.get("last_nudge_at", 0)) < NUDGE_COOLDOWN_SECONDS:
        return False
    text = (
        NUDGE_HEADER + "\n\n"
        "The BOT ERRORS reliability work is still inside the approved SDLC gate. "
        "Please reply with APPROVED, BLOCKED, or the next concrete critique for the current gate. "
        "The loop will keep polling and will not mark this complete without evidence and Q validation."
    )
    if send_message(socket_path, text):
        state["last_nudge_at"] = current
        state["last_outbound_at"] = current
        return True
    return False


def maybe_send_checkpoint(state: dict[str, Any], socket_path: str) -> bool:
    current = now()
    if state.get("phase") == "monitoring":
        return False
    if current - int(state.get("last_checkpoint_at", 0)) < CHECKPOINT_AFTER_SECONDS:
        return False
    if current - int(state.get("last_activity_at", 0)) < CHECKPOINT_AFTER_SECONDS:
        return False
    phase = state.get("phase", "unknown")
    text = (
        CHECKPOINT_HEADER + "\n\n"
        f"Current phase: {phase}. "
        "Completion remains blocked until the approved design, pre-slice checks, Slice 1 evidence, "
        "adversarial review, and per-machine rollout gates are all green. "
        "Concrete SLA condition remains: critical BOT ERRORS delivery <=5m; deadman and daily "
        "capability misses have bounded ceilings in the design spec."
    )
    if send_message(socket_path, text):
        state["last_checkpoint_at"] = current
        state["last_outbound_at"] = current
        return True
    return False


def compute_wait(state: dict[str, Any], had_activity: bool, sent_message: bool) -> int:
    if had_activity or sent_message:
        state["idle_cycles"] = 0
        return ACTIVE_WAIT_SECONDS
    current = now()
    if int(state.get("awaiting_q_since", 0)) > 0:
        return AWAITING_Q_WAIT_SECONDS
    if current - int(state.get("last_activity_at", 0)) < 15 * 60:
        return RECENT_ACTIVITY_WAIT_SECONDS
    state["idle_cycles"] = int(state.get("idle_cycles", 0)) + 1
    return min(MAX_IDLE_WAIT_SECONDS, IDLE_WAIT_SECONDS + (state["idle_cycles"] * 60))


def run_once(args: argparse.Namespace) -> int:
    ensure_private_dir(STATE_DIR)
    first_start = not STATE_FILE.exists()
    state = load_state()
    record_target_coverage(state)
    if first_start and int(state.get("last_seen_pk", 0)) == 0:
        try:
            state["last_seen_pk"], lookback = bootstrap_cursor_pk(args.db)
            log_event("bootstrap_cursor", {"last_seen_pk": state["last_seen_pk"], "lookback_messages": lookback})
        except Exception as exc:  # noqa: BLE001
            log_event("bootstrap_cursor_failed", {"error": str(exc), "db": args.db})
    try:
        messages = read_messages(args.db, int(state.get("last_seen_pk", 0)))
    except Exception as exc:  # noqa: BLE001
        error = str(exc)
        log_event("poll_failed", {"error": error, "db": args.db})
        state["last_poll_error_at"] = now()
        state["last_poll_error"] = error[:500]
        state["consecutive_poll_failures"] = int(state.get("consecutive_poll_failures", 0)) + 1
        save_state(state)
        messages = []
    else:
        if int(state.get("consecutive_poll_failures", 0)) > 0:
            log_event("poll_recovered", {"failures": state.get("consecutive_poll_failures", 0)})
        state["last_poll_error_at"] = 0
        state["last_poll_error"] = ""
        state["consecutive_poll_failures"] = 0
    had_activity = bool(messages)
    if messages:
        classify_activity(state, messages, save_state)
        log_event("poll_activity", {"count": len(messages), "last_pk": state.get("last_seen_pk")})
    sent = False
    if not args.no_send:
        sent = maybe_send_bootstrap(state, args.socket)
        sent = maybe_send_nudge(state, args.socket) or sent
        sent = maybe_send_checkpoint(state, args.socket) or sent
    wait_seconds = compute_wait(state, had_activity, sent)
    state["next_wait_seconds"] = wait_seconds
    save_state(state)
    print(
        json.dumps(
            {
                "time": iso(),
                "messages": len(messages),
                "phase": state.get("phase"),
                "last_seen_pk": state.get("last_seen_pk"),
                "sent": sent,
                "next_wait_seconds": wait_seconds,
            },
            sort_keys=True,
        ),
        flush=True,
    )
    return wait_seconds


def run_loop(args: argparse.Namespace) -> None:
    while True:
        wait_seconds = run_once(args)
        time.sleep(wait_seconds)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="BOT ERRORS Q coordination loop")
    parser.add_argument("--db", default=os.environ.get("BOT_ERRORS_DB", DEFAULT_DB))
    parser.add_argument("--socket", default=os.environ.get("BOT_ERRORS_SOCKET", DEFAULT_SOCKET))
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--no-send", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not BOT_ERRORS_KEY:
        print("missing BOT_ERRORS_KEY or BOT_ERRORS_JID", file=sys.stderr)
        return 64
    if not args.db:
        print("missing BOT_ERRORS_DB or --db", file=sys.stderr)
        return 64
    db_error = validate_db(args.db)
    if db_error:
        print(db_error, file=sys.stderr)
        log_event("db_validation_failed", {"error": db_error, "db": args.db})
        return 64
    if not args.no_send:
        target_error = validate_bot_errors_target()
        if target_error:
            print(target_error, file=sys.stderr)
            log_event("target_validation_failed", {"error": target_error})
            return 64
    if not args.no_send and not args.socket:
        print("missing BOT_ERRORS_SOCKET or --socket", file=sys.stderr)
        return 64
    if args.once:
        run_once(args)
        return 0
    run_loop(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
