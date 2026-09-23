"""Owner critical route: copy selected critical BOT ERRORS alerts to the owner.

The BOT ERRORS group is written by the owner's own line, so the owner's phone
never notifies for it. This route sends a short, readable line from a SEPARATE
instance to the owner's direct chat, plus an e-mail through the existing
fallback script.

Inert unless BOT_ERRORS_OWNER_ROUTE_JID and BOT_ERRORS_OWNER_ROUTE_SOCKET are
set: nothing else is read or parsed without them. The dispatcher queues each
sent alert and calls this route after the cycle's group work and completion
stamp, within one shared time budget, and swallows every failure: this route
can never delay, fail, or re-send a group alert.

Policy:
  * severity critical, incident ALERT (never a clear);
  * source matches BOT_ERRORS_OWNER_ROUTE_SOURCES (fnmatch patterns);
  * first open only, plus ESCALATED still-open reminders; plain still-open
    renotifies are skipped;
  * at most one owner message per incident key per
    BOT_ERRORS_OWNER_ROUTE_MIN_INTERVAL_SECONDS (default 21600 = 6 h). The
    floor is recorded BEFORE the send, so a crash yields a missed copy, never
    a duplicate; the group copy exists either way;
  * whenever deduplication cannot be established the copy is skipped, never
    risked: an unreadable or corrupt state file, a state lock held by another
    caller, or a spent time budget each log a skip and send nothing.

Stale-incident digests are info severity and are never routed.

Dispatch-log records carry only booleans (``whatsappAccepted``,
``emailAccepted``, ``emailEnabled``, ``skippedMinInterval``): the controller log
keeps a string only when it is on its fixed allowlist, so free-text statuses
would be silently dropped.
"""
from __future__ import annotations

import fcntl
import fnmatch
import json
import os
import re
import socket
import time
from pathlib import Path
from typing import Any, Callable

from lib.send_acceptance import validate_send_acceptance

DEFAULT_SOURCES = (
    "provider_fallback_activated,"
    "runtime_provider_fallback_replay_failed,"
    "primary_model_unusable,"
    "agent_respawn_failed,"
    "agent365-reliability-fleet_*_primary_model_usable,"
    "reauth-observe:reauth_needed_manual,"
    "provider_credential_dead,"
    "instance_logged_out,"
    "whatsapp_device_bond_lost,"
    "owner_route_selftest"
)

SELFTEST_SOURCE = "owner_route_selftest"

TITLES = {
    "provider_fallback_activated": "switched to backup model (primary provider failing)",
    "runtime_provider_fallback_replay_failed": "backup model failed to answer a replayed message",
    "primary_model_unusable": "primary model unusable",
    "agent_respawn_failed": "agent failed to restart",
    "reauth-observe:reauth_needed_manual": "credential needs a manual re-login",
    "provider_credential_dead": "provider credential dead (re-login required)",
    "instance_logged_out": "WhatsApp logged out",
    "whatsapp_device_bond_lost": "WhatsApp device link lost",
    SELFTEST_SOURCE: "TEST — BOT ERRORS routing check",
}

STATE_RETENTION_SECONDS = 7 * 86400
EMAIL_TIMEOUT_SECONDS = 20.0

_FLEET_MODEL = re.compile(
    r"^agent365-reliability-fleet_([a-z0-9]+)_(.+?)_primary_model_usable(_unverified)?$"
)


def _cfg() -> dict[str, Any]:
    env = os.environ
    return {
        "jid": env.get("BOT_ERRORS_OWNER_ROUTE_JID", "").strip(),
        "resolved": env.get("BOT_ERRORS_OWNER_ROUTE_RESOLVED_JID", "").strip(),
        "socket": env.get("BOT_ERRORS_OWNER_ROUTE_SOCKET", "").strip(),
        "sources": [
            s.strip()
            for s in env.get("BOT_ERRORS_OWNER_ROUTE_SOURCES", DEFAULT_SOURCES).split(",")
            if s.strip()
        ],
        "email": env.get("BOT_ERRORS_OWNER_ROUTE_EMAIL", "1").strip().lower() in {"1", "true", "yes", "on"},
        "min_interval": int(env.get("BOT_ERRORS_OWNER_ROUTE_MIN_INTERVAL_SECONDS", "21600")),
        "timeout": float(env.get("BOT_ERRORS_OWNER_ROUTE_TIMEOUT_SECONDS", "8")),
    }


def _evidence_value(evidence: str, name: str) -> str | None:
    match = re.search(rf"(?m)^{re.escape(name)}=(\S+)$", evidence)
    return match.group(1) if match else None


def owner_line(event: dict[str, Any]) -> str:
    """'<host>/<bot>: <plain title> — <one-line detail>' built only from
    source/machine/instance and dispatcher-derived fields (never the
    digest-confined summary)."""
    source = str(event.get("source") or "")
    machine = str(event.get("machine") or "").strip()
    if not machine or machine.lower() == "unknown":
        diagnostics = event.get("diagnostics") if isinstance(event.get("diagnostics"), dict) else {}
        relay = diagnostics.get("relay") if isinstance(diagnostics.get("relay"), dict) else {}
        # No relay block = produced on this (dispatcher) host.
        machine = str(relay.get("remoteHost") or socket.gethostname()).strip().lower()
    instance = str(event.get("instance") or "").strip()
    title = TITLES.get(source)
    match = _FLEET_MODEL.match(source)
    if match:
        machine = match.group(1)
        instance = match.group(2).replace("_", "-")
        title = "primary model health unverified" if match.group(3) else "primary model check failed"
    if not title:
        title = source.replace("_", " ")
    where = "/".join(p for p in (machine, instance) if p and p.lower() != "unknown") or "unknown host"
    evidence = str(event.get("evidence") or "")
    event_id = str(event.get("id") or "")[:8]
    if _evidence_value(evidence, "escalated") == "true":
        age = _evidence_value(evidence, "age_seconds")
        hours = f"{int(age) // 3600} h" if age and age.isdigit() else "over 24 h"
        detail = f"still open after {hours} (escalated reminder); event {event_id}"
    else:
        detail = f"new critical alert; event {event_id}; full detail in BOT ERRORS group"
    if source == SELFTEST_SOURCE:
        return f"{title}: {where} — {detail}"
    return f"{where}: {title} — {detail}"


def qualifies(event: dict[str, Any], sources: list[str], is_alert: bool) -> str | None:
    """Return None when the event qualifies, else a skip reason."""
    if not is_alert:
        return "not_incident_alert"
    if str(event.get("severity") or "").lower() != "critical":
        return "not_critical"
    source = str(event.get("source") or "")
    if not any(fnmatch.fnmatchcase(source, pattern) for pattern in sources):
        return "source_not_routed"
    evidence = str(event.get("evidence") or "")
    if _evidence_value(evidence, "incident_still_open") == "true" and _evidence_value(evidence, "escalated") != "true":
        return "non_escalated_renotify"
    return None


class _StateUnreadable(Exception):
    """The state file exists but cannot be read or parsed."""


def _load_state(path: Path) -> dict[str, Any]:
    """Return the throttle state; a missing file is the empty initial state.

    Any other failure raises _StateUnreadable: treating an existing but
    unreadable file as empty would forget every floor and permit duplicates.
    """
    try:
        raw = path.read_text()
    except FileNotFoundError:
        return {}
    except OSError as exc:
        raise _StateUnreadable(str(exc)) from exc
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise _StateUnreadable(str(exc)) from exc
    if not isinstance(data, dict):
        raise _StateUnreadable("state is not an object")
    return data


def _save_state(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, sort_keys=True))
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def enabled() -> bool:
    env = os.environ
    return bool(
        env.get("BOT_ERRORS_OWNER_ROUTE_JID", "").strip()
        and env.get("BOT_ERRORS_OWNER_ROUTE_SOCKET", "").strip()
    )


def route_owner_critical(
    event: dict[str, Any],
    *,
    key: str,
    is_alert: bool,
    group_text: str,
    state_dir: Path,
    json_rpc_call: Callable[..., dict[str, Any]],
    email_fallback: Callable[..., bool],
    log: Callable[[dict[str, Any]], None],
    deadline: float | None = None,
) -> None:
    if not enabled():
        return
    cfg = _cfg()
    if qualifies(event, cfg["sources"], is_alert):
        return

    def skip(**flags: Any) -> None:
        log({"type": "owner_route_skipped", "eventId": event.get("id"), "incidentKey": key, **flags})

    def remaining() -> float:
        return float("inf") if deadline is None else deadline - time.monotonic()

    # Checked before the floor is recorded: a copy skipped for time must not
    # also block the next occurrence for a whole interval.
    if remaining() < 1:
        skip(skippedBudget=True)
        return
    state_path = state_dir / "owner-route-state.json"
    with (state_dir / "owner-route.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            skip(skippedLocked=True)
            return
        now = int(time.time())
        try:
            state = _load_state(state_path)
        except _StateUnreadable:
            skip(stateUnreadable=True)
            return
        entry = state.get(key)
        last = int(entry.get("lastAt") or 0) if isinstance(entry, dict) else 0
        if last and now - last < cfg["min_interval"]:
            skip(skippedMinInterval=True, sinceLastSeconds=now - last)
            return
        retention = max(STATE_RETENTION_SECONDS, cfg["min_interval"])
        state = {
            k: v for k, v in state.items()
            if isinstance(v, dict) and now - int(v.get("lastAt") or 0) < retention
        }
        state[key] = {"lastAt": now, "eventId": event.get("id")}
        _save_state(state_path, state)

    line = owner_line(event)
    whatsapp_accepted = False
    receipt: dict[str, str] = {}
    try:
        result = json_rpc_call(
            cfg["socket"],
            "tools/call",
            {"name": "send_message", "arguments": {"chatJid": cfg["jid"], "text": line}},
            timeout=max(1.0, min(cfg["timeout"], remaining())),
        )
        receipt = validate_send_acceptance(result, cfg["resolved"] or cfg["jid"])
        whatsapp_accepted = True
    except Exception:  # noqa: BLE001 - fail-open by design
        whatsapp_accepted = False
    email_accepted: bool | None = None
    email_skipped_budget = False
    if cfg["email"]:
        email_timeout = min(EMAIL_TIMEOUT_SECONDS, remaining())
        if email_timeout < 1:
            email_skipped_budget = True
        else:
            try:
                email_accepted = bool(email_fallback(line, f"{line}\n\n{group_text}", timeout=email_timeout))
            except Exception:  # noqa: BLE001
                email_accepted = False
    log({"type": "owner_route_sent", "eventId": event.get("id"), "incidentKey": key,
         "source": event.get("source"), "whatsappAccepted": whatsapp_accepted,
         "emailEnabled": cfg["email"], "emailAccepted": email_accepted,
         "emailSkippedBudget": email_skipped_budget,
         "auditReceipt": receipt.get("audit_receipt")})
