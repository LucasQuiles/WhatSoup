from __future__ import annotations

import hashlib
import importlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import signal
import subprocess
import sys

import pytest


def publication_result(module: object, **overrides: object) -> object:
    values = {
        "component": "fixture.state",
        "durability": module.DurabilityProof.COMMITTED,
        "confinement": module.ConfinementProof.PROVEN,
        "cleanup": module.CleanupState.COMPLETE,
        "authority": module.AuthorityState.INTENDED_AUTHORITATIVE,
        "stage": module.WriteStage.PARENT_SYNC,
        "error_class": None,
        "generation": 3,
        "private_operation_id": "private-operation-id",
        "private_content_sha256": "private-content-digest",
    }
    values.update(overrides)
    return module.PublicationResult(**values)


def test_durable_json_contract_is_importable() -> None:
    try:
        module = importlib.import_module("deploy.scripts.lib.durable_json")
    except ModuleNotFoundError:
        pytest.fail("durable_json contract is not importable")

    required = {
        "durable_json_target",
        "observe_json",
        "operation_id",
        "publish_event_json",
        "publish_state_json",
        "reconcile_json_publication",
        "sync_changed_parents",
        "require_advance",
    }
    assert required <= set(dir(module))


def test_outcome_types_are_closed_and_complete() -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    required_types = {
        "DurabilityProof",
        "ConfinementProof",
        "CleanupState",
        "AuthorityState",
        "WriteStage",
        "ErrorClass",
        "DurableWriteError",
        "DurableJsonTarget",
        "JsonVersion",
        "JsonObservation",
        "JsonPublicationIntent",
        "ParentSyncResult",
        "PublicationKind",
        "PublicationResult",
    }
    assert required_types <= set(dir(module))


def test_require_advance_rejects_unproven_without_private_identifiers() -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    result = publication_result(
        module,
        durability=module.DurabilityProof.UNPROVEN,
        authority=module.AuthorityState.EXPECTED_PREDECESSOR,
        error_class=module.ErrorClass.IO,
    )

    with pytest.raises(module.DurableWriteError) as raised:
        module.require_advance(result)

    message = str(raised.value)
    assert "private-operation-id" not in message
    assert "private-content-digest" not in message
    assert "unproven" in message


def test_advance_requires_every_closed_proof_axis() -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    assert publication_result(module).advance_allowed
    assert publication_result(
        module,
        durability=module.DurabilityProof.RECONCILED_COMMITTED,
        cleanup=module.CleanupState.DEBT_PRIVATE_TEMP,
    ).advance_allowed

    blocked = [
        {"durability": module.DurabilityProof.NOT_MUTATED},
        {"durability": module.DurabilityProof.UNPROVEN},
        {"confinement": module.ConfinementProof.UNPROVEN},
        {"confinement": module.ConfinementProof.VIOLATED},
        {"authority": module.AuthorityState.EXPECTED_PREDECESSOR},
        {"authority": module.AuthorityState.SUPERSEDED},
        {"authority": module.AuthorityState.CONFLICT},
        {"authority": module.AuthorityState.UNKNOWN},
        {"cleanup": module.CleanupState.DEBT_RECOVERY_RECORD},
    ]
    assert all(not publication_result(module, **overrides).advance_allowed for overrides in blocked)


def test_public_projection_is_closed_and_omits_private_values() -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    projection = publication_result(module).public_projection()
    assert set(projection) == {
        "component",
        "durability",
        "confinement",
        "cleanup",
        "authority",
        "stage",
        "error_class",
        "generation",
    }
    rendered = repr(projection)
    assert "private-operation-id" not in rendered
    assert "private-content-digest" not in rendered


def test_target_factory_rejects_lexical_escape(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    with pytest.raises(module.DurableWriteError):
        module.durable_json_target(
            trusted_root=tmp_path,
            relative_path="../escape.json",
        )


def test_target_factory_rejects_empty_root_components(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    with pytest.raises(module.DurableWriteError):
        module.durable_json_target(
            trusted_root=f"{tmp_path}//nested",
            relative_path="state/current.json",
        )


def test_operation_id_is_canonical_and_predecessor_fenced(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/fixture.json",
    )
    absent = module.JsonVersion(False, None, None, None)
    predecessor = module.JsonVersion(True, "previous-digest", 2, "previous-operation")

    first = module.operation_id(
        target,
        {"alpha": 1, "beta": ["x", True]},
        component="fixture.state",
        predecessor=absent,
    )
    reordered = module.operation_id(
        target,
        {"beta": ["x", True], "alpha": 1},
        component="fixture.state",
        predecessor=absent,
    )
    advanced = module.operation_id(
        target,
        {"alpha": 1, "beta": ["x", True]},
        component="fixture.state",
        predecessor=predecessor,
    )

    assert first == reordered
    assert first != advanced
    assert len(first) == 64


def test_operation_id_rejects_non_string_mapping_keys(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/fixture.json",
    )

    with pytest.raises(module.DurableWriteError):
        module.operation_id(
            target,
            {1: "ambiguous"},
            component="fixture.state",
            predecessor=module.JsonVersion(False, None, None, None),
        )


@pytest.mark.parametrize(
    ("payload", "error_class"),
    [
        ({"value": float("nan")}, "serialization"),
        ({"value": object()}, "serialization"),
        ({"value": 2**53}, "serialization"),
    ],
)
def test_event_rejects_ambiguous_or_unsupported_json_before_mutation(
    tmp_path: Path,
    payload: dict[str, object],
    error_class: str,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id="untrusted-operation",
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.stage is module.WriteStage.SERIALIZATION
    assert result.error_class.value == error_class
    assert not (tmp_path / "state" / "event.json").exists()
    assert list((tmp_path / "state").glob(".durable-json.*.tmp")) == []


def test_event_rejects_cyclic_json_before_mutation(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload: dict[str, object] = {}
    payload["cycle"] = payload

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id="untrusted-operation",
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.stage is module.WriteStage.SERIALIZATION
    assert result.error_class is module.ErrorClass.SERIALIZATION
    assert not (tmp_path / "state" / "event.json").exists()


def test_event_rejects_oversized_json_before_mutation(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )

    result = module.publish_event_json(
        target,
        {"value": "x" * (8 * 1024 * 1024)},
        component="fixture.event",
        operation_id="untrusted-operation",
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.stage is module.WriteStage.SERIALIZATION
    assert result.error_class is module.ErrorClass.SIZE
    assert not (tmp_path / "state" / "event.json").exists()


@pytest.mark.parametrize("failure", ["short_write", "enospc"])
def test_event_write_failures_do_not_publish(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )

    def fail_write(_descriptor: int, _raw: bytes) -> int:
        if failure == "enospc":
            raise OSError(module.errno.ENOSPC, "injected")
        return 0

    monkeypatch.setattr(module.os, "write", fail_write)

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.stage is module.WriteStage.WRITE
    assert result.error_class is module.ErrorClass.IO
    assert not result.advance_allowed
    assert not (tmp_path / "state/event.json").exists()
    assert list((tmp_path / "state").glob(".durable-json.*.tmp")) == []


def test_event_file_sync_failure_does_not_publish(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )
    real_fsync = module.os.fsync
    calls = 0

    def fail_payload_sync(descriptor: int) -> None:
        nonlocal calls
        calls += 1
        if calls == 3:
            raise OSError(module.errno.ENOSPC, "injected")
        real_fsync(descriptor)

    monkeypatch.setattr(module.os, "fsync", fail_payload_sync)

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.stage is module.WriteStage.FILE_SYNC
    assert result.error_class is module.ErrorClass.IO
    assert not (tmp_path / "state/event.json").exists()


def test_event_permission_finalization_failure_does_not_publish(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )
    real_fchmod = module.os.fchmod
    calls = 0

    def deny_payload_mode(descriptor: int, mode: int) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError(module.errno.EACCES, "injected")
        real_fchmod(descriptor, mode)

    monkeypatch.setattr(module.os, "fchmod", deny_payload_mode)

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.stage is module.WriteStage.PERMISSION_FINALIZATION
    assert result.error_class is module.ErrorClass.PERMISSION
    assert not (tmp_path / "state/event.json").exists()


def test_event_final_mode_ignores_ambient_umask(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )
    previous_umask = module.os.umask(0)
    try:
        result = module.publish_event_json(
            target,
            payload,
            component="fixture.event",
            operation_id=op_id,
        )
    finally:
        module.os.umask(previous_umask)

    assert result.advance_allowed
    assert (tmp_path / "state/event.json").stat().st_mode & 0o777 == 0o600


def test_event_private_temporary_cleanup_debt_is_explicit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )
    temp_name = f".durable-json.{op_id}.tmp"
    real_unlink = module.os.unlink

    def preserve_private_temp(path: object, *args: object, **kwargs: object) -> None:
        if path == temp_name:
            raise OSError(module.errno.EACCES, "injected")
        real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(module.os, "unlink", preserve_private_temp)

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
    )

    assert result.durability is module.DurabilityProof.COMMITTED
    assert result.cleanup is module.CleanupState.DEBT_PRIVATE_TEMP
    assert result.advance_allowed
    assert (state / "event.json").exists()
    assert (state / temp_name).exists()


def test_event_rejects_private_temporary_with_unexpected_hard_link(
    tmp_path: Path,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    operation = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )
    alias = state / "unexpected-link"

    def add_link(stage: object) -> None:
        if stage is module.WriteStage.WRITE:
            alias.hardlink_to(state / f".durable-json.{operation}.tmp")

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=operation,
        _fault_hook=add_link,
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.stage is module.WriteStage.PERMISSION_FINALIZATION
    assert result.error_class is module.ErrorClass.IDENTITY_TYPE
    assert not result.advance_allowed
    assert not (state / "event.json").exists()
    assert alias.read_bytes() == b'{"id":"event-1"}\n'


def test_exclusive_temporary_collision_is_preserved_as_recovery_debt(
    tmp_path: Path,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )
    stale = state / f".durable-json.{op_id}.tmp"
    stale.write_bytes(b"unverified-stale-bytes")
    stale.chmod(0o600)

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.cleanup is module.CleanupState.DEBT_RECOVERY_RECORD
    assert not result.advance_allowed
    assert stale.read_bytes() == b"unverified-stale-bytes"
    assert not (state / "event.json").exists()


def test_state_temporary_collision_blocks_replacement(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    payload = {"status": "ready"}
    absent = module.JsonVersion(False, None, None, None)
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.state",
        predecessor=absent,
    )
    stale = state / f".durable-json.{op_id}.tmp"
    stale.write_bytes(b"unverified-stale-bytes")
    stale.chmod(0o600)

    result = module.publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=absent,
        generation=1,
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.cleanup is module.CleanupState.DEBT_RECOVERY_RECORD
    assert not result.advance_allowed
    assert stale.read_bytes() == b"unverified-stale-bytes"
    assert not (state / "current.json").exists()


@pytest.mark.parametrize("exhaustion_name", ["EMFILE", "ENFILE"])
def test_parent_descriptor_exhaustion_is_typed_and_inconclusive(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    exhaustion_name: str,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )
    real_open = module.os.open

    def exhaust_on_state(path: object, flags: int, *args: object, **kwargs: object) -> int:
        if path == "state":
            raise OSError(getattr(module.errno, exhaustion_name), "injected")
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(module.os, "open", exhaust_on_state)

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.confinement is module.ConfinementProof.UNPROVEN
    assert result.error_class is module.ErrorClass.DESCRIPTOR_EXHAUSTION
    assert result.stage is module.WriteStage.PARENT_OPEN
    assert not result.advance_allowed


def test_lock_permission_failure_is_typed_before_mutation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )
    real_open = module.os.open

    def deny_lock(path: object, flags: int, *args: object, **kwargs: object) -> int:
        if path == ".durable-json.lock":
            raise OSError(module.errno.EACCES, "injected")
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(module.os, "open", deny_lock)

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.confinement is module.ConfinementProof.PROVEN
    assert result.error_class is module.ErrorClass.PERMISSION
    assert result.stage is module.WriteStage.LOCK_ACQUISITION
    assert not result.advance_allowed


def test_parent_substitution_after_validation_cannot_escape_or_advance(
    tmp_path: Path,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    validated = tmp_path / "validated-parent"
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )

    def substitute(stage: object) -> None:
        if stage is module.WriteStage.PARENT_OPEN:
            state.rename(validated)
            state.symlink_to(outside, target_is_directory=True)

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
        _fault_hook=substitute,
    )

    assert (validated / "event.json").exists()
    assert not (outside / "event.json").exists()
    assert result.confinement is module.ConfinementProof.PROVEN
    assert result.authority is module.AuthorityState.UNKNOWN
    assert not result.advance_allowed


def test_observe_json_reports_an_absent_target(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/fixture.json",
    )

    observation = module.observe_json(target)

    assert observation.payload is None
    assert observation.version == module.JsonVersion(False, None, None, None)


def test_observe_json_reads_a_regular_bounded_record(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    payload = {
        "schemaVersion": 1,
        "generation": 4,
        "operationId": "fixture-operation",
        "value": "ok",
    }
    raw = b'{"generation":4,"operationId":"fixture-operation","schemaVersion":1,"value":"ok"}\n'
    record = state / "fixture.json"
    record.write_bytes(raw)
    record.chmod(0o600)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/fixture.json",
    )

    observation = module.observe_json(target)

    assert observation.payload == payload
    assert observation.version.exists
    assert observation.version.raw_sha256 == hashlib.sha256(raw).hexdigest()
    assert observation.version.generation == 4
    assert observation.version.operation_id == "fixture-operation"


def test_publish_event_json_commits_create_once_bytes(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1", "severity": "critical"}
    absent = module.JsonVersion(False, None, None, None)
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=absent,
    )

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
    )

    assert result.advance_allowed
    assert result.durability is module.DurabilityProof.COMMITTED
    assert result.authority is module.AuthorityState.INTENDED_AUTHORITATIVE
    assert (state / "event.json").read_bytes() == b'{"id":"event-1","severity":"critical"}\n'


def test_publish_event_json_reconciles_same_operation(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1", "severity": "critical"}
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )
    first = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
    )

    replay = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
    )

    assert first.advance_allowed
    assert replay.advance_allowed
    assert replay.durability is module.DurabilityProof.RECONCILED_COMMITTED
    assert replay.authority is module.AuthorityState.INTENDED_AUTHORITATIVE


def test_publish_event_json_does_not_clobber_different_existing_bytes(
    tmp_path: Path,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    existing = state / "event.json"
    existing.write_text('{"id":"other"}\n', encoding="utf-8")
    existing.chmod(0o600)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    operation = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=operation,
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.authority is module.AuthorityState.CONFLICT
    assert result.error_class is module.ErrorClass.CONFLICT
    assert not result.advance_allowed
    assert existing.read_bytes() == b'{"id":"other"}\n'


def test_publish_state_json_replaces_the_expected_generation(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    payload = {"status": "ready", "version": 1}
    absent = module.JsonVersion(False, None, None, None)
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.state",
        predecessor=absent,
    )

    result = module.publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=absent,
        generation=1,
    )

    assert result.advance_allowed
    assert result.durability is module.DurabilityProof.COMMITTED
    assert result.generation == 1
    assert (tmp_path / "state/current.json").read_bytes() == b'{"status":"ready","version":1}\n'


def test_state_replace_exdev_is_prepublication_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    payload = {"generation": 1, "status": "ready"}
    absent = module.JsonVersion(False, None, None, None)
    operation = module.operation_id(
        target,
        payload,
        component="fixture.state",
        predecessor=absent,
    )

    def fail_replace(*_args: object, **_kwargs: object) -> None:
        raise OSError(module.errno.EXDEV, "injected")

    monkeypatch.setattr(module.os, "replace", fail_replace)
    result = module.publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=operation,
        expected=absent,
        generation=1,
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.authority is module.AuthorityState.EXPECTED_PREDECESSOR
    assert result.stage is module.WriteStage.PUBLICATION
    assert result.error_class is module.ErrorClass.IO
    assert not result.advance_allowed
    assert not (tmp_path / "state" / "current.json").exists()


def test_state_generation_cannot_move_backwards(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    absent = module.JsonVersion(False, None, None, None)
    current_payload = {"generation": 2, "status": "current"}
    current_op = module.operation_id(
        target,
        current_payload,
        component="fixture.state",
        predecessor=absent,
    )
    first = module.publish_state_json(
        target,
        current_payload,
        component="fixture.state",
        operation_id=current_op,
        expected=absent,
        generation=2,
    )
    expected = module.observe_json(target).version
    stale_payload = {"generation": 1, "status": "stale"}
    stale_op = module.operation_id(
        target,
        stale_payload,
        component="fixture.state",
        predecessor=expected,
    )

    stale = module.publish_state_json(
        target,
        stale_payload,
        component="fixture.state",
        operation_id=stale_op,
        expected=expected,
        generation=1,
    )

    assert first.advance_allowed
    assert stale.durability is module.DurabilityProof.NOT_MUTATED
    assert stale.authority is module.AuthorityState.SUPERSEDED
    assert not stale.advance_allowed
    assert module.observe_json(target).payload == current_payload


def test_observe_json_rejects_a_symlinked_intermediate(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    (tmp_path / "state").symlink_to(outside, target_is_directory=True)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )

    with pytest.raises(module.DurableWriteError):
        module.observe_json(target)


def test_observe_json_rejects_a_weakened_intermediate_mode(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o755)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )

    with pytest.raises(module.DurableWriteError):
        module.observe_json(target)


def test_observe_json_rejects_a_hard_linked_target(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    record = state / "current.json"
    record.write_text('{"status":"ready"}\n', encoding="utf-8")
    record.chmod(0o600)
    (state / "alias.json").hardlink_to(record)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )

    with pytest.raises(module.DurableWriteError):
        module.observe_json(target)


@pytest.mark.parametrize("leaf_kind", ["symlink", "directory"])
def test_observe_json_rejects_non_regular_leaf(
    tmp_path: Path,
    leaf_kind: str,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    leaf = state / "current.json"
    if leaf_kind == "symlink":
        leaf.symlink_to(state / "missing.json")
    else:
        leaf.mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )

    with pytest.raises(module.DurableWriteError):
        module.observe_json(target)


@pytest.mark.parametrize("missing", ["fcntl", "nofollow"])
def test_missing_confinement_capability_fails_before_mutation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    missing: str,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    operation = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )
    if missing == "fcntl":
        monkeypatch.setattr(module, "fcntl", None)
    else:
        monkeypatch.setattr(module.os, "O_NOFOLLOW", 0)

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=operation,
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.stage is module.WriteStage.CAPABILITY_CHECK
    assert result.error_class is module.ErrorClass.UNSUPPORTED_CAPABILITY
    assert not result.advance_allowed
    assert not (tmp_path / "state" / "event.json").exists()


def test_observe_json_refuses_missing_no_follow_capability(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    record = state / "current.json"
    record.write_text('{"status":"ready"}\n', encoding="utf-8")
    record.chmod(0o600)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    monkeypatch.setattr(module.os, "O_NOFOLLOW", 0)

    with pytest.raises(module.DurableWriteError) as raised:
        module.observe_json(target)

    assert raised.value.error_class is module.ErrorClass.UNSUPPORTED_CAPABILITY


def test_publish_event_json_reports_confinement_violation_without_escape(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    (tmp_path / "state").symlink_to(outside, target_is_directory=True)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
    )

    assert result.durability is module.DurabilityProof.NOT_MUTATED
    assert result.confinement is module.ConfinementProof.VIOLATED
    assert not result.advance_allowed
    assert not (outside / "event.json").exists()


def test_event_parent_sync_interruption_requires_reconciliation(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )

    def interrupt(stage: object) -> None:
        if stage is module.WriteStage.PARENT_SYNC:
            raise InterruptedError

    interrupted = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
        _fault_hook=interrupt,
    )
    reconciled = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
    )

    assert interrupted.durability is module.DurabilityProof.UNPROVEN
    assert not interrupted.advance_allowed
    assert reconciled.durability is module.DurabilityProof.RECONCILED_COMMITTED
    assert reconciled.advance_allowed


def test_state_parent_sync_interruption_requires_reconciliation(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    payload = {"status": "ready"}
    absent = module.JsonVersion(False, None, None, None)
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.state",
        predecessor=absent,
    )

    def interrupt(stage: object) -> None:
        if stage is module.WriteStage.PARENT_SYNC:
            raise InterruptedError

    interrupted = module.publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=absent,
        generation=1,
        _fault_hook=interrupt,
    )
    reconciled = module.publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=absent,
        generation=1,
    )

    assert interrupted.durability is module.DurabilityProof.UNPROVEN
    assert not interrupted.advance_allowed
    assert reconciled.durability is module.DurabilityProof.RECONCILED_COMMITTED
    assert reconciled.advance_allowed


@pytest.mark.parametrize(
    "stage_name",
    [
        "SERIALIZATION",
        "CAPABILITY_CHECK",
        "PARENT_OPEN",
        "LOCK_ACQUISITION",
        "TEMPORARY_CREATION",
        "WRITE",
        "FILE_FLUSH",
        "FILE_SYNC",
        "PERMISSION_FINALIZATION",
        "PUBLICATION",
        "CLEANUP",
        "PARENT_SYNC",
    ],
)
def test_event_interruptions_never_become_success(tmp_path: Path, stage_name: str) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )
    fault_stage = getattr(module.WriteStage, stage_name)

    def interrupt(stage: object) -> None:
        if stage is fault_stage:
            raise InterruptedError

    result = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
        _fault_hook=interrupt,
    )

    assert not result.advance_allowed
    assert result.stage is fault_stage
    assert result.error_class is module.ErrorClass.INTERRUPTION
    if stage_name in {"PUBLICATION", "CLEANUP", "PARENT_SYNC"}:
        assert result.durability is module.DurabilityProof.UNPROVEN
        assert (tmp_path / "state/event.json").exists()
    else:
        assert result.durability is module.DurabilityProof.NOT_MUTATED
        assert not (tmp_path / "state/event.json").exists()


@pytest.mark.parametrize(
    "stage_name",
    [
        "SERIALIZATION",
        "CAPABILITY_CHECK",
        "PARENT_OPEN",
        "LOCK_ACQUISITION",
        "RECONCILIATION",
        "TEMPORARY_CREATION",
        "WRITE",
        "FILE_FLUSH",
        "FILE_SYNC",
        "PERMISSION_FINALIZATION",
        "PUBLICATION",
        "PARENT_SYNC",
    ],
)
def test_state_interruptions_never_become_success(tmp_path: Path, stage_name: str) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    payload = {"status": "ready"}
    absent = module.JsonVersion(False, None, None, None)
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.state",
        predecessor=absent,
    )
    fault_stage = getattr(module.WriteStage, stage_name)

    def interrupt(stage: object) -> None:
        if stage is fault_stage:
            raise InterruptedError

    result = module.publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=absent,
        generation=1,
        _fault_hook=interrupt,
    )

    assert not result.advance_allowed
    assert result.stage is fault_stage
    assert result.error_class is module.ErrorClass.INTERRUPTION
    if stage_name in {"PUBLICATION", "PARENT_SYNC"}:
        assert result.durability is module.DurabilityProof.UNPROVEN
        assert (tmp_path / "state/current.json").exists()
    else:
        assert result.durability is module.DurabilityProof.NOT_MUTATED
        assert not (tmp_path / "state/current.json").exists()


def test_concurrent_event_writers_converge_on_one_operation(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=module.JsonVersion(False, None, None, None),
    )

    def publish() -> object:
        return module.publish_event_json(
            target,
            payload,
            component="fixture.event",
            operation_id=op_id,
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _index: publish(), range(8)))

    assert all(result.advance_allowed for result in results)
    assert sum(result.durability is module.DurabilityProof.COMMITTED for result in results) == 1
    assert sum(
        result.durability is module.DurabilityProof.RECONCILED_COMMITTED
        for result in results
    ) == 7


def test_concurrent_state_writers_fence_the_same_predecessor(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    absent = module.JsonVersion(False, None, None, None)
    payloads = [{"winner": "alpha"}, {"winner": "beta"}]

    def publish(payload: dict[str, str]) -> object:
        op_id = module.operation_id(
            target,
            payload,
            component="fixture.state",
            predecessor=absent,
        )
        return module.publish_state_json(
            target,
            payload,
            component="fixture.state",
            operation_id=op_id,
            expected=absent,
            generation=1,
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(publish, payloads))

    assert sum(result.advance_allowed for result in results) == 1
    assert sum(
        result.authority is module.AuthorityState.CONFLICT for result in results
    ) == 1, json.dumps([result.public_projection() for result in results], sort_keys=True)
    assert (tmp_path / "state/current.json").read_text(encoding="utf-8") in {
        '{"winner":"alpha"}\n',
        '{"winner":"beta"}\n',
    }


def test_concurrent_event_and_state_writers_share_one_parent_fence(
    tmp_path: Path,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    event_target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    state_target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    absent = module.JsonVersion(False, None, None, None)
    event_payload = {"id": "event-1"}
    state_payload = {"generation": 1, "status": "ready"}
    event_operation = module.operation_id(
        event_target,
        event_payload,
        component="fixture.event",
        predecessor=absent,
    )
    state_operation = module.operation_id(
        state_target,
        state_payload,
        component="fixture.state",
        predecessor=absent,
    )

    def publish_event() -> object:
        return module.publish_event_json(
            event_target,
            event_payload,
            component="fixture.event",
            operation_id=event_operation,
        )

    def publish_state() -> object:
        return module.publish_state_json(
            state_target,
            state_payload,
            component="fixture.state",
            operation_id=state_operation,
            expected=absent,
            generation=1,
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        event_future = pool.submit(publish_event)
        state_future = pool.submit(publish_state)
        event_result = event_future.result()
        state_result = state_future.result()

    assert event_result.advance_allowed
    assert state_result.advance_allowed
    assert module.observe_json(event_target).payload == event_payload
    assert module.observe_json(state_target).payload == state_payload


def test_sync_changed_parents_uses_one_barrier_for_one_parent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    (state / ".durable-json.lock").write_bytes(b"")
    (state / ".durable-json.lock").chmod(0o600)
    destination = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/destination.json",
    )
    source = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/source.json",
    )
    real_fsync = module.os.fsync
    barriers: list[tuple[int, int]] = []

    def record_fsync(descriptor: int) -> None:
        observed = module.os.fstat(descriptor)
        barriers.append((observed.st_dev, observed.st_ino))
        real_fsync(descriptor)

    monkeypatch.setattr(module.os, "fsync", record_fsync)

    result = module.sync_changed_parents(destination, source)

    assert result.advance_allowed
    assert result.same_parent
    assert result.destination_synced
    assert result.source_synced
    assert len(barriers) == 1


def test_sync_changed_parents_orders_destination_before_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    destination_dir = tmp_path / "destination"
    source_dir = tmp_path / "source"
    destination_dir.mkdir(mode=0o700)
    source_dir.mkdir(mode=0o700)
    for directory in (destination_dir, source_dir):
        (directory / ".durable-json.lock").write_bytes(b"")
        (directory / ".durable-json.lock").chmod(0o600)
    destination = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="destination/event.json",
    )
    source = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="source/event.json",
    )
    real_fsync = module.os.fsync
    barriers: list[tuple[int, int]] = []

    def record_fsync(descriptor: int) -> None:
        observed = module.os.fstat(descriptor)
        barriers.append((observed.st_dev, observed.st_ino))
        real_fsync(descriptor)

    monkeypatch.setattr(module.os, "fsync", record_fsync)

    result = module.sync_changed_parents(destination, source)

    destination_stat = destination_dir.stat()
    source_stat = source_dir.stat()
    assert result.advance_allowed
    assert not result.same_parent
    assert barriers == [
        (destination_stat.st_dev, destination_stat.st_ino),
        (source_stat.st_dev, source_stat.st_ino),
    ]


def test_sync_changed_parents_locks_unique_parents_in_canonical_order(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    destination_dir = tmp_path / "destination"
    source_dir = tmp_path / "source"
    destination_dir.mkdir(mode=0o700)
    source_dir.mkdir(mode=0o700)
    for directory in (destination_dir, source_dir):
        (directory / ".durable-json.lock").write_bytes(b"")
        (directory / ".durable-json.lock").chmod(0o600)
    destination = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="destination/record.json",
    )
    source = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="source/record.json",
    )
    observed: list[tuple[int, int]] = []
    real_lock = module._lock_parent

    def record_lock(parent_fd: int) -> int:
        parent_stat = module.os.fstat(parent_fd)
        observed.append((parent_stat.st_dev, parent_stat.st_ino))
        return real_lock(parent_fd)

    monkeypatch.setattr(module, "_lock_parent", record_lock)

    result = module.sync_changed_parents(destination, source)

    assert result.advance_allowed
    assert len(observed) == 2
    assert observed == sorted(set(observed))


def test_sync_changed_parents_reports_the_failed_source_barrier(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    destination_dir = tmp_path / "destination"
    source_dir = tmp_path / "source"
    destination_dir.mkdir(mode=0o700)
    source_dir.mkdir(mode=0o700)
    for directory in (destination_dir, source_dir):
        (directory / ".durable-json.lock").write_bytes(b"")
        (directory / ".durable-json.lock").chmod(0o600)
    destination = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="destination/event.json",
    )
    source = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="source/event.json",
    )
    real_fsync = module.os.fsync
    calls = 0

    def fail_second_fsync(descriptor: int) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("injected source barrier failure")
        real_fsync(descriptor)

    monkeypatch.setattr(module.os, "fsync", fail_second_fsync)

    result = module.sync_changed_parents(destination, source)

    assert not result.advance_allowed
    assert result.destination_synced
    assert not result.source_synced
    assert result.failed_parent == "source"
    assert result.error_class is module.ErrorClass.IO


def test_sync_changed_parents_reports_unsupported_directory_sync(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    (state / ".durable-json.lock").write_bytes(b"")
    (state / ".durable-json.lock").chmod(0o600)
    destination = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/destination.json",
    )
    source = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/source.json",
    )

    def unsupported(_descriptor: int) -> None:
        raise OSError(module.errno.EINVAL, "injected")

    monkeypatch.setattr(module.os, "fsync", unsupported)

    result = module.sync_changed_parents(destination, source)

    assert not result.advance_allowed
    assert result.failed_parent == "destination"
    assert result.error_class is module.ErrorClass.UNSUPPORTED_CAPABILITY


def test_reconcile_json_publication_proves_intended_event_bytes(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    absent = module.JsonVersion(False, None, None, None)
    op_id = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=absent,
    )
    intent = module.JsonPublicationIntent(
        kind=module.PublicationKind.EVENT,
        target=target,
        payload=payload,
        component="fixture.event",
        operation_id=op_id,
        generation=None,
    )
    committed = module.publish_event_json(
        target,
        payload,
        component="fixture.event",
        operation_id=op_id,
    )

    reconciled = module.reconcile_json_publication(intent, absent)

    assert committed.advance_allowed
    assert reconciled.advance_allowed
    assert reconciled.durability is module.DurabilityProof.RECONCILED_COMMITTED
    assert reconciled.authority is module.AuthorityState.INTENDED_AUTHORITATIVE


def test_reconcile_state_reports_expected_predecessor_without_republishing(
    tmp_path: Path,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    absent = module.JsonVersion(False, None, None, None)
    previous_payload = {"generation": 1, "status": "previous"}
    previous_operation = module.operation_id(
        target,
        previous_payload,
        component="fixture.state",
        predecessor=absent,
    )
    published = module.publish_state_json(
        target,
        previous_payload,
        component="fixture.state",
        operation_id=previous_operation,
        expected=absent,
        generation=1,
    )
    assert published.advance_allowed
    previous = module.observe_json(target).version
    intended_payload = {"generation": 2, "status": "intended"}
    intended_operation = module.operation_id(
        target,
        intended_payload,
        component="fixture.state",
        predecessor=previous,
    )
    intent = module.JsonPublicationIntent(
        kind=module.PublicationKind.STATE,
        target=target,
        payload=intended_payload,
        component="fixture.state",
        operation_id=intended_operation,
        generation=2,
    )

    reconciled = module.reconcile_json_publication(intent, previous)

    assert reconciled.durability is module.DurabilityProof.NOT_MUTATED
    assert reconciled.authority is module.AuthorityState.EXPECTED_PREDECESSOR
    assert reconciled.error_class is None
    assert not reconciled.advance_allowed
    assert module.observe_json(target).payload == previous_payload


def test_reconcile_state_reports_superseded_generation(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    absent = module.JsonVersion(False, None, None, None)
    current_payload = {"generation": 3, "status": "newer"}
    current_operation = module.operation_id(
        target,
        current_payload,
        component="fixture.state",
        predecessor=absent,
    )
    assert module.publish_state_json(
        target,
        current_payload,
        component="fixture.state",
        operation_id=current_operation,
        expected=absent,
        generation=3,
    ).advance_allowed
    previous = module.JsonVersion(True, "older-digest", 1, None)
    intended_payload = {"generation": 2, "status": "intended"}
    intended_operation = module.operation_id(
        target,
        intended_payload,
        component="fixture.state",
        predecessor=previous,
    )
    intent = module.JsonPublicationIntent(
        kind=module.PublicationKind.STATE,
        target=target,
        payload=intended_payload,
        component="fixture.state",
        operation_id=intended_operation,
        generation=2,
    )

    reconciled = module.reconcile_json_publication(intent, previous)

    assert reconciled.durability is module.DurabilityProof.NOT_MUTATED
    assert reconciled.authority is module.AuthorityState.SUPERSEDED
    assert reconciled.error_class is module.ErrorClass.CONFLICT
    assert not reconciled.advance_allowed


def test_reconcile_state_reports_conflicting_authority(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    current = state / "current.json"
    current.write_text('{"generation":1,"status":"other"}\n', encoding="utf-8")
    current.chmod(0o600)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    previous = module.JsonVersion(True, "different-digest", 1, None)
    intended_payload = {"generation": 2, "status": "intended"}
    intended_operation = module.operation_id(
        target,
        intended_payload,
        component="fixture.state",
        predecessor=previous,
    )
    intent = module.JsonPublicationIntent(
        kind=module.PublicationKind.STATE,
        target=target,
        payload=intended_payload,
        component="fixture.state",
        operation_id=intended_operation,
        generation=2,
    )

    reconciled = module.reconcile_json_publication(intent, previous)

    assert reconciled.durability is module.DurabilityProof.NOT_MUTATED
    assert reconciled.authority is module.AuthorityState.CONFLICT
    assert reconciled.error_class is module.ErrorClass.CONFLICT
    assert not reconciled.advance_allowed


def test_reconcile_malformed_target_is_unproven(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    current = state / "current.json"
    current.write_text("{malformed\n", encoding="utf-8")
    current.chmod(0o600)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    previous = module.JsonVersion(False, None, None, None)
    payload = {"generation": 1, "status": "intended"}
    operation = module.operation_id(
        target,
        payload,
        component="fixture.state",
        predecessor=previous,
    )
    intent = module.JsonPublicationIntent(
        kind=module.PublicationKind.STATE,
        target=target,
        payload=payload,
        component="fixture.state",
        operation_id=operation,
        generation=1,
    )

    reconciled = module.reconcile_json_publication(intent, previous)

    assert reconciled.durability is module.DurabilityProof.UNPROVEN
    assert reconciled.authority is module.AuthorityState.UNKNOWN
    assert reconciled.error_class is module.ErrorClass.SERIALIZATION
    assert not reconciled.advance_allowed


def test_reconcile_absent_target_with_existing_predecessor_is_unknown(
    tmp_path: Path,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    previous = module.JsonVersion(True, "previous-digest", 1, None)
    payload = {"generation": 2, "status": "intended"}
    operation = module.operation_id(
        target,
        payload,
        component="fixture.state",
        predecessor=previous,
    )
    intent = module.JsonPublicationIntent(
        kind=module.PublicationKind.STATE,
        target=target,
        payload=payload,
        component="fixture.state",
        operation_id=operation,
        generation=2,
    )

    reconciled = module.reconcile_json_publication(intent, previous)

    assert reconciled.durability is module.DurabilityProof.NOT_MUTATED
    assert reconciled.authority is module.AuthorityState.UNKNOWN
    assert not reconciled.advance_allowed


def test_reconcile_matching_bytes_with_unknown_parent_authority_does_not_advance(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    previous = module.JsonVersion(False, None, None, None)
    payload = {"generation": 1, "status": "intended"}
    operation = module.operation_id(
        target,
        payload,
        component="fixture.state",
        predecessor=previous,
    )
    assert module.publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=operation,
        expected=previous,
        generation=1,
    ).advance_allowed
    intent = module.JsonPublicationIntent(
        kind=module.PublicationKind.STATE,
        target=target,
        payload=payload,
        component="fixture.state",
        operation_id=operation,
        generation=1,
    )
    monkeypatch.setattr(module, "_parent_authority_matches", lambda *_args: False)

    reconciled = module.reconcile_json_publication(intent, previous)

    assert reconciled.durability is module.DurabilityProof.RECONCILED_COMMITTED
    assert reconciled.authority is module.AuthorityState.UNKNOWN
    assert not reconciled.advance_allowed


@pytest.mark.parametrize(
    ("kind", "generation"),
    [
        ("event", None),
        ("state", 1),
        ("typed_event", 1),
        ("typed_state", None),
    ],
)
def test_reconcile_rejects_malformed_intent_shape(
    tmp_path: Path,
    kind: str,
    generation: int | None,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    previous = module.JsonVersion(False, None, None, None)
    payload = {"status": "intended"}
    operation = module.operation_id(
        target,
        payload,
        component="fixture.state",
        predecessor=previous,
    )
    if kind == "typed_event":
        malformed_kind: object = module.PublicationKind.EVENT
    elif kind == "typed_state":
        malformed_kind = module.PublicationKind.STATE
    else:
        malformed_kind = kind
    intent = module.JsonPublicationIntent(
        kind=malformed_kind,
        target=target,
        payload=payload,
        component="fixture.state",
        operation_id=operation,
        generation=generation,
    )

    reconciled = module.reconcile_json_publication(intent, previous)

    assert reconciled.durability is module.DurabilityProof.NOT_MUTATED
    assert reconciled.authority is module.AuthorityState.UNKNOWN
    assert reconciled.error_class is module.ErrorClass.IDENTITY_TYPE
    assert not reconciled.advance_allowed


def test_event_sigkill_after_publication_reconciles_on_restart(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    child = """
import os
import signal
import sys
from pathlib import Path
from deploy.scripts.lib import durable_json as durable

root = Path(sys.argv[1])
target = durable.durable_json_target(
    trusted_root=root,
    relative_path="state/event.json",
)
payload = {"id": "event-1"}
previous = durable.JsonVersion(False, None, None, None)
operation = durable.operation_id(
    target,
    payload,
    component="fixture.event",
    predecessor=previous,
)

def kill_after_publication(stage):
    if stage is durable.WriteStage.PUBLICATION:
        os.kill(os.getpid(), signal.SIGKILL)

durable.publish_event_json(
    target,
    payload,
    component="fixture.event",
    operation_id=operation,
    _fault_hook=kill_after_publication,
)
"""
    killed = subprocess.run(
        [sys.executable, "-c", child, str(tmp_path)],
        cwd=Path.cwd(),
        check=False,
    )
    assert killed.returncode == -signal.SIGKILL

    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    previous = module.JsonVersion(False, None, None, None)
    operation = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=previous,
    )
    intent = module.JsonPublicationIntent(
        kind=module.PublicationKind.EVENT,
        target=target,
        payload=payload,
        component="fixture.event",
        operation_id=operation,
        generation=None,
    )

    reconciled = module.reconcile_json_publication(intent, previous)

    assert reconciled.durability is module.DurabilityProof.RECONCILED_COMMITTED
    assert reconciled.advance_allowed
    assert reconciled.cleanup is module.CleanupState.COMPLETE
    assert list((tmp_path / "state").glob(".durable-json.*.tmp")) == []


def test_event_sigkill_before_publication_retires_unpublished_temp(
    tmp_path: Path,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    child = """
import os
import signal
import sys
from pathlib import Path
from deploy.scripts.lib import durable_json as durable

root = Path(sys.argv[1])
target = durable.durable_json_target(
    trusted_root=root,
    relative_path="state/event.json",
)
payload = {"id": "event-1"}
previous = durable.JsonVersion(False, None, None, None)
operation = durable.operation_id(
    target,
    payload,
    component="fixture.event",
    predecessor=previous,
)

def kill_before_publication(stage):
    if stage is durable.WriteStage.PERMISSION_FINALIZATION:
        os.kill(os.getpid(), signal.SIGKILL)

durable.publish_event_json(
    target,
    payload,
    component="fixture.event",
    operation_id=operation,
    _fault_hook=kill_before_publication,
)
"""
    killed = subprocess.run(
        [sys.executable, "-c", child, str(tmp_path)],
        cwd=Path.cwd(),
        check=False,
    )
    assert killed.returncode == -signal.SIGKILL

    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/event.json",
    )
    payload = {"id": "event-1"}
    previous = module.JsonVersion(False, None, None, None)
    operation = module.operation_id(
        target,
        payload,
        component="fixture.event",
        predecessor=previous,
    )
    intent = module.JsonPublicationIntent(
        kind=module.PublicationKind.EVENT,
        target=target,
        payload=payload,
        component="fixture.event",
        operation_id=operation,
        generation=None,
    )

    reconciled = module.reconcile_json_publication(intent, previous)

    assert reconciled.durability is module.DurabilityProof.NOT_MUTATED
    assert reconciled.authority is module.AuthorityState.EXPECTED_PREDECESSOR
    assert reconciled.cleanup is module.CleanupState.COMPLETE
    assert not reconciled.advance_allowed
    assert not (tmp_path / "state" / "event.json").exists()
    assert list((tmp_path / "state").glob(".durable-json.*.tmp")) == []


def test_state_sigkill_after_authority_replace_reconciles_on_restart(
    tmp_path: Path,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "state").mkdir(mode=0o700)
    child = """
import os
import signal
import sys
from pathlib import Path
from deploy.scripts.lib import durable_json as durable

root = Path(sys.argv[1])
target = durable.durable_json_target(
    trusted_root=root,
    relative_path="state/current.json",
)
payload = {"generation": 1, "status": "ready"}
previous = durable.JsonVersion(False, None, None, None)
operation = durable.operation_id(
    target,
    payload,
    component="fixture.state",
    predecessor=previous,
)

def kill_after_replace(stage):
    if stage is durable.WriteStage.PUBLICATION:
        os.kill(os.getpid(), signal.SIGKILL)

durable.publish_state_json(
    target,
    payload,
    component="fixture.state",
    operation_id=operation,
    expected=previous,
    generation=1,
    _fault_hook=kill_after_replace,
)
"""
    killed = subprocess.run(
        [sys.executable, "-c", child, str(tmp_path)],
        cwd=Path.cwd(),
        check=False,
    )
    assert killed.returncode == -signal.SIGKILL

    target = module.durable_json_target(
        trusted_root=tmp_path,
        relative_path="state/current.json",
    )
    payload = {"generation": 1, "status": "ready"}
    previous = module.JsonVersion(False, None, None, None)
    operation = module.operation_id(
        target,
        payload,
        component="fixture.state",
        predecessor=previous,
    )
    intent = module.JsonPublicationIntent(
        kind=module.PublicationKind.STATE,
        target=target,
        payload=payload,
        component="fixture.state",
        operation_id=operation,
        generation=1,
    )

    reconciled = module.reconcile_json_publication(intent, previous)

    assert reconciled.durability is module.DurabilityProof.RECONCILED_COMMITTED
    assert reconciled.advance_allowed
