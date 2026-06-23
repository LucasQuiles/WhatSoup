"""Tests for Pattern A (open variant) — suppress the periodic still-open
renotify / age-escalation for non-actionable sources while the incident is live.

The stale variant (test_bot_errors_f11_stale_suppression) only fires once an
incident goes quiet. But a runtime-tool-error:* bucket re-arms on every fresh
self-corrected tool failure, so it never goes stale — it stays `open` and the 6h
"still open" renotify (plus age-based escalation) re-pages it forever with no
remediation behind it. This open-variant gate absorbs those fresh occurrences
silently (audit counter preserved) while leaving flap-storm — the genuine
stuck-agent signal, evaluated earlier via force_notify_level — fully intact.
Fail-open: any classifier error falls through to send.
"""
from __future__ import annotations

import importlib.util
import os
import time
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_SUPPRESS_OPEN_NONACTIONABLE_RENOTIFY",
    "BOT_ERRORS_INCIDENT_RENOTIFY_SECONDS",
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
    for k, v in (extra_env or {}).items():
        os.environ[k] = v
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location("bot_errors_open_renotify", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_MACHINE = "host-a"
_INSTANCE = "instance-x"


def _alert(source: str, *, severity: str = "warning") -> dict:
    return {
        "schemaVersion": 1,
        "id": f"evt-{source}",
        "eventType": "alert",
        "severity": severity,
        "machine": _MACHINE,
        "instance": _INSTANCE,
        "source": source,
        "summary": f"summary for {source}",
        "evidence": f"evidence for {source}",
    }


def _state_with_open(mod, event: dict, *, last_notified_age: int, record_extra: dict | None = None) -> tuple[dict, str]:
    """One OPEN incident keyed for the event, last notified `last_notified_age`s ago."""
    key = mod.incident_key(event)
    now = int(time.time())
    record = {
        "status": "open",
        "openedAt": now - 5 * 86400,
        "openedIso": "2026-06-13T00:00:00Z",
        "lastNotifiedAt": now - last_notified_age,
        "suppressedCount": 7,
    }
    record.update(record_extra or {})
    return {"version": 1, "openIncidents": {key: record}, "lastSentAt": {}}, key


# ---------------------------------------------------------------------------
# T1: open runtime-tool-error past the renotify cadence is suppressed (not
#     re-paged), the audit counter increments, and lastNotifiedAt is NOT bumped.
# ---------------------------------------------------------------------------

def test_open_tool_error_renotify_suppressed(tmp_path):
    mod = _load(tmp_path)
    evt = _alert("runtime-tool-error:provider-cli:Shell")
    # 7h since last notify > 6h default cadence -> renotify branch reached.
    state, key = _state_with_open(mod, evt, last_notified_age=7 * 3600)
    before = state["openIncidents"][key]["lastNotifiedAt"]

    reason = mod.should_suppress_send(evt, state)

    assert reason is not None
    assert "open renotify suppressed" in reason
    rec = state["openIncidents"][key]
    assert rec["openRenotifySuppressedCount"] == 1
    # not re-paged: the notify clock is untouched
    assert rec["lastNotifiedAt"] == before


# ---------------------------------------------------------------------------
# T2: an ACTIONABLE open incident (real physical action) past the cadence still
#     renotifies — the gate must not over-broadly silence real standing work.
# ---------------------------------------------------------------------------

def test_open_actionable_incident_still_renotifies(tmp_path):
    mod = _load(tmp_path)
    evt = _alert("whatsapp_device_bond_lost", severity="critical")
    state, key = _state_with_open(
        mod, evt, last_notified_age=7 * 3600,
        record_extra={"failureCode": "DEVICE_BOND_LOST", "recoverability": "manual_relink_required"},
    )

    reason = mod.should_suppress_send(evt, state)

    assert reason is None  # falls through to send (renotify)
    rec = state["openIncidents"][key]
    assert "openRenotifySuppressedCount" not in rec
    assert rec["renotifyCount"] == 1  # real renotify happened


# ---------------------------------------------------------------------------
# T3: flap_storm is EXEMPT — a genuinely stuck source still escalates and is
#     never silenced by the open-variant gate.
# ---------------------------------------------------------------------------

def test_flap_storm_source_not_suppressed(tmp_path):
    mod = _load(tmp_path)
    evt = _alert("flap_storm", severity="critical")
    state, key = _state_with_open(mod, evt, last_notified_age=7 * 3600)

    reason = mod.should_suppress_send(evt, state)

    assert reason is None  # not suppressed
    assert "openRenotifySuppressedCount" not in state["openIncidents"][key]


# ---------------------------------------------------------------------------
# T4: kill-switch off -> a tool-error open incident renotifies as before
#     (legacy behavior preserved for rollback).
# ---------------------------------------------------------------------------

def test_gate_off_tool_error_renotifies(tmp_path):
    mod = _load(tmp_path, {"BOT_ERRORS_SUPPRESS_OPEN_NONACTIONABLE_RENOTIFY": "0"})
    evt = _alert("runtime-tool-error:provider-cli:Shell")
    state, key = _state_with_open(mod, evt, last_notified_age=7 * 3600)

    reason = mod.should_suppress_send(evt, state)

    assert reason is None  # gate off -> legacy renotify
    assert state["openIncidents"][key]["renotifyCount"] == 1


# ---------------------------------------------------------------------------
# T5: a tool-error still WITHIN the renotify cadence is a plain duplicate-
#     suppressed (the open-variant gate only governs the renotify boundary).
# ---------------------------------------------------------------------------

def test_open_tool_error_within_cadence_is_plain_duplicate(tmp_path):
    mod = _load(tmp_path)
    evt = _alert("runtime-tool-error:provider-cli:Shell")
    state, key = _state_with_open(mod, evt, last_notified_age=600)  # 10m < 6h

    reason = mod.should_suppress_send(evt, state)

    assert reason is not None
    assert "duplicate suppressed" in reason
    assert "openRenotifySuppressedCount" not in state["openIncidents"][key]
