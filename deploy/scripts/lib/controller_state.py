"""Durable, integrity-bound controller state with bounded recovery evidence."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time
from typing import Any, Literal


JsonObject = dict[str, Any]
StateComponent = Literal["collector", "heartbeat-watchdog", "dispatcher-incident"]
StateMode = Literal[
    "bootstrap", "valid", "recovered", "reconciled", "recovery_required"
]
ReadMode = Literal["valid", "legacy_valid", "recovery_pending", "unavailable"]
RecoveryOutcome = Literal[
    "validated_previous_only", "authoritative_reconciliation"
]
StateReason = Literal[
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
]

STATE_RECOVERY_REQUIRED_EXIT = 78
MAX_GENERATION = 2**53 - 1
MAX_OCCURRENCE_COUNT = 2**31 - 1

_FORMAT = "whatsoup.controller-state"
_FORMAT_VERSION = 1
_COMPONENTS = frozenset(
    {"collector", "heartbeat-watchdog", "dispatcher-incident"}
)
_REASONS = frozenset(
    {
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
)
_ENVELOPE_KEYS = frozenset(
    {
        "format",
        "formatVersion",
        "component",
        "storeId",
        "generation",
        "writtenAt",
        "integritySha256",
    }
)
_MARKER_KEYS = frozenset(
    {
        "format",
        "formatVersion",
        "component",
        "storeId",
        "highWaterGeneration",
        "highWaterIntegritySha256",
        "integritySha256",
    }
)
_JOURNAL_KEYS = frozenset(
    {
        "format",
        "formatVersion",
        "component",
        "storeId",
        "transactionId",
        "operation",
        "phase",
        "expectedGeneration",
        "targetGeneration",
        "expectedIntegritySha256",
        "targetIntegritySha256",
        "expectedHighWaterGeneration",
        "targetHighWaterGeneration",
        "expectedHighWaterIntegritySha256",
        "targetHighWaterIntegritySha256",
        "legacySourceSha256",
        "previousEnvelope",
        "targetEnvelope",
        "integritySha256",
    }
)
_RECEIPT_KEYS = frozenset(
    {
        "format",
        "formatVersion",
        "component",
        "storeId",
        "recoveryReceiptId",
        "reason",
        "phase",
        "occurrenceCount",
        "markerHighWaterGeneration",
        "markerHighWaterIntegritySha256",
        "recoveredGeneration",
        "recoveredIntegritySha256",
        "targetGeneration",
        "targetIntegritySha256",
        "integritySha256",
    }
)
_OPERATIONS = frozenset({"bootstrap", "migration", "normal", "reconciliation"})
_JOURNAL_PHASES = frozenset(
    {"prepared", "previous_committed", "primary_committed", "marker_committed"}
)
_RECOVERY_PHASES = frozenset(
    {
        "planned",
        "evidence_preserved",
        "restored",
        "reconciliation_prepared",
        "reconciled",
    }
)
_HEX32 = re.compile(r"^[0-9a-f]{32}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_UTC_MILLISECONDS = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"
)
_EVIDENCE_LEAF = re.compile(r"^[0-9a-f]{32}\.controller-state-evidence$")
_FALLBACK_EMITTED = False


@dataclass(frozen=True)
class StateDiagnostic:
    component: StateComponent
    mode: StateMode
    current_generation: int | None
    recovered_generation: int | None
    reason: StateReason | None
    recovery_receipt_id: str | None
    occurrence_count: int


@dataclass(frozen=True)
class StateLoadResult:
    mode: StateMode
    payload: dict[str, Any] | None
    capability: "StateWriteCapability | None"
    diagnostic: StateDiagnostic


@dataclass(frozen=True)
class StateReadResult:
    mode: ReadMode
    payload: dict[str, Any] | None
    generation: int | None
    reason: StateReason | None


@dataclass(frozen=True)
class StateCommitResult:
    mode: Literal["valid", "reconciled"]
    generation: int
    capability: "StateWriteCapability"
    diagnostic: StateDiagnostic


class ControllerStateRequired(RuntimeError):
    """Content-free process-boundary signal carrying a private diagnostic."""

    def __init__(self, diagnostic: StateDiagnostic):
        self.diagnostic = diagnostic
        super().__init__("controller state recovery required")

    def __repr__(self) -> str:
        return "ControllerStateRequired('controller state recovery required')"


class _StateFault(Exception):
    def __init__(self, reason: StateReason, *, recoverable: bool = False):
        self.reason = reason
        self.recoverable = recoverable


class _PublicationAmbiguous(_StateFault):
    def __init__(self) -> None:
        super().__init__("publication_ambiguous")


class _RealFileOps:
    open = staticmethod(os.open)
    fstat = staticmethod(os.fstat)
    read = staticmethod(os.read)
    write = staticmethod(os.write)
    fsync_file = staticmethod(os.fsync)
    fsync_directory = staticmethod(os.fsync)
    replace = staticmethod(os.replace)
    unlink = staticmethod(os.unlink)
    flock = staticmethod(fcntl.flock)
    close = staticmethod(os.close)


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _digest(value: Mapping[str, Any]) -> str:
    return hashlib.sha256(_canonical_bytes(value)).hexdigest()


def _deep_copy(value: Any) -> Any:
    return json.loads(_canonical_bytes(value).decode("utf-8"))


def _valid_generation(value: Any, *, nullable: bool = False) -> bool:
    return (nullable and value is None) or (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= MAX_GENERATION
    )


def _valid_digest(value: Any, *, nullable: bool = False) -> bool:
    return (nullable and value is None) or (
        isinstance(value, str) and _HEX64.fullmatch(value) is not None
    )


def _valid_store_id(value: Any) -> bool:
    return isinstance(value, str) and _HEX32.fullmatch(value) is not None


def _parse_json(raw: bytes) -> Any:
    try:
        text = raw.decode("utf-8")

        def reject_constant(_value: str) -> None:
            raise ValueError("non-finite JSON number")

        return json.loads(text, parse_constant=reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise _StateFault("decode_failed", recoverable=True) from exc


def _validate_payload_copy(
    value: Mapping[str, Any],
    validator: Callable[[Mapping[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError("controller state payload must be an object")
    candidate = _deep_copy(dict(value))
    if "_controllerState" in candidate:
        raise ValueError("reserved controller state member")
    validated = validator(candidate)
    if not isinstance(validated, dict) or "_controllerState" in validated:
        raise ValueError("controller state validator must return an object")
    return _deep_copy(validated)


def _timestamp(clock: Callable[[], datetime]) -> str:
    value = clock()
    if (
        not isinstance(value, datetime)
        or value.tzinfo is None
        or value.utcoffset() != timezone.utc.utcoffset(value)
    ):
        raise ValueError("controller state clock must return UTC datetime")
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _make_envelope(
    payload: dict[str, Any],
    *,
    component: StateComponent,
    store_id: str,
    generation: int,
    clock: Callable[[], datetime],
) -> dict[str, Any]:
    if not _valid_generation(generation):
        raise _StateFault("generation_invalid")
    metadata: dict[str, Any] = {
        "format": _FORMAT,
        "formatVersion": _FORMAT_VERSION,
        "component": component,
        "storeId": store_id,
        "generation": generation,
        "writtenAt": _timestamp(clock),
    }
    metadata["integritySha256"] = _digest({**metadata, "payload": payload})
    return {**_deep_copy(payload), "_controllerState": metadata}


def _signed_sidecar(value: Mapping[str, Any]) -> dict[str, Any]:
    result = _deep_copy(dict(value))
    result.pop("integritySha256", None)
    result["integritySha256"] = _digest(result)
    return result


def _validate_envelope(
    raw: bytes,
    *,
    component: StateComponent,
    validator: Callable[[Mapping[str, Any]], dict[str, Any]],
    store_id: str | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    document = _parse_json(raw)
    if not isinstance(document, dict):
        raise _StateFault("invalid_root", recoverable=True)
    metadata = document.get("_controllerState")
    if metadata is None:
        raise _StateFault("schema_incompatible")
    if not isinstance(metadata, dict) or set(metadata) != _ENVELOPE_KEYS:
        raise _StateFault("schema_incompatible")
    if (
        metadata.get("format") != _FORMAT
        or metadata.get("formatVersion") != _FORMAT_VERSION
        or metadata.get("component") != component
        or not _valid_store_id(metadata.get("storeId"))
        or (store_id is not None and metadata.get("storeId") != store_id)
    ):
        raise _StateFault("schema_incompatible")
    if not _valid_generation(metadata.get("generation")):
        raise _StateFault("generation_invalid")
    written_at = metadata.get("writtenAt")
    if not isinstance(written_at, str) or not _UTC_MILLISECONDS.fullmatch(written_at):
        raise _StateFault("schema_incompatible")
    try:
        datetime.strptime(written_at, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as exc:
        raise _StateFault("schema_incompatible") from exc
    if not _valid_digest(metadata.get("integritySha256")):
        raise _StateFault("integrity_mismatch", recoverable=True)
    payload = {key: value for key, value in document.items() if key != "_controllerState"}
    unsigned = {key: value for key, value in metadata.items() if key != "integritySha256"}
    if metadata["integritySha256"] != _digest({**unsigned, "payload": payload}):
        raise _StateFault("integrity_mismatch", recoverable=True)
    try:
        validated = _validate_payload_copy(payload, validator)
    except (TypeError, ValueError):
        raise _StateFault("schema_incompatible") from None
    if raw != _canonical_bytes(document):
        raise _StateFault("schema_incompatible")
    return validated, _deep_copy(document)


def _validate_marker(
    raw: bytes, *, component: StateComponent
) -> dict[str, Any]:
    value = _parse_json(raw)
    if not isinstance(value, dict) or set(value) != _MARKER_KEYS:
        raise _StateFault("schema_incompatible")
    if (
        value.get("format") != _FORMAT
        or value.get("formatVersion") != _FORMAT_VERSION
        or value.get("component") != component
        or not _valid_store_id(value.get("storeId"))
    ):
        raise _StateFault("schema_incompatible")
    if not _valid_generation(value.get("highWaterGeneration")):
        raise _StateFault("generation_invalid")
    if not _valid_digest(value.get("highWaterIntegritySha256")):
        raise _StateFault("integrity_mismatch")
    if not _valid_digest(value.get("integritySha256")):
        raise _StateFault("integrity_mismatch")
    unsigned = {key: item for key, item in value.items() if key != "integritySha256"}
    if value["integritySha256"] != _digest(unsigned):
        raise _StateFault("integrity_mismatch")
    if raw != _canonical_bytes(value):
        raise _StateFault("schema_incompatible")
    return value


def _validate_receipt(
    raw: bytes, *, component: StateComponent, store_id: str
) -> dict[str, Any]:
    value = _parse_json(raw)
    if not isinstance(value, dict) or set(value) != _RECEIPT_KEYS:
        raise _StateFault("schema_incompatible")
    if (
        value.get("format") != _FORMAT
        or value.get("formatVersion") != _FORMAT_VERSION
        or value.get("component") != component
        or value.get("storeId") != store_id
        or not _valid_store_id(value.get("recoveryReceiptId"))
        or value.get("reason") not in _REASONS
        or value.get("phase") not in _RECOVERY_PHASES
    ):
        raise _StateFault("schema_incompatible")
    count = value.get("occurrenceCount")
    if not isinstance(count, int) or isinstance(count, bool) or not (
        1 <= count <= MAX_OCCURRENCE_COUNT
    ):
        raise _StateFault("generation_invalid")
    for key in ("markerHighWaterGeneration", "recoveredGeneration"):
        if not _valid_generation(value.get(key)):
            raise _StateFault("generation_invalid")
    if not _valid_generation(value.get("targetGeneration"), nullable=True):
        raise _StateFault("generation_invalid")
    for key in (
        "markerHighWaterIntegritySha256",
        "recoveredIntegritySha256",
    ):
        if not _valid_digest(value.get(key)):
            raise _StateFault("integrity_mismatch")
    if not _valid_digest(value.get("targetIntegritySha256"), nullable=True):
        raise _StateFault("integrity_mismatch")
    target_null = value["targetGeneration"] is None
    if target_null != (value["targetIntegritySha256"] is None):
        raise _StateFault("schema_incompatible")
    if value["phase"] in {"planned", "evidence_preserved", "restored"} and not target_null:
        raise _StateFault("schema_incompatible")
    if value["phase"] in {"reconciliation_prepared", "reconciled"} and target_null:
        raise _StateFault("schema_incompatible")
    if not _valid_digest(value.get("integritySha256")):
        raise _StateFault("integrity_mismatch")
    unsigned = {key: item for key, item in value.items() if key != "integritySha256"}
    if value["integritySha256"] != _digest(unsigned):
        raise _StateFault("integrity_mismatch")
    if raw != _canonical_bytes(value):
        raise _StateFault("schema_incompatible")
    return value


def _validate_journal(
    raw: bytes,
    *,
    component: StateComponent,
    store_id: str,
    validator: Callable[[Mapping[str, Any]], dict[str, Any]],
) -> dict[str, Any]:
    value = _parse_json(raw)
    if not isinstance(value, dict) or set(value) != _JOURNAL_KEYS:
        raise _StateFault("schema_incompatible")
    if (
        value.get("format") != _FORMAT
        or value.get("formatVersion") != _FORMAT_VERSION
        or value.get("component") != component
        or value.get("storeId") != store_id
        or not _valid_store_id(value.get("transactionId"))
        or value.get("operation") not in _OPERATIONS
        or value.get("phase") not in _JOURNAL_PHASES
    ):
        raise _StateFault("schema_incompatible")
    for key in (
        "expectedGeneration",
        "targetGeneration",
        "expectedHighWaterGeneration",
        "targetHighWaterGeneration",
    ):
        if not _valid_generation(value.get(key), nullable=True):
            raise _StateFault("generation_invalid")
    for key in (
        "expectedIntegritySha256",
        "targetIntegritySha256",
        "expectedHighWaterIntegritySha256",
        "targetHighWaterIntegritySha256",
        "legacySourceSha256",
    ):
        if not _valid_digest(value.get(key), nullable=True):
            raise _StateFault("integrity_mismatch")
    for key in (
        "targetGeneration",
        "expectedHighWaterGeneration",
        "targetHighWaterGeneration",
        "targetIntegritySha256",
        "expectedHighWaterIntegritySha256",
        "targetHighWaterIntegritySha256",
    ):
        if value[key] is None:
            raise _StateFault("schema_incompatible")
    if value["operation"] == "migration":
        if value["legacySourceSha256"] is None:
            raise _StateFault("schema_incompatible")
    elif value["legacySourceSha256"] is not None:
        raise _StateFault("schema_incompatible")
    if not _valid_digest(value.get("integritySha256")):
        raise _StateFault("integrity_mismatch")
    unsigned = {key: item for key, item in value.items() if key != "integritySha256"}
    if value["integritySha256"] != _digest(unsigned):
        raise _StateFault("integrity_mismatch")
    previous_raw = _canonical_bytes(value.get("previousEnvelope"))
    target_raw = _canonical_bytes(value.get("targetEnvelope"))
    _, previous = _validate_envelope(
        previous_raw, component=component, validator=validator, store_id=store_id
    )
    _, target = _validate_envelope(
        target_raw, component=component, validator=validator, store_id=store_id
    )
    previous_meta = previous["_controllerState"]
    target_meta = target["_controllerState"]
    if (
        target_meta["generation"] != value["targetGeneration"]
        or target_meta["integritySha256"] != value["targetIntegritySha256"]
        or value["targetHighWaterGeneration"] != value["targetGeneration"]
        or value["targetHighWaterIntegritySha256"] != value["targetIntegritySha256"]
    ):
        raise _StateFault("generation_invalid")
    if value["expectedGeneration"] is not None and (
        previous_meta["generation"] != value["expectedGeneration"]
        or previous_meta["integritySha256"] != value["expectedIntegritySha256"]
    ):
        raise _StateFault("generation_invalid")
    if value["operation"] in {"bootstrap", "migration"}:
        if value["expectedGeneration"] is not None or value["expectedIntegritySha256"] is not None:
            raise _StateFault("schema_incompatible")
    elif value["expectedGeneration"] is None or value["expectedIntegritySha256"] is None:
        raise _StateFault("schema_incompatible")
    if (
        value["expectedHighWaterGeneration"] >= MAX_GENERATION
        or value["targetGeneration"] != value["expectedHighWaterGeneration"] + 1
    ):
        raise _StateFault("generation_invalid")
    if value["operation"] != "reconciliation" and (
        previous_meta["generation"] != value["expectedHighWaterGeneration"]
        or previous_meta["integritySha256"]
        != value["expectedHighWaterIntegritySha256"]
    ):
        raise _StateFault("generation_invalid")
    if value["operation"] == "reconciliation" and (
        previous_meta["generation"] > value["expectedHighWaterGeneration"]
    ):
        raise _StateFault("generation_invalid")
    if raw != _canonical_bytes(value):
        raise _StateFault("schema_incompatible")
    return value


class StateWriteCapability:
    __slots__ = (
        "_token",
        "_session",
        "_component",
        "_store_id",
        "_generation",
        "_marker_generation",
        "_primary_identity",
        "_kind",
        "_active",
    )

    def __init__(
        self,
        token: object,
        session: "ControllerStateSession",
        component: StateComponent,
        store_id: str | None,
        generation: int | None,
        marker_generation: int | None,
        primary_identity: tuple[int, int] | None,
        kind: str,
    ) -> None:
        if token is not session._capability_token:
            raise TypeError("StateWriteCapability has no public constructor")
        self._token = token
        self._session = session
        self._component = component
        self._store_id = store_id
        self._generation = generation
        self._marker_generation = marker_generation
        self._primary_identity = primary_identity
        self._kind = kind
        self._active = True


class ControllerStateSession:
    """Verified directory, stable lock, current authority, and publication state."""

    def __init__(
        self,
        path: Path,
        *,
        component: StateComponent,
        bootstrap: Callable[[], dict[str, Any]],
        validate_payload: Callable[[Mapping[str, Any]], dict[str, Any]],
        lock_timeout_seconds: float,
        clock: Callable[[], datetime],
        random_bytes: Callable[[int], bytes],
        file_ops: Any,
        shared_lock: bool = False,
    ) -> None:
        self._path = path
        self._name = path.name
        self._component = component
        self._bootstrap = bootstrap
        self._validate_payload = validate_payload
        self._clock = clock
        self._random_bytes = random_bytes
        self._ops = file_ops
        self._directory_fd = -1
        self._lock_fd = -1
        self._closed = False
        self._startup_fault: StateReason | None = None
        self._capability_token = object()
        self._active_capability: StateWriteCapability | None = None
        try:
            self._open_directory()
            if self._startup_fault is None:
                self._open_lock(lock_timeout_seconds, shared=shared_lock)
        except ControllerStateRequired:
            self.close()
            raise

    def __enter__(self) -> "ControllerStateSession":
        if self._closed:
            raise RuntimeError("controller state session is closed")
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _traceback: Any) -> None:
        self.close()

    def _diagnostic(
        self,
        mode: StateMode,
        *,
        current: int | None = None,
        recovered: int | None = None,
        reason: StateReason | None = None,
        receipt: str | None = None,
        count: int = 0,
    ) -> StateDiagnostic:
        return StateDiagnostic(
            self._component, mode, current, recovered, reason, receipt, count
        )

    def _required(self, reason: StateReason) -> ControllerStateRequired:
        return ControllerStateRequired(
            self._diagnostic("recovery_required", reason=reason, count=1)
        )

    def _open_directory(self) -> None:
        current = -1
        try:
            absolute_parent = Path(os.path.abspath(self._path.parent))
            current = self._ops.open(
                os.sep, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            )
            for part in absolute_parent.parts[1:]:
                next_fd = self._ops.open(
                    part,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=current,
                )
                self._ops.close(current)
                current = next_fd
            observed = self._ops.fstat(current)
        except OSError as exc:
            if current >= 0:
                self._close_quiet(current)
            raise self._required("unsafe_file") from exc
        if (
            not stat.S_ISDIR(observed.st_mode)
            or observed.st_uid != os.geteuid()
            or stat.S_IMODE(observed.st_mode) & 0o022
        ):
            self._directory_fd = current
            self._startup_fault = "unsafe_file"
            return
        self._directory_fd = current

    def _open_lock(self, timeout: float, *, shared: bool) -> None:
        flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
        try:
            fd = self._ops.open(
                self._name + ".lock", flags, 0o600, dir_fd=self._directory_fd
            )
            observed = self._ops.fstat(fd)
            if not self._safe_file_stat(observed):
                raise OSError(errno.EPERM, "unsafe lock")
            deadline = time.monotonic() + max(0.0, timeout)
            lock_operation = (
                fcntl.LOCK_SH if shared else fcntl.LOCK_EX
            ) | fcntl.LOCK_NB
            while True:
                try:
                    self._ops.flock(fd, lock_operation)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError
                    time.sleep(min(0.005, max(0.0, deadline - time.monotonic())))
            recheck = self._ops.open(
                self._name + ".lock",
                os.O_RDWR | os.O_NOFOLLOW,
                dir_fd=self._directory_fd,
            )
            try:
                rechecked = self._ops.fstat(recheck)
            finally:
                self._ops.close(recheck)
            if (
                not self._safe_file_stat(rechecked)
                or (rechecked.st_dev, rechecked.st_ino)
                != (observed.st_dev, observed.st_ino)
            ):
                raise OSError(errno.EPERM, "replaced lock")
        except TimeoutError as exc:
            if "fd" in locals():
                self._close_quiet(fd)
            raise self._required("lock_unavailable") from exc
        except OSError as exc:
            if "fd" in locals():
                self._close_quiet(fd)
            reason: StateReason = (
                "unsafe_file"
                if exc.errno in {errno.ELOOP, errno.EPERM}
                else "read_failed"
            )
            raise self._required(reason) from exc
        self._lock_fd = fd

    def _safe_file_stat(self, observed: os.stat_result) -> bool:
        return (
            stat.S_ISREG(observed.st_mode)
            and observed.st_uid == os.geteuid()
            and stat.S_IMODE(observed.st_mode) == 0o600
        )

    def _close_checked(self, fd: int) -> None:
        try:
            self._ops.close(fd)
        except OSError as exc:
            try:
                os.close(fd)
            except OSError:
                pass
            raise _StateFault("read_failed") from exc

    def _close_quiet(self, fd: int) -> None:
        try:
            self._ops.close(fd)
        except OSError:
            try:
                os.close(fd)
            except OSError:
                pass

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("controller state session is closed")

    def _invalidate_capability(self) -> None:
        if self._active_capability is not None:
            self._active_capability._active = False
        self._active_capability = None

    def _new_capability(
        self,
        *,
        store_id: str | None,
        generation: int | None,
        marker_generation: int | None,
        primary_identity: tuple[int, int] | None,
        kind: str,
    ) -> StateWriteCapability:
        self._invalidate_capability()
        capability = StateWriteCapability(
            self._capability_token,
            self,
            self._component,
            store_id,
            generation,
            marker_generation,
            primary_identity,
            kind,
        )
        self._active_capability = capability
        return capability

    def _random_hex(self) -> str:
        value = self._random_bytes(16)
        if not isinstance(value, bytes) or len(value) != 16:
            raise ValueError("controller state random source must return 16 bytes")
        return value.hex()

    def _leaf(self, suffix: str) -> str:
        return self._name + suffix

    def _has_unmanaged_authority_artifact(self) -> bool:
        try:
            names = os.listdir(self._directory_fd)
        except OSError as exc:
            raise _StateFault("read_failed") from exc
        temporary_prefix = f".{self._name}."
        return any(
            _EVIDENCE_LEAF.fullmatch(name) is not None
            or name.startswith(temporary_prefix)
            for name in names
        )

    def _read_leaf_with_identity(
        self, suffix: str
    ) -> tuple[bytes, tuple[int, int]] | None:
        leaf = self._leaf(suffix)
        try:
            first = self._ops.open(
                leaf,
                os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW,
                dir_fd=self._directory_fd,
            )
        except FileNotFoundError:
            return None
        except OSError as exc:
            reason: StateReason = "unsafe_file" if exc.errno in {
                errno.ELOOP,
                errno.EPERM,
                errno.ENXIO,
            } else "read_failed"
            raise _StateFault(reason) from exc
        try:
            observed = self._ops.fstat(first)
            if not self._safe_file_stat(observed):
                raise _StateFault("unsafe_file")
            identity = (observed.st_dev, observed.st_ino)
            try:
                second = self._ops.open(
                    leaf,
                    os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW,
                    dir_fd=self._directory_fd,
                )
                second_stat = self._ops.fstat(second)
            except OSError as exc:
                raise _StateFault("unsafe_file") from exc
            finally:
                if "second" in locals():
                    self._close_checked(second)
            if (
                not self._safe_file_stat(second_stat)
                or (second_stat.st_dev, second_stat.st_ino) != identity
            ):
                raise _StateFault("unsafe_file")
            chunks: list[bytes] = []
            while True:
                chunk = self._ops.read(first, 1024 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
                if sum(map(len, chunks)) > 64 * 1024 * 1024:
                    raise _StateFault("read_failed")
            return b"".join(chunks), identity
        except OSError as exc:
            raise _StateFault("read_failed") from exc
        finally:
            self._close_checked(first)

    def _read_leaf(self, suffix: str) -> bytes | None:
        result = self._read_leaf_with_identity(suffix)
        return None if result is None else result[0]

    def _write_all(self, fd: int, data: bytes) -> None:
        offset = 0
        while offset < len(data):
            written = self._ops.write(fd, data[offset:])
            if written <= 0:
                raise OSError(errno.EIO, "short controller state write")
            offset += written

    def _atomic_bytes(self, suffix: str, data: bytes) -> None:
        leaf = self._leaf(suffix)
        temp = f".{leaf}.{self._random_hex()}.tmp"
        fd = -1
        renamed = False
        try:
            fd = self._ops.open(
                temp,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=self._directory_fd,
            )
            observed = self._ops.fstat(fd)
            if not self._safe_file_stat(observed):
                raise OSError(errno.EPERM, "unsafe temporary")
            self._write_all(fd, data)
            self._ops.fsync_file(fd)
            self._ops.close(fd)
            fd = -1
            self._ops.replace(
                temp,
                leaf,
                src_dir_fd=self._directory_fd,
                dst_dir_fd=self._directory_fd,
            )
            renamed = True
            self._ops.fsync_directory(self._directory_fd)
        except OSError as exc:
            if fd >= 0:
                self._close_quiet(fd)
            if renamed:
                raise _PublicationAmbiguous() from exc
            raise
        except BaseException:
            if fd >= 0:
                self._close_quiet(fd)
            raise

    def _atomic_json(self, suffix: str, value: Mapping[str, Any]) -> None:
        self._atomic_bytes(suffix, _canonical_bytes(value))

    def _unlink(self, suffix: str) -> None:
        try:
            self._ops.unlink(self._leaf(suffix), dir_fd=self._directory_fd)
            self._ops.fsync_directory(self._directory_fd)
        except FileNotFoundError:
            return
        except OSError as exc:
            raise _PublicationAmbiguous() from exc

    def _preserve_evidence(self, raw: bytes, leaf: str) -> None:
        fd = -1
        try:
            fd = self._ops.open(
                leaf,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=self._directory_fd,
            )
            observed = self._ops.fstat(fd)
            if not self._safe_file_stat(observed):
                raise OSError(errno.EPERM, "unsafe evidence")
            self._write_all(fd, raw)
            self._ops.fsync_file(fd)
            self._ops.close(fd)
            fd = -1
            self._ops.fsync_directory(self._directory_fd)
        except BaseException:
            if fd >= 0:
                self._close_quiet(fd)
            raise

    def _marker_for(
        self, store_id: str, generation: int, integrity: str
    ) -> dict[str, Any]:
        return _signed_sidecar(
            {
                "format": _FORMAT,
                "formatVersion": _FORMAT_VERSION,
                "component": self._component,
                "storeId": store_id,
                "highWaterGeneration": generation,
                "highWaterIntegritySha256": integrity,
            }
        )

    def _journal_for(
        self,
        *,
        operation: str,
        previous: dict[str, Any],
        target: dict[str, Any],
        expected_generation: int | None,
        expected_integrity: str | None,
        expected_highwater_generation: int,
        expected_highwater_integrity: str,
        legacy_source: str | None = None,
    ) -> dict[str, Any]:
        target_meta = target["_controllerState"]
        return _signed_sidecar(
            {
                "format": _FORMAT,
                "formatVersion": _FORMAT_VERSION,
                "component": self._component,
                "storeId": target_meta["storeId"],
                "transactionId": self._random_hex(),
                "operation": operation,
                "phase": "prepared",
                "expectedGeneration": expected_generation,
                "targetGeneration": target_meta["generation"],
                "expectedIntegritySha256": expected_integrity,
                "targetIntegritySha256": target_meta["integritySha256"],
                "expectedHighWaterGeneration": expected_highwater_generation,
                "targetHighWaterGeneration": target_meta["generation"],
                "expectedHighWaterIntegritySha256": expected_highwater_integrity,
                "targetHighWaterIntegritySha256": target_meta["integritySha256"],
                "legacySourceSha256": legacy_source,
                "previousEnvelope": previous,
                "targetEnvelope": target,
            }
        )

    def _advance_journal(self, journal: dict[str, Any], phase: str) -> dict[str, Any]:
        advanced = dict(journal)
        advanced["phase"] = phase
        advanced = _signed_sidecar(advanced)
        self._atomic_json(".transaction", advanced)
        return advanced

    def _same_envelope(self, raw: bytes | None, envelope: dict[str, Any]) -> bool:
        return raw == _canonical_bytes(envelope)

    def _resume_transaction(
        self,
        journal: dict[str, Any],
        marker: dict[str, Any],
    ) -> dict[str, Any]:
        previous = journal["previousEnvelope"]
        target = journal["targetEnvelope"]
        previous_raw = _canonical_bytes(previous)
        target_raw = _canonical_bytes(target)
        phase = journal["phase"]
        primary_raw = self._read_leaf("")
        retained_raw = self._read_leaf(".previous")
        operation = journal["operation"]
        marker_is_expected = (
            marker["storeId"] == journal["storeId"]
            and marker["highWaterGeneration"]
            == journal["expectedHighWaterGeneration"]
            and marker["highWaterIntegritySha256"]
            == journal["expectedHighWaterIntegritySha256"]
        )
        marker_is_target = (
            marker["storeId"] == journal["storeId"]
            and marker["highWaterGeneration"]
            == journal["targetHighWaterGeneration"]
            and marker["highWaterIntegritySha256"]
            == journal["targetHighWaterIntegritySha256"]
        )
        if (
            phase in {"prepared", "previous_committed"}
            and not marker_is_expected
        ) or (
            phase == "primary_committed"
            and not (marker_is_expected or marker_is_target)
        ) or (phase == "marker_committed" and not marker_is_target):
            raise _StateFault("publication_ambiguous")

        if phase == "prepared":
            if operation == "migration":
                if (
                    primary_raw is None
                    or hashlib.sha256(primary_raw).hexdigest()
                    != journal["legacySourceSha256"]
                ):
                    raise _StateFault("publication_ambiguous")
            elif operation == "bootstrap":
                if primary_raw not in {None, previous_raw, target_raw}:
                    raise _StateFault("publication_ambiguous")
            elif primary_raw not in {previous_raw, target_raw}:
                raise _StateFault("publication_ambiguous")
            self._atomic_bytes(".previous", previous_raw)
            journal = self._advance_journal(journal, "previous_committed")
            phase = "previous_committed"
            primary_raw = self._read_leaf("")
            retained_raw = self._read_leaf(".previous")

        if phase == "previous_committed":
            primary_matches = primary_raw in {previous_raw, target_raw}
            if operation == "bootstrap":
                primary_matches = primary_raw in {None, previous_raw, target_raw}
            elif operation == "migration":
                primary_matches = primary_raw == target_raw or (
                    primary_raw is not None
                    and hashlib.sha256(primary_raw).hexdigest()
                    == journal["legacySourceSha256"]
                )
            if retained_raw != previous_raw or not primary_matches:
                raise _StateFault("publication_ambiguous")
            self._atomic_bytes("", target_raw)
            journal = self._advance_journal(journal, "primary_committed")
            phase = "primary_committed"
            primary_raw = self._read_leaf("")
            retained_raw = self._read_leaf(".previous")

        if phase == "primary_committed":
            if primary_raw != target_raw or retained_raw != previous_raw:
                raise _StateFault("publication_ambiguous")
            current_marker = _validate_marker(
                self._read_leaf(".initialized") or b"",
                component=self._component,
            )
            expected_marker = (
                current_marker["highWaterGeneration"]
                == journal["expectedHighWaterGeneration"]
                and current_marker["highWaterIntegritySha256"]
                == journal["expectedHighWaterIntegritySha256"]
            )
            target_marker = (
                current_marker["highWaterGeneration"]
                == journal["targetHighWaterGeneration"]
                and current_marker["highWaterIntegritySha256"]
                == journal["targetHighWaterIntegritySha256"]
            )
            if not (expected_marker or target_marker):
                raise _StateFault("publication_ambiguous")
            target_marker_value = self._marker_for(
                journal["storeId"],
                journal["targetHighWaterGeneration"],
                journal["targetHighWaterIntegritySha256"],
            )
            self._atomic_json(".initialized", target_marker_value)
            marker = target_marker_value
            journal = self._advance_journal(journal, "marker_committed")
            phase = "marker_committed"

        if phase == "marker_committed":
            primary_raw = self._read_leaf("")
            retained_raw = self._read_leaf(".previous")
            current_marker = _validate_marker(
                self._read_leaf(".initialized") or b"",
                component=self._component,
            )
            if (
                primary_raw != target_raw
                or retained_raw != previous_raw
                or current_marker["storeId"] != journal["storeId"]
                or current_marker["highWaterGeneration"]
                != journal["targetHighWaterGeneration"]
                or current_marker["highWaterIntegritySha256"]
                != journal["targetHighWaterIntegritySha256"]
            ):
                raise _StateFault("publication_ambiguous")
            self._unlink(".transaction")
            marker = current_marker
        return marker

    def _make_load_result(
        self,
        mode: StateMode,
        payload: dict[str, Any],
        *,
        store_id: str | None,
        generation: int | None,
        marker_generation: int | None,
        primary_identity: tuple[int, int] | None,
        kind: str,
        receipt: dict[str, Any] | None = None,
    ) -> StateLoadResult:
        capability = self._new_capability(
            store_id=store_id,
            generation=generation,
            marker_generation=marker_generation,
            primary_identity=primary_identity,
            kind=kind,
        )
        diagnostic = self._diagnostic(
            mode,
            current=generation,
            recovered=(
                receipt["recoveredGeneration"] if receipt is not None else None
            ),
            reason=(
                receipt["reason"]
                if receipt is not None and mode == "recovered"
                else None
            ),
            receipt=(
                receipt["recoveryReceiptId"] if receipt is not None else None
            ),
            count=receipt["occurrenceCount"] if receipt is not None else 0,
        )
        return StateLoadResult(mode, _deep_copy(payload), capability, diagnostic)

    def _failure_result(
        self,
        reason: StateReason,
        *,
        current: int | None = None,
        recovered: int | None = None,
        receipt: dict[str, Any] | None = None,
    ) -> StateLoadResult:
        self._invalidate_capability()
        return StateLoadResult(
            "recovery_required",
            None,
            None,
            self._diagnostic(
                "recovery_required",
                current=current,
                recovered=recovered,
                reason=reason,
                receipt=(
                    receipt["recoveryReceiptId"] if receipt is not None else None
                ),
                count=receipt["occurrenceCount"] if receipt is not None else 1,
            ),
        )

    def _legacy_payload(self, raw: bytes) -> dict[str, Any]:
        value = _parse_json(raw)
        if not isinstance(value, dict):
            raise _StateFault("invalid_root")
        if "_controllerState" in value:
            raise _StateFault("schema_incompatible")
        try:
            return _validate_payload_copy(value, self._validate_payload)
        except (TypeError, ValueError):
            raise _StateFault("schema_incompatible") from None

    def _bootstrap_result(self) -> StateLoadResult:
        try:
            payload = _validate_payload_copy(self._bootstrap(), self._validate_payload)
        except (TypeError, ValueError):
            return self._failure_result("schema_incompatible")
        return self._make_load_result(
            "bootstrap",
            payload,
            store_id=None,
            generation=None,
            marker_generation=None,
            primary_identity=None,
            kind="bootstrap",
        )

    def _migrate(self, raw: bytes, payload: dict[str, Any]) -> StateLoadResult:
        store_id = self._random_hex()
        previous = _make_envelope(
            payload,
            component=self._component,
            store_id=store_id,
            generation=0,
            clock=self._clock,
        )
        target = _make_envelope(
            payload,
            component=self._component,
            store_id=store_id,
            generation=1,
            clock=self._clock,
        )
        previous_meta = previous["_controllerState"]
        marker = self._marker_for(
            store_id, 0, previous_meta["integritySha256"]
        )
        self._atomic_json(".initialized", marker)
        journal = self._journal_for(
            operation="migration",
            previous=previous,
            target=target,
            expected_generation=None,
            expected_integrity=None,
            expected_highwater_generation=0,
            expected_highwater_integrity=previous_meta["integritySha256"],
            legacy_source=hashlib.sha256(raw).hexdigest(),
        )
        self._atomic_json(".transaction", journal)
        marker = self._resume_transaction(journal, marker)
        observed = self._read_leaf_with_identity("")
        assert observed is not None
        return self._make_load_result(
            "reconciled",
            payload,
            store_id=store_id,
            generation=1,
            marker_generation=marker["highWaterGeneration"],
            primary_identity=observed[1],
            kind="normal",
        )

    def _receipt_evidence_leaf(self, receipt: Mapping[str, Any]) -> str:
        return (
            str(receipt["recoveryReceiptId"]) + ".controller-state-evidence"
        )

    def _reconciliation_stage_leaf(self, receipt: Mapping[str, Any]) -> str:
        return (
            f".{self._name}.{receipt['recoveryReceiptId']}."
            "reconciliation-journal.tmp"
        )

    def _recovery_receipt(
        self,
        *,
        marker: dict[str, Any],
        recovered: dict[str, Any],
        reason: StateReason,
    ) -> dict[str, Any]:
        metadata = recovered["_controllerState"]
        receipt_id = self._random_hex()
        while receipt_id == marker["storeId"]:
            receipt_id = self._random_hex()
        return _signed_sidecar(
            {
                "format": _FORMAT,
                "formatVersion": _FORMAT_VERSION,
                "component": self._component,
                "storeId": marker["storeId"],
                "recoveryReceiptId": receipt_id,
                "reason": reason,
                "phase": "planned",
                "occurrenceCount": 1,
                "markerHighWaterGeneration": marker["highWaterGeneration"],
                "markerHighWaterIntegritySha256": marker[
                    "highWaterIntegritySha256"
                ],
                "recoveredGeneration": metadata["generation"],
                "recoveredIntegritySha256": metadata["integritySha256"],
                "targetGeneration": None,
                "targetIntegritySha256": None,
            }
        )

    def _advance_receipt(
        self, receipt: dict[str, Any], phase: str, **changes: Any
    ) -> dict[str, Any]:
        advanced = dict(receipt)
        advanced.update(changes)
        advanced["phase"] = phase
        advanced = _signed_sidecar(advanced)
        self._atomic_json(".recovery", advanced)
        return advanced

    def _increment_receipt(self, receipt: dict[str, Any]) -> dict[str, Any]:
        count = min(MAX_OCCURRENCE_COUNT, receipt["occurrenceCount"] + 1)
        if count == receipt["occurrenceCount"]:
            return receipt
        advanced = dict(receipt)
        advanced["occurrenceCount"] = count
        advanced = _signed_sidecar(advanced)
        self._atomic_json(".recovery", advanced)
        return advanced

    def _recover(
        self,
        *,
        marker: dict[str, Any],
        primary_raw: bytes,
        previous: dict[str, Any],
        reason: StateReason,
        receipt: dict[str, Any] | None = None,
    ) -> StateLoadResult:
        previous_raw = _canonical_bytes(previous)
        is_retry = receipt is not None
        if receipt is None:
            receipt = self._recovery_receipt(
                marker=marker, recovered=previous, reason=reason
            )
            try:
                self._atomic_json(".recovery", receipt)
            except (OSError, _StateFault, _PublicationAmbiguous):
                return self._failure_result("evidence_preservation_failed")
        elif is_retry:
            try:
                receipt = self._increment_receipt(receipt)
            except (OSError, _StateFault, _PublicationAmbiguous):
                return self._failure_result(
                    "publication_ambiguous", receipt=receipt
                )
        phase = receipt["phase"]
        evidence_leaf = self._receipt_evidence_leaf(receipt)
        if phase == "planned":
            if primary_raw == previous_raw:
                return self._failure_result(
                    "publication_ambiguous", receipt=receipt
                )
            try:
                existing = self._read_named_evidence(evidence_leaf)
                if existing is None:
                    self._preserve_evidence(primary_raw, evidence_leaf)
                elif existing != primary_raw:
                    return self._failure_result(
                        "evidence_preservation_failed", receipt=receipt
                    )
                receipt = self._advance_receipt(
                    receipt, "evidence_preserved"
                )
            except (OSError, _StateFault, _PublicationAmbiguous):
                return self._failure_result(
                    "evidence_preservation_failed", receipt=receipt
                )
            phase = "evidence_preserved"
        if phase == "evidence_preserved":
            try:
                evidence = self._read_named_evidence(evidence_leaf)
            except _StateFault:
                evidence = None
            if evidence is None:
                return self._failure_result(
                    "evidence_preservation_failed", receipt=receipt
                )
            try:
                if primary_raw == evidence:
                    self._atomic_bytes("", previous_raw)
                elif primary_raw != previous_raw:
                    return self._failure_result(
                        "publication_ambiguous", receipt=receipt
                    )
                receipt = self._advance_receipt(receipt, "restored")
            except (OSError, _StateFault, _PublicationAmbiguous):
                return self._failure_result(
                    "publication_ambiguous", receipt=receipt
                )
            phase = "restored"
        if phase == "restored":
            current = self._read_leaf_with_identity("")
            retained = self._read_leaf(".previous")
            if current is None or current[0] != previous_raw or retained != previous_raw:
                return self._failure_result(
                    "publication_ambiguous", receipt=receipt
                )
            payload = {
                key: value for key, value in previous.items() if key != "_controllerState"
            }
            return self._make_load_result(
                "recovered",
                payload,
                store_id=marker["storeId"],
                generation=previous["_controllerState"]["generation"],
                marker_generation=marker["highWaterGeneration"],
                primary_identity=current[1],
                kind="reconciliation",
                receipt=receipt,
            )
        return self._failure_result("publication_ambiguous", receipt=receipt)

    def _read_named_private(self, leaf: str) -> bytes | None:
        if (
            Path(leaf).name != leaf
            or (
                not _EVIDENCE_LEAF.fullmatch(leaf)
                and not (
                    leaf.startswith(f".{self._name}.")
                    and leaf.endswith(".reconciliation-journal.tmp")
                )
            )
        ):
            raise _StateFault("unsafe_file")
        try:
            first = self._ops.open(
                leaf,
                os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW,
                dir_fd=self._directory_fd,
            )
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise _StateFault("unsafe_file") from exc
        try:
            observed = self._ops.fstat(first)
            if not self._safe_file_stat(observed):
                raise _StateFault("unsafe_file")
            chunks = []
            while chunk := self._ops.read(first, 1024 * 1024):
                chunks.append(chunk)
            return b"".join(chunks)
        except OSError as exc:
            raise _StateFault("read_failed") from exc
        finally:
            self._close_checked(first)

    def _read_named_evidence(self, leaf: str) -> bytes | None:
        return self._read_named_private(leaf)

    def _stage_reconciliation_journal(
        self, receipt: Mapping[str, Any], journal: Mapping[str, Any]
    ) -> str:
        leaf = self._reconciliation_stage_leaf(receipt)
        encoded = _canonical_bytes(journal)
        existing = self._read_named_private(leaf)
        if existing is not None:
            if existing != encoded:
                raise _StateFault("publication_ambiguous")
            return leaf
        fd = -1
        try:
            fd = self._ops.open(
                leaf,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=self._directory_fd,
            )
            observed = self._ops.fstat(fd)
            if not self._safe_file_stat(observed):
                raise OSError(errno.EPERM, "unsafe reconciliation journal")
            self._write_all(fd, encoded)
            self._ops.fsync_file(fd)
            self._close_checked(fd)
            fd = -1
            self._ops.fsync_directory(self._directory_fd)
            return leaf
        except OSError as exc:
            raise _StateFault("publication_ambiguous") from exc
        finally:
            if fd >= 0:
                self._close_quiet(fd)

    def _promote_reconciliation_journal(self, stage_leaf: str) -> None:
        try:
            self._ops.replace(
                stage_leaf,
                self._leaf(".transaction"),
                src_dir_fd=self._directory_fd,
                dst_dir_fd=self._directory_fd,
            )
            self._ops.fsync_directory(self._directory_fd)
        except OSError as exc:
            raise _PublicationAmbiguous() from exc

    def load(self) -> StateLoadResult:
        self._ensure_open()
        self._invalidate_capability()
        if self._startup_fault is not None:
            return self._failure_result(self._startup_fault)
        completed_reconciliation = False
        try:
            marker_raw = self._read_leaf(".initialized")
            primary_observed = self._read_leaf_with_identity("")
            previous_raw = self._read_leaf(".previous")
            journal_raw = self._read_leaf(".transaction")
            receipt_raw = self._read_leaf(".recovery")
            unmanaged_authority = self._has_unmanaged_authority_artifact()
        except _StateFault as exc:
            return self._failure_result(exc.reason)

        if marker_raw is None:
            if (
                primary_observed is None
                and previous_raw is None
                and journal_raw is None
                and receipt_raw is None
                and not unmanaged_authority
            ):
                return self._bootstrap_result()
            if (
                primary_observed is not None
                and previous_raw is None
                and journal_raw is None
                and receipt_raw is None
                and not unmanaged_authority
            ):
                try:
                    payload = self._legacy_payload(primary_observed[0])
                    return self._migrate(primary_observed[0], payload)
                except _StateFault as exc:
                    return self._failure_result(exc.reason)
                except (OSError, _PublicationAmbiguous):
                    return self._failure_result("publication_ambiguous")
            return self._failure_result("schema_incompatible")

        try:
            marker = _validate_marker(marker_raw, component=self._component)
        except _StateFault as exc:
            return self._failure_result(exc.reason)
        store_id = marker["storeId"]

        receipt: dict[str, Any] | None = None
        if receipt_raw is not None:
            try:
                receipt = _validate_receipt(
                    receipt_raw, component=self._component, store_id=store_id
                )
            except _StateFault as exc:
                return self._failure_result(exc.reason)

        if receipt is not None and receipt["phase"] == "reconciliation_prepared":
            try:
                receipt = self._increment_receipt(receipt)
            except (OSError, _StateFault, _PublicationAmbiguous):
                return self._failure_result(
                    "publication_ambiguous", receipt=receipt
                )

        journal: dict[str, Any] | None = None
        if journal_raw is not None:
            try:
                journal = _validate_journal(
                    journal_raw,
                    component=self._component,
                    store_id=store_id,
                    validator=self._validate_payload,
                )
            except _StateFault as exc:
                return self._failure_result(exc.reason, receipt=receipt)
            reconciliation_receipt = (
                receipt is not None
                and receipt["phase"] == "reconciliation_prepared"
            )
            if (journal["operation"] == "reconciliation") != reconciliation_receipt or (
                reconciliation_receipt
                and (
                    receipt["targetGeneration"] != journal["targetGeneration"]
                    or receipt["targetIntegritySha256"]
                    != journal["targetIntegritySha256"]
                )
            ):
                return self._failure_result(
                    "publication_ambiguous", receipt=receipt
                )
        elif receipt is not None and receipt["phase"] == "reconciliation_prepared":
            stage_leaf = self._reconciliation_stage_leaf(receipt)
            try:
                staged_raw = self._read_named_private(stage_leaf)
                if staged_raw is None:
                    return self._failure_result(
                        "publication_ambiguous", receipt=receipt
                    )
                journal = _validate_journal(
                    staged_raw,
                    component=self._component,
                    store_id=store_id,
                    validator=self._validate_payload,
                )
                if (
                    journal["operation"] != "reconciliation"
                    or receipt["targetGeneration"] != journal["targetGeneration"]
                    or receipt["targetIntegritySha256"]
                    != journal["targetIntegritySha256"]
                ):
                    return self._failure_result(
                        "generation_invalid", receipt=receipt
                    )
                self._promote_reconciliation_journal(stage_leaf)
            except (_StateFault, OSError, _PublicationAmbiguous) as exc:
                reason = (
                    exc.reason
                    if isinstance(exc, _StateFault)
                    else "publication_ambiguous"
                )
                return self._failure_result(reason, receipt=receipt)

        if journal is not None:
            try:
                marker = self._resume_transaction(journal, marker)
                primary_observed = self._read_leaf_with_identity("")
                previous_raw = self._read_leaf(".previous")
            except (_StateFault, OSError, _PublicationAmbiguous) as exc:
                reason = (
                    exc.reason if isinstance(exc, _StateFault) else "publication_ambiguous"
                )
                if reason not in {
                    "schema_incompatible",
                    "integrity_mismatch",
                    "generation_invalid",
                }:
                    reason = "publication_ambiguous"
                return self._failure_result(reason, receipt=receipt)

        if receipt is not None and receipt["phase"] == "reconciliation_prepared":
            if self._read_leaf(".transaction") is not None:
                return self._failure_result(
                    "publication_ambiguous", receipt=receipt
                )
            try:
                primary_raw = self._read_leaf("")
                assert primary_raw is not None
                _, target = _validate_envelope(
                    primary_raw,
                    component=self._component,
                    validator=self._validate_payload,
                    store_id=store_id,
                )
                target_meta = target["_controllerState"]
                if (
                    target_meta["generation"] != receipt["targetGeneration"]
                    or target_meta["integritySha256"]
                    != receipt["targetIntegritySha256"]
                    or marker["highWaterGeneration"] != receipt["targetGeneration"]
                    or marker["highWaterIntegritySha256"]
                    != receipt["targetIntegritySha256"]
                ):
                    return self._failure_result(
                        "generation_invalid", receipt=receipt
                    )
                receipt = self._advance_receipt(receipt, "reconciled")
                receipt_raw = _canonical_bytes(receipt)
                primary_observed = self._read_leaf_with_identity("")
                completed_reconciliation = True
            except (_StateFault, OSError, _PublicationAmbiguous):
                return self._failure_result("generation_invalid", receipt=receipt)

        if receipt is not None and receipt["phase"] in {
            "planned",
            "evidence_preserved",
            "restored",
        }:
            if previous_raw is None or primary_observed is None:
                return self._failure_result(
                    "publication_ambiguous", receipt=receipt
                )
            try:
                _, previous = _validate_envelope(
                    previous_raw,
                    component=self._component,
                    validator=self._validate_payload,
                    store_id=store_id,
                )
            except _StateFault as exc:
                return self._failure_result(exc.reason, receipt=receipt)
            if (
                previous["_controllerState"]["generation"]
                != receipt["recoveredGeneration"]
                or previous["_controllerState"]["integritySha256"]
                != receipt["recoveredIntegritySha256"]
                or marker["highWaterGeneration"]
                != receipt["markerHighWaterGeneration"]
                or marker["highWaterIntegritySha256"]
                != receipt["markerHighWaterIntegritySha256"]
            ):
                return self._failure_result("generation_invalid", receipt=receipt)
            return self._recover(
                marker=marker,
                primary_raw=primary_observed[0],
                previous=previous,
                reason=receipt["reason"],
                receipt=receipt,
            )

        if primary_observed is None:
            return self._failure_result("read_failed")
        primary_raw, primary_identity = primary_observed
        try:
            payload, primary = _validate_envelope(
                primary_raw,
                component=self._component,
                validator=self._validate_payload,
                store_id=store_id,
            )
        except _StateFault as primary_fault:
            if not primary_fault.recoverable or previous_raw is None:
                return self._failure_result(primary_fault.reason)
            try:
                _, previous = _validate_envelope(
                    previous_raw,
                    component=self._component,
                    validator=self._validate_payload,
                    store_id=store_id,
                )
            except _StateFault:
                return self._failure_result(primary_fault.reason)
            return self._recover(
                marker=marker,
                primary_raw=primary_raw,
                previous=previous,
                reason=primary_fault.reason,
            )
        metadata = primary["_controllerState"]
        if (
            metadata["generation"] != marker["highWaterGeneration"]
            or metadata["integritySha256"] != marker["highWaterIntegritySha256"]
        ):
            return self._failure_result(
                "generation_invalid",
                current=metadata["generation"],
                receipt=receipt,
            )
        if previous_raw is not None:
            try:
                _, retained = _validate_envelope(
                    previous_raw,
                    component=self._component,
                    validator=self._validate_payload,
                    store_id=store_id,
                )
            except _StateFault:
                retained = None
            if (
                retained is not None
                and retained["_controllerState"]["generation"]
                >= metadata["generation"]
            ):
                return self._failure_result(
                    "generation_invalid",
                    current=metadata["generation"],
                    receipt=receipt,
                )
        mode: StateMode = (
            "reconciled" if completed_reconciliation else "valid"
        )
        return self._make_load_result(
            mode,
            payload,
            store_id=store_id,
            generation=metadata["generation"],
            marker_generation=marker["highWaterGeneration"],
            primary_identity=primary_identity,
            kind="normal",
            receipt=receipt,
        )

    def reload(self) -> StateLoadResult:
        return self.load()

    def _validate_capability(
        self, capability: StateWriteCapability, kind: str
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        self._ensure_open()
        if (
            not isinstance(capability, StateWriteCapability)
            or capability is not self._active_capability
            or not capability._active
            or capability._session is not self
            or capability._component != self._component
            or capability._kind != kind
        ):
            raise self._required("generation_invalid")
        try:
            if kind == "bootstrap":
                if self._has_unmanaged_authority_artifact() or any(
                    self._read_leaf(suffix) is not None
                    for suffix in (
                        "",
                        ".previous",
                        ".initialized",
                        ".transaction",
                        ".recovery",
                    )
                ):
                    raise self._required("generation_invalid")
                return None, None
            marker_raw = self._read_leaf(".initialized")
            primary_observed = self._read_leaf_with_identity("")
        except _StateFault as exc:
            raise self._required(exc.reason) from exc
        if marker_raw is None or primary_observed is None:
            raise self._required("generation_invalid")
        try:
            marker = _validate_marker(marker_raw, component=self._component)
            _, primary = _validate_envelope(
                primary_observed[0],
                component=self._component,
                validator=self._validate_payload,
                store_id=marker["storeId"],
            )
        except _StateFault as exc:
            raise self._required(exc.reason) from exc
        metadata = primary["_controllerState"]
        if (
            marker["storeId"] != capability._store_id
            or metadata["storeId"] != capability._store_id
            or metadata["generation"] != capability._generation
            or marker["highWaterGeneration"] != capability._marker_generation
            or primary_observed[1] != capability._primary_identity
        ):
            raise self._required("generation_invalid")
        return marker, primary

    def _commit_transaction(
        self, journal: dict[str, Any], marker: dict[str, Any]
    ) -> dict[str, Any]:
        self._atomic_json(".transaction", journal)
        return self._resume_transaction(journal, marker)

    def save(
        self,
        payload: Mapping[str, Any],
        capability: StateWriteCapability,
    ) -> StateCommitResult:
        kind = (
            capability._kind
            if isinstance(capability, StateWriteCapability)
            else "normal"
        )
        if kind == "reconciliation":
            self._validate_capability(capability, "normal")
        expected_kind = "bootstrap" if kind == "bootstrap" else "normal"
        marker, primary = self._validate_capability(capability, expected_kind)
        validated = _validate_payload_copy(payload, self._validate_payload)
        try:
            if expected_kind == "bootstrap":
                store_id = self._random_hex()
                previous = _make_envelope(
                    _validate_payload_copy(
                        self._bootstrap(), self._validate_payload
                    ),
                    component=self._component,
                    store_id=store_id,
                    generation=0,
                    clock=self._clock,
                )
                target_generation = 1
                previous_meta = previous["_controllerState"]
                marker = self._marker_for(
                    store_id, 0, previous_meta["integritySha256"]
                )
                self._atomic_json(".initialized", marker)
                operation = "bootstrap"
                expected_generation = None
                expected_integrity = None
            else:
                assert marker is not None and primary is not None
                current_meta = primary["_controllerState"]
                if current_meta["generation"] >= MAX_GENERATION:
                    raise _StateFault("generation_invalid")
                store_id = marker["storeId"]
                previous = primary
                target_generation = current_meta["generation"] + 1
                operation = "normal"
                expected_generation = current_meta["generation"]
                expected_integrity = current_meta["integritySha256"]
                previous_raw = self._read_leaf(".previous")
                if previous_raw is not None:
                    try:
                        _, retained = _validate_envelope(
                            previous_raw,
                            component=self._component,
                            validator=self._validate_payload,
                            store_id=store_id,
                        )
                    except _StateFault:
                        try:
                            self._preserve_evidence(
                                previous_raw,
                                self._random_hex()
                                + ".controller-state-evidence",
                            )
                        except BaseException as exc:
                            raise _StateFault(
                                "evidence_preservation_failed"
                            ) from exc
                    else:
                        if (
                            retained["_controllerState"]["generation"]
                            >= current_meta["generation"]
                        ):
                            raise _StateFault("generation_invalid")
            target = _make_envelope(
                validated,
                component=self._component,
                store_id=store_id,
                generation=target_generation,
                clock=self._clock,
            )
            assert marker is not None
            journal = self._journal_for(
                operation=operation,
                previous=previous,
                target=target,
                expected_generation=expected_generation,
                expected_integrity=expected_integrity,
                expected_highwater_generation=marker["highWaterGeneration"],
                expected_highwater_integrity=marker[
                    "highWaterIntegritySha256"
                ],
            )
            marker = self._commit_transaction(journal, marker)
        except _StateFault as exc:
            raise ControllerStateRequired(
                self._diagnostic(
                    "recovery_required",
                    reason=exc.reason,
                    count=1,
                )
            ) from exc
        except OSError as exc:
            raise ControllerStateRequired(
                self._diagnostic(
                    "recovery_required",
                    reason="publication_ambiguous",
                    count=1,
                )
            ) from exc
        self._invalidate_capability()
        observed = self._read_leaf_with_identity("")
        assert observed is not None
        new_capability = self._new_capability(
            store_id=store_id,
            generation=target_generation,
            marker_generation=marker["highWaterGeneration"],
            primary_identity=observed[1],
            kind="normal",
        )
        diagnostic = self._diagnostic(
            "valid", current=target_generation, count=0
        )
        return StateCommitResult(
            "valid", target_generation, new_capability, diagnostic
        )

    def complete_reconciliation(
        self,
        payload: Mapping[str, Any],
        capability: StateWriteCapability,
        *,
        outcome: RecoveryOutcome,
    ) -> StateCommitResult:
        marker, primary = self._validate_capability(
            capability, "reconciliation"
        )
        if outcome not in {
            "validated_previous_only",
            "authoritative_reconciliation",
        }:
            raise ValueError("unknown controller state reconciliation outcome")
        validated = _validate_payload_copy(payload, self._validate_payload)
        assert marker is not None and primary is not None
        try:
            receipt_raw = self._read_leaf(".recovery")
            if receipt_raw is None:
                raise _StateFault("generation_invalid")
            receipt = _validate_receipt(
                receipt_raw,
                component=self._component,
                store_id=marker["storeId"],
            )
            if receipt["phase"] not in {
                "restored",
                "reconciliation_prepared",
            }:
                raise _StateFault("generation_invalid")
            if marker["highWaterGeneration"] >= MAX_GENERATION:
                raise _StateFault("generation_invalid")
            target_generation = marker["highWaterGeneration"] + 1
            primary_meta = primary["_controllerState"]
            stage_leaf = self._reconciliation_stage_leaf(receipt)
            staged_raw = self._read_named_private(stage_leaf)
            if staged_raw is None:
                if receipt["phase"] != "restored":
                    raise _StateFault("publication_ambiguous")
                target = _make_envelope(
                    validated,
                    component=self._component,
                    store_id=marker["storeId"],
                    generation=target_generation,
                    clock=self._clock,
                )
                journal = self._journal_for(
                    operation="reconciliation",
                    previous=primary,
                    target=target,
                    expected_generation=primary_meta["generation"],
                    expected_integrity=primary_meta["integritySha256"],
                    expected_highwater_generation=marker["highWaterGeneration"],
                    expected_highwater_integrity=marker[
                        "highWaterIntegritySha256"
                    ],
                )
                stage_leaf = self._stage_reconciliation_journal(
                    receipt, journal
                )
            else:
                journal = _validate_journal(
                    staged_raw,
                    component=self._component,
                    store_id=marker["storeId"],
                    validator=self._validate_payload,
                )
                target_payload = {
                    key: value
                    for key, value in journal["targetEnvelope"].items()
                    if key != "_controllerState"
                }
                if target_payload != validated:
                    raise _StateFault("generation_invalid")
            target_meta = journal["targetEnvelope"]["_controllerState"]
            if (
                journal["operation"] != "reconciliation"
                or journal["previousEnvelope"] != primary
                or journal["targetGeneration"] != target_generation
                or (
                    receipt["phase"] == "reconciliation_prepared"
                    and (
                        receipt["targetGeneration"] != target_generation
                        or receipt["targetIntegritySha256"]
                        != target_meta["integritySha256"]
                    )
                )
            ):
                raise _StateFault("generation_invalid")
            if receipt["phase"] == "restored":
                receipt = self._advance_receipt(
                    receipt,
                    "reconciliation_prepared",
                    targetGeneration=target_generation,
                    targetIntegritySha256=target_meta["integritySha256"],
                )
            self._promote_reconciliation_journal(stage_leaf)
            marker = self._resume_transaction(journal, marker)
            receipt = self._advance_receipt(receipt, "reconciled")
        except _StateFault as exc:
            raise ControllerStateRequired(
                self._diagnostic(
                    "recovery_required",
                    current=capability._generation,
                    recovered=capability._generation,
                    reason=exc.reason,
                    receipt=(
                        receipt.get("recoveryReceiptId")
                        if "receipt" in locals()
                        else None
                    ),
                    count=(
                        receipt.get("occurrenceCount", 1)
                        if "receipt" in locals()
                        else 1
                    ),
                )
            ) from exc
        except OSError as exc:
            raise ControllerStateRequired(
                self._diagnostic(
                    "recovery_required",
                    reason="publication_ambiguous",
                    count=1,
                )
            ) from exc
        self._invalidate_capability()
        observed = self._read_leaf_with_identity("")
        assert observed is not None
        new_capability = self._new_capability(
            store_id=marker["storeId"],
            generation=target_generation,
            marker_generation=marker["highWaterGeneration"],
            primary_identity=observed[1],
            kind="normal",
        )
        diagnostic = self._diagnostic(
            "reconciled",
            current=target_generation,
            recovered=receipt["recoveredGeneration"],
            receipt=receipt["recoveryReceiptId"],
            count=receipt["occurrenceCount"],
        )
        return StateCommitResult(
            "reconciled", target_generation, new_capability, diagnostic
        )

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._invalidate_capability()
        if self._lock_fd >= 0:
            try:
                self._ops.flock(self._lock_fd, fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                self._ops.close(self._lock_fd)
            except OSError:
                try:
                    os.close(self._lock_fd)
                except OSError:
                    pass
            self._lock_fd = -1
        if self._directory_fd >= 0:
            try:
                self._ops.close(self._directory_fd)
            except OSError:
                try:
                    os.close(self._directory_fd)
                except OSError:
                    pass
            self._directory_fd = -1


def open_controller_state(
    path: Path,
    *,
    component: StateComponent,
    bootstrap: Callable[[], dict[str, Any]],
    validate_payload: Callable[[Mapping[str, Any]], dict[str, Any]],
    lock_timeout_seconds: float,
    clock: Callable[[], datetime] | None = None,
    random_bytes: Callable[[int], bytes] | None = None,
    file_ops: Any | None = None,
) -> ControllerStateSession:
    if component not in _COMPONENTS:
        raise ValueError("unknown controller state component")
    return ControllerStateSession(
        Path(path),
        component=component,
        bootstrap=bootstrap,
        validate_payload=validate_payload,
        lock_timeout_seconds=lock_timeout_seconds,
        clock=clock or (lambda: datetime.now(timezone.utc)),
        random_bytes=random_bytes or secrets.token_bytes,
        file_ops=file_ops or _RealFileOps(),
    )


def read_controller_state(
    path: Path,
    *,
    component: StateComponent,
    validate_payload: Callable[[Mapping[str, Any]], dict[str, Any]],
    lock_timeout_seconds: float,
    file_ops: Any | None = None,
) -> StateReadResult:
    if component not in _COMPONENTS:
        raise ValueError("unknown controller state component")
    placeholder = lambda: {}
    try:
        session = ControllerStateSession(
            Path(path),
            component=component,
            bootstrap=placeholder,
            validate_payload=validate_payload,
            lock_timeout_seconds=lock_timeout_seconds,
            clock=lambda: datetime.now(timezone.utc),
            random_bytes=secrets.token_bytes,
            file_ops=file_ops or _RealFileOps(),
            shared_lock=True,
        )
    except ControllerStateRequired as exc:
        return StateReadResult("unavailable", None, None, exc.diagnostic.reason)
    try:
        if session._startup_fault is not None:
            return StateReadResult(
                "unavailable", None, None, session._startup_fault
            )
        marker_raw = session._read_leaf(".initialized")
        primary = session._read_leaf("")
        previous = session._read_leaf(".previous")
        journal = session._read_leaf(".transaction")
        receipt_raw = session._read_leaf(".recovery")
        unmanaged_authority = session._has_unmanaged_authority_artifact()
        if marker_raw is None:
            if (
                primary is not None
                and previous is None
                and journal is None
                and receipt_raw is None
                and not unmanaged_authority
            ):
                try:
                    payload = session._legacy_payload(primary)
                except _StateFault as exc:
                    return StateReadResult("unavailable", None, None, exc.reason)
                return StateReadResult("legacy_valid", payload, None, None)
            return StateReadResult("unavailable", None, None, "read_failed")
        marker = _validate_marker(marker_raw, component=component)
        if journal is not None:
            return StateReadResult(
                "unavailable", None, None, "publication_ambiguous"
            )
        if receipt_raw is not None:
            receipt = _validate_receipt(
                receipt_raw,
                component=component,
                store_id=marker["storeId"],
            )
            if receipt["phase"] != "reconciled":
                return StateReadResult(
                    "recovery_pending", None, None, receipt["reason"]
                )
        if primary is None:
            return StateReadResult("unavailable", None, None, "read_failed")
        payload, document = _validate_envelope(
            primary,
            component=component,
            validator=validate_payload,
            store_id=marker["storeId"],
        )
        metadata = document["_controllerState"]
        if (
            metadata["generation"] != marker["highWaterGeneration"]
            or metadata["integritySha256"] != marker["highWaterIntegritySha256"]
        ):
            return StateReadResult(
                "unavailable", None, None, "generation_invalid"
            )
        return StateReadResult("valid", payload, metadata["generation"], None)
    except _StateFault as exc:
        return StateReadResult("unavailable", None, None, exc.reason)
    finally:
        session.close()


def state_diagnostic_details(diagnostic: StateDiagnostic) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "component": diagnostic.component,
        "stateMode": diagnostic.mode,
        "reason": diagnostic.reason,
        "currentGeneration": diagnostic.current_generation,
        "recoveredGeneration": diagnostic.recovered_generation,
        "recoveryReceiptId": diagnostic.recovery_receipt_id,
        "occurrenceCount": min(
            MAX_OCCURRENCE_COUNT, max(0, diagnostic.occurrence_count)
        ),
    }


def emit_state_recovery_fallback(diagnostic: StateDiagnostic) -> None:
    global _FALLBACK_EMITTED
    if _FALLBACK_EMITTED:
        return
    _FALLBACK_EMITTED = True
    try:
        encoded = _canonical_bytes(state_diagnostic_details(diagnostic)) + b"\n"
        os.write(2, encoded[:4096])
    except OSError:
        pass
