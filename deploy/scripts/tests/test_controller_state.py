"""Executable contract for integrity-bound controller state recovery.

This suite intentionally precedes ``lib/controller_state.py``.  It exercises the
public contract through real files and a deterministic syscall-boundary adapter;
it does not provide a test implementation of the production helper.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import MISSING, FrozenInstanceError, dataclass, fields
from datetime import datetime, timedelta, timezone
import errno
import fcntl
import hashlib
import importlib.util
import inspect
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import time
from types import ModuleType
from typing import Any, Literal, get_args, get_type_hints

import pytest


_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
_MODULE_PATH = _SCRIPT_ROOT / "lib" / "controller_state.py"
_COMPONENT = "collector"
_STORE_ID = "00112233445566778899aabbccddeeff"
_FORMAT = "whatsoup.controller-state"
_FORMAT_VERSION = 1
_MAX_GENERATION = 2**53 - 1
_MAX_OCCURRENCE_COUNT = 2**31 - 1
_HEX32 = re.compile(r"[0-9a-f]{32}")
_HEX64 = re.compile(r"[0-9a-f]{64}")
_UTC_MILLISECOND_TIMESTAMP = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"
)
_MANAGED_SUFFIXES = (
    "",
    ".previous",
    ".initialized",
    ".transaction",
    ".recovery",
    ".lock",
)
_ENVELOPE_METADATA_KEYS = {
    "format",
    "formatVersion",
    "component",
    "storeId",
    "generation",
    "writtenAt",
    "integritySha256",
}
_MARKER_KEYS = {
    "format",
    "formatVersion",
    "component",
    "storeId",
    "highWaterGeneration",
    "highWaterIntegritySha256",
    "integritySha256",
}
_RECOVERY_RECEIPT_BASE_KEYS = {
    "format",
    "formatVersion",
    "recoveryReceiptId",
    "component",
    "storeId",
    "phase",
    "reason",
    "occurrenceCount",
    "markerHighWaterGeneration",
    "markerHighWaterIntegritySha256",
    "recoveredGeneration",
    "recoveredIntegritySha256",
    "targetGeneration",
    "targetIntegritySha256",
    "integritySha256",
}
_JOURNAL_KEYS = {
    "format",
    "formatVersion",
    "transactionId",
    "component",
    "storeId",
    "operation",
    "phase",
    "expectedGeneration",
    "targetGeneration",
    "expectedHighWaterGeneration",
    "targetHighWaterGeneration",
    "expectedIntegritySha256",
    "targetIntegritySha256",
    "expectedHighWaterIntegritySha256",
    "targetHighWaterIntegritySha256",
    "legacySourceSha256",
    "previousEnvelope",
    "targetEnvelope",
    "integritySha256",
}
_GOLDEN_PREIMAGE_KEYS = {
    "format",
    "formatVersion",
    "component",
    "storeId",
    "generation",
    "writtenAt",
    "payload",
}
_GOLDEN_CANONICAL_PREIMAGE = (
    b'{"component":"collector","format":"whatsoup.controller-state",'
    b'"formatVersion":1,"generation":7,"payload":{"counters":{"seen":3},'
    b'"label":"caf\xc3\xa9","ordered":[2,1]},'
    b'"storeId":"00112233445566778899aabbccddeeff",'
    b'"writtenAt":"2026-07-28T21:00:00.000Z"}'
)
_GOLDEN_INTEGRITY_SHA256 = (
    "d8e1f7ff058ff0e38a0e10338bae0e4cd487be1bac3d846d0179907e6879c564"
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
    role: str | None = None
    identity: tuple[int, int] | None = None


@dataclass
class FaultRule:
    name: str
    matching_occurrence: int
    error: BaseException
    predicate: Callable[[BoundaryCall], bool]
    matches: int = 0
    fired: bool = False


class SimulatedCrash(BaseException):
    """Abrupt process loss after a real syscall has completed successfully."""


@dataclass
class CrashRule:
    name: str
    matching_occurrence: int
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
        self.crash_rules: list[CrashRule] = []
        self.fd_paths: dict[int, str] = {}
        self.fd_identities: dict[int, tuple[int, int]] = {}
        self.fd_roles: dict[int, str | None] = {}
        self.path_roles: dict[str, str] = {}
        self.read_identities: Counter[tuple[int, int]] = Counter()
        self.write_identities: Counter[tuple[int, int]] = Counter()
        self.chmod_identities: Counter[tuple[int, int]] = Counter()
        self.opened_fds: set[int] = set()
        self.closed_fds: set[int] = set()
        self.last_namespace_target = ""
        self.last_namespace_role: str | None = None
        self.store_path: Path | None = None
        self.managed_names: dict[str, str] = {}
        self.expected_unmanaged_role: str | None = None
        self.recovery_receipt_syncs = 0
        self.after_hooks: dict[tuple[str, int], Callable[[], None]] = {}
        self.fstat_transform: Callable[[int, os.stat_result], os.stat_result] | None = None
        self.after_fstat: Callable[[int, os.stat_result], None] | None = None

    def bind_store(self, path: Path) -> None:
        self.store_path = path
        self.managed_names = {
            _managed(path, suffix).name: (
                "primary" if suffix == "" else suffix.removeprefix(".")
            )
            for suffix in _MANAGED_SUFFIXES
        }

    def expect_next_unmanaged_creation(self, role: str) -> None:
        assert role and role not in self.managed_names.values()
        self.expected_unmanaged_role = role

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

    def crash_after(
        self,
        name: str,
        *,
        occurrence: int = 1,
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
        self.crash_rules.append(
            CrashRule(
                name=name,
                matching_occurrence=occurrence,
                predicate=predicate,
            )
        )

    def hook_after(self, name: str, occurrence: int, action: Callable[[], None]) -> None:
        self.after_hooks[(name, occurrence)] = action

    def reset_trace(self) -> None:
        self.calls.clear()
        self.counters.clear()
        self.rules.clear()
        self.crash_rules.clear()
        self.last_namespace_target = ""
        self.last_namespace_role = None

    def _record(
        self,
        name: str,
        detail: str,
        *,
        role: str | None = None,
        identity: tuple[int, int] | None = None,
    ) -> BoundaryCall:
        self.counters[name] += 1
        call = BoundaryCall(name, self.counters[name], detail, role, identity)
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
        for rule in self.crash_rules:
            if rule.fired or rule.name != call.name or not rule.predicate(call):
                continue
            rule.matches += 1
            if rule.matches == rule.matching_occurrence:
                rule.fired = True
                raise SimulatedCrash(
                    f"simulated crash after {call.name} occurrence {call.occurrence}"
                )

    @staticmethod
    def _path_detail(path: os.PathLike[str] | str, dir_fd: int | None) -> str:
        prefix = f"dirfd={dir_fd}:" if dir_fd is not None else ""
        return prefix + os.fspath(path)

    def _path_key(self, path: os.PathLike[str] | str, dir_fd: int | None) -> str:
        return self._path_detail(path, dir_fd)

    def _fixed_role(self, path: os.PathLike[str] | str) -> str | None:
        return self.managed_names.get(Path(os.fspath(path)).name)

    def open(
        self,
        path: os.PathLike[str] | str,
        flags: int,
        mode: int = 0o600,
        *,
        dir_fd: int | None = None,
    ) -> int:
        detail = self._path_detail(path, dir_fd)
        role = self._fixed_role(path)
        if flags & os.O_CREAT and role is None and self.expected_unmanaged_role is not None:
            role = self.expected_unmanaged_role
            self.expected_unmanaged_role = None
        call = self._record("open", detail, role=role)
        if flags & os.O_CREAT:
            fd = os.open(path, flags, mode, dir_fd=dir_fd)
        else:
            fd = os.open(path, flags, dir_fd=dir_fd)
        self.fd_paths[fd] = detail
        observed = os.fstat(fd)
        identity = (observed.st_dev, observed.st_ino)
        self.fd_identities[fd] = identity
        self.fd_roles[fd] = role
        if role is not None:
            self.path_roles[self._path_key(path, dir_fd)] = role
        if flags & os.O_CREAT:
            self.last_namespace_target = os.fspath(path)
            self.last_namespace_role = role
        self.opened_fds.add(fd)
        self._after(call)
        return fd

    def fstat(self, fd: int) -> os.stat_result:
        call = self._record(
            "fstat",
            self.fd_paths.get(fd, f"fd={fd}"),
            role=self.fd_roles.get(fd),
            identity=self.fd_identities.get(fd),
        )
        result = os.fstat(fd)
        if self.fstat_transform is not None:
            result = self.fstat_transform(fd, result)
        self._after(call)
        if self.after_fstat is not None:
            self.after_fstat(fd, result)
        return result

    def read(self, fd: int, size: int) -> bytes:
        identity = self.fd_identities.get(fd)
        call = self._record(
            "read",
            self.fd_paths.get(fd, f"fd={fd}"),
            role=self.fd_roles.get(fd),
            identity=identity,
        )
        if identity is not None:
            self.read_identities[identity] += 1
        result = os.read(fd, size)
        self._after(call)
        return result

    def write(self, fd: int, data: bytes) -> int:
        identity = self.fd_identities.get(fd)
        call = self._record(
            "write",
            self.fd_paths.get(fd, f"fd={fd}"),
            role=self.fd_roles.get(fd),
            identity=identity,
        )
        if identity is not None:
            self.write_identities[identity] += 1
        result = os.write(fd, data)
        self._after(call)
        return result

    def fsync_file(self, fd: int) -> None:
        call = self._record(
            "fsync_file",
            self.fd_paths.get(fd, f"fd={fd}"),
            role=self.fd_roles.get(fd),
            identity=self.fd_identities.get(fd),
        )
        os.fsync(fd)
        self._after(call)

    def fsync_directory(self, fd: int) -> None:
        path = self.fd_paths.get(fd, f"fd={fd}")
        call = self._record(
            "fsync_directory",
            (
                f"{path};after={self.last_namespace_target};"
                f"after_role={self.last_namespace_role}"
            ),
            role=self.last_namespace_role,
            identity=self.fd_identities.get(fd),
        )
        os.fsync(fd)
        if self.last_namespace_role == "recovery" and self.store_path is not None:
            receipt_path = _managed(self.store_path, ".recovery")
            if receipt_path.exists():
                receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                if receipt.get("phase") == "planned" and self.recovery_receipt_syncs == 0:
                    self.expected_unmanaged_role = "evidence"
                self.recovery_receipt_syncs += 1
        if self.last_namespace_role == "transaction" and self.store_path is not None:
            journal_path = _managed(self.store_path, ".transaction")
            if journal_path.exists():
                journal = json.loads(journal_path.read_text(encoding="utf-8"))
                next_role = {
                    "prepared": "previous_temp",
                    "previous_committed": "primary_temp",
                    "primary_committed": "initialized_temp",
                }.get(journal.get("phase"))
                if next_role is not None:
                    self.expected_unmanaged_role = next_role
        elif self.last_namespace_role in {"previous", "primary", "initialized"}:
            self.expected_unmanaged_role = "transaction_temp"
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
        source_role = self.path_roles.get(self._path_key(source, src_dir_fd))
        target_role = self._fixed_role(target)
        role = target_role or source_role
        call = self._record("replace", detail, role=role)
        os.replace(source, target, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)
        self.last_namespace_target = os.fspath(target)
        self.last_namespace_role = role
        if role is not None:
            self.path_roles[self._path_key(target, dst_dir_fd)] = role
        self._after(call)

    def unlink(
        self,
        path: os.PathLike[str] | str,
        *,
        dir_fd: int | None = None,
    ) -> None:
        detail = self._path_detail(path, dir_fd)
        role = self.path_roles.get(self._path_key(path, dir_fd)) or self._fixed_role(path)
        call = self._record("unlink", detail, role=role)
        os.unlink(path, dir_fd=dir_fd)
        self.last_namespace_target = os.fspath(path)
        self.last_namespace_role = role
        self._after(call)

    def flock(self, fd: int, operation: int) -> None:
        call = self._record(
            "flock",
            self.fd_paths.get(fd, f"fd={fd}"),
            role=self.fd_roles.get(fd),
            identity=self.fd_identities.get(fd),
        )
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
        try:
            observed = os.stat(path, dir_fd=dir_fd, follow_symlinks=follow_symlinks)
        except OSError:
            observed = None
        if observed is not None:
            self.chmod_identities[(observed.st_dev, observed.st_ino)] += 1
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

    def assert_all_rules_fired(self) -> None:
        assert self.rules or self.crash_rules
        for rule in (*self.rules, *self.crash_rules):
            assert rule.fired, (
                f"{rule.name} rule did not reach matching occurrence "
                f"{rule.matching_occurrence}"
            )
            assert self.counters[rule.name] > 0


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


def _write_private_raw(path: Path, value: bytes) -> None:
    path.write_bytes(value)
    path.chmod(0o600)


def _json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def _assert_generation(value: Any, *, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    assert isinstance(value, int) and not isinstance(value, bool)
    assert 0 <= value <= _MAX_GENERATION


def _assert_digest(value: Any, *, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    assert isinstance(value, str)
    assert _HEX64.fullmatch(value)


def _assert_envelope_contract(
    document: dict[str, Any],
    *,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    assert "_controllerState" in document
    projected_payload = {
        key: value for key, value in document.items() if key != "_controllerState"
    }
    if payload is not None:
        assert projected_payload == payload
    metadata = document["_controllerState"]
    assert isinstance(metadata, dict)
    assert set(metadata) == _ENVELOPE_METADATA_KEYS
    assert metadata["format"] == _FORMAT
    assert metadata["formatVersion"] == _FORMAT_VERSION
    assert metadata["component"] in {
        "collector",
        "heartbeat-watchdog",
        "dispatcher-incident",
    }
    assert isinstance(metadata["storeId"], str)
    assert _HEX32.fullmatch(metadata["storeId"])
    _assert_generation(metadata["generation"])
    assert isinstance(metadata["writtenAt"], str)
    assert _UTC_MILLISECOND_TIMESTAMP.fullmatch(metadata["writtenAt"])
    datetime.strptime(metadata["writtenAt"], "%Y-%m-%dT%H:%M:%S.%fZ")
    _assert_digest(metadata["integritySha256"])
    preimage = {
        key: value for key, value in metadata.items() if key != "integritySha256"
    }
    preimage["payload"] = projected_payload
    assert set(preimage) == _GOLDEN_PREIMAGE_KEYS
    assert metadata["integritySha256"] == _integrity(preimage)
    return metadata


def _assert_marker_contract(
    marker: dict[str, Any],
    *,
    authority: dict[str, Any] | None = None,
) -> None:
    assert set(marker) == _MARKER_KEYS
    assert marker["format"] == _FORMAT
    assert marker["formatVersion"] == _FORMAT_VERSION
    assert marker["component"] in {
        "collector",
        "heartbeat-watchdog",
        "dispatcher-incident",
    }
    assert isinstance(marker["storeId"], str)
    assert _HEX32.fullmatch(marker["storeId"])
    _assert_generation(marker["highWaterGeneration"])
    _assert_digest(marker["highWaterIntegritySha256"])
    _assert_digest(marker["integritySha256"])
    _assert_sidecar_integrity(marker)
    if authority is not None:
        metadata = _assert_envelope_contract(authority)
        assert marker["component"] == metadata["component"]
        assert marker["storeId"] == metadata["storeId"]
        assert marker["highWaterGeneration"] == metadata["generation"]
        assert marker["highWaterIntegritySha256"] == metadata["integritySha256"]


def _assert_fd2_line(action: Callable[[], Any]) -> tuple[Any, bytes]:
    read_fd, write_fd = os.pipe()
    saved_stderr = os.dup(2)
    try:
        os.dup2(write_fd, 2)
        os.close(write_fd)
        result = action()
    finally:
        os.dup2(saved_stderr, 2)
        os.close(saved_stderr)
    chunks = []
    try:
        while chunk := os.read(read_fd, 4096):
            chunks.append(chunk)
    finally:
        os.close(read_fd)
    return result, b"".join(chunks)


def _with_closed_fd2(action: Callable[[], Any]) -> Any:
    saved_stderr = os.dup(2)
    try:
        os.close(2)
        return action()
    finally:
        os.dup2(saved_stderr, 2)
        os.close(saved_stderr)


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


@dataclass(frozen=True)
class EvidenceIdentity:
    path: Path
    device: int
    inode: int
    mode: int
    data: bytes


def _evidence_snapshot(path: Path) -> tuple[EvidenceIdentity, ...]:
    identities = []
    for candidate in sorted(_evidence_files(path)):
        observed = candidate.stat()
        identities.append(
            EvidenceIdentity(
                path=candidate,
                device=observed.st_dev,
                inode=observed.st_ino,
                mode=stat.S_IMODE(observed.st_mode),
                data=candidate.read_bytes(),
            )
        )
    return tuple(identities)


def _file_identity(path: Path, *, follow_symlinks: bool = True) -> tuple[int, int]:
    observed = path.stat() if follow_symlinks else path.lstat()
    return observed.st_dev, observed.st_ino


def _authority_identities(path: Path) -> set[tuple[int, int]]:
    identities = set()
    for suffix in _MANAGED_SUFFIXES:
        candidate = _managed(path, suffix)
        if candidate.exists() and not candidate.is_symlink():
            identities.add(_file_identity(candidate))
    return identities


def _assert_no_forbidden_effects(
    ops: FaultOps,
    *,
    protected_identities: set[tuple[int, int]],
) -> None:
    for identity in protected_identities:
        assert ops.read_identities[identity] == 0
        assert ops.write_identities[identity] == 0
        assert ops.chmod_identities[identity] == 0
    assert ops.counters["write"] == 0
    assert ops.counters["chmod"] == 0
    assert ops.counters["replace"] == 0
    assert ops.counters["unlink"] == 0


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
    if ops is not None:
        ops.bind_store(path)
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
    if ops is not None:
        ops.bind_store(path)
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


def _assert_capability_rejected_without_mutation(
    cs: ModuleType,
    path: Path,
    ops: FaultOps,
    operation: Callable[[], Any],
) -> None:
    before = _authority_snapshot(path)
    ops.reset_trace()
    with pytest.raises(cs.ControllerStateRequired):
        operation()
    assert _authority_snapshot(path) == before
    assert ops.counters["write"] == 0
    assert ops.counters["replace"] == 0
    assert ops.counters["unlink"] == 0


def _clone_opaque_capability(capability: Any) -> Any:
    clone = object.__new__(type(capability))
    if hasattr(capability, "__dict__"):
        for name, value in vars(capability).items():
            object.__setattr__(clone, name, value)
    for owner in type(capability).__mro__:
        slots = getattr(owner, "__slots__", ())
        if isinstance(slots, str):
            slots = (slots,)
        for name in slots:
            if name in {"__dict__", "__weakref__"} or not hasattr(capability, name):
                continue
            object.__setattr__(clone, name, getattr(capability, name))
    assert clone is not capability
    return clone


def _rewrite_coherent_binding(
    path: Path,
    *,
    component: str | None = None,
    store_id: str | None = None,
) -> None:
    primary_integrity = None
    for suffix in ("", ".previous"):
        envelope_path = _managed(path, suffix)
        if not envelope_path.exists():
            continue
        envelope = _json(envelope_path)
        if component is not None:
            envelope["_controllerState"]["component"] = component
        if store_id is not None:
            envelope["_controllerState"]["storeId"] = store_id
        _refresh_envelope_integrity(envelope)
        _write_private_json(envelope_path, envelope)
        if suffix == "":
            primary_integrity = envelope["_controllerState"]["integritySha256"]
    marker_path = _managed(path, ".initialized")
    marker = _json(marker_path)
    if component is not None:
        marker["component"] = component
    if store_id is not None:
        marker["storeId"] = store_id
    marker["highWaterIntegritySha256"] = primary_integrity
    _refresh_sidecar_integrity(marker)
    _write_private_json(marker_path, marker)


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
        "StateWriteCapability",
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
    assert cs.JsonObject == dict[str, Any]
    assert get_args(cs.StateComponent) == (
        "collector",
        "heartbeat-watchdog",
        "dispatcher-incident",
    )
    assert get_args(cs.StateMode) == (
        "bootstrap",
        "valid",
        "recovered",
        "reconciled",
        "recovery_required",
    )
    assert get_args(cs.ReadMode) == (
        "valid",
        "legacy_valid",
        "recovery_pending",
        "unavailable",
    )
    assert get_args(cs.RecoveryOutcome) == (
        "validated_previous_only",
        "authoritative_reconciliation",
    )
    assert get_args(cs.StateReason) == (
        "read_failed",
        "unsafe_file",
        "decode_failed",
        "invalid_root",
        "schema_incompatible",
        "integrity_mismatch",
        "generation_invalid",
        "publication_ambiguous",
        "evidence_preservation_failed",
        "lock_unavailable",
    )

    session = _open(cs, tmp_path / "state.json")
    assert isinstance(session, cs.ControllerStateSession)
    assert session.__enter__() is session
    assert {"load", "reload", "save", "complete_reconciliation", "close"} <= set(
        dir(session)
    )
    session.close()


def _assert_parameters(
    function: Callable[..., Any],
    expected: tuple[tuple[str, inspect._ParameterKind, Any], ...],
) -> None:
    signature = inspect.signature(function)
    assert tuple(signature.parameters) == tuple(name for name, _kind, _default in expected)
    for name, kind, default in expected:
        parameter = signature.parameters[name]
        assert parameter.kind is kind
        if default is inspect.Parameter.empty:
            assert parameter.default is inspect.Parameter.empty
        else:
            assert parameter.default == default
    assert signature.return_annotation is not inspect.Signature.empty


def _assert_resolved_hints(
    function: Callable[..., Any],
    expected: dict[str, Any],
) -> None:
    assert get_type_hints(function) == expected


def test_public_functions_and_session_methods_have_exact_signatures() -> None:
    cs = load_controller_state_module()
    positional = inspect.Parameter.POSITIONAL_OR_KEYWORD
    keyword_only = inspect.Parameter.KEYWORD_ONLY
    required = inspect.Parameter.empty

    _assert_parameters(
        cs.open_controller_state,
        (
            ("path", positional, required),
            ("component", keyword_only, required),
            ("bootstrap", keyword_only, required),
            ("validate_payload", keyword_only, required),
            ("lock_timeout_seconds", keyword_only, required),
            ("clock", keyword_only, None),
            ("random_bytes", keyword_only, None),
            ("file_ops", keyword_only, None),
        ),
    )
    _assert_parameters(
        cs.read_controller_state,
        (
            ("path", positional, required),
            ("component", keyword_only, required),
            ("validate_payload", keyword_only, required),
            ("lock_timeout_seconds", keyword_only, required),
            ("file_ops", keyword_only, None),
        ),
    )
    for name in ("load", "reload", "close"):
        _assert_parameters(
            getattr(cs.ControllerStateSession, name),
            (("self", positional, required),),
        )
    _assert_parameters(
        cs.ControllerStateSession.save,
        (
            ("self", positional, required),
            ("payload", positional, required),
            ("capability", positional, required),
        ),
    )
    _assert_parameters(
        cs.ControllerStateSession.complete_reconciliation,
        (
            ("self", positional, required),
            ("payload", positional, required),
            ("capability", positional, required),
            ("outcome", keyword_only, required),
        ),
    )
    _assert_parameters(
        cs.emit_state_recovery_fallback,
        (("diagnostic", positional, required),),
    )
    _assert_parameters(
        cs.state_diagnostic_details,
        (("diagnostic", positional, required),),
    )
    json_validator = Callable[[Mapping[str, Any]], dict[str, Any]]
    _assert_resolved_hints(
        cs.open_controller_state,
        {
            "path": Path,
            "component": cs.StateComponent,
            "bootstrap": Callable[[], dict[str, Any]],
            "validate_payload": json_validator,
            "lock_timeout_seconds": float,
            "clock": Callable[[], datetime] | None,
            "random_bytes": Callable[[int], bytes] | None,
            "file_ops": Any | None,
            "return": cs.ControllerStateSession,
        },
    )
    _assert_resolved_hints(
        cs.read_controller_state,
        {
            "path": Path,
            "component": cs.StateComponent,
            "validate_payload": json_validator,
            "lock_timeout_seconds": float,
            "file_ops": Any | None,
            "return": cs.StateReadResult,
        },
    )
    for name in ("load", "reload"):
        _assert_resolved_hints(
            getattr(cs.ControllerStateSession, name),
            {"return": cs.StateLoadResult},
        )
    _assert_resolved_hints(
        cs.ControllerStateSession.save,
        {
            "payload": Mapping[str, Any],
            "capability": cs.StateWriteCapability,
            "return": cs.StateCommitResult,
        },
    )
    _assert_resolved_hints(
        cs.ControllerStateSession.complete_reconciliation,
        {
            "payload": Mapping[str, Any],
            "capability": cs.StateWriteCapability,
            "outcome": cs.RecoveryOutcome,
            "return": cs.StateCommitResult,
        },
    )
    _assert_resolved_hints(
        cs.ControllerStateSession.close,
        {"return": type(None)},
    )
    _assert_resolved_hints(
        cs.emit_state_recovery_fallback,
        {"diagnostic": cs.StateDiagnostic, "return": type(None)},
    )
    _assert_resolved_hints(
        cs.state_diagnostic_details,
        {"diagnostic": cs.StateDiagnostic, "return": dict[str, Any]},
    )


def test_all_declared_records_have_exact_frozen_field_contract() -> None:
    cs = load_controller_state_module()
    expected_fields = {
        cs.StateDiagnostic: (
            ("component", cs.StateComponent),
            ("mode", cs.StateMode),
            ("current_generation", int | None),
            ("recovered_generation", int | None),
            ("reason", cs.StateReason | None),
            ("recovery_receipt_id", str | None),
            ("occurrence_count", int),
        ),
        cs.StateLoadResult: (
            ("mode", cs.StateMode),
            ("payload", dict[str, Any] | None),
            ("capability", cs.StateWriteCapability | None),
            ("diagnostic", cs.StateDiagnostic),
        ),
        cs.StateReadResult: (
            ("mode", cs.ReadMode),
            ("payload", dict[str, Any] | None),
            ("generation", int | None),
            ("reason", cs.StateReason | None),
        ),
        cs.StateCommitResult: (
            ("mode", Literal["valid", "reconciled"]),
            ("generation", int),
            ("capability", cs.StateWriteCapability),
            ("diagnostic", cs.StateDiagnostic),
        ),
    }
    for record_type, expected in expected_fields.items():
        declared = fields(record_type)
        resolved = get_type_hints(record_type)
        assert tuple(field.name for field in declared) == tuple(
            name for name, _annotation in expected
        )
        assert tuple(resolved[field.name] for field in declared) == tuple(
            annotation for _name, annotation in expected
        )
        assert all(field.default is MISSING for field in declared)
        assert all(field.default_factory is MISSING for field in declared)
        assert record_type.__dataclass_params__.frozen is True

    diagnostic = cs.StateDiagnostic(
        component="collector",
        mode="bootstrap",
        current_generation=None,
        recovered_generation=None,
        reason=None,
        recovery_receipt_id=None,
        occurrence_count=0,
    )
    records = (
        diagnostic,
        cs.StateLoadResult(
            mode="bootstrap",
            payload={},
            capability=None,
            diagnostic=diagnostic,
        ),
        cs.StateReadResult(
            mode="valid",
            payload={},
            generation=1,
            reason=None,
        ),
        cs.StateCommitResult(
            mode="valid",
            generation=1,
            capability=object(),
            diagnostic=diagnostic,
        ),
    )
    for record in records:
        first_field = next(iter(record.__dataclass_fields__))
        with pytest.raises(FrozenInstanceError):
            setattr(record, first_field, None)


def test_frozen_canonical_integrity_vector_has_exact_preimage_keys() -> None:
    preimage = {
        "format": "whatsoup.controller-state",
        "formatVersion": 1,
        "component": "collector",
        "storeId": _STORE_ID,
        "generation": 7,
        "writtenAt": "2026-07-28T21:00:00.000Z",
        "payload": {
            "counters": {"seen": 3},
            "label": "caf\u00e9",
            "ordered": [2, 1],
        },
    }
    assert set(preimage) == _GOLDEN_PREIMAGE_KEYS
    assert _canonical_bytes(preimage) == _GOLDEN_CANONICAL_PREIMAGE
    assert hashlib.sha256(_GOLDEN_CANONICAL_PREIMAGE).hexdigest() == (
        _GOLDEN_INTEGRITY_SHA256
    )


@pytest.mark.parametrize(
    ("payload", "probe"),
    (
        ({"z": 1, "a": 2, "counters": {}}, b'"a":2,"counters":{},"z":1'),
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
    assert set(document) == set(payload) | {"_controllerState"}
    metadata = _assert_envelope_contract(document, payload=payload)
    assert metadata["generation"] == 1
    marker = _json(_managed(path, ".initialized"))
    _assert_marker_contract(marker, authority=document)


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
        committed = session.save(
            {"counters": {"valid_after_rejection": 1}},
            loaded.capability,
        )
        assert committed.mode == "valid"
        assert committed.generation == 1


def test_payload_validator_rejection_does_not_consume_capability(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    with _open(
        cs,
        path,
        bootstrap=lambda: {"version": 1, "counters": {}},
        validator=validate_versioned_payload,
    ) as session:
        loaded = session.load()
        before = _authority_snapshot(path)
        with pytest.raises((ValueError, cs.ControllerStateRequired)):
            session.save(
                {"version": 2, "counters": {"invalid": 1}},
                loaded.capability,
            )
        assert _authority_snapshot(path) == before
        committed = session.save(
            {"version": 1, "counters": {"valid_after_rejection": 1}},
            loaded.capability,
        )
        assert committed.mode == "valid"
        assert committed.generation == 1


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
        ops.assert_all_rules_fired()
        assert ops.counters["replace"] > 0
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
    raw_legacy = (
        b'{ "members" : ["alpha","caf\xc3\xa9"], '
        b'"counters" : { "open" : 4 } }\n'
    )
    legacy = {"members": ["alpha", "caf\u00e9"], "counters": {"open": 4}}
    assert raw_legacy != _canonical_bytes(legacy)
    assert b"caf\xc3\xa9" in raw_legacy
    _write_private_raw(path, raw_legacy)
    assert path.read_bytes() == raw_legacy

    with _open(cs, path) as session:
        result = session.load()
        assert result.mode == "reconciled"
        assert result.payload == legacy
        assert result.capability is not None
    migrated = _json(path)
    migrated_metadata = _assert_envelope_contract(migrated, payload=legacy)
    assert migrated_metadata["generation"] == 1
    previous = _json(_managed(path, ".previous"))
    previous_metadata = _assert_envelope_contract(previous, payload=legacy)
    assert previous_metadata["generation"] == 0
    assert migrated_metadata["storeId"] == previous_metadata["storeId"]
    _assert_marker_contract(
        _json(_managed(path, ".initialized")),
        authority=migrated,
    )


def test_migration_journal_binds_exact_noncanonical_legacy_bytes(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    raw_legacy = b'{ "members" : ["caf\xc3\xa9"], "counters" : {"open":4} }\n'
    _write_private_raw(path, raw_legacy)
    ops = FaultOps()
    ops.crash_after(
        "fsync_directory",
        predicate=lambda call: call.role == "transaction"
        and _managed(path, ".transaction").exists()
        and _json(_managed(path, ".transaction")).get("phase") == "prepared",
    )
    session = _open(cs, path, ops=ops)
    try:
        with pytest.raises(SimulatedCrash):
            session.load()
    finally:
        session.close()

    ops.assert_all_rules_fired()
    journal = _json(_managed(path, ".transaction"))
    _assert_generated_journal_contract(journal)
    assert journal["operation"] == "migration"
    assert journal["phase"] == "prepared"
    assert journal["legacySourceSha256"] == hashlib.sha256(raw_legacy).hexdigest()
    assert path.read_bytes() == raw_legacy


def test_read_only_pristine_legacy_is_legacy_valid_and_performs_no_write(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    raw_legacy = b'{ "members" : ["caf\xc3\xa9"], "counters" : {"open":4} }\n'
    legacy = {"members": ["caf\u00e9"], "counters": {"open": 4}}
    assert raw_legacy != _canonical_bytes(legacy)
    _write_private_raw(path, raw_legacy)
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
    assert path.read_bytes() == raw_legacy
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
        ops.assert_all_rules_fired()
        assert ops.counters["replace"] > 0
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
    protected = {_file_identity(outside)}
    os.symlink(outside, victim)
    outside_before = outside.read_bytes()
    ops = FaultOps()

    try:
        with _open(cs, path, ops=ops) as session:
            _assert_recovery_required(session.load(), "unsafe_file")
    except cs.ControllerStateRequired as error:
        assert error.diagnostic.reason == "unsafe_file"

    assert outside.read_bytes() == outside_before
    _assert_no_forbidden_effects(ops, protected_identities=protected)


def test_symlinked_ancestor_is_rejected_without_following_target(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    real = tmp_path / "real"
    real.mkdir()
    path = real / "state.json"
    _seed_store(cs, path)
    protected = _authority_identities(path)
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
    _assert_no_forbidden_effects(ops, protected_identities=protected)


def test_non_regular_managed_leaf_is_rejected_without_repair(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    path.unlink()
    os.mkfifo(path, 0o600)
    protected = {_file_identity(path, follow_symlinks=False)}
    ops = FaultOps()

    with _open(cs, path, ops=ops) as session:
        _assert_recovery_required(session.load(), "unsafe_file")

    assert stat.S_ISFIFO(path.lstat().st_mode)
    _assert_no_forbidden_effects(ops, protected_identities=protected)


def test_owner_mismatch_reported_by_verified_descriptor_is_rejected(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    protected = {_file_identity(path)}
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
    _assert_no_forbidden_effects(ops, protected_identities=protected)


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
    protected = _authority_identities(path)
    private.chmod(directory_mode)
    before = _authority_snapshot(path)
    ops = FaultOps()
    try:
        with _open(cs, path, ops=ops) as session:
            _assert_recovery_required(session.load(), "unsafe_file")
    finally:
        private.chmod(0o700)
    assert _authority_snapshot(path) == before
    _assert_no_forbidden_effects(ops, protected_identities=protected)


@pytest.mark.parametrize("file_mode", (0o640, 0o604, 0o666))
def test_non_private_managed_file_is_rejected_without_chmod(
    tmp_path: Path,
    file_mode: int,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    path.chmod(file_mode)
    protected = {_file_identity(path)}
    before = path.read_bytes()
    ops = FaultOps()

    with _open(cs, path, ops=ops) as session:
        _assert_recovery_required(session.load(), "unsafe_file")

    assert stat.S_IMODE(path.stat().st_mode) == file_mode
    assert path.read_bytes() == before
    _assert_no_forbidden_effects(ops, protected_identities=protected)


def test_identity_replacement_between_inspection_and_use_fails_closed(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    replacement = tmp_path / "replacement"
    replacement.write_bytes(path.read_bytes())
    replacement.chmod(0o600)
    protected = {_file_identity(path), _file_identity(replacement)}
    before = _authority_snapshot(path)
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
    assert path.read_bytes() == before[""]
    _assert_no_forbidden_effects(ops, protected_identities=protected)


def test_capability_has_no_public_zero_argument_constructor(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    assert inspect.isclass(cs.StateWriteCapability)
    with pytest.raises(TypeError):
        cs.StateWriteCapability()
    path = tmp_path / "state.json"
    with _open(cs, path) as session:
        capability = session.load().capability
        assert capability is not None
        assert type(capability) is cs.StateWriteCapability


def test_save_requires_a_capability(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    ops = FaultOps()
    with _open(cs, path, ops=ops) as session:
        session.load()
        _assert_capability_rejected_without_mutation(
            cs,
            path,
            ops,
            lambda: session.save({"counters": {}}, None),
        )


def test_committed_save_consumes_old_and_returns_distinct_fresh_capability(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    ops = FaultOps()
    with _open(cs, path, ops=ops) as session:
        loaded = session.load()
        old = loaded.capability
        first = session.save({"counters": {"seen": 1}}, old)
        assert first.capability is not old
        _assert_capability_rejected_without_mutation(
            cs,
            path,
            ops,
            lambda: session.save({"counters": {"seen": 2}}, old),
        )
        second = session.save({"counters": {"seen": 2}}, first.capability)
        assert second.generation == first.generation + 1
        assert second.capability is not first.capability


def test_reused_capability_is_rejected(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    ops = FaultOps()
    with _open(cs, path, ops=ops) as session:
        capability = session.load().capability
        session.save({"counters": {"seen": 1}}, capability)
        _assert_capability_rejected_without_mutation(
            cs,
            path,
            ops,
            lambda: session.save({"counters": {"seen": 2}}, capability),
        )


def test_reload_invalidates_previously_issued_capability(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    ops = FaultOps()
    with _open(cs, path, ops=ops) as session:
        first = session.load()
        reloaded = session.reload()
        assert reloaded.mode == "valid"
        assert reloaded.capability is not first.capability
        _assert_capability_rejected_without_mutation(
            cs,
            path,
            ops,
            lambda: session.save({"counters": {"seen": 2}}, first.capability),
        )


def test_released_capability_is_rejected(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    ops = FaultOps()
    session = _open(cs, path, ops=ops)
    capability = session.load().capability
    session.close()
    before = _authority_snapshot(path)
    ops.reset_trace()
    _assert_capability_rejected(
        cs,
        lambda: session.save({"counters": {}}, capability),
    )
    assert _authority_snapshot(path) == before
    assert ops.counters["write"] == 0
    assert ops.counters["replace"] == 0
    assert ops.counters["unlink"] == 0


def test_capability_component_binding_is_independent(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    ops = FaultOps()
    session, result = _load_valid(cs, path, ops=ops)
    original_store = _json(path)["_controllerState"]["storeId"]
    original_generation = _json(path)["_controllerState"]["generation"]
    _rewrite_coherent_binding(path, component="heartbeat-watchdog")
    assert _json(path)["_controllerState"]["storeId"] == original_store
    assert _json(path)["_controllerState"]["generation"] == original_generation

    _assert_capability_rejected_without_mutation(
        cs,
        path,
        ops,
        lambda: session.save({"counters": {"seen": 2}}, result.capability),
    )
    session.close()


def test_store_binding_rejects_capability_after_coherent_store_substitution(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    ops = FaultOps()
    session, result = _load_valid(cs, path, ops=ops)
    replacement_store = "f" * 32
    component = _json(path)["_controllerState"]["component"]
    generation = _json(path)["_controllerState"]["generation"]
    _rewrite_coherent_binding(path, store_id=replacement_store)
    assert _json(path)["_controllerState"]["component"] == component
    assert _json(path)["_controllerState"]["generation"] == generation

    _assert_capability_rejected_without_mutation(
        cs,
        path,
        ops,
        lambda: session.save({"counters": {"seen": 2}}, result.capability),
    )
    session.close()


def test_capability_path_identity_binding_is_independent(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    ops = FaultOps()
    session, result = _load_valid(cs, path, ops=ops)
    original = _json(path)
    replacement = tmp_path / "byte-identical-primary"
    _write_private_raw(replacement, path.read_bytes())
    os.replace(replacement, path)
    assert _json(path) == original

    _assert_capability_rejected_without_mutation(
        cs,
        path,
        ops,
        lambda: session.save({"counters": {"seen": 2}}, result.capability),
    )
    session.close()


def test_capability_bound_to_observed_generation_rejects_external_advance(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    ops = FaultOps()
    session, result = _load_valid(cs, path, ops=ops)
    component = _json(path)["_controllerState"]["component"]
    store_id = _json(path)["_controllerState"]["storeId"]
    _set_valid_generation(path, result.diagnostic.current_generation + 1)
    assert _json(path)["_controllerState"]["component"] == component
    assert _json(path)["_controllerState"]["storeId"] == store_id

    _assert_capability_rejected_without_mutation(
        cs,
        path,
        ops,
        lambda: session.save({"counters": {"seen": 2}}, result.capability),
    )
    session.close()


def test_capability_session_binding_rejects_prior_session_object(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    first = _open(cs, path)
    prior_capability = first.load().capability
    first.close()
    ops = FaultOps()
    second, current = _load_valid(cs, path, ops=ops)
    assert current.capability is not prior_capability

    _assert_capability_rejected_without_mutation(
        cs,
        path,
        ops,
        lambda: second.save({"counters": {"seen": 2}}, prior_capability),
    )
    second.close()


def test_capability_object_identity_rejects_same_valued_forgery(
    tmp_path: Path,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    ops = FaultOps()
    session, result = _load_valid(cs, path, ops=ops)
    forged = _clone_opaque_capability(result.capability)

    _assert_capability_rejected_without_mutation(
        cs,
        path,
        ops,
        lambda: session.save({"counters": {"seen": 2}}, forged),
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
    ops = FaultOps()
    with _open(cs, path, ops=ops) as session:
        recovered = session.load()
        assert recovered.mode == "recovered"
        _assert_capability_rejected_without_mutation(
            cs,
            path,
            ops,
            lambda: session.save(recovered.payload, recovered.capability),
        )
        reconciled = session.complete_reconciliation(
            recovered.payload,
            recovered.capability,
            outcome="validated_previous_only",
        )
        assert reconciled.mode == "reconciled"


def test_reconciliation_validation_rejection_preserves_recovery_capability(
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
    _damage_primary(path, "truncated")
    ops = FaultOps()

    def namespace_snapshot() -> tuple[tuple[Any, ...], ...]:
        snapshot = []
        for candidate in sorted(tmp_path.iterdir()):
            observed = candidate.lstat()
            data = candidate.read_bytes() if stat.S_ISREG(observed.st_mode) else None
            snapshot.append(
                (
                    candidate.name,
                    observed.st_dev,
                    observed.st_ino,
                    observed.st_mode,
                    observed.st_uid,
                    observed.st_gid,
                    observed.st_size,
                    data,
                )
            )
        return tuple(snapshot)

    with _open(
        cs,
        path,
        validator=validate_versioned_payload,
        ops=ops,
    ) as session:
        recovered = session.load()
        assert recovered.mode == "recovered"
        assert recovered.payload == {"version": 1, "counters": {"seen": 1}}
        capability = recovered.capability
        assert capability is not None
        authority_before = _authority_snapshot(path)
        namespace_before = namespace_snapshot()
        evidence_before = _evidence_snapshot(path)
        ops.reset_trace()

        with pytest.raises((ValueError, cs.ControllerStateRequired)):
            session.complete_reconciliation(
                {"version": 2, "counters": {"invalid": 1}},
                capability,
                outcome="validated_previous_only",
            )

        assert _authority_snapshot(path) == authority_before
        assert namespace_snapshot() == namespace_before
        assert _evidence_snapshot(path) == evidence_before
        for boundary in (
            "write",
            "fsync_file",
            "fsync_directory",
            "replace",
            "unlink",
            "chmod",
        ):
            assert ops.counters[boundary] == 0

        reconciled = session.complete_reconciliation(
            recovered.payload,
            capability,
            outcome="validated_previous_only",
        )
        assert reconciled.mode == reconciled.diagnostic.mode == "reconciled"


def test_normal_capability_cannot_authorize_reconciliation(tmp_path: Path) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_store(cs, path)
    ops = FaultOps()
    with _open(cs, path, ops=ops) as session:
        valid = session.load()
        _assert_capability_rejected_without_mutation(
            cs,
            path,
            ops,
            lambda: session.complete_reconciliation(
                valid.payload,
                valid.capability,
                outcome="validated_previous_only",
            ),
        )
        committed = session.save(
            {"counters": {"seen": 2}},
            valid.capability,
        )
        assert committed.mode == "valid"


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
        receipt_before = _json(_managed(path, ".recovery"))
        recovery_marker = _json(_managed(path, ".initialized"))
        _assert_recovery_receipt_contract(
            receipt_before,
            marker=recovery_marker,
            recovered_envelope=_json(_managed(path, ".previous")),
        )
        assert receipt_before["phase"] == "restored"
        assert receipt_before["targetGeneration"] is None
        assert receipt_before["targetIntegritySha256"] is None
        reconciled = session.complete_reconciliation(
            recovered.payload,
            recovered.capability,
            outcome="validated_previous_only",
        )
        assert reconciled.mode == reconciled.diagnostic.mode == "reconciled"
        assert reconciled.diagnostic.recovery_receipt_id == receipt_id
        receipt_after_reconciliation = _json(_managed(path, ".recovery"))
        _assert_recovery_receipt_contract(
            receipt_after_reconciliation,
            marker=recovery_marker,
            recovered_envelope=_json(_managed(path, ".previous")),
            target_envelope=_json(path),
        )
        changed = {
            key
            for key in receipt_before
            if receipt_before[key] != receipt_after_reconciliation[key]
        }
        assert changed == {
            "phase",
            "targetGeneration",
            "targetIntegritySha256",
            "integritySha256",
        }
        for retained in set(receipt_before) - changed:
            assert receipt_after_reconciliation[retained] == receipt_before[retained]
        assert receipt_after_reconciliation["phase"] == "reconciled"
        assert receipt_after_reconciliation["targetGeneration"] == reconciled.generation
        assert re.fullmatch(
            r"[0-9a-f]{64}",
            receipt_after_reconciliation["targetIntegritySha256"],
        )
        valid = session.reload()
        assert valid.mode == valid.diagnostic.mode == "valid"
        assert valid.payload == recovered.payload
        assert valid.diagnostic.recovery_receipt_id == receipt_id
        assert valid.capability is not reconciled.capability
        assert _json(_managed(path, ".recovery")) == receipt_after_reconciliation

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
        started = time.monotonic()
        with pytest.raises(cs.ControllerStateRequired) as raised:
            _open(cs, path, lock_timeout=0.001)
        elapsed = time.monotonic() - started
        assert raised.value.diagnostic.reason == "lock_unavailable"
        assert raised.value.diagnostic.mode == "recovery_required"
        assert elapsed < 0.5, (
            f"lock acquisition exceeded bounded timeout falsifier: {elapsed:.3f}s"
        )
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
    ops = FaultOps()

    with _open(cs, path, ops=ops) as session:
        result = session.load()
        assert result.mode == "recovered"
        assert result.payload == {"counters": {"seen": 1}, "members": ["retained"]}
        assert result.capability is not None
        assert result.diagnostic.recovery_receipt_id
        receipt = _json(_managed(path, ".recovery"))
        _assert_recovery_receipt_contract(
            receipt,
            marker=_json(_managed(path, ".initialized")),
            recovered_envelope=_json(_managed(path, ".previous")),
        )
        assert receipt["recoveryReceiptId"] == result.diagnostic.recovery_receipt_id
        evidence = _evidence_files(path)
        assert len(evidence) == 1
        assert next(iter(evidence)).read_bytes() == damaged
        restored = path.read_bytes()
        assert restored == _managed(path, ".previous").read_bytes()
        marker_during = _json(_managed(path, ".initialized"))
        assert marker_during["highWaterGeneration"] == marker_before["highWaterGeneration"]
        evidence_write = min(
            index
            for index, call in enumerate(ops.calls)
            if call.name == "write" and call.role == "evidence"
        )
        evidence_file_fsync = min(
            index
            for index, call in enumerate(ops.calls)
            if call.name == "fsync_file" and call.role == "evidence"
        )
        evidence_directory_fsync = min(
            index
            for index, call in enumerate(ops.calls)
            if call.name == "fsync_directory" and call.role == "evidence"
        )
        primary_replace = min(
            index
            for index, call in enumerate(ops.calls)
            if call.name == "replace" and call.role == "primary"
        )
        assert (
            evidence_write
            < evidence_file_fsync
            < evidence_directory_fsync
            < primary_replace
        )
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
        first_evidence = _evidence_snapshot(path)
    with _open(cs, path) as restarted:
        retry = restarted.load()

    assert retry.mode == "recovered"
    assert retry.diagnostic.recovery_receipt_id == first_receipt
    assert _evidence_snapshot(path) == first_evidence
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
    evidence = _evidence_snapshot(path)

    with _open(cs, path) as second:
        second_result = second.load()
    with _open(cs, path) as third:
        third_result = third.load()

    assert second_result.diagnostic.occurrence_count == _MAX_OCCURRENCE_COUNT
    assert third_result.diagnostic.occurrence_count == _MAX_OCCURRENCE_COUNT
    assert second_result.diagnostic.recovery_receipt_id == first_result.diagnostic.recovery_receipt_id
    assert third_result.diagnostic.recovery_receipt_id == first_result.diagnostic.recovery_receipt_id
    assert _evidence_snapshot(path) == evidence


def test_emergency_fallback_is_at_most_once_per_module_invocation() -> None:
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
    _result, raw = _assert_fd2_line(
        lambda: (
            cs.emit_state_recovery_fallback(diagnostic),
            cs.emit_state_recovery_fallback(diagnostic),
        )
    )

    assert raw.count(b"\n") == 1


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
    ops.expect_next_unmanaged_creation("evidence")

    committed = session.save({"counters": {"seen": 3}}, loaded.capability)
    session.close()

    assert committed.mode == "valid"
    evidence = _evidence_files(path)
    assert any(candidate.read_bytes() == damaged_previous for candidate in evidence)
    evidence_fsync = min(
        index
        for index, call in enumerate(ops.calls)
        if call.name == "fsync_file" and call.role == "evidence"
    )
    evidence_directory_fsync = min(
        index
        for index, call in enumerate(ops.calls)
        if call.name == "fsync_directory" and call.role == "evidence"
    )
    previous_replace = min(
        index
        for index, call in enumerate(ops.calls)
        if call.name == "replace" and call.detail.endswith("state.json.previous")
    )
    assert evidence_fsync < evidence_directory_fsync < previous_replace


@pytest.mark.parametrize(
    "boundary",
    (
        "write",
        "fsync_file",
        "fsync_directory",
    ),
)
def test_invalid_previous_evidence_failure_preserves_both_authorities(
    tmp_path: Path,
    boundary: str,
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
    ops.reset_trace()
    ops.expect_next_unmanaged_creation("evidence")
    ops.inject(boundary, predicate=lambda call: call.role == "evidence")

    with pytest.raises(cs.ControllerStateRequired) as raised:
        session.save({"counters": {"seen": 3}}, loaded.capability)
    session.close()

    ops.assert_all_rules_fired()
    assert ops.counters[boundary] > 0
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
        ops.inject("write", predicate=lambda call: call.role == "evidence")
    elif case == "evidence_file_fsync":
        fault_boundary = "fsync_file"
        ops.inject("fsync_file", predicate=lambda call: call.role == "evidence")
    elif case == "evidence_directory_fsync":
        fault_boundary = "fsync_directory"
        ops.inject("fsync_directory", predicate=lambda call: call.role == "evidence")
    elif case == "directory_full":
        fault_boundary = "write"
        ops.inject(
            "write",
            error=OSError(errno.ENOSPC, "injected full directory"),
            predicate=lambda call: call.role == "evidence",
        )
    elif case == "permission_denied":
        fault_boundary = "write"
        ops.inject(
            "write",
            error=PermissionError(errno.EACCES, "injected permission denial"),
            predicate=lambda call: call.role == "evidence",
        )

    before = _authority_snapshot(path)
    with _open(cs, path, ops=ops) as session:
        result = session.load()
    _assert_recovery_required(result)
    if fault_boundary is not None:
        ops.assert_all_rules_fired()
        assert ops.counters[fault_boundary] > 0
    after = _authority_snapshot(path)
    for suffix in ("", ".previous", ".initialized", ".transaction"):
        assert after[suffix] == before[suffix]
    if fault_boundary is None:
        assert after[".recovery"] == before[".recovery"]
    else:
        assert after[".recovery"] is not None
        receipt = _json(_managed(path, ".recovery"))
        _assert_recovery_receipt_contract(
            receipt,
            marker=_json(_managed(path, ".initialized")),
            recovered_envelope=_json(_managed(path, ".previous")),
        )
        assert receipt["phase"] in {"planned", "evidence_preserved"}


@dataclass(frozen=True)
class CrashCase:
    phase: str
    boundary: str
    role: str
    journal_phase: str | None
    primary_generation: int
    previous_generation: int
    marker_generation: int


_TRANSACTION_CRASH_CASES = (
    CrashCase(
        "journal_prepared",
        "fsync_directory",
        "transaction",
        "prepared",
        2,
        1,
        2,
    ),
    CrashCase(
        "previous_temp_fsynced",
        "fsync_file",
        "previous_temp",
        "prepared",
        2,
        1,
        2,
    ),
    CrashCase("previous_renamed", "replace", "previous", "prepared", 2, 2, 2),
    CrashCase(
        "previous_directory_synced",
        "fsync_directory",
        "previous",
        "prepared",
        2,
        2,
        2,
    ),
    CrashCase(
        "journal_advanced_previous_committed",
        "fsync_directory",
        "transaction",
        "previous_committed",
        2,
        2,
        2,
    ),
    CrashCase(
        "primary_temp_fsynced",
        "fsync_file",
        "primary_temp",
        "previous_committed",
        2,
        2,
        2,
    ),
    CrashCase(
        "primary_renamed",
        "replace",
        "primary",
        "previous_committed",
        3,
        2,
        2,
    ),
    CrashCase(
        "primary_directory_synced",
        "fsync_directory",
        "primary",
        "previous_committed",
        3,
        2,
        2,
    ),
    CrashCase(
        "journal_advanced_primary_committed",
        "fsync_directory",
        "transaction",
        "primary_committed",
        3,
        2,
        2,
    ),
    CrashCase(
        "marker_renamed",
        "replace",
        "initialized",
        "primary_committed",
        3,
        2,
        3,
    ),
    CrashCase(
        "marker_directory_synced",
        "fsync_directory",
        "initialized",
        "primary_committed",
        3,
        2,
        3,
    ),
    CrashCase(
        "journal_advanced_marker_committed",
        "fsync_directory",
        "transaction",
        "marker_committed",
        3,
        2,
        3,
    ),
    CrashCase(
        "journal_removed",
        "unlink",
        "transaction",
        None,
        3,
        2,
        3,
    ),
    CrashCase(
        "journal_removal_directory_synced",
        "fsync_directory",
        "transaction",
        None,
        3,
        2,
        3,
    ),
)


def _envelope_generation(path: Path) -> int:
    generation = _json(path)["_controllerState"]["generation"]
    assert isinstance(generation, int) and not isinstance(generation, bool)
    return generation


def _assert_sidecar_integrity(document: dict[str, Any]) -> None:
    unsigned = {key: value for key, value in document.items() if key != "integritySha256"}
    assert document["integritySha256"] == _integrity(unsigned)


def _assert_recovery_receipt_contract(
    receipt: dict[str, Any],
    *,
    marker: dict[str, Any],
    recovered_envelope: dict[str, Any],
    target_envelope: dict[str, Any] | None = None,
) -> None:
    assert set(receipt) == _RECOVERY_RECEIPT_BASE_KEYS
    assert receipt["format"] == _FORMAT
    assert receipt["formatVersion"] == _FORMAT_VERSION
    assert receipt["component"] in {
        "collector",
        "heartbeat-watchdog",
        "dispatcher-incident",
    }
    assert isinstance(receipt["storeId"], str)
    assert _HEX32.fullmatch(receipt["storeId"])
    assert isinstance(receipt["recoveryReceiptId"], str)
    assert _HEX32.fullmatch(receipt["recoveryReceiptId"])
    assert receipt["phase"] in {
        "planned",
        "evidence_preserved",
        "restored",
        "reconciliation_prepared",
        "reconciled",
    }
    assert receipt["reason"] in {
        "read_failed",
        "unsafe_file",
        "decode_failed",
        "invalid_root",
        "schema_incompatible",
        "integrity_mismatch",
        "generation_invalid",
        "publication_ambiguous",
        "evidence_preservation_failed",
        "lock_unavailable",
    }
    assert isinstance(receipt["occurrenceCount"], int)
    assert not isinstance(receipt["occurrenceCount"], bool)
    assert 1 <= receipt["occurrenceCount"] <= _MAX_OCCURRENCE_COUNT
    for key in (
        "markerHighWaterGeneration",
        "recoveredGeneration",
        "targetGeneration",
    ):
        _assert_generation(receipt[key], nullable=key == "targetGeneration")
    for key in (
        "markerHighWaterIntegritySha256",
        "recoveredIntegritySha256",
        "targetIntegritySha256",
    ):
        _assert_digest(receipt[key], nullable=key == "targetIntegritySha256")
    _assert_digest(receipt["integritySha256"])
    _assert_marker_contract(marker)
    recovered_metadata = _assert_envelope_contract(recovered_envelope)
    assert receipt["component"] == marker["component"] == recovered_metadata["component"]
    assert receipt["storeId"] == marker["storeId"] == recovered_metadata["storeId"]
    assert receipt["markerHighWaterGeneration"] == marker["highWaterGeneration"]
    assert (
        receipt["markerHighWaterIntegritySha256"]
        == marker["highWaterIntegritySha256"]
    )
    assert receipt["recoveredGeneration"] == recovered_metadata["generation"]
    assert (
        receipt["recoveredIntegritySha256"]
        == recovered_metadata["integritySha256"]
    )
    if target_envelope is None:
        assert receipt["targetGeneration"] is None
        assert receipt["targetIntegritySha256"] is None
    else:
        target_metadata = _assert_envelope_contract(target_envelope)
        assert target_metadata["component"] == receipt["component"]
        assert target_metadata["storeId"] == receipt["storeId"]
        assert receipt["targetGeneration"] == target_metadata["generation"]
        assert receipt["targetIntegritySha256"] == target_metadata["integritySha256"]
    _assert_sidecar_integrity(receipt)


def _transaction_payload(generation: int) -> dict[str, Any]:
    assert generation in {1, 2, 3}
    return {"counters": {"seen": generation}}


def _assert_generated_journal_contract(journal: dict[str, Any]) -> None:
    assert set(journal) == _JOURNAL_KEYS
    assert journal["format"] == _FORMAT
    assert journal["formatVersion"] == _FORMAT_VERSION
    assert journal["component"] in {
        "collector",
        "heartbeat-watchdog",
        "dispatcher-incident",
    }
    assert isinstance(journal["storeId"], str)
    assert _HEX32.fullmatch(journal["storeId"])
    assert isinstance(journal["transactionId"], str)
    assert _HEX32.fullmatch(journal["transactionId"])
    assert journal["operation"] in {
        "bootstrap",
        "migration",
        "normal",
        "reconciliation",
    }
    assert journal["phase"] in {
        "prepared",
        "previous_committed",
        "primary_committed",
        "marker_committed",
    }
    for key in (
        "expectedGeneration",
        "targetGeneration",
        "expectedHighWaterGeneration",
        "targetHighWaterGeneration",
    ):
        _assert_generation(journal[key], nullable=True)
    for key in (
        "expectedIntegritySha256",
        "targetIntegritySha256",
        "expectedHighWaterIntegritySha256",
        "targetHighWaterIntegritySha256",
        "legacySourceSha256",
    ):
        _assert_digest(journal[key], nullable=True)
    previous_metadata = _assert_envelope_contract(journal["previousEnvelope"])
    target_metadata = _assert_envelope_contract(journal["targetEnvelope"])
    assert previous_metadata["component"] == journal["component"]
    assert target_metadata["component"] == journal["component"]
    assert previous_metadata["storeId"] == journal["storeId"]
    assert target_metadata["storeId"] == journal["storeId"]
    if journal["expectedGeneration"] is not None:
        assert previous_metadata["generation"] == journal["expectedGeneration"]
        assert (
            previous_metadata["integritySha256"]
            == journal["expectedIntegritySha256"]
        )
    assert target_metadata["generation"] == journal["targetGeneration"]
    assert target_metadata["integritySha256"] == journal["targetIntegritySha256"]
    assert (
        previous_metadata["generation"]
        == journal["expectedHighWaterGeneration"]
    )
    assert (
        previous_metadata["integritySha256"]
        == journal["expectedHighWaterIntegritySha256"]
    )
    assert target_metadata["generation"] == journal["targetHighWaterGeneration"]
    assert (
        target_metadata["integritySha256"]
        == journal["targetHighWaterIntegritySha256"]
    )
    _assert_digest(journal["integritySha256"])
    _assert_sidecar_integrity(journal)


def _assert_normal_journal_contract(
    journal: dict[str, Any],
    *,
    phase: str,
) -> None:
    _assert_generated_journal_contract(journal)
    assert journal["component"] == _COMPONENT
    assert journal["operation"] == "normal"
    assert journal["phase"] == phase
    assert journal["legacySourceSha256"] is None
    for key in (
        "expectedGeneration",
        "targetGeneration",
        "expectedHighWaterGeneration",
        "targetHighWaterGeneration",
    ):
        _assert_generation(journal[key])
    for key in (
        "expectedIntegritySha256",
        "targetIntegritySha256",
        "expectedHighWaterIntegritySha256",
        "targetHighWaterIntegritySha256",
        "integritySha256",
    ):
        _assert_digest(journal[key])
    assert journal["expectedGeneration"] == 2
    assert journal["targetGeneration"] == 3
    assert journal["expectedHighWaterGeneration"] == 2
    assert journal["targetHighWaterGeneration"] == 3
    previous_metadata = _assert_envelope_contract(
        journal["previousEnvelope"],
        payload=_transaction_payload(2),
    )
    target_metadata = _assert_envelope_contract(
        journal["targetEnvelope"],
        payload=_transaction_payload(3),
    )
    assert previous_metadata["component"] == journal["component"]
    assert target_metadata["component"] == journal["component"]
    assert previous_metadata["storeId"] == journal["storeId"]
    assert target_metadata["storeId"] == journal["storeId"]
    assert previous_metadata["generation"] == journal["expectedGeneration"]
    assert target_metadata["generation"] == journal["targetGeneration"]
    assert previous_metadata["integritySha256"] == journal["expectedIntegritySha256"]
    assert target_metadata["integritySha256"] == journal["targetIntegritySha256"]
    assert (
        journal["expectedHighWaterIntegritySha256"]
        == previous_metadata["integritySha256"]
    )
    assert (
        journal["targetHighWaterIntegritySha256"]
        == target_metadata["integritySha256"]
    )


def _assert_transaction_crash_posture(path: Path, crash: CrashCase) -> None:
    primary = _json(path)
    previous = _json(_managed(path, ".previous"))
    primary_metadata = _assert_envelope_contract(
        primary,
        payload=_transaction_payload(crash.primary_generation),
    )
    previous_metadata = _assert_envelope_contract(
        previous,
        payload=_transaction_payload(crash.previous_generation),
    )
    assert primary_metadata["generation"] == crash.primary_generation
    assert previous_metadata["generation"] == crash.previous_generation
    assert primary_metadata["component"] == previous_metadata["component"] == _COMPONENT
    assert primary_metadata["storeId"] == previous_metadata["storeId"]
    marker = _json(_managed(path, ".initialized"))
    marker_authority = (
        primary
        if crash.marker_generation == crash.primary_generation
        else previous
    )
    _assert_marker_contract(marker, authority=marker_authority)
    assert marker["highWaterGeneration"] == crash.marker_generation
    journal_path = _managed(path, ".transaction")
    if crash.journal_phase is None:
        assert not journal_path.exists()
        return
    journal = _json(journal_path)
    _assert_normal_journal_contract(journal, phase=crash.journal_phase)
    assert journal["storeId"] == primary_metadata["storeId"]
    if crash.primary_generation == 2:
        assert primary == journal["previousEnvelope"]
    else:
        assert primary == journal["targetEnvelope"]
    if crash.previous_generation == 2:
        assert previous == journal["previousEnvelope"]
    expected_marker_digest = (
        journal["expectedHighWaterIntegritySha256"]
        if crash.marker_generation == 2
        else journal["targetHighWaterIntegritySha256"]
    )
    assert marker["highWaterIntegritySha256"] == expected_marker_digest


def _assert_completed_normal_transaction(
    path: Path,
    *,
    expected_previous: dict[str, Any],
    expected_target: dict[str, Any],
) -> None:
    primary = _json(path)
    previous = _json(_managed(path, ".previous"))
    assert primary == expected_target
    assert previous == expected_previous
    primary_metadata = _assert_envelope_contract(
        primary,
        payload=_transaction_payload(3),
    )
    previous_metadata = _assert_envelope_contract(
        previous,
        payload=_transaction_payload(2),
    )
    assert primary_metadata["generation"] == 3
    assert previous_metadata["generation"] == 2
    assert primary_metadata["component"] == previous_metadata["component"] == _COMPONENT
    assert primary_metadata["storeId"] == previous_metadata["storeId"]
    _assert_marker_contract(
        _json(_managed(path, ".initialized")),
        authority=primary,
    )
    assert not _managed(path, ".transaction").exists()


@dataclass(frozen=True)
class InterruptedNormalSave:
    ops: FaultOps
    expected_previous: dict[str, Any]
    expected_target: dict[str, Any]


def _transaction_crash_predicate(
    path: Path,
    crash: CrashCase,
) -> Callable[[BoundaryCall], bool]:
    def matches(call: BoundaryCall) -> bool:
        if call.role != crash.role:
            return False
        journal_path = _managed(path, ".transaction")
        if crash.journal_phase is None:
            return not journal_path.exists()
        return (
            journal_path.exists()
            and _json(journal_path).get("phase") == crash.journal_phase
        )

    return matches


def _interrupt_normal_save(
    cs: ModuleType,
    path: Path,
    crash: CrashCase,
) -> InterruptedNormalSave:
    ops = FaultOps()
    session, loaded = _load_valid(cs, path, ops=ops)
    ops.reset_trace()
    # matching_occurrence=1 is among calls matching both the structural role and
    # the durable journal phase, not among unrelated calls to the same syscall.
    ops.crash_after(
        crash.boundary,
        predicate=_transaction_crash_predicate(path, crash),
    )
    try:
        with pytest.raises(SimulatedCrash):
            session.save({"counters": {"seen": 3}}, loaded.capability)
    finally:
        session.close()
    ops.assert_all_rules_fired()
    assert ops.counters[crash.boundary] > 0
    _assert_transaction_crash_posture(path, crash)
    journal_path = _managed(path, ".transaction")
    if journal_path.exists():
        journal = _json(journal_path)
        expected_previous = journal["previousEnvelope"]
        expected_target = journal["targetEnvelope"]
    else:
        expected_previous = _json(_managed(path, ".previous"))
        expected_target = _json(path)
    return InterruptedNormalSave(ops, expected_previous, expected_target)


@pytest.mark.parametrize("crash", _TRANSACTION_CRASH_CASES, ids=lambda case: case.phase)
def test_transaction_crash_matrix_resumes_every_exact_durable_posture(
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

    interrupted = _interrupt_normal_save(cs, path, crash)

    assert interrupted.ops.counters[crash.boundary] > 0
    with _open(cs, path) as restarted:
        result = restarted.load()
    assert result.mode == result.diagnostic.mode == "valid"
    assert result.payload == {"counters": {"seen": 3}}
    assert result.diagnostic.current_generation == 3
    _assert_completed_normal_transaction(
        path,
        expected_previous=interrupted.expected_previous,
        expected_target=interrupted.expected_target,
    )


@pytest.mark.parametrize(
    ("phase", "crash_phase"),
    (
        ("prepared", "journal_prepared"),
        ("previous_committed", "journal_advanced_previous_committed"),
        ("primary_committed", "journal_advanced_primary_committed"),
        ("marker_committed", "journal_advanced_marker_committed"),
    ),
)
def test_restart_resumes_each_exact_matching_transaction_phase(
    tmp_path: Path,
    phase: str,
    crash_phase: str,
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
    crash = next(case for case in _TRANSACTION_CRASH_CASES if case.phase == crash_phase)
    interrupted = _interrupt_normal_save(cs, path, crash)
    assert _json(_managed(path, ".transaction"))["phase"] == phase

    with _open(cs, path) as restarted:
        resumed = restarted.load()

    assert resumed.mode == resumed.diagnostic.mode == "valid"
    assert resumed.payload == {"counters": {"seen": 3}}
    assert resumed.diagnostic.current_generation == 3
    _assert_completed_normal_transaction(
        path,
        expected_previous=interrupted.expected_previous,
        expected_target=interrupted.expected_target,
    )


@pytest.mark.parametrize(
    ("phase", "crash_phase"),
    (
        ("prepared", "journal_prepared"),
        ("previous_committed", "journal_advanced_previous_committed"),
        ("primary_committed", "journal_advanced_primary_committed"),
        ("marker_committed", "journal_advanced_marker_committed"),
    ),
)
def test_transaction_phase_specific_mismatch_fails_closed(
    tmp_path: Path,
    phase: str,
    crash_phase: str,
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
    crash = next(case for case in _TRANSACTION_CRASH_CASES if case.phase == crash_phase)
    _interrupt_normal_save(cs, path, crash)
    journal = _json(_managed(path, ".transaction"))
    component = journal["component"]
    store_id = journal["storeId"]
    if phase == "prepared":
        primary = _json(path)
        primary["counters"] = {"coherent_but_not_journal_expected": 1}
        _refresh_envelope_integrity(primary)
        _write_private_json(path, primary)
        marker = _json(_managed(path, ".initialized"))
        marker["highWaterIntegritySha256"] = primary["_controllerState"][
            "integritySha256"
        ]
        _refresh_sidecar_integrity(marker)
        _write_private_json(_managed(path, ".initialized"), marker)
    elif phase == "previous_committed":
        previous = _json(_managed(path, ".previous"))
        previous["counters"] = {"not_the_embedded_previous": 1}
        _refresh_envelope_integrity(previous)
        _write_private_json(_managed(path, ".previous"), previous)
    elif phase == "primary_committed":
        primary = _json(path)
        primary["counters"] = {"not_the_embedded_target": 1}
        _refresh_envelope_integrity(primary)
        _write_private_json(path, primary)
    else:
        marker = _json(_managed(path, ".initialized"))
        marker["highWaterIntegritySha256"] = "a" * 64
        _refresh_sidecar_integrity(marker)
        _write_private_json(_managed(path, ".initialized"), marker)

    unchanged_journal = _json(_managed(path, ".transaction"))
    assert unchanged_journal["component"] == component
    assert unchanged_journal["storeId"] == store_id
    _assert_sidecar_integrity(unchanged_journal)
    with _open(cs, path) as restarted:
        result = restarted.load()
    _assert_recovery_required(result, "publication_ambiguous")


def _recovery_phase_crash_predicate(
    path: Path,
    phase: str,
) -> Callable[[BoundaryCall], bool]:
    def matches(call: BoundaryCall) -> bool:
        receipt_path = _managed(path, ".recovery")
        return (
            call.role == "recovery"
            and receipt_path.exists()
            and _json(receipt_path).get("phase") == phase
        )

    return matches


def _seed_exact_recovery_phase(
    cs: ModuleType,
    path: Path,
    phase: str,
) -> tuple[FaultOps, bytes]:
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}},
            {"counters": {"seen": 2}},
        ),
    )
    damaged = _damage_primary(path, "truncated")
    if phase == "reconciliation_prepared":
        with _open(cs, path) as initial:
            assert initial.load().mode == "recovered"
        ops = FaultOps()
        session = _open(cs, path, ops=ops)
        recovered = session.load()
        assert recovered.mode == "recovered"
        ops.reset_trace()
        ops.crash_after(
            "fsync_directory",
            predicate=_recovery_phase_crash_predicate(path, phase),
        )
        try:
            with pytest.raises(SimulatedCrash):
                session.complete_reconciliation(
                    recovered.payload,
                    recovered.capability,
                    outcome="validated_previous_only",
                )
        finally:
            session.close()
    else:
        ops = FaultOps()
        ops.crash_after(
            "fsync_directory",
            predicate=_recovery_phase_crash_predicate(path, phase),
        )
        session = _open(cs, path, ops=ops)
        try:
            with pytest.raises(SimulatedCrash):
                session.load()
        finally:
            session.close()
    ops.assert_all_rules_fired()
    assert ops.counters["fsync_directory"] > 0

    receipt = _json(_managed(path, ".recovery"))
    marker = _json(_managed(path, ".initialized"))
    journal_path = _managed(path, ".transaction")
    target_envelope = None
    if phase == "reconciliation_prepared":
        journal = _json(journal_path)
        target_envelope = journal["targetEnvelope"]
    _assert_recovery_receipt_contract(
        receipt,
        marker=marker,
        recovered_envelope=_json(_managed(path, ".previous")),
        target_envelope=target_envelope,
    )
    assert receipt["phase"] == phase
    if phase != "reconciliation_prepared":
        assert not journal_path.exists()
    if phase == "planned":
        assert path.read_bytes() == damaged
        assert _evidence_snapshot(path) == ()
        assert receipt["targetGeneration"] is None
        assert receipt["targetIntegritySha256"] is None
    elif phase == "evidence_preserved":
        assert path.read_bytes() == damaged
        evidence = _evidence_snapshot(path)
        assert len(evidence) == 1 and evidence[0].data == damaged
        assert receipt["targetGeneration"] is None
        assert receipt["targetIntegritySha256"] is None
    else:
        assert path.read_bytes() == _managed(path, ".previous").read_bytes()
        evidence = _evidence_snapshot(path)
        assert len(evidence) == 1 and evidence[0].data == damaged
        if phase == "reconciliation_prepared":
            assert isinstance(receipt["targetGeneration"], int)
            assert re.fullmatch(r"[0-9a-f]{64}", receipt["targetIntegritySha256"])
        else:
            assert receipt["targetGeneration"] is None
            assert receipt["targetIntegritySha256"] is None
    return ops, damaged


@pytest.mark.parametrize(
    "phase",
    (
        "planned",
        "evidence_preserved",
        "restored",
        "reconciliation_prepared",
    ),
)
def test_restart_resumes_each_exact_boundary_created_recovery_phase(
    tmp_path: Path,
    phase: str,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_exact_recovery_phase(cs, path, phase)

    with _open(cs, path) as restarted:
        result = restarted.load()
        if phase == "reconciliation_prepared":
            assert result.mode == "reconciled"
            result = restarted.reload()
            assert result.mode == "valid"
        else:
            assert result.mode == "recovered"
        assert result.payload == {"counters": {"seen": 1}}


@pytest.mark.parametrize(
    ("phase", "expected_reason"),
    (
        ("planned", "publication_ambiguous"),
        ("evidence_preserved", "evidence_preservation_failed"),
        ("restored", "publication_ambiguous"),
        ("reconciliation_prepared", "generation_invalid"),
    ),
)
def test_recovery_phase_specific_posture_mismatch_fails_closed(
    tmp_path: Path,
    phase: str,
    expected_reason: str,
) -> None:
    cs = load_controller_state_module()
    path = tmp_path / "state.json"
    _seed_exact_recovery_phase(cs, path, phase)
    receipt_path = _managed(path, ".recovery")
    receipt_before = _json(receipt_path)
    if phase == "planned":
        _write_private_raw(path, _managed(path, ".previous").read_bytes())
    elif phase == "evidence_preserved":
        evidence = _evidence_snapshot(path)
        assert len(evidence) == 1
        evidence[0].path.unlink()
    elif phase == "restored":
        _write_private_raw(path, b'{"changed-after-restored":true}')
    else:
        receipt = dict(receipt_before)
        receipt["targetGeneration"] = int(receipt["targetGeneration"]) + 1
        _refresh_sidecar_integrity(receipt)
        _write_private_json(receipt_path, receipt)

    receipt_after = _json(receipt_path)
    assert receipt_after["component"] == receipt_before["component"]
    assert receipt_after["storeId"] == receipt_before["storeId"]
    _assert_sidecar_integrity(receipt_after)
    with _open(cs, path) as restarted:
        result = restarted.load()
    _assert_recovery_required(result, expected_reason)


def _assert_closed_diagnostic_projection(
    encoded: bytes,
    forbidden: tuple[str, ...],
) -> None:
    assert len(encoded) <= 4096
    parsed = json.loads(encoded)
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
    rendered = encoded.decode("utf-8")
    for canary in forbidden:
        assert canary not in rendered


def test_actual_recovery_receipt_projects_only_bounded_opaque_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cs = load_controller_state_module()
    monkeypatch.setenv(
        "CONTROLLER_STATE_TEST_CANARY",
        "seeded-environment-canary",
    )
    path = tmp_path / "seeded-path-canary-state.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}, "members": ["payload-value-canary"]},
            {"counters": {"seen": 2}, "members": ["newer-value"]},
        ),
    )
    original = _json(path)
    store_id = original["_controllerState"]["storeId"]
    private_digest = original["_controllerState"]["integritySha256"]
    _write_private_raw(path, b'{"raw-fault-canary":')

    with _open(cs, path) as session:
        result = session.load()
        assert result.mode == "recovered"
    receipt = _json(_managed(path, ".recovery"))
    _assert_recovery_receipt_contract(
        receipt,
        marker=_json(_managed(path, ".initialized")),
        recovered_envelope=_json(_managed(path, ".previous")),
    )
    receipt_id = receipt["recoveryReceiptId"]
    assert receipt_id == result.diagnostic.recovery_receipt_id
    assert _HEX32.fullmatch(receipt_id)
    evidence = _evidence_snapshot(path)
    assert len(evidence) == 1

    details = cs.state_diagnostic_details(result.diagnostic)
    encoded_details = _canonical_bytes(details)
    _return_value, fallback = _assert_fd2_line(
        lambda: cs.emit_state_recovery_fallback(result.diagnostic)
    )
    assert fallback.endswith(b"\n") and fallback.count(b"\n") == 1
    forbidden = (
        path.name,
        os.fspath(path),
        store_id,
        private_digest,
        evidence[0].path.name,
        "raw-fault-canary",
        "payload-value-canary",
        "seeded-environment-canary",
    )
    _assert_closed_diagnostic_projection(encoded_details, forbidden)
    _assert_closed_diagnostic_projection(fallback.rstrip(b"\n"), forbidden)


def test_injected_raw_fault_canaries_do_not_escape_real_failure_diagnostic(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cs = load_controller_state_module()
    monkeypatch.setenv(
        "CONTROLLER_STATE_TEST_CANARY",
        "seeded-environment-canary",
    )
    path = tmp_path / "fault-path-canary.json"
    _seed_store(
        cs,
        path,
        (
            {"counters": {"seen": 1}, "members": ["payload-canary"]},
            {"counters": {"seen": 2}},
        ),
    )
    original = _json(path)
    store_id = original["_controllerState"]["storeId"]
    digest = original["_controllerState"]["integritySha256"]
    _damage_primary(path, "truncated")
    ops = FaultOps()
    ops.inject(
        "write",
        predicate=lambda call: call.role == "evidence",
        error=OSError(
            errno.EIO,
            "raw-exception-canary /fault/path-canary payload-canary "
            "seeded-environment-canary",
        ),
    )
    with _open(cs, path, ops=ops) as session:
        result = session.load()
    _assert_recovery_required(result, "evidence_preservation_failed")
    ops.assert_all_rules_fired()
    _return_value, fallback = _assert_fd2_line(
        lambda: cs.emit_state_recovery_fallback(result.diagnostic)
    )
    forbidden = (
        "raw-exception-canary",
        "fault-path-canary",
        "payload-canary",
        "seeded-environment-canary",
        store_id,
        digest,
    )
    _assert_closed_diagnostic_projection(
        _canonical_bytes(cs.state_diagnostic_details(result.diagnostic)),
        forbidden,
    )
    _assert_closed_diagnostic_projection(fallback.rstrip(b"\n"), forbidden)


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


def test_fallback_is_one_bounded_json_line_with_only_closed_schema() -> None:
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
    return_value, raw = _assert_fd2_line(
        lambda: cs.emit_state_recovery_fallback(diagnostic)
    )

    assert return_value is None
    assert raw.endswith(b"\n")
    assert raw.count(b"\n") == 1
    assert len(raw) <= 4096
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


def test_stderr_failure_cannot_replace_typed_non_success() -> None:
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
    assert _with_closed_fd2(
        lambda: cs.emit_state_recovery_fallback(diagnostic)
    ) is None
    assert error.diagnostic is diagnostic
    assert str(error) == "controller state recovery required"
