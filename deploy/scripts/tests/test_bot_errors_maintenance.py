"""Tests for Pattern B (Part 2) — maintenance-window CLI + dispatcher gate.

An operator declares a planned maintenance window for an instance; the
dispatcher then silences that instance's incident ALERTS (not crash-alerts)
for the window's duration. CLEAR events still flow so a recovery during
maintenance closes the incident. State lives in ``maintenance.json`` under the
dispatcher's state directory (``BOT_ERRORS_STATE_DIR`` honored), keyed by
``machine|instance``. FAIL-OPEN on missing/corrupt state and when the gate is
disabled.

Covered:
- CLI open writes a window; list shows it; close removes it (atomic JSON).
- duration parser: 30m/2h/90s/1d parse; non-positive/garbage reject; clamp.
- dispatcher: alert within an active window -> suppressed + tagged.
- dispatcher: alert for a DIFFERENT instance (no window) -> NOT suppressed.
- dispatcher: CLEAR during an active window -> NOT suppressed (recovery flows).
- expired window -> NOT suppressed (dropped at read time).
- gate off (BOT_ERRORS_MAINTENANCE_WINDOWS=0) -> alert flows.
- corrupt maintenance.json -> treated empty (fail-open).
- per-machine scoping: host-a|inst-a does not silence host-b|inst-a.

Neutral fixtures only: machines host-a/host-b, instances inst-a/inst-b.
"""
from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"
_CLI = Path(__file__).resolve().parents[1] / "bot-errors-maintenance.py"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_MAINTENANCE_WINDOWS",
    "BOT_ERRORS_SEND_DAILY_HEALTH_INFO",
    "BOT_ERRORS_INHIBITION_ENABLED",
]


@pytest.fixture(autouse=True)
def _clean_env(tmp_path):
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    for k in _ENV_KEYS:
        os.environ.pop(k, None)
    # Point both the dispatcher and the CLI at an isolated state dir.
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _load_dispatcher():
    spec = importlib.util.spec_from_file_location("bot_errors_maint_dispatcher", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _load_cli():
    spec = importlib.util.spec_from_file_location("bot_errors_maintenance_cli", _CLI)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_MACHINE = "host-a"
_INSTANCE = "inst-a"


def _alert(source: str = "instance_logged_out", *, machine: str = _MACHINE, instance: str = _INSTANCE) -> dict:
    return {
        "schemaVersion": 1,
        "id": f"evt-{source}",
        "eventType": "alert",
        "severity": "critical",
        "machine": machine,
        "instance": instance,
        "source": source,
        "summary": f"summary for {source}",
        "evidence": f"evidence for {source}",
    }


def _clear(source: str = "instance_logged_out", *, machine: str = _MACHINE, instance: str = _INSTANCE) -> dict:
    evt = _alert(source, machine=machine, instance=instance)
    evt["eventType"] = "clear"
    return evt


def _empty_state() -> dict:
    return {"version": 1, "openIncidents": {}, "lastSentAt": {}}


def _write_window(tmp_path: Path, *, machine: str, instance: str, expires_at: int, reason: str | None = None) -> None:
    record = {"openedAt": int(time.time()), "expiresAt": expires_at}
    if reason is not None:
        record["reason"] = reason
    path = tmp_path / "maintenance.json"
    path.write_text(json.dumps({f"{machine}|{instance}": record}), encoding="utf-8")


# ---------------------------------------------------------------------------
# CLI: open / list / close round-trip
# ---------------------------------------------------------------------------

def test_cli_open_writes_window(tmp_path):
    cli = _load_cli()
    rc = cli.main(["open", _INSTANCE, "30m", "--machine", _MACHINE, "--reason", "deploy"])
    assert rc == 0

    state_file = tmp_path / "maintenance.json"
    assert state_file.exists()
    data = json.loads(state_file.read_text())
    key = f"{_MACHINE}|{_INSTANCE}"
    assert key in data
    assert data[key]["reason"] == "deploy"
    assert data[key]["expiresAt"] > data[key]["openedAt"]


def test_cli_list_shows_active_window(tmp_path, capsys):
    cli = _load_cli()
    cli.main(["open", _INSTANCE, "1h", "--machine", _MACHINE])
    capsys.readouterr()
    cli.main(["list"])
    out = capsys.readouterr().out
    listed = json.loads(out)
    assert f"{_MACHINE}|{_INSTANCE}" in listed


def test_cli_close_removes_window(tmp_path):
    cli = _load_cli()
    cli.main(["open", _INSTANCE, "1h", "--machine", _MACHINE])
    rc = cli.main(["close", _INSTANCE, "--machine", _MACHINE])
    assert rc == 0

    data = json.loads((tmp_path / "maintenance.json").read_text())
    assert f"{_MACHINE}|{_INSTANCE}" not in data


def test_cli_list_drops_expired_window(tmp_path, capsys):
    cli = _load_cli()
    _write_window(tmp_path, machine=_MACHINE, instance=_INSTANCE, expires_at=int(time.time()) - 5)
    cli.main(["list"])
    out = capsys.readouterr().out
    assert json.loads(out) == {}


# ---------------------------------------------------------------------------
# CLI: duration parser
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "text,expected",
    [("30m", 1800), ("2h", 7200), ("90s", 90), ("1d", 86400)],
)
def test_parse_duration_valid(text, expected):
    cli = _load_cli()
    assert cli.parse_duration(text) == expected


@pytest.mark.parametrize("text", ["0s", "0m", "-5m", "garbage", "", "10", "5x", "h"])
def test_parse_duration_rejects_bad(text):
    cli = _load_cli()
    with pytest.raises(ValueError):
        cli.parse_duration(text)


def test_parse_duration_clamps_at_max():
    cli = _load_cli()
    # 48h requested; clamp to the 24h ceiling.
    assert cli.parse_duration("48h") == cli.MAX_DURATION_SECONDS
    assert cli.parse_duration("2d") == cli.MAX_DURATION_SECONDS


# ---------------------------------------------------------------------------
# Dispatcher gate: alert within active window suppressed + tagged
# ---------------------------------------------------------------------------

def test_alert_in_active_window_suppressed_and_tagged(tmp_path):
    mod = _load_dispatcher()
    _write_window(
        tmp_path,
        machine=_MACHINE,
        instance=_INSTANCE,
        expires_at=int(time.time()) + 3600,
        reason="rolling restart",
    )
    event = _alert()
    reason = mod.should_suppress_send(event, _empty_state())

    assert reason is not None
    assert reason.startswith("maintenance_silenced:")
    assert "rolling restart" in reason
    assert event["diagnostics"]["maintenanceSilenced"] is True


def test_alert_in_window_without_reason_still_suppressed(tmp_path):
    mod = _load_dispatcher()
    _write_window(tmp_path, machine=_MACHINE, instance=_INSTANCE, expires_at=int(time.time()) + 3600)
    reason = mod.should_suppress_send(_alert(), _empty_state())
    assert reason is not None
    assert reason.startswith("maintenance_silenced:")


# ---------------------------------------------------------------------------
# Dispatcher gate: different instance not covered
# ---------------------------------------------------------------------------

def test_alert_for_different_instance_not_suppressed(tmp_path):
    mod = _load_dispatcher()
    _write_window(tmp_path, machine=_MACHINE, instance=_INSTANCE, expires_at=int(time.time()) + 3600)
    other = _alert(instance="inst-b")
    assert mod.active_maintenance_window(other) is None
    # No window for inst-b; first-sight alert is not maintenance-silenced.
    reason = mod.should_suppress_send(other, _empty_state())
    assert reason is None or not reason.startswith("maintenance_silenced:")


# ---------------------------------------------------------------------------
# Dispatcher gate: CLEAR during a window still flows
# ---------------------------------------------------------------------------

def test_clear_during_window_not_suppressed(tmp_path):
    mod = _load_dispatcher()
    _write_window(tmp_path, machine=_MACHINE, instance=_INSTANCE, expires_at=int(time.time()) + 3600)
    clear = _clear()
    assert mod.active_maintenance_window(clear) is not None  # window covers the scope
    reason = mod.should_suppress_send(clear, _empty_state())
    # A clear must never be maintenance-silenced (recovery still closes incident).
    assert reason is None or not reason.startswith("maintenance_silenced:")
    assert "maintenanceSilenced" not in clear.get("diagnostics", {})


# ---------------------------------------------------------------------------
# Expired window not suppressed
# ---------------------------------------------------------------------------

def test_expired_window_not_suppressed(tmp_path):
    mod = _load_dispatcher()
    _write_window(tmp_path, machine=_MACHINE, instance=_INSTANCE, expires_at=int(time.time()) - 10)
    assert mod.active_maintenance_window(_alert()) is None
    reason = mod.should_suppress_send(_alert(), _empty_state())
    assert reason is None or not reason.startswith("maintenance_silenced:")


# ---------------------------------------------------------------------------
# Gate off restores prior behavior (fail-open)
# ---------------------------------------------------------------------------

def test_gate_off_disables_maintenance_silencing(tmp_path):
    os.environ["BOT_ERRORS_MAINTENANCE_WINDOWS"] = "0"
    mod = _load_dispatcher()
    assert mod.MAINTENANCE_ENABLED is False
    _write_window(tmp_path, machine=_MACHINE, instance=_INSTANCE, expires_at=int(time.time()) + 3600)
    # The window IS active — only the disabled gate flag should stop suppression,
    # proving the flag (not an absent window) is what restores prior behavior.
    assert mod.active_maintenance_window(_alert()) is not None
    reason = mod.should_suppress_send(_alert(), _empty_state())
    assert reason is None or not reason.startswith("maintenance_silenced:")


# ---------------------------------------------------------------------------
# Corrupt maintenance.json -> fail-open
# ---------------------------------------------------------------------------

def test_corrupt_state_treated_empty(tmp_path):
    mod = _load_dispatcher()
    (tmp_path / "maintenance.json").write_text("{not valid json", encoding="utf-8")
    assert mod._load_maintenance_windows() == {}
    assert mod.active_maintenance_window(_alert()) is None
    reason = mod.should_suppress_send(_alert(), _empty_state())
    if reason is not None:
        assert not reason.startswith("maintenance_silenced:")


def test_non_dict_state_treated_empty(tmp_path):
    mod = _load_dispatcher()
    (tmp_path / "maintenance.json").write_text("[1, 2, 3]", encoding="utf-8")
    assert mod._load_maintenance_windows() == {}


def test_missing_state_treated_empty(tmp_path):
    mod = _load_dispatcher()
    # No file written.
    assert mod._load_maintenance_windows() == {}
    assert mod.active_maintenance_window(_alert()) is None


# ---------------------------------------------------------------------------
# Per-machine scoping
# ---------------------------------------------------------------------------

def test_window_for_host_a_does_not_silence_host_b(tmp_path):
    mod = _load_dispatcher()
    _write_window(tmp_path, machine="host-a", instance="inst-a", expires_at=int(time.time()) + 3600)
    # Same instance label, different machine -> not covered.
    other_machine = _alert(machine="host-b", instance="inst-a")
    assert mod.active_maintenance_window(other_machine) is None
    # And the matching machine IS covered (sanity: scoping is the only diff).
    same = _alert(machine="host-a", instance="inst-a")
    assert mod.active_maintenance_window(same) is not None
