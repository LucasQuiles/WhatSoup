"""Tests for #2437 boundary-2: malformed delivery.attempts must be quarantined
after claim, not bounce between processing/ and outbox/ forever.

fails-before:  ``mark_attempt()`` (bot-errors-dispatcher.py:2585) converts
               ``delivery.attempts`` via ``int(delivery.get("attempts") or 0)``
               with no try boundary.  ``process_one()`` calls ``mark_attempt()``
               AFTER ``claim()`` has moved the file into ``processing/``, so a
               ``TypeError``/``ValueError`` escapes pre-update, the record is
               stranded in ``processing/``, and ``reclaim_processing()`` bounces
               it back to ``outbox/`` on the next restart.  Result: the poison
               record is claimed and fails again indefinitely, blocking every
               later-sorted valid event.

passes-after:  ``ready()`` validates ``delivery.attempts`` with the same typed
               quarantine as boundary-1 (``nextAttemptAtEpoch``), routing the
               malformed event to ``quarantine/`` before claim so the scan loop
               continues and later valid events still dispatch.

All tests exercise the REAL dispatcher module (importlib load), mocked WhatsApp
and email-fallback so delivery never reaches the network.
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

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

TEST_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS",
    "BOT_ERRORS_OUTBOX_DIR",
    "BOT_ERRORS_JID",
]


_clean_test_env = dispatcher_fixtures.make_env_scrub_fixture(TEST_ENV_KEYS)


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load_module(state_dir: Path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    os.environ["BOT_ERRORS_JID"] = "12345@s.whatsapp.net"
    spec = importlib.util.spec_from_file_location(
        "bot_errors_dispatcher_2437_attempts", _SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _write_event(
    path: Path,
    *,
    attempts: Any = 0,
    next_attempt: Any = 0,
    source: str = "test-2437-b2",
) -> None:
    """Write a minimal incident-alert envelope with the given delivery fields.

    Shape mirrors the canonical incident-alert form used by the boundary-1
    sibling test (test_bot_errors_dispatcher_malformed_meta_2437.py).
    """
    event = {
        "schemaVersion": 1,
        "machine": "test-machine",
        "instance": "bot-errors-test",
        "source": source,
        "alertSource": "line-a",
        "severity": "critical",
        "eventType": "alert",
        "evidence": f"instance: line-a test event {path.stem}",
        "delivery": {
            "attempts": attempts,
            "status": "queued",
            "nextAttemptAtEpoch": next_attempt,
            "lastError": None,
        },
    }
    path.write_text(json.dumps(event), encoding="utf-8")
    path.chmod(0o600)


# ===========================================================================
# 1. Type matrix — every malformed attempts value is quarantined, not raised
# ===========================================================================

MALFORMED_ATTEMPTS_VALUES = [
    pytest.param("not-a-number", id="non-numeric-string"),
    pytest.param({"oops": "dict"}, id="dict"),
    pytest.param([1, 2, 3], id="list"),
]


@pytest.mark.parametrize("bad_value", MALFORMED_ATTEMPTS_VALUES)
def test_ready_quarantines_malformed_attempts(tmp_path, bad_value):
    """RED-on-main: a malformed delivery.attempts must be quarantined, not raise.

    On main ``ready()`` validates only ``nextAttemptAtEpoch``; a malformed
    ``attempts`` passes ready(), is claimed, then ``mark_attempt()`` raises and
    the record is stranded in processing/. After the fix, ready() quarantines
    the file and returns False.
    """
    mod = _load_module(tmp_path / "state")
    paths = mod.setup_dirs()
    poison = paths["outbox"] / "poison.json"
    _write_event(poison, attempts=bad_value)

    with (
        patch.object(mod, "send_whatsapp", side_effect=RuntimeError("whatsapp down")),
        patch.object(mod, "email_fallback", return_value=False),
    ):
        result = mod.ready(poison, paths["quarantine"])

    assert result is False, (
        "a malformed-attempts event must be reported not-ready, not raise"
    )
    assert not poison.exists(), "the poison event must be moved out of the outbox"
    quarantined = list(paths["quarantine"].glob("poison.json.*.poison"))
    assert quarantined, "a quarantine marker file must exist for the malformed event"


def test_ready_does_not_quarantine_valid_zero_attempts(tmp_path):
    """No regression: a well-formed integer attempts count is never quarantined."""
    mod = _load_module(tmp_path / "state")
    paths = mod.setup_dirs()
    good = paths["outbox"] / "good.json"
    _write_event(good, attempts=0, next_attempt=0)

    result = mod.ready(good, paths["quarantine"])

    assert result is True, "a zero-attempts event with zero epoch must be ready"
    assert good.exists(), "a ready event must NOT be moved to quarantine"


def test_ready_does_not_quarantine_missing_attempts(tmp_path):
    """No regression: missing attempts (legacy compat) is treated as 0, not poison."""
    mod = _load_module(tmp_path / "state")
    paths = mod.setup_dirs()
    good = paths["outbox"] / "good.json"
    event = {
        "schemaVersion": 1,
        "machine": "test-machine",
        "instance": "bot-errors-test",
        "source": "test-2437-b2-missing",
        "alertSource": "line-a",
        "severity": "critical",
        "eventType": "alert",
        "evidence": "missing attempts legacy event",
        "delivery": {
            "status": "queued",
            "nextAttemptAtEpoch": 0,
            "lastError": None,
        },
    }
    good.write_text(json.dumps(event), encoding="utf-8")

    result = mod.ready(good, paths["quarantine"])

    assert result is True, "missing attempts must be treated as 0 (legacy compat)"
    assert good.exists(), "a legacy event must NOT be quarantined"


# ===========================================================================
# 2. Post-claim no-wedge — a malformed-attempts record does not block later
#    valid events in the same run_once cycle.
# ===========================================================================


def test_malformed_attempts_does_not_wedge_later_valid_event(tmp_path):
    """End-to-end: a malformed-attempts record no longer wedges run_once.

    On main the poison record is claimed, mark_attempt() raises inside
    process_one(), and the exception escapes the run_once loop at :6277 (no
    per-event boundary), aborting the cycle before the later valid event is
    reached. After the fix, ready() quarantines the poison before claim, so the
    scan continues and the valid event is delivered.
    """
    mod = _load_module(tmp_path / "state")
    paths = mod.setup_dirs()
    poison = paths["outbox"] / "00-poison.json"
    good = paths["outbox"] / "01-good.json"
    _write_event(poison, attempts="not-a-number", source="test-2437-b2-poison")
    _write_event(good, attempts=0, next_attempt=0, source="test-2437-b2-good")

    sent_paths: list[str] = []

    def _fake_send(text: str, socket_path: str = "") -> None:
        sent_paths.append(text)

    with (
        patch.object(mod, "send_whatsapp", side_effect=_fake_send),
        patch.object(mod, "email_fallback", return_value=False),
    ):
        result = mod.run_once(max_events=10)

    assert not poison.exists(), "poison must be moved out of the outbox"
    poison_quarantined = list(paths["quarantine"].glob("00-poison.json.*.poison"))
    assert poison_quarantined, "the malformed-attempts record must reach quarantine"

    assert result.get("failed", 0) == 0, (
        "the malformed-attempts record must not count as a delivery failure; "
        "it is quarantined before claim"
    )
    assert result.get("sent", 0) >= 1, (
        "the later valid event must still be delivered in the same cycle"
    )
    assert any("test-2437-b2-good" in t for t in sent_paths), (
        "the valid event's evidence must appear in the delivered WhatsApp text"
    )
    assert not good.exists(), "the valid event must have been claimed and sent"


# ===========================================================================
# 3. Restart no-loop — a malformed-attempts record stranded in processing/
#    from a pre-fix crash cannot bounce back to outbox and re-wedge forever.
# ===========================================================================


def test_restart_reclaim_then_ready_quarantines_stranded_poison(tmp_path):
    """A stranded processing/ record is reclaimed to outbox, then quarantined.

    Simulates: daemon crashed mid-process_one after claim (record in processing/)
    with a malformed attempts value. On restart, reclaim_processing moves it
    back to outbox. The next ready() call must quarantine it (not re-claim and
    re-crash), breaking the infinite outbox→processing→outbox bounce.
    """
    mod = _load_module(tmp_path / "state")
    paths = mod.setup_dirs()

    # Simulate a pre-fix crash: the poison record is stranded in processing/.
    stranded = paths["processing"] / "stranded.json.processing"
    _write_event(stranded, attempts={"bad": "dict"}, source="test-2437-b2-stranded")
    # Mark it as a processing file (reclaim uses original_name_from_processing).
    # The .processing suffix is what reclaim_processing keys on.

    # Step 1: restart → reclaim moves processing/ → outbox/
    reclaimed = mod.reclaim_processing(paths)
    assert reclaimed == 1, "the stranded record must be reclaimed to outbox"
    assert not stranded.exists(), "processing/ must be empty after reclaim"

    outbox_files = list(paths["outbox"].glob("*.json"))
    assert outbox_files, "the reclaimed record must be in outbox/"
    reclaimed_path = outbox_files[0]

    # Step 2: the next ready() call must quarantine it (not re-claim → re-crash).
    with (
        patch.object(mod, "send_whatsapp", side_effect=RuntimeError("whatsapp down")),
        patch.object(mod, "email_fallback", return_value=False),
    ):
        result = mod.ready(reclaimed_path, paths["quarantine"])

    assert result is False, "the reclaimed poison must be reported not-ready, not raise"
    assert not reclaimed_path.exists(), (
        "the reclaimed poison must be moved to quarantine, not left in outbox"
    )
    quarantined = list(paths["quarantine"].glob("*.poison"))
    assert quarantined, (
        "the stranded-then-reclaimed record must reach quarantine, ending the loop"
    )
