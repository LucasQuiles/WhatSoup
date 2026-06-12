"""Regression tests for heartbeat watchdog auth-loss classification."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path


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
