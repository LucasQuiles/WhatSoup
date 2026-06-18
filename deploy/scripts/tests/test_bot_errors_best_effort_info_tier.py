"""Tests for Pattern I — best-effort remote failures are info-tier, never page.

An operator declares ``--best-effort-remote <host>`` to mark a host that is
EXPECTED to go offline (e.g. a laptop that sleeps). Such a host going down is a
planned/expected condition, not a crash. Before Pattern I, ``is_best_effort``
only adjusted aggregate rollup counters — the per-remote ``relay_host_down``
(warning page) and pre-threshold ``remote-claim-failed`` (critical) still paged.

Pattern I downgrades those per-remote failure events to ``info`` for best-effort
hosts so they surface in the digest without paging. The gate
``BOT_ERRORS_BEST_EFFORT_INFO_TIER`` (default on) fails open: gate off → prior
warning/critical behavior. Non-best-effort hosts are unaffected. Recovery events
were already info and stay info.

Neutral fixtures only: hosts host-a / peer-flaky.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from typing import Any

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-collector.py"

_GATE = "BOT_ERRORS_BEST_EFFORT_INFO_TIER"
_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_OUTBOX_DIR",
    "BOT_ERRORS_TAILSCALE_STATUS_COMMAND",
    _GATE,
]


@pytest.fixture(autouse=True)
def _clean_env(tmp_path):
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    for k in _ENV_KEYS:
        os.environ.pop(k, None)
    state_dir = tmp_path / "bot-errors"
    outbox_dir = tmp_path / "outbox"
    state_dir.mkdir(mode=0o700)
    outbox_dir.mkdir(mode=0o700)
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    os.environ["BOT_ERRORS_OUTBOX_DIR"] = str(outbox_dir)
    os.environ["BOT_ERRORS_TAILSCALE_STATUS_COMMAND"] = ""
    yield state_dir, outbox_dir
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_collector_be", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _events(outbox_dir: Path, source: str | None = None) -> list[dict[str, Any]]:
    out = []
    for p in sorted(outbox_dir.glob("*.json")):
        try:
            ev = json.loads(p.read_text())
        except Exception:
            continue
        if source is None or ev.get("source") == source:
            out.append(ev)
    return out


# ---------------------------------------------------------------------------
# gate helper
# ---------------------------------------------------------------------------

def test_gate_default_on():
    mod = _load()
    assert mod.best_effort_info_tier_enabled() is True


@pytest.mark.parametrize("val", ["0", "false", "no", "off", "OFF", "False"])
def test_gate_off_values(val):
    os.environ[_GATE] = val
    mod = _load()
    assert mod.best_effort_info_tier_enabled() is False


# ---------------------------------------------------------------------------
# emit_relay_host_state_event — relay_host_down severity
# ---------------------------------------------------------------------------

def test_relay_host_down_best_effort_is_info(_clean_env):
    _state_dir, outbox_dir = _clean_env
    mod = _load()
    mod.emit_relay_host_state_event("peer-flaky", "relay_host_down", "remote=peer-flaky", {}, best_effort=True)
    evs = _events(outbox_dir, "relay_host_down")
    assert len(evs) == 1
    assert evs[0]["severity"] == "info"


def test_relay_host_down_non_best_effort_is_warning(_clean_env):
    _state_dir, outbox_dir = _clean_env
    mod = _load()
    mod.emit_relay_host_state_event("host-a", "relay_host_down", "remote=host-a", {}, best_effort=False)
    evs = _events(outbox_dir, "relay_host_down")
    assert len(evs) == 1
    assert evs[0]["severity"] == "warning"


def test_relay_host_down_default_param_is_warning(_clean_env):
    # best_effort defaults False — callers that don't opt in keep prior behavior.
    _state_dir, outbox_dir = _clean_env
    mod = _load()
    mod.emit_relay_host_state_event("host-a", "relay_host_down", "remote=host-a", {})
    assert _events(outbox_dir, "relay_host_down")[0]["severity"] == "warning"


def test_relay_host_down_gate_off_stays_warning_even_best_effort(_clean_env):
    _state_dir, outbox_dir = _clean_env
    os.environ[_GATE] = "0"
    mod = _load()
    mod.emit_relay_host_state_event("peer-flaky", "relay_host_down", "remote=peer-flaky", {}, best_effort=True)
    assert _events(outbox_dir, "relay_host_down")[0]["severity"] == "warning"


def test_relay_host_recovered_always_info(_clean_env):
    # Recovery is info regardless of best_effort — never a page either way.
    _state_dir, outbox_dir = _clean_env
    mod = _load()
    mod.emit_relay_host_state_event("host-a", "relay_host_recovered", "remote=host-a", {}, best_effort=False)
    mod.emit_relay_host_state_event("peer-flaky", "relay_host_recovered", "remote=peer-flaky", {}, best_effort=True)
    evs = _events(outbox_dir, "relay_host_recovered")
    assert len(evs) == 2
    assert all(e["severity"] == "info" for e in evs)


# ---------------------------------------------------------------------------
# enqueue_meta_alert — fresh alert severity
# ---------------------------------------------------------------------------

def _enqueue(mod, state, *, best_effort):
    mod.enqueue_meta_alert(
        "peer-flaky" if best_effort else "host-a",
        "remote-claim-failed",
        "cannot claim remote outbox",
        "remote=x\nerror=timeout",
        state,
        900,
        None,
        best_effort=best_effort,
    )


def test_meta_alert_best_effort_is_info(_clean_env):
    _state_dir, outbox_dir = _clean_env
    mod = _load()
    _enqueue(mod, {}, best_effort=True)
    evs = _events(outbox_dir, "remote-claim-failed")
    assert len(evs) == 1
    assert evs[0]["severity"] == "info"


def test_meta_alert_non_best_effort_is_critical(_clean_env):
    _state_dir, outbox_dir = _clean_env
    mod = _load()
    _enqueue(mod, {}, best_effort=False)
    evs = _events(outbox_dir, "remote-claim-failed")
    assert len(evs) == 1
    assert evs[0]["severity"] == "critical"


def test_meta_alert_default_param_is_critical(_clean_env):
    _state_dir, outbox_dir = _clean_env
    mod = _load()
    mod.enqueue_meta_alert("host-a", "remote-claim-failed", "s", "e", {}, 900)
    assert _events(outbox_dir, "remote-claim-failed")[0]["severity"] == "critical"


def test_meta_alert_gate_off_stays_critical_even_best_effort(_clean_env):
    _state_dir, outbox_dir = _clean_env
    os.environ[_GATE] = "0"
    mod = _load()
    _enqueue(mod, {}, best_effort=True)
    assert _events(outbox_dir, "remote-claim-failed")[0]["severity"] == "critical"


def test_meta_alert_renotify_open_best_effort_is_info(_clean_env):
    # The still-open renotify path must also honor info-tier for best-effort.
    _state_dir, outbox_dir = _clean_env
    mod = _load()
    now = mod.alert_key  # touch to ensure module loaded
    assert callable(now)
    key = mod.alert_key("peer-flaky", "remote-claim-failed")
    # openedAt must be a truthy past epoch so the cooldown gate (current - last_notify
    # >= cooldown) opens and the still-open renotify actually fires. A 0 is falsy and
    # falls through to `current`, which would suppress the renotify.
    state: dict[str, Any] = {
        "alerts": {key: 1},
        "openAlerts": {
            key: {
                "status": "open",
                "eventId": "prior",
                "openedAt": 1,
                "openedIso": "1970-01-01T00:00:01Z",
                "lastSeenAt": 1,
                "suppressedCount": 0,
            }
        },
    }
    _enqueue(mod, state, best_effort=True)
    still_open = [e for e in _events(outbox_dir, "remote-claim-failed") if "still open" in e.get("summary", "")]
    assert len(still_open) == 1
    assert still_open[0]["severity"] == "info"
