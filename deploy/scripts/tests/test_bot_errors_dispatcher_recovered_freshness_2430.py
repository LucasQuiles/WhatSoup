"""Tests for #2430: recovered-before-delivery suppression must persist freshness.

fails-before:  ``suppress_alerts_recovered_before_delivery()`` absorbed daily-health
               carriers into the in-memory ``incident_state`` (added by #3061) but
               never called ``save_incident_state()`` / ``incident.commit()``. The
               pass then terminally moved both the alert and the clear out of the
               retryable outbox, so the per-event loop iterated nothing and the only
               remaining commit was the conditional test-leak marker. On-disk
               ``dailyHealthFreshness`` stayed absent — the documented falsifier
               (``state_saves=0``, ``freshness_after_terminal_moves=absent``). A
               restart had no event from which to reconstruct the stamp, so the
               heartbeat watchdog read stale/missing liveness for a healthy host.

passes-after:  The pass now absorbs every daily-health carrier that will leave the
               outbox, persists changed incident state ONCE before the first
               ``move_suppressed_event``, and only then performs the terminal moves
               — mirroring ``collapse_ready_storms`` / ``suppress_ready_recovery_
               duplicates``. On-disk ``dailyHealthFreshness`` records the newer
               clear observation even though both files left the outbox. A save
               failure raises before any move, leaving both files retryable.

All tests exercise the REAL dispatcher module (importlib load + the pass + on-disk
``load_incident_state`` reload, mocked WhatsApp/email).
"""

from __future__ import annotations

import importlib.util
import os
import sys
import time
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
]


_clean_test_env = dispatcher_fixtures.make_env_scrub_fixture(TEST_ENV_KEYS)


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load_module(state_dir: Path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_2430", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


_RELAY_HOST = "relay-2430-a"
_INSTANCE = "bot-errors-test-2430"


def _daily_health_event(
    *,
    event_id: str,
    event_type: str,
    created_at_epoch: int,
    next_attempt_at_epoch: int,
    severity: str = "critical",
) -> dict[str, Any]:
    """Canonical daily-health incident envelope (legacy v1 form).

    ``source`` begins with ``daily-health`` so ``record_daily_health_freshness``
    records it; ``diagnostics.relay.remoteHost`` is the freshness host key (per
    ``daily_health_host_from_payload``). eventKind is intentionally ABSENT: the
    legacy v1 classifier derives it from (eventType, severity) and rejects a
    literal eventKind on a v1 envelope (``unexpected_legacy_event_kind``) —
    same convention as ``test_bot_errors_collapse_freshness.py``.
    """
    return {
        "schemaVersion": 1,
        "id": event_id,
        "eventType": event_type,
        "severity": severity,
        "source": "daily-health",
        "machine": "dispatcher-test-machine",
        "instance": _INSTANCE,
        "alertSource": "health-check",
        "summary": "#2430 recovered-before-delivery freshness probe",
        "evidence": f"health {_INSTANCE}: 200 status=healthy wa_connected=true",
        "createdAt": _iso(created_at_epoch),
        "diagnostics": {"relay": {"remoteHost": _RELAY_HOST}},
        "delivery": {
            "attempts": 0,
            "status": "queued",
            "nextAttemptAtEpoch": next_attempt_at_epoch,
            "lastError": None,
        },
    }


def _iso(epoch: int) -> str:
    # Mirror the dispatcher's own iso_from_epoch so createdAt round-trips
    # through event_created_epoch() cleanly (the recorder only stamps when
    # it can trust the observation time).
    import datetime as _dt

    return _dt.datetime.fromtimestamp(epoch, tz=_dt.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


_write_event = dispatcher_fixtures.write_outbox_event


def test_no_open_incident_pair_persists_freshness_before_terminal_move(tmp_path):
    """RED-on-main: both files retire only after durable state records the clear.

    On main the pass absorbs the daily-health alert+clear in memory but never
    saves, then moves both files out of the outbox. After the pass the on-disk
    incident_state has no ``dailyHealthFreshness`` entry for the relay host —
    exactly the issue's falsifier. After the fix the clear's newer observation
    is durable on disk before either file leaves the outbox.
    """
    mod = _load_module(tmp_path / "state")
    paths = mod.setup_dirs()
    now = int(time.time())

    alert_epoch = now - 600
    clear_epoch = now - 60
    alert_path = _write_event(
        paths,
        "20260809T000000Z.alert.json",
        _daily_health_event(
            event_id="deferred-daily-health-alert",
            event_type="alert",
            created_at_epoch=alert_epoch,
            # Alert is NOT delivery-ready: queued into the future so
            # delivery_ready() is False, but it precedes the clear.
            next_attempt_at_epoch=now + 3600,
        ),
    )
    clear_path = _write_event(
        paths,
        "20260809T000100Z.clear.json",
        _daily_health_event(
            event_id="ready-daily-health-clear",
            event_type="clear",
            severity="info",
            created_at_epoch=clear_epoch,
            # Clear IS delivery-ready (eligible for the suppression pass).
            next_attempt_at_epoch=0,
        ),
    )

    with (
        patch.object(mod, "send_whatsapp", side_effect=RuntimeError("whatsapp down")),
        patch.object(mod, "email_fallback", return_value=False),
    ):
        suppressed = mod.suppress_alerts_recovered_before_delivery(paths)

    # Both files terminally retired.
    assert suppressed == 2, "alert + clear should both be suppressed"
    assert not alert_path.exists(), "alert must leave the outbox"
    assert not clear_path.exists(), "clear must leave the outbox"
    assert len(list(paths["suppressed"].glob("*.suppressed"))) == 2

    # Discriminating assertion: freshness is durable ON DISK after the pass.
    # On main this dict is absent (the falsifier); after the fix the clear's
    # newer observation is recorded under the relay host key.
    reloaded = mod.load_incident_state(paths)
    ledger = reloaded.get("dailyHealthFreshness")
    assert isinstance(ledger, dict), "dailyHealthFreshness must be persisted"
    assert _RELAY_HOST in ledger, "the relay host's freshness stamp must be durable"
    assert ledger[_RELAY_HOST]["lastSeenAt"] == clear_epoch, (
        "the newer clear observation must win the monotonic ledger"
    )


def test_save_failure_before_moves_leaves_both_files_retryable(tmp_path):
    """RED-on-main (behavior contract): a save failure must not move either file.

    The fix gates every terminal move on a successful save. If persistence
    raises (here simulated by making ``save_incident_state`` raise), the pass
    must propagate that failure before moving the alert OR the clear, leaving
    both retryable in the outbox so the next cycle (and the operator) can see
    them as a visible failed run.
    """
    mod = _load_module(tmp_path / "state")
    paths = mod.setup_dirs()
    now = int(time.time())

    alert_path = _write_event(
        paths,
        "20260809T000000Z.alert.json",
        _daily_health_event(
            event_id="deferred-daily-health-alert-savefail",
            event_type="alert",
            created_at_epoch=now - 600,
            next_attempt_at_epoch=now + 3600,
        ),
    )
    clear_path = _write_event(
        paths,
        "20260809T000100Z.clear.json",
        _daily_health_event(
            event_id="ready-daily-health-clear-savefail",
            event_type="clear",
            severity="info",
            created_at_epoch=now - 60,
            next_attempt_at_epoch=0,
        ),
    )

    def _boom(*_args, **_kwargs):
        raise RuntimeError("simulated persistence failure")

    with (
        patch.object(mod, "send_whatsapp", side_effect=RuntimeError("whatsapp down")),
        patch.object(mod, "email_fallback", return_value=False),
        patch.object(mod, "save_incident_state", side_effect=_boom),
    ):
        with pytest.raises(RuntimeError, match="simulated persistence failure"):
            mod.suppress_alerts_recovered_before_delivery(paths)

    # Both files MUST remain in the outbox (retryable), and nothing suppressed.
    assert alert_path.exists(), "alert must stay retryable when the save fails"
    assert clear_path.exists(), "clear must stay retryable when the save fails"
    assert len(list(paths["suppressed"].glob("*.suppressed"))) == 0, (
        "no terminal move may run after a save failure"
    )


def test_non_daily_health_pair_writes_no_incident_state(tmp_path):
    """No regression: a non-daily-health pair performs no incident-state write.

    The fix scopes the save to daily-health carriers only (matching the issue's
    "preserve existing behavior for non-daily-health pairs without unnecessary
    state writes"). A generic alert+clear pair suppresses normally but leaves
    the on-disk incident_state without a dailyHealthFreshness ledger and without
    an updatedAt advanced by this pass.
    """
    mod = _load_module(tmp_path / "state")
    paths = mod.setup_dirs()
    now = int(time.time())

    alert_path = _write_event(
        paths,
        "20260809T000000Z.alert.json",
        {
            "schemaVersion": 1,
            "id": "deferred-generic-alert",
            "eventType": "alert",
            "severity": "critical",
            "source": "generic-ops-2430",
            "machine": "dispatcher-test-machine",
            "instance": _INSTANCE,
            "alertSource": "line-a",
            "summary": "#2430 non-daily-health regression guard",
            "evidence": "generic ops alert",
            "createdAt": _iso(now - 600),
            "delivery": {
                "attempts": 0,
                "status": "queued",
                "nextAttemptAtEpoch": now + 3600,
                "lastError": None,
            },
        },
    )
    clear_path = _write_event(
        paths,
        "20260809T000100Z.clear.json",
        {
            "schemaVersion": 1,
            "id": "ready-generic-clear",
            "eventType": "clear",
            "severity": "info",
            "source": "generic-ops-2430",
            "machine": "dispatcher-test-machine",
            "instance": _INSTANCE,
            "alertSource": "line-a",
            "summary": "#2430 non-daily-health regression guard",
            "evidence": "generic ops clear",
            "createdAt": _iso(now - 60),
            "delivery": {
                "attempts": 0,
                "status": "queued",
                "nextAttemptAtEpoch": 0,
                "lastError": None,
            },
        },
    )

    state_before = mod.load_incident_state(paths)
    updated_at_before = state_before.get("updatedAt")

    with (
        patch.object(mod, "send_whatsapp", side_effect=RuntimeError("whatsapp down")),
        patch.object(mod, "email_fallback", return_value=False),
    ):
        suppressed = mod.suppress_alerts_recovered_before_delivery(paths)

    assert suppressed == 2
    assert not alert_path.exists()
    assert not clear_path.exists()

    reloaded = mod.load_incident_state(paths)
    assert "dailyHealthFreshness" not in reloaded, (
        "a non-daily-health pair must not manufacture freshness"
    )
    assert reloaded.get("updatedAt") == updated_at_before, (
        "a non-daily-health pair must not trigger an incident-state save"
    )
