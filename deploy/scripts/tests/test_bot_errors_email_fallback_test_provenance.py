"""Email fallback must never escalate test-provenance / test-leak events.

2026-08-28: a pytest-fixture dead-letter (dispatch log under a Linux
``pytest-of-<user>`` basetemp, synthetic machine name, a REAL instance label)
was delivered to the operator as a real critical email through the F5 email
fallback. The queue path already suppresses test-provenance events; the email
fallback applied no such gate, and the leak-pattern set did not recognise
Linux pytest basetemps. Both layers are covered here.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

_ENV_KEYS = ["BOT_ERRORS_STATE_DIR", "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS", "BOT_ERRORS_TEST_LEAK_PATH_PATTERNS"]


@pytest.fixture(autouse=True)
def _clean_env():
    saved = {key: os.environ.get(key) for key in _ENV_KEYS}
    yield
    for key, value in saved.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def _load_module(env: dict[str, str]):
    for key, value in env.items():
        os.environ[key] = value
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_email_provenance", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _event(**overrides: Any) -> dict[str, Any]:
    event: dict[str, Any] = {
        "schemaVersion": 1,
        "id": "evt-email-provenance",
        "eventType": "alert",
        "severity": "critical",
        "source": "daily-health-fail",
        "instance": "eh-bot",
        "machine": "relay-deadletter-hub",
        "summary": "daily health failing",
        "evidence": "health eh-bot: 500 status=unhealthy",
        "createdAt": "2026-08-28T23:39:19Z",
        "delivery": {"attempts": 3, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    event.update(overrides)
    return event


def _write_event(paths: dict[str, Path], event: dict[str, Any]) -> Path:
    event_path = paths["outbox"] / f"20260828233919.eh-bot.daily-health-fail.{event['id']}.json"
    event_path.write_text(json.dumps(event, indent=2, sort_keys=True) + "\n")
    event_path.chmod(0o600)
    return event_path


def _executable_fallback(tmp_path: Path) -> str:
    script = tmp_path / "email-fallback.sh"
    script.write_text("#!/bin/sh\nexit 0\n")
    script.chmod(0o755)
    return str(script)


def _dispatch_log_types(paths: dict[str, Path]) -> list[str]:
    log_path = paths["logs"] / "dispatch.jsonl"
    if not log_path.exists():
        return []
    return [json.loads(line).get("type") for line in log_path.read_text().splitlines() if line.strip()]


def test_linux_pytest_basetemp_blocks_email_fallback_without_widening_global_patterns():
    # The basetemp rule is scoped to the email gate: a global TEST_LEAK pattern
    # would match the suite's own tmp_path roots on Linux CI and drop fixture
    # events in unrelated tests.
    mod = _load_module({"BOT_ERRORS_STATE_DIR": "/tmp/unused-state-dir-for-pattern-test"})
    event = _event(dispatchlog="/srv/whatsoup/tmp/pytest-of-user/pytest-4/testdeadlettersavesabsorbe0/logs/dispatch.jsonl")
    assert mod.event_is_test_leak(event) is False
    assert mod.email_fallback_blocked_reason(event) == "test_leak"


def test_blocked_reason_recognises_provenance_flag_and_clean_events():
    mod = _load_module({"BOT_ERRORS_STATE_DIR": "/tmp/unused-state-dir-for-pattern-test"})
    flagged = _event(runtime={"provenance": {"test": True}})
    assert mod.email_fallback_blocked_reason(flagged) == "test_provenance"
    assert mod.email_fallback_blocked_reason(_event()) is None


def test_test_provenance_event_never_reaches_email_fallback(tmp_path: Path):
    mod = _load_module({
        "BOT_ERRORS_STATE_DIR": str(tmp_path / "state"),
        "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
    })
    paths = mod.setup_dirs()
    event_path = _write_event(paths, _event(runtime={"provenance": {"test": True}}))

    with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("send fails")), \
         patch.object(mod, "EMAIL_FALLBACK", _executable_fallback(tmp_path)), \
         patch.object(mod, "email_fallback", return_value=True) as fallback:
        mod.process_one(event_path, paths)

    assert fallback.call_count == 0
    assert "email_fallback_test_provenance_suppressed" in _dispatch_log_types(paths)
    outbox_files = list(paths["outbox"].glob("*.json"))
    assert outbox_files, "event must be requeued, not delivered by email"
    delivery = json.loads(outbox_files[0].read_text()).get("delivery", {})
    assert delivery.get("emailFallback") == "not_attempted"


def test_pytest_basetemp_leak_never_reaches_email_fallback(tmp_path: Path):
    mod = _load_module({
        "BOT_ERRORS_STATE_DIR": str(tmp_path / "state"),
        "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
    })
    paths = mod.setup_dirs()
    event_path = _write_event(paths, _event(
        dispatchlog="/srv/whatsoup/tmp/pytest-of-user/pytest-4/testdeadlettersavesabsorbe0/logs/dispatch.jsonl",
    ))

    with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("send fails")), \
         patch.object(mod, "EMAIL_FALLBACK", _executable_fallback(tmp_path)), \
         patch.object(mod, "email_fallback", return_value=True) as fallback:
        mod.process_one(event_path, paths)

    assert fallback.call_count == 0


def test_clean_event_still_uses_email_fallback(tmp_path: Path):
    # The dispatcher stamps its own dispatch-log path into the event before the
    # fallback runs, and every pytest tmp root matches a test-leak pattern by
    # design (that is the leak's tell). The positive path therefore needs a
    # state dir OUTSIDE any test root; it is created under $HOME and removed.
    state_root = Path.home() / f".bot-errors-email-gate-test-{uuid.uuid4().hex}"
    try:
        mod = _load_module({
            "BOT_ERRORS_STATE_DIR": str(state_root),
            "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
        })
        paths = mod.setup_dirs()
        event_path = _write_event(paths, _event())

        with patch.object(mod, "send_whatsapp", side_effect=RuntimeError("send fails")), \
             patch.object(mod, "EMAIL_FALLBACK", _executable_fallback(tmp_path)), \
             patch.object(mod, "email_fallback", return_value=True) as fallback:
            mod.process_one(event_path, paths)

        assert fallback.call_count == 1
    finally:
        shutil.rmtree(state_root, ignore_errors=True)
