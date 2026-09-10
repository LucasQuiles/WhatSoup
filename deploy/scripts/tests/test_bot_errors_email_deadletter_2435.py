"""Tests for #2435: an accepted email fallback is terminal, not requeued.

fails-before:  email_fallback returns True -> email_status="accepted_unconfirmed"
               -> event requeued to outbox -> every later cycle submits the
               fallback again, then dead-letters the event as undelivered.
passes-after:  accepted fallback -> delivery terminal (email_delivered),
               incident state persisted, event archived to sent/, dispatch log
               records type=email_delivered. Nothing left in outbox/processing.

No regression: a failing email fallback still follows the normal retry path.

All tests exercise the REAL dispatcher module (importlib load + process_one).
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any
from unittest.mock import patch


_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

TEST_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS",
    "BOT_ERRORS_OUTBOX_DIR",
]


_clean_test_env = dispatcher_fixtures.make_env_scrub_fixture(TEST_ENV_KEYS)


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load_module(extra_env: dict[str, str] | None = None):
    for k, v in (extra_env or {}).items():
        os.environ[k] = v
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_2435", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _event(event_id: str) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": "alert",
        "severity": "critical",
        "source": "socket_down",
        "instance": "ana-bot",
        "machine": "test-host",
        "summary": "email deadletter test",
        "evidence": "testing #2435 terminal acceptance",
        "createdAt": "2026-06-12T00:00:00Z",
        "delivery": {
            "attempts": 3,
            "status": "queued",
            "nextAttemptAtEpoch": 0,
            "lastError": None,
        },
    }


_write_event = dispatcher_fixtures.write_socket_down_outbox_event


_fallback_script = dispatcher_fixtures.fallback_script


# These tests exercise email-fallback MECHANICS under a pytest tmp root. The
# provenance gate refuses email for any dispatcher rooted in a test tmp dir by
# design (the 2026-08-28 leak's tell), so it is disabled here explicitly; the
# gate itself is covered by test_bot_errors_email_fallback_test_provenance.py.
def test_accepted_fallback_is_terminal_and_archived(tmp_path):
    """Accepted email -> True/email_delivered, archived to sent/, no leaks."""
    mod = _load_module({
        "BOT_ERRORS_STATE_DIR": str(tmp_path / "state"),
        "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
    })
    paths = mod.setup_dirs()
    event_path = _write_event(paths, _event("evt-2435-accepted"))
    fallback = _fallback_script(tmp_path, 0)

    with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("send fails")), \
         patch.object(mod, "email_fallback_blocked_reason", return_value=None), \
         patch.object(mod, "EMAIL_FALLBACK", str(fallback)):
        ok, detail = mod.process_one(event_path, paths)

    assert ok is True and detail == "email_delivered"
    assert not list(paths["outbox"].glob("*.json")), "must not requeue to outbox"
    assert not list(paths["processing"].glob("*.json")), "must not leak the claimed file"
    sent_files = list(paths["sent"].glob("*.sent"))
    assert sent_files, "accepted fallback must archive to sent/"
    archived = json.loads(sent_files[0].read_text())
    assert archived["delivery"]["status"] == "email_delivered"
    assert archived["delivery"]["nextAttemptAtEpoch"] == 0


def test_accepted_fallback_writes_dispatch_log(tmp_path):
    """The terminal acceptance is auditable: log type email_delivered."""
    mod = _load_module({
        "BOT_ERRORS_STATE_DIR": str(tmp_path / "state"),
        "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
    })
    paths = mod.setup_dirs()
    event_path = _write_event(paths, _event("evt-2435-log"))
    fallback = _fallback_script(tmp_path, 0)

    with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("send fails")), \
         patch.object(mod, "email_fallback_blocked_reason", return_value=None), \
         patch.object(mod, "EMAIL_FALLBACK", str(fallback)):
        mod.process_one(event_path, paths)

    log_path = paths["logs"] / "dispatch.jsonl"
    assert log_path.exists(), "dispatch log must exist"
    assert '"email_delivered"' in log_path.read_text(), "dispatch log must record the terminal acceptance"


def test_failed_fallback_still_retries(tmp_path):
    """No regression: a failing email fallback keeps the normal retry path."""
    mod = _load_module({
        "BOT_ERRORS_STATE_DIR": str(tmp_path / "state"),
        "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
    })
    paths = mod.setup_dirs()
    event_path = _write_event(paths, _event("evt-2435-failed"))
    fallback = _fallback_script(tmp_path, 1)

    with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("send fails")), \
         patch.object(mod, "email_fallback_blocked_reason", return_value=None), \
         patch.object(mod, "EMAIL_FALLBACK", str(fallback)):
        ok, detail = mod.process_one(event_path, paths)

    assert detail != "email_delivered", "failed email must not take the terminal path"
    assert not list(paths["sent"].glob("*.sent")), "failed email must not archive as sent"
    requeued = list(paths["outbox"].glob("*.json"))
    assert requeued, "failed email keeps the event on the retry path"
    delivery = json.loads(requeued[0].read_text()).get("delivery", {})
    assert delivery.get("status") != "email_delivered"
