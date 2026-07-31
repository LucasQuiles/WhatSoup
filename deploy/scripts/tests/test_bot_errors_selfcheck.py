"""Tests for host-local BOT ERRORS selfcheck.

All fixtures are scratch directories. No host services are queried and the
deployer is injected, not executed.
"""
from __future__ import annotations

import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import sys

import pytest


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-selfcheck.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_selfcheck", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write(path: Path, data: bytes) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return _sha(data)


def _fixture(
    tmp_path: Path,
    *,
    root_data: bytes = b"redact\n",
    bundle_data: bytes = b"redact\n",
    central_ack_path=None,
    approved_heads=None,
):
    head = "a" * 40
    root = tmp_path / "runtime"
    state = tmp_path / "state" / "sentinel"
    fleet_state = tmp_path / "state" / "fleet-sentinel"
    bundle = state / "bundle" / head
    current = state / "current"
    manifest = tmp_path / "manifest.json"
    ledger = tmp_path / "ledger.json"
    deployer = tmp_path / "deployer.sh"

    f10 = _write(bundle / _mod.sp.F10_PATH, bundle_data)
    _write(root / _mod.sp.F10_PATH, root_data)
    manifest.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "expected_head_sha": head,
                "files": [{"path": _mod.sp.F10_PATH, "sha256": f10}],
            }
        ),
        encoding="utf-8",
    )
    ledger.write_text(json.dumps({"approved_f10": [f10], "approved_heads": approved_heads or []}), encoding="utf-8")
    state.mkdir(parents=True, exist_ok=True)
    fleet_state.mkdir(parents=True, exist_ok=True)
    os.symlink(bundle, current)
    deployer.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")

    config = _mod.SelfcheckConfig(
        root=root,
        state_dir=state,
        manifest_path=manifest,
        ledger_path=ledger,
        current_link=current,
        deployer_path=deployer,
        autoheal_off_path=fleet_state / "AUTOHEAL_OFF",
        disabled_path=state / "DISABLED",
        lock_path=state / "selfcheck.lock",
        status_path=state / "status.json",
        memory_path=state / "selfcheck-state.json",
        heartbeat_path=state / "heartbeat.json",
        central_ack_path=central_ack_path,
        central_down_alert_path=state / "actions" / "central-down-alert.json",
    )
    calls: list[tuple[Path, Path, Path]] = []

    def deploy(root_arg: Path, bundle_arg: Path, deployer_arg: Path) -> tuple[int, str]:
        calls.append((root_arg, bundle_arg, deployer_arg))
        return 0, "DEPLOY_OK"

    def runtime_verify(_root_arg: Path, _deployer_arg: Path) -> tuple[int, str]:
        return 0, "VERIFY_OK\n  SMOKE    redaction ok\n"

    def push_heartbeat(_payload: dict) -> dict:
        return {"attempted": False, "mode": "disabled"}

    deps = _mod.SelfcheckDeps(
        commit_exists=lambda _sha: True,
        deploy=deploy,
        runtime_verify=runtime_verify,
        push_heartbeat=push_heartbeat,
        now_epoch=lambda: 1000.0,
        hostname=lambda: "test-host",
        service_status=lambda _unit: "active",
    )
    return config, deps, calls, head


def _read_status(config) -> dict:
    return json.loads(config.status_path.read_text(encoding="utf-8"))


def _seed_memory(config, payload: dict) -> None:
    config.memory_path.parent.mkdir(parents=True, exist_ok=True)
    config.memory_path.write_text(json.dumps(payload), encoding="utf-8")


def test_clean_runtime_writes_healthy_status_without_heal(tmp_path: Path):
    config, deps, calls, head = _fixture(tmp_path)
    status = _mod.run_selfcheck(config, deps)
    assert status["healthy"] is True
    assert status["class"] == "healthy"
    assert status["action"] == "noop"
    assert status["runtimeVerify"]["rc"] == 0
    assert status["pin"]["headSha"] == head
    assert status["centralAck"] == {"configured": False, "mode": "local_only", "status": "not_configured"}
    assert status["heartbeat"]["local"] == "ok"
    assert status["heartbeat"]["push"] == {"attempted": False, "mode": "disabled"}
    heartbeat = json.loads(config.heartbeat_path.read_text(encoding="utf-8"))
    assert heartbeat["kind"] == "bot-errors-selfcheck-heartbeat"
    assert heartbeat["host"] == "test-host"
    assert heartbeat["class"] == "healthy"
    assert calls == []
    assert _read_status(config)["class"] == "healthy"


def test_clean_runtime_runs_deployer_verify_smoke(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path)
    verify_calls: list[tuple[Path, Path]] = []

    def runtime_verify(root_arg: Path, deployer_arg: Path) -> tuple[int, str]:
        verify_calls.append((root_arg, deployer_arg))
        return 0, "x" * 1200

    deps = _mod.SelfcheckDeps(
        commit_exists=deps.commit_exists,
        deploy=deps.deploy,
        runtime_verify=runtime_verify,
        push_heartbeat=deps.push_heartbeat,
        now_epoch=deps.now_epoch,
        hostname=deps.hostname,
        service_status=deps.service_status,
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["healthy"] is True
    assert status["class"] == "healthy"
    assert verify_calls == [(config.root, config.deployer_path)]
    assert status["runtimeVerify"] == {"rc": 0, "output": "x" * 1000}
    assert calls == []


def test_runtime_verify_failure_escalates_without_heal(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path)

    def runtime_verify(_root_arg: Path, _deployer_arg: Path) -> tuple[int, str]:
        return 7, "VERIFY_FAIL\nSMOKE failed\n"

    deps = _mod.SelfcheckDeps(
        commit_exists=deps.commit_exists,
        deploy=deps.deploy,
        runtime_verify=runtime_verify,
        push_heartbeat=deps.push_heartbeat,
        now_epoch=deps.now_epoch,
        hostname=deps.hostname,
        service_status=deps.service_status,
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["healthy"] is False
    assert status["class"] == "runtime_verify_failed"
    assert status["action"] == "escalate"
    assert status["runtimeVerify"]["rc"] == 7
    assert "runtime_verify_rc=7" in status["problems"]
    assert "VERIFY_FAIL" in status["problems"][1]
    assert calls == []


def test_root_drift_skips_runtime_verify_until_after_heal(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")

    def runtime_verify(_root_arg: Path, _deployer_arg: Path) -> tuple[int, str]:
        raise AssertionError("runtime verify should wait for matching file hashes")

    deps = _mod.SelfcheckDeps(
        commit_exists=deps.commit_exists,
        deploy=deps.deploy,
        runtime_verify=runtime_verify,
        push_heartbeat=deps.push_heartbeat,
        now_epoch=deps.now_epoch,
        hostname=deps.hostname,
        service_status=deps.service_status,
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "drift"
    assert status["action"] == "hysteresis_wait"
    assert calls == []


def test_heartbeat_push_receives_status_payload(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path)
    pushed: list[dict] = []

    def push_heartbeat(payload: dict) -> dict:
        pushed.append(payload)
        return {"attempted": True, "ok": True, "status": 202}

    deps = _mod.SelfcheckDeps(
        commit_exists=deps.commit_exists,
        deploy=deps.deploy,
        runtime_verify=deps.runtime_verify,
        push_heartbeat=push_heartbeat,
        now_epoch=deps.now_epoch,
        hostname=deps.hostname,
        service_status=deps.service_status,
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["healthy"] is True
    assert pushed[0]["kind"] == "bot-errors-selfcheck-heartbeat"
    assert pushed[0]["class"] == "healthy"
    assert pushed[0]["pin"]["headSha"] == "a" * 40
    assert status["heartbeat"]["push"] == {"attempted": True, "ok": True, "status": 202}
    assert calls == []


def test_heartbeat_push_failure_does_not_mask_runtime_status(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path)

    def push_heartbeat(_payload: dict) -> dict:
        raise RuntimeError("central down")

    deps = _mod.SelfcheckDeps(
        commit_exists=deps.commit_exists,
        deploy=deps.deploy,
        runtime_verify=deps.runtime_verify,
        push_heartbeat=push_heartbeat,
        now_epoch=deps.now_epoch,
        hostname=deps.hostname,
        service_status=deps.service_status,
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["healthy"] is True
    assert status["class"] == "healthy"
    assert status["heartbeat"]["push"]["ok"] is False
    assert "central down" in status["heartbeat"]["push"]["error"]
    assert calls == []


def test_central_ack_fresh_records_central_acked(tmp_path: Path):
    ack = tmp_path / "central-ack.json"
    ack.write_text("{}", encoding="utf-8")
    os.utime(ack, (980.0, 980.0))
    config, deps, calls, _head = _fixture(tmp_path, central_ack_path=ack)
    status = _mod.run_selfcheck(config, deps)
    assert status["centralAck"]["mode"] == "central_acked"
    assert status["centralAck"]["status"] == "fresh"
    assert status["centralAck"]["ageSeconds"] == 20
    assert status["centralAck"]["centralDownSuspected"] is False
    assert "centralDownAlert" not in status
    assert status["healthy"] is True
    assert calls == []


def test_future_central_ack_mtime_is_not_trusted(tmp_path: Path):
    ack = tmp_path / "central-ack.json"
    ack.write_text("{}", encoding="utf-8")
    os.utime(ack, (1120.0, 1120.0))
    config, deps, calls, _head = _fixture(tmp_path, central_ack_path=ack)

    status = _mod.run_selfcheck(config, deps)

    assert status["centralAck"]["mode"] == "local_only"
    assert status["centralAck"]["status"] == "future_mtime"
    assert status["centralAck"]["futureBySeconds"] == 120
    assert status["centralAck"]["localOnlySeconds"] == 0
    assert status["centralAck"]["centralDownSuspected"] is False
    assert "centralDownAlert" not in status
    assert calls == []


def test_symlinked_central_ack_is_not_trusted(tmp_path: Path):
    target = tmp_path / "external-central-ack.json"
    target.write_text("{}", encoding="utf-8")
    os.utime(target, (990.0, 990.0))
    ack = tmp_path / "central-ack.json"
    os.symlink(target, ack)
    config, deps, calls, _head = _fixture(tmp_path, central_ack_path=ack)

    status = _mod.run_selfcheck(config, deps)

    assert status["centralAck"]["mode"] == "local_only"
    assert status["centralAck"]["status"] == "symlink"
    assert status["centralAck"]["centralDownSuspected"] is False
    assert "centralDownAlert" not in status
    assert calls == []


def test_central_ack_missing_or_stale_records_local_only(tmp_path: Path, monkeypatch):
    missing = tmp_path / "missing-ack.json"
    config, deps, calls, _head = _fixture(tmp_path, central_ack_path=missing)
    status = _mod.run_selfcheck(config, deps)
    assert status["centralAck"]["mode"] == "local_only"
    assert status["centralAck"]["status"] == "missing"
    assert status["centralAck"]["localOnlySeconds"] == 0
    assert status["centralAck"]["centralDownSuspected"] is False
    assert "centralDownAlert" not in status

    stale_root = tmp_path / "stale-case"
    stale_root.mkdir()
    ack = stale_root / "stale-ack.json"
    ack.write_text("{}", encoding="utf-8")
    os.utime(ack, (900.0, 900.0))
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_ACK_MAX_AGE_SECONDS", "60")
    config, deps, calls, _head = _fixture(stale_root, central_ack_path=ack)
    status = _mod.run_selfcheck(config, deps)
    assert status["centralAck"]["mode"] == "local_only"
    assert status["centralAck"]["status"] == "stale"
    assert status["centralAck"]["ageSeconds"] == 100
    assert status["centralAck"]["centralDownSuspected"] is False
    assert calls == []


def test_long_stale_central_ack_writes_central_down_alert(tmp_path: Path, monkeypatch):
    ack = tmp_path / "central-ack.json"
    ack.write_text("{}", encoding="utf-8")
    os.utime(ack, (100.0, 100.0))
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_ACK_MAX_AGE_SECONDS", "60")
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS", "600")
    config, deps, calls, _head = _fixture(tmp_path, central_ack_path=ack)
    status = _mod.run_selfcheck(config, deps)
    assert status["healthy"] is True
    assert status["centralAck"]["status"] == "stale"
    assert status["centralAck"]["ageSeconds"] == 900
    assert status["centralAck"]["centralDownSuspected"] is True
    assert status["centralDownAlert"] == {
        "active": True,
        "path": str(config.central_down_alert_path),
        "ok": True,
    }
    alert = json.loads(config.central_down_alert_path.read_text(encoding="utf-8"))
    assert alert["kind"] == "bot-errors-selfcheck-central-down-alert"
    # Issue #2470: alert must use digests, not raw host/root.
    assert alert["hostDigest"] == _mod._telemetry_digest("host", "test-host")
    assert "host" not in alert
    assert alert["rootDigest"] == _mod._telemetry_digest("root", str(config.root))
    assert "root" not in alert
    assert alert["action"] == "central_down_suspected"
    assert alert["tier"] == "tier3"
    assert alert["centralAck"]["status"] == "stale"
    assert "path" not in alert["centralAck"]
    heartbeat = json.loads(config.heartbeat_path.read_text(encoding="utf-8"))
    assert heartbeat["centralDownAlert"]["ok"] is True
    assert calls == []


def test_missing_central_ack_alerts_after_local_only_threshold(tmp_path: Path, monkeypatch):
    missing = tmp_path / "missing-ack.json"
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS", "600")
    config, deps, calls, _head = _fixture(tmp_path, central_ack_path=missing)
    _seed_memory(
        config,
        {
            "lastClass": "healthy",
            "consecutive": 1,
            "healHistory": [],
            "centralAckLocalOnlySince": 100.0,
        },
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["healthy"] is True
    assert status["centralAck"]["status"] == "missing"
    assert status["centralAck"]["localOnlySeconds"] == 900
    assert status["centralAck"]["centralDownSuspected"] is True
    assert status["centralDownAlert"]["ok"] is True
    assert json.loads(config.central_down_alert_path.read_text(encoding="utf-8"))["centralAck"]["status"] == "missing"
    assert calls == []


def test_central_down_alert_write_failure_is_reported(tmp_path: Path, monkeypatch):
    ack = tmp_path / "central-ack.json"
    ack.write_text("{}", encoding="utf-8")
    os.utime(ack, (100.0, 100.0))
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_ACK_MAX_AGE_SECONDS", "60")
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS", "600")
    config, deps, calls, _head = _fixture(tmp_path, central_ack_path=ack)
    original_atomic_write_json = _mod.atomic_write_json

    def atomic_write_json(path: Path, payload: dict) -> None:
        if path == config.central_down_alert_path:
            raise OSError("disk full")
        original_atomic_write_json(path, payload)

    monkeypatch.setattr(_mod, "atomic_write_json", atomic_write_json)
    status = _mod.run_selfcheck(config, deps)
    assert status["healthy"] is True
    assert status["centralDownAlert"]["ok"] is False
    assert "disk full" in status["centralDownAlert"]["error"]
    heartbeat = json.loads(config.heartbeat_path.read_text(encoding="utf-8"))
    assert heartbeat["centralDownAlert"]["ok"] is False
    assert calls == []


def test_future_central_ack_local_only_since_is_clamped(tmp_path: Path, monkeypatch):
    missing = tmp_path / "missing-ack.json"
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS", "600")
    config, deps, calls, _head = _fixture(tmp_path, central_ack_path=missing)
    _seed_memory(
        config,
        {
            "lastClass": "healthy",
            "consecutive": 1,
            "healHistory": [],
            "centralAckLocalOnlySince": 2000.0,
        },
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["centralAck"]["localOnlySeconds"] == 0
    assert status["centralAck"]["localOnlySince"] == "1970-01-01T00:16:40Z"
    assert status["centralAck"]["centralDownSuspected"] is False
    assert "centralDownAlert" not in status
    assert calls == []


def test_non_finite_central_ack_local_only_since_is_reset(tmp_path: Path, monkeypatch):
    missing = tmp_path / "missing-ack.json"
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS", "600")
    config, deps, calls, _head = _fixture(tmp_path, central_ack_path=missing)
    _seed_memory(
        config,
        {
            "lastClass": "healthy",
            "consecutive": 1,
            "healHistory": [],
            "centralAckLocalOnlySince": float("nan"),
        },
    )

    status = _mod.run_selfcheck(config, deps)

    assert status["centralAck"]["localOnlySeconds"] == 0
    assert status["centralAck"]["localOnlySince"] == "1970-01-01T00:16:40Z"
    assert status["centralAck"]["centralDownSuspected"] is False
    assert "centralDownAlert" not in status
    assert calls == []


def test_boolean_central_ack_local_only_since_is_reset(tmp_path: Path, monkeypatch):
    missing = tmp_path / "missing-ack.json"
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS", "600")
    config, deps, calls, _head = _fixture(tmp_path, central_ack_path=missing)
    _seed_memory(
        config,
        {
            "lastClass": "healthy",
            "consecutive": 1,
            "healHistory": [],
            "centralAckLocalOnlySince": True,
        },
    )

    status = _mod.run_selfcheck(config, deps)

    assert status["centralAck"]["localOnlySeconds"] == 0
    assert status["centralAck"]["localOnlySince"] == "1970-01-01T00:16:40Z"
    assert status["centralAck"]["centralDownSuspected"] is False
    assert "centralDownAlert" not in status
    assert calls == []


def test_fresh_central_ack_clears_local_only_watch(tmp_path: Path):
    ack = tmp_path / "central-ack.json"
    ack.write_text("{}", encoding="utf-8")
    os.utime(ack, (990.0, 990.0))
    config, deps, calls, _head = _fixture(tmp_path, central_ack_path=ack)
    _seed_memory(
        config,
        {
            "lastClass": "healthy",
            "consecutive": 1,
            "healHistory": [],
            "centralAckLocalOnlySince": 100.0,
        },
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["centralAck"]["mode"] == "central_acked"
    assert status["centralAck"]["centralDownSuspected"] is False
    assert "centralDownAlert" not in status
    assert "centralAckLocalOnlySince" not in json.loads(config.memory_path.read_text(encoding="utf-8"))
    assert calls == []


def test_central_ack_stat_error_and_invalid_max_age_fallback(tmp_path: Path, monkeypatch):
    ack = tmp_path / "central-ack.json"
    original_stat = Path.stat

    def stat(path: Path, *args, **kwargs):
        if path == ack:
            raise PermissionError("denied")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", stat)
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_ACK_MAX_AGE_SECONDS", "bad")
    result = _mod.central_ack_inventory(ack, 1000.0)
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS", "bad")
    assert _mod.central_down_max_age_seconds() == 2 * 60 * 60
    assert result == {
        "configured": True,
        "mode": "local_only",
        "status": "stat_error:PermissionError",
        "path": str(ack),
        "maxAgeSeconds": 3 * 30 * 60,
    }


def test_heartbeat_helper_fallbacks_and_local_write_failure(tmp_path: Path, monkeypatch):
    assert _mod.tail_text(None) == ""
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_HEARTBEAT_TIMEOUT_SECONDS", "bad")
    assert _mod.heartbeat_push_timeout() == 5.0
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_HEARTBEAT_TIMEOUT_SECONDS", "inf")
    assert _mod.heartbeat_push_timeout() == 5.0
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_HEAL_MIN_FREE_BYTES", "bad")
    assert _mod.heal_min_free_bytes() == 64 * 1024 * 1024

    config, deps, _calls, _head = _fixture(tmp_path)
    status = {
        "schemaVersion": 1,
        "host": "test-host",
        "checkedAt": "1970-01-01T00:00:00Z",
        "healthy": True,
        "class": "healthy",
        "action": "noop",
        "problems": [],
        "consecutive": 1,
    }

    def atomic(path: Path, _payload: dict) -> None:
        if path == config.heartbeat_path:
            raise OSError("disk full")

    monkeypatch.setattr(_mod, "atomic_write_json", atomic)
    _mod.publish_heartbeat(config, deps, status)
    assert status["heartbeat"]["local"] == "write_failed:OSError"
    assert status["heartbeat"]["push"] == {"attempted": False, "mode": "disabled"}


def test_untrusted_pin_records_problem_and_does_not_heal(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path)
    deps = _mod.SelfcheckDeps(
        commit_exists=lambda _sha: False,
        deploy=deps.deploy,
        runtime_verify=deps.runtime_verify,
        push_heartbeat=deps.push_heartbeat,
        now_epoch=deps.now_epoch,
        hostname=deps.hostname,
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "pin_untrusted"
    assert "not on origin/main" in status["problems"][0]
    assert calls == []


def test_deploy_approved_head_allows_non_git_runtime_root(tmp_path: Path):
    config, deps, calls, head = _fixture(tmp_path, approved_heads=["a" * 40])
    deps = _mod.SelfcheckDeps(
        commit_exists=lambda _sha: False,
        deploy=deps.deploy,
        runtime_verify=deps.runtime_verify,
        push_heartbeat=deps.push_heartbeat,
        now_epoch=deps.now_epoch,
        hostname=deps.hostname,
        service_status=deps.service_status,
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "healthy"
    assert status["pin"]["headSha"] == head
    assert status["pin"]["headApproved"] == "true"
    assert status["pin"]["trust"] == "ok: approved head ledger"
    assert calls == []


def test_pin_load_error_is_fail_closed_status(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path)
    config.manifest_path.write_text("{bad json", encoding="utf-8")
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "pin_untrusted"
    assert status["healthy"] is False
    assert calls == []


def test_safe_drift_requires_two_consecutive_cycles_before_heal(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    first = _mod.run_selfcheck(config, deps)
    assert first["class"] == "drift"
    assert first["consecutive"] == 1
    assert first["action"] == "hysteresis_wait"
    assert calls == []

    second = _mod.run_selfcheck(config, deps)
    assert second["class"] == "drift"
    assert second["consecutive"] == 2
    assert second["action"] == "healed"
    assert len(calls) == 1


def test_malformed_consecutive_memory_restarts_hysteresis(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": "bad", "healHistory": []})

    status = _mod.run_selfcheck(config, deps)

    assert status["class"] == "drift"
    assert status["consecutive"] == 1
    assert status["action"] == "hysteresis_wait"
    assert calls == []
    memory = json.loads(config.memory_path.read_text(encoding="utf-8"))
    assert memory["consecutive"] == 1


def test_non_finite_consecutive_memory_restarts_hysteresis(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": float("inf"), "healHistory": []})

    status = _mod.run_selfcheck(config, deps)

    assert status["class"] == "drift"
    assert status["consecutive"] == 1
    assert status["action"] == "hysteresis_wait"
    assert calls == []
    memory = json.loads(config.memory_path.read_text(encoding="utf-8"))
    assert memory["consecutive"] == 1


def test_boolean_consecutive_memory_restarts_hysteresis(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": True, "healHistory": []})

    status = _mod.run_selfcheck(config, deps)

    assert status["class"] == "drift"
    assert status["consecutive"] == 1
    assert status["action"] == "hysteresis_wait"
    assert calls == []
    memory = json.loads(config.memory_path.read_text(encoding="utf-8"))
    assert memory["consecutive"] == 1


def test_unit_bad_blocks_file_heal_and_escalates(tmp_path: Path, monkeypatch):
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": 1, "healHistory": []})
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_UNITS", "com.bot-errors.health=loaded,bot-errors-dispatcher.service=active")
    deps = _mod.SelfcheckDeps(
        commit_exists=deps.commit_exists,
        deploy=deps.deploy,
        runtime_verify=deps.runtime_verify,
        push_heartbeat=deps.push_heartbeat,
        now_epoch=deps.now_epoch,
        hostname=deps.hostname,
        service_status=lambda unit: "loaded" if unit == "com.bot-errors.health" else "inactive",
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "unit_bad"
    assert status["action"] == "escalate"
    assert "bot-errors-dispatcher.service" in status["problems"][0]
    assert len(status["unitStatuses"]) == 2
    assert calls == []


def test_loaded_expectation_accepts_active_status(tmp_path: Path, monkeypatch):
    config, deps, calls, _head = _fixture(tmp_path)
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_UNITS", "com.bot-errors.health=loaded")
    status = _mod.run_selfcheck(config, deps)
    assert status["healthy"] is True
    assert status["unitStatuses"] == [
        {"unit": "com.bot-errors.health", "expected": "loaded", "status": "active", "ok": "true"}
    ]
    assert calls == []


def test_stale_run_blocks_file_heal_and_escalates(tmp_path: Path, monkeypatch):
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    stamp = tmp_path / "last-run.json"
    stamp.write_text("ok", encoding="utf-8")
    os.utime(stamp, (100.0, 100.0))
    _seed_memory(config, {"lastClass": "drift", "consecutive": 1, "healHistory": []})
    monkeypatch.setenv(
        "BOT_ERRORS_SELFCHECK_FRESHNESS_JSON",
        json.dumps([{"name": "daily-health", "path": str(stamp), "maxAgeSeconds": 60}]),
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "stale_run"
    assert status["action"] == "escalate"
    assert "age_seconds=900" in status["problems"][0]
    assert calls == []


def test_freshness_ok_is_recorded_without_blocking(tmp_path: Path, monkeypatch):
    config, deps, calls, _head = _fixture(tmp_path)
    stamp = tmp_path / "last-run.json"
    stamp.write_text("ok", encoding="utf-8")
    os.utime(stamp, (980.0, 980.0))
    monkeypatch.setenv(
        "BOT_ERRORS_SELFCHECK_FRESHNESS_JSON",
        json.dumps([{"name": "daily-health", "path": str(stamp), "maxAgeSeconds": 60}]),
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["healthy"] is True
    assert status["freshness"][0]["ageSeconds"] == 20
    assert status["freshness"][0]["ok"] == "true"
    assert calls == []


def test_future_freshness_mtime_is_stale_run(tmp_path: Path, monkeypatch):
    config, deps, calls, _head = _fixture(tmp_path)
    stamp = tmp_path / "last-run.json"
    stamp.write_text("ok", encoding="utf-8")
    os.utime(stamp, (1120.0, 1120.0))
    monkeypatch.setenv(
        "BOT_ERRORS_SELFCHECK_FRESHNESS_JSON",
        json.dumps([{"name": "daily-health", "path": str(stamp), "maxAgeSeconds": 60}]),
    )

    status = _mod.run_selfcheck(config, deps)

    assert status["class"] == "stale_run"
    assert status["action"] == "escalate"
    assert status["freshness"][0]["status"] == "future_mtime"
    assert status["freshness"][0]["futureBySeconds"] == 120
    assert "future_mtime" in status["problems"][0]
    assert calls == []


def test_missing_freshness_path_is_stale_run(tmp_path: Path, monkeypatch):
    config, deps, calls, _head = _fixture(tmp_path)
    missing = tmp_path / "missing.json"
    monkeypatch.setenv(
        "BOT_ERRORS_SELFCHECK_FRESHNESS_JSON",
        json.dumps([{"name": "daily-health", "path": str(missing), "maxAgeSeconds": 60}]),
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "stale_run"
    assert status["freshness"][0]["status"] == "missing"
    assert calls == []


def test_manifest_missing_is_safe_heal_class_after_hysteresis(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path)
    (config.root / _mod.sp.F10_PATH).unlink()
    _seed_memory(config, {"lastClass": "manifest_missing", "consecutive": 1, "healHistory": []})
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "manifest_missing"
    assert status["action"] == "healed"
    assert status["healDiskPreflight"]["ok"] is True
    assert len(calls) == 1


def test_low_disk_preflight_blocks_autoheal_before_deploy(tmp_path: Path, monkeypatch):
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": 1, "healHistory": []})
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_HEAL_MIN_FREE_BYTES", "1000")

    class StatVfs:
        f_bavail = 1
        f_frsize = 1

    monkeypatch.setattr(_mod.os, "statvfs", lambda _path: StatVfs())
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "drift"
    assert status["action"] == "heal_preflight_failed"
    assert status["healDiskPreflight"]["status"] == "low_disk_space"
    assert status["healDiskPreflight"]["availableBytes"] == 1
    assert "low_disk_space" in status["problems"]
    assert calls == []


def test_disk_preflight_stat_error_blocks_autoheal(tmp_path: Path, monkeypatch):
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": 1, "healHistory": []})

    def statvfs(_path):
        raise OSError("statvfs denied")

    monkeypatch.setattr(_mod.os, "statvfs", statvfs)
    status = _mod.run_selfcheck(config, deps)
    assert status["action"] == "heal_preflight_failed"
    assert status["healDiskPreflight"]["status"] == "statvfs_error:OSError"
    assert "statvfs_error:OSError" in status["problems"]
    assert calls == []


def test_disk_preflight_bundle_stat_error_is_fail_closed(tmp_path: Path):
    pin = _mod.sp.Pin(head_sha="a" * 40, files={_mod.sp.F10_PATH: "0" * 64}, f10_sha="0" * 64)
    result = _mod.heal_disk_preflight(tmp_path / "root", tmp_path / "bundle", pin)
    assert result["ok"] is False
    assert result["status"] == "bundle_stat_error:FileNotFoundError"


def test_disk_preflight_root_stat_error_is_fail_closed(tmp_path: Path, monkeypatch):
    rel = _mod.sp.F10_PATH
    bundle = tmp_path / "bundle"
    root = tmp_path / "root"
    _write(bundle / rel, b"redact\n")
    _write(root / rel, b"wrong\n")
    pin = _mod.sp.Pin(head_sha="a" * 40, files={rel: _sha(b"redact\n")}, f10_sha=_sha(b"redact\n"))
    root_file = root / rel
    original_stat = Path.stat

    def stat(path: Path):
        if path == root_file:
            raise PermissionError("denied")
        return original_stat(path)

    monkeypatch.setattr(Path, "stat", stat)
    result = _mod.heal_disk_preflight(root, bundle, pin)
    assert result["ok"] is False
    assert result["status"] == "root_stat_error:PermissionError"
    assert result["path"] == str(root_file)


def test_autoheal_off_checks_before_hysteresis_and_never_deploys(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    config.autoheal_off_path.touch()
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "drift"
    assert status["action"] == "monitor_only"
    assert status["levers"]["autohealOff"] == "present"
    assert calls == []


def test_disabled_lever_prevents_mutation(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    config.disabled_path.touch()
    status = _mod.run_selfcheck(config, deps)
    assert status["action"] == "mutation_disabled"
    assert status["levers"]["disabled"] == "present"
    assert calls == []


def test_bad_current_bundle_refuses_heal(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n", bundle_data=b"also-wrong\n")
    (config.current_link.parent / "bundle" / ("a" * 40) / _mod.sp.F10_PATH).write_text("mutated", encoding="utf-8")
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "bundle_bad"
    assert status["action"] == "none"
    assert calls == []


def test_current_bundle_name_must_match_pin_head(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path)
    other = config.current_link.parent / "bundle" / ("b" * 40)
    other.mkdir(parents=True)
    config.current_link.unlink()
    os.symlink(other, config.current_link)
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "bundle_mismatch"
    assert calls == []


def test_current_bundle_must_stay_under_sentinel_bundle_cache(tmp_path: Path):
    config, deps, calls, head = _fixture(tmp_path)
    external = tmp_path / "outside-cache" / head
    external_file = external / _mod.sp.F10_PATH
    external_file.parent.mkdir(parents=True)
    source_file = config.current_link.parent / "bundle" / head / _mod.sp.F10_PATH
    external_file.write_bytes(source_file.read_bytes())
    config.current_link.unlink()
    os.symlink(external, config.current_link)

    status = _mod.run_selfcheck(config, deps)

    assert status["class"] == "bundle_missing"
    assert "outside bundle cache" in status["problems"][0]
    assert calls == []


def test_missing_current_bundle_records_bundle_missing(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path)
    config.current_link.unlink()
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "bundle_missing"
    assert "current bundle unavailable" in status["problems"][0]
    assert calls == []


def test_symlinked_runtime_path_is_risky_and_not_healed(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path)
    (config.root / _mod.sp.F10_PATH).unlink()
    os.symlink(config.current_link.parent / "bundle" / ("a" * 40) / _mod.sp.F10_PATH, config.root / _mod.sp.F10_PATH)
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "unsafe_runtime_path"
    assert status["action"] == "escalate"
    assert calls == []


def test_rate_limit_blocks_third_heal_inside_window(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": 1, "healHistory": [999.0, 998.0]})
    status = _mod.run_selfcheck(config, deps)
    assert status["action"] == "rate_limited"
    assert calls == []


def test_existing_lock_blocks_heal(tmp_path: Path):
    """A live flock holder (this test process, alive PID) blocks the heal.

    Note: the lock is now an flock advisory lock, not an O_EXCL lockfile, so a
    busy lock is one that is *held* — merely writing a file no longer blocks
    (that was the stale-lock-freezes-heals-forever bug fixed in P0-3)."""
    import fcntl
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": 1, "healHistory": []})
    config.lock_path.parent.mkdir(parents=True, exist_ok=True)
    holder = os.open(str(config.lock_path), os.O_CREAT | os.O_WRONLY, 0o600)
    fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.write(holder, f"{os.getpid()}\n".encode())  # our PID — alive, fresh
    try:
        status = _mod.run_selfcheck(config, deps)
        assert status["action"] == "lock_busy"
        assert calls == []
    finally:
        fcntl.flock(holder, fcntl.LOCK_UN)
        os.close(holder)


def test_current_symlink_race_refuses_deploy(tmp_path: Path):
    config, deps, calls, head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": 1, "healHistory": []})
    alternate = tmp_path / "alternate" / head
    alternate.mkdir(parents=True)

    def before_heal() -> None:
        config.current_link.unlink()
        os.symlink(alternate, config.current_link)

    deps = _mod.SelfcheckDeps(
        commit_exists=deps.commit_exists,
        deploy=deps.deploy,
        runtime_verify=deps.runtime_verify,
        push_heartbeat=deps.push_heartbeat,
        now_epoch=deps.now_epoch,
        hostname=deps.hostname,
        before_heal=before_heal,
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["action"] == "current_changed"
    assert calls == []


def test_deployer_failure_is_reported_and_lock_is_released(tmp_path: Path):
    config, deps, _calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": 1, "healHistory": []})

    def deploy(_root: Path, _bundle: Path, _deployer: Path) -> tuple[int, str]:
        return 4, "VERIFY_FAILED"

    deps = _mod.SelfcheckDeps(
        commit_exists=deps.commit_exists,
        deploy=deploy,
        runtime_verify=deps.runtime_verify,
        push_heartbeat=deps.push_heartbeat,
        now_epoch=deps.now_epoch,
        hostname=deps.hostname,
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["action"] == "heal_failed"
    assert "deployer_rc=4" in status["problems"]
    # #2474: release_lock no longer unlinks the pathname, only the flock.
    assert config.lock_path.exists()


def test_no_heal_mode_is_monitor_only(tmp_path: Path):
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": 1, "healHistory": []})
    status = _mod.run_selfcheck(config, deps, heal_enabled=False)
    assert status["action"] == "monitor_only"
    assert calls == []


def test_dry_service_states_parse_json_and_pairs(monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_DRY_SERVICE_STATES", '{"a.service":"active"}')
    assert _mod.dry_service_states() == {"a.service": "active"}
    monkeypatch.setenv("BOT_ERRORS_DRY_SERVICE_STATES", "a=loaded,ignored,b=inactive")
    assert _mod.dry_service_states() == {"a": "loaded", "b": "inactive"}


def test_service_check_timeout_has_floor_and_fallback(monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_SERVICE_CHECK_TIMEOUT_SECONDS", "0")
    assert _mod.service_check_timeout() == 0.1
    monkeypatch.setenv("BOT_ERRORS_SERVICE_CHECK_TIMEOUT_SECONDS", "bad")
    assert _mod.service_check_timeout() == 5.0
    monkeypatch.setenv("BOT_ERRORS_SERVICE_CHECK_TIMEOUT_SECONDS", "inf")
    assert _mod.service_check_timeout() == 5.0


def test_default_service_status_uses_dry_state(monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_DRY_SERVICE_STATES", "com.bot-errors.health=loaded")
    assert _mod.default_service_status("com.bot-errors.health") == "loaded"


def test_default_service_status_uses_systemd_for_service_units(monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_DRY_SERVICE_STATES", raising=False)
    monkeypatch.setattr(_mod.sys, "platform", "linux")
    monkeypatch.setattr(_mod, "systemd_service_status", lambda unit: "active")
    assert _mod.default_service_status("bot-errors-dispatcher.service") == "active"


def test_launchd_and_systemd_status_helpers(monkeypatch):
    class Proc:
        def __init__(self, returncode: int, stdout: str):
            self.returncode = returncode
            self.stdout = stdout

    def run_launchd(cmd, **_kwargs):
        assert cmd[:2] == ["launchctl", "print"]
        return Proc(0, "state = running\n\tpid = 123\n")

    monkeypatch.setattr(_mod.subprocess, "run", run_launchd)
    assert _mod.launchd_service_status("com.bot-errors.health") == "active"

    def run_systemd(cmd, **_kwargs):
        assert cmd[:3] == ["systemctl", "--user", "is-active"]
        return Proc(0, "active\n")

    monkeypatch.setattr(_mod.subprocess, "run", run_systemd)
    assert _mod.systemd_service_status("bot-errors-dispatcher.service") == "active"


def test_launchd_loaded_and_inactive_statuses(monkeypatch):
    class Proc:
        def __init__(self, returncode: int, stdout: str):
            self.returncode = returncode
            self.stdout = stdout

    monkeypatch.setattr(_mod.subprocess, "run", lambda *_args, **_kwargs: Proc(0, "state = waiting\n"))
    assert _mod.launchd_service_status("com.bot-errors.health") == "loaded"
    monkeypatch.setattr(_mod.subprocess, "run", lambda *_args, **_kwargs: Proc(1, ""))
    assert _mod.launchd_service_status("com.bot-errors.health") == "inactive"


def test_default_service_status_reports_check_failures(monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_DRY_SERVICE_STATES", raising=False)

    def boom(*_args, **_kwargs):
        raise _mod.subprocess.TimeoutExpired(cmd="launchctl", timeout=5)

    monkeypatch.setattr(_mod, "launchd_service_status", boom)
    assert _mod.default_service_status("com.bot-errors.health") == "check_failed:TimeoutExpired"


def test_parse_unit_expectations_and_status_matching():
    assert _mod.parse_unit_expectations("a.service,b.service=loaded,=active") == [
        ("a.service", "active"),
        ("b.service", "loaded"),
    ]
    assert _mod.unit_status_ok("active_process_fallback", "active") is True
    assert _mod.unit_status_ok("loaded", "loaded") is True
    assert _mod.unit_status_ok("inactive", "loaded") is False
    assert _mod.unit_status_ok("waiting", "waiting") is True


def test_invalid_freshness_config_fails_closed(tmp_path: Path, monkeypatch):
    config, deps, calls, _head = _fixture(tmp_path)
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_FRESHNESS_JSON", '{"bad": true}')
    with pytest.raises(_mod.SelfcheckError, match="freshness expectations"):
        _mod.run_selfcheck(config, deps)
    assert calls == []


def test_invalid_freshness_json_fails_closed(monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_FRESHNESS_JSON", "{bad json")
    with pytest.raises(_mod.SelfcheckError, match="invalid freshness JSON"):
        _mod.freshness_expectations()


def test_invalid_freshness_entry_fails_closed(monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_FRESHNESS_JSON", json.dumps([{"name": "x"}]))
    with pytest.raises(_mod.SelfcheckError, match="requires name"):
        _mod.freshness_expectations()


def test_boolean_freshness_max_age_fails_closed(monkeypatch):
    monkeypatch.setenv(
        "BOT_ERRORS_SELFCHECK_FRESHNESS_JSON",
        json.dumps([{"name": "daily-health", "path": "/tmp/last-run", "maxAgeSeconds": True}]),
    )
    with pytest.raises(_mod.SelfcheckError, match="requires name"):
        _mod.freshness_expectations()


def test_non_object_freshness_entry_fails_closed(monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_FRESHNESS_JSON", json.dumps(["bad"]))
    with pytest.raises(_mod.SelfcheckError, match="must be an object"):
        _mod.freshness_expectations()


def test_freshness_stat_error_is_stale_run(tmp_path: Path, monkeypatch):
    config, deps, calls, _head = _fixture(tmp_path)
    target = tmp_path / "last-run.json"
    target.write_text("ok", encoding="utf-8")
    original_stat = Path.stat

    def stat(path: Path):
        if path == target:
            raise PermissionError("denied")
        return original_stat(path)

    monkeypatch.setattr(Path, "stat", stat)
    monkeypatch.setenv(
        "BOT_ERRORS_SELFCHECK_FRESHNESS_JSON",
        json.dumps([{"name": "daily-health", "path": str(target), "maxAgeSeconds": 60}]),
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["class"] == "stale_run"
    assert status["freshness"][0]["status"] == "stat_error:PermissionError"
    assert calls == []


def test_default_config_uses_env_overrides(tmp_path: Path, monkeypatch):
    root = tmp_path / "root"
    state = tmp_path / "custom-state"
    manifest = tmp_path / "manifest.json"
    heartbeat = tmp_path / "heartbeat.json"
    ack = tmp_path / "central-ack.json"
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state-root"))
    monkeypatch.setenv("BOT_ERRORS_RUNTIME_MANIFEST", str(manifest))
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_HEARTBEAT", str(heartbeat))
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_ACK", str(ack))
    central_alert = tmp_path / "central-down-alert.json"
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_ALERT", str(central_alert))
    assert _mod.default_state_dir() == tmp_path / "state-root" / "sentinel"
    config = _mod.default_config(root, state)
    assert config.manifest_path == manifest
    assert config.current_link == state / "current"
    assert config.heartbeat_path == heartbeat
    assert config.central_ack_path == ack
    assert config.central_down_alert_path == central_alert


def test_private_dir_chmod_error_is_nonfatal(tmp_path: Path, monkeypatch):
    original_chmod = Path.chmod

    def chmod(path: Path, mode: int) -> None:
        if path == tmp_path / "state":
            raise OSError("chmod denied")
        original_chmod(path, mode)

    monkeypatch.setattr(Path, "chmod", chmod)
    _mod.ensure_private_dir(tmp_path / "state")
    assert (tmp_path / "state").is_dir()


def test_fsync_parent_ignores_open_error(tmp_path: Path, monkeypatch):
    called = False

    def boom(*_args, **_kwargs):
        nonlocal called
        called = True
        raise OSError("no directory fd")

    monkeypatch.setattr(_mod.os, "open", boom)
    _mod.fsync_parent(tmp_path / "missing" / "status.json")
    assert called is True


def test_atomic_write_json_cleans_temp_on_replace_error(tmp_path: Path, monkeypatch):
    path = tmp_path / "state" / "status.json"

    def replace(_src, _dst):
        raise RuntimeError("replace failed")

    monkeypatch.setattr(_mod.os, "replace", replace)
    with pytest.raises(RuntimeError):
        _mod.atomic_write_json(path, {"ok": True})
    assert list(path.parent.glob(".status.json.*.tmp")) == []


def test_atomic_write_json_ignores_temp_unlink_error_after_failure(tmp_path: Path, monkeypatch):
    path = tmp_path / "state" / "status.json"
    original_unlink = Path.unlink

    def replace(_src, _dst):
        raise RuntimeError("replace failed")

    def unlink(path_obj: Path):
        if path_obj.name.startswith(".status.json."):
            raise OSError("unlink denied")
        original_unlink(path_obj)

    monkeypatch.setattr(_mod.os, "replace", replace)
    monkeypatch.setattr(Path, "unlink", unlink)
    with pytest.raises(RuntimeError):
        _mod.atomic_write_json(path, {"ok": True})


def test_read_json_object_rejects_bad_json_and_non_object(tmp_path: Path):
    bad = tmp_path / "bad.json"; bad.write_text("{bad", encoding="utf-8")
    with pytest.raises(_mod.SelfcheckError, match="cannot read"):
        _mod.read_json_object(bad, {})
    array = tmp_path / "array.json"; array.write_text("[]", encoding="utf-8")
    with pytest.raises(_mod.SelfcheckError, match="must be a JSON object"):
        _mod.read_json_object(array, {})


def test_load_memory_rejects_bad_history_shape(tmp_path: Path):
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"healHistory": "bad"}), encoding="utf-8")
    with pytest.raises(_mod.SelfcheckError, match="healHistory"):
        _mod.load_memory(path)


def test_lever_stat_error_is_engaged(tmp_path: Path, monkeypatch):
    lever = tmp_path / "DISABLED"

    def stat(path: Path):
        if path == lever:
            raise PermissionError("denied")
        return original_stat(path)

    original_stat = Path.stat
    monkeypatch.setattr(Path, "stat", stat)
    engaged, reason = _mod.lever_engaged(lever)
    assert engaged is True
    assert reason == "stat_error:PermissionError"


def test_invalid_heal_history_blocks_mutation():
    allowed, reason = _mod.heal_allowed({"healHistory": ["not-a-number"]}, 1000.0)
    assert allowed is False
    assert reason == "invalid_heal_history"


def test_non_finite_heal_history_blocks_mutation():
    allowed, reason = _mod.heal_allowed({"healHistory": [float("inf")]}, 1000.0)
    assert allowed is False
    assert reason == "invalid_heal_history"


def test_old_heal_history_is_pruned():
    memory = {"healHistory": [1.0, 29999.0]}
    allowed, reason = _mod.heal_allowed(memory, 30000.0)
    assert allowed is True
    assert reason == "ok"
    assert memory["healHistory"] == [29999.0]


def test_release_lock_tolerates_missing_lock(tmp_path: Path):
    lock = tmp_path / "lock"
    fd = _mod.acquire_lock(lock)
    assert fd is not None
    lock.unlink()
    _mod.release_lock(lock, fd)
    assert not lock.exists()


def test_relative_current_symlink_resolves_against_state_dir(tmp_path: Path):
    state = tmp_path / "state"
    bundle = state / "bundle" / ("a" * 40)
    bundle.mkdir(parents=True)
    current = state / "current"
    os.symlink(Path("bundle") / ("a" * 40), current)
    assert _mod.current_bundle_path(current) == bundle.resolve()


def test_classify_empty_mismatch_defaults_to_drift():
    assert _mod.classify_runtime_mismatches([]) == "drift"


def test_default_commit_exists_requires_commit_and_origin_main(tmp_path: Path, monkeypatch):
    calls: list[list[str]] = []

    class Proc:
        def __init__(self, returncode: int):
            self.returncode = returncode

    def run(cmd, **_kwargs):
        calls.append(cmd)
        if cmd[3] == "cat-file":
            return Proc(0)
        return Proc(0)

    monkeypatch.setattr(_mod.subprocess, "run", run)
    exists = _mod.default_commit_exists(tmp_path)("a" * 40)
    assert exists is True
    assert calls[0][3] == "cat-file"
    assert calls[1][3] == "merge-base"

    def cat_fails(cmd, **_kwargs):
        return Proc(1 if cmd[3] == "cat-file" else 0)

    monkeypatch.setattr(_mod.subprocess, "run", cat_fails)
    assert _mod.default_commit_exists(tmp_path)("a" * 40) is False


def test_default_commit_exists_rejects_commit_not_on_origin_main(tmp_path: Path, monkeypatch):
    class Proc:
        def __init__(self, returncode: int):
            self.returncode = returncode

    def run(cmd, **_kwargs):
        return Proc(1 if cmd[3] == "merge-base" else 0)

    monkeypatch.setattr(_mod.subprocess, "run", run)
    assert _mod.default_commit_exists(tmp_path)("a" * 40) is False


def test_default_deploy_invokes_local_deployer(tmp_path: Path, monkeypatch):
    class Proc:
        returncode = 0
        stdout = "x" * 5000

    seen = {}

    def run(cmd, **kwargs):
        seen["cmd"] = cmd
        seen["timeout"] = kwargs["timeout"]
        return Proc()

    monkeypatch.setattr(_mod.subprocess, "run", run)
    rc, output = _mod.default_deploy(tmp_path / "deployer.sh")(tmp_path / "root", tmp_path / "bundle")
    assert rc == 0
    assert seen["cmd"][:2] == ["bash", str(tmp_path / "deployer.sh")]
    assert seen["timeout"] == 120
    assert len(output) == 4000


def test_default_deploy_reports_timeout_and_exec_errors(tmp_path: Path, monkeypatch):
    def timeout(_cmd, **_kwargs):
        raise _mod.subprocess.TimeoutExpired(["bash"], 120, output=b"partial deploy output")

    monkeypatch.setattr(_mod.subprocess, "run", timeout)
    rc, output = _mod.default_deploy(tmp_path / "deployer.sh")(tmp_path / "root", tmp_path / "bundle")
    assert rc == 124
    assert "DEPLOY_TIMEOUT" in output
    assert "partial deploy output" in output

    def exec_error(_cmd, **_kwargs):
        raise OSError("missing bash")

    monkeypatch.setattr(_mod.subprocess, "run", exec_error)
    rc, output = _mod.default_deploy(tmp_path / "deployer.sh")(tmp_path / "root", tmp_path / "bundle")
    assert rc == 127
    assert "DEPLOY_EXEC_ERROR: OSError" in output


def test_default_runtime_verify_invokes_deployer_verify(tmp_path: Path, monkeypatch):
    class Proc:
        returncode = 1
        stdout = "x" * 5000

    seen = {}

    def run(cmd, **kwargs):
        seen["cmd"] = cmd
        seen["timeout"] = kwargs["timeout"]
        seen["stderr"] = kwargs["stderr"]
        return Proc()

    monkeypatch.setattr(_mod.subprocess, "run", run)
    deployer = tmp_path / "deployer.sh"
    root = tmp_path / "root"
    rc, output = _mod.default_runtime_verify(deployer)(root, deployer)
    assert rc == 1
    assert seen["cmd"] == ["bash", str(deployer), "verify", str(root)]
    assert seen["timeout"] == 120
    assert seen["stderr"] == _mod.subprocess.STDOUT
    assert len(output) == 4000


def test_default_runtime_verify_reports_timeout_and_exec_errors(tmp_path: Path, monkeypatch):
    def timeout(_cmd, **_kwargs):
        raise _mod.subprocess.TimeoutExpired(["bash"], 120, output=b"partial output")

    monkeypatch.setattr(_mod.subprocess, "run", timeout)
    rc, output = _mod.default_runtime_verify(tmp_path / "deployer.sh")(tmp_path / "root", tmp_path / "deployer.sh")
    assert rc == 124
    assert "VERIFY_TIMEOUT" in output
    assert "partial output" in output

    def exec_error(_cmd, **_kwargs):
        raise OSError("missing bash")

    monkeypatch.setattr(_mod.subprocess, "run", exec_error)
    rc, output = _mod.default_runtime_verify(tmp_path / "deployer.sh")(tmp_path / "root", tmp_path / "deployer.sh")
    assert rc == 127
    assert "VERIFY_EXEC_ERROR: OSError" in output


def test_default_push_heartbeat_disabled_without_url(monkeypatch):
    monkeypatch.delenv("BOT_ERRORS_SELFCHECK_HEARTBEAT_URL", raising=False)
    assert _mod.default_push_heartbeat({"host": "test-host"}) == {"attempted": False, "mode": "disabled"}


def test_default_push_heartbeat_posts_json_and_handles_errors(monkeypatch):
    seen = {}

    class Response:
        status = 202

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _limit):
            return b"ACK"

    def ok(req, timeout):
        seen["url"] = req.full_url
        seen["method"] = req.get_method()
        seen["data"] = json.loads(req.data.decode("utf-8"))
        seen["timeout"] = timeout
        return Response()

    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_HEARTBEAT_URL", "http://127.0.0.1:9123/heartbeat")
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_HEARTBEAT_TIMEOUT_SECONDS", "0")
    monkeypatch.setattr(_mod, "urlopen", ok)
    result = _mod.default_push_heartbeat({"host": "test-host"})
    assert result == {"attempted": True, "ok": True, "status": 202, "body": "ACK"}
    assert seen == {
        "url": "http://127.0.0.1:9123/heartbeat",
        "method": "POST",
        "data": {"host": "test-host"},
        "timeout": 0.1,
    }

    def http_error(_req, **_kwargs):
        raise _mod.HTTPError("http://127.0.0.1:9123/heartbeat", 503, "unavailable", hdrs=None, fp=io.BytesIO(b"busy"))

    monkeypatch.setattr(_mod, "urlopen", http_error)
    result = _mod.default_push_heartbeat({"host": "test-host"})
    assert result == {"attempted": True, "ok": False, "status": 503, "error": "busy"}

    def url_error(_req, **_kwargs):
        raise _mod.URLError("refused")

    monkeypatch.setattr(_mod, "urlopen", url_error)
    result = _mod.default_push_heartbeat({"host": "test-host"})
    assert result["attempted"] is True
    assert result["ok"] is False
    assert "URLError" in result["error"]


def test_default_deps_wires_default_callables(tmp_path: Path, monkeypatch):
    config, _deps, _calls, _head = _fixture(tmp_path)
    monkeypatch.setattr(_mod, "default_commit_exists", lambda root: (lambda sha: True))
    monkeypatch.setattr(_mod, "default_deploy", lambda deployer: (lambda root, bundle, path: (0, "ok")))
    monkeypatch.setattr(_mod, "default_runtime_verify", lambda deployer: (lambda root, path: (0, "verify ok")))
    monkeypatch.setattr(_mod, "default_push_heartbeat", lambda payload: {"attempted": True, "ok": True})
    deps = _mod.default_deps(config)
    assert deps.commit_exists("a" * 40) is True
    assert deps.deploy(config.root, config.root, config.deployer_path) == (0, "ok")
    assert deps.runtime_verify(config.root, config.deployer_path) == (0, "verify ok")
    assert deps.push_heartbeat({"host": "test-host"}) == {"attempted": True, "ok": True}
    assert isinstance(deps.hostname(), str)


def test_parse_args_accepts_root_state_and_no_heal(tmp_path: Path):
    args = _mod.parse_args(["--root", str(tmp_path / "root"), "--state-dir", str(tmp_path / "state"), "--no-heal"])
    assert args.root == str(tmp_path / "root")
    assert args.state_dir == str(tmp_path / "state")
    assert args.no_heal is True


def test_main_success_and_unhealthy_exit_codes(tmp_path: Path, monkeypatch, capsys):
    config, _deps, _calls, _head = _fixture(tmp_path)
    monkeypatch.setattr(_mod, "default_config", lambda root, state_dir: config)
    monkeypatch.setattr(_mod, "run_selfcheck", lambda cfg, heal_enabled=True: {"healthy": True, "action": "noop"})
    assert _mod.main(["--root", str(config.root), "--state-dir", str(config.state_dir)]) == 0
    assert '"healthy": true' in capsys.readouterr().out

    monkeypatch.setattr(_mod, "run_selfcheck", lambda cfg, heal_enabled=True: {"healthy": False, "action": "escalate"})
    assert _mod.main(["--root", str(config.root), "--state-dir", str(config.state_dir)]) == 1


def test_main_error_writes_selfcheck_error_status(tmp_path: Path, monkeypatch, capsys):
    config, _deps, _calls, _head = _fixture(tmp_path)
    monkeypatch.setattr(_mod, "default_config", lambda root, state_dir: config)

    def fail(_cfg, heal_enabled=True):
        raise RuntimeError("boom")

    monkeypatch.setattr(_mod, "run_selfcheck", fail)
    assert _mod.main(["--root", str(config.root), "--state-dir", str(config.state_dir)]) == 2
    assert "selfcheck_error" in capsys.readouterr().err
    assert json.loads(config.status_path.read_text(encoding="utf-8"))["class"] == "selfcheck_error"


def test_main_error_still_returns_when_status_write_fails(tmp_path: Path, monkeypatch):
    config, _deps, _calls, _head = _fixture(tmp_path)
    monkeypatch.setattr(_mod, "default_config", lambda root, state_dir: config)
    monkeypatch.setattr(_mod, "run_selfcheck", lambda cfg, heal_enabled=True: (_ for _ in ()).throw(RuntimeError("boom")))
    monkeypatch.setattr(_mod, "atomic_write_json", lambda path, payload: (_ for _ in ()).throw(RuntimeError("write failed")))
    assert _mod.main(["--root", str(config.root), "--state-dir", str(config.state_dir)]) == 2


# ---------------------------------------------------------------------------
# P0-8A: lever stat_error must escalate, not silently suppress heals
# ---------------------------------------------------------------------------

def test_lever_stat_error_on_disabled_path_escalates_not_silent(tmp_path: Path, monkeypatch):
    """P0-8A: OSError on disabled lever must set class=lever_stat_error + action=escalate.

    Before fix: stat_error returns (True, "stat_error:PermissionError"), which makes
    `disabled=True` and routes to action=mutation_disabled with no alert.
    After fix: run_selfcheck detects the stat_error prefix and returns lever_stat_error/escalate.
    """
    config, deps, calls, _head = _fixture(tmp_path)
    original_stat = Path.stat

    def stat_raises(self, **kwargs):
        if self == config.disabled_path:
            raise PermissionError("denied")
        return original_stat(self, **kwargs)

    monkeypatch.setattr(Path, "stat", stat_raises)
    status = _mod.run_selfcheck(config, deps)
    # FAILING before fix: action is "noop" or "mutation_disabled", class is "healthy"
    assert status["class"] == "lever_stat_error", (
        f"expected lever_stat_error, got class={status['class']!r} action={status['action']!r}"
    )
    assert status["action"] == "escalate", (
        f"expected action=escalate, got {status['action']!r}"
    )
    assert any("lever stat failed" in p for p in status["problems"]), (
        f"expected 'lever stat failed' in problems, got {status['problems']!r}"
    )
    assert status["levers"]["disabled"].startswith("stat_error:"), (
        f"expected levers.disabled to start with stat_error:, got {status['levers']['disabled']!r}"
    )
    assert calls == []


def test_lever_stat_error_on_autoheal_off_path_escalates(tmp_path: Path, monkeypatch):
    """P0-8A: OSError on autoheal_off lever must also escalate with lever_stat_error.

    Before fix: returns (True, "stat_error:OSError"), autoheal_off=True, action=monitor_only.
    After fix: class=lever_stat_error, action=escalate.
    """
    config, deps, calls, _head = _fixture(tmp_path)
    original_stat = Path.stat

    def stat_raises(self, **kwargs):
        if self == config.autoheal_off_path:
            raise OSError("EIO input/output error")
        return original_stat(self, **kwargs)

    monkeypatch.setattr(Path, "stat", stat_raises)
    status = _mod.run_selfcheck(config, deps)
    # FAILING before fix: action="monitor_only" or "noop", class="healthy" or "drift"
    assert status["class"] == "lever_stat_error", (
        f"expected lever_stat_error, got class={status['class']!r} action={status['action']!r}"
    )
    assert status["action"] == "escalate", (
        f"expected action=escalate, got {status['action']!r}"
    )
    assert status["levers"]["autohealOff"].startswith("stat_error:"), (
        f"expected levers.autohealOff to start with stat_error:, got {status['levers']['autohealOff']!r}"
    )
    assert calls == []


def test_lever_stat_error_existing_lever_engaged_test_still_passes(tmp_path: Path, monkeypatch):
    """Regression guard: lever_engaged itself still returns (True, 'stat_error:...') unchanged.

    The fix is in run_selfcheck caller, not in lever_engaged. This test proves no regression
    on the direct lever_engaged function test (mirrors test_lever_stat_error_is_engaged).
    """
    lever = tmp_path / "DISABLED"
    original_stat = Path.stat

    def stat(path: Path, **kwargs):
        if path == lever:
            raise PermissionError("denied")
        return original_stat(path, **kwargs)

    monkeypatch.setattr(Path, "stat", stat)
    engaged, reason = _mod.lever_engaged(lever)
    assert engaged is True
    assert reason == "stat_error:PermissionError"


# --- P0-3: stale selfcheck.lock must not freeze heals forever ----------------
# The old lock was an O_EXCL lockfile: if the holder was SIGKILLed between open
# and unlink, the file stayed on disk and every future acquire_lock returned
# None -> action=lock_busy forever. The fix uses an flock advisory lock, which
# the kernel releases on holder exit, so a leftover file is simply re-acquired.


def test_acquire_lock_ignores_holderless_leftover_file(tmp_path: Path):
    """A leftover lock file with no live flock holder (e.g. left by a crashed
    process) is re-acquired, not honored as busy — that was the P0-3 freeze."""
    lock = tmp_path / "selfcheck.lock"
    lock.write_text("999999999\n", encoding="utf-8")  # crashed holder's PID, no flock
    fd = _mod.acquire_lock(lock)
    assert fd is not None, "a holderless leftover lock file must be re-acquirable"
    # The PID is rewritten to ours for observability.
    assert lock.read_text(encoding="utf-8").strip() == str(os.getpid())
    _mod.release_lock(lock, fd)
    # #2474: release_lock must not unlink the pathname -- a leftover file is not
    # a stale lock (flock ownership is descriptor-scoped), and removing it here
    # would let a fresh acquirer create a new inode at the same path mid-handoff.
    assert lock.exists(), "release_lock must leave the pathname in place"


def test_acquire_lock_respects_live_holder(tmp_path: Path):
    """When a live process actually holds the flock, acquire_lock returns None."""
    import fcntl
    lock = tmp_path / "selfcheck.lock"
    held = os.open(str(lock), os.O_CREAT | os.O_WRONLY, 0o600)
    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.write(held, f"{os.getpid()}\n".encode())  # our PID — alive, fresh
    try:
        assert _mod.acquire_lock(lock) is None, "a live flock holder must block acquisition"
    finally:
        fcntl.flock(held, fcntl.LOCK_UN)
        os.close(held)


def test_release_lock_allows_immediate_reacquire(tmp_path: Path):
    """release_lock frees the flock; the pathname persists (#2474), but the next
    acquire still wins immediately because flock ownership is descriptor-scoped,
    not path-scoped."""
    lock = tmp_path / "selfcheck.lock"
    fd = _mod.acquire_lock(lock)
    assert fd is not None
    _mod.release_lock(lock, fd)
    assert lock.exists(), "the lock pathname must persist across release (#2474)"
    fd2 = _mod.acquire_lock(lock)
    assert fd2 is not None, "lock must be re-acquirable immediately after release"
    _mod.release_lock(lock, fd2)


def test_release_lock_preserves_inode_identity_across_handoff(tmp_path: Path):
    """#2474 regression: release_lock must not unlink the lock pathname, because
    a released-then-reacquired lock must keep the SAME inode identity across a
    handoff. Under the pre-fix release_lock (close, then unlink), a release here
    deleted the pathname; a fresh acquirer then created a NEW inode at the same
    path, and any contender that had opened the OLD inode before the unlink
    could hold a live lock independent of a later contender's lock on the NEW
    inode. The issue's own deterministic canary reproduced exactly that split:
    ``second_holder_live=True, third_holder_live=True, split_inode=True``. This
    test proves the fixed release_lock keeps a single, stable inode across the
    handoff, and that a contender racing in while the new holder is live is
    correctly blocked rather than free to create a second, independent lock."""
    lock = tmp_path / "selfcheck.lock"
    fd_a = _mod.acquire_lock(lock)
    assert fd_a is not None
    inode_a = lock.stat().st_ino

    _mod.release_lock(lock, fd_a)
    assert lock.exists(), "the pathname must survive release (identity must not change hands)"
    assert lock.stat().st_ino == inode_a, "release must not touch inode identity"

    fd_b = _mod.acquire_lock(lock)
    assert fd_b is not None, "handoff acquire must succeed on the SAME inode"
    assert lock.stat().st_ino == inode_a, "handoff must reuse the original inode, never a fresh one"

    # A third contender racing in while B is live must be blocked on the SAME
    # inode -- not free to create and lock a brand-new inode at the same path,
    # which is exactly the split-inode condition #2474 describes.
    fd_c = _mod.acquire_lock(lock)
    assert fd_c is None, "a third contender must be blocked by the live holder on the shared inode"
    assert lock.stat().st_ino == inode_a, "a blocked contender must not have replaced the inode"

    _mod.release_lock(lock, fd_b)


def test_stale_lock_file_no_longer_freezes_heal(tmp_path: Path):
    """End-to-end: a leftover lock file with a dead PID must NOT block the heal.

    Before P0-3 this resolved to lock_busy forever; after the fix the stale file
    is reclaimed and the heal proceeds."""
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": 1, "healHistory": []})
    config.lock_path.parent.mkdir(parents=True, exist_ok=True)
    config.lock_path.write_text("999999999\n", encoding="utf-8")  # dead PID leftover
    status = _mod.run_selfcheck(config, deps)
    assert status["action"] == "healed", f"stale lock must not block heal, got {status['action']}"
    assert calls, "deploy must have been called once the stale lock was reclaimed"


# --- P0-7: pin-update race during in-flight heal -----------------------------
# The pin was loaded at the top of run_selfcheck and reused many steps later
# inside the heal lock. A concurrent `pin` update in that window would deploy
# the stale bundle and still report "healed". The fix re-reads + re-verifies the
# pin inside the lock and aborts as current_changed on any drift.


def test_concurrent_repin_aborts_heal(tmp_path: Path):
    """If the pin changes between the top-of-cycle read and the in-lock re-read,
    the heal aborts as current_changed and deploy is never called."""
    import unittest.mock as mock
    from types import SimpleNamespace

    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": 1, "healHistory": []})

    original_load_pin = _mod.sp.load_pin
    call_count = [0]

    def patched_load_pin(path):
        call_count[0] += 1
        if call_count[0] == 1:
            return original_load_pin(path)
        # Inside the lock: the manifest has been re-pinned to a new head.
        return SimpleNamespace(head_sha="b" * 40, f10_sha="d" * 64)

    with mock.patch.object(_mod.sp, "load_pin", side_effect=patched_load_pin):
        status = _mod.run_selfcheck(config, deps)

    assert status["action"] == "current_changed", (
        f"expected current_changed on concurrent re-pin, got {status['action']}"
    )
    assert calls == [], "deploy must not run when the pin changed mid-heal"
    assert any("pin_changed_during_heal" in p for p in status.get("problems", []))


def test_pin_recheck_failure_inside_lock_aborts_heal(tmp_path: Path):
    """If the in-lock pin re-read raises PinLoadError, abort as current_changed."""
    import unittest.mock as mock

    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": 1, "healHistory": []})

    original_load_pin = _mod.sp.load_pin
    call_count = [0]

    def patched_load_pin(path):
        call_count[0] += 1
        if call_count[0] == 1:
            return original_load_pin(path)
        raise _mod.sp.PinLoadError("manifest deleted mid-heal")

    with mock.patch.object(_mod.sp, "load_pin", side_effect=patched_load_pin):
        status = _mod.run_selfcheck(config, deps)

    assert status["action"] == "current_changed", (
        f"expected current_changed on pin re-read failure, got {status['action']}"
    )
    assert calls == [], "deploy must not run when the pin re-read failed"
    assert any("pin_recheck_failed" in p for p in status.get("problems", []))


def test_stable_pin_still_heals(tmp_path: Path):
    """Regression guard: when the pin is unchanged on both reads, heal proceeds."""
    config, deps, calls, _head = _fixture(tmp_path, root_data=b"wrong\n")
    _seed_memory(config, {"lastClass": "drift", "consecutive": 1, "healHistory": []})
    status = _mod.run_selfcheck(config, deps)
    assert status["action"] == "healed", f"stable pin must still heal, got {status['action']}"
    assert len(calls) == 1


# ─────────────────────────────────────────────────────────────────────────
# Issue #2470: central telemetry boundary canary tests.
#
# These prove that central_telemetry_payload() and publish_central_down_alert()
# never carry raw host identity, absolute paths, free-form problem text,
# file-level mismatch tuples, unit labels, freshness names/paths, raw verifier
# output, or configured ack paths.
# ─────────────────────────────────────────────────────────────────────────

def test_central_telemetry_payload_omits_raw_identity_and_paths():
    """The telemetry payload must not carry raw host, root, or paths."""
    status = {
        "schemaVersion": 1,
        "host": "production-web-01.example.com",
        "checkedAt": "2026-07-29T00:00:00Z",
        "root": "/var/lib/bot-errors/production",
        "healthy": False,
        "class": "runtime_verify_failed",
        "action": "escalate",
        "problems": ["bundle path /var/lib/bot-errors/abc123 missing", "unit bot-errors-worker status=failed"],
        "consecutive": 3,
        "pin": {"headSha": "a" * 40, "f10Sha": "b" * 40, "trust": "approved", "headApproved": "true"},
        "bundle": "abc123def456",
        "runtimeMismatches": [("/var/lib/bot-errors/src/main.py", "content"), ("/var/lib/bot-errors/src/util.py", "missing")],
        "bundleMismatches": [("/opt/bundle/src/lib.ts", "content")],
        "unitStatuses": [{"unit": "bot-errors-worker", "expected": "active", "status": "failed", "ok": "false"}],
        "freshness": [{"name": "ingest-log", "path": "/var/log/bot-errors/ingest.log", "ageSeconds": 999, "ok": "false"}],
        "runtimeVerify": {"rc": 1, "output": "Error: Cannot find module '/var/lib/bot-errors/src/main.js'\n    at Object.<anonymous>"},
        "centralAck": {"configured": True, "mode": "local_only", "status": "stale", "path": "/var/lib/bot-errors/central-ack.json", "ageSeconds": 900, "maxAgeSeconds": 60},
    }
    payload = _mod.central_telemetry_payload(status)

    # Bounded metadata IS present.
    assert payload["schemaVersion"] == 2
    assert payload["healthy"] is False
    assert payload["class"] == "runtime_verify_failed"
    assert payload["action"] == "escalate"
    assert payload["consecutive"] == 3
    assert payload["problemCount"] == 2
    assert payload["pin"]["headSha"] == "a" * 40
    assert payload["bundle"] == "abc123def456"
    assert payload["runtimeMismatchCount"] == 2
    assert payload["runtimeMismatchKinds"] == {"content": 1, "missing": 1}
    assert payload["bundleMismatchCount"] == 1
    assert payload["bundleMismatchKinds"] == {"content": 1}
    assert payload["unitAggregate"] == {"total": 1, "ok": 0, "bad": 1}
    assert payload["freshnessAggregate"] == {"total": 1, "ok": 0, "bad": 1}
    assert payload["runtimeVerifyRc"] == 1
    assert payload["centralAck"]["status"] == "stale"
    assert payload["centralAck"]["configured"] is True

    # Raw identity and paths are ABSENT.
    assert "host" not in payload
    assert "root" not in payload
    assert "problems" not in payload
    assert "runtimeMismatches" not in payload
    assert "bundleMismatches" not in payload
    assert "unitStatuses" not in payload
    assert "freshness" not in payload
    assert "runtimeVerify" not in payload
    assert "path" not in payload.get("centralAck", {})

    # Raw values must not appear anywhere in the serialized payload.
    serialized = json.dumps(payload, sort_keys=True)
    assert "production-web-01" not in serialized
    assert "/var/lib/bot-errors" not in serialized
    assert "bot-errors-worker" not in serialized
    assert "ingest-log" not in serialized
    assert "/var/log/bot-errors" not in serialized
    assert "Cannot find module" not in serialized
    assert "bundle path" not in serialized
    assert "/opt/bundle" not in serialized


def test_central_telemetry_payload_omits_raw_output_on_healthy():
    """Healthy status with runtime verify output must not leak output text."""
    status = {
        "schemaVersion": 1,
        "host": "my-host",
        "checkedAt": "2026-07-29T00:00:00Z",
        "root": "/srv/app",
        "healthy": True,
        "class": "healthy",
        "action": "noop",
        "consecutive": 0,
        "runtimeVerify": {"rc": 0, "output": "All checks passed. Config at /srv/app/config.json"},
    }
    payload = _mod.central_telemetry_payload(status)
    serialized = json.dumps(payload, sort_keys=True)
    assert payload["runtimeVerifyRc"] == 0
    assert "All checks passed" not in serialized
    assert "/srv/app/config.json" not in serialized
    assert "runtimeVerify" not in payload


def test_central_telemetry_digest_properties():
    """Digests must be deterministic, domain-separated, and non-reversible."""
    h1 = _mod._telemetry_digest("host", "web-01")
    h2 = _mod._telemetry_digest("host", "web-01")
    assert h1 == h2  # deterministic
    assert len(h1) == 16  # 16-char hex

    # Domain separation: same value in different domains must differ.
    assert _mod._telemetry_digest("host", "shared") != _mod._telemetry_digest("root", "shared")

    # Non-reversibility: digest must not contain the raw value.
    d = _mod._telemetry_digest("host", "SECRET-HOSTNAME-12345")
    assert "SECRET" not in d
    assert "HOSTNAME" not in d


def test_central_telemetry_mismatch_kind_counts_collapses_paths():
    """Mismatch tuples must collapse to kind counts — no paths."""
    mismatches = [
        ("/secret/path/a.py", "content"),
        ("/secret/path/b.py", "content"),
        ("/secret/path/c.py", "missing"),
    ]
    counts = _mod._mismatch_kind_counts(mismatches)
    assert counts == {"content": 2, "missing": 1}
    serialized = json.dumps(counts)
    assert "/secret" not in serialized
    assert "a.py" not in serialized


def test_publish_heartbeat_pushes_telemetry_not_full_payload(tmp_path: Path):
    """The push must receive the bounded telemetry payload, not the full local payload."""
    config, deps, calls, _head = _fixture(tmp_path)
    pushed: list[dict] = []

    def push_heartbeat(payload: dict) -> dict:
        pushed.append(payload)
        return {"attempted": True, "ok": True, "status": 202}

    deps = _mod.SelfcheckDeps(
        commit_exists=deps.commit_exists,
        deploy=deps.deploy,
        runtime_verify=deps.runtime_verify,
        push_heartbeat=push_heartbeat,
        now_epoch=deps.now_epoch,
        hostname=deps.hostname,
        service_status=deps.service_status,
    )
    status = _mod.run_selfcheck(config, deps)
    assert status["healthy"] is True

    # Push received telemetry shape (schemaVersion 2).
    assert len(pushed) == 1
    assert pushed[0]["schemaVersion"] == 2
    assert "host" not in pushed[0]
    assert "root" not in pushed[0]
    assert "problems" not in pushed[0]
    assert pushed[0]["hostDigest"] == _mod._telemetry_digest("host", "test-host")

    # Local heartbeat file still has full forensic detail (schemaVersion 1).
    local = json.loads(config.heartbeat_path.read_text(encoding="utf-8"))
    assert local["host"] == "test-host"
    assert "root" in local


def test_central_down_alert_uses_digests_not_raw_identity(tmp_path: Path, monkeypatch):
    """Central-down alert artifact must use digests, not raw host/root/path."""
    ack = tmp_path / "central-ack.json"
    ack.write_text("{}", encoding="utf-8")
    os.utime(ack, (100.0, 100.0))
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_ACK_MAX_AGE_SECONDS", "60")
    monkeypatch.setenv("BOT_ERRORS_SELFCHECK_CENTRAL_DOWN_MAX_AGE_SECONDS", "600")
    config, deps, calls, _head = _fixture(tmp_path, central_ack_path=ack)
    status = _mod.run_selfcheck(config, deps)
    assert status["centralDownAlert"]["ok"] is True

    alert = json.loads(config.central_down_alert_path.read_text(encoding="utf-8"))
    assert alert["schemaVersion"] == 2
    assert "host" not in alert
    assert "root" not in alert
    assert alert["hostDigest"] is not None
    assert alert["rootDigest"] is not None
    assert "path" not in alert["centralAck"]

    serialized = json.dumps(alert, sort_keys=True)
    assert "test-host" not in serialized
    assert str(config.root) not in serialized


def test_central_telemetry_rejects_unknown_fields():
    """Unknown status fields must not appear in the telemetry payload."""
    status = {
        "schemaVersion": 1,
        "host": "h",
        "healthy": True,
        "class": "healthy",
        "customSecretField": "leaked-data",
        "deployerOutput": "rc=0 some output",
        "healDiskPreflight": {"ok": True},
    }
    payload = _mod.central_telemetry_payload(status)
    serialized = json.dumps(payload, sort_keys=True)
    assert "customSecretField" not in serialized
    assert "deployerOutput" not in serialized
    assert "healDiskPreflight" not in serialized
    assert "leaked-data" not in serialized
