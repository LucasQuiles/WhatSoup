"""Parity tests for the generated, SSH-safe durable JSON subset."""

from __future__ import annotations

import errno
from pathlib import Path

import pytest

from deploy.scripts.lib import durable_json
from deploy.scripts.lib import durable_json_remote


def _targets(root: Path, name: str = "event.json"):
    local = durable_json.durable_json_target(
        trusted_root=root,
        relative_path=name,
    )
    remote = durable_json_remote.durable_json_target(
        trusted_root=root,
        relative_path=name,
    )
    return local, remote


def _publish(module, target, payload, component, *, fault_hook=None):
    absent = module.JsonVersion(False, None, None, None)
    publication_operation = module.operation_id(
        target,
        payload,
        component=component,
        predecessor=absent,
    )
    return module.publish_event_json(
        target,
        payload,
        component=component,
        operation_id=publication_operation,
        _fault_hook=fault_hook,
    )


@pytest.mark.parametrize(
    "payload",
    [
        {"z": 1, "a": ["é", True, None]},
        {"nested": {"safe": (1, 2, 3)}},
    ],
)
def test_remote_canonical_event_bytes_match_local(
    tmp_path: Path,
    payload: dict[str, object],
) -> None:
    local_root = tmp_path / "local"
    remote_root = tmp_path / "remote"
    local_root.mkdir(mode=0o700)
    remote_root.mkdir(mode=0o700)
    local_target, _ = _targets(local_root)
    _, remote_target = _targets(remote_root)

    local = _publish(durable_json, local_target, payload, "parity.event")
    remote = _publish(durable_json_remote, remote_target, payload, "parity.event")

    assert local.advance_allowed
    assert remote.advance_allowed
    assert (local_root / "event.json").read_bytes() == (
        remote_root / "event.json"
    ).read_bytes()
    assert remote.public_projection() == local.public_projection()


def test_remote_event_reconciles_identical_existing_bytes(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    _, target = _targets(tmp_path)
    payload = {"kind": "ack", "value": 1}

    first = _publish(durable_json_remote, target, payload, "remote.event")
    before_bytes = (tmp_path / "event.json").read_bytes()
    before_stat = (tmp_path / "event.json").stat()
    second = _publish(durable_json_remote, target, payload, "remote.event")

    assert first.durability is durable_json_remote.DurabilityProof.COMMITTED
    assert (
        second.durability
        is durable_json_remote.DurabilityProof.RECONCILED_COMMITTED
    )
    assert second.advance_allowed
    assert (tmp_path / "event.json").read_bytes() == before_bytes
    after_stat = (tmp_path / "event.json").stat()
    assert stat_mode(after_stat.st_mode) == stat_mode(before_stat.st_mode) == 0o600
    assert after_stat.st_nlink == before_stat.st_nlink == 1


def test_remote_event_direct_retry_reconciles_published_private_temporary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tmp_path.chmod(0o700)
    _, target = _targets(tmp_path)
    payload = {"kind": "ack", "value": 1}
    absent = durable_json_remote.JsonVersion(False, None, None, None)
    operation = durable_json_remote.operation_id(
        target,
        payload,
        component="remote.event",
        predecessor=absent,
    )
    temp_name = f".durable-json.{operation}.tmp"
    real_unlink = durable_json_remote.os.unlink

    def preserve_private_temp(path: object, *args: object, **kwargs: object) -> None:
        if path == temp_name:
            raise OSError(errno.EACCES, "injected")
        real_unlink(path, *args, **kwargs)

    with monkeypatch.context() as context:
        context.setattr(
            durable_json_remote.os,
            "unlink",
            preserve_private_temp,
        )
        first = _publish(
            durable_json_remote,
            target,
            payload,
            "remote.event",
        )

    second = _publish(
        durable_json_remote,
        target,
        payload,
        "remote.event",
    )

    assert first.advance_allowed
    assert second.advance_allowed
    assert (
        second.durability
        is durable_json_remote.DurabilityProof.RECONCILED_COMMITTED
    )
    assert not (tmp_path / temp_name).exists()


def test_remote_event_conflict_does_not_replace_existing_bytes(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    _, target = _targets(tmp_path)
    original = {"kind": "ack", "value": 1}
    conflicting = {"kind": "ack", "value": 2}

    assert _publish(
        durable_json_remote,
        target,
        original,
        "remote.event",
    ).advance_allowed
    result = _publish(
        durable_json_remote,
        target,
        conflicting,
        "remote.event",
    )

    assert not result.advance_allowed
    assert result.error_class is durable_json_remote.ErrorClass.CONFLICT
    assert b'"value":1' in (tmp_path / "event.json").read_bytes()


def test_remote_parent_open_failure_is_never_committed(
    tmp_path: Path,
) -> None:
    tmp_path.chmod(0o700)
    _, target = _targets(tmp_path)

    def fail_parent_open(stage) -> None:
        if stage is durable_json_remote.WriteStage.PARENT_OPEN:
            raise OSError(errno.EACCES, "synthetic parent open failure")

    result = _publish(
        durable_json_remote,
        target,
        {"kind": "ack"},
        "remote.event",
        fault_hook=fail_parent_open,
    )

    assert not result.advance_allowed
    assert result.durability is durable_json_remote.DurabilityProof.NOT_MUTATED
    assert result.error_class is durable_json_remote.ErrorClass.PERMISSION


def test_remote_parent_sync_failure_is_unproven(
    tmp_path: Path,
) -> None:
    tmp_path.chmod(0o700)
    _, target = _targets(tmp_path)

    def fail_parent_sync(stage) -> None:
        if stage is durable_json_remote.WriteStage.PARENT_SYNC:
            raise OSError(errno.EIO, "synthetic parent sync failure")

    result = _publish(
        durable_json_remote,
        target,
        {"kind": "ack"},
        "remote.event",
        fault_hook=fail_parent_sync,
    )

    assert not result.advance_allowed
    assert result.durability is durable_json_remote.DurabilityProof.UNPROVEN
    assert result.error_class is durable_json_remote.ErrorClass.IO
    assert (tmp_path / "event.json").read_bytes() == b'{"kind":"ack"}\n'
    assert result.authority is durable_json_remote.AuthorityState.UNKNOWN
    assert result.cleanup is durable_json_remote.CleanupState.NOT_REQUIRED

    local_root = tmp_path / "local"
    local_root.mkdir(mode=0o700)
    local_target, _remote_target = _targets(local_root)

    def fail_local_parent_sync(stage) -> None:
        if stage is durable_json.WriteStage.PARENT_SYNC:
            raise OSError(errno.EIO, "synthetic parent sync failure")

    local_result = _publish(
        durable_json,
        local_target,
        {"kind": "ack"},
        "remote.event",
        fault_hook=fail_local_parent_sync,
    )
    assert result.public_projection() == local_result.public_projection()

    reconciled = _publish(
        durable_json_remote,
        target,
        {"kind": "ack"},
        "remote.event",
    )
    assert reconciled.advance_allowed
    assert (
        reconciled.durability
        is durable_json_remote.DurabilityProof.RECONCILED_COMMITTED
    )


def test_remote_aggregate_rejects_any_unproven_publication(
    tmp_path: Path,
) -> None:
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_root.mkdir(mode=0o700)
    second_root.mkdir(mode=0o700)
    _, first_target = _targets(first_root)
    _, second_target = _targets(second_root)
    first = _publish(
        durable_json_remote,
        first_target,
        {"kind": "copy"},
        "remote.copy",
    )

    def fail_parent_sync(stage) -> None:
        if stage is durable_json_remote.WriteStage.PARENT_SYNC:
            raise OSError(errno.EIO, "synthetic parent sync failure")

    second = _publish(
        durable_json_remote,
        second_target,
        {"kind": "journal"},
        "remote.journal",
        fault_hook=fail_parent_sync,
    )

    with pytest.raises(durable_json_remote.DurableWriteError):
        durable_json_remote.require_all_advance([first, second])
    durable_json_remote.require_advance(first)
    with pytest.raises(durable_json_remote.DurableWriteError):
        durable_json_remote.require_advance(second)


def stat_mode(mode: int) -> int:
    return mode & 0o777
