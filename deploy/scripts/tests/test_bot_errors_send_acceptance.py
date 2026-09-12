"""Exercise the actual send RPC and existing durable lifecycle with a local peer."""
from __future__ import annotations
import importlib.util
import json
from pathlib import Path
from unittest.mock import patch
import pytest
import test_bot_errors_ambiguous_send_outcome as existing

TARGET = "111111111111111111@g.us"
OTHER = "222222222222222222@g.us"

def content(payload):
    return {"content": [{"type": "text", "text": json.dumps(payload)}]}

UNKNOWN = [
    {}, {"result": False}, {"content": []},
    {"content": [{"type": "text", "text": "not-json"}]},
    content({"sent": True, "resolved_chatJid": OTHER}),
    content({"sent": "true", "resolved_chatJid": TARGET}),
    content({"sent": True}),
    {"content": [{"type": "text", "text": '{"sent":true,"sent":false}'}]},
    {"isError": "false", **content({"sent": True, "resolved_chatJid": TARGET})},
    content({"sent": True, "resolved_chatJid": TARGET, "suppressed": True}),
    content({"sent": True, "resolved_chatJid": TARGET, "dryRun": True}),
    content({"sent": True, "resolved_chatJid": TARGET, "audit_receipt": 17}),
    {"content": [{"type": "text", "text": '{"sent":true,"resolved_chatJid":"' + TARGET + '","value":NaN}'}]},
    {"content": [{"type": "text", "text": '[' * 2000 + '0' + ']' * 2000}]},
]

class Peer(existing._FakePeer):
    def __init__(self, result):
        self.result = result
        super().__init__("s", "acceptance")

    def _handle(self, conn):
        reader = conn.makefile("rb")
        init = json.loads(reader.readline())
        conn.sendall((json.dumps({"jsonrpc": "2.0", "id": init["id"], "result": {}}) + "\n").encode())
        request = json.loads(reader.readline())
        self.requests.append(request)
        conn.sendall((json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": self.result}) + "\n").encode())

@pytest.fixture
def dispatcher(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    for key in ["BOT_ERRORS_DRY_SEND_CAPTURE", "BOT_ERRORS_DRY_SEND_FAIL"]:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("BOT_ERRORS_JID", TARGET)
    monkeypatch.setenv("BOT_ERRORS_EXPECTED_JID", TARGET)
    return existing._load(tmp_path / "state")

@pytest.mark.parametrize("reply", UNKNOWN)
def test_dispatcher_unproven_acceptance_is_post_request_unknown(dispatcher, reply):
    with Peer(reply):
        with pytest.raises(dispatcher.AmbiguousSendOutcome) as caught:
            dispatcher.send_whatsapp("synthetic body", "s", require_acceptance=True)
    assert caught.value.phase == dispatcher.JSON_RPC_POST_REQUEST_PHASE

def test_dispatcher_negative_result_is_known_nonacceptance(dispatcher):
    with Peer(content({"sent": False, "suppressed": True})):
        with pytest.raises(dispatcher.ProvenRemoteRejection):
            dispatcher.send_whatsapp("synthetic body", "s", require_acceptance=True)

@pytest.mark.parametrize("with_receipt", [False, True])
def test_dispatcher_target_bound_acceptance_returns_only_receipt_metadata(dispatcher, with_receipt):
    payload = {"sent": True, "resolved_chatJid": TARGET, "text": "must not escape into receipt"}
    if with_receipt:
        payload["audit_receipt"] = "fixture-opaque-receipt"
    with Peer(content(payload)):
        result = dispatcher.send_whatsapp("synthetic body", "s", require_acceptance=True)
    assert result == ({"audit_receipt": "fixture-opaque-receipt"} if with_receipt else {})

@pytest.mark.parametrize("reply", [
    content({"sent": True, "resolved_chatJid": OTHER}),
    {"content": [{"type": "text", "text": '[' * 10000 + '0' + ']' * 10000}]},
])
def test_unknown_reply_preserves_existing_hold_across_reclaim(dispatcher, reply):
    paths = dispatcher.setup_dirs()
    event = existing._event("sf5-unknown", existing.QUEUED_STATUS)
    existing._open_incident(dispatcher, paths, event)
    queued = existing._seed_outbox(paths, event)
    real_send = dispatcher.send_whatsapp
    with Peer(reply) as peer:
        with patch.object(dispatcher, "send_whatsapp", side_effect=lambda text, **kw: real_send(text, "s", **kw)):
            ok, _ = dispatcher.process_one(queued, paths)
            assert ok is False
            for _ in range(2):
                dispatcher.reclaim_processing(paths)
            assert len(peer.requests) == 1
    records = existing._processing_records(paths)
    assert len(records) == 1
    assert records[0]["delivery"]["status"] == existing.HELD_STATUS
    assert not list(paths["sent"].iterdir())


def test_valid_acceptance_receipt_is_retained_in_private_sent_record(dispatcher):
    paths = dispatcher.setup_dirs()
    event = existing._event("sf5-receipt", existing.QUEUED_STATUS)
    existing._open_incident(dispatcher, paths, event)
    queued = existing._seed_outbox(paths, event)
    real_send = dispatcher.send_whatsapp
    with Peer(content({"sent": True, "resolved_chatJid": TARGET, "audit_receipt": "fixture-receipt"})):
        with patch.object(dispatcher, "send_whatsapp", side_effect=lambda text, **kw: real_send(text, "s", **kw)):
            ok, _ = dispatcher.process_one(queued, paths)
    assert ok is True
    archived = list(paths["sent"].iterdir())
    assert len(archived) == 1
    record = json.loads(archived[0].read_text())
    assert record["delivery"]["auditReceipt"] == "fixture-receipt"
    assert "fixture-receipt" not in (paths["logs"] / "dispatch.jsonl").read_text()


def test_negative_acceptance_is_requeued_and_not_marked_sent(dispatcher):
    paths = dispatcher.setup_dirs()
    event = existing._event("sf5-rejected", existing.QUEUED_STATUS)
    existing._open_incident(dispatcher, paths, event)
    queued = existing._seed_outbox(paths, event)
    real_send = dispatcher.send_whatsapp
    with Peer(content({"sent": False, "suppressed": True})):
        with patch.object(dispatcher, "send_whatsapp", side_effect=lambda text, **kw: real_send(text, "s", **kw)):
            ok, _ = dispatcher.process_one(queued, paths)
    assert ok is False
    assert not list(paths["sent"].iterdir())
    records = [json.loads(p.read_text()) for p in paths["outbox"].glob("*.json")]
    assert len(records) == 1
    assert records[0]["delivery"]["status"] == existing.QUEUED_STATUS


@pytest.mark.parametrize("reply", UNKNOWN + [content({"sent": False, "suppressed": True})])
def test_legacy_direct_send_preserves_default_return(dispatcher, reply):
    with Peer(reply):
        assert dispatcher.send_whatsapp("synthetic body", "s") is None


def test_only_process_one_opts_in_and_legacy_callers_are_unchanged():
    import ast
    module = ast.parse(existing._SCRIPT.read_text())
    callers = {}
    for function in module.body:
        if isinstance(function, ast.FunctionDef):
            for node in ast.walk(function):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "send_whatsapp":
                    callers.setdefault(function.name, []).append(node)
    strict = [name for name, calls in callers.items() for call in calls if call.keywords]
    assert strict == ["process_one"]
    call = callers["process_one"][0]
    assert len(call.keywords) == 1
    assert call.keywords[0].arg == "require_acceptance"
    assert isinstance(call.keywords[0].value, ast.Constant)
    assert call.keywords[0].value.value is True
    assert {name: len(calls) for name, calls in callers.items() if name != "process_one"} == {
        "flap_scan_outbox": 1, "sweep_flap_storms": 1,
        "sweep_stale_incidents": 2, "quarantine_poison": 1,
    }
