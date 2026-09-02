"""Tests for #2437: malformed delivery metadata must be quarantined, not wedged.

fails-before:  ``ready()`` calls ``int(delivery.get("nextAttemptAtEpoch") or 0)``
               without a try boundary. A syntactically valid event whose
               ``nextAttemptAtEpoch`` is a non-numeric string (or float / dict)
               raises on that conversion, aborting the whole scan loop. One
               poison record then wedges every later valid alert; daemon mode
               re-wedges on the next interval because the record is unchanged.
               The bare ``delivery_ready(event)`` caller in
               ``suppress_alerts_recovered_before_delivery`` has the same abort.

passes-after:  ``ready()`` catches the malformed timestamp, calls
               ``quarantine_poison(...)``, and returns False so the scan skips
               this record and continues. ``delivery_ready()`` no longer raises
               (treats unreadable timestamps as "not ready"). A later valid
               event in the same outbox is still delivered.

All tests exercise the REAL dispatcher module (importlib load + ready() +
delivery_ready() + quarantine_poison side effects, mocked WhatsApp/email).
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

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


def _load_module(state_dir: Path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_2437", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _write_event(path: Path, *, next_attempt) -> None:
    """Write a minimal incident-alert envelope with the given epoch value.

    Shape (schemaVersion/machine/instance/source/alertSource/severity/
    eventType=alert/evidence) is the canonical incident-alert form verified at
    ``tests/.../test_bot_errors_daily_health_saliency.py:272-282`` — passes
    ``classify_event().kind == "incident_alert"``.
    """
    event = {
        "schemaVersion": 1,
        "machine": "test-machine",
        "instance": "bot-errors-test",
        "source": "test-2437",
        "alertSource": "line-a",
        "severity": "critical",
        "eventType": "alert",
        "evidence": f"instance: line-a test event {path.stem}",
        "delivery": {
            "attempts": 0,
            "status": "queued",
            "nextAttemptAtEpoch": next_attempt,
            "lastError": None,
        },
    }
    path.write_text(json.dumps(event), encoding="utf-8")


def test_ready_quarantines_malformed_next_attempt_at_epoch(tmp_path):
    """RED-on-main: a non-numeric nextAttemptAtEpoch must be quarantined, not raised.

    On main ``ready()`` raises TypeError/ValueError on the int() conversion and
    aborts the caller's scan; after the #2437 fix it quarantines the file and
    returns False.
    """
    mod = _load_module(tmp_path / "state")
    paths = mod.setup_dirs()
    poison = paths["outbox"] / "poison.json"
    _write_event(poison, next_attempt="not-a-number")

    with (
        patch.object(mod, "send_whatsapp", side_effect=RuntimeError("whatsapp down")),
        patch.object(mod, "email_fallback", return_value=False),
    ):
        result = mod.ready(poison, paths["quarantine"])

    # Discriminating assertion #1: ready() must not raise; it returns False.
    assert result is False, (
        "a malformed-metadata event must be reported not-ready, not raise"
    )
    # Discriminating assertion #2: the poison file is moved to quarantine.
    assert not poison.exists(), "the poison event must be moved out of the outbox"
    quarantined = list(paths["quarantine"].glob("poison.json.*.poison"))
    assert quarantined, "a quarantine marker file must exist for the malformed event"


def test_ready_does_not_quarantine_valid_zero_epoch(tmp_path):
    """No regression: a well-formed integer epoch is never quarantined."""
    mod = _load_module(tmp_path / "state")
    paths = mod.setup_dirs()
    good = paths["outbox"] / "good.json"
    _write_event(good, next_attempt=0)

    result = mod.ready(good, paths["quarantine"])

    assert result is True, "a zero nextAttemptAtEpoch must be ready immediately"
    assert good.exists(), "a ready event must NOT be moved to quarantine"


def test_delivery_ready_does_not_raise_on_malformed(tmp_path):
    """RED-on-main: bare delivery_ready() caller must not abort on bad metadata.

    ``suppress_alerts_recovered_before_delivery`` calls ``delivery_ready(event)``
    directly on an already-loaded event; a malformed timestamp there would abort
    the suppression scan. The fix makes ``delivery_ready()`` treat unreadable
    timestamps as "not ready" instead of raising.
    """
    mod = _load_module(tmp_path / "state")
    mod.setup_dirs()
    malformed_event = {
        "delivery": {"nextAttemptAtEpoch": {"oops": "a dict is not a timestamp"}},
    }
    # Must not raise; a malformed timestamp is treated as not-ready.
    assert mod.delivery_ready(malformed_event) is False

    string_event = {"delivery": {"nextAttemptAtEpoch": "later"}}
    assert mod.delivery_ready(string_event) is False

    list_event = {"delivery": {"nextAttemptAtEpoch": [1, 2, 3]}}
    assert mod.delivery_ready(list_event) is False


def test_ready_malformed_does_not_wedge_later_valid_event(tmp_path):
    """End-to-end: a malformed record no longer wedges the whole outbox scan.

    On main, calling ``ready()`` on the poison file raises and the caller's
    scan loop aborts; the later valid event is never reached. After the fix,
    ``ready()`` quarantines the poison and returns False, so the scan continues
    and the valid event is processed normally.
    """
    mod = _load_module(tmp_path / "state")
    paths = mod.setup_dirs()
    poison = paths["outbox"] / "00-poison.json"
    good = paths["outbox"] / "01-good.json"
    _write_event(poison, next_attempt="not-a-number")
    _write_event(good, next_attempt=0)

    with (
        patch.object(mod, "send_whatsapp", side_effect=RuntimeError("whatsapp down")),
        patch.object(mod, "email_fallback", return_value=False),
    ):
        poison_result = mod.ready(poison, paths["quarantine"])
        good_result = mod.ready(good, paths["quarantine"])

    assert poison_result is False, "poison event must be quarantined and skipped"
    assert good_result is True, (
        "later valid event must still be reached after the poison is skipped"
    )
    assert good.exists(), (
        "the valid event must NOT be moved (it was ready, not claimed here)"
    )
