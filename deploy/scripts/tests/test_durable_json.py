from __future__ import annotations

import hashlib
import importlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

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


def test_parent_descriptor_exhaustion_is_typed_and_inconclusive(
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

    def exhaust_on_state(path: object, flags: int, *args: object, **kwargs: object) -> int:
        if path == "state":
            raise OSError(module.errno.EMFILE, "injected")
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


def test_sync_changed_parents_uses_one_barrier_for_one_parent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
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


def test_sync_changed_parents_reports_the_failed_source_barrier(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.durable_json")
    (tmp_path / "destination").mkdir(mode=0o700)
    (tmp_path / "source").mkdir(mode=0o700)
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
