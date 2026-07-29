from __future__ import annotations

import hashlib
import importlib
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
