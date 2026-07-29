"""Fail-closed durable outcomes for the remaining BOT ERRORS principals."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys

import pytest

from deploy.scripts.lib import durable_json


_SCRIPTS = Path(__file__).resolve().parents[1]


def _load(script: str):
    spec = importlib.util.spec_from_file_location(
        f"durable_outcomes_{script.replace('-', '_')}",
        _SCRIPTS / script,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _unproven(
    component: str,
    *,
    generation: int | None,
) -> durable_json.PublicationResult:
    return durable_json.PublicationResult(
        component=component,
        durability=durable_json.DurabilityProof.UNPROVEN,
        confinement=durable_json.ConfinementProof.PROVEN,
        cleanup=durable_json.CleanupState.NOT_REQUIRED,
        authority=durable_json.AuthorityState.UNKNOWN,
        stage=durable_json.WriteStage.PARENT_SYNC,
        error_class=durable_json.ErrorClass.IO,
        generation=generation,
        private_operation_id="private-operation",
        private_content_sha256="private-digest",
    )


def _committed(
    component: str,
    *,
    generation: int | None,
) -> durable_json.PublicationResult:
    return durable_json.PublicationResult(
        component=component,
        durability=durable_json.DurabilityProof.COMMITTED,
        confinement=durable_json.ConfinementProof.PROVEN,
        cleanup=durable_json.CleanupState.COMPLETE,
        authority=durable_json.AuthorityState.INTENDED_AUTHORITATIVE,
        stage=durable_json.WriteStage.PARENT_SYNC,
        error_class=None,
        generation=generation,
        private_operation_id="private-operation",
        private_content_sha256="private-digest",
    )


def test_health_deadman_state_rejects_unproven_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    module = _load("bot-errors-health-check.py")
    monkeypatch.setattr(
        module,
        "publish_state_json",
        lambda *_args, **_kwargs: _unproven(
            "health_check.deadman_state",
            generation=1,
        ),
        raising=False,
    )

    with pytest.raises(RuntimeError) as raised:
        module.save_deadman_state({"schemaVersion": 1, "incidents": {}})

    assert type(raised.value).__name__ == "DurableWriteError"
    assert not module.deadman_state_path().exists()


def test_health_outbox_event_rejects_unproven_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    outbox = tmp_path / "outbox"
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(outbox))
    module = _load("bot-errors-health-check.py")
    monkeypatch.setattr(
        module,
        "publish_event_json",
        lambda *_args, **_kwargs: _unproven(
            "health_check.outbox_event",
            generation=None,
        ),
        raising=False,
    )
    monkeypatch.setattr(module, "record_writefail", lambda *_args: None)

    with pytest.raises(RuntimeError) as raised:
        module.outbox_event("fixture", "fixture")

    assert type(raised.value).__name__ == "DurableWriteError"
    assert list(outbox.glob("*.json")) == []


def test_watchdog_state_rejects_unproven_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    module = _load("bot-errors-heartbeat-watchdog.py")
    monkeypatch.setattr(
        module,
        "publish_state_json",
        lambda *_args, **_kwargs: _unproven(
            "heartbeat_watchdog.state",
            generation=1,
        ),
        raising=False,
    )

    with pytest.raises(RuntimeError) as raised:
        module.save_state({"version": 1, "open": {}})

    assert type(raised.value).__name__ == "DurableWriteError"
    assert not module.watchdog_state_path().exists()


def test_q_loop_state_rejects_unproven_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BOT_ERRORS_Q_LOOP_STATE_DIR", str(tmp_path))
    module = _load("bot-errors-q-loop.py")
    monkeypatch.setattr(
        module,
        "publish_state_json",
        lambda *_args, **_kwargs: _unproven("q_loop.state", generation=1),
        raising=False,
    )

    with pytest.raises(RuntimeError) as raised:
        module.save_state({"schemaVersion": 1})

    assert type(raised.value).__name__ == "DurableWriteError"
    assert not module.STATE_FILE.exists()


def _selfcheck_config(module, tmp_path: Path):
    state = tmp_path / "state"
    return module.SelfcheckConfig(
        root=tmp_path / "root",
        state_dir=state,
        manifest_path=tmp_path / "manifest.json",
        ledger_path=tmp_path / "ledger.json",
        current_link=state / "current",
        deployer_path=tmp_path / "deployer.sh",
        autoheal_off_path=state / "AUTOHEAL_OFF",
        disabled_path=state / "DISABLED",
        lock_path=state / "selfcheck.lock",
        status_path=state / "status.json",
        memory_path=state / "memory.json",
        heartbeat_path=state / "heartbeat.json",
        central_ack_path=None,
        central_down_alert_path=state / "actions" / "central-down-alert.json",
    )


def test_selfcheck_heartbeat_reports_unproven_local_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load("bot-errors-selfcheck.py")
    config = _selfcheck_config(module, tmp_path)
    pushes: list[dict] = []
    deps = module.SelfcheckDeps(
        commit_exists=lambda _sha: True,
        deploy=lambda *_args: (0, ""),
        runtime_verify=lambda *_args: (0, ""),
        push_heartbeat=lambda payload: pushes.append(payload) or {"attempted": True, "ok": True},
        now_epoch=lambda: 1_700_000_000.0,
        hostname=lambda: "fixture",
    )
    monkeypatch.setattr(
        module,
        "publish_state_json",
        lambda *_args, **_kwargs: _unproven(
            "selfcheck.heartbeat",
            generation=1,
        ),
        raising=False,
    )
    status = {"schemaVersion": 1, "checkedAt": module.now_iso(1_700_000_000)}

    module.publish_heartbeat(config, deps, status)

    assert status["heartbeat"]["local"] == "write_failed:DurableWriteError"
    assert status["heartbeat"]["push"] == {"attempted": True, "ok": True}
    assert len(pushes) == 1
    assert not config.heartbeat_path.exists()


def test_selfcheck_finalization_aggregates_memory_and_status_results(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load("bot-errors-selfcheck.py")
    config = _selfcheck_config(module, tmp_path)
    deps = module.SelfcheckDeps(
        commit_exists=lambda _sha: True,
        deploy=lambda *_args: (0, ""),
        runtime_verify=lambda *_args: (0, ""),
        push_heartbeat=lambda _payload: {"attempted": False},
        now_epoch=lambda: 1_700_000_000.0,
        hostname=lambda: "fixture",
    )
    components: list[str] = []

    def publish(_target, _payload, *, component, **_kwargs):
        components.append(component)
        if component == "selfcheck.memory":
            return _committed(component, generation=1)
        return _unproven(component, generation=1)

    monkeypatch.setattr(module, "publish_state_json", publish, raising=False)
    monkeypatch.setattr(module, "publish_central_down_alert", lambda *_args: None)
    monkeypatch.setattr(module, "publish_heartbeat", lambda *_args: None)

    with pytest.raises(RuntimeError) as raised:
        module.finalize_status(
            config,
            deps,
            {"schemaVersion": 1},
            {"schemaVersion": 1},
        )

    assert type(raised.value).__name__ == "DurableWriteError"
    assert components == ["selfcheck.memory", "selfcheck.status"]


def _sentinel_config(module, tmp_path: Path):
    return module.SentinelConfig(
        state_dir=tmp_path / "state",
        hosts_path=tmp_path / "hosts.json",
        oracle_path=None,
        action_outbox_dir=tmp_path / "state" / "actions",
        action_outbox_retention=500,
        heartbeat_max_age_seconds=60,
        hysteresis_cycles=2,
        connectivity_hysteresis_cycles=3,
        flap_window_seconds=300,
        flap_threshold=4,
        max_tier1_heal_candidates=2,
        correlated_drift_freeze_threshold=2,
        max_clock_skew_seconds=300,
        action_event_cooldown_seconds=3600,
        max_critical_whatsapp_per_day=8,
        tier2_token_ttl_seconds=1800,
        q_host="fixture",
    )


def test_sentinel_state_rejects_unproven_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load("bot-errors-sentinel.py")
    config = _sentinel_config(module, tmp_path)
    monkeypatch.setattr(
        module,
        "publish_state_json",
        lambda *_args, **_kwargs: _unproven("sentinel.state", generation=1),
        raising=False,
    )

    with pytest.raises(RuntimeError) as raised:
        module.save_state(config, {"schemaVersion": 1, "hosts": {}})

    assert type(raised.value).__name__ == "DurableWriteError"
    assert not module.state_path(config).exists()


def test_cutover_does_not_advance_profile_when_inventory_is_unproven(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load("bot_errors_cutover.py")
    inventory_path = tmp_path / "inventory.json"
    profiles_dir = tmp_path / "profiles"
    profile_path = profiles_dir / "fixture.json"
    inventory = {
        "hosts": [
            {
                "host": "fixture",
                "profile": "fixture.json",
                "instances": [
                    {"name": "worker", "expected": "blocked", "healthPort": 9000}
                ],
            }
        ]
    }
    profile = {
        "instances": [
            {"name": "worker", "expected": "blocked", "healthPort": 9000}
        ]
    }
    inventory_path.parent.chmod(0o700)
    profiles_dir.mkdir(mode=0o700)
    inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
    profile_path.write_text(json.dumps(profile), encoding="utf-8")
    inventory_path.chmod(0o600)
    profile_path.chmod(0o600)
    components: list[str] = []

    def publish(_target, _payload, *, component, **_kwargs):
        components.append(component)
        return _unproven(component, generation=1)

    monkeypatch.setattr(module, "publish_state_json", publish, raising=False)

    with pytest.raises(RuntimeError) as raised:
        module.restore_service_to_always_on(
            "fixture",
            "worker",
            inventory_path=inventory_path,
            profiles_dir=profiles_dir,
        )

    assert type(raised.value).__name__ == "DurableWriteError"
    assert components == ["cutover.inventory_state"]
    assert json.loads(profile_path.read_text(encoding="utf-8")) == profile


def test_cutover_reports_possible_divergence_when_profile_is_unproven(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load("bot_errors_cutover.py")
    inventory_path = tmp_path / "inventory.json"
    profiles_dir = tmp_path / "profiles"
    profile_path = profiles_dir / "fixture.json"
    inventory = {
        "hosts": [
            {
                "host": "fixture",
                "profile": "fixture.json",
                "instances": [
                    {"name": "worker", "expected": "blocked", "healthPort": 9000}
                ],
            }
        ]
    }
    profile = {
        "instances": [
            {"name": "worker", "expected": "blocked", "healthPort": 9000}
        ]
    }
    profiles_dir.mkdir(mode=0o755)
    inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
    profile_path.write_text(json.dumps(profile), encoding="utf-8")
    inventory_path.chmod(0o644)
    profile_path.chmod(0o644)
    components: list[str] = []

    def publish(_target, _payload, *, component, **_kwargs):
        components.append(component)
        if component == "cutover.inventory_state":
            return _committed(component, generation=1)
        return _unproven(component, generation=1)

    monkeypatch.setattr(module, "publish_state_json", publish, raising=False)

    with pytest.raises(
        module.CutoverError,
        match="surfaces may be divergent",
    ):
        module.restore_service_to_always_on(
            "fixture",
            "worker",
            inventory_path=inventory_path,
            profiles_dir=profiles_dir,
        )

    assert components == ["cutover.inventory_state", "cutover.profile_state"]
