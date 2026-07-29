"""Executable contract for integrity-bound controller state recovery.

This suite intentionally precedes ``lib/controller_state.py``.  It exercises the
public contract through real files and a deterministic syscall-boundary adapter;
it does not provide a test implementation of the production helper.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import FrozenInstanceError, dataclass
from datetime import datetime, timedelta, timezone
import errno
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import stat
import sys
from types import ModuleType
from typing import Any

import pytest


_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
_MODULE_PATH = _SCRIPT_ROOT / "lib" / "controller_state.py"
_COMPONENT = "collector"
_STORE_ID = "00112233445566778899aabbccddeeff"
_MAX_OCCURRENCE_COUNT = 2**31 - 1
_MANAGED_SUFFIXES = (
    "",
    ".previous",
    ".initialized",
    ".transaction",
    ".recovery",
    ".lock",
)


def load_controller_state_module() -> ModuleType:
    """Load the helper exactly as an isolated deployed bundle will load it."""

    assert _MODULE_PATH.is_file(), (
        "RED contract unmet: deploy/scripts/lib/controller_state.py does not exist"
    )
    module_name = "controller_state_contract_target"
    sys.modules.pop(module_name, None)
    spec = importlib.util.spec_from_file_location(module_name, _MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class DeterministicClock:
    def __init__(self) -> None:
        self._next = datetime(2026, 7, 28, 21, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        value = self._next
        self._next += timedelta(milliseconds=1)
        return value


class DeterministicRandomBytes:
    def __init__(self, seed: int = 0) -> None:
        self._offset = seed % 256

    def __call__(self, size: int) -> bytes:
        assert isinstance(size, int) and size > 0
        value = bytes((self._offset + index) % 256 for index in range(size))
        self._offset = (self._offset + size) % 256
        return value


def validate_probe_payload(raw: Mapping[str, Any]) -> dict[str, Any]:
    payload = dict(raw)
    if "_controllerState" in payload:
        raise ValueError("reserved controller state member")
    counters = payload.get("counters", {})
    if not isinstance(counters, dict):
        raise ValueError("counters must be an object")
    return payload


def validate_versioned_payload(raw: Mapping[str, Any]) -> dict[str, Any]:
    payload = validate_probe_payload(raw)
    if payload.get("version") != 1:
        raise ValueError("unsupported component payload version")
    return payload


@dataclass(frozen=True)
class BoundaryCall:
    name: str
    occurrence: int
    detail: str


@dataclass
class FaultRule:
    name: str
    matching_occurrence: int
    error: BaseException
    predicate: Callable[[BoundaryCall], bool]
    matches: int = 0
    fired: bool = False


class FaultOps:
    """Real syscall adapter with deterministic named-boundary fault injection.

    Each required boundary is counted and recorded *before* an optional error is
    raised.  Rules count only matching calls, which lets tests target a durable
    transition without depending on unrelated descriptor traffic.
    """

    REQUIRED_BOUNDARIES = frozenset(
        {
            "open",
            "fstat",
            "read",
            "write",
            "fsync_file",
            "fsync_directory",
            "replace",
            "unlink",
            "flock",
        }
    )

    def __init__(self) -> None:
        self.calls: list[BoundaryCall] = []
        self.counters: Counter[str] = Counter()
        self.rules: list[FaultRule] = []
        self.fd_paths: dict[int, str] = {}
        self.opened_fds: set[int] = set()
        self.closed_fds: set[int] = set()
        self.last_namespace_target = ""
        self.after_hooks: dict[tuple[str, int], Callable[[], None]] = {}
        self.fstat_transform: Callable[[int, os.stat_result], os.stat_result] | None = None
        self.after_fstat: Callable[[int, os.stat_result], None] | None = None

    def inject(
        self,
        name: str,
        *,
        occurrence: int = 1,
        error: BaseException | None = None,
        detail_contains: str | None = None,
        predicate: Callable[[BoundaryCall], bool] | None = None,
    ) -> None:
        assert name in self.REQUIRED_BOUNDARIES
        assert occurrence > 0
        if predicate is None:
            predicate = (
                (lambda call: detail_contains in call.detail)
                if detail_contains is not None
                else (lambda _call: True)
            )
        self.rules.append(
            FaultRule(
                name=name,
                matching_occurrence=occurrence,
                error=error or OSError(errno.EIO, f"injected {name} failure"),
                predicate=predicate,
            )
        )

    def hook_after(self, name: str, occurrence: int, action: Callable[[], None]) -> None:
        self.after_hooks[(name, occurrence)] = action

    def reset_trace(self) -> None:
        self.calls.clear()
        self.counters.clear()
        self.rules.clear()
        self.last_namespace_target = ""

    def _record(self, name: str, detail: str) -> BoundaryCall:
        self.counters[name] += 1
        call = BoundaryCall(name, self.counters[name], detail)
        self.calls.append(call)
        for rule in self.rules:
            if rule.fired or rule.name != name or not rule.predicate(call):
                continue
            rule.matches += 1
            if rule.matches == rule.matching_occurrence:
                rule.fired = True
                raise rule.error
        return call

    def _after(self, call: BoundaryCall) -> None:
        action = self.after_hooks.get((call.name, call.occurrence))
        if action is not None:
            action()

    @staticmethod
    def _path_detail(path: os.PathLike[str] | str, dir_fd: int | None) -> str:
        prefix = f"dirfd={dir_fd}:" if dir_fd is not None else ""
        return prefix + os.fspath(path)

    def open(
        self,
        path: os.PathLike[str] | str,
        flags: int,
        mode: int = 0o600,
        *,
        dir_fd: int | None = None,
    ) -> int:
        detail = self._path_detail(path, dir_fd)
        call = self._record("open", detail)
        if flags & os.O_CREAT:
            fd = os.open(path, flags, mode, dir_fd=dir_fd)
        else:
            fd = os.open(path, flags, dir_fd=dir_fd)
        self.fd_paths[fd] = detail
        self.opened_fds.add(fd)
        self._after(call)
        return fd

    def fstat(self, fd: int) -> os.stat_result:
        call = self._record("fstat", self.fd_paths.get(fd, f"fd={fd}"))
        result = os.fstat(fd)
        if self.fstat_transform is not None:
            result = self.fstat_transform(fd, result)
        self._after(call)
        if self.after_fstat is not None:
            self.after_fstat(fd, result)
        return result

    def read(self, fd: int, size: int) -> bytes:
        call = self._record("read", self.fd_paths.get(fd, f"fd={fd}"))
        result = os.read(fd, size)
        self._after(call)
        return result

    def write(self, fd: int, data: bytes) -> int:
        call = self._record("write", self.fd_paths.get(fd, f"fd={fd}"))
        result = os.write(fd, data)
        self._after(call)
        return result

    def fsync_file(self, fd: int) -> None:
        call = self._record("fsync_file", self.fd_paths.get(fd, f"fd={fd}"))
        os.fsync(fd)
        self._after(call)

    def fsync_directory(self, fd: int) -> None:
        path = self.fd_paths.get(fd, f"fd={fd}")
        call = self._record(
            "fsync_directory",
            f"{path};after={self.last_namespace_target}",
        )
        os.fsync(fd)
        self._after(call)

    def replace(
        self,
        source: os.PathLike[str] | str,
        target: os.PathLike[str] | str,
        *,
        src_dir_fd: int | None = None,
        dst_dir_fd: int | None = None,
    ) -> None:
        detail = (
            f"{self._path_detail(source, src_dir_fd)}"
            f"->{self._path_detail(target, dst_dir_fd)}"
        )
        call = self._record("replace", detail)
        os.replace(source, target, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
        self.last_namespace_target = os.fspath(target)
        self._after(call)

    def unlink(
        self,
        path: os.PathLike[str] | str,
        *,
        dir_fd: int | None = None,
    ) -> None:
        detail = self._path_detail(path, dir_fd)
        call = self._record("unlink", detail)
        os.unlink(path, dir_fd=dir_fd)
        self.last_namespace_target = os.fspath(path)
        self._after(call)

    def flock(self, fd: int, operation: int) -> None:
        call = self._record("flock", self.fd_paths.get(fd, f"fd={fd}"))
        fcntl.flock(fd, operation)
        self._after(call)

    def close(self, fd: int) -> None:
        os.close(fd)
        self.closed_fds.add(fd)

    def chmod(
        self,
        path: os.PathLike[str] | str,
        mode: int,
        *,
        dir_fd: int | None = None,
        follow_symlinks: bool = True,
    ) -> None:
        self.counters["chmod"] += 1
        os.chmod(
            path,
            mode,
            dir_fd=dir_fd,
            follow_symlinks=follow_symlinks,
        )

    def assert_injected(self, name: str) -> None:
        matching = [rule for rule in self.rules if rule.name == name]
        assert matching and all(rule.fired for rule in matching)
        assert self.counters[name] > 0


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _integrity(value: Mapping[str, Any]) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _refresh_sidecar_integrity(document: dict[str, Any]) -> None:
    unsigned = {key: value for key, value in document.items() if key != "integritySha256"}
    document["integritySha256"] = _integrity(unsigned)


def _refresh_envelope_integrity(document: dict[str, Any]) -> None:
    metadata = document["_controllerState"]
    preimage = {
        key: value
        for key, value in metadata.items()
        if key != "integritySha256"
    }
    preimage["payload"] = {
        key: value for key, value in document.items() if key != "_controllerState"
    }
    metadata["integritySha256"] = _integrity(preimage)


def _write_private_json(path: Path, value: Mapping[str, Any]) -> None:
    path.write_bytes(_canonical_bytes(value))
    path.chmod(0o600)


def _json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def _managed(path: Path, suffix: str) -> Path:
    return path.with_name(path.name + suffix)


def _authority_snapshot(path: Path) -> dict[str, bytes | None]:
    return {
        suffix: (
            _managed(path, suffix).read_bytes()
            if _managed(path, suffix).exists() and _managed(path, suffix).is_file()
            else None
        )
        for suffix in _MANAGED_SUFFIXES[:-1]
    }


def _evidence_files(path: Path) -> set[Path]:
    managed = {_managed(path, suffix) for suffix in _MANAGED_SUFFIXES}
    return {
        candidate
        for candidate in path.parent.iterdir()
        if candidate not in managed and candidate.is_file()
    }


def _bootstrap() -> dict[str, Any]:
    return {"counters": {}, "members": []}


def _open(
    cs: ModuleType,
    path: Path,
    *,
    component: str = _COMPONENT,
    bootstrap: Callable[[], dict[str, Any]] = _bootstrap,
    validator: Callable[[Mapping[str, Any]], dict[str, Any]] = validate_probe_payload,
    ops: FaultOps | None = None,
    lock_timeout: float = 0.05,
):
    return cs.open_controller_state(
        path,
        component=component,
        bootstrap=bootstrap,
        validate_payload=validator,
        lock_timeout_seconds=lock_timeout,
        clock=DeterministicClock(),
        random_bytes=DeterministicRandomBytes(
            hashlib.sha256(os.fspath(path).encode("utf-8")).digest()[0]
        ),
        file_ops=ops,
    )


def _read(
    cs: ModuleType,
    path: Path,
    *,
    component: str = _COMPONENT,
    validator: Callable[[Mapping[str, Any]], dict[str, Any]] = validate_probe_payload,
    ops: FaultOps | None = None,
    lock_timeout: float = 0.05,
):
    return cs.read_controller_state(
        path,
        component=component,
        validate_payload=validator,
        lock_timeout_seconds=lock_timeout,
        file_ops=ops,
    )


def _seed_store(
    cs: ModuleType,
    path: Path,
    payloads: tuple[dict[str, Any], ...] = (
        {"counters": {"seen": 1}, "members": ["first"]},
    ),
) -> None:
    with _open(cs, path) as session:
        result = session.load()
        assert result.mode == "bootstrap"
        capability = result.capability
        assert capability is not None
        for payload in payloads:
            commit = session.save(payload, capability)
            assert commit.mode == "valid"
            capability = commit.capability


def _load_valid(cs: ModuleType, path: Path, *, ops: FaultOps | None = None):
    session = _open(cs, path, ops=ops)
    result = session.load()
    assert result.mode == "valid"
    assert result.payload is not None
    assert result.capability is not None
    return session, result


def _damage_primary(path: Path, damage: str) -> bytes:
    if damage == "truncated":
        damaged = b'{"counters":'
    elif damage == "wrong_root":
        damaged = b'["not","an","object"]'
    elif damage == "integrity_mismatch":
        document = _json(path)
        document["counters"] = {"tampered": 999}
        damaged = _canonical_bytes(document)
    else:  # pragma: no cover - the parametrization is closed.
        raise AssertionError(damage)
    path.write_bytes(damaged)
    path.chmod(0o600)
    return damaged


def _assert_recovery_required(result: Any, reason: str | None = None) -> None:
    assert result.mode == "recovery_required"
    assert result.payload is None
    assert result.capability is None
    if reason is not None:
        assert result.diagnostic.reason == reason


def _assert_capability_rejected(cs: ModuleType, operation: Callable[[], Any]) -> None:
    with pytest.raises((RuntimeError, cs.ControllerStateRequired)):
        operation()


def _last_call_index(ops: FaultOps, name: str, detail: str = "") -> int:
    return max(
        index
        for index, call in enumerate(ops.calls)
        if call.name == name and detail in call.detail
    )


def _set_valid_generation(path: Path, generation: int) -> None:
    primary = _json(path)
    primary["_controllerState"]["generation"] = generation
    _refresh_envelope_integrity(primary)
    _write_private_json(path, primary)

    marker_path = _managed(path, ".initialized")
    marker = _json(marker_path)
    marker["highWaterGeneration"] = generation
    marker["highWaterIntegritySha256"] = primary["_controllerState"]["integritySha256"]
    _refresh_sidecar_integrity(marker)
    _write_private_json(marker_path, marker)


def test_fault_ops_raises_on_exact_named_boundary_occurrence(tmp_path: Path) -> None:
    ops = FaultOps()
    target = tmp_path / "probe"
    target.write_bytes(b"x")
    ops.inject("open", occurrence=2, error=PermissionError("injected"))

    first = ops.open(target, os.O_RDONLY)
    ops.close(first)
    with pytest.raises(PermissionError, match="injected"):
        ops.open(target, os.O_RDONLY)

    assert ops.counters["open"] == 2
    assert [call.occurrence for call in ops.calls if call.name == "open"] == [1, 2]
    ops.assert_injected("open")


def test_public_contract_exports_required_types_and_operations(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    required = {
        "JsonObject",
        "StateComponent",
        "StateMode",
        "ReadMode",
        "RecoveryOutcome",
        "StateReason",
        "StateDiagnostic",
        "StateLoadResult",
        "StateReadResult",
        "StateCommitResult",
        "ControllerStateSession",
        "ControllerStateRequired",
        "STATE_RECOVERY_REQUIRED_EXIT",
        "open_controller_state",
        "read_controller_state",
        "emit_state_recovery_fallback",
        "state_diagnostic_details",
    }
    assert required <= set(vars(cs))
    assert cs.STATE_RECOVERY_REQUIRED_EXIT == 78

    session = _open(cs, tmp_path / "state.json")
    assert isinstance(session, cs.ControllerStateSession)
    assert session.__enter__() is session
    assert {"load", "reload", "save", "complete_reconciliation", "close"} <= set(
        dir(session)
    )
    session.close()


def test_result_and_diagnostic_records_are_frozen() -> None:
    cs = load_controller_state_module()
    diagnostic = cs.StateDiagnostic(
        component="collector",
        mode="bootstrap",
        current_generation=None,
        recovered_generation=None,
        reason=None,
        recovery_receipt_id=None,
        occurrence_count=0,
    )
    with pytest.raises(FrozenInstanceError):
        diagnostic.mode = "valid"


@pytest.mark.parametrize(
    ("payload", "probe"),
    (
        ({"z": 1, "a": 2, "counters": {}}, b'{"a":2,"counters":{},"z":1'),
        ({"counters": {}, "label": "caf\u00e9"}, "caf\u00e9".encode()),
        ({"counters": {}, "ordered": [3, 1, 2]}, b'"ordered":[3,1,2]'),
        ({"counters": {"large": 9_007_199_254_740_991}}, b"9007199254740991"),
    ),
)
def test_committed_documents_use_canonical_json(
    tmp_path: Path,
    payload: dict[str, Any],
    probe: bytes,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    with _open(cs, path) as session:
        loaded = session.load()
        committed = session.save(payload, loaded.capability)
        assert committed.generation == 1

    raw = path.read_bytes()
    document = json.loads(raw)
    assert raw == _canonical_bytes(document)
    assert probe in raw
    metadata = document["_controllerState"]
    preimage = {key: value for key, value in metadata.items() if key != "integritySha256"}
    preimage["payload"] = payload
    assert metadata["integritySha256"] == _integrity(preimage)


@pytest.mark.parametrize("value", (math.nan, math.inf, -math.inf))
def test_non_finite_numbers_are_rejected_before_publication(
    tmp_path: Path,
    value: float,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    with _open(cs, path) as session:
        loaded = session.load()
        before = _authority_snapshot(path)
        with pytest.raises((ValueError, cs.ControllerStateRequired)):
            session.save({"counters": {"invalid": value}}, loaded.capability)
        assert _authority_snapshot(path) == before


@pytest.mark.parametrize(
    ("target", "field"),
    (
        ("primary", "generation"),
        ("marker", "highWaterGeneration"),
        ("journal", "targetGeneration"),
        ("receipt", "recoveredGeneration"),
    ),
)
def test_boolean_generation_fields_are_not_integers(
    tmp_path: Path,
    target: str,
    field: str,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    targets = {
        "primary": path,
        "marker": _managed(path, ".initialized"),
    }
    if target == "journal":
        ops = FaultOps()
        session, result = _load_valid(cs, path, ops=ops)
        ops.inject("replace", detail_contains=".previous")
        with pytest.raises(cs.ControllerStateRequired):
            session.save({"counters": {"seen": 2}}, result.capability)
        session.close()
        targets[target] = _managed(path, ".transaction")
    elif target == "receipt":
        _damage_primary(path, "truncated")
        with _open(cs, path) as session:
            assert session.load().mode == "recovered"
        targets[target] = _managed(path, ".recovery")

    document = _json(targets[target])
    if target == "primary":
        document["_controllerState"][field] = True
        _refresh_envelope_integrity(document)
    else:
        document[field] = True
        _refresh_sidecar_integrity(document)
    _write_private_json(targets[target], document)

    with _open(cs, path) as session:
        _assert_recovery_required(session.load(), "generation_invalid")


def test_unknown_controller_state_member_is_rejected(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    document = _json(path)
    document["_controllerState"]["futureMember"] = "unsupported"
    _refresh_envelope_integrity(document)
    _write_private_json(path, document)

    with _open(cs, path) as session:
        _assert_recovery_required(session.load(), "schema_incompatible")


def test_future_envelope_format_version_is_rejected_without_rollback(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"version": 1, "counters": {"seen": 1}},
            {"version": 1, "counters": {"seen": 2}},
        ),
    )
    previous_before = _managed(path, ".previous").read_bytes()
    document = _json(path)
    document["_controllerState"]["formatVersion"] = 2
    _refresh_envelope_integrity(document)
    _write_private_json(path, document)

    with _open(cs, path, validator=validate_versioned_payload) as session:
        result = session.load()
    _assert_recovery_required(result, "schema_incompatible")
    assert _managed(path, ".previous").read_bytes() == previous_before


def test_future_component_payload_version_is_separate_from_envelope_version(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path, ({"version": 1, "counters": {}},))
    document = _json(path)
    assert document["_controllerState"]["formatVersion"] == 1
    document["version"] = 2
    _refresh_envelope_integrity(document)
    _write_private_json(path, document)

    with _open(cs, path, validator=validate_versioned_payload) as session:
        _assert_recovery_required(session.load(), "schema_incompatible")


def test_pristine_store_bootstraps_without_established_artifacts(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    with _open(cs, path) as session:
        result = session.load()
        assert result.mode == "bootstrap"
        assert result.payload == _bootstrap()
        assert result.capability is not None
        assert result.diagnostic.mode == "bootstrap"
    assert not path.exists()
    assert _managed(path, ".lock").is_file()


def test_preexisting_trusted_lock_alone_does_not_establish_store(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    lock = _managed(path, ".lock")
    lock.write_bytes(b"")
    lock.chmod(0o600)

    with _open(cs, path) as session:
        assert session.load().mode == "bootstrap"
    assert lock.exists()


def test_marker_without_generation_is_recovery_required(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    marker = {
        "format": "whatsoup.controller-state",
        "formatVersion": 1,
        "component": _COMPONENT,
        "storeId": _STORE_ID,
        "highWaterGeneration": 0,
        "highWaterIntegritySha256": "0" * 64,
    }
    _refresh_sidecar_integrity(marker)
    _write_private_json(_managed(path, ".initialized"), marker)

    with _open(cs, path) as session:
        _assert_recovery_required(session.load())


def test_pristine_legacy_writer_migrates_without_payload_change(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    legacy = {"counters": {"open": 4}, "members": ["alpha", "beta"]}
    _write_private_json(path, legacy)

    with _open(cs, path) as session:
        result = session.load()
        assert result.mode == "reconciled"
        assert result.payload == legacy
        assert result.capability is not None
    migrated = _json(path)
    assert {key: value for key, value in migrated.items() if key != "_controllerState"} == legacy
    assert migrated["_controllerState"]["generation"] == 1


def test_read_only_pristine_legacy_is_legacy_valid_and_performs_no_write(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    legacy = {"counters": {"open": 4}, "members": ["alpha"]}
    _write_private_json(path, legacy)
    lock = _managed(path, ".lock")
    lock.write_bytes(b"")
    lock.chmod(0o600)
    before = {candidate.name: candidate.read_bytes() for candidate in tmp_path.iterdir()}
    ops = FaultOps()

    result = _read(cs, path, ops=ops)

    assert result.mode == "legacy_valid"
    assert result.payload == legacy
    assert result.generation is None
    assert {candidate.name: candidate.read_bytes() for candidate in tmp_path.iterdir()} == before
    assert ops.counters["write"] == 0
    assert ops.counters["replace"] == 0
    assert ops.counters["unlink"] == 0


def test_established_store_legacy_writer_rollback_fails_closed(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    marker_before = _managed(path, ".initialized").read_bytes()
    _write_private_json(path, {"counters": {}, "members": []})

    with _open(cs, path) as session:
        _assert_recovery_required(session.load())
    assert _managed(path, ".initialized").read_bytes() == marker_before


def test_valid_current_load_does_not_rewrite_authority(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    before = _authority_snapshot(path)
    ops = FaultOps()

    with _open(cs, path, ops=ops) as session:
        result = session.load()
        assert result.mode == "valid"

    assert _authority_snapshot(path) == before
    assert ops.counters["write"] == 0
    assert ops.counters["replace"] == 0
    assert ops.counters["unlink"] == 0


@pytest.mark.parametrize("mismatch", ("store", "component"))
def test_envelope_store_or_component_mismatch_is_not_adopted(
    tmp_path: Path,
    mismatch: str,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    document = _json(path)
    if mismatch == "store":
        document["_controllerState"]["storeId"] = "f" * 32
    else:
        document["_controllerState"]["component"] = "heartbeat-watchdog"
    _refresh_envelope_integrity(document)
    _write_private_json(path, document)

    with _open(cs, path) as session:
        _assert_recovery_required(session.load())


@pytest.mark.parametrize("sidecar", (".initialized", ".transaction", ".recovery"))
def test_sidecar_tamper_is_recovery_required(tmp_path: Path, sidecar: str) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    if sidecar == ".transaction":
        ops = FaultOps()
        session, result = _load_valid(cs, path, ops=ops)
        ops.inject("replace", detail_contains=".previous")
        with pytest.raises(cs.ControllerStateRequired):
            session.save({"counters": {"seen": 2}}, result.capability)
        session.close()
    elif sidecar == ".recovery":
        _damage_primary(path, "truncated")
        with _open(cs, path) as session:
            assert session.load().mode == "recovered"
    document = _json(_managed(path, sidecar))
    document["integritySha256"] = "0" * 64
    _write_private_json(_managed(path, sidecar), document)

    with _open(cs, path) as session:
        _assert_recovery_required(session.load(), "integrity_mismatch")


def test_generation_pair_below_marker_high_water_is_rollback(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}},
            {"counters": {"seen": 2}},
        ),
    )
    older = _managed(path, ".previous").read_bytes()
    path.write_bytes(older)
    _managed(path, ".previous").write_bytes(older)

    with _open(cs, path) as session:
        _assert_recovery_required(session.load(), "generation_invalid")


def test_semantically_invalid_component_payload_is_rejected(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    document = _json(path)
    document["counters"] = []
    _refresh_envelope_integrity(document)
    _write_private_json(path, document)

    with _open(cs, path) as session:
        _assert_recovery_required(session.load(), "schema_incompatible")


@pytest.mark.parametrize(
    "leaf_suffix",
    (".lock", "", ".previous", ".initialized", ".transaction", ".recovery"),
)
def test_symlinked_managed_leaf_is_rejected_without_target_effects(
    tmp_path: Path,
    leaf_suffix: str,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    if leaf_suffix == ".transaction":
        _write_private_json(
            _managed(path, leaf_suffix),
            {"untrusted": True, "integritySha256": "0" * 64},
        )
    elif leaf_suffix == ".recovery":
        _write_private_json(
            _managed(path, leaf_suffix),
            {"untrusted": True, "integritySha256": "0" * 64},
        )
    victim = _managed(path, leaf_suffix)
    if victim.exists():
        victim.unlink()
    outside = tmp_path / f"outside-{leaf_suffix.replace('.', '') or 'primary'}"
    outside.write_bytes(b"outside authority")
    outside.chmod(0o600)
    os.symlink(outside, victim)
    outside_before = outside.read_bytes()
    ops = FaultOps()

    try:
        with _open(cs, path, ops=ops) as session:
            _assert_recovery_required(session.load(), "unsafe_file")
    except cs.ControllerStateRequired as error:
        assert error.diagnostic.reason == "unsafe_file"

    assert outside.read_bytes() == outside_before
    assert ops.counters["chmod"] == 0
    assert ops.counters["replace"] == 0
    assert ops.counters["unlink"] == 0
    assert all(os.fspath(outside) not in call.detail for call in ops.calls if call.name == "read")


def test_symlinked_ancestor_is_rejected_without_following_target(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    real = tmp_path / "real"
    real.mkdir()
    path = real / "state.json"
    _seed_store(cs, path)
    linked = tmp_path / "linked"
    os.symlink(real, linked)
    outside_before = _authority_snapshot(path)
    ops = FaultOps()

    try:
        with _open(cs, linked / "state.json", ops=ops) as session:
            _assert_recovery_required(session.load(), "unsafe_file")
    except cs.ControllerStateRequired as error:
        assert error.diagnostic.reason == "unsafe_file"

    assert _authority_snapshot(path) == outside_before
    assert ops.counters["chmod"] == 0
    assert ops.counters["replace"] == 0
    assert ops.counters["unlink"] == 0


def test_non_regular_managed_leaf_is_rejected_without_repair(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    path.unlink()
    os.mkfifo(path, 0o600)
    ops = FaultOps()

    with _open(cs, path, ops=ops) as session:
        _assert_recovery_required(session.load(), "unsafe_file")

    assert stat.S_ISFIFO(path.lstat().st_mode)
    assert ops.counters["chmod"] == 0
    assert ops.counters["replace"] == 0
    assert ops.counters["unlink"] == 0


def test_owner_mismatch_reported_by_verified_descriptor_is_rejected(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    ops = FaultOps()

    def wrong_owner(fd: int, observed: os.stat_result) -> os.stat_result:
        if ops.fd_paths.get(fd, "").endswith("state.json"):
            values = list(observed)
            values[4] = observed.st_uid + 1
            return os.stat_result(values)
        return observed

    ops.fstat_transform = wrong_owner
    before = _authority_snapshot(path)
    with _open(cs, path, ops=ops) as session:
        _assert_recovery_required(session.load(), "unsafe_file")
    assert _authority_snapshot(path) == before
    assert ops.counters["chmod"] == 0
    assert ops.counters["replace"] == 0


@pytest.mark.parametrize("directory_mode", (0o770, 0o707))
def test_group_or_world_writable_directory_is_rejected(
    tmp_path: Path,
    directory_mode: int,
) -> None:
    cs = load_controller_state_module()
    private = tmp_path / "private"
    private.mkdir(mode=0o700)
    path = private / "state.json"
    _seed_store(cs, path)
    private.chmod(directory_mode)
    before = _authority_snapshot(path)
    ops = FaultOps()
    try:
        with _open(cs, path, ops=ops) as session:
            _assert_recovery_required(session.load(), "unsafe_file")
    finally:
        private.chmod(0o700)
    assert _authority_snapshot(path) == before
    assert ops.counters["chmod"] == 0
    assert ops.counters["replace"] == 0


@pytest.mark.parametrize("file_mode", (0o640, 0o604, 0o666))
def test_non_private_managed_file_is_rejected_without_chmod(
    tmp_path: Path,
    file_mode: int,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    path.chmod(file_mode)
    before = path.read_bytes()
    ops = FaultOps()

    with _open(cs, path, ops=ops) as session:
        _assert_recovery_required(session.load(), "unsafe_file")

    assert stat.S_IMODE(path.stat().st_mode) == file_mode
    assert path.read_bytes() == before
    assert ops.counters["chmod"] == 0
    assert ops.counters["replace"] == 0


def test_identity_replacement_between_inspection_and_use_fails_closed(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    replacement = tmp_path / "replacement"
    replacement.write_bytes(path.read_bytes())
    replacement.chmod(0o600)
    ops = FaultOps()

    def swap_identity() -> None:
        os.replace(replacement, path)

    swapped = False

    def swap_primary_identity(fd: int, _observed: os.stat_result) -> None:
        nonlocal swapped
        if not swapped and ops.fd_paths.get(fd, "").endswith("state.json"):
            swapped = True
            swap_identity()

    ops.after_fstat = swap_primary_identity
    with _open(cs, path, ops=ops) as session:
        _assert_recovery_required(session.load(), "unsafe_file")
    assert swapped is True
    assert ops.counters["replace"] == 0
    assert ops.counters["chmod"] == 0


def test_capability_has_no_public_zero_argument_constructor(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    with _open(cs, path) as session:
        capability = session.load().capability
        assert capability is not None
        with pytest.raises(TypeError):
            type(capability)()


def test_save_requires_a_capability(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    with _open(cs, path) as session:
        session.load()
        _assert_capability_rejected(
            cs,
            lambda: session.save({"counters": {}}, None),
        )


def test_committed_save_consumes_old_and_returns_distinct_fresh_capability(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    with _open(cs, path) as session:
        loaded = session.load()
        old = loaded.capability
        first = session.save({"counters": {"seen": 1}}, old)
        assert first.capability is not old
        _assert_capability_rejected(
            cs,
            lambda: session.save({"counters": {"seen": 2}}, old),
        )
        second = session.save({"counters": {"seen": 2}}, first.capability)
        assert second.generation == first.generation + 1
        assert second.capability is not first.capability


def test_reused_capability_is_rejected(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    with _open(cs, path) as session:
        capability = session.load().capability
        session.save({"counters": {"seen": 1}}, capability)
        _assert_capability_rejected(
            cs,
            lambda: session.save({"counters": {"seen": 2}}, capability),
        )


def test_reload_invalidates_previously_issued_capability(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    with _open(cs, path) as session:
        first = session.load()
        reloaded = session.reload()
        assert reloaded.mode == "valid"
        assert reloaded.capability is not first.capability
        _assert_capability_rejected(
            cs,
            lambda: session.save({"counters": {"seen": 2}}, first.capability),
        )


def test_released_capability_is_rejected(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    session = _open(cs, path)
    capability = session.load().capability
    session.close()
    _assert_capability_rejected(
        cs,
        lambda: session.save({"counters": {}}, capability),
    )


@pytest.mark.parametrize("mismatch", ("component", "store", "path"))
def test_cross_authority_capability_is_rejected(
    tmp_path: Path,
    mismatch: str,
) -> None:
    cs = load_controller_state_module()
    first_path = tmp_path / "first.json"
    second_path = tmp_path / "second.json"
    first_component = "collector"
    second_component = "heartbeat-watchdog" if mismatch == "component" else "collector"
    first = _open(cs, first_path, component=first_component)
    second = _open(cs, second_path, component=second_component)
    try:
        first_capability = first.load().capability
        second_result = second.load()
        assert second_result.capability is not None
        _assert_capability_rejected(
            cs,
            lambda: second.save({"counters": {}}, first_capability),
        )
    finally:
        first.close()
        second.close()


def test_store_binding_rejects_capability_after_coherent_store_substitution(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    session, result = _load_valid(cs, path)
    replacement_store = "f" * 32
    primary = _json(path)
    primary["_controllerState"]["storeId"] = replacement_store
    _refresh_envelope_integrity(primary)
    _write_private_json(path, primary)
    marker_path = _managed(path, ".initialized")
    marker = _json(marker_path)
    marker["storeId"] = replacement_store
    marker["highWaterIntegritySha256"] = primary["_controllerState"]["integritySha256"]
    _refresh_sidecar_integrity(marker)
    _write_private_json(marker_path, marker)

    _assert_capability_rejected(
        cs,
        lambda: session.save({"counters": {"seen": 2}}, result.capability),
    )
    session.close()


def test_capability_bound_to_observed_generation_rejects_external_advance(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    session, result = _load_valid(cs, path)
    _set_valid_generation(path, result.diagnostic.current_generation + 1)

    _assert_capability_rejected(
        cs,
        lambda: session.save({"counters": {"seen": 2}}, result.capability),
    )
    session.close()


def test_reconciliation_capability_cannot_authorize_ordinary_save(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}},
            {"counters": {"seen": 2}},
        ),
    )
    _damage_primary(path, "truncated")
    with _open(cs, path) as session:
        recovered = session.load()
        assert recovered.mode == "recovered"
        _assert_capability_rejected(
            cs,
            lambda: session.save(recovered.payload, recovered.capability),
        )


def test_normal_capability_cannot_authorize_reconciliation(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    with _open(cs, path) as session:
        valid = session.load()
        _assert_capability_rejected(
            cs,
            lambda: session.complete_reconciliation(
                valid.payload,
                valid.capability,
                outcome="validated_previous_only",
            ),
        )


def test_recovered_reconciled_valid_transition_is_ordered_and_not_repeated(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}},
            {"counters": {"seen": 2}},
        ),
    )
    _damage_primary(path, "truncated")

    with _open(cs, path) as session:
        recovered = session.load()
        assert recovered.mode == recovered.diagnostic.mode == "recovered"
        receipt_id = recovered.diagnostic.recovery_receipt_id
        reconciled = session.complete_reconciliation(
            recovered.payload,
            recovered.capability,
            outcome="validated_previous_only",
        )
        assert reconciled.mode == reconciled.diagnostic.mode == "reconciled"
        assert reconciled.diagnostic.recovery_receipt_id == receipt_id
        valid = session.reload()
        assert valid.mode == valid.diagnostic.mode == "valid"
        assert valid.payload == recovered.payload
        assert valid.diagnostic.recovery_receipt_id == receipt_id
        assert valid.capability is not reconciled.capability

    receipt = _json(_managed(path, ".recovery"))
    assert receipt["phase"] == "reconciled"
    with _open(cs, path) as restarted:
        assert restarted.load().mode == "valid"


def test_controller_state_required_is_content_free() -> None:
    cs = load_controller_state_module()
    diagnostic = cs.StateDiagnostic(
        component="collector",
        mode="recovery_required",
        current_generation=7,
        recovered_generation=6,
        reason="integrity_mismatch",
        recovery_receipt_id="opaque-receipt",
        occurrence_count=2,
    )
    error = cs.ControllerStateRequired(diagnostic)

    assert error.diagnostic is diagnostic
    assert str(error) == "controller state recovery required"
    rendered = repr(error)
    for forbidden in (
        "integrity_mismatch",
        "opaque-receipt",
        "/private/state.json",
        "raw exception",
        "payloadValue",
    ):
        assert forbidden not in rendered


def test_exclusive_lock_overlap_is_bounded_and_typed(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    first = _open(cs, path)
    first.load()
    try:
        with pytest.raises(cs.ControllerStateRequired) as raised:
            _open(cs, path, lock_timeout=0.001)
        assert raised.value.diagnostic.reason == "lock_unavailable"
        assert raised.value.diagnostic.mode == "recovery_required"
    finally:
        first.close()


def test_shared_reader_during_exclusive_ownership_is_unavailable(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    owner = _open(cs, path)
    owner.load()
    try:
        reader = _read(cs, path, lock_timeout=0.001)
        assert reader.mode == "unavailable"
        assert reader.payload is None
        assert reader.reason == "lock_unavailable"
    finally:
        owner.close()


@pytest.mark.parametrize("raises", (False, True))
def test_context_manager_closes_on_success_and_exception(
    tmp_path: Path,
    raises: bool,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    capability = None
    if raises:
        with pytest.raises(LookupError):
            with _open(cs, path) as session:
                capability = session.load().capability
                raise LookupError("synthetic")
    else:
        with _open(cs, path) as session:
            capability = session.load().capability

    _assert_capability_rejected(
        cs,
        lambda: session.save({"counters": {}}, capability),
    )


def test_close_is_idempotent_and_operations_after_close_are_rejected(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    session = _open(cs, tmp_path / "state.json")
    session.close()
    session.close()
    for operation in (
        session.load,
        session.reload,
        lambda: session.save({}, None),
        lambda: session.complete_reconciliation(
            {},
            None,
            outcome="validated_previous_only",
        ),
    ):
        with pytest.raises(RuntimeError):
            operation()


def test_session_close_closes_descriptors_and_keeps_stable_lock_leaf(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    ops = FaultOps()
    session = _open(cs, path, ops=ops)
    session.load()
    lock = _managed(path, ".lock")
    lock_identity = lock.stat()
    session.close()

    assert lock.is_file()
    assert (lock.stat().st_dev, lock.stat().st_ino) == (
        lock_identity.st_dev,
        lock_identity.st_ino,
    )
    assert ops.counters["unlink"] == 0
    for fd in ops.opened_fds:
        with pytest.raises(OSError) as raised:
            os.fstat(fd)
        assert raised.value.errno == errno.EBADF


def test_lock_leaf_persists_and_can_be_reacquired_after_session_close(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    first = _open(cs, path)
    first.load()
    first.close()
    lock = _managed(path, ".lock")
    identity = (lock.stat().st_dev, lock.stat().st_ino)

    with _open(cs, path) as second:
        assert second.load().mode == "bootstrap"

    assert lock.exists()
    assert (lock.stat().st_dev, lock.stat().st_ino) == identity


@pytest.mark.parametrize("damage", ("truncated", "wrong_root", "integrity_mismatch"))
def test_valid_previous_recovers_damaged_primary_with_one_receipt(
    tmp_path: Path,
    damage: str,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}, "members": ["retained"]},
            {"counters": {"seen": 2}, "members": ["newer"]},
        ),
    )
    marker_before = _json(_managed(path, ".initialized"))
    damaged = _damage_primary(path, damage)

    with _open(cs, path) as session:
        result = session.load()
        assert result.mode == "recovered"
        assert result.payload == {"counters": {"seen": 1}, "members": ["retained"]}
        assert result.capability is not None
        assert result.diagnostic.recovery_receipt_id
        evidence = _evidence_files(path)
        assert len(evidence) == 1
        assert next(iter(evidence)).read_bytes() == damaged
        restored = path.read_bytes()
        assert restored == _managed(path, ".previous").read_bytes()
        marker_during = _json(_managed(path, ".initialized"))
        assert marker_during["highWaterGeneration"] == marker_before["highWaterGeneration"]
        _assert_capability_rejected(
            cs,
            lambda: session.save(result.payload, result.capability),
        )
        committed = session.complete_reconciliation(
            result.payload,
            result.capability,
            outcome="validated_previous_only",
        )
        assert committed.generation > marker_before["highWaterGeneration"]


def test_recovery_receipt_and_evidence_identity_reused_across_restart(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}},
            {"counters": {"seen": 2}},
        ),
    )
    _damage_primary(path, "truncated")
    with _open(cs, path) as first:
        first_result = first.load()
        first_receipt = first_result.diagnostic.recovery_receipt_id
        first_evidence = _evidence_files(path)
    with _open(cs, path) as restarted:
        retry = restarted.load()

    assert retry.mode == "recovered"
    assert retry.diagnostic.recovery_receipt_id == first_receipt
    assert _evidence_files(path) == first_evidence
    assert retry.diagnostic.occurrence_count == min(
        first_result.diagnostic.occurrence_count + 1,
        _MAX_OCCURRENCE_COUNT,
    )


def test_recovery_occurrence_count_saturates_without_new_identity(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}},
            {"counters": {"seen": 2}},
        ),
    )
    _damage_primary(path, "truncated")
    with _open(cs, path) as first:
        first_result = first.load()
    receipt_path = _managed(path, ".recovery")
    receipt = _json(receipt_path)
    receipt["occurrenceCount"] = _MAX_OCCURRENCE_COUNT - 1
    _refresh_sidecar_integrity(receipt)
    _write_private_json(receipt_path, receipt)
    evidence = _evidence_files(path)

    with _open(cs, path) as second:
        second_result = second.load()
    with _open(cs, path) as third:
        third_result = third.load()

    assert second_result.diagnostic.occurrence_count == _MAX_OCCURRENCE_COUNT
    assert third_result.diagnostic.occurrence_count == _MAX_OCCURRENCE_COUNT
    assert second_result.diagnostic.recovery_receipt_id == first_result.diagnostic.recovery_receipt_id
    assert third_result.diagnostic.recovery_receipt_id == first_result.diagnostic.recovery_receipt_id
    assert _evidence_files(path) == evidence


def test_emergency_fallback_is_at_most_once_per_module_invocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cs = load_controller_state_module()
    diagnostic = cs.StateDiagnostic(
        component="collector",
        mode="recovery_required",
        current_generation=None,
        recovered_generation=None,
        reason="read_failed",
        recovery_receipt_id=None,
        occurrence_count=1,
    )
    writes: list[bytes] = []
    monkeypatch.setattr(cs.os, "write", lambda _fd, data: writes.append(data) or len(data))

    cs.emit_state_recovery_fallback(diagnostic)
    cs.emit_state_recovery_fallback(diagnostic)

    assert len(writes) == 1


def _corrupt_previous(path: Path) -> bytes:
    damaged = b'{"invalid-previous":'
    previous = _managed(path, ".previous")
    previous.write_bytes(damaged)
    previous.chmod(0o600)
    return damaged


def test_invalid_previous_is_preserved_durably_before_successful_save(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}},
            {"counters": {"seen": 2}},
        ),
    )
    damaged_previous = _corrupt_previous(path)
    ops = FaultOps()
    session, loaded = _load_valid(cs, path, ops=ops)
    ops.reset_trace()

    committed = session.save({"counters": {"seen": 3}}, loaded.capability)
    session.close()

    assert committed.mode == "valid"
    evidence = _evidence_files(path)
    assert any(candidate.read_bytes() == damaged_previous for candidate in evidence)
    evidence_fsync = min(
        index
        for index, call in enumerate(ops.calls)
        if call.name == "fsync_file" and ".previous" not in call.detail
    )
    evidence_directory_fsync = min(
        index
        for index, call in enumerate(ops.calls)
        if call.name == "fsync_directory" and "evidence" in call.detail
    )
    previous_replace = min(
        index
        for index, call in enumerate(ops.calls)
        if call.name == "replace" and call.detail.endswith("state.json.previous")
    )
    assert evidence_fsync < evidence_directory_fsync < previous_replace


@pytest.mark.parametrize(
    ("boundary", "detail"),
    (
        ("write", "evidence"),
        ("fsync_file", "evidence"),
        ("fsync_directory", "evidence"),
    ),
)
def test_invalid_previous_evidence_failure_preserves_both_authorities(
    tmp_path: Path,
    boundary: str,
    detail: str,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}},
            {"counters": {"seen": 2}},
        ),
    )
    _corrupt_previous(path)
    primary_before = path.read_bytes()
    previous_before = _managed(path, ".previous").read_bytes()
    ops = FaultOps()
    session, loaded = _load_valid(cs, path, ops=ops)
    ops.inject(boundary, detail_contains=detail)

    with pytest.raises(cs.ControllerStateRequired) as raised:
        session.save({"counters": {"seen": 3}}, loaded.capability)
    session.close()

    ops.assert_injected(boundary)
    assert raised.value.diagnostic.reason == "evidence_preservation_failed"
    assert path.read_bytes() == primary_before
    assert _managed(path, ".previous").read_bytes() == previous_before


@pytest.mark.parametrize(
    "case",
    (
        "no_previous",
        "corrupt_previous",
        "cross_store_previous",
        "future_primary",
        "evidence_write",
        "evidence_file_fsync",
        "evidence_directory_fsync",
        "directory_full",
        "permission_denied",
    ),
)
def test_unrecoverable_fault_returns_no_payload_or_authority(
    tmp_path: Path,
    case: str,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}},
            {"counters": {"seen": 2}},
        ),
    )
    previous = _managed(path, ".previous")
    if case == "no_previous":
        previous.unlink()
        _damage_primary(path, "truncated")
    elif case == "corrupt_previous":
        previous.write_bytes(b"{bad")
        _damage_primary(path, "truncated")
    elif case == "cross_store_previous":
        document = _json(previous)
        document["_controllerState"]["storeId"] = "f" * 32
        _refresh_envelope_integrity(document)
        _write_private_json(previous, document)
        _damage_primary(path, "truncated")
    elif case == "future_primary":
        document = _json(path)
        document["_controllerState"]["formatVersion"] = 2
        _refresh_envelope_integrity(document)
        _write_private_json(path, document)
    else:
        _damage_primary(path, "truncated")

    ops = FaultOps()
    fault_boundary = None
    if case == "evidence_write":
        fault_boundary = "write"
        ops.inject("write", detail_contains="evidence")
    elif case == "evidence_file_fsync":
        fault_boundary = "fsync_file"
        ops.inject("fsync_file", detail_contains="evidence")
    elif case == "evidence_directory_fsync":
        fault_boundary = "fsync_directory"
        ops.inject("fsync_directory", detail_contains="evidence")
    elif case == "directory_full":
        fault_boundary = "write"
        ops.inject(
            "write",
            error=OSError(errno.ENOSPC, "injected full directory"),
            detail_contains="evidence",
        )
    elif case == "permission_denied":
        fault_boundary = "write"
        ops.inject(
            "write",
            error=PermissionError(errno.EACCES, "injected permission denial"),
            detail_contains="evidence",
        )

    before = _authority_snapshot(path)
    with _open(cs, path, ops=ops) as session:
        result = session.load()
    _assert_recovery_required(result)
    if fault_boundary is not None:
        ops.assert_injected(fault_boundary)
    for suffix in ("", ".previous"):
        assert _authority_snapshot(path)[suffix] == before[suffix]


@dataclass(frozen=True)
class CrashCase:
    phase: str
    boundary: str
    detail: str
    matching_occurrence: int = 1


_TRANSACTION_CRASH_CASES = (
    CrashCase("journal_prepared", "fsync_directory", "after=state.json.transaction"),
    CrashCase("previous_temp_fsynced", "fsync_file", ".previous"),
    CrashCase("previous_renamed", "replace", "->state.json.previous"),
    CrashCase("previous_directory_synced", "fsync_directory", "after=state.json.previous"),
    CrashCase("primary_temp_fsynced", "fsync_file", "state.json", 2),
    CrashCase("primary_renamed", "replace", "->state.json", 2),
    CrashCase("primary_directory_synced", "fsync_directory", "after=state.json", 2),
    CrashCase("marker_renamed", "replace", "->state.json.initialized"),
    CrashCase("marker_directory_synced", "fsync_directory", "after=state.json.initialized"),
    CrashCase(
        "journal_advanced_previous_committed",
        "replace",
        "->state.json.transaction",
        2,
    ),
    CrashCase(
        "journal_advanced_primary_committed",
        "replace",
        "->state.json.transaction",
        3,
    ),
    CrashCase(
        "journal_advanced_marker_committed",
        "replace",
        "->state.json.transaction",
        4,
    ),
    CrashCase("journal_removed", "unlink", "state.json.transaction"),
    CrashCase(
        "journal_removal_directory_synced",
        "fsync_directory",
        "after=state.json.transaction",
        5,
    ),
)


def _interrupt_normal_save(
    cs: ModuleType,
    path: Path,
    crash: CrashCase,
) -> FaultOps:
    ops = FaultOps()
    session, loaded = _load_valid(cs, path, ops=ops)
    ops.reset_trace()
    ops.inject(
        crash.boundary,
        occurrence=crash.matching_occurrence,
        detail_contains=crash.detail,
        error=OSError(errno.EIO, f"injected crash at {crash.phase}"),
    )
    with pytest.raises(cs.ControllerStateRequired) as raised:
        session.save({"counters": {"seen": 3}}, loaded.capability)
    session.close()
    ops.assert_injected(crash.boundary)
    assert raised.value.diagnostic.mode == "recovery_required"
    return ops


@pytest.mark.parametrize("crash", _TRANSACTION_CRASH_CASES, ids=lambda case: case.phase)
def test_transaction_crash_matrix_reaches_every_durable_boundary(
    tmp_path: Path,
    crash: CrashCase,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}},
            {"counters": {"seen": 2}},
        ),
    )

    ops = _interrupt_normal_save(cs, path, crash)

    assert ops.counters[crash.boundary] > 0
    with _open(cs, path) as restarted:
        result = restarted.load()
        assert result.mode in {"valid", "reconciled", "recovery_required"}
        if result.mode != "recovery_required":
            assert result.payload == {"counters": {"seen": 3}}


@pytest.mark.parametrize(
    "phase",
    ("prepared", "previous_committed", "primary_committed", "marker_committed"),
)
def test_restart_resumes_each_exact_matching_transaction_phase(
    tmp_path: Path,
    phase: str,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}},
            {"counters": {"seen": 2}},
        ),
    )
    crash_by_phase = {
        "prepared": CrashCase("prepared", "replace", "->state.json.previous"),
        "previous_committed": CrashCase(
            "previous_committed",
            "replace",
            "->state.json",
            2,
        ),
        "primary_committed": CrashCase(
            "primary_committed",
            "replace",
            "->state.json.initialized",
        ),
        "marker_committed": CrashCase(
            "marker_committed",
            "unlink",
            "state.json.transaction",
        ),
    }
    _interrupt_normal_save(cs, path, crash_by_phase[phase])

    with _open(cs, path) as restarted:
        resumed = restarted.load()

    assert resumed.mode in {"valid", "reconciled"}
    assert resumed.payload == {"counters": {"seen": 3}}
    assert not _managed(path, ".transaction").exists()


@pytest.mark.parametrize(
    "phase",
    ("prepared", "previous_committed", "primary_committed", "marker_committed"),
)
def test_transaction_phase_mismatch_fails_closed(
    tmp_path: Path,
    phase: str,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}},
            {"counters": {"seen": 2}},
        ),
    )
    crash = {
        "prepared": CrashCase("prepared", "replace", "->state.json.previous"),
        "previous_committed": CrashCase(
            "previous_committed",
            "replace",
            "->state.json",
            2,
        ),
        "primary_committed": CrashCase(
            "primary_committed",
            "replace",
            "->state.json.initialized",
        ),
        "marker_committed": CrashCase(
            "marker_committed",
            "unlink",
            "state.json.transaction",
        ),
    }[phase]
    _interrupt_normal_save(cs, path, crash)
    journal = _managed(path, ".transaction")
    document = _json(journal)
    document["targetGeneration"] = int(document["targetGeneration"]) + 1
    _refresh_sidecar_integrity(document)
    _write_private_json(journal, document)

    with _open(cs, path) as restarted:
        _assert_recovery_required(restarted.load())


@pytest.mark.parametrize(
    "phase",
    (
        "planned",
        "evidence_preserved",
        "restored",
        "reconciliation_prepared",
    ),
)
def test_restart_resumes_each_exact_matching_recovery_phase(
    tmp_path: Path,
    phase: str,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}},
            {"counters": {"seen": 2}},
        ),
    )
    _damage_primary(path, "truncated")
    if phase == "planned":
        ops = FaultOps()
        ops.inject("write", detail_contains="evidence")
        with _open(cs, path, ops=ops) as session:
            _assert_recovery_required(session.load(), "evidence_preservation_failed")
        ops.assert_injected("write")
    else:
        with _open(cs, path) as session:
            recovered = session.load()
            assert recovered.mode == "recovered"
            if phase == "evidence_preserved":
                receipt_path = _managed(path, ".recovery")
                receipt = _json(receipt_path)
                receipt["phase"] = "evidence_preserved"
                _refresh_sidecar_integrity(receipt)
                _write_private_json(receipt_path, receipt)
            elif phase == "reconciliation_prepared":
                session.close()
                ops = FaultOps()
                retry = _open(cs, path, ops=ops)
                recovered = retry.load()
                ops.inject("replace", detail_contains="state.json.transaction")
                with pytest.raises(cs.ControllerStateRequired):
                    retry.complete_reconciliation(
                        recovered.payload,
                        recovered.capability,
                        outcome="validated_previous_only",
                    )
                ops.assert_injected("replace")
                retry.close()

    with _open(cs, path) as restarted:
        result = restarted.load()
        assert result.mode in {"recovered", "reconciled", "valid"}
        assert result.payload == {"counters": {"seen": 1}}


@pytest.mark.parametrize(
    "phase",
    (
        "planned",
        "evidence_preserved",
        "restored",
        "reconciliation_prepared",
    ),
)
def test_recovery_phase_sidecar_mismatch_fails_closed(
    tmp_path: Path,
    phase: str,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}},
            {"counters": {"seen": 2}},
        ),
    )
    _damage_primary(path, "truncated")
    with _open(cs, path) as session:
        assert session.load().mode == "recovered"
    receipt_path = _managed(path, ".recovery")
    receipt = _json(receipt_path)
    receipt["phase"] = phase
    receipt["storeId"] = "f" * 32
    _refresh_sidecar_integrity(receipt)
    _write_private_json(receipt_path, receipt)

    with _open(cs, path) as restarted:
        _assert_recovery_required(restarted.load())


def test_diagnostic_mapping_is_closed_bounded_and_content_free() -> None:
    cs = load_controller_state_module()
    diagnostic = cs.StateDiagnostic(
        component="dispatcher-incident",
        mode="recovery_required",
        current_generation=12,
        recovered_generation=11,
        reason="integrity_mismatch",
        recovery_receipt_id="opaque_receipt_01",
        occurrence_count=3,
    )

    details = cs.state_diagnostic_details(diagnostic)

    assert details == {
        "schemaVersion": 1,
        "component": "dispatcher-incident",
        "stateMode": "recovery_required",
        "reason": "integrity_mismatch",
        "currentGeneration": 12,
        "recoveredGeneration": 11,
        "recoveryReceiptId": "opaque_receipt_01",
        "occurrenceCount": 3,
    }
    encoded = _canonical_bytes(details)
    assert len(encoded) <= 4096
    for forbidden in (
        "raw exception text",
        "/private/state.json",
        "evidence-leaf",
        "payloadKey",
        "payloadValue",
        "environmentValue",
        "integritySha256",
        "storeId",
        _STORE_ID,
    ):
        assert forbidden not in encoded.decode("utf-8")


def test_diagnostic_without_durable_receipt_does_not_fabricate_identity() -> None:
    cs = load_controller_state_module()
    diagnostic = cs.StateDiagnostic(
        component="collector",
        mode="recovery_required",
        current_generation=None,
        recovered_generation=None,
        reason="read_failed",
        recovery_receipt_id=None,
        occurrence_count=1,
    )
    details = cs.state_diagnostic_details(diagnostic)
    assert details["recoveryReceiptId"] is None


def test_fallback_is_one_bounded_json_line_with_only_closed_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cs = load_controller_state_module()
    diagnostic = cs.StateDiagnostic(
        component="collector",
        mode="recovery_required",
        current_generation=None,
        recovered_generation=None,
        reason="read_failed",
        recovery_receipt_id=None,
        occurrence_count=1,
    )
    writes: list[tuple[int, bytes]] = []
    monkeypatch.setattr(
        cs.os,
        "write",
        lambda fd, data: writes.append((fd, data)) or len(data),
    )

    cs.emit_state_recovery_fallback(diagnostic)

    assert len(writes) == 1
    fd, raw = writes[0]
    assert fd == 2
    assert raw.endswith(b"\n")
    assert raw.count(b"\n") == 1
    parsed = json.loads(raw)
    assert parsed == cs.state_diagnostic_details(diagnostic)
    assert set(parsed) == {
        "schemaVersion",
        "component",
        "stateMode",
        "reason",
        "currentGeneration",
        "recoveredGeneration",
        "recoveryReceiptId",
        "occurrenceCount",
    }


def test_stderr_failure_cannot_replace_typed_non_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cs = load_controller_state_module()
    diagnostic = cs.StateDiagnostic(
        component="collector",
        mode="recovery_required",
        current_generation=None,
        recovered_generation=None,
        reason="read_failed",
        recovery_receipt_id=None,
        occurrence_count=1,
    )
    error = cs.ControllerStateRequired(diagnostic)
    monkeypatch.setattr(
        cs.os,
        "write",
        lambda _fd, _data: (_ for _ in ()).throw(OSError(errno.EIO, "stderr failed")),
    )

    assert cs.emit_state_recovery_fallback(diagnostic) is None
    assert error.diagnostic is diagnostic
    assert str(error) == "controller state recovery required"
