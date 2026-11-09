"""Routing contract for the transport's ``whatsapp_link_dead`` card.

2026-11-09: four bots ran 8-18 days linkless. Each outage's immediate
``whatsapp_device_bond_lost`` alert was suppressed as a duplicate of an
``awaiting_physical`` incident opened months earlier for the same key. The
transport now raises ``whatsapp_link_dead`` once per outage, 10 minutes after
a 401 with no reconnect, and clears it when the link opens. These tests pin
that the dispatcher delivers it even while such an old root is open and folds
a repeat for the same outage into the open incident. The transport tests
(tests/transport/dead-link-alert.test.ts) cover the clear on reconnect.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import time
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"
_ENV_KEYS = ["BOT_ERRORS_STATE_DIR"]
_clean_env = dispatcher_fixtures.make_env_scrub_fixture(_ENV_KEYS)

_INSTANCE = "ad-bot"
_OLD = 1788424350  # 2026-09-03: the stale awaiting_physical root


def _load(state_dir: Path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("bot_errors_link_dead_routing", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _event(event_id: str, event_type: str = "alert") -> dict:
    return {
        "schemaVersion": 2,
        "id": event_id,
        "eventType": event_type,
        "eventKind": "incident_alert" if event_type == "alert" else "incident_clear",
        "severity": "critical" if event_type == "alert" else "info",
        "instance": _INSTANCE,
        "source": "whatsapp_link_dead",
        "summary": "WhatsApp link down: whatsoup@ad-bot logged out (401) at 2026-10-22T05:08:35.688Z",
        "evidence": "outage_started_at: 2026-10-22T05:08:35.688Z\nstatus_code: 401",
    }


def _state_with_stale_bond_root(mod) -> dict:
    probe = dict(_event("probe"), source="whatsapp_device_bond_lost")
    key = mod.incident_key(probe)
    return {
        "version": 1,
        "openIncidents": {
            key: {
                "status": "awaiting_physical",
                "openedAt": _OLD,
                "lastSentAt": _OLD,
                "lastNotifiedAt": int(time.time()) - 3600,
                "awaitingPhysicalAt": _OLD,
                "failureCode": "WA_AUTH_BOND_SERVER_REVOKED",
                "assetKind": "whatsapp_linked_device",
                "suppressedCount": 3692,
                "generationToken": "a0c1e2f3a4b5c6d7",
            }
        },
        "lastSentAt": {},
    }


def test_link_dead_is_delivered_while_an_old_bond_root_is_open(tmp_path):
    mod = _load(tmp_path)
    state = _state_with_stale_bond_root(mod)

    assert mod.should_suppress_send(_event("outage-1"), state) is None


def test_bond_lost_itself_is_still_absorbed_by_the_old_root(tmp_path):
    """The gap this card closes: the existing source alone stays silent."""
    mod = _load(tmp_path)
    state = _state_with_stale_bond_root(mod)
    bond = dict(_event("bond-1"), source="whatsapp_device_bond_lost")

    reason = mod.should_suppress_send(bond, state)

    assert reason is not None and "duplicate suppressed" in reason


def test_a_repeat_for_the_same_outage_is_not_a_second_card(tmp_path):
    mod = _load(tmp_path)
    first = _event("outage-1")
    key = mod.incident_key(first)
    now = int(time.time())
    state = {
        "version": 1,
        "openIncidents": {
            key: {"status": "open", "openedAt": now - 60, "lastSentAt": now - 60, "lastNotifiedAt": now - 60,
                  "suppressedCount": 0, "generationToken": "b0c1e2f3a4b5c6d7"},
        },
        "lastSentAt": {key: now - 60},
    }

    reason = mod.should_suppress_send(_event("outage-1-repeat"), state)

    assert reason is not None and "duplicate suppressed" in reason


def _card_event(outage_started_at) -> dict:
    """The event as the outbox emits it: summary and evidence are confined."""
    event = dict(
        _event("outage-card"),
        summary="unknown - 120 chars - digest 0123abcd",
        evidence="unknown - 240 chars - digest 4567cdef",
        createdAt="2026-10-22T05:18:35.700Z",
    )
    if outage_started_at is not None:
        event["diagnostics"] = {"queue": "/tmp/outbox", "outageStartedAt": outage_started_at}
    return event


def test_the_card_names_the_bot_and_the_outage_start(tmp_path):
    """Owner ruling 2026-11-09: one BOT ERRORS card naming the bot and the time.

    Confinement turns the summary and evidence that carried the start into
    digests, so the start rides a structured field and is rendered from it.
    """
    mod = _load(tmp_path)

    card = mod.format_event(_card_event("2026-10-22T05:08:35.688Z"))

    assert f"instance: {_INSTANCE}" in card
    assert "outage_started: 2026-10-22T05:08:35.688Z" in card


def test_a_malformed_outage_start_is_not_rendered(tmp_path):
    mod = _load(tmp_path)

    malformed = [
        "+1 (555) 123-4567",
        "/home/testuser/.config/whatsoup/tokens.env",
        "yesterday",
        1761109715,
        "2026-10-22T05:08:35.688Z\nx",
        "2026-13-45T25:61:00.000Z",
        "\u0662\u0660\u0662\u0666-10-22T05:08:35.688Z",  # Arabic-Indic digits
    ]
    for value in malformed:
        card = mod.format_event(_card_event(value))
        assert "outage_started" not in card, value


def test_a_card_without_the_field_renders_as_before(tmp_path):
    mod = _load(tmp_path)

    assert "outage_started" not in mod.format_event(_card_event(None))
