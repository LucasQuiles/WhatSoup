"""Every BOT ERRORS send path stores the event its card's "Ref <8>" names.

process_one archives each queued event it delivers. The dispatcher also sends
events it builds itself (flap storms and their resolution, stale reminders,
the auto-close digest, credential and quarantine meta alerts); each of those
is archived to sent/ by archive_sent_synthesized_event after a successful
send, under its own id. This file enumerates the send paths from the source,
so a new path without an archive step fails here.
"""

from __future__ import annotations

import ast
import importlib.util
import json
import re
import sys
import time
from pathlib import Path

import pytest


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"
_CARD_REF = re.compile(r"(?m)^Ref ([0-9a-f]{8}) · ")
# Every function that calls send_whatsapp. process_one archives through its own
# lifecycle move; every other path is a synthesized event.
SEND_PATHS = {
    "process_one",
    "flap_scan_outbox",
    "sweep_flap_storms",
    "sweep_stale_incidents",
    "send_meta_alert",
    "credential_meta_alert",
}
SYNTHESIZED_PATHS = SEND_PATHS - {"process_one"}


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_send_refs", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


dispatcher = _load()


def _functions_calling(tree: ast.AST, name: str) -> set[str]:
    found = set()
    for function in ast.walk(tree):
        if isinstance(function, ast.FunctionDef):
            for node in ast.walk(function):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == name:
                    found.add(function.name)
    return found


@pytest.fixture
def state(tmp_path, monkeypatch):
    root = tmp_path / "state"
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(root / "outbox"))
    monkeypatch.setenv("BOT_ERRORS_DRY_SEND_CAPTURE", str(tmp_path / "sent.log"))
    monkeypatch.delenv("BOT_ERRORS_DRY_SEND_FAIL", raising=False)
    return tmp_path, dispatcher.setup_dirs()


def _stored_ids_for(paths, card: str) -> list[str]:
    match = _CARD_REF.search(card)
    assert match is not None, card
    stored = [json.loads(path.read_text(encoding="utf-8")) for path in paths["sent"].glob("*.sent")]
    return [str(event.get("id")) for event in stored if dispatcher.public_card_ref(event) == match.group(1)]


def test_every_send_path_archives_the_event_its_card_names(state, monkeypatch) -> None:
    tmp_path, paths = state
    tree = ast.parse(_SCRIPT.read_text(encoding="utf-8"))

    # 1. The send paths, enumerated from the source.
    assert _functions_calling(tree, "send_whatsapp") == SEND_PATHS
    # 2. Each synthesized path stages a pending record and archives through the shared steps.
    assert SYNTHESIZED_PATHS <= _functions_calling(tree, "stage_synthesized_event")
    assert SYNTHESIZED_PATHS <= _functions_calling(tree, "archive_sent_synthesized_event")

    # 3. Each synthesized event's card Ref resolves to exactly its archived record.
    now = int(time.time())
    key = "HOST-A|bot-a|tool-failure"
    trip = {"cumulativeCount": 7, "firstTripAt": now - 900, "lastTripAt": now, "stormAt": now - 600}
    stale_record = {"openedAt": now - 400_000, "lastSeenAt": now - 400_000, "lastSummary": "tool failed"}
    built = [
        dispatcher.flap_storm_event(key, dict(trip), "warning", now),
        dispatcher.flap_resolve_event(key, dict(trip), now, False),
        dispatcher.stale_incident_event(key, dict(stale_record), now),
        dispatcher.stale_autoclose_summary_event([key], now),
    ]
    for event in built:
        assert event is not None
        card = dispatcher.format_public_message(event)
        dispatcher.archive_sent_synthesized_event(event)
        assert _stored_ids_for(paths, card) == [event["id"]]

    sent_cards: list[str] = []
    monkeypatch.setattr(dispatcher, "send_whatsapp", lambda text, **_kwargs: sent_cards.append(text))
    source = next(iter(dispatcher._CREDENTIAL_META_FLAGS))
    assert dispatcher.credential_meta_alert(source, "credential state was lost", time.monotonic() + 30)
    dispatcher.send_meta_alert(
        {**dispatcher.new_event_fields("alert", "critical"), "id": "poison-send-refs-1", "createdAt": "2026-11-12T00:00:00Z",
         "machine": "host-a", "instance": "bot-errors-dispatcher", "source": "poison-event-quarantine",
         "summary": "quarantined an unreadable event", "evidence": "", "delivery": {"attempts": 0, "status": "meta"}},
        "quarantine",
    )
    assert len(sent_cards) == 2
    for card in sent_cards:
        assert len(set(_stored_ids_for(paths, card))) == 1


def test_synthesized_archive_failure_never_raises_or_unsends(state, monkeypatch) -> None:
    tmp_path, paths = state
    sent_cards: list[str] = []
    monkeypatch.setattr(dispatcher, "send_whatsapp", lambda text, **_kwargs: sent_cards.append(text))
    publish = dispatcher.publish_state_json

    # Only the archive write fails: a refused pending write sends nothing
    # (test_failed_pending_write_sends_nothing_and_counts_nothing).
    def refuse(target, payload, *, component, **kwargs):
        if component == "dispatcher.synthesized_sent_state":
            raise OSError("injected synthesized archive failure")
        return publish(target, payload, component=component, **kwargs)

    monkeypatch.setattr(dispatcher, "publish_state_json", refuse)
    source = next(iter(dispatcher._CREDENTIAL_META_FLAGS))

    day = dispatcher.credential_meta_alert(source, "credential state was lost", time.monotonic() + 30)

    assert day is not None
    assert len(sent_cards) == 1
    assert list(paths["sent"].glob("*.sent")) == []
    logged = [
        json.loads(line)
        for log in sorted((tmp_path / "state").rglob("*.jsonl"))
        for line in log.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert [record["type"] for record in logged if record.get("type") == "synthesized_archive_failed"] == [
        "synthesized_archive_failed"
    ]


# A crash between staging and archiving leaves a pending record. The next pass
# stores it with delivery status "unconfirmed" and never sends it again.

class _Crash(BaseException):
    """A process death: no `except Exception` handler on the send path sees it."""


def _crash(*_args, **_kwargs):
    raise _Crash()


def _logged(tmp_path) -> list[dict]:
    return [
        json.loads(line)
        for log in sorted((tmp_path / "state").rglob("*.jsonl"))
        for line in log.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def _pending(paths) -> list[Path]:
    directory = paths["root"] / "synthesized-pending"
    if not directory.exists():
        return []
    return sorted(path for path in directory.glob("*.json") if not path.name.startswith("."))


def _stored(paths) -> list[tuple[Path, dict]]:
    return [
        (path, json.loads(path.read_text(encoding="utf-8")))
        for path in sorted(paths["sent"].iterdir())
        if not path.name.startswith(".")
    ]


def _ids_for_card(paths, card: str) -> list[str]:
    match = _CARD_REF.search(card)
    assert match is not None, card
    return [str(record.get("id")) for _path, record in _stored(paths) if dispatcher.public_card_ref(record) == match.group(1)]


def _recover_without_sending(monkeypatch, paths) -> int:
    calls: list[str] = []
    monkeypatch.setattr(dispatcher, "send_whatsapp", lambda *_a, **_k: calls.append("whatsapp"))
    monkeypatch.setattr(dispatcher, "email_fallback", lambda *_a, **_k: calls.append("email") or True)
    stored = dispatcher.recover_synthesized_pending(paths)
    assert calls == []
    return stored


def _run_meta_path(name: str):
    if name == "credential_meta_alert":
        source = next(iter(dispatcher._CREDENTIAL_META_FLAGS))
        return dispatcher.credential_meta_alert(source, "credential state was lost", time.monotonic() + 30)
    return dispatcher.send_meta_alert(
        {**dispatcher.new_event_fields("alert", "critical"), "id": "poison-crash-1", "createdAt": "2026-11-12T00:00:00Z",
         "machine": "host-a", "instance": "bot-errors-dispatcher", "source": "poison-event-quarantine",
         "summary": "quarantined an unreadable event", "evidence": "", "delivery": {"attempts": 0, "status": "meta"}},
        "quarantine",
    )


def _assert_one_unconfirmed_record(monkeypatch, paths, card: str) -> None:
    assert len(_pending(paths)) == 1
    assert _recover_without_sending(monkeypatch, paths) == 1
    assert _pending(paths) == []
    [(path, record)] = _stored(paths)
    assert not path.name.endswith(".sent")
    assert record["delivery"]["status"] == "unconfirmed"
    assert "delivery: unconfirmed" in dispatcher.format_event(record)
    assert _ids_for_card(paths, card) == [record["id"]]
    # A later pass has nothing left to store and sends nothing.
    assert _recover_without_sending(monkeypatch, paths) == 0
    assert len(_stored(paths)) == 1


@pytest.mark.parametrize("path_name", ["credential_meta_alert", "send_meta_alert"])
def test_crash_between_send_and_archive_stores_one_unconfirmed_record(state, monkeypatch, path_name) -> None:
    _tmp_path, paths = state
    cards: list[str] = []
    monkeypatch.setattr(dispatcher, "send_whatsapp", lambda text, **_kwargs: cards.append(text))
    archive = dispatcher.archive_sent_synthesized_event
    monkeypatch.setattr(dispatcher, "archive_sent_synthesized_event", _crash)

    with pytest.raises(_Crash):
        _run_meta_path(path_name)

    monkeypatch.setattr(dispatcher, "archive_sent_synthesized_event", archive)
    assert len(cards) == 1
    assert _stored(paths) == []
    _assert_one_unconfirmed_record(monkeypatch, paths, cards[0])


@pytest.mark.parametrize("path_name", ["credential_meta_alert", "send_meta_alert"])
def test_crash_before_send_stores_one_unconfirmed_record(state, monkeypatch, path_name) -> None:
    _tmp_path, paths = state
    built: list[str] = []

    def crash_at_send(text, **_kwargs):
        built.append(text)
        raise _Crash()

    monkeypatch.setattr(dispatcher, "send_whatsapp", crash_at_send)

    with pytest.raises(_Crash):
        _run_meta_path(path_name)

    assert len(built) == 1
    assert _stored(paths) == []
    _assert_one_unconfirmed_record(monkeypatch, paths, built[0])


def test_crash_after_archive_keeps_the_sent_record_only(state, monkeypatch) -> None:
    _tmp_path, paths = state
    cards: list[str] = []
    monkeypatch.setattr(dispatcher, "send_whatsapp", lambda text, **_kwargs: cards.append(text))
    remove = dispatcher._remove_synthesized_pending
    monkeypatch.setattr(dispatcher, "_remove_synthesized_pending", _crash)

    with pytest.raises(_Crash):
        _run_meta_path("credential_meta_alert")

    monkeypatch.setattr(dispatcher, "_remove_synthesized_pending", remove)
    assert len(_pending(paths)) == 1
    assert _recover_without_sending(monkeypatch, paths) == 0
    assert _pending(paths) == []
    [(path, record)] = _stored(paths)
    assert path.name.endswith(".sent")
    assert record["delivery"]["status"] == "meta"
    assert _ids_for_card(paths, cards[0]) == [record["id"]]


# A card must never go out without a pending record behind its Ref. When the
# pending record cannot be written, nothing is sent on any channel, nothing is
# counted as sent, an error-level local record says why, and the alert stays
# owed: a later pass sends it once storage works again.

def _refuse_all_storage(*_args, **_kwargs):
    raise OSError("injected persistent storage failure")


def _refuse_pending_storage(monkeypatch) -> None:
    publish = dispatcher.publish_state_json

    def refuse_pending(target, payload, *, component, **kwargs):
        if component == "dispatcher.synthesized_pending_state":
            raise OSError("injected persistent pending write failure")
        return publish(target, payload, component=component, **kwargs)

    monkeypatch.setattr(dispatcher, "publish_state_json", refuse_pending)


def _pending_failures(tmp_path) -> list[dict]:
    return [entry for entry in _logged(tmp_path) if entry.get("type") == "synthesized_pending_failed"]


@pytest.mark.parametrize("path_name", ["credential_meta_alert", "send_meta_alert"])
def test_failed_pending_write_sends_nothing_and_counts_nothing(state, monkeypatch, path_name) -> None:
    tmp_path, paths = state
    channels: list[str] = []
    monkeypatch.setattr(dispatcher, "send_whatsapp", lambda *_a, **_k: channels.append("whatsapp"))
    monkeypatch.setattr(dispatcher, "email_fallback", lambda *_a, **_k: channels.append("email") or True)
    monkeypatch.setattr(dispatcher, "publish_state_json", _refuse_all_storage)

    result = _run_meta_path(path_name)

    assert channels == []
    if path_name == "credential_meta_alert":
        # None: no channel took it, so send_credential_meta_alerts owes it again next cycle.
        assert result is None
    else:
        assert result[:2] == ("not_attempted", "not_attempted")
    assert _pending(paths) == []
    assert _stored(paths) == []
    failures = _pending_failures(tmp_path)
    assert len(failures) == 1
    assert failures[0]["level"] == "error"


def test_failed_pending_write_keeps_a_stale_reminder_owed_until_storage_works(state, monkeypatch) -> None:
    tmp_path, paths = state
    now = int(time.time())
    # awaiting_physical: the sweep reminds rather than auto-closes it.
    key = "host-a|whatsoup-bot|whatsapp_auth_bond_local_failure"
    incident_path = paths["incident_state"]
    incident_path.parent.mkdir(parents=True, exist_ok=True)
    incident_path.write_text(json.dumps({"version": 1, "lastSentAt": {}, "openIncidents": {key: {
        "status": "awaiting_physical",
        "openedAt": now - 10 * 86400,
        "lastSeenAt": now - 8 * 86400,
        "lastSummary": "WhatsApp line needs a relink",
        "physicalCandidateCount": 1,
    }}}))
    incident_path.chmod(0o600)
    cards: list[str] = []
    monkeypatch.setattr(dispatcher, "send_whatsapp", lambda text, **_kwargs: cards.append(text))
    publish = dispatcher.publish_state_json
    _refuse_pending_storage(monkeypatch)

    sent, failed, _error = dispatcher.sweep_stale_incidents(paths)

    assert (sent, failed, cards) == (0, 1, [])
    assert _pending(paths) == [] and _stored(paths) == []
    assert len(_pending_failures(tmp_path)) == 1

    # The failed reminder is retried after the failure retry interval; skip the wait.
    monkeypatch.setattr(dispatcher, "publish_state_json", publish)
    monkeypatch.setattr(dispatcher, "INCIDENT_STALE_FAILURE_RETRY_SECONDS", 0)
    sent, failed, _error = dispatcher.sweep_stale_incidents(paths)

    assert (sent, failed, len(cards)) == (1, 0, 1)
    assert len(_ids_for_card(paths, cards[0])) == 1


def test_refused_send_leaves_no_pending_record(state, monkeypatch) -> None:
    _tmp_path, paths = state

    def refuse(_text, **_kwargs):
        raise RuntimeError("injected refusal")

    monkeypatch.setattr(dispatcher, "send_whatsapp", refuse)
    monkeypatch.setattr(dispatcher, "email_fallback", lambda *_a, **_k: False)

    assert _run_meta_path("credential_meta_alert") is None

    assert _pending(paths) == []
    assert _recover_without_sending(monkeypatch, paths) == 0
    assert _stored(paths) == []


def test_ambiguous_send_is_stored_unconfirmed(state, monkeypatch) -> None:
    _tmp_path, paths = state
    built: list[str] = []

    def ambiguous(text, **_kwargs):
        built.append(text)
        raise dispatcher.AmbiguousSendOutcome("no answer", phase=dispatcher.JSON_RPC_POST_REQUEST_PHASE)

    monkeypatch.setattr(dispatcher, "send_whatsapp", ambiguous)
    monkeypatch.setattr(dispatcher, "email_fallback", lambda *_a, **_k: False)

    assert _run_meta_path("credential_meta_alert") is not None

    _assert_one_unconfirmed_record(monkeypatch, paths, built[0])


def test_run_once_recovers_pending_records_before_any_send() -> None:
    tree = ast.parse(_SCRIPT.read_text(encoding="utf-8"))
    run_once = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "run_once")
    lines = {
        node.func.id: node.lineno
        for node in ast.walk(run_once)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert lines["recover_synthesized_pending"] < lines["suppress_test_provenance_events"]
    assert lines["recover_synthesized_pending"] < lines["flap_scan_outbox"]
    assert lines["recover_synthesized_pending"] < lines["process_one"]
