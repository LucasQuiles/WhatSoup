"""Tests for auto-close honesty (Pattern A — §10 C8 truthful close reporting).

The stale-autoclose safety valve removes a non-actionable stale incident from
openIncidents once it is quiet past the escalate horizon. Historically the
consolidated digest CLAIMED these were "self-healed". That inference is FALSE
when the monitoring path that would emit fresh failure events is itself down
(observed live: daily-health-fail incidents went quiet because the relay/daily-
health stopped arriving, not because the underlying drift was fixed — they were
auto-closed as "self-healed" and then reopened on the next health run).

The close itself is correct (bounds openIncidents); only the REPORT must be
truthful: an age-only auto-close is "aged out past escalate horizon, recovery
NOT verified — reopens if the condition persists", never "self-healed". And a
source auto-closed this way must carry a C8 audit tag so a later escalation to
critical can be flagged as a previously-suppressed (potentially missed) signal.
"""
from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_SUPPRESS_STALE_INFO_RENOTIFY",
    "BOT_ERRORS_INCIDENT_STALE_SECONDS",
    "BOT_ERRORS_INCIDENT_ESCALATE_SECONDS",
    "BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS",
    "BOT_ERRORS_STALE_RENOTIFY_SUPPRESS_SOURCES",
    "BOT_ERRORS_AUTOCLOSE_REOPEN_WINDOW_SECONDS",
]


@pytest.fixture(autouse=True)
def _clean_env():
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    for k in _ENV_KEYS:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _load(state_dir: Path, extra_env: dict[str, str] | None = None):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    # Force immediate (non-coalesced) digest so the single sweep emits it.
    os.environ.setdefault("BOT_ERRORS_STALE_AUTOCLOSE_DIGEST_COALESCE_SECONDS", "0")
    for k, v in (extra_env or {}).items():
        os.environ[k] = v
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_honesty", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _write_state(mod, records: dict) -> None:
    path = mod.state_paths()["incident_state"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "openIncidents": records, "lastSentAt": {}}))


def _capture_sends(mod) -> list[str]:
    sends: list[str] = []
    mod.send_whatsapp = lambda text, *a, **k: sends.append(text)  # type: ignore[assignment]
    return sends


def _quiet_drift_record(now: int) -> dict:
    # A daily-health-fail style non-actionable stale incident, quiet past escalate.
    return {
        "status": "stale",
        "openedAt": now - 10 * 86400,
        "lastSeenAt": now - 8 * 86400,
        "lastSummary": "daily-health found issues",
    }


def _alert_for_key(key: str) -> dict:
    machine, instance, source = key.split("|", 2)
    return {
        "schemaVersion": 1,
        "id": "evt-reopen-001",
        "eventType": "alert",
        "severity": "critical",
        "createdAt": "2026-06-23T00:00:00Z",
        "machine": machine,
        "instance": instance,
        "source": source,
        "summary": "same incident reopened",
        "evidence": "fresh failure after unverified stale auto-close",
        "delivery": {"attempts": 1, "status": "queued"},
    }


def test_autoclose_digest_is_truthful_not_self_healed(tmp_path):
    mod = _load(tmp_path)
    now = int(time.time())
    key = "host-a|bot-errors-health|daily-health-fail:instance-x"
    _write_state(mod, {key: _quiet_drift_record(now)})
    sends = _capture_sends(mod)

    sent, failed, err = mod.sweep_stale_incidents(mod.state_paths())

    assert sent == 0 and failed == 0 and err is None
    assert len(sends) == 1
    digest = sends[0]
    # Truthful: must NOT assert the incident self-healed.
    assert "self-healed" not in digest.lower()
    # Truthful: must state recovery was not verified and that it reopens if real.
    assert "unverified" in digest.lower()
    assert "reopen" in digest.lower()
    # Still terminally removed (safety valve intact).
    assert key not in json.loads(
        (mod.state_paths()["incident_state"]).read_text()
    )["openIncidents"]


def test_autoclose_dispatch_log_reason_is_not_self_healed(tmp_path):
    mod = _load(tmp_path)
    now = int(time.time())
    key = "host-a|bot-errors-health|daily-health-fail:instance-x"
    _write_state(mod, {key: _quiet_drift_record(now)})
    _capture_sends(mod)

    mod.sweep_stale_incidents(mod.state_paths())

    log_path = mod.state_paths()["logs"] / "dispatch.jsonl"
    lines = [json.loads(l) for l in log_path.read_text().splitlines() if l.strip()]
    suppressed = [r for r in lines if r.get("type") == "stale_renotify_suppressed"]
    assert suppressed, "expected a stale_renotify_suppressed dispatch-log entry"
    # The reason code must no longer assert self-healing.
    assert all("self_healed" not in str(r.get("reason", "")) for r in suppressed)


# ---------------------------------------------------------------------------
# A2: liveness-gated resolve — do NOT auto-close a daily-health incident as
# aged-out while that machine's own daily-health MONITORING is itself stale
# (§10 C2: collector/monitoring silence != recovery). The dispatcher already
# tracks the heartbeat-watchdog daily_health staleness incident in its own
# state, so the signal needs no new coupling.
# ---------------------------------------------------------------------------

def test_held_when_monitoring_is_down(tmp_path):
    mod = _load(tmp_path)
    now = int(time.time())
    drift_key = "host-a|bot-errors-health|daily-health-fail:instance-x"
    # heartbeat-watchdog says host-a's own daily-health cadence is stale -> the
    # monitoring path that would emit a FRESH failure for instance-x is down.
    monitor_key = (
        "host-a|bot-errors-heartbeat-watchdog|heartbeat-watchdog:daily_health:host-a"
    )
    _write_state(mod, {
        drift_key: _quiet_drift_record(now),
        monitor_key: {
            "status": "open",
            "openedAt": now - 3600,
            "lastSeenAt": now - 60,
            "lastSummary": "daily-health cadence stale for host-a",
        },
    })
    sends = _capture_sends(mod)

    sent, failed, err = mod.sweep_stale_incidents(mod.state_paths())

    assert sent == 0 and failed == 0 and err is None
    # No auto-close digest while monitoring is down.
    assert sends == []
    # The drift incident is HELD (not removed) because silence is uninformative.
    open_now = json.loads((mod.state_paths()["incident_state"]).read_text())["openIncidents"]
    assert drift_key in open_now
    # It is still suppressed (no spam) but marked held-for-liveness, not closed.
    rec = open_now[drift_key]
    assert rec.get("staleSuppressed") is True


def test_gate_off_closes_even_when_monitoring_down(tmp_path):
    mod = _load(tmp_path, {"BOT_ERRORS_AUTOCLOSE_LIVENESS_GATE": "0"})
    now = int(time.time())
    drift_key = "host-a|bot-errors-health|daily-health-fail:instance-x"
    monitor_key = (
        "host-a|bot-errors-heartbeat-watchdog|heartbeat-watchdog:daily_health:host-a"
    )
    _write_state(mod, {
        drift_key: _quiet_drift_record(now),
        monitor_key: {"status": "open", "openedAt": now - 3600, "lastSeenAt": now - 60},
    })
    sends = _capture_sends(mod)

    mod.sweep_stale_incidents(mod.state_paths())

    # Gate off -> legacy behavior: aged-out incident is closed regardless.
    open_now = json.loads((mod.state_paths()["incident_state"]).read_text())["openIncidents"]
    assert drift_key not in open_now


def test_autoclose_records_reopen_history_for_promotion_backstop(tmp_path):
    mod = _load(tmp_path, {"BOT_ERRORS_AUTOCLOSE_REOPEN_WINDOW_SECONDS": str(30 * 86400)})
    now = int(time.time())
    key = "host-a|bot-errors-health|daily-health-fail:instance-x"
    _write_state(mod, {key: _quiet_drift_record(now)})
    _capture_sends(mod)

    mod.sweep_stale_incidents(mod.state_paths())
    state = json.loads((mod.state_paths()["incident_state"]).read_text())
    history = state["staleAutocloseHistory"][key]
    assert history["reason"] == "nonactionable_aged_out_unverified"
    assert history["closedAt"] > 0

    mod.mark_incident_sent(_alert_for_key(key), state)

    metrics = state["promotionSafety"]
    assert metrics["autoCloseThenReopenCount"] == 1
    assert metrics["lastAutoCloseThenReopen"]["incidentKey"] == key
    assert metrics["lastAutoCloseThenReopen"]["secondsSinceAutoclose"] >= 0
    reopened = state["openIncidents"][key]
    assert reopened["autoCloseReopened"] is True
    assert reopened["autoCloseReopenCount"] == 1


def test_autoclose_reopen_history_expires_outside_window(tmp_path):
    mod = _load(tmp_path, {"BOT_ERRORS_AUTOCLOSE_REOPEN_WINDOW_SECONDS": "60"})
    key = "host-a|bot-errors-health|daily-health-fail:instance-x"
    state = {
        "version": 1,
        "openIncidents": {},
        "lastSentAt": {},
        "staleAutocloseHistory": {
            key: {
                "closedAt": int(time.time()) - 3600,
                "reason": "nonactionable_aged_out_unverified",
            },
        },
    }

    mod.mark_incident_sent(_alert_for_key(key), state)

    assert "promotionSafety" not in state
    assert state["openIncidents"][key].get("autoCloseReopened") is not True
    assert key not in state.get("staleAutocloseHistory", {})


@pytest.mark.parametrize("source", ["whatsapp_device_bond_lost", "instance_logged_out"])
def test_bond_lost_family_is_not_unverified_autoclosed_even_if_suppression_config_matches(
    tmp_path,
    source: str,
):
    mod = _load(tmp_path, {"BOT_ERRORS_STALE_RENOTIFY_SUPPRESS_SOURCES": source})
    now = int(time.time())
    key = f"host-a|instance-x|{source}"
    _write_state(mod, {
        key: {
            "status": "stale",
            "openedAt": now - 10 * 86400,
            "lastSeenAt": now - 8 * 86400,
            "lastSummary": f"{source} still requires confirmation",
        },
    })
    sends = _capture_sends(mod)

    sent, failed, err = mod.sweep_stale_incidents(mod.state_paths())

    assert sent == 1 and failed == 0 and err is None
    assert sends, "protected source should renotify instead of silently auto-closing"
    state = json.loads((mod.state_paths()["incident_state"]).read_text())
    assert key in state["openIncidents"]
    assert key not in state.get("staleAutocloseHistory", {})
