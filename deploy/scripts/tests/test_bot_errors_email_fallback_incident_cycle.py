"""Discriminating regression for the post-adoption email-fallback terminal path.

Companion to test_bot_errors_incident_cycle_required_3054.py. That suite proves
the *guard* at helper entry; this one proves the *email-fallback terminal path*
inside ``process_one`` survives when an ``IncidentStateCycle`` is active.

fails-before:  the accepted-email terminal block required
               ``require_all_advance([incident_publication, email_publication])``
               unconditionally, but ``incident_publication`` is assigned ONLY in
               the ``else`` (no-incident) branch — when ``incident`` is present
               the code takes ``incident.commit()`` and never binds it. So the
               post-adoption email-fallback path raised ``UnboundLocalError``
               before it could archive the event, leaking the claimed file into
               processing/ where reclaim would resurrect and re-send it.
passes-after:  when ``incident`` is present the required-advance set is
               ``[email_publication]`` (incident durability is carried by
               ``incident.commit()``); the event archives to sent/ exactly like
               the no-incident path. The two sibling terminal paths (suppressed,
               primary-sent) already guarded this — this closes the trio.

Exercises the REAL dispatcher module (importlib load + process_one) with a real
adopted controller-state session, mirroring the #2435 email-fallback harness.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
_SCRIPT = _SCRIPTS / "bot-errors-dispatcher.py"
sys.path.insert(0, str(_SCRIPTS))
sys.path.insert(0, str(_SCRIPTS / "lib"))

from lib.controller_state import open_controller_state  # noqa: E402

TEST_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS",
    "BOT_ERRORS_OUTBOX_DIR",
]


@pytest.fixture(autouse=True)
def _clean_test_env():
    saved = {k: os.environ.get(k) for k in TEST_ENV_KEYS}
    for k in TEST_ENV_KEYS:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _load_module(extra_env: dict[str, str]):
    for k, v in extra_env.items():
        os.environ[k] = v
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_efic", _SCRIPT)
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
        "summary": "email fallback under active incident",
        "evidence": "post-adoption email-fallback terminal path",
        "createdAt": "2026-06-12T00:00:00Z",
        "delivery": {
            "attempts": 3,
            "status": "queued",
            "nextAttemptAtEpoch": 0,
            "lastError": None,
        },
    }


def _write_event(paths: dict[str, Path], event: dict[str, Any]) -> Path:
    event_path = paths["outbox"] / f"20260612000000.ana-bot.socket_down.{event['id']}.json"
    event_path.write_text(json.dumps(event, indent=2, sort_keys=True) + "\n")
    event_path.chmod(0o600)
    return event_path


def _fallback_script(tmp_path: Path, exit_code: int) -> Path:
    script = tmp_path / "fake-fallback.sh"
    script.write_text(f"#!/bin/sh\nexit {exit_code}\n")
    script.chmod(0o755)
    return script


def _adopt(mod, paths: dict[str, Path]):
    """Adopt the incident state dir via the session save path (creates
    ``.initialized``), so process_one takes the incident-present branch."""
    # Production parity: controller_state rejects a group/other-writable anchor
    # parent as ``unsafe_file`` at session open; keep the root at 0700 under any
    # umask (mirrors the #3054 fixture hardening).
    os.chmod(paths["incident_state"].parent, 0o700)
    session = open_controller_state(
        paths["incident_state"],
        component="dispatcher-incident",
        bootstrap=mod.dispatcher_bootstrap_state,
        validate_payload=mod.validate_dispatcher_state,
        lock_timeout_seconds=10,
    )
    with session:
        result = session.load()
        session.save(dict(result.payload or {}), result.capability)
    marker = paths["incident_state"].parent / (paths["incident_state"].name + ".initialized")
    assert marker.exists(), "adoption fixture must create .initialized"


def test_email_fallback_terminal_under_active_incident_archives(tmp_path):
    """DISCRIMINATOR: accepted email fallback + active IncidentStateCycle must
    reach the terminal path (email_delivered, archived to sent/) without an
    UnboundLocalError. Fails if fix 2's ternary guard is reverted."""
    mod = _load_module({
        "BOT_ERRORS_STATE_DIR": str(tmp_path / "state"),
        "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS": "10",
    })
    paths = mod.setup_dirs()
    _adopt(mod, paths)
    event_path = _write_event(paths, _event("evt-efic-accepted"))
    fallback = _fallback_script(tmp_path, 0)

    session = open_controller_state(
        paths["incident_state"],
        component="dispatcher-incident",
        bootstrap=mod.dispatcher_bootstrap_state,
        validate_payload=mod.validate_dispatcher_state,
        lock_timeout_seconds=10,
    )
    # The #3400 provenance gate blocks email fallback for any event carrying a
    # test-tmp-rooted diagnostics.dispatchLog (which process_one injects from
    # tmp_path here); neutralize it exactly like the #2435 harness so the run
    # reaches the terminal path under test.
    with session, \
            patch.object(mod, "send_whatsapp", side_effect=RuntimeError("send fails")), \
            patch.object(mod, "email_fallback_blocked_reason", return_value=None), \
            patch.object(mod, "EMAIL_FALLBACK", str(fallback)):
        result = session.load()
        cycle = mod.IncidentStateCycle(
            session, result.payload, result.capability, paths=paths
        )
        ok, detail = mod.process_one(event_path, paths, incident=cycle)

    assert ok is True and detail == "email_delivered", (ok, detail)
    assert not list(paths["outbox"].glob("*.json")), "must not requeue to outbox"
    assert not list(paths["processing"].glob("*.json")), "must not leak the claimed file"
    sent_files = list(paths["sent"].glob("*.sent"))
    assert sent_files, "accepted fallback under incident must archive to sent/"
    archived = json.loads(sent_files[0].read_text())
    assert archived["delivery"]["status"] == "email_delivered"
