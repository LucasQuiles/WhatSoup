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
import shutil
import socket
import subprocess
import tempfile
import threading
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
HELD_PUBLICATION_COMPONENT = "dispatcher.process_held_state"
SEND_ISSUED_COMPONENT = "dispatcher.process_send_issued_state"

# collapse_ready_storms clusters on DISTINCT HOSTS and fires at
# storm_threshold(), which defaults to 3. The siblings must reach that count on
# their own: if the held record were needed to make up the number, excluding it
# would stop the sweep firing and the test would pass for the wrong reason.
STORM_SIBLINGS = 3

# Every seeded event starts with one prior attempt, so an assertion about the
# retry budget has to name the increment rather than a floor the seed satisfies.
SEEDED_ATTEMPTS = 1
PARENT_SYNC_STAGE = "parent_sync"
# One line per hold ATTEMPT: the first attempt whose publication never landed,
# plus the retry that succeeded. See hold_ambiguous_send for the ORDER note.
RETRIED_HOLD_SIGNALS = 2

INJECTED_PUBLICATION_FAILURE = "injected sent-publication failure"

# json_rpc_call raises RuntimeError for every transport failure and the caller
# sees only the message, so the message is the classifier's input. What makes a
# failure ambiguous is WHEN it happened: only after the tools/call request was
# flushed can the remote already have accepted the message. json_rpc_call stamps
# the protocol phase into the text of the no-reply failures, and these tests
# drive the real transport against a fake peer so the phase labels under test
# are the ones the code actually raises.
HANDSHAKE_PHASE = "phase=handshake"
POST_REQUEST_PHASE = "phase=post_request"

# Fake-peer behaviours, named so the parametrize lists carry no bare literals.
CLOSE_IN_HANDSHAKE = "close_in_handshake"
HANG_IN_HANDSHAKE = "hang_in_handshake"
NOT_JSON_IN_HANDSHAKE = "not_json_in_handshake"
CLOSE_AFTER_REQUEST = "close_after_request"
HANG_AFTER_REQUEST = "hang_after_request"
ERROR_AFTER_REQUEST = "error_after_request"
REJECTION_NAMING_THE_PHASE = "rejection_naming_the_phase"
# The remote had the request and answered with something unreadable. Reading,
# decoding and parsing that answer are all post-flush, so all of them are
# ambiguous -- the defect this iteration closes.
PARTIAL_LINE = "partial_line_after_request"
NOT_JSON = "not_json_after_request"
NOT_OBJECT = "not_object_after_request"
BAD_UTF8 = "bad_utf8_after_request"
HANDSHAKE_FAILURES = (HANG_IN_HANDSHAKE, CLOSE_IN_HANDSHAKE, NOT_JSON_IN_HANDSHAKE)
POST_REQUEST_FAILURES = (HANG_AFTER_REQUEST, CLOSE_AFTER_REQUEST)
POST_REQUEST_PARSE_FAILURES = (PARTIAL_LINE, NOT_JSON, NOT_OBJECT, BAD_UTF8)

# Connect-phase failures, which never reach the protocol at all.
MISSING_SOCKET = "missing_socket"
STALE_SOCKET_FILE = "stale_socket_file"
CONNECT_FAILURES = (MISSING_SOCKET, STALE_SOCKET_FILE)

TRANSPORT_TIMEOUT = 0.2
SERVER_HANG_SECONDS = 2.0

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
        "attempts": SEEDED_ATTEMPTS,
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


def _malformed_reply(fail_at: str) -> bytes:
    """The bytes a peer sends back after reading the tools/call request.

    Every one of these is a reply the remote produced AFTER it had the request,
    so the message may already have been delivered no matter how unreadable the
    answer is.
    """
    if fail_at == PARTIAL_LINE:
        # A reply cut off mid-write: valid framing, truncated JSON.
        return b'{"jsonrpc":"2.0","id":\n'
    if fail_at == NOT_JSON:
        return b"this is not json\n"
    if fail_at == NOT_OBJECT:
        return b"[1, 2, 3]\n"
    if fail_at == BAD_UTF8:
        return b"\xff\xfe\n"
    return b""


class _FakePeer:
    """A minimal AF_UNIX JSON-RPC peer that fails in a chosen way.

    The point is to let the REAL json_rpc_call meet the failure. A test that
    hard-codes the message it expects proves only that the constant matches
    itself, and would keep passing after the transport stopped raising it.

    `requests` records every tools/call line the peer ACTUALLY received, which
    is the only honest count of how many times the remote was asked to send.
    The peer serves connections in a loop so one instance spans several cycles.
    """

    def __init__(self, path: str, fail_at: str):
        self.path = path
        self.fail_at = fail_at
        self.requests: list[str] = []
        self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._sock.bind(path)
        self._sock.listen(8)
        self._thread = threading.Thread(target=self._serve, daemon=True)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *_exc):
        try:
            self._sock.close()
        except OSError:
            pass
        return False

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self._sock.accept()
            except OSError:
                return
            try:
                self._handle(conn)
            except OSError:
                pass
            finally:
                conn.close()

    def _handle(self, conn) -> None:
        reader = conn.makefile("rb")
        handshake = reader.readline()
        if not handshake:
            return
        if self.fail_at == CLOSE_IN_HANDSHAKE:
            return
        if self.fail_at == HANG_IN_HANDSHAKE:
            time.sleep(SERVER_HANG_SECONDS)
            return
        if self.fail_at == NOT_JSON_IN_HANDSHAKE:
            conn.sendall(b"this is not json\n")
            return
        conn.sendall(
            json.dumps(
                {"jsonrpc": "2.0", "id": json.loads(handshake)["id"], "result": {}}
            ).encode("utf-8")
            + b"\n"
        )
        request = reader.readline()
        if not request:
            return
        self.requests.append(request.decode("utf-8", "replace"))
        if self.fail_at == HANG_AFTER_REQUEST:
            time.sleep(SERVER_HANG_SECONDS)
            return
        if self.fail_at in (ERROR_AFTER_REQUEST, REJECTION_NAMING_THE_PHASE):
            message = "unknown chat"
            if self.fail_at == REJECTION_NAMING_THE_PHASE:
                # A hostile or unlucky remote payload that contains the literal
                # phase label. A substring match would hold a proven rejection.
                message = f"unknown chat ({POST_REQUEST_PHASE})"
            conn.sendall(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": json.loads(request)["id"],
                        "error": {"code": -32602, "message": message},
                    }
                ).encode("utf-8")
                + b"\n"
            )
            return
        conn.sendall(_malformed_reply(self.fail_at))


def _transport_error(mod, fail_at: str) -> str:
    """Return the message the REAL transport raises for one failure mode."""
    directory = tempfile.mkdtemp()
    path = os.path.join(directory, "s")
    try:
        if fail_at == MISSING_SOCKET:
            with pytest.raises(Exception) as caught:
                mod.json_rpc_call(path, "tools/call", {}, timeout=TRANSPORT_TIMEOUT)
            return str(caught.value)
        if fail_at == STALE_SOCKET_FILE:
            Path(path).write_text("not a socket")
            with pytest.raises(Exception) as caught:
                mod.json_rpc_call(path, "tools/call", {}, timeout=TRANSPORT_TIMEOUT)
            return str(caught.value)
        with _FakePeer(path, fail_at):
            with pytest.raises(Exception) as caught:
                mod.json_rpc_call(
                    path,
                    "tools/call",
                    {"name": "send_message", "arguments": {}},
                    timeout=TRANSPORT_TIMEOUT,
                )
        return str(caught.value)
    finally:
        shutil.rmtree(directory, ignore_errors=True)


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


@pytest.mark.parametrize("fail_at", POST_REQUEST_FAILURES)
def test_a_lost_response_is_held_rather_than_requeued(tmp_path, fail_at):
    """Acceptance 3: the request was flushed and no outcome came back.

    The peer accepted the handshake, then died or went silent after reading the
    tools/call request, so the remote may already have accepted the message.
    Treating that as a failure requeues and re-sends.
    """
    mod = _load(tmp_path / f"lost-response-{fail_at}")
    error = _transport_error(mod, fail_at)
    assert POST_REQUEST_PHASE in error, (
        f"a failure after the request was flushed must be labelled "
        f"{POST_REQUEST_PHASE!r}: {error!r}"
    )
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


def _assert_requeued_not_held(mod, paths, error: str, expect_sends: int) -> None:
    calls = _cycle(mod, paths, raises=error)
    assert len(calls) == expect_sends, (
        f"expected {expect_sends} transport attempt(s), got {len(calls)}: {error!r}"
    )
    requeued = list(paths["outbox"].glob("*.json"))
    assert len(requeued) == 1, (
        f"a pre-send or proven failure must stay on the bounded retry path, "
        f"got outbox={requeued!r} processing={_processing_records(paths)!r} "
        f"for {error!r}"
    )
    record = json.loads(requeued[0].read_text())
    assert _delivery_status(record) == QUEUED_STATUS, (
        f"must requeue, not hold: {record.get('delivery')!r} for {error!r}"
    )
    # The seed already carries attempts=1, so ">= 1" would hold even if the
    # attempt were never counted. mark_attempt increments before the send, so
    # the requeued record must read exactly one MORE than the seed.
    assert int((record.get("delivery") or {}).get("attempts") or 0) == SEEDED_ATTEMPTS + 1, (
        f"the attempt must be counted against the retry budget, expected "
        f"{SEEDED_ATTEMPTS + 1}: {record.get('delivery')!r}"
    )
    assert _held_signals(paths) == [], (
        f"a non-ambiguous failure must not emit a hold signal: {error!r}"
    )


def test_a_proven_rejection_keeps_the_bounded_retry_path(tmp_path):
    """Acceptance 3 control (A5): a reply naming an error is not ambiguous.

    The peer answered the tools/call with a JSON-RPC error, so the remote
    provably did not accept the message -- even though the failure happened
    after the request was flushed. The phase label must not be stamped on
    reply-derived failures, or every rejection would be held.
    """
    mod = _load(tmp_path / "proven-rejection")
    error = _transport_error(mod, ERROR_AFTER_REQUEST)
    assert POST_REQUEST_PHASE not in error, (
        f"a reply that names an error proves the outcome and must NOT carry the "
        f"ambiguous phase label: {error!r}"
    )
    paths = mod.setup_dirs()
    event = _event("evt-2424-rejected", QUEUED_STATUS)
    _open_incident(mod, paths, event)
    _seed_outbox(paths, event)

    _assert_requeued_not_held(mod, paths, error, expect_sends=1)


@pytest.mark.parametrize("fail_at", HANDSHAKE_FAILURES)
def test_a_handshake_failure_is_requeued_not_held(tmp_path, fail_at):
    """H2: a failure before the tools/call request was flushed is PRE-SEND.

    json_rpc_call runs the initialize handshake first. Nothing has been asked of
    the remote yet, so nothing can have been accepted. Holding here would turn a
    transient MCP outage into an operator queue of held alerts instead of the
    bounded retry that has always applied.
    """
    mod = _load(tmp_path / f"handshake-{fail_at}")
    error = _transport_error(mod, fail_at)
    assert HANDSHAKE_PHASE in error, (
        f"a handshake-phase failure must be labelled {HANDSHAKE_PHASE!r}: {error!r}"
    )
    assert POST_REQUEST_PHASE not in error, (
        f"a handshake-phase failure must not be labelled ambiguous: {error!r}"
    )
    paths = mod.setup_dirs()
    event = _event(f"evt-2424-{fail_at}", QUEUED_STATUS)
    _open_incident(mod, paths, event)
    _seed_outbox(paths, event)

    _assert_requeued_not_held(mod, paths, error, expect_sends=1)


@pytest.mark.parametrize("fail_at", CONNECT_FAILURES)
def test_a_connect_failure_is_requeued_not_held(tmp_path, fail_at):
    """H2 control: the protocol was never entered, so nothing is ambiguous.

    Already true before the phase distinction existed; proved here so that a
    later widening of the ambiguous class cannot silently swallow it.
    """
    mod = _load(tmp_path / f"connect-{fail_at}")
    error = _transport_error(mod, fail_at)
    assert POST_REQUEST_PHASE not in error, (
        f"a connect failure must not be labelled ambiguous: {error!r}"
    )
    paths = mod.setup_dirs()
    event = _event(f"evt-2424-{fail_at}", QUEUED_STATUS)
    _open_incident(mod, paths, event)
    _seed_outbox(paths, event)

    _assert_requeued_not_held(mod, paths, error, expect_sends=1)


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


# --------------------------------------------------------------------------
# F1: reading, decoding and parsing the reply are all post-flush.
# --------------------------------------------------------------------------


def _peer_backed_sender(mod, path: str, sent: list):
    """A sender that drives the REAL transport against the fake peer."""

    def _send(text, *_a, **_k):
        sent.append(text)
        mod.json_rpc_call(
            path,
            "tools/call",
            {"name": "send_message", "arguments": {"text": text}},
            timeout=TRANSPORT_TIMEOUT,
        )

    return _send


def _cycles_against_peer(mod, paths, path: str, rounds: int) -> list:
    """reclaim -> ready -> process_one, `rounds` times, real transport."""
    sent: list = []
    for _ in range(rounds):
        mod.reclaim_processing(paths)
        with patch.object(
            mod, "send_whatsapp", side_effect=_peer_backed_sender(mod, path, sent)
        ):
            for queued in sorted(paths["outbox"].glob("*.json")):
                if mod.ready(queued, paths["quarantine"]):
                    mod.process_one(queued, paths)
    return sent


@pytest.mark.parametrize("fail_at", POST_REQUEST_PARSE_FAILURES)
def test_an_unreadable_reply_after_the_request_is_held_not_resent(tmp_path, fail_at):
    """F1: the remote had the request, so an unreadable answer proves nothing.

    Only readline was inside the phase handler, so a truncated, non-JSON,
    non-object or badly encoded reply raised unlabelled and the event was
    re-sent. The peer counts what it actually received: it must be one.
    """
    mod = _load(tmp_path / f"unreadable-{fail_at}")
    paths = mod.setup_dirs()
    event = _event(f"evt-2424-{fail_at}", QUEUED_STATUS)
    _open_incident(mod, paths, event)
    _seed_outbox(paths, event)

    directory = tempfile.mkdtemp()
    path = os.path.join(directory, "s")
    try:
        with _FakePeer(path, fail_at) as peer:
            _cycles_against_peer(mod, paths, path, rounds=3)
            received = len(peer.requests)
    finally:
        shutil.rmtree(directory, ignore_errors=True)

    assert received == 1, (
        "the remote was asked to send the same notification more than once "
        f"after an unreadable reply: {received} tools/call request(s)"
    )
    held = _processing_records(paths)
    assert len(held) == 1 and _delivery_status(held[0]) == HELD_STATUS, (
        f"an unreadable reply must be held as {HELD_STATUS!r}: {held!r}"
    )
    assert not list(paths["outbox"].glob("*.json")), (
        "an ambiguous outcome must not be requeued for a blind resend"
    )
    assert len(_held_signals(paths)) == 1, (
        f"exactly one signal for the held item: {len(_held_signals(paths))}"
    )


def test_a_rejection_naming_the_phase_label_is_still_a_rejection(tmp_path):
    """F1/N2: the label is a suffix the transport writes, not a magic substring.

    A remote error payload that happens to contain the literal must not be able
    to force a hold, so the match is anchored to the end of the message.
    """
    mod = _load(tmp_path / "rejection-naming-phase")
    error = _transport_error(mod, REJECTION_NAMING_THE_PHASE)
    assert POST_REQUEST_PHASE in error, (
        f"this probe is only meaningful if the payload carries the literal: {error!r}"
    )
    assert not mod.is_ambiguous_send_outcome(error), (
        f"a proven rejection carrying the literal was classified ambiguous: {error!r}"
    )
    paths = mod.setup_dirs()
    event = _event("evt-2424-phase-payload", QUEUED_STATUS)
    _open_incident(mod, paths, event)
    _seed_outbox(paths, event)

    _assert_requeued_not_held(mod, paths, error, expect_sends=1)


# --------------------------------------------------------------------------
# F2/F3/F4: containment, the reclaim exemption, and a refused marker write.
# --------------------------------------------------------------------------


def test_a_failing_hold_publication_does_not_abort_the_reclaim_pass(tmp_path):
    """F2: one poisoned record must not strand every other claimed file.

    run_once calls reclaim_processing bare, so a raise here aborts the whole
    cycle -- and the next one, and every one after, because the record that
    raises is still there. A healthy stranded alert was never delivered.
    """
    mod = _load(tmp_path / "hold-publication-fails")
    paths = mod.setup_dirs()
    ambiguous = _event(
        "evt-2424-poison", IN_FLIGHT_STATUS, **{SEND_ISSUED_FIELD: STALE_ISSUED_AT}
    )
    healthy = _event("evt-2424-healthy", QUEUED_STATUS)
    _open_incident(mod, paths, healthy)
    _seed_processing(paths, ambiguous)
    _seed_processing(paths, healthy)

    with _failing_publication(mod, HELD_PUBLICATION_COMPONENT):
        reclaimed = mod.reclaim_processing(paths)
    assert reclaimed >= 1, (
        f"the healthy claim must still be reclaimed: {reclaimed}"
    )

    calls: list = []
    with patch.object(mod, "send_whatsapp", side_effect=lambda *a, **k: calls.append(a)):
        for queued in sorted(paths["outbox"].glob("*.json")):
            if mod.ready(queued, paths["quarantine"]):
                mod.process_one(queued, paths)
    assert len(calls) == 1, (
        f"a healthy stranded alert was not delivered: {len(calls)} send(s)"
    )

    stranded = _processing_records(paths)
    assert len(stranded) == 1 and _delivery_status(stranded[0]) == IN_FLIGHT_STATUS, (
        f"the record whose hold failed must stay claimed for the next pass: {stranded!r}"
    )

    # Injection removed: the next pass completes the hold, still once.
    mod.reclaim_processing(paths)
    held = _processing_records(paths)
    assert len(held) == 1 and _delivery_status(held[0]) == HELD_STATUS, (
        f"the retried hold must succeed: {held!r}"
    )
    # The disclosed cost of appending the log line BEFORE the publication: a
    # publication that never reached disk is retried, and the line is written
    # again. One duplicate LOG LINE per retried hold, never a duplicate send --
    # the send decision reads the durable record, which is stamped once.
    assert len(_held_signals(paths)) == RETRIED_HOLD_SIGNALS, (
        f"one duplicate line per retried hold was expected, got "
        f"{len(_held_signals(paths))}"
    )
    stamped = (held[0].get("delivery") or {}).get("outcomeUnknownSignalledAt")
    assert stamped, f"the durable record must carry one signal stamp: {held[0]!r}"


def test_reclaim_leaves_a_held_record_where_it_is(tmp_path):
    """F3: the reclaim-level exemption, pinned on its own.

    Deleting the exemption survived every other test because process_one's own
    held branch caught the bounced record. It does not catch the pre-loop
    sweeps, which run first and consult no delivery status.
    """
    mod = _load(tmp_path / "reclaim-exemption")
    paths = mod.setup_dirs()
    held = _event("evt-2424-parked", HELD_STATUS, **{SEND_ISSUED_FIELD: STALE_ISSUED_AT})
    _seed_processing(paths, held)

    reclaimed = mod.reclaim_processing(paths)

    assert not list(paths["outbox"].glob("*")), (
        "a held record was bounced into the outbox, where the pre-loop sweeps "
        f"can consume it: {list(paths['outbox'].glob('*'))}"
    )
    assert reclaimed == 0, f"a held record must not be counted as reclaimed: {reclaimed}"
    parked = _processing_records(paths)
    assert len(parked) == 1 and _delivery_status(parked[0]) == HELD_STATUS, (
        f"the held record must stay parked in processing/: {parked!r}"
    )


def test_the_storm_sweep_does_not_consume_a_held_record(tmp_path):
    """F3: the sweep most likely to consume a held record, proved directly.

    collapse_ready_storms is the one that ARCHIVES what it consumes (into
    storm-collapsed/), so a held record reaching it is lost outright rather than
    merely re-queued. The record is placed in outbox/ by force: reclaim will not
    put it there, and this asserts the second line of defence.
    """
    mod = _load(tmp_path / "storm-sweep-held")
    paths = mod.setup_dirs()
    # The sweep clusters on DISTINCT HOSTS, not on event count, so each record
    # needs its own machine or the sweep never fires and this test proves
    # nothing. The sibling assertion below is the control that it did fire.
    # The id must not be a PREFIX of the sibling ids: the archive check below
    # matches on file name, and a prefix would match a sibling instead.
    held = _event("evt-2424-parked-item", HELD_STATUS, **{SEND_ISSUED_FIELD: STALE_ISSUED_AT})
    held["machine"] = "host-held"
    _seed_outbox(paths, held)
    siblings = []
    for index in range(STORM_SIBLINGS):
        sibling = _event(f"evt-2424-storm-sib{index}", QUEUED_STATUS)
        sibling["machine"] = f"host-{index}"
        siblings.append(sibling)
        _seed_outbox(paths, sibling)

    mod.collapse_ready_storms(paths)

    collapsed = [p.name for p in paths["storm_collapsed"].glob("*")]
    assert all(
        any(sibling["id"] in name for name in collapsed) for sibling in siblings
    ), (
        "positive control: the sweep must actually have collapsed the ordinary "
        f"siblings, or this test asserts nothing: {collapsed}"
    )
    assert not any(held["id"] in name for name in collapsed), (
        "a held record was archived by the storm sweep, which loses it "
        f"outright: {collapsed}"
    )


def test_a_refused_send_issued_publication_requeues_without_the_marker(tmp_path):
    """F4: a refused advance means the send never happened.

    The marker may already be on disk, so leaving it makes the next reclaim
    hold an alert that was never sent. The record must go back to the queue in
    a state that cannot be mistaken for in-flight.
    """
    mod = _load(tmp_path / "issued-refused")
    paths = mod.setup_dirs()
    event = _event("evt-2424-refused", QUEUED_STATUS)
    _open_incident(mod, paths, event)
    queued = _seed_outbox(paths, event)

    calls: list = []
    original = mod.require_all_advance

    def _require(results):
        for result in results:
            if getattr(result, "component", "") == SEND_ISSUED_COMPONENT:
                raise RuntimeError("injected non-advancing issued publication")
        return original(results)

    with patch.object(mod, "require_all_advance", side_effect=_require):
        with patch.object(
            mod, "send_whatsapp", side_effect=lambda *a, **k: calls.append(a)
        ):
            mod.process_one(queued, paths)

    assert calls == [], f"a refused marker write must not send: {len(calls)}"
    assert _held_signals(paths) == [], "a send that never left must not be held"
    assert not _processing_records(paths), (
        f"the record must not stay claimed: {_processing_records(paths)!r}"
    )
    requeued = list(paths["outbox"].glob("*.json"))
    assert len(requeued) == 1, f"the record must be requeued: {requeued!r}"
    delivery = json.loads(requeued[0].read_text()).get("delivery") or {}
    assert not delivery.get(SEND_ISSUED_FIELD), (
        f"the issued marker must not survive a refused publication: {delivery!r}"
    )
    assert not mod.is_ambiguous_in_flight(json.loads(requeued[0].read_text())), (
        f"the requeued record must not read as in-flight: {delivery!r}"
    )


def test_the_hold_signal_carries_no_event_identifier(tmp_path):
    """The signal is per-item anonymous by design.

    metadata_only_controller_details projects unlisted strings away, so an
    eventId passed here never reaches the log. Rather than leave a field that
    silently disappears, none is passed: the operator lists processing/ to see
    which item is held. This pins that decision (A9 stays clean by construction).
    """
    mod = _load(tmp_path / "signal-anonymous")
    paths = mod.setup_dirs()
    event = _event(
        "evt-2424-anon", IN_FLIGHT_STATUS, **{SEND_ISSUED_FIELD: STALE_ISSUED_AT}
    )
    _open_incident(mod, paths, event)
    _seed_processing(paths, event)

    _cycle(mod, paths)

    signals = _held_signals(paths)
    assert len(signals) == 1, f"exactly one signal: {len(signals)}"
    rendered = json.dumps(signals[0])
    assert event["id"] not in rendered, (
        f"the signal must not carry an event identifier: {rendered}"
    )
    details = signals[0].get("details") or {}
    assert details.get("held") is True and "attempts" in details, (
        f"the signal must still carry its bounded metadata: {details!r}"
    )


# --------------------------------------------------------------------------
# Publications that REACH DISK and are still refused, and the runbook command.
# --------------------------------------------------------------------------


def _non_advancing_publication(mod, component: str):
    """A publication that lands on disk but cannot prove durability.

    The fault fires at PARENT_SYNC, after the rename, so the bytes ARE visible
    and only the advance check refuses. Raising at require_all_advance instead
    would leave nothing on disk and would not exercise this state at all.
    """
    original = mod.publish_state_json

    def _publish(*args, **kwargs):
        if kwargs.get("component") == component:
            def _fault(stage):
                if getattr(stage, "value", "") == PARENT_SYNC_STAGE:
                    raise OSError("injected parent-sync fault")

            kwargs["_fault_hook"] = _fault
        return original(*args, **kwargs)

    return patch.object(mod, "publish_state_json", side_effect=_publish)


def test_a_refused_hold_publication_still_signals_exactly_once(tmp_path):
    """The record is the authority, and the log line must not be lost with it.

    A hold publication can reach disk and still be refused. The record then
    already reads held-and-signalled, so every later reclaim skips it -- and a
    log line appended after the publication would never be written at all. The
    line is therefore appended first.
    """
    mod = _load(tmp_path / "hold-refused")
    paths = mod.setup_dirs()
    event = _event(
        "evt-2424-refused-hold", IN_FLIGHT_STATUS, **{SEND_ISSUED_FIELD: STALE_ISSUED_AT}
    )
    _seed_processing(paths, event)

    with _non_advancing_publication(mod, HELD_PUBLICATION_COMPONENT):
        try:
            mod.reclaim_processing(paths)
        except Exception as exc:  # contained per record, but never wedge the test
            pytest.fail(f"reclaim must contain a refused hold: {exc!r}")

    parked = _processing_records(paths)
    assert len(parked) == 1 and _delivery_status(parked[0]) == HELD_STATUS, (
        f"the refused publication still reached disk, so the record reads held: {parked!r}"
    )
    assert len(_held_signals(paths)) == 1, (
        "a hold whose publication was refused lost its signal: "
        f"{len(_held_signals(paths))}"
    )

    mod.reclaim_processing(paths)
    mod.reclaim_processing(paths)
    assert len(_held_signals(paths)) == 1, (
        f"two further passes must not signal again: {len(_held_signals(paths))}"
    )


def test_a_refused_send_issued_publication_that_reached_disk_requeues(tmp_path):
    """The issued marker landed, but the advance was refused: no send, no hold.

    The record on disk carries the marker, so without the requeue path the next
    reclaim would hold an alert that never left the process.
    """
    mod = _load(tmp_path / "issued-refused-ondisk")
    paths = mod.setup_dirs()
    event = _event("evt-2424-issued-refused", QUEUED_STATUS)
    _open_incident(mod, paths, event)
    queued = _seed_outbox(paths, event)

    calls: list = []
    with _non_advancing_publication(mod, SEND_ISSUED_COMPONENT):
        with patch.object(
            mod, "send_whatsapp", side_effect=lambda *a, **k: calls.append(a)
        ):
            mod.process_one(queued, paths)

    assert calls == [], f"a refused marker write must not send: {len(calls)}"
    assert _held_signals(paths) == [], "a send that never left must not be held"
    requeued = list(paths["outbox"].glob("*.json"))
    assert len(requeued) == 1, f"the record must be requeued: {requeued!r}"
    record = json.loads(requeued[0].read_text())
    assert not (record.get("delivery") or {}).get(SEND_ISSUED_FIELD), (
        f"the issued marker must not survive: {record.get('delivery')!r}"
    )
    assert not mod.is_ambiguous_in_flight(record), (
        f"the requeued record must not read as in-flight: {record.get('delivery')!r}"
    )


def _documented_inspect_command() -> str:
    """The command the README tells an operator to run, read from the README.

    Read rather than copied: a command duplicated into the test can drift from
    the runbook, and the runbook is what an operator actually types.
    """
    readme = (Path(__file__).resolve().parents[1] / "README-bot-errors.md").read_text()
    marker = "**Inspect.**"
    assert marker in readme, "the README must document how to inspect a held item"
    fence = readme.index("```bash", readme.index(marker))
    start = readme.index("\n", fence) + 1
    return readme[start : readme.index("```", start)].strip()


def test_the_documented_inspection_command_lists_a_real_held_record(tmp_path):
    """Contract clause 4: the runbook command must match what is written.

    publish_state_json renders compact JSON, so a pattern assuming a space after
    the colon matches nothing. The record here is written through the real
    publication path, and the command is run verbatim.
    """
    mod = _load(tmp_path / "runbook-grep")
    paths = mod.setup_dirs()
    event = _event(
        "evt-2424-runbook", IN_FLIGHT_STATUS, **{SEND_ISSUED_FIELD: STALE_ISSUED_AT}
    )
    _seed_processing(paths, event)
    mod.reclaim_processing(paths)

    held = _processing_records(paths)
    assert len(held) == 1 and _delivery_status(held[0]) == HELD_STATUS, (
        f"the record must be held through the real publication path: {held!r}"
    )

    command = _documented_inspect_command()
    result = subprocess.run(
        ["bash", "-c", command],
        capture_output=True,
        text=True,
        env={**os.environ, "BOT_ERRORS_STATE_DIR": str(paths["root"])},
    )
    assert result.returncode == 0 and result.stdout.strip(), (
        f"the documented command matched no held record. command={command!r} "
        f"rc={result.returncode} stdout={result.stdout!r} stderr={result.stderr!r}"
    )
    assert event["id"] in result.stdout, (
        f"the documented command must list the held file: {result.stdout!r}"
    )
