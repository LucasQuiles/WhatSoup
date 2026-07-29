"""Descriptor-confined durable JSON publication contracts."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import json
import os
from pathlib import Path, PurePath, PurePosixPath
import stat
from typing import Any, Mapping, NoReturn


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
    descriptor = os.open(name, flags, dir_fd=dir_fd)
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


def publish_event_json(*args: object, **kwargs: object) -> NoReturn:
    _not_implemented()


def publish_state_json(*args: object, **kwargs: object) -> NoReturn:
    _not_implemented()


def reconcile_json_publication(*args: object, **kwargs: object) -> NoReturn:
    _not_implemented()


def sync_changed_parents(*args: object, **kwargs: object) -> NoReturn:
    _not_implemented()


def require_advance(result: PublicationResult) -> None:
    if not result.advance_allowed:
        raise DurableWriteError(
            json.dumps(result.public_projection(), sort_keys=True, separators=(",", ":"))
        )
