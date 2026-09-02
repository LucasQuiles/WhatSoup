"""A delivered event reclaimed from processing/ must not be paged again.

process_one publishes the terminal delivery record into the processing file
and commits incident state BEFORE os.replace() archives the file. A crash in
that window leaves a file in processing/ whose delivery.status is already
terminal -- "sent" on the primary route, "email_delivered" on the fallback.
reclaim_processing returns it to the outbox and the next cycle processes it
again.

The guard inside conversation_scope_is_unrepresented cannot see this: process_one
calls mark_attempt first, which unconditionally overwrites delivery.status with
"sending", so by the time the gate reads the record the terminal status is gone.
A test that calls should_suppress_send directly on a hand-written "sent" record
therefore passes while production re-pages -- the shape this suite exists to
prevent.

These tests drive the FULL production chain: reclaim_processing -> ready ->
process_one, with a sender spy that must stay untouched.
"""

from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path
from unittest.mock import patch

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

SOURCE = "agent_turn_admission_rejected"
INSTANCE = "instance-x"
MACHINE = "unknown"
SCOPE = "cs1_a1b2c3d4e5f60718"

_ENV_KEYS = ["BOT_ERRORS_STATE_DIR", "BOT_ERRORS_CONVERSATION_SCOPED_SOURCES"]


@pytest.fixture(autouse=True)
def _clean_env():
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    for k in _ENV_KEYS:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _load(state_dir: Path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location(
        f"bot_errors_dispatcher_replay_{state_dir.name}", _SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _event(event_id: str, status: str) -> dict:
    return {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "warning",
        "machine": MACHINE,
        "instance": INSTANCE,
        "source": SOURCE,
        "id": event_id,
        "createdAt": "2026-09-02T02:33:05.995Z",
        "conversationScope": SCOPE,
        "summary": {"failureClass": "unknown", "length": 44, "correlationDigest": "de" * 32},
        "evidence": {"failureClass": "Error", "length": 88, "correlationDigest": "00" * 32},
        # What process_one wrote just before the crash.
        "delivery": {"attempts": 1, "status": status, "nextAttemptAtEpoch": 0, "lastError": None},
    }


def _crashed_after_publish(mod, paths, event: dict) -> None:
    """Seed the crash window: a terminal record still sitting in processing/."""
    key = mod.incident_key(event)
    now = int(time.time())
    mod.save_incident_state(paths, {
        "version": 1,
        "openIncidents": {key: {"status": "open", "openedAt": now - 600}},
        "lastSentAt": {key: now - 60},
        "conversationScopes": {
            key: {SCOPE: {"lastSeenAt": now, "eventIds": {event["id"]: now}}}
        },
    })
    claimed = paths["processing"] / f"20260902.{INSTANCE}.{SOURCE}.{event['id']}.json.999.processing"
    claimed.write_text(json.dumps(event, indent=2))
    claimed.chmod(0o600)


def _cycle(mod, paths) -> list:
    """reclaim -> ready -> process_one, exactly as run_once sequences it."""
    mod.reclaim_processing(paths)
    calls: list = []
    with patch.object(mod, "send_whatsapp", side_effect=lambda *a, **k: calls.append(a)):
        for queued in sorted(paths["outbox"].glob("*.json")):
            if mod.ready(queued, paths["quarantine"]):
                mod.process_one(queued, paths)
    return calls


@pytest.mark.parametrize("status", ["sent", "email_delivered"])
def test_a_terminal_record_reclaimed_from_processing_is_not_re_paged(tmp_path, status):
    """Both terminal statuses: reclaimed, archived, and never re-sent."""
    mod = _load(tmp_path / f"replay-{status}")
    paths = mod.setup_dirs()
    event = _event(f"evt-crash-{status}", status)
    _crashed_after_publish(mod, paths, event)

    calls = _cycle(mod, paths)

    assert calls == [], (
        f"an event whose delivery already reads {status!r} was paged again "
        f"after being reclaimed from processing/: {len(calls)} send(s)"
    )
    leftover = [
        item for item in paths["processing"].glob("*") if ".processing" in item.name
    ]
    assert not leftover, f"the claimed file must not be left behind: {leftover}"
    archived = list(paths["sent"].glob("*.sent"))
    assert archived, "the reclaimed terminal record must be archived to sent/"
    assert not list(paths["outbox"].glob("*.json")), "a delivered event must not stay queued"


@pytest.mark.parametrize("status", ["sent", "email_delivered"])
def test_the_reclaimed_terminal_record_keeps_its_conversation_represented(tmp_path, status):
    """Representation must survive the replay, idempotently."""
    mod = _load(tmp_path / f"repr-{status}")
    paths = mod.setup_dirs()
    event = _event(f"evt-repr-{status}", status)
    _crashed_after_publish(mod, paths, event)
    key = mod.incident_key(event)

    _cycle(mod, paths)

    scopes = (mod.load_incident_state(paths).get("conversationScopes") or {})
    assert key in scopes and SCOPE in scopes[key], (
        f"the conversation must stay represented after the replay: {scopes!r}"
    )


def test_a_failed_delivery_replay_still_retries(tmp_path):
    """BOUNDARY: only a TERMINAL status short-circuits.

    A retry after a FAILED delivery carries a non-terminal status and must
    still reach the operator, or a transport blip silently consumes the one
    forced notification (#2428).
    """
    mod = _load(tmp_path / "retry")
    paths = mod.setup_dirs()
    event = _event("evt-transport-blip", "queued")
    event["delivery"]["lastError"] = "transport down"
    _crashed_after_publish(mod, paths, event)
    # Not yet represented: the earlier attempt never delivered.
    state = mod.load_incident_state(paths)
    state["conversationScopes"] = {}
    mod.save_incident_state(paths, state)

    calls = _cycle(mod, paths)

    assert len(calls) == 1, (
        "a retry after a failed delivery must still force its notification: "
        f"{len(calls)} send(s)"
    )


def test_a_first_attempt_transport_failure_records_nothing_then_delivers(tmp_path):
    """SHOULD-4: the retry lifecycle, driven rather than hand-written.

    The sibling unit tests construct the post-failure delivery record
    themselves, which pins the gate's reading of a record but not that the
    dispatcher ever writes one that shape. This drives the real process_one
    twice: the first attempt fails in transport, and nothing may be recorded
    as represented, because an operator saw nothing. The event is then
    requeued and the second attempt succeeds, which is what records it.
    """
    mod = _load(tmp_path / "retry-lifecycle")
    paths = mod.setup_dirs()
    event = _event("evt-retry-lifecycle", "queued")
    key = mod.incident_key(event)
    now = int(time.time())
    mod.save_incident_state(paths, {
        "version": 1,
        "openIncidents": {key: {"status": "open", "openedAt": now - 600}},
        "lastSentAt": {key: now - 60},
    })
    queued = paths["outbox"] / f"20260902.{INSTANCE}.{SOURCE}.{event['id']}.json"
    queued.write_text(json.dumps(event, indent=2))
    queued.chmod(0o600)

    with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("transport down")), \
         patch.object(mod, "email_fallback", return_value=False):
        mod.process_one(queued, paths)

    scopes = (mod.load_incident_state(paths).get("conversationScopes") or {})
    assert SCOPE not in scopes.get(key, {}), (
        "a conversation whose alert never reached an operator must not be "
        f"recorded as represented: {scopes!r}"
    )

    # The dispatcher requeued it. Second attempt, transport healthy.
    requeued = sorted(paths["outbox"].glob("*.json"))
    assert requeued, "a failed delivery must leave the event queued for retry"
    calls: list = []
    with patch.object(mod, "send_whatsapp", side_effect=lambda *a, **k: calls.append(a)):
        mod.process_one(requeued[0], paths)

    assert len(calls) == 1, f"the retry must still reach the operator: {len(calls)}"
    scopes = (mod.load_incident_state(paths).get("conversationScopes") or {})
    assert SCOPE in scopes.get(key, {}), (
        f"a delivered retry must record its conversation: {scopes!r}"
    )
