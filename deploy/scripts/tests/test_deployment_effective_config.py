from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib
import json
from pathlib import Path

import pytest


_NOW_MS = 1_700_000_000_000
_CONTEXT = {
    "arc_commit": "a" * 40,
    "qfleet_commit": "b" * 40,
    "whatsoup_commit": "c" * 40,
    "run_context_digest": "d" * 64,
}


@dataclass
class Fixture:
    durable: object
    root: Path
    record_path: Path
    record_target: object
    record: dict[str, object]
    digest: str
    source_paths: dict[str, Path]


def _write_private(path: Path, raw: bytes) -> None:
    path.write_bytes(raw)
    path.chmod(0o600)


def _identity(observation: object) -> dict[str, object]:
    identity = observation.identity
    assert identity is not None
    return {
        "device": str(identity.device),
        "inode": str(identity.inode),
        "size": identity.size,
        "mode": identity.mode,
        "uid": identity.uid,
        "links": identity.nlink,
        "modifiedNs": str(identity.mtime_ns),
        "changedNs": str(identity.ctime_ns),
    }


def _publish(durable: object, target: object, payload: dict[str, object]) -> object:
    absent = durable.JsonVersion(False, None, None, None)
    operation = durable.operation_id(
        target,
        payload,
        component="fixture.effective-config",
        predecessor=absent,
    )
    result = durable.publish_event_json(
        target,
        payload,
        component="fixture.effective-config",
        operation_id=operation,
    )
    assert result.advance_allowed
    return durable.observe_json(target, strict=True)


def _fixture(tmp_path: Path, suffix: str) -> Fixture:
    durable = importlib.import_module("deploy.scripts.lib.durable_json")
    root = tmp_path / f"root-{suffix}"
    root.mkdir(mode=0o700)
    sources_dir = root / "sources"
    sources_dir.mkdir(mode=0o700)
    records_dir = root / "records"
    records_dir.mkdir(mode=0o700)
    source_paths = {
        "binding": sources_dir / "binding.json",
        "inventory": sources_dir / "inventory.json",
        "instance_config": sources_dir / "config.json",
    }
    source_payloads = {
        "binding": {"source": "binding", "fixture": suffix},
        "inventory": {"source": "inventory", "fixture": suffix},
        "instance_config": {"source": "instance", "fixture": suffix},
    }
    sources: dict[str, object] = {}
    for name, path in source_paths.items():
        _write_private(path, json.dumps(source_payloads[name], separators=(",", ":")).encode("utf-8"))
        target = durable.durable_json_target(
            trusted_root=root,
            relative_path=path.relative_to(root),
        )
        observation = durable.observe_json(target, strict=True)
        sources[name] = {
            "root": str(root),
            "path": str(path),
            "raw_sha256": observation.version.raw_sha256,
            "identity": _identity(observation),
        }
    target = {
        "host_ref": f"host_{suffix * 8}",
        "user_ref": f"usr_{suffix * 8}",
        "instance_ref": f"inst_{suffix * 8}",
        "inventory_host": f"host-{suffix}",
        "instance_name": f"agent-{suffix}",
    }
    instance_digest = sources["instance_config"]["raw_sha256"]
    policy_digest = "e" * 64
    record: dict[str, object] = {
        "schema_version": "whatsoup.effective-config.v1",
        "generated_at": "2023-11-14T22:13:20.000Z",
        "context": dict(_CONTEXT),
        "target": target,
        "sources": sources,
        "requested": {},
        "configured": {
            "host": {"tier": "observe"},
            "instance": {"name": f"agent-{suffix}", "type": "agent", "accessMode": "full", "healthPort": 8123},
            "service": {},
            "agentOptions": {},
            "deployment": {
                "uid": 501,
                "home_root": f"/Users/fixture-{suffix}",
                "principal": f"fixture-{suffix}",
                "platform": "macos",
                "service_manager": "launchd",
                "service_domain": "gui",
                "token_file_relative": "tokens/auth.json",
                "token_file": f"/Users/fixture-{suffix}/tokens/auth.json",
            },
        },
        "fields": [
            {
                "field": "configured.instance.name",
                "owner": "whatsoup_instance",
                "source_raw_sha256": instance_digest,
                "presence": "value",
                "value": f"agent-{suffix}",
                "override_reason": None,
            },
            {
                "field": "limits.freshness_seconds",
                "owner": "qualification_policy",
                "source_raw_sha256": policy_digest,
                "presence": "value",
                "value": 300,
                "override_reason": None,
            },
        ],
        "limits": {"timeout_seconds": 5, "max_bytes": 65536, "freshness_seconds": 300},
        "policy_digest": policy_digest,
        "transport_identity": "unresolved",
    }
    record_path = records_dir / "effective.json"
    record_target = durable.durable_json_target(
        trusted_root=root,
        relative_path=record_path.relative_to(root),
    )
    observation = _publish(durable, record_target, record)
    assert observation.version.raw_sha256 is not None
    return Fixture(
        durable=durable,
        root=root,
        record_path=record_path,
        record_target=record_target,
        record=record,
        digest=observation.version.raw_sha256,
        source_paths=source_paths,
    )


def _rewrite_record(fixture: Fixture, payload: dict[str, object] | None = None, raw: bytes | None = None) -> str:
    fixture.record_path.unlink()
    if raw is None:
        assert payload is not None
        raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8") + b"\n"
    _write_private(fixture.record_path, raw)
    return hashlib.sha256(raw).hexdigest()


def _load(module: object, fixture: Fixture, **overrides: object) -> object:
    return module.load_effective_config(
        fixture.record_target,
        expected_sha256=overrides.get("expected_sha256", fixture.digest),
        expected_context=overrides.get("expected_context", fixture.record["context"]),
        expected_target=overrides.get("expected_target", fixture.record["target"]),
        now_ms=overrides.get("now_ms", _NOW_MS),
    )


def test_load_effective_config_accepts_two_bound_private_records(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_effective_config")

    for suffix in ("a", "b"):
        fixture = _fixture(tmp_path, suffix)
        loaded = _load(module, fixture)

        assert loaded["target"] == fixture.record["target"]
        assert loaded["transport_identity"] == "unresolved"


def test_load_effective_config_rejects_changed_and_missing_sources_content_free(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_effective_config")
    changed = _fixture(tmp_path, "c")
    _write_private(changed.source_paths["binding"], b'{"source":"changed"}')
    missing = _fixture(tmp_path, "d")
    missing.source_paths["inventory"].unlink()

    for fixture in (changed, missing):
        with pytest.raises(module.EffectiveConfigRefusal) as raised:
            _load(module, fixture)

        assert str(raised.value) == ""


def test_load_effective_config_rejects_stale_future_context_target_digest_and_version(
    tmp_path: Path,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_effective_config")
    stale = _fixture(tmp_path, "e")
    stale_payload = dict(stale.record)
    stale_payload["generated_at"] = "2023-11-14T22:08:19.999Z"
    stale.digest = _rewrite_record(stale, stale_payload)
    future = _fixture(tmp_path, "f")
    future_payload = dict(future.record)
    future_payload["generated_at"] = "2023-11-14T22:13:20.001Z"
    future.digest = _rewrite_record(future, future_payload)
    version = _fixture(tmp_path, "g")
    version_payload = dict(version.record)
    version_payload["schema_version"] = "whatsoup.effective-config.v2"
    version.digest = _rewrite_record(version, version_payload)

    for fixture in (stale, future, version):
        with pytest.raises(module.EffectiveConfigRefusal) as raised:
            _load(module, fixture)

        assert str(raised.value) == ""
    mixed_context = _fixture(tmp_path, "h")
    mixed_payload = dict(mixed_context.record)
    mixed_payload["context"] = {**_CONTEXT, "qfleet_commit": "f" * 40}
    mixed_context.digest = _rewrite_record(mixed_context, mixed_payload)
    target = _fixture(tmp_path, "i")
    with pytest.raises(module.EffectiveConfigRefusal):
        _load(module, mixed_context)
    with pytest.raises(module.EffectiveConfigRefusal):
        _load(module, target, expected_target={**target.record["target"], "host_ref": "host_z" * 2})
    with pytest.raises(module.EffectiveConfigRefusal):
        _load(module, target, expected_sha256="not-a-digest")


def test_load_effective_config_rejects_unsafe_source_permissions_and_boundary_json(
    tmp_path: Path,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_effective_config")
    unsafe = _fixture(tmp_path, "j")
    unsafe.source_paths["instance_config"].chmod(0o644)
    duplicate = _fixture(tmp_path, "k")
    duplicate.digest = _rewrite_record(
        duplicate,
        raw=b'{"schema_version":"whatsoup.effective-config.v1","schema_version":"whatsoup.effective-config.v1"}\n',
    )
    nonfinite = _fixture(tmp_path, "l")
    nonfinite.digest = _rewrite_record(
        nonfinite,
        raw=b'{"schema_version":"whatsoup.effective-config.v1","limit":NaN}\n',
    )

    for fixture in (unsafe, duplicate, nonfinite):
        with pytest.raises(module.EffectiveConfigRefusal) as raised:
            _load(module, fixture)

        assert str(raised.value) == ""


def test_load_effective_config_binds_digest_before_selecting_recorded_source_roots(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_effective_config")
    fixture = _fixture(tmp_path, "m")
    original_observe = module.durable_json.observe_json
    source_reads = 0

    def count_source_reads(target: object, **kwargs: object) -> object:
        nonlocal source_reads
        if target.logical_target.startswith("sources/"):
            source_reads += 1
        return original_observe(target, **kwargs)

    monkeypatch.setattr(module.durable_json, "observe_json", count_source_reads)

    with pytest.raises(module.EffectiveConfigRefusal):
        _load(module, fixture, expected_sha256="0" * 64)

    assert source_reads == 0


def test_load_effective_config_rechecks_the_record_after_source_observations(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_effective_config")
    fixture = _fixture(tmp_path, "n")
    original_observe = module.durable_json.observe_json
    source_reads = 0
    changed = False

    def change_record_after_sources(target: object, **kwargs: object) -> object:
        nonlocal source_reads, changed
        observation = original_observe(target, **kwargs)
        if target.logical_target.startswith("sources/"):
            source_reads += 1
            if source_reads == 3:
                _write_private(fixture.record_path, b'{"schema_version":"whatsoup.effective-config.v1"}\n')
                changed = True
        return observation

    monkeypatch.setattr(module.durable_json, "observe_json", change_record_after_sources)

    with pytest.raises(module.EffectiveConfigRefusal):
        _load(module, fixture)

    assert changed


def test_load_effective_config_rechecks_sources_changed_during_observation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_effective_config")
    fixture = _fixture(tmp_path, "o")
    original_observe = module.durable_json.observe_json
    source_reads = 0

    def change_first_source_after_last_read(target: object, **kwargs: object) -> object:
        nonlocal source_reads
        observation = original_observe(target, **kwargs)
        if target.logical_target.startswith("sources/"):
            source_reads += 1
            if source_reads == 3:
                _write_private(fixture.source_paths["binding"], b'{"changed":true}')
        return observation

    monkeypatch.setattr(module.durable_json, "observe_json", change_first_source_after_last_read)
    with pytest.raises(module.EffectiveConfigRefusal) as raised:
        _load(module, fixture)
    assert str(raised.value) == ""


def test_load_effective_config_refuses_a_record_expiring_during_observation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_effective_config")
    fixture = _fixture(tmp_path, "p")
    original_observe = module.durable_json.observe_json
    now_ms = _NOW_MS

    def expire_after_source_read(target: object, **kwargs: object) -> object:
        nonlocal now_ms
        observation = original_observe(target, **kwargs)
        if target.logical_target == "sources/config.json":
            now_ms += 301_000
        return observation

    monkeypatch.setattr(module.durable_json, "observe_json", expire_after_source_read)
    monkeypatch.setattr(module.time, "time_ns", lambda: now_ms * 1_000_000)
    with pytest.raises(module.EffectiveConfigRefusal):
        _load(module, fixture, now_ms=None)
