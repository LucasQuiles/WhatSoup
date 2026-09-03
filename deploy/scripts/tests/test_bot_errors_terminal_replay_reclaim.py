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


def _clear_event(event_id: str, status: str) -> dict:
    """A delivered RECOVERY, in the shape the envelope classifier accepts.

    The kind is "incident_recovery" with eventType "clear" and severity "info";
    an "incident_clear" kind is rejected as unknown_event_kind.
    """
    event = _event(event_id, status)
    event["eventKind"] = "incident_recovery"
    event["eventType"] = "clear"
    event["severity"] = "info"
    return event


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


def test_the_replay_repair_survives_its_own_commit(tmp_path):
    """MUST-D: the save-path sweep must not erase the repair that commits it.

    _normalize_incident_state_for_save runs the sweep on EVERY save, and the
    sweep drops any key that is not in openIncidents. In the pre-commit crash
    window the incident marker is exactly what was lost, so the terminal-replay
    repair recorded the conversation and then its own commit swept the record
    straight back out: openIncidents stayed empty and the next event for that
    conversation paged a second time for an alert already delivered.

    SCOPE: this drives the ALERT path only. The clear half -- a delivered clear
    archiving with its incident still open -- is a different defect on the same
    branch and is pinned separately in
    test_a_delivered_clear_in_the_crash_window_closes_its_incident below.
    """
    mod = _load(tmp_path / "replay-survives")
    paths = mod.setup_dirs()
    event = _event("evt-crash-swept", "sent")
    key = mod.incident_key(event)

    # The crash window WITHOUT the incident-open marker: that write is what the
    # crash lost, so the replay must not depend on it surviving.
    mod.save_incident_state(paths, {
        "version": 1, "openIncidents": {}, "lastSentAt": {}, "conversationScopes": {},
    })
    claimed = paths["processing"] / f"20260902.{INSTANCE}.{SOURCE}.{event['id']}.json.999.processing"
    claimed.write_text(json.dumps(event, indent=2))
    claimed.chmod(0o600)

    calls = _cycle(mod, paths)
    assert calls == [], f"the replay itself must not page: {len(calls)}"

    persisted = mod.load_incident_state(paths)
    scopes = persisted.get("conversationScopes") or {}
    assert key in scopes and SCOPE in scopes[key], (
        "the replay repair must survive the commit that persists it, or the "
        f"next event pages a second time for a delivered alert: {scopes!r}"
    )

    # And the consequence the repair exists to prevent: a repeat stays quiet.
    repeat = _event("evt-crash-swept-repeat", "queued")
    repeat_path = paths["outbox"] / f"20260902.{INSTANCE}.{SOURCE}.{repeat['id']}.json"
    repeat_path.write_text(json.dumps(repeat, indent=2))
    repeat_path.chmod(0o600)
    again: list = []
    with patch.object(mod, "send_whatsapp", side_effect=lambda *a, **k: again.append(a)):
        if mod.ready(repeat_path, paths["quarantine"]):
            mod.process_one(repeat_path, paths)
    assert again == [], (
        f"a repeat of an already-delivered conversation must stay suppressed: {len(again)}"
    )


def test_a_delivered_clear_in_the_crash_window_closes_its_incident(tmp_path):
    """MUST-1: the replay branch must apply the transition for ANY kind.

    The branch repaired only the alert half, so a clear caught in the crash
    window archived with its incident permanently open. Nothing reopened it:
    the clear had been delivered, so no later event closes it either. The fix
    is to re-apply the canonical transition rather than to add a clear branch
    beside the alert one, because the enumeration is the defect.
    """
    mod = _load(tmp_path / "clear-crash")
    paths = mod.setup_dirs()
    event = _clear_event("evt-clear-crash", "sent")
    key = mod.incident_key(event)
    assert mod.is_incident_clear(event), "the fixture must be a recovery"

    now = int(time.time())
    mod.save_incident_state(paths, {
        "version": 1,
        "openIncidents": {key: {"status": "open", "openedAt": now - 600}},
        "lastSentAt": {key: now - 60},
        "conversationScopes": {},
    })
    claimed = paths["processing"] / f"20260903.{INSTANCE}.{SOURCE}.{event['id']}.json.999.processing"
    claimed.write_text(json.dumps(event, indent=2))
    claimed.chmod(0o600)

    calls = _cycle(mod, paths)

    # CONTROL, not the red: an already-delivered clear is not re-sent either
    # way, so this passes on both sides of the fix.
    assert calls == [], f"a delivered clear must not be re-sent: {len(calls)}"

    persisted = mod.load_incident_state(paths)
    assert key not in (persisted.get("openIncidents") or {}), (
        "a delivered clear must close its incident even when the crash window "
        f"cost the commit: {persisted.get('openIncidents')!r}"
    )
    assert key not in (persisted.get("lastSentAt") or {}), (
        f"and must clear its lastSentAt: {persisted.get('lastSentAt')!r}"
    )


def test_replaying_an_already_committed_alert_changes_nothing(tmp_path):
    """A1: the replay branch must be idempotent for an alert already recorded.

    mark_incident_sent is not idempotent -- it increments renotifyCount and
    advances lastSentAt whenever a record exists -- and the replay branch fires
    for any terminal file left in processing/, including a crash AFTER the
    state commit. Applying the transition again there would inflate the
    renotify cadence for an alert nobody re-sent.
    """
    mod = _load(tmp_path / "already-committed")
    paths = mod.setup_dirs()
    event = _event("evt-already-committed", "sent")
    key = mod.incident_key(event)

    now = int(time.time())
    committed = {
        "status": "open",
        "openedAt": now - 600,
        "eventId": event["id"],
        "renotifyCount": 3,
    }
    mod.save_incident_state(paths, {
        "version": 1,
        "openIncidents": {key: dict(committed)},
        "lastSentAt": {key: now - 600},
        "conversationScopes": {},
    })
    claimed = paths["processing"] / f"20260903.{INSTANCE}.{SOURCE}.{event['id']}.json.999.processing"
    claimed.write_text(json.dumps(event, indent=2))
    claimed.chmod(0o600)

    _cycle(mod, paths)

    persisted = mod.load_incident_state(paths)
    record = (persisted.get("openIncidents") or {}).get(key) or {}
    assert record.get("renotifyCount") == 3, (
        f"replaying a committed alert must not advance the renotify cadence: {record!r}"
    )
    assert (persisted.get("lastSentAt") or {}).get(key) == now - 600, (
        f"nor advance lastSentAt: {persisted.get('lastSentAt')!r}"
    )


def _email_delivered(mod, paths, event, tmp_path) -> tuple:
    """Drive process_one down the accepted-email route for `event`."""
    queued = paths["outbox"] / f"20260903.{INSTANCE}.{SOURCE}.{event['id']}.json"
    event = dict(event)
    event["delivery"] = {"attempts": 3, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None}
    queued.write_text(json.dumps(event, indent=2))
    queued.chmod(0o600)
    fallback = tmp_path / "fake-fallback.sh"
    fallback.write_text("#!/bin/sh\nexit 0\n")
    fallback.chmod(0o755)
    with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("transport down")), \
         patch.object(mod, "email_fallback_blocked_reason", return_value=None), \
         patch.object(mod, "EMAIL_FALLBACK", str(fallback)), \
         patch.object(mod, "email_fallback", return_value=True):
        return mod.process_one(queued, paths)


def test_an_email_delivered_alert_opens_its_incident(tmp_path):
    """SHOULD-6: email is a delivery, so it must leave the same incident state.

    The email branch returned before mark_incident_sent and opened neither
    openIncidents nor lastSentAt, while the replay branch treats
    email_delivered as terminal and opens both. Incident state therefore
    depended on whether a crash happened to intervene. Email is a real
    operator-visible route, so the email branch is the side that was wrong.
    """
    mod = _load(tmp_path / "email-alert")
    paths = mod.setup_dirs()
    event = _event("evt-email-alert", "queued")
    key = mod.incident_key(event)
    mod.save_incident_state(paths, {"version": 1, "openIncidents": {}, "lastSentAt": {}})

    ok, detail = _email_delivered(mod, paths, event, tmp_path)
    assert (ok, detail) == (True, "email_delivered"), (ok, detail)

    persisted = mod.load_incident_state(paths)
    assert key in (persisted.get("openIncidents") or {}), (
        f"an email-delivered alert must open its incident: {persisted.get('openIncidents')!r}"
    )
    assert key in (persisted.get("lastSentAt") or {}), (
        f"and set lastSentAt so same-key events dedupe: {persisted.get('lastSentAt')!r}"
    )


def test_an_email_delivered_clear_closes_its_incident(tmp_path):
    """SHOULD-6, the clear half: it is MUST-1's defect on a second path.

    Nothing on the path from process_one to the email branch checks kind -- the
    gate keys on attempts and the provenance veto -- so a clear reaches it and
    used to archive with its incident still open, exactly as in the crash
    window.
    """
    mod = _load(tmp_path / "email-clear")
    paths = mod.setup_dirs()
    event = _clear_event("evt-email-clear", "queued")
    key = mod.incident_key(event)
    now = int(time.time())
    mod.save_incident_state(paths, {
        "version": 1,
        "openIncidents": {key: {"status": "open", "openedAt": now - 600}},
        "lastSentAt": {key: now - 60},
    })

    ok, detail = _email_delivered(mod, paths, event, tmp_path)
    assert (ok, detail) == (True, "email_delivered"), (ok, detail)

    persisted = mod.load_incident_state(paths)
    assert key not in (persisted.get("openIncidents") or {}), (
        f"an email-delivered clear must close its incident: {persisted.get('openIncidents')!r}"
    )
