"""Regression coverage for envelope safety in pre-delivery dispatcher passes."""
from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path
from typing import Any


_SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_DISPATCHER = _SCRIPTS_DIR / "bot-errors-dispatcher.py"


def _load_dispatcher():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_preprocess_envelope_safety", _DISPATCHER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


_dispatcher = _load_dispatcher()


def _write_event(paths: dict[str, Path], filename: str, event: dict[str, Any]) -> Path:
    path = paths["outbox"] / filename
    path.write_text(json.dumps(event), encoding="utf-8")
    # Producers publish events 0600 (emit + durable_json enforce it); the
    # fenced dispatcher rejects looser modes, so the fixture must match.
    path.chmod(0o600)
    return path


def _incident_event(
    *,
    event_id: str,
    event_kind: str,
    event_type: str,
    severity: str,
    created_at_epoch: int,
    next_attempt_at_epoch: int,
) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "id": event_id,
        "eventKind": event_kind,
        "eventType": event_type,
        "severity": severity,
        "source": "preprocess-envelope-safety",
        "machine": "dispatcher-test-machine",
        "instance": "dispatcher-test-instance",
        "summary": "pre-delivery envelope safety regression",
        "evidence": "regression fixture",
        "createdAt": _dispatcher.iso_from_epoch(created_at_epoch),
        "delivery": {
            "attempts": 0,
            "status": "queued",
            "nextAttemptAtEpoch": next_attempt_at_epoch,
        },
    }


def test_malformed_envelope_is_quarantined_without_blocking_valid_recovered_alert_suppression(tmp_path, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    paths = _dispatcher.setup_dirs()
    now = int(time.time())

    malformed_path = _write_event(
        paths,
        "20260730T000000Z.malformed.json",
        _incident_event(
            event_id="invalid-envelope",
            event_kind="incident_alert",
            event_type="alert",
            severity="info",
            created_at_epoch=now - 20,
            next_attempt_at_epoch=0,
        ),
    )
    deferred_alert_path = _write_event(
        paths,
        "20260730T000001Z.alert.json",
        _incident_event(
            event_id="deferred-alert",
            event_kind="incident_alert",
            event_type="alert",
            severity="critical",
            created_at_epoch=now - 10,
            next_attempt_at_epoch=now + 60,
        ),
    )
    clear_path = _write_event(
        paths,
        "20260730T000002Z.clear.json",
        _incident_event(
            event_id="ready-clear",
            event_kind="incident_recovery",
            event_type="clear",
            severity="info",
            created_at_epoch=now,
            next_attempt_at_epoch=0,
        ),
    )

    suppressed = _dispatcher.suppress_alerts_recovered_before_delivery(paths)

    assert suppressed == 2
    assert not malformed_path.exists()
    assert list(paths["quarantine"].glob("*.invalid-envelope"))
    assert not deferred_alert_path.exists()
    assert not clear_path.exists()
    assert len(list(paths["suppressed"].glob("*.suppressed"))) == 2
