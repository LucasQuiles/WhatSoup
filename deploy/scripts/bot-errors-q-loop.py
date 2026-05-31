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
import json
import os
import re
import socket
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any


BOT_ERRORS_JID = os.environ.get("BOT_ERRORS_JID", "")
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
NUDGE_AFTER_SECONDS = 20 * 60
NUDGE_COOLDOWN_SECONDS = 45 * 60
CHECKPOINT_AFTER_SECONDS = 60 * 60


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
        "last_outbound_at": 0,
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
        loaded = json.loads(STATE_FILE.read_text())
    except Exception as exc:  # noqa: BLE001 - operational daemon must recover.
        log_event("state_corrupt", {"error": str(exc), "path": str(STATE_FILE)})
        backup = STATE_FILE.with_suffix(f".corrupt.{now()}.json")
        try:
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
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = now()
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, STATE_FILE)


def log_event(kind: str, data: dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    record = {"ts": now(), "time": iso(), "kind": kind, **data}
    with EVENT_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")


def append_activity(record: dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with ACTIVITY_LOG.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"ts": now(), "time": iso(), **record}, sort_keys=True) + "\n")


def read_messages(db_path: str, after_pk: int) -> list[dict[str, Any]]:
    conn = sqlite3.connect(db_path)
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
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "select coalesce(max(pk), 0) from messages where conversation_key = ?",
            (BOT_ERRORS_KEY,),
        ).fetchone()
    finally:
        conn.close()
    return int(row[0] if row else 0)


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


def send_message(socket_path: str, text: str) -> bool:
    try:
        result = rpc_call(socket_path, "send_message", {"chatJid": BOT_ERRORS_JID, "text": text})
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
    sender = str(message.get("sender_name") or message.get("sender_jid") or "")
    if sender.lower() == "q":
        return "q"
    return "participant"


def classify_activity(state: dict[str, Any], messages: list[dict[str, Any]]) -> None:
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
            if re.search(r"\bAPPROVED SCOPE\b", body, re.I):
                state["scope_approved_at"] = ts
                state["blocked_since"] = 0
                state["awaiting_q_since"] = 0
                state["phase"] = "sdlc_spec_and_preslice"
            elif re.search(r"\bAPPROVED\b", body, re.I):
                state["blocked_since"] = 0
                state["awaiting_q_since"] = 0
                state["phase"] = "monitoring"
            elif re.search(r"(?im)^\s*(?:[*_`]+)?BLOCKED\b", body):
                state["blocked_since"] = ts
                state["awaiting_q_since"] = 0
                state["phase"] = "blocked_by_q"
            elif re.search(r"\b(no response needed|standing by|no post warranted|nothing new|no actionable change|monitoring continues|continuing (?:to )?monitor(?:/poll)?)\b", body, re.I):
                state["awaiting_q_since"] = 0
                state["phase"] = "monitoring"
        if role in {"codex", "lucas", "outbound"}:
            state["last_outbound_at"] = max(int(state.get("last_outbound_at", 0)), ts)
            if "reply" in body.lower() or "approve" in body.lower() or "blocked" in body.lower():
                state["awaiting_q_since"] = ts


def maybe_send_bootstrap(state: dict[str, Any], socket_path: str) -> bool:
    if state["sent"].get("daemon_online"):
        return False
    text = (
        "Codex -> Q / durable coordination loop online\n\n"
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
        "Codex -> Q / gate nudge\n\n"
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
        "Codex -> Q / hourly SDLC checkpoint\n\n"
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
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    first_start = not STATE_FILE.exists()
    state = load_state()
    if first_start and int(state.get("last_seen_pk", 0)) == 0:
        try:
            state["last_seen_pk"] = latest_message_pk(args.db)
            log_event("bootstrap_cursor", {"last_seen_pk": state["last_seen_pk"]})
        except Exception as exc:  # noqa: BLE001
            log_event("bootstrap_cursor_failed", {"error": str(exc), "db": args.db})
    try:
        messages = read_messages(args.db, int(state.get("last_seen_pk", 0)))
    except Exception as exc:  # noqa: BLE001
        log_event("poll_failed", {"error": str(exc), "db": args.db})
        messages = []
    had_activity = bool(messages)
    if messages:
        classify_activity(state, messages)
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
    if not args.no_send and not BOT_ERRORS_JID:
        print("missing BOT_ERRORS_JID", file=sys.stderr)
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
