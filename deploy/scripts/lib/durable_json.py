"""Descriptor-confined durable JSON publication contracts."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePath, PurePosixPath
import stat
from typing import Any, Callable, Mapping, NoReturn


class DurabilityProof(str, Enum):
    NOT_MUTATED = "not_mutated"
    COMMITTED = "committed"
    UNPROVEN = "unproven"
    RECONCILED_COMMITTED = "reconciled_committed"


class ConfinementProof(str, Enum):
    PROVEN = "proven"
    UNPROVEN = "unproven"
    VIOLATED = "violated"


class CleanupState(str, Enum):
    NOT_REQUIRED = "not_required"
    COMPLETE = "complete"
    DEBT_PRIVATE_TEMP = "debt_private_temp"
    DEBT_RECOVERY_RECORD = "debt_recovery_record"


class AuthorityState(str, Enum):
    EXPECTED_PREDECESSOR = "expected_predecessor"
    INTENDED_AUTHORITATIVE = "intended_authoritative"
    SUPERSEDED = "superseded"
    CONFLICT = "conflict"
    UNKNOWN = "unknown"


class WriteStage(str, Enum):
    SERIALIZATION = "serialization"
    CAPABILITY_CHECK = "capability_check"
    LOCK_ACQUISITION = "lock_acquisition"
    TEMPORARY_CREATION = "temporary_creation"
    WRITE = "write"
    FILE_FLUSH = "file_flush"
    FILE_SYNC = "file_sync"
    PERMISSION_FINALIZATION = "permission_finalization"
    PUBLICATION = "publication"
    PARENT_OPEN = "parent_open"
    PARENT_SYNC = "parent_sync"
    CLEANUP = "cleanup"
    RECONCILIATION = "reconciliation"


class ErrorClass(str, Enum):
    SERIALIZATION = "serialization"
    SIZE = "size"
    PERMISSION = "permission"
    DESCRIPTOR_EXHAUSTION = "descriptor_exhaustion"
    UNSUPPORTED_CAPABILITY = "unsupported_capability"
    IO = "io"
    INTERRUPTION = "interruption"
    CONFLICT = "conflict"
    IDENTITY_TYPE = "identity_type"
    CLEANUP = "cleanup"
    UNKNOWN = "unknown"


class DurableWriteError(RuntimeError):
    """Bounded public failure for a durable publication decision."""


@dataclass(frozen=True)
class PublicationResult:
    component: str
    durability: DurabilityProof
    confinement: ConfinementProof
    cleanup: CleanupState
    authority: AuthorityState
    stage: WriteStage
    error_class: ErrorClass | None
    generation: int | None
    private_operation_id: str
    private_content_sha256: str | None

    @property
    def advance_allowed(self) -> bool:
        return (
            self.durability
            in {
                DurabilityProof.COMMITTED,
                DurabilityProof.RECONCILED_COMMITTED,
            }
            and self.confinement is ConfinementProof.PROVEN
            and self.authority is AuthorityState.INTENDED_AUTHORITATIVE
            and self.cleanup
            in {
                CleanupState.NOT_REQUIRED,
                CleanupState.COMPLETE,
                CleanupState.DEBT_PRIVATE_TEMP,
            }
        )

    def public_projection(self) -> dict[str, str | int | None]:
        return {
            "component": self.component,
            "durability": self.durability.value,
            "confinement": self.confinement.value,
            "cleanup": self.cleanup.value,
            "authority": self.authority.value,
            "stage": self.stage.value,
            "error_class": self.error_class.value if self.error_class else None,
            "generation": self.generation,
        }


@dataclass(frozen=True)
class DurableJsonTarget:
    trusted_root: Path
    relative_path: PurePath
    logical_target: str


@dataclass(frozen=True)
class JsonVersion:
    exists: bool
    raw_sha256: str | None
    generation: int | None
    operation_id: str | None


@dataclass(frozen=True)
class JsonObservation:
    payload: Mapping[str, Any] | None
    version: JsonVersion


def _not_implemented() -> NoReturn:
    raise NotImplementedError("durable JSON publication is not implemented")


def durable_json_target(
    *,
    trusted_root: os.PathLike[str] | str,
    relative_path: os.PathLike[str] | str,
) -> DurableJsonTarget:
    root_text = os.fspath(trusted_root)
    relative_text = os.fspath(relative_path)
    root_parts = root_text.split("/")
    relative_parts = relative_text.split("/")
    if (
        not root_text.startswith("/")
        or any(part in {".", ".."} for part in root_parts)
        or relative_text.startswith("/")
        or "\\" in relative_text
        or any(part in {"", ".", ".."} for part in relative_parts)
    ):
        raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)
    relative = PurePosixPath(*relative_parts)
    return DurableJsonTarget(
        trusted_root=Path(root_text),
        relative_path=relative,
        logical_target=relative.as_posix(),
    )


def _open_directory(name: str, *, dir_fd: int) -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(name, flags, dir_fd=dir_fd)
    except OSError as exc:
        if exc.errno in {errno.EMFILE, errno.ENFILE}:
            error_class = ErrorClass.DESCRIPTOR_EXHAUSTION
        elif exc.errno in {errno.EACCES, errno.EPERM}:
            error_class = ErrorClass.PERMISSION
        else:
            error_class = ErrorClass.IDENTITY_TYPE
        raise DurableWriteError(error_class.value) from exc
    if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)
    return descriptor


def _open_target_parent(target: DurableJsonTarget) -> tuple[int, str]:
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in target.trusted_root.parts[1:]:
            next_descriptor = _open_directory(component, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        root_stat = os.fstat(descriptor)
        if root_stat.st_uid != os.getuid() or stat.S_IMODE(root_stat.st_mode) & 0o077:
            raise DurableWriteError(ErrorClass.PERMISSION.value)
        relative_parts = target.relative_path.parts
        for component in relative_parts[:-1]:
            next_descriptor = _open_directory(component, dir_fd=descriptor)
            component_stat = os.fstat(next_descriptor)
            if (
                component_stat.st_uid != os.getuid()
                or stat.S_IMODE(component_stat.st_mode) & 0o077
            ):
                os.close(next_descriptor)
                raise DurableWriteError(ErrorClass.PERMISSION.value)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor, relative_parts[-1]
    except BaseException:
        os.close(descriptor)
        raise


def observe_json(target: DurableJsonTarget) -> JsonObservation:
    if not isinstance(target, DurableJsonTarget):
        raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)
    parent_fd, leaf = _open_target_parent(target)
    try:
        flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(leaf, flags, dir_fd=parent_fd)
        except FileNotFoundError:
            return JsonObservation(None, JsonVersion(False, None, None, None))
        try:
            file_stat = os.fstat(descriptor)
            if (
                not stat.S_ISREG(file_stat.st_mode)
                or file_stat.st_uid != os.getuid()
                or stat.S_IMODE(file_stat.st_mode) & 0o077
            ):
                raise DurableWriteError(ErrorClass.PERMISSION.value)
            if file_stat.st_size > 8 * 1024 * 1024:
                raise DurableWriteError(ErrorClass.SIZE.value)
            raw = b""
            while len(raw) <= 8 * 1024 * 1024:
                chunk = os.read(descriptor, min(1024 * 1024, 8 * 1024 * 1024 + 1 - len(raw)))
                if not chunk:
                    break
                raw += chunk
            if len(raw) > 8 * 1024 * 1024:
                raise DurableWriteError(ErrorClass.SIZE.value)
            try:
                payload = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise DurableWriteError(ErrorClass.SERIALIZATION.value) from exc
            if not isinstance(payload, dict):
                raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)
            generation = payload.get("generation")
            operation = payload.get("operationId")
            if generation is not None and (not isinstance(generation, int) or isinstance(generation, bool)):
                raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)
            if operation is not None and not isinstance(operation, str):
                raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)
            return JsonObservation(
                payload,
                JsonVersion(
                    True,
                    hashlib.sha256(raw).hexdigest(),
                    generation,
                    operation,
                ),
            )
        finally:
            os.close(descriptor)
    finally:
        os.close(parent_fd)


def _canonical_payload(payload: Mapping[str, Any]) -> bytes:
    try:
        rendered = json.dumps(
            payload,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as exc:
        raise DurableWriteError(ErrorClass.SERIALIZATION.value) from exc
    return rendered.encode("utf-8")


def operation_id(
    target: DurableJsonTarget,
    payload: Mapping[str, Any],
    *,
    component: str,
    predecessor: JsonVersion,
) -> str:
    if (
        not isinstance(target, DurableJsonTarget)
        or not isinstance(predecessor, JsonVersion)
        or not component
        or "\0" in component
    ):
        raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)
    intended_sha256 = hashlib.sha256(_canonical_payload(payload)).hexdigest()
    material = "\0".join(
        [
            "whatsoup.durable-json.v1",
            component,
            target.logical_target,
            predecessor.raw_sha256 or "absent",
            intended_sha256,
        ]
    ).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def _result(
    *,
    component: str,
    operation: str,
    content_sha256: str | None,
    durability: DurabilityProof,
    authority: AuthorityState,
    stage: WriteStage,
    error_class: ErrorClass | None = None,
    cleanup: CleanupState = CleanupState.NOT_REQUIRED,
    confinement: ConfinementProof = ConfinementProof.PROVEN,
    generation: int | None = None,
) -> PublicationResult:
    return PublicationResult(
        component=component,
        durability=durability,
        confinement=confinement,
        cleanup=cleanup,
        authority=authority,
        stage=stage,
        error_class=error_class,
        generation=generation,
        private_operation_id=operation,
        private_content_sha256=content_sha256,
    )


def _lock_parent(parent_fd: int) -> int:
    common_flags = os.O_RDWR | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    descriptor = -1
    created = False
    for _attempt in range(3):
        try:
            descriptor = os.open(
                ".durable-json.lock",
                common_flags | os.O_CREAT | os.O_EXCL,
                0o600,
                dir_fd=parent_fd,
            )
            created = True
            break
        except FileExistsError:
            try:
                descriptor = os.open(
                    ".durable-json.lock",
                    common_flags,
                    dir_fd=parent_fd,
                )
                break
            except FileNotFoundError:
                continue
        except FileNotFoundError:
            continue
    if descriptor < 0:
        raise FileNotFoundError("lock entry did not stabilize")
    lock_stat = os.fstat(descriptor)
    if (
        not stat.S_ISREG(lock_stat.st_mode)
        or lock_stat.st_uid != os.getuid()
        or stat.S_IMODE(lock_stat.st_mode) & 0o077
    ):
        os.close(descriptor)
        raise DurableWriteError(ErrorClass.PERMISSION.value)
    os.fchmod(descriptor, 0o600)
    if created:
        os.fsync(descriptor)
        os.fsync(parent_fd)
    fcntl.flock(descriptor, fcntl.LOCK_EX)
    return descriptor


def _write_all(descriptor: int, raw: bytes) -> None:
    offset = 0
    while offset < len(raw):
        written = os.write(descriptor, raw[offset:])
        if written <= 0:
            raise OSError("short write")
        offset += written


def _inject_fault(
    hook: Callable[[WriteStage], None] | None,
    stage: WriteStage,
) -> None:
    if hook is not None:
        hook(stage)


def publish_event_json(
    target: DurableJsonTarget,
    payload: Mapping[str, Any],
    *,
    component: str,
    operation_id: str,
    _fault_hook: Callable[[WriteStage], None] | None = None,
) -> PublicationResult:
    absent = JsonVersion(False, None, None, None)
    try:
        canonical = _canonical_payload(payload)
        expected_operation = globals()["operation_id"](
            target,
            payload,
            component=component,
            predecessor=absent,
        )
    except DurableWriteError:
        return _result(
            component=component,
            operation=operation_id,
            content_sha256=None,
            durability=DurabilityProof.NOT_MUTATED,
            authority=AuthorityState.EXPECTED_PREDECESSOR,
            stage=WriteStage.SERIALIZATION,
            error_class=ErrorClass.SERIALIZATION,
        )
    raw = canonical + b"\n"
    content_sha256 = hashlib.sha256(raw).hexdigest()
    if operation_id != expected_operation:
        return _result(
            component=component,
            operation=operation_id,
            content_sha256=content_sha256,
            durability=DurabilityProof.NOT_MUTATED,
            authority=AuthorityState.EXPECTED_PREDECESSOR,
            stage=WriteStage.CAPABILITY_CHECK,
            error_class=ErrorClass.IDENTITY_TYPE,
        )

    parent_fd = -1
    lock_fd = -1
    temp_fd = -1
    temp_name = f".durable-json.{operation_id}.tmp"
    temp_created = False
    published = False
    cleanup = CleanupState.NOT_REQUIRED
    current_stage = WriteStage.SERIALIZATION
    try:
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.CAPABILITY_CHECK
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.PARENT_OPEN
        parent_fd, leaf = _open_target_parent(target)
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.LOCK_ACQUISITION
        lock_fd = _lock_parent(parent_fd)
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.TEMPORARY_CREATION
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        temp_fd = os.open(temp_name, flags, 0o600, dir_fd=parent_fd)
        temp_created = True
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.WRITE
        _write_all(temp_fd, raw)
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.FILE_FLUSH
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.FILE_SYNC
        os.fsync(temp_fd)
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.PERMISSION_FINALIZATION
        os.fchmod(temp_fd, 0o600)
        temp_stat = os.fstat(temp_fd)
        if not stat.S_ISREG(temp_stat.st_mode) or temp_stat.st_nlink != 1:
            raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)
        _inject_fault(_fault_hook, current_stage)
        os.close(temp_fd)
        temp_fd = -1
        current_stage = WriteStage.PUBLICATION
        os.link(
            temp_name,
            leaf,
            src_dir_fd=parent_fd,
            dst_dir_fd=parent_fd,
            follow_symlinks=False,
        )
        published = True
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.CLEANUP
        try:
            os.unlink(temp_name, dir_fd=parent_fd)
            temp_created = False
            cleanup = CleanupState.COMPLETE
        except OSError:
            cleanup = CleanupState.DEBT_PRIVATE_TEMP
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.PARENT_SYNC
        _inject_fault(_fault_hook, current_stage)
        os.fsync(parent_fd)
        return _result(
            component=component,
            operation=operation_id,
            content_sha256=content_sha256,
            durability=DurabilityProof.COMMITTED,
            authority=AuthorityState.INTENDED_AUTHORITATIVE,
            stage=WriteStage.PARENT_SYNC,
            cleanup=cleanup,
        )
    except FileExistsError:
        if parent_fd >= 0:
            existing_fd = -1
            try:
                existing_fd = os.open(
                    leaf,
                    os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=parent_fd,
                )
                existing_stat = os.fstat(existing_fd)
                if (
                    not stat.S_ISREG(existing_stat.st_mode)
                    or existing_stat.st_uid != os.getuid()
                    or stat.S_IMODE(existing_stat.st_mode) & 0o077
                    or existing_stat.st_nlink != 1
                    or existing_stat.st_size != len(raw)
                ):
                    raise DurableWriteError(ErrorClass.CONFLICT.value)
                existing = b""
                while len(existing) < len(raw):
                    chunk = os.read(existing_fd, len(raw) - len(existing))
                    if not chunk:
                        break
                    existing += chunk
                if existing == raw:
                    try:
                        os.unlink(temp_name, dir_fd=parent_fd)
                        temp_created = False
                        cleanup = CleanupState.COMPLETE
                    except OSError:
                        cleanup = CleanupState.DEBT_PRIVATE_TEMP
                    os.fsync(parent_fd)
                    return _result(
                        component=component,
                        operation=operation_id,
                        content_sha256=content_sha256,
                        durability=DurabilityProof.RECONCILED_COMMITTED,
                        authority=AuthorityState.INTENDED_AUTHORITATIVE,
                        stage=WriteStage.RECONCILIATION,
                        cleanup=cleanup,
                    )
            except (OSError, DurableWriteError):
                pass
            finally:
                if existing_fd >= 0:
                    os.close(existing_fd)
        return _result(
            component=component,
            operation=operation_id,
            content_sha256=content_sha256,
            durability=DurabilityProof.UNPROVEN if published else DurabilityProof.NOT_MUTATED,
            authority=AuthorityState.CONFLICT,
            stage=WriteStage.PUBLICATION,
            error_class=ErrorClass.CONFLICT,
            cleanup=CleanupState.DEBT_PRIVATE_TEMP if temp_created else CleanupState.NOT_REQUIRED,
        )
    except (OSError, DurableWriteError) as exc:
        confinement = (
            ConfinementProof.VIOLATED
            if parent_fd < 0 and isinstance(exc, DurableWriteError)
            else ConfinementProof.PROVEN
        )
        error_class = ErrorClass.INTERRUPTION if isinstance(exc, InterruptedError) else (
            ErrorClass.IDENTITY_TYPE
            if confinement is ConfinementProof.VIOLATED
            else ErrorClass.IO
        )
        return _result(
            component=component,
            operation=operation_id,
            content_sha256=content_sha256,
            durability=DurabilityProof.UNPROVEN if published else DurabilityProof.NOT_MUTATED,
            authority=AuthorityState.UNKNOWN if published else AuthorityState.EXPECTED_PREDECESSOR,
            stage=current_stage,
            error_class=error_class,
            cleanup=CleanupState.DEBT_PRIVATE_TEMP if temp_created else CleanupState.NOT_REQUIRED,
            confinement=confinement,
        )
    finally:
        if temp_fd >= 0:
            os.close(temp_fd)
        if temp_created and parent_fd >= 0:
            try:
                os.unlink(temp_name, dir_fd=parent_fd)
            except OSError:
                pass
        if lock_fd >= 0:
            os.close(lock_fd)
        if parent_fd >= 0:
            os.close(parent_fd)


def _read_version_at(parent_fd: int, leaf: str) -> tuple[bytes | None, JsonVersion]:
    flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(leaf, flags, dir_fd=parent_fd)
    except FileNotFoundError:
        return None, JsonVersion(False, None, None, None)
    try:
        file_stat = os.fstat(descriptor)
        if (
            not stat.S_ISREG(file_stat.st_mode)
            or file_stat.st_uid != os.getuid()
            or stat.S_IMODE(file_stat.st_mode) & 0o077
            or file_stat.st_nlink != 1
            or file_stat.st_size > 8 * 1024 * 1024
        ):
            raise DurableWriteError(ErrorClass.PERMISSION.value)
        raw = b""
        while len(raw) <= 8 * 1024 * 1024:
            chunk = os.read(descriptor, min(1024 * 1024, 8 * 1024 * 1024 + 1 - len(raw)))
            if not chunk:
                break
            raw += chunk
        if len(raw) > 8 * 1024 * 1024:
            raise DurableWriteError(ErrorClass.SIZE.value)
        try:
            payload = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DurableWriteError(ErrorClass.SERIALIZATION.value) from exc
        if not isinstance(payload, dict):
            raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)
        observed_generation = payload.get("generation")
        observed_operation = payload.get("operationId")
        if observed_generation is not None and (
            not isinstance(observed_generation, int) or isinstance(observed_generation, bool)
        ):
            raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)
        if observed_operation is not None and not isinstance(observed_operation, str):
            raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)
        return raw, JsonVersion(
            True,
            hashlib.sha256(raw).hexdigest(),
            observed_generation,
            observed_operation,
        )
    finally:
        os.close(descriptor)


def publish_state_json(
    target: DurableJsonTarget,
    payload: Mapping[str, Any],
    *,
    component: str,
    operation_id: str,
    expected: JsonVersion,
    generation: int,
    _fault_hook: Callable[[WriteStage], None] | None = None,
) -> PublicationResult:
    if (
        not isinstance(expected, JsonVersion)
        or not isinstance(generation, int)
        or isinstance(generation, bool)
        or generation < 1
    ):
        return _result(
            component=component,
            operation=operation_id,
            content_sha256=None,
            durability=DurabilityProof.NOT_MUTATED,
            authority=AuthorityState.UNKNOWN,
            stage=WriteStage.CAPABILITY_CHECK,
            error_class=ErrorClass.IDENTITY_TYPE,
            generation=generation if isinstance(generation, int) else None,
        )
    try:
        canonical = _canonical_payload(payload)
        expected_operation = globals()["operation_id"](
            target,
            payload,
            component=component,
            predecessor=expected,
        )
    except DurableWriteError:
        return _result(
            component=component,
            operation=operation_id,
            content_sha256=None,
            durability=DurabilityProof.NOT_MUTATED,
            authority=AuthorityState.UNKNOWN,
            stage=WriteStage.SERIALIZATION,
            error_class=ErrorClass.SERIALIZATION,
            generation=generation,
        )
    raw = canonical + b"\n"
    content_sha256 = hashlib.sha256(raw).hexdigest()
    if operation_id != expected_operation:
        return _result(
            component=component,
            operation=operation_id,
            content_sha256=content_sha256,
            durability=DurabilityProof.NOT_MUTATED,
            authority=AuthorityState.UNKNOWN,
            stage=WriteStage.CAPABILITY_CHECK,
            error_class=ErrorClass.IDENTITY_TYPE,
            generation=generation,
        )

    parent_fd = -1
    lock_fd = -1
    temp_fd = -1
    temp_name = f".durable-json.{operation_id}.tmp"
    temp_created = False
    published = False
    current_stage = WriteStage.SERIALIZATION
    try:
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.CAPABILITY_CHECK
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.PARENT_OPEN
        parent_fd, leaf = _open_target_parent(target)
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.LOCK_ACQUISITION
        lock_fd = _lock_parent(parent_fd)
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.RECONCILIATION
        current_raw, current = _read_version_at(parent_fd, leaf)
        if current_raw == raw:
            os.fsync(parent_fd)
            return _result(
                component=component,
                operation=operation_id,
                content_sha256=content_sha256,
                durability=DurabilityProof.RECONCILED_COMMITTED,
                authority=AuthorityState.INTENDED_AUTHORITATIVE,
                stage=WriteStage.RECONCILIATION,
                cleanup=CleanupState.NOT_REQUIRED,
                generation=generation,
            )
        if current != expected:
            superseded = (
                current.generation is not None
                and expected.generation is not None
                and current.generation > expected.generation
            )
            return _result(
                component=component,
                operation=operation_id,
                content_sha256=content_sha256,
                durability=DurabilityProof.NOT_MUTATED,
                authority=AuthorityState.SUPERSEDED if superseded else AuthorityState.CONFLICT,
                stage=WriteStage.RECONCILIATION,
                error_class=ErrorClass.CONFLICT,
                generation=generation,
            )
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.TEMPORARY_CREATION
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        temp_fd = os.open(temp_name, flags, 0o600, dir_fd=parent_fd)
        temp_created = True
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.WRITE
        _write_all(temp_fd, raw)
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.FILE_FLUSH
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.FILE_SYNC
        os.fsync(temp_fd)
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.PERMISSION_FINALIZATION
        os.fchmod(temp_fd, 0o600)
        temp_stat = os.fstat(temp_fd)
        if not stat.S_ISREG(temp_stat.st_mode) or temp_stat.st_nlink != 1:
            raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)
        _inject_fault(_fault_hook, current_stage)
        os.close(temp_fd)
        temp_fd = -1
        current_stage = WriteStage.PUBLICATION
        os.replace(temp_name, leaf, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        temp_created = False
        published = True
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.PARENT_SYNC
        _inject_fault(_fault_hook, current_stage)
        os.fsync(parent_fd)
        return _result(
            component=component,
            operation=operation_id,
            content_sha256=content_sha256,
            durability=DurabilityProof.COMMITTED,
            authority=AuthorityState.INTENDED_AUTHORITATIVE,
            stage=WriteStage.PARENT_SYNC,
            cleanup=CleanupState.COMPLETE,
            generation=generation,
        )
    except (OSError, DurableWriteError) as exc:
        confinement = (
            ConfinementProof.VIOLATED
            if parent_fd < 0 and isinstance(exc, DurableWriteError)
            else ConfinementProof.PROVEN
        )
        error_class = ErrorClass.INTERRUPTION if isinstance(exc, InterruptedError) else (
            ErrorClass.IDENTITY_TYPE
            if confinement is ConfinementProof.VIOLATED
            else ErrorClass.IO
        )
        return _result(
            component=component,
            operation=operation_id,
            content_sha256=content_sha256,
            durability=DurabilityProof.UNPROVEN if published else DurabilityProof.NOT_MUTATED,
            authority=AuthorityState.UNKNOWN if published else AuthorityState.EXPECTED_PREDECESSOR,
            stage=current_stage,
            error_class=error_class,
            cleanup=CleanupState.DEBT_PRIVATE_TEMP if temp_created else CleanupState.NOT_REQUIRED,
            confinement=confinement,
            generation=generation,
        )
    finally:
        if temp_fd >= 0:
            os.close(temp_fd)
        if temp_created and parent_fd >= 0:
            try:
                os.unlink(temp_name, dir_fd=parent_fd)
            except OSError:
                pass
        if lock_fd >= 0:
            os.close(lock_fd)
        if parent_fd >= 0:
            os.close(parent_fd)


def reconcile_json_publication(*args: object, **kwargs: object) -> NoReturn:
    _not_implemented()


def sync_changed_parents(*args: object, **kwargs: object) -> NoReturn:
    _not_implemented()


def require_advance(result: PublicationResult) -> None:
    if not result.advance_allowed:
        raise DurableWriteError(
            json.dumps(result.public_projection(), sort_keys=True, separators=(",", ":"))
        )
