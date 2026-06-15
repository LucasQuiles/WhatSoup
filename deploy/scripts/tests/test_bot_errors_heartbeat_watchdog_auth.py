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


def test_malformed_open_incident_counters_do_not_crash_reconcile(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _private_state(monkeypatch, mod, tmp_path)
    mod.atomic_write_json(
        state / "heartbeat-watchdog-state.json",
        {
            "version": 1,
            "open": {
                "fleet_sentinel": {
                    "firstSeenAt": "1970-01-01T00:00:00Z",
                    "lastNotifiedAt": "1970-01-01T00:16:00Z",
                    "ageSeconds": "bad",
                    "suppressed": "bad",
                    "lastEvidence": "prior evidence",
                }
            },
        },
    )

    written = mod.reconcile({"fleet_sentinel": "fleet sentinel heartbeat stale"}, ["fleet_sentinel"])

    assert written == []
    saved = json.loads((state / "heartbeat-watchdog-state.json").read_text(encoding="utf-8"))
    incident = saved["open"]["fleet_sentinel"]
    assert incident["suppressed"] == 1
    assert incident["ageSeconds"] == 1000
    assert incident["lastEvidence"] == "fleet sentinel heartbeat stale"


def test_malformed_open_incident_record_realerts_when_problem_persists(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _private_state(monkeypatch, mod, tmp_path)
    mod.atomic_write_json(
        state / "heartbeat-watchdog-state.json",
        {"version": 1, "open": {"fleet_sentinel": ["corrupt"]}},
    )

    written = mod.reconcile({"fleet_sentinel": "fleet sentinel heartbeat stale"}, ["fleet_sentinel"])

    assert len(written) == 1
    saved = json.loads((state / "heartbeat-watchdog-state.json").read_text(encoding="utf-8"))
    incident = saved["open"]["fleet_sentinel"]
    assert isinstance(incident, dict)
    assert incident["suppressed"] == 0
    assert incident["lastEvidence"] == "fleet sentinel heartbeat stale"


def test_malformed_recovery_counter_restarts_recovery_confirmation(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _private_state(monkeypatch, mod, tmp_path)
    mod.atomic_write_json(
        state / "heartbeat-watchdog-state.json",
        {
            "version": 1,
            "open": {
                "fleet_sentinel": {
                    "firstSeenAt": "1970-01-01T00:00:00Z",
                    "lastSeenAt": "1970-01-01T00:10:00Z",
                    "lastNotifiedAt": "1970-01-01T00:00:00Z",
                    "recoveryObservations": "bad",
                    "suppressed": 0,
                    "lastEvidence": "prior evidence",
                }
            },
        },
    )

    written = mod.reconcile({}, ["fleet_sentinel"])

    assert written == []
    saved = json.loads((state / "heartbeat-watchdog-state.json").read_text(encoding="utf-8"))
    assert saved["open"]["fleet_sentinel"]["recoveryObservations"] == 1


def test_malformed_open_incident_record_restarts_recovery_confirmation(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _private_state(monkeypatch, mod, tmp_path)
    mod.atomic_write_json(
        state / "heartbeat-watchdog-state.json",
        {"version": 1, "open": {"fleet_sentinel": ["corrupt"]}},
    )

    written = mod.reconcile({}, ["fleet_sentinel"])

    assert written == []
    saved = json.loads((state / "heartbeat-watchdog-state.json").read_text(encoding="utf-8"))
    incident = saved["open"]["fleet_sentinel"]
    assert isinstance(incident, dict)
    assert incident["recoveryObservations"] == 1


def test_dispatcher_heartbeat_critical_inspect_error_is_reported_not_crashed(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _private_state(monkeypatch, mod, tmp_path)
    target = state / "dispatcher-state.json"
    mod.atomic_write_json(target, {"updated_at": 1000})
    original_stat = Path.stat

    def stat(path: Path, *args, **kwargs):
        if path == target:
            raise PermissionError("denied")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", stat)

    problems = mod.collect_problems(_watchdog_args(), {"dispatcher"})

    assert problems["dispatcher"] == (
        "dispatcher heartbeat stale: age_seconds=missing max=300 "
        f"detail=failed to inspect critical file {target}: PermissionError: denied"
    )


def test_dispatcher_heartbeat_stat_error_after_private_check_is_reported_not_crashed(
    tmp_path: Path,
    monkeypatch,
):
    mod = _load_module()
    state = _private_state(monkeypatch, mod, tmp_path)
    target = state / "dispatcher-state.json"
    mod.atomic_write_json(target, {"updated_at": 1000})
    original_stat = Path.stat

    def stat(path: Path, *args, **kwargs):
        if path == target and kwargs.get("follow_symlinks") is not False:
            raise PermissionError("denied")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", stat)

    problems = mod.collect_problems(_watchdog_args(), {"dispatcher"})

    assert problems["dispatcher"] == (
        "dispatcher heartbeat stale: age_seconds=missing max=300 "
        f"detail=failed to stat {target}: PermissionError: denied"
    )


def test_parse_args_falls_back_for_bad_max_age_env(monkeypatch):
    mod = _load_module()
    monkeypatch.setenv("BOT_ERRORS_MAX_Q_LOOP_AGE", "bad")
    monkeypatch.setenv("BOT_ERRORS_MAX_DISPATCHER_AGE", "0")
    monkeypatch.setenv("BOT_ERRORS_MAX_COLLECTOR_AGE", "-1")
    monkeypatch.setenv("BOT_ERRORS_MAX_FLEET_SENTINEL_AGE", "")
    monkeypatch.setenv("BOT_ERRORS_MAX_DAILY_HEALTH_AGE", "bad")

    args = mod.parse_args([])

    assert args.max_q_loop_age == 600
    assert args.max_dispatcher_age == 300
    assert args.max_collector_age == 180
    assert args.max_fleet_sentinel_age == 2700
    assert args.max_daily_health_age == 25 * 60 * 60


def test_queue_backlog_threshold_env_falls_back_for_bad_values(tmp_path: Path, monkeypatch):
    mod = _load_module()
    _private_state(monkeypatch, mod, tmp_path)
    for name in (
        "BOT_ERRORS_OUTBOX_CRITICAL_COUNT",
        "BOT_ERRORS_WATCHDOG_OUTBOX_CRITICAL_COUNT",
        "BOT_ERRORS_OUTBOX_CRITICAL_OLDEST_SECONDS",
        "BOT_ERRORS_WATCHDOG_OUTBOX_CRITICAL_OLDEST_SECONDS",
        "BOT_ERRORS_PROCESSING_CRITICAL_COUNT",
        "BOT_ERRORS_WATCHDOG_PROCESSING_CRITICAL_COUNT",
        "BOT_ERRORS_PROCESSING_CRITICAL_OLDEST_SECONDS",
        "BOT_ERRORS_WATCHDOG_PROCESSING_CRITICAL_OLDEST_SECONDS",
        "BOT_ERRORS_WRITEFAIL_CRITICAL_COUNT",
        "BOT_ERRORS_WATCHDOG_WRITEFAIL_CRITICAL_COUNT",
        "BOT_ERRORS_WRITEFAIL_CRITICAL_OLDEST_SECONDS",
        "BOT_ERRORS_WATCHDOG_WRITEFAIL_CRITICAL_OLDEST_SECONDS",
    ):
        monkeypatch.setenv(name, "bad")

    assert mod.queue_backlog_problems() == {}


def test_queue_backlog_directory_scan_error_is_reported_not_crashed(tmp_path: Path, monkeypatch):
    mod = _load_module()
    _private_state(monkeypatch, mod, tmp_path)
    outbox = tmp_path / "outbox"
    outbox.mkdir()
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(outbox))
    original_glob = Path.glob

    def glob(path: Path, pattern: str):
        if path == outbox:
            raise PermissionError("denied")
        return original_glob(path, pattern)

    monkeypatch.setattr(Path, "glob", glob)

    problems = mod.collect_problems(_watchdog_args(), {"queue_backlog"})

    assert problems["queue:outbox"] == (
        f"outbox backlog scan failed: path={outbox} pattern=*.json "
        "error=PermissionError: denied"
    )


def test_queue_backlog_file_stat_error_is_reported_not_crashed(tmp_path: Path, monkeypatch):
    mod = _load_module()
    _private_state(monkeypatch, mod, tmp_path)
    outbox = tmp_path / "outbox"
    outbox.mkdir()
    target = outbox / "event.json"
    target.write_text("{}", encoding="utf-8")
    target.chmod(0o600)
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(outbox))
    original_stat = Path.stat
    target_calls = 0

    def stat(path: Path, *args, **kwargs):
        nonlocal target_calls
        if path == target:
            target_calls += 1
            if target_calls > 1:
                raise PermissionError("denied")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", stat)

    problems = mod.collect_problems(_watchdog_args(), {"queue_backlog"})

    assert problems["queue:outbox"] == (
        f"outbox backlog scan failed: path={outbox} pattern=*.json "
        "error=PermissionError: denied"
    )


def test_daily_health_directory_scan_error_is_reported_not_crashed(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _private_state(monkeypatch, mod, tmp_path)
    sent = state / "sent"
    sent.mkdir()
    original_glob = Path.glob

    def glob(path: Path, pattern: str):
        if path == sent:
            raise PermissionError("denied")
        return original_glob(path, pattern)

    monkeypatch.setattr(Path, "glob", glob)

    problems = mod.collect_problems(_watchdog_args(), {"daily_health"})

    assert problems["daily_health"] == (
        "daily-health cadence stale: age_seconds=missing max=90000 "
        f"detail=failed to scan daily-health events under {state}: "
        f"directory={sent} pattern=*.json* error=PermissionError: denied"
    )


def test_daily_health_event_stat_error_is_reported_not_crashed(tmp_path: Path, monkeypatch):
    mod = _load_module()
    state = _private_state(monkeypatch, mod, tmp_path)
    sent = state / "sent"
    sent.mkdir()
    target = sent / "bot-errors-health.daily-health.event.json"
    target.write_text(json.dumps({"source": "daily-health"}) + "\n", encoding="utf-8")
    target.chmod(0o600)
    original_stat = Path.stat

    def stat(path: Path, *args, **kwargs):
        if path == target:
            raise PermissionError("denied")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", stat)

    problems = mod.collect_problems(_watchdog_args(), {"daily_health"})

    assert problems["daily_health"] == (
        "daily-health cadence stale: age_seconds=missing max=90000 "
        f"detail=failed to scan daily-health events under {state}: "
        f"path={target} error=PermissionError: denied"
    )


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
