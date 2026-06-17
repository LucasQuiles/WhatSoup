"""Tests for F11 (Pattern A — suppress non-actionable stale renotify).

Design: docs/superpowers/specs/2026-06-16-bot-errors-noise-reduction-design.md
§3 Pattern A + §10 C4/C5.

A self-healed / no-op stale incident (derived requested_action == the
non-actionable sentinel, or a recovery/no-op source signature) must NOT be
re-pushed to WhatsApp. It is tagged + counted in state (audit preserved) and,
once past the escalate horizon, terminally removed from openIncidents and
reported ONCE in a consolidated auto-close summary. Actionable stale incidents
(real operator/physical action) still renotify. The whole gate is fail-open.
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
    "BOT_ERRORS_STALE_RENOTIFY_SUPPRESS_SOURCES",
    "BOT_ERRORS_INCIDENT_STALE_SECONDS",
    "BOT_ERRORS_INCIDENT_ESCALATE_SECONDS",
    "BOT_ERRORS_INCIDENT_STALE_RENOTIFY_SECONDS",
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
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_f11", _SCRIPT)
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


def _open_incidents(mod) -> dict:
    path = mod.state_paths()["incident_state"]
    return json.loads(path.read_text())["openIncidents"]


# ---------------------------------------------------------------------------
# T1: non-actionable stale (action none), past escalate -> suppressed + auto-closed
# ---------------------------------------------------------------------------

def test_nonactionable_stale_is_suppressed_and_autoclosed(tmp_path):
    mod = _load(tmp_path)
    now = int(time.time())
    key = "host-a|instance-x|runtime-agent-failure:claude-cli:provider_auth_required"
    _write_state(mod, {
        key: {
            "status": "stale",
            "openedAt": now - 10 * 86400,
            "openedIso": "2026-06-07T00:00:00Z",
            "lastSeenAt": now - 8 * 86400,
            "lastSeenIso": "2026-06-09T00:00:00Z",
            "lastSummary": "Agent runtime failure: provider_auth_required",
            "suppressedCount": 11,
        },
    })
    sends = _capture_sends(mod)
    sent, failed, err = mod.sweep_stale_incidents(mod.state_paths())

    assert sent == 0 and failed == 0 and err is None
    # exactly one consolidated auto-close summary, no per-incident renotify
    assert len(sends) == 1
    assert "Auto-closed" in sends[0]
    assert "none — informational" in sends[0]
    # incident terminally removed from open state
    assert key not in _open_incidents(mod)


# ---------------------------------------------------------------------------
# T2: non-actionable stale, NOT yet past escalate -> suppressed, kept, no send
# ---------------------------------------------------------------------------

def test_nonactionable_stale_below_escalate_suppressed_not_closed(tmp_path):
    mod = _load(tmp_path, {
        "BOT_ERRORS_INCIDENT_STALE_SECONDS": "86400",       # 1d stale gate
        "BOT_ERRORS_INCIDENT_ESCALATE_SECONDS": "2592000",  # 30d escalate horizon
    })
    now = int(time.time())
    key = "host-a|instance-x|some_quiet_source"
    _write_state(mod, {
        key: {
            "status": "stale",
            "openedAt": now - 2 * 86400,
            "lastSeenAt": now - 2 * 86400,
            "lastSummary": "quiet source",
        },
    })
    sends = _capture_sends(mod)
    sent, failed, err = mod.sweep_stale_incidents(mod.state_paths())

    assert sent == 0 and failed == 0
    assert sends == []  # nothing pushed
    record = _open_incidents(mod)[key]  # still present
    assert record.get("staleSuppressed") is True
    assert record.get("staleSuppressedCount") == 1


# ---------------------------------------------------------------------------
# T3: actionable stale (real operator action) still renotifies
# ---------------------------------------------------------------------------

def test_actionable_stale_still_sent(tmp_path):
    mod = _load(tmp_path)
    now = int(time.time())
    key = "host-a|instance-x|whatsapp_device_bond_lost"
    _write_state(mod, {
        key: {
            "status": "awaiting_physical",
            "openedAt": now - 10 * 86400,
            "lastSeenAt": now - 8 * 86400,
            "lastSummary": "device bond lost",
            "failureCode": "DEVICE_BOND_LOST",
            "recoverability": "manual_relink_required",
            "assetKind": "whatsapp_linked_device",
        },
    })
    sends = _capture_sends(mod)
    sent, failed, err = mod.sweep_stale_incidents(mod.state_paths())

    assert sent == 1 and failed == 0
    assert len(sends) == 1
    assert "Auto-closed" not in sends[0]
    assert "none — informational" not in sends[0]
    assert key in _open_incidents(mod)  # not removed


# ---------------------------------------------------------------------------
# T4: gate off -> non-actionable stale is sent (legacy behavior)
# ---------------------------------------------------------------------------

def test_gate_off_sends_nonactionable_stale(tmp_path):
    mod = _load(tmp_path, {"BOT_ERRORS_SUPPRESS_STALE_INFO_RENOTIFY": "0"})
    now = int(time.time())
    key = "host-a|instance-x|runtime-agent-failure:claude-cli:provider_auth_required"
    _write_state(mod, {
        key: {
            "status": "stale",
            "openedAt": now - 10 * 86400,
            "lastSeenAt": now - 8 * 86400,
            "lastSummary": "runtime failure",
        },
    })
    sends = _capture_sends(mod)
    sent, failed, err = mod.sweep_stale_incidents(mod.state_paths())

    assert sent == 1
    assert len(sends) == 1
    assert "Auto-closed" not in sends[0]


# ---------------------------------------------------------------------------
# T5: fail-open -> classifier raising falls through to send
# ---------------------------------------------------------------------------

def test_fail_open_on_classifier_error(tmp_path):
    mod = _load(tmp_path)

    def _boom(event, key):
        raise RuntimeError("classifier blew up")

    mod.stale_renotify_is_nonactionable = _boom  # type: ignore[assignment]
    now = int(time.time())
    key = "host-a|instance-x|runtime-agent-failure:claude-cli:provider_auth_required"
    _write_state(mod, {
        key: {
            "status": "stale",
            "openedAt": now - 10 * 86400,
            "lastSeenAt": now - 8 * 86400,
            "lastSummary": "runtime failure",
        },
    })
    sends = _capture_sends(mod)
    sent, failed, err = mod.sweep_stale_incidents(mod.state_paths())

    assert sent == 1  # fell through to send despite classifier error
    assert key in _open_incidents(mod)
