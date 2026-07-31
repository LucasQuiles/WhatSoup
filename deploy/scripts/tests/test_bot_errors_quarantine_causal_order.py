"""Causal-order regressions for quarantine incident alerts and clears."""
from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path


_SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
_DISPATCHER = _SCRIPTS_DIR / "bot-errors-dispatcher.py"


def _load_dispatcher():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_quarantine_causal_order", _DISPATCHER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


_dispatcher = _load_dispatcher()
_SOURCE = "outbound_delivery_ambiguous"
_MACHINE = "causal-test-machine"
_INSTANCE = "causal-test-instance"


def _event(*, event_id: str, event_kind: str, event_type: str, created_at: str, next_attempt: int) -> dict[str, object]:
    return {
        "schemaVersion": 2,
        "eventKind": event_kind,
        "eventType": event_type,
        "severity": "critical" if event_type == "alert" else "info",
        "id": event_id,
        "source": _SOURCE,
        "machine": _MACHINE,
        "instance": _INSTANCE,
        "summary": "causal ordering regression",
        "evidence": "bounded test evidence",
        "createdAt": created_at,
        "delivery": {
            "attempts": 0,
            "status": "queued",
            "nextAttemptAtEpoch": next_attempt,
        },
    }


def _write(paths: dict[str, Path], name: str, event: dict[str, object]) -> Path:
    path = paths["outbox"] / name
    path.write_text(json.dumps(event), encoding="utf-8")
    return path


def test_older_clear_cannot_retire_a_later_same_second_quarantine_alert(tmp_path, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    paths = _dispatcher.setup_dirs()
    now = int(time.time())
    clear = _event(
        event_id="clear-first",
        event_kind="incident_recovery",
        event_type="clear",
        created_at="2026-07-30T12:00:00.000Z",
        next_attempt=0,
    )
    alert = _event(
        event_id="alert-later",
        event_kind="incident_alert",
        event_type="alert",
        created_at="2026-07-30T12:00:00.001Z",
        next_attempt=now + 60,
    )
    clear_path = _write(paths, "20260730T120000Z.clear-first.json", clear)
    alert_path = _write(paths, "20260730T120000Z_001.alert-later.json", alert)

    generated_name = _dispatcher.outbox_path_for_event(alert, paths).name
    assert generated_name.startswith("20260730T120000Z_001.")
    assert sorted([clear_path.name, generated_name]) == [clear_path.name, generated_name]
    assert _dispatcher.suppress_alerts_recovered_before_delivery(paths) == 0
    assert clear_path.exists()
    assert alert_path.exists()


def test_quarantine_clear_requires_strictly_later_full_timestamp_than_open_alert():
    key = f"{_MACHINE}|{_INSTANCE}|{_SOURCE}"
    state = {
        "version": 1,
        "lastSentAt": {},
        "openIncidents": {
            key: {
                "status": "open",
                "eventCreatedAt": "2026-07-30T12:00:00.001Z",
                "eventCreatedAtEpoch": 1785412800,
                "openedAt": 1785412800,
            },
        },
    }
    stale_clear = _event(
        event_id="clear-before-open",
        event_kind="incident_recovery",
        event_type="clear",
        created_at="2026-07-30T12:00:00.000Z",
        next_attempt=0,
    )
    equal_clear = _event(
        event_id="clear-equal-open",
        event_kind="incident_recovery",
        event_type="clear",
        created_at="2026-07-30T12:00:00.001Z",
        next_attempt=0,
    )

    assert "does not follow" in str(_dispatcher.should_suppress_send(stale_clear, state))
    assert "does not follow" in str(_dispatcher.should_suppress_send(equal_clear, state))
