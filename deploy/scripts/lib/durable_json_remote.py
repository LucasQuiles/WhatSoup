"""Runtime-safe durable event publisher embedded into remote BOT ERRORS scripts."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import errno
import hashlib
import json
import os
from pathlib import Path, PurePath, PurePosixPath
import stat
from typing import Any, Callable, Mapping, Sequence

try:
    import fcntl
except ImportError:  # pragma: no cover - exercised through capability simulation
    fcntl = None  # type: ignore[assignment]


HELPER_GENERATION = 1
_MAX_JSON_BYTES = 8 * 1024 * 1024
_MAX_SAFE_INTEGER = (1 << 53) - 1
_HAS_OPEN_DIR_FD = os.open in os.supports_dir_fd
_HAS_LINK_DIR_FD = os.link in os.supports_dir_fd
_HAS_LINK_NOFOLLOW = os.link in os.supports_follow_symlinks


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


class _EventTempRecovery(Enum):
    ABSENT = 0
    RETIRED_UNPUBLISHED = 1
    RETIRED_PUBLISHED = 2


class DurableWriteError(RuntimeError):
    def __init__(
        self,
        error_class: ErrorClass | str,
        public_message: str | None = None,
    ):
        self.error_class = ErrorClass(error_class)
        super().__init__(public_message or self.error_class.value)


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
        or any(part in {"", ".", ".."} for part in root_parts[1:])
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
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(
        os,
        "O_NOFOLLOW",
        0,
    )
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
        if (
            root_stat.st_uid != os.getuid()
            or stat.S_IMODE(root_stat.st_mode) & 0o077
        ):
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


def _parent_authority_matches(
    target: DurableJsonTarget,
    parent_fd: int,
) -> bool:
    comparison_fd = -1
    try:
        comparison_fd, _leaf = _open_target_parent(target)
        current = os.fstat(parent_fd)
        comparison = os.fstat(comparison_fd)
        return (
            current.st_dev == comparison.st_dev
            and current.st_ino == comparison.st_ino
        )
    except (OSError, DurableWriteError):
        return False
    finally:
        if comparison_fd >= 0:
            os.close(comparison_fd)


def _canonical_payload(payload: Mapping[str, Any]) -> bytes:
    if not isinstance(payload, Mapping):
        raise DurableWriteError(ErrorClass.SERIALIZATION.value)

    active_containers: set[int] = set()

    def validate(value: Any) -> None:
        if isinstance(value, bool) or value is None or isinstance(value, str):
            return
        if isinstance(value, int):
            if abs(value) > _MAX_SAFE_INTEGER:
                raise DurableWriteError(ErrorClass.SERIALIZATION.value)
            return
        if isinstance(value, float):
            return
        if not isinstance(value, (Mapping, list, tuple)):
            return
        identity = id(value)
        if identity in active_containers:
            raise DurableWriteError(ErrorClass.SERIALIZATION.value)
        active_containers.add(identity)
        try:
            if isinstance(value, Mapping):
                if any(not isinstance(key, str) for key in value):
                    raise DurableWriteError(ErrorClass.IDENTITY_TYPE.value)
                for nested in value.values():
                    validate(nested)
            else:
                for nested in value:
                    validate(nested)
        finally:
            active_containers.remove(identity)

    validate(payload)
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
    raw = rendered.encode("utf-8")
    if len(raw) + 1 > _MAX_JSON_BYTES:
        raise DurableWriteError(ErrorClass.SIZE.value)
    return raw


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
        or not isinstance(component, str)
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


def _classify_exception(
    exc: OSError | DurableWriteError,
    *,
    parent_opened: bool,
) -> tuple[ConfinementProof, ErrorClass]:
    if isinstance(exc, InterruptedError):
        return (
            (
                ConfinementProof.PROVEN
                if parent_opened
                else ConfinementProof.UNPROVEN
            ),
            ErrorClass.INTERRUPTION,
        )
    if isinstance(exc, DurableWriteError):
        confinement = (
            ConfinementProof.VIOLATED
            if not parent_opened
            and exc.error_class is ErrorClass.IDENTITY_TYPE
            else (
                ConfinementProof.PROVEN
                if parent_opened
                else ConfinementProof.UNPROVEN
            )
        )
        return confinement, exc.error_class
    if exc.errno in {errno.EMFILE, errno.ENFILE}:
        error_class = ErrorClass.DESCRIPTOR_EXHAUSTION
    elif exc.errno in {errno.EACCES, errno.EPERM}:
        error_class = ErrorClass.PERMISSION
    elif exc.errno in {
        errno.EINVAL,
        getattr(errno, "ENOTSUP", errno.EINVAL),
        getattr(errno, "EOPNOTSUPP", errno.EINVAL),
    }:
        error_class = ErrorClass.UNSUPPORTED_CAPABILITY
    else:
        error_class = ErrorClass.IO
    return (
        (
            ConfinementProof.PROVEN
            if parent_opened
            else ConfinementProof.UNPROVEN
        ),
        error_class,
    )


def _lock_parent(parent_fd: int) -> int:
    if fcntl is None:
        raise DurableWriteError(ErrorClass.UNSUPPORTED_CAPABILITY.value)
    common_flags = (
        os.O_RDWR | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    )
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


def _require_capabilities() -> None:
    if (
        fcntl is None
        or not getattr(os, "O_NOFOLLOW", 0)
        or not _HAS_OPEN_DIR_FD
        or not _HAS_LINK_DIR_FD
        or not _HAS_LINK_NOFOLLOW
    ):
        raise DurableWriteError(ErrorClass.UNSUPPORTED_CAPABILITY.value)


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


def _recover_reconciled_event_temp(
    parent_fd: int,
    *,
    leaf: str,
    temp_name: str,
    intended_raw: bytes,
) -> _EventTempRecovery:
    flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    try:
        temp_fd = os.open(temp_name, flags, dir_fd=parent_fd)
    except FileNotFoundError:
        return _EventTempRecovery.ABSENT
    target_fd = -1
    try:
        temp_stat = os.fstat(temp_fd)
        if (
            not stat.S_ISREG(temp_stat.st_mode)
            or temp_stat.st_uid != os.getuid()
            or stat.S_IMODE(temp_stat.st_mode) & 0o077
            or temp_stat.st_nlink not in {1, 2}
            or temp_stat.st_size != len(intended_raw)
        ):
            raise DurableWriteError(ErrorClass.CONFLICT)
        observed = b""
        while len(observed) < len(intended_raw):
            chunk = os.read(
                temp_fd,
                len(intended_raw) - len(observed),
            )
            if not chunk:
                break
            observed += chunk
        if observed != intended_raw:
            raise DurableWriteError(ErrorClass.CONFLICT)
        try:
            target_fd = os.open(leaf, flags, dir_fd=parent_fd)
        except FileNotFoundError:
            if temp_stat.st_nlink != 1:
                raise DurableWriteError(ErrorClass.CONFLICT)
            os.unlink(temp_name, dir_fd=parent_fd)
            os.fsync(parent_fd)
            return _EventTempRecovery.RETIRED_UNPUBLISHED
        target_stat = os.fstat(target_fd)
        if (
            not stat.S_ISREG(target_stat.st_mode)
            or target_stat.st_uid != os.getuid()
            or stat.S_IMODE(target_stat.st_mode) & 0o077
            or temp_stat.st_dev != target_stat.st_dev
            or temp_stat.st_ino != target_stat.st_ino
            or temp_stat.st_nlink != 2
            or target_stat.st_nlink != 2
            or target_stat.st_size != len(intended_raw)
        ):
            raise DurableWriteError(ErrorClass.CONFLICT)
        os.unlink(temp_name, dir_fd=parent_fd)
        os.fsync(parent_fd)
        return _EventTempRecovery.RETIRED_PUBLISHED
    finally:
        if target_fd >= 0:
            os.close(target_fd)
        os.close(temp_fd)


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
    except DurableWriteError as exc:
        return _result(
            component=component,
            operation=operation_id,
            content_sha256=None,
            durability=DurabilityProof.NOT_MUTATED,
            authority=AuthorityState.EXPECTED_PREDECESSOR,
            stage=WriteStage.SERIALIZATION,
            error_class=exc.error_class,
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
        _require_capabilities()
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.PARENT_OPEN
        _inject_fault(_fault_hook, current_stage)
        parent_fd, leaf = _open_target_parent(target)
        current_stage = WriteStage.LOCK_ACQUISITION
        lock_fd = _lock_parent(parent_fd)
        _inject_fault(_fault_hook, current_stage)
        current_stage = WriteStage.TEMPORARY_CREATION
        event_temp_recovery = _recover_reconciled_event_temp(
            parent_fd,
            leaf=leaf,
            temp_name=temp_name,
            intended_raw=raw,
        )
        if event_temp_recovery is _EventTempRecovery.RETIRED_PUBLISHED:
            authority = (
                AuthorityState.INTENDED_AUTHORITATIVE
                if _parent_authority_matches(target, parent_fd)
                else AuthorityState.UNKNOWN
            )
            return _result(
                component=component,
                operation=operation_id,
                content_sha256=content_sha256,
                durability=DurabilityProof.RECONCILED_COMMITTED,
                authority=authority,
                stage=WriteStage.RECONCILIATION,
                cleanup=CleanupState.COMPLETE,
            )
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | os.O_CLOEXEC
            | getattr(os, "O_NOFOLLOW", 0)
        )
        temp_fd = os.open(
            temp_name,
            flags,
            0o600,
            dir_fd=parent_fd,
        )
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
        authority = (
            AuthorityState.INTENDED_AUTHORITATIVE
            if _parent_authority_matches(target, parent_fd)
            else AuthorityState.UNKNOWN
        )
        return _result(
            component=component,
            operation=operation_id,
            content_sha256=content_sha256,
            durability=DurabilityProof.COMMITTED,
            authority=authority,
            stage=WriteStage.PARENT_SYNC,
            cleanup=cleanup,
        )
    except FileExistsError:
        if current_stage is WriteStage.TEMPORARY_CREATION:
            return _result(
                component=component,
                operation=operation_id,
                content_sha256=content_sha256,
                durability=DurabilityProof.NOT_MUTATED,
                authority=AuthorityState.UNKNOWN,
                stage=current_stage,
                error_class=ErrorClass.CONFLICT,
                cleanup=CleanupState.DEBT_RECOVERY_RECORD,
            )
        if parent_fd >= 0:
            existing_fd = -1
            try:
                existing_fd = os.open(
                    leaf,
                    (
                        os.O_RDONLY
                        | os.O_CLOEXEC
                        | getattr(os, "O_NOFOLLOW", 0)
                    ),
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
                    chunk = os.read(
                        existing_fd,
                        len(raw) - len(existing),
                    )
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
                    authority = (
                        AuthorityState.INTENDED_AUTHORITATIVE
                        if _parent_authority_matches(target, parent_fd)
                        else AuthorityState.UNKNOWN
                    )
                    return _result(
                        component=component,
                        operation=operation_id,
                        content_sha256=content_sha256,
                        durability=DurabilityProof.RECONCILED_COMMITTED,
                        authority=authority,
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
            durability=(
                DurabilityProof.UNPROVEN
                if published
                else DurabilityProof.NOT_MUTATED
            ),
            authority=AuthorityState.CONFLICT,
            stage=WriteStage.PUBLICATION,
            error_class=ErrorClass.CONFLICT,
            cleanup=(
                CleanupState.DEBT_PRIVATE_TEMP
                if temp_created
                else CleanupState.NOT_REQUIRED
            ),
        )
    except (OSError, DurableWriteError) as exc:
        confinement, error_class = _classify_exception(
            exc,
            parent_opened=parent_fd >= 0,
        )
        cleanup_state = (
            CleanupState.DEBT_RECOVERY_RECORD
            if current_stage is WriteStage.TEMPORARY_CREATION
            and not temp_created
            else (
                CleanupState.DEBT_PRIVATE_TEMP
                if temp_created
                else CleanupState.NOT_REQUIRED
            )
        )
        return _result(
            component=component,
            operation=operation_id,
            content_sha256=content_sha256,
            durability=(
                DurabilityProof.UNPROVEN
                if published
                else DurabilityProof.NOT_MUTATED
            ),
            authority=(
                AuthorityState.UNKNOWN
                if published
                else AuthorityState.EXPECTED_PREDECESSOR
            ),
            stage=current_stage,
            error_class=error_class,
            cleanup=cleanup_state,
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


def require_advance(result: PublicationResult) -> None:
    if not result.advance_allowed:
        raise DurableWriteError(
            result.error_class or ErrorClass.UNKNOWN,
            json.dumps(
                result.public_projection(),
                sort_keys=True,
                separators=(",", ":"),
            ),
        )


def require_all_advance(results: Sequence[PublicationResult]) -> None:
    for result in results:
        require_advance(result)
