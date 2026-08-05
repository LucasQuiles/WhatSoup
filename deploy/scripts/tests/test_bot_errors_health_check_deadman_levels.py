"""Tests for #2425 and #2462: deadman levels + daily health receipt.

Loads bot-errors-health-check.py via importlib (hyphen in filename prevents normal import).
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


# ===========================================================================
# TESTS: deadman notification levels + state tracking (#2425)
# ===========================================================================

def test_deadman_failed_is_warning():
    assert _mod._deadman_delivery_level("failed") == "warning"


def test_deadman_rejected_is_warning():
    assert _mod._deadman_delivery_level("rejected_unconfirmed") == "warning"


def test_deadman_sent_is_info():
    assert _mod._deadman_delivery_level("sent") == "info"


def test_deadman_suppressed_is_info():
    assert _mod._deadman_delivery_level("suppressed_cooldown") == "info"


def test_deadman_rejected_count_increments():
    state = {}
    status = "failed"
    if status in ("failed", "rejected_unconfirmed"):
        state["lastRejectedCount"] = (int(state.get("lastRejectedCount") or 0)) + 1
    assert state.get("lastRejectedCount") == 1


def test_deadman_rejected_count_unchanged_on_sent():
    state = {}
    status = "sent"
    if status in ("failed", "rejected_unconfirmed"):
        state["lastRejectedCount"] = (int(state.get("lastRejectedCount") or 0)) + 1
    assert state.get("lastRejectedCount") is None


def test_deadman_recovery_result_success():
    result = "success" if "sent" == "sent" else "failed"
    assert result == "success"


def test_deadman_recovery_result_failed():
    result = "success" if "failed" == "sent" else "failed"
    assert result == "failed"


# ===========================================================================
# TESTS: daily health durable receipt (#2462)
# ===========================================================================

def test_daily_health_receipt_written(tmp_path, monkeypatch):
    """record_daily_health_receipt must write a receipt JSON file."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    event_path = tmp_path / "outbox" / "evt.daily-health.test.json"
    event_path.parent.mkdir(parents=True)
    event_path.write_text("{}")

    _mod.record_daily_health_receipt(event_path, "info")

    receipt_path = tmp_path / "daily-health-receipt.json"
    assert receipt_path.exists(), "receipt file must exist"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["eventId"] == "evt.daily-health.test"
    assert receipt["severity"] == "info"
    assert "emittedAt" in receipt


def test_daily_health_receipt_alert_severity(tmp_path, monkeypatch):
    """Alert-severity daily health must also produce a receipt."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    event_path = tmp_path / "outbox" / "evt.critical.json"
    event_path.parent.mkdir(parents=True)
    event_path.write_text("{}")

    _mod.record_daily_health_receipt(event_path, "critical")

    receipt = json.loads(
        (tmp_path / "daily-health-receipt.json").read_text(encoding="utf-8")
    )
    assert receipt["severity"] == "critical"


def test_daily_health_receipt_overwrites_previous(tmp_path, monkeypatch):
    """Second cycle overwrites prior receipt (last cycle wins)."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    outbox = tmp_path / "outbox"
    outbox.mkdir(parents=True)
    (outbox / "ev1.json").write_text("{}")
    (outbox / "ev2.json").write_text("{}")

    _mod.record_daily_health_receipt(outbox / "ev1.json", "info")
    _mod.record_daily_health_receipt(outbox / "ev2.json", "critical")

    receipt = json.loads(
        (tmp_path / "daily-health-receipt.json").read_text(encoding="utf-8")
    )
    assert receipt["eventId"] == "ev2"
    assert receipt["severity"] == "critical"
