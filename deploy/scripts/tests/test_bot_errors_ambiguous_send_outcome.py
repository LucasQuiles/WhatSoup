"""An accepted-but-unconfirmed send must be held, never re-sent (#2424).

process_one publishes delivery.status = "sending" durably BEFORE it calls
send_whatsapp, and only publishes "sent" afterwards. A crash -- or a raising
publication -- between those two points leaves a record on disk that reads
"sending" and is indistinguishable from a record whose send never left the
process. reclaim_processing bounces every processing/ file back to the outbox
without consulting delivery status, so the restart sends a second time: one
accepted notification, two operator pages.

The terminal-replay guard does not cover this. It fires only for
TERMINAL_DELIVERY_STATUSES, which "sending" is not, and that frozenset means
"an operator HAS been shown this event" -- which an ambiguous outcome does not
prove. This suite owns the window the guard leaves open, and the sibling suite
test_bot_errors_terminal_replay_reclaim.py owns the window it closes.

The issue fixes the direction: "If reconciliation is unavailable, hold the
ambiguous item and emit one bounded metadata-only signal rather than silently
duplicating it." No transport idempotency exists at this baseline, so hold and
signal is the only duplicate-free option.

These tests drive the FULL production chain: reclaim_processing -> ready ->
process_one, with a sender spy that counts every remote send.
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

# Delivery statuses, named rather than repeated as literals.
QUEUED_STATUS = "queued"
IN_FLIGHT_STATUS = "sending"
SENT_STATUS = "sent"
HELD_STATUS = "outcome_unknown"

# The write-ahead marker that separates "the request was issued" from "the
# attempt was recorded but the request never left".
SEND_ISSUED_FIELD = "sendIssuedAt"
STALE_ISSUED_AT = "2026-09-01T00:00:00Z"

# The one bounded metadata-only signal emitted per held item.
HELD_SIGNAL_KIND = "delivery_outcome_unknown_held"

# Durable publication components, used to inject a failure at exactly one
# boundary. Patching publish_state_json wholesale would also fail the attempt
# publication, and the sender would never be reached at all.
SENT_PUBLICATION_COMPONENT = "dispatcher.process_sent_state"
ATTEMPT_PUBLICATION_COMPONENT = "dispatcher.process_attempt_state"

# Transport error classes. json_rpc_call raises RuntimeError for both, and the
# caller sees only the message, so the message is the classifier's input.
AMBIGUOUS_TRANSPORT_ERROR = "timeout waiting for JSON-RPC response"
LOST_CONNECTION_ERROR = "socket closed before response"
PROVEN_REJECTION_ERROR = "rpc error: {'code': -32602, 'message': 'unknown chat'}"
INJECTED_PUBLICATION_FAILURE = "injected sent-publication failure"

AMBIGUOUS_ERRORS = (AMBIGUOUS_TRANSPORT_ERROR, LOST_CONNECTION_ERROR)

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
        f"bot_errors_dispatcher_ambiguous_{state_dir.name}", _SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _event(event_id: str, status: str, **delivery: object) -> dict:
    record = {
        "attempts": 1,
        "status": status,
        "nextAttemptAtEpoch": 0,
        "lastError": None,
    }
    record.update(delivery)
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
        "delivery": record,
    }


def _open_incident(mod, paths, event: dict) -> None:
    """An open incident with no conversation recorded: the send is due."""
    key = mod.incident_key(event)
    now = int(time.time())
    mod.save_incident_state(paths, {
        "version": 1,
        "openIncidents": {key: {"status": "open", "openedAt": now - 600}},
        "lastSentAt": {key: now - 60},
        "conversationScopes": {},
    })


def _seed_processing(paths, event: dict) -> Path:
    """A claimed file stranded in processing/, as a crash leaves it."""
    claimed = paths["processing"] / (
        f"20260902.{INSTANCE}.{SOURCE}.{event['id']}.json.999.processing"
    )
    claimed.write_text(json.dumps(event, indent=2))
    claimed.chmod(0o600)
    return claimed


def _seed_outbox(paths, event: dict) -> Path:
    queued = paths["outbox"] / f"20260902.{INSTANCE}.{SOURCE}.{event['id']}.json"
    queued.write_text(json.dumps(event, indent=2))
    queued.chmod(0o600)
    return queued


def _cycle(mod, paths, raises: str | None = None) -> list:
    """reclaim -> ready -> process_one, exactly as run_once sequences it."""
    mod.reclaim_processing(paths)
    calls: list = []

    def _spy(*args, **kwargs):
        calls.append(args)
        if raises is not None:
            raise RuntimeError(raises)

    with patch.object(mod, "send_whatsapp", side_effect=_spy):
        for queued in sorted(paths["outbox"].glob("*.json")):
            if mod.ready(queued, paths["quarantine"]):
                mod.process_one(queued, paths)
    return calls


def _failing_publication(mod, component: str):
    """Fail exactly one durable publication, leaving every other one real."""
    original = mod.publish_state_json

    def _publish(*args, **kwargs):
        if kwargs.get("component") == component:
            raise RuntimeError(INJECTED_PUBLICATION_FAILURE)
        return original(*args, **kwargs)

    return patch.object(mod, "publish_state_json", side_effect=_publish)


def _processing_records(paths) -> list[dict]:
    records = []
    for path in sorted(paths["processing"].glob("*")):
        try:
            records.append(json.loads(path.read_text()))
        except ValueError:
            continue
    return records


def _delivery_status(record: dict) -> str:
    delivery = record.get("delivery")
    return str(delivery.get("status") or "") if isinstance(delivery, dict) else ""


def _record_kind(record: dict) -> str:
    for key in ("kind", "recordKind", "type"):
        value = record.get(key)
        if isinstance(value, str):
            return value
    return ""


def _held_signals(paths) -> list[dict]:
    log_path = paths["logs"] / "dispatch.jsonl"
    if not log_path.exists():
        return []
    signals = []
    for line in log_path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict) and _record_kind(record) == HELD_SIGNAL_KIND:
            signals.append(record)
    return signals


# --------------------------------------------------------------------------
# The open window: a send whose outcome is unknown must never be repeated.
# --------------------------------------------------------------------------


def test_a_crashed_in_flight_record_is_held_and_never_resent(tmp_path):
    """Acceptance 1, crash half: a second pass over the same on-disk state.

    The record was published with the request already issued and the process
    died before the sent publication. Nothing on disk proves the remote did or
    did not accept it, so the restart must not send again.
    """
    mod = _load(tmp_path / "crash-in-flight")
    paths = mod.setup_dirs()
    event = _event(
        "evt-2424-crash", IN_FLIGHT_STATUS, **{SEND_ISSUED_FIELD: STALE_ISSUED_AT}
    )
    _open_incident(mod, paths, event)
    _seed_processing(paths, event)

    calls = _cycle(mod, paths)

    assert calls == [], (
        "a send whose outcome is unknown was repeated after restart: "
        f"{len(calls)} send(s) for one accepted notification"
    )
    held = _processing_records(paths)
    assert len(held) == 1, f"the ambiguous record must be held, not moved: {held!r}"
    assert _delivery_status(held[0]) == HELD_STATUS, (
        f"the held record must carry a durable {HELD_STATUS!r} disposition: "
        f"{held[0].get('delivery')!r}"
    )
    assert not list(paths["outbox"].glob("*.json")), (
        "a held record must not be bounced back into the send queue"
    )
    assert not list(paths["sent"].glob("*.sent")), (
        "an unconfirmed send must never be archived as delivered"
    )
    assert len(_held_signals(paths)) == 1, (
        "a held item must emit exactly one signal: "
        f"{len(_held_signals(paths))}"
    )


def test_a_failed_sent_publication_holds_the_event_and_the_restart_does_not_resend(
    tmp_path,
):
    """Acceptance 1, raise-injected half: the sent publication fails.

    The send was accepted. The publication that would have recorded it raises,
    so the process unwinds with the record still reading "sending". Exactly one
    remote notification may exist across both passes.
    """
    mod = _load(tmp_path / "sent-publication-fails")
    paths = mod.setup_dirs()
    event = _event("evt-2424-publish", QUEUED_STATUS)
    _open_incident(mod, paths, event)
    queued = _seed_outbox(paths, event)

    first: list = []
    with _failing_publication(mod, SENT_PUBLICATION_COMPONENT):
        with patch.object(
            mod, "send_whatsapp", side_effect=lambda *a, **k: first.append(a)
        ):
            with pytest.raises(RuntimeError):
                mod.process_one(queued, paths)

    assert len(first) == 1, f"the first pass must reach the transport once: {len(first)}"

    second = _cycle(mod, paths)

    assert len(first) + len(second) == 1, (
        "one accepted notification produced more than one remote send: "
        f"{len(first)} then {len(second)}"
    )
    held = _processing_records(paths)
    assert len(held) == 1 and _delivery_status(held[0]) == HELD_STATUS, (
        f"the interrupted send must be held as {HELD_STATUS!r}: {held!r}"
    )
    assert len(_held_signals(paths)) == 1, (
        f"exactly one signal per held item: {len(_held_signals(paths))}"
    )


@pytest.mark.parametrize("error", AMBIGUOUS_ERRORS)
def test_a_lost_response_is_held_rather_than_requeued(tmp_path, error):
    """Acceptance 3: the request was issued and no outcome came back.

    Both messages are raised by wait_for_response after the tool call was
    written to the socket, so the remote may already have accepted. Treating
    them as failures requeues and re-sends.
    """
    mod = _load(tmp_path / f"lost-response-{abs(hash(error)) % 1000}")
    paths = mod.setup_dirs()
    event = _event("evt-2424-lost", QUEUED_STATUS)
    _open_incident(mod, paths, event)
    _seed_outbox(paths, event)

    first = _cycle(mod, paths, raises=error)
    assert len(first) == 1, f"the first pass must reach the transport once: {len(first)}"

    assert not list(paths["outbox"].glob("*.json")), (
        "an ambiguous outcome must not be requeued for a blind resend"
    )
    held = _processing_records(paths)
    assert len(held) == 1 and _delivery_status(held[0]) == HELD_STATUS, (
        f"a lost response must be held as {HELD_STATUS!r}: {held!r}"
    )

    second = _cycle(mod, paths)
    assert second == [], f"the restart must not resend a held item: {len(second)}"
    assert len(_held_signals(paths)) == 1, (
        f"exactly one signal across restarts: {len(_held_signals(paths))}"
    )


def test_a_second_reclaim_does_not_signal_the_held_item_again(tmp_path):
    """Acceptance 5: the signal is idempotent across restarts."""
    mod = _load(tmp_path / "signal-idempotent")
    paths = mod.setup_dirs()
    event = _event(
        "evt-2424-idem", IN_FLIGHT_STATUS, **{SEND_ISSUED_FIELD: STALE_ISSUED_AT}
    )
    _open_incident(mod, paths, event)
    _seed_processing(paths, event)

    _cycle(mod, paths)
    after_first = len(_held_signals(paths))
    _cycle(mod, paths)
    _cycle(mod, paths)

    assert after_first == 1, f"the first hold must signal once: {after_first}"
    assert len(_held_signals(paths)) == 1, (
        "every later reclaim re-signalled a held item that was already "
        f"reported: {len(_held_signals(paths))} signals"
    )


# --------------------------------------------------------------------------
# Controls: the paths this change must leave exactly as they were.
# --------------------------------------------------------------------------


def test_a_proven_rejection_keeps_the_bounded_retry_path(tmp_path):
    """Acceptance 3 control (A5): a response naming an error is not ambiguous.

    wait_for_response raises this only after reading a reply that carries an
    error, so the remote provably did not accept the message.
    """
    mod = _load(tmp_path / "proven-rejection")
    paths = mod.setup_dirs()
    event = _event("evt-2424-rejected", QUEUED_STATUS)
    _open_incident(mod, paths, event)
    _seed_outbox(paths, event)

    calls = _cycle(mod, paths, raises=PROVEN_REJECTION_ERROR)

    assert len(calls) == 1, f"the rejected send must still be attempted: {len(calls)}"
    requeued = list(paths["outbox"].glob("*.json"))
    assert len(requeued) == 1, (
        f"a proven rejection must stay on the bounded retry path: {requeued!r}"
    )
    record = json.loads(requeued[0].read_text())
    assert _delivery_status(record) == QUEUED_STATUS, (
        f"a proven rejection must requeue, not hold: {record.get('delivery')!r}"
    )
    assert _held_signals(paths) == [], (
        "a proven rejection must not emit an ambiguous-outcome signal"
    )


def test_a_crash_before_the_send_is_issued_still_delivers_once(tmp_path):
    """Acceptance 4 control (A1): "sending" alone is not ambiguous.

    The attempt was recorded durably and the process died before the request
    was issued. Nothing reached the remote, so the restart must deliver -- and
    holding here would convert a duplicate-alert bug into a lost-alert bug.
    """
    mod = _load(tmp_path / "crash-before-issue")
    paths = mod.setup_dirs()
    event = _event("evt-2424-preissue", IN_FLIGHT_STATUS)
    _open_incident(mod, paths, event)
    _seed_processing(paths, event)

    calls = _cycle(mod, paths)

    assert len(calls) == 1, (
        "a notification that never reached the transport was not delivered "
        f"after restart: {len(calls)} send(s)"
    )
    assert list(paths["sent"].glob("*.sent")), (
        "the delivered event must be archived to sent/"
    )
    assert _held_signals(paths) == [], (
        "a pre-issue crash is not an ambiguous outcome and must not signal"
    )


def test_the_issued_marker_does_not_survive_into_the_next_attempt(tmp_path):
    """Acceptance 4 control: the marker is per attempt, not per event.

    A requeued event still carries the previous attempt's marker. If the
    attempt publication kept it, a crash before the NEXT send was issued would
    read as ambiguous and hold an event that never reached the remote.
    """
    mod = _load(tmp_path / "marker-per-attempt")
    paths = mod.setup_dirs()
    event = _event(
        "evt-2424-stale", QUEUED_STATUS, **{SEND_ISSUED_FIELD: STALE_ISSUED_AT}
    )
    _open_incident(mod, paths, event)
    _seed_outbox(paths, event)

    published: list = []
    original = mod.publish_state_json

    def _capture(*args, **kwargs):
        if kwargs.get("component") == ATTEMPT_PUBLICATION_COMPONENT:
            published.append(json.loads(json.dumps(args[1])))
        return original(*args, **kwargs)

    calls: list = []
    with patch.object(mod, "publish_state_json", side_effect=_capture):
        with patch.object(
            mod, "send_whatsapp", side_effect=lambda *a, **k: calls.append(a)
        ):
            for queued in sorted(paths["outbox"].glob("*.json")):
                if mod.ready(queued, paths["quarantine"]):
                    mod.process_one(queued, paths)

    assert len(calls) == 1, f"the retry must still be delivered: {len(calls)}"
    assert len(published) == 1, (
        f"one attempt publication was expected: {len(published)}"
    )
    attempt_delivery = published[0].get("delivery") or {}
    assert not attempt_delivery.get(SEND_ISSUED_FIELD), (
        "the previous attempt's issued marker survived into this attempt's "
        f"durable record: {attempt_delivery!r}"
    )


def test_an_incident_commit_failure_after_the_sent_publication_never_resends(tmp_path):
    """Acceptance 2: the incident save fails after a durable "sent" record.

    This sub-case is already closed at the baseline: the sent publication runs
    before the incident save, so the record on disk reads "sent" and the
    terminal-replay guard archives it. The assertion is exactly-once, and the
    archive is the evidence of which mechanism resolved it.
    """
    mod = _load(tmp_path / "incident-save-fails")
    paths = mod.setup_dirs()
    event = _event("evt-2424-save", QUEUED_STATUS)
    _open_incident(mod, paths, event)
    queued = _seed_outbox(paths, event)

    first: list = []
    original_save = mod.save_incident_state

    def _save(*args, **kwargs):
        if first:
            raise RuntimeError("injected incident-save failure")
        return original_save(*args, **kwargs)

    with patch.object(mod, "save_incident_state", side_effect=_save):
        with patch.object(
            mod, "send_whatsapp", side_effect=lambda *a, **k: first.append(a)
        ):
            with pytest.raises(RuntimeError):
                mod.process_one(queued, paths)

    assert len(first) == 1, f"the first pass must reach the transport once: {len(first)}"

    second = _cycle(mod, paths)

    assert len(first) + len(second) == 1, (
        "an accepted send whose incident save failed was repeated: "
        f"{len(first)} then {len(second)}"
    )
    assert not list(paths["outbox"].glob("*.json")), (
        "the resolved record must not be left queued"
    )
    assert list(paths["sent"].glob("*.sent")), (
        "a durable sent record is resolved by the terminal-replay guard, "
        "which archives it to sent/"
    )
