"""Regression tests for heartbeat watchdog auth-loss classification."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace


_SCRIPT_ROOT = Path(__file__).resolve().parents[1]


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_heartbeat_watchdog",
        _SCRIPT_ROOT / "bot-errors-heartbeat-watchdog.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _watchdog_args(max_fleet_sentinel_age: int = 60):
    return SimpleNamespace(
        max_q_loop_age=600,
        max_dispatcher_age=300,
        max_collector_age=180,
        max_daily_health_age=25 * 60 * 60,
        max_fleet_sentinel_age=max_fleet_sentinel_age,
    )


def _private_state(monkeypatch, mod, tmp_path: Path) -> Path:
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state))
    monkeypatch.setenv("BOT_ERRORS_WATCHDOG_CHECKS", "fleet_sentinel")
    monkeypatch.setenv("BOT_ERRORS_DRY_NOW", "1000")
    return state


def test_fleet_sentinel_heartbeat_check_is_quiet_when_fresh(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _private_state(monkeypatch, mod, tmp_path)
    heartbeat = state / "fleet-sentinel" / "sentinel-heartbeat.json"
    mod.atomic_write_json(
        heartbeat,
        {
            "schemaVersion": 1,
            "kind": "bot-errors-sentinel-heartbeat",
            "checkedAt": "1970-01-01T00:16:20Z",
            "healthy": True,
            "fleetAction": "none",
            "hostCount": 9,
        },
    )

    assert mod.collect_problems(_watchdog_args(), {"fleet_sentinel"}) == {}


def test_fleet_sentinel_heartbeat_check_flags_stale_and_writes_deadman_event(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _private_state(monkeypatch, mod, tmp_path)
    outbox = tmp_path / "outbox"
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(outbox))
    heartbeat = state / "fleet-sentinel" / "sentinel-heartbeat.json"
    mod.atomic_write_json(
        heartbeat,
        {
            "schemaVersion": 1,
            "kind": "bot-errors-sentinel-heartbeat",
            "checkedAt": "1970-01-01T00:00:00Z",
            "healthy": True,
            "fleetAction": "none",
            "hostCount": 9,
        },
    )

    result = mod.run_once(_watchdog_args())

    assert result == 0
    events = list(outbox.glob("*.json"))
    assert len(events) == 1
    event = json.loads(events[0].read_text(encoding="utf-8"))
    assert event["alertSource"] == "fleet_sentinel"
    assert event["severity"] == "critical"
    assert "fleet sentinel heartbeat stale" in event["evidence"]
    assert "sentinel-heartbeat.json" in event["evidence"]


def test_local_instance_health_flags_terminal_auth_class_as_physical_intervention(
    tmp_path: Path,
    monkeypatch,
):
    mod = _load_module()
    profile = tmp_path / "profile.json"
    profile.write_text(
        json.dumps(
            {
                "instances": [
                    {
                        "name": "line-alpha",
                        "service": "whatsoup-line-alpha.service",
                        "expected": "always_on",
                        "healthPort": 3201,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(profile))
    monkeypatch.setenv(
        "BOT_ERRORS_DRY_LOCAL_HEALTH_RESPONSES",
        json.dumps(
            {
                "line-alpha": {
                    "status": 200,
                    "json": {
                        "status": "healthy",
                        "instance": {"name": "line-alpha"},
                        "whatsapp": {
                            "connected": False,
                            "connection": {
                                "state": "disconnected",
                                "last_status_code": 515,
                                "last_disconnect_reason": "restartRequired",
                                "auth_failure_class": "Pairing_Required",
                            },
                            "auth_bond": {"status": "present", "issues": []},
                        },
                    },
                }
            }
        ),
    )

    problems = mod.local_instance_health_problems()

    detail = problems["local_health:line-alpha"]
    assert "auth_failure_class=Pairing_Required" in detail
    assert "physical_intervention_required=terminal_auth_failure_class" in detail


def test_terminal_auth_failure_class_inventory_matches_dispatcher_and_health_check():
    mod = _load_module()

    assert mod.TERMINAL_AUTH_FAILURE_CLASSES == {
        "pairing_required",
        "serverside_logout_irreversible",
    }
