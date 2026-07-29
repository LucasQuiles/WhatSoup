"""Descriptor-confined durable JSON publication contracts."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import json
import os
from pathlib import Path, PurePath, PurePosixPath
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


def observe_json(*args: object, **kwargs: object) -> NoReturn:
    _not_implemented()


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
