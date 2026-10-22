"""Active direct-DM round-trip liveness probe (bead: active-liveness-checks-fleet, layer 3).

Send a sentinel to an instance's OWN jid over its MCP socket, prove the send was
accepted (verify-by-state via :mod:`lib.send_acceptance`), then confirm the
sentinel landed in that instance's own ``messages`` table as a ``fromMe`` echo.
This proves connectivity + send-acceptance + receive + DB-write end to end --
strictly stronger than a ``/health`` 200.

It does NOT prove the turn pipeline. A wedged line still runs ingest and stores
the ``fromMe`` echo without ever running a turn (Finding B in the bead), so a
self-DM lands even while no turn executes. Catching a turn-queue halt is layer 1
(a turn-completion probe), a separate check built on ``turn_failure_rate``.

Safe on agent lines: the self-DM is ``fromMe`` and is short-circuited by ingest
(``src/core/ingest.ts``) before any turn dispatch, so no self-response loop is
possible. The sentinel also carries a ``NO_REPLY`` tag for defence in depth, and
the probe asserts that zero turns were spawned for the sentinel -- flagging a
regression if the short-circuit ever stops holding.

The socket JSON-RPC framing here intentionally mirrors
``bot-errors-dispatcher.json_rpc_call`` (which unwraps the reply's ``result``
object before validation); the non-trivial acceptance proof is shared via
:mod:`lib.send_acceptance`. When that ``json_rpc_call`` is extracted into a
shared module, this duplication should be collapsed.
"""
from __future__ import annotations

import json
import os
import socket as _socket
import sqlite3
import time
from dataclasses import dataclass
from typing import Any, Callable

from lib.send_acceptance import (
    SendAcceptanceUnknown,
    SendNotAccepted,
    validate_send_acceptance,
)

SENTINEL_PREFIX = "WHATSOUP-DM-ROUNDTRIP"
# Prefix length used for the DB LIKE match. The instance-unique nonce lives well
# inside this window, so the match is specific to this probe run.
_MATCH_LEN = 48

SendFn = Callable[[str, str, str, float], dict[str, Any]]
LandingFn = Callable[[str, str, float, float], "tuple[bool, int]"]


class RoundtripConfigError(RuntimeError):
    """The dm_roundtrip roster is missing or malformed (fail-loud, not silent)."""


@dataclass(frozen=True)
class RoundtripTarget:
    """One probe endpoint: an instance, its socket, its own jid, and its DB."""

    name: str
    socket_path: str
    own_jid: str
    db_path: str


def build_sentinel(name: str, *, now: float | None = None, pid: int | None = None) -> str:
    """A run-unique, NO_REPLY-tagged sentinel that never matches a real message."""
    ts = int(now if now is not None else time.time())
    proc = pid if pid is not None else os.getpid()
    return f"[[{SENTINEL_PREFIX} {name} {ts}-{proc}]] liveness probe NO_REPLY"


def parse_roster(raw: str, *, default_db_for: Callable[[str], str]) -> list[RoundtripTarget]:
    """Parse the dm_roundtrip roster JSON into targets.

    ``raw`` is a JSON array of objects ``{name, socket, own_jid[, db]}``. ``db``
    defaults to ``default_db_for(name)`` when omitted. Every parse failure is
    raised as :class:`RoundtripConfigError` so an enabled-but-misconfigured
    check pages a config problem instead of silently probing nothing.
    """
    text = (raw or "").strip()
    if not text:
        raise RoundtripConfigError("roster is empty")
    try:
        data = json.loads(text)
    except (TypeError, ValueError) as exc:
        raise RoundtripConfigError(f"roster is not valid JSON: {str(exc)[:120]}") from exc
    if not isinstance(data, list) or not data:
        raise RoundtripConfigError("roster must be a non-empty JSON array")
    targets: list[RoundtripTarget] = []
    seen: set[str] = set()
    for index, entry in enumerate(data):
        if not isinstance(entry, dict):
            raise RoundtripConfigError(f"roster entry {index} is not an object")
        name = str(entry.get("name") or "").strip()
        socket_path = str(entry.get("socket") or "").strip()
        own_jid = str(entry.get("own_jid") or "").strip()
        if not name or not socket_path or not own_jid:
            raise RoundtripConfigError(
                f"roster entry {index} requires name, socket, own_jid"
            )
        if name in seen:
            raise RoundtripConfigError(f"roster has duplicate instance name: {name}")
        seen.add(name)
        db_path = str(entry.get("db") or "").strip() or default_db_for(name)
        if not db_path:
            raise RoundtripConfigError(f"roster entry {name} has no resolvable db path")
        targets.append(RoundtripTarget(name, socket_path, own_jid, db_path))
    return targets


def json_rpc_send(socket_path: str, chat_jid: str, text: str, timeout: float = 15.0) -> dict[str, Any]:
    """Send ``text`` to ``chat_jid`` over the instance MCP socket; return the
    unwrapped tool ``result`` (``isError``/``content`` at top level), matching
    the dispatcher's json_rpc_call so :func:`validate_send_acceptance` applies."""
    if not socket_path:
        raise RuntimeError("socket path missing")
    if not os.path.exists(socket_path):
        raise RuntimeError(f"socket missing: {socket_path}")
    init_id = int(time.time() * 1000)
    call_id = init_id + 1
    with _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(socket_path)
        reader = sock.makefile("r", encoding="utf-8", newline="\n")
        writer = sock.makefile("w", encoding="utf-8", newline="\n")

        def _send(obj: dict[str, Any]) -> None:
            writer.write(json.dumps(obj) + "\n")
            writer.flush()

        def _wait(msg_id: int) -> dict[str, Any]:
            while True:
                line = reader.readline()
                if not line:
                    raise RuntimeError("socket closed before response")
                msg = json.loads(line)
                if msg.get("id") == msg_id:
                    result = msg.get("result", {})
                    return result if isinstance(result, dict) else {"result": result}

        _send({
            "jsonrpc": "2.0",
            "id": init_id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "dm-roundtrip-probe", "version": "1.0.0"},
            },
        })
        _wait(init_id)
        _send({
            "jsonrpc": "2.0",
            "id": call_id,
            "method": "tools/call",
            "params": {"name": "send_message", "arguments": {"chatJid": chat_jid, "text": text}},
        })
        return _wait(call_id)


def poll_landing(db_path: str, sentinel: str, deadline_s: float, poll_interval_s: float) -> "tuple[bool, int]":
    """Poll the instance DB until the sentinel lands as a fromMe row or the
    deadline passes. Return ``(landed, turns_spawned)`` where ``turns_spawned``
    is the number of ``inbound_events`` referencing the sentinel (expected 0).
    Read-only: ``mode=ro`` + ``PRAGMA query_only``."""
    like = f"%{sentinel[:_MATCH_LEN]}%"
    deadline = time.monotonic() + max(0.0, deadline_s)
    interval = max(0.05, poll_interval_s)
    landed = False
    while True:
        landed = _seen_from_me(db_path, like)
        if landed or time.monotonic() >= deadline:
            break
        time.sleep(interval)
    turns = _turns_for(db_path, like) if landed else 0
    return landed, turns


def _connect_ro(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    conn.execute("PRAGMA query_only=ON")
    return conn


def _seen_from_me(db_path: str, like: str) -> bool:
    conn = _connect_ro(db_path)
    try:
        row = conn.execute(
            "SELECT is_from_me FROM messages "
            "WHERE content LIKE ? OR content_text LIKE ? LIMIT 1",
            (like, like),
        ).fetchone()
        return row is not None and row[0] == 1
    finally:
        conn.close()


def _turns_for(db_path: str, like: str) -> int:
    conn = _connect_ro(db_path)
    try:
        return conn.execute(
            "SELECT COUNT(*) FROM inbound_events e "
            "JOIN messages m ON m.message_id = e.message_id "
            "WHERE m.content LIKE ? OR m.content_text LIKE ?",
            (like, like),
        ).fetchone()[0]
    finally:
        conn.close()


def evaluate_target(
    target: RoundtripTarget,
    *,
    timeout: float,
    deadline_s: float,
    poll_interval_s: float,
    send_fn: SendFn = json_rpc_send,
    landing_fn: LandingFn = poll_landing,
    sentinel: str | None = None,
) -> str | None:
    """Run one round-trip. Return a problem string, or ``None`` when healthy.

    Failure taxonomy (each is actionable):
    - send raised           -> socket/transport dead (line unreachable)
    - SendNotAccepted       -> the tool proved it did NOT send (rejection)
    - SendAcceptanceUnknown -> outcome unproven (ambiguous; treat as a problem)
    - no DB echo in time    -> accepted but never received/stored (partial line)
    - turns > 0             -> fromMe echo-guard regression (self-loop risk)
    """
    probe = sentinel or build_sentinel(target.name)
    try:
        result = send_fn(target.socket_path, target.own_jid, probe, timeout)
    except Exception as exc:  # noqa: BLE001 -- any transport failure is unreachable
        return f"dm_roundtrip send failed: instance={target.name} error={str(exc)[:160]}"
    try:
        validate_send_acceptance(result, target.own_jid)
    except SendNotAccepted as exc:
        return f"dm_roundtrip send rejected: instance={target.name} reason={str(exc)[:160]}"
    except SendAcceptanceUnknown as exc:
        return f"dm_roundtrip send unconfirmed: instance={target.name} reason={str(exc)[:160]}"
    try:
        landed, turns = landing_fn(target.db_path, probe, deadline_s, poll_interval_s)
    except Exception as exc:  # noqa: BLE001 -- DB read failure is itself a signal
        return f"dm_roundtrip db read failed: instance={target.name} error={str(exc)[:160]}"
    if not landed:
        return (
            f"dm_roundtrip no self-DM echo: instance={target.name} "
            f"sentinel absent from messages within {deadline_s:g}s "
            f"(send accepted but not received/stored)"
        )
    if turns > 0:
        return (
            f"dm_roundtrip echo-guard regression: instance={target.name} "
            f"sentinel spawned {turns} turn(s) -- fromMe short-circuit failed"
        )
    return None
