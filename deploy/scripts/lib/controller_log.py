"""Versioned, content-free correlation and failure policy for controller JSONL."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from functools import wraps
import json
import re
import threading
import time as time_module
from typing import Any, TypeVar
import uuid


CONTROLLER_LOG_SCHEMA_VERSION = 1
CONTROLLER_LOG_DETAILS_MAX_BYTES = 16_384
CONTROLLER_LOG_HEALTH_MAX_BYTES = 4_096

CONTROLLER_COMPONENTS = frozenset(
    {
        "collector",
        "dispatcher",
        "heartbeat_watchdog",
        "q_loop",
        "deadman",
    }
)
CONTROLLER_LEVELS = frozenset({"debug", "info", "warning", "error"})
CONTROLLER_OUTCOMES = frozenset(
    {"observed", "started", "completed", "failed", "suppressed", "recovered"}
)
CONTROLLER_DURABILITY_CLASSES = frozenset({"diagnostic_best_effort"})

_RECORD_KIND_RE = re.compile(r"^[a-z][a-z0-9_]{0,95}$")
_OPAQUE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_DETAIL_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,95}$")
_SAFE_DETAIL_STRING_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$")
_RECOVERY_RECEIPT_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_CONTROLLER_STATE_MODES = frozenset(
    {
        "bootstrap",
        "valid",
        "recovered",
        "reconciled",
        "recovery_required",
    }
)
_CONTROLLER_STATE_REASONS = frozenset(
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
        "retention_exhausted",
    }
)
_SAFE_DETAIL_STRING_VALUES = frozenset(
    {
        "1_64",
        "65_256",
        "257_1024",
        "active",
        "blocked",
        "bounded_unverified_autoclose_cap_reached",
        "completed",
        "decode_error",
        "degraded",
        "empty",
        "failed",
        "healthy",
        "inactive",
        "invalid_value",
        "locked",
        "missing",
        "observed",
        "open",
        "os_error",
        "over_1024",
        "participant",
        "permission_denied",
        "q",
        "recovered",
        "resolved",
        "root",
        "schema",
        "sent",
        "session_limit",
        "started",
        "suppressed",
        "tailscale_offline",
        "timeout",
        "unexpected_error",
        "unknown",
    }
)
_SENSITIVE_DETAIL_KEY_PARTS = (
    "account",
    "argv",
    "body",
    "command",
    "credential",
    "cwd",
    "destination",
    "error",
    "eventid",
    "evidence",
    "host",
    "incidentkey",
    "instance",
    "jid",
    "machine",
    "message",
    "path",
    "problem",
    "reason",
    "remote",
    "sender",
    "source",
    "text",
    "token",
)
_SAFE_BOOLEAN_DETAIL_KEYS = frozenset({"remoteAckDegraded"})
_SAFE_DERIVED_DETAIL_KEYS = frozenset({"bodyLengthBucket", "reason"}).union(
    _SAFE_BOOLEAN_DETAIL_KEYS
)

_CORE_FIELDS = frozenset(
    {
        "schemaVersion",
        "observedAt",
        "time",
        "component",
        "recordKind",
        "type",
        "level",
        "outcome",
        "runId",
        "cycleId",
        "sequence",
        "durabilityClass",
        "details",
    }
)

_R = TypeVar("_R")


def _default_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _default_id() -> str:
    return uuid.uuid4().hex


def _validate_opaque_id(value: str, field: str) -> str:
    if not isinstance(value, str) or not _OPAQUE_ID_RE.fullmatch(value):
        raise ValueError(f"controller log {field} must be a bounded opaque identifier")
    return value


def _validate_observed_at(value: str) -> str:
    from datetime import datetime

    if not isinstance(value, str):
        raise ValueError("controller log observedAt must be canonical UTC")
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as exc:
        raise ValueError("controller log observedAt must be canonical UTC") from exc
    return value


def _json_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError("controller log value must be JSON serializable") from exc


def _validate_details(details: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(details, Mapping):
        raise ValueError("controller log details must be an object")
    normalized: dict[str, Any] = {}
    for key, value in details.items():
        if not isinstance(key, str) or not _DETAIL_KEY_RE.fullmatch(key):
            raise ValueError("controller log detail keys must be bounded identifiers")
        if key in _CORE_FIELDS:
            raise ValueError(f"controller log details cannot shadow reserved field {key}")
        normalized[key] = value
    if len(_json_bytes(normalized)) > CONTROLLER_LOG_DETAILS_MAX_BYTES:
        raise ValueError("controller log details exceed the durable size bound")
    return normalized


def metadata_only_controller_details(value: Mapping[str, Any]) -> dict[str, Any]:
    """Project controller diagnostics to bounded counts, booleans, and enums."""

    def project(item: Any, *, depth: int) -> Any:
        if depth > 3:
            return None
        if item is None or isinstance(item, bool):
            return item
        if isinstance(item, int) and not isinstance(item, bool):
            return max(-(2**53 - 1), min(2**53 - 1, item))
        if isinstance(item, float):
            return item if item == item and abs(item) != float("inf") else None
        if isinstance(item, str):
            return (
                item
                if _SAFE_DETAIL_STRING_RE.fullmatch(item)
                and item in _SAFE_DETAIL_STRING_VALUES
                else None
            )
        if isinstance(item, Mapping):
            projected: dict[str, Any] = {}
            for key in sorted(item):
                if not isinstance(key, str) or not _DETAIL_KEY_RE.fullmatch(key):
                    continue
                if key == "component":
                    continue
                if key == "stateMode":
                    state_mode = item[key]
                    if (
                        isinstance(state_mode, str)
                        and state_mode in _CONTROLLER_STATE_MODES
                    ):
                        projected[key] = state_mode
                    continue
                if key == "reason":
                    reason = item[key]
                    if (
                        isinstance(reason, str)
                        and (
                            reason in _SAFE_DETAIL_STRING_VALUES
                            or reason in _CONTROLLER_STATE_REASONS
                        )
                    ):
                        projected[key] = reason
                    continue
                if key == "recoveryReceiptId":
                    receipt_id = item[key]
                    if (
                        isinstance(receipt_id, str)
                        and _RECOVERY_RECEIPT_ID_RE.fullmatch(receipt_id)
                    ):
                        projected[key] = receipt_id
                    continue
                if key in {"currentGeneration", "recoveredGeneration"}:
                    generation = item[key]
                    if generation is None or (
                        isinstance(generation, int)
                        and not isinstance(generation, bool)
                        and 0 <= generation <= 2**53 - 1
                    ):
                        projected[key] = generation
                    continue
                if key == "occurrenceCount":
                    count = item[key]
                    if (
                        isinstance(count, int)
                        and not isinstance(count, bool)
                        and 0 <= count <= 2**31 - 1
                    ):
                        projected[key] = count
                    continue
                if key == "stagingAttempt":
                    attempt = item[key]
                    if attempt is None or (
                        isinstance(attempt, int)
                        and not isinstance(attempt, bool)
                        and 1 <= attempt <= 8
                    ):
                        projected[key] = attempt
                    continue
                if key in {
                    "stagedRecordSha256",
                    "retainedReconciliationRecords",
                }:
                    continue
                if key in _SAFE_BOOLEAN_DETAIL_KEYS and not isinstance(item[key], bool):
                    continue
                folded = key.casefold().replace("-", "").replace("_", "")
                if (
                    key not in _SAFE_DERIVED_DETAIL_KEYS
                    and (
                        key.casefold().endswith("id")
                        or any(part in folded for part in _SENSITIVE_DETAIL_KEY_PARTS)
                    )
                ):
                    continue
                child = project(item[key], depth=depth + 1)
                if child is not None:
                    projected[key] = child
                if len(projected) == 64:
                    break
            return projected
        if isinstance(item, (list, tuple)):
            projected_list = []
            for child in item[:32]:
                projected_child = project(child, depth=depth + 1)
                if projected_child is not None:
                    projected_list.append(projected_child)
            return projected_list
        return None

    projected = project(value, depth=0)
    if not isinstance(projected, dict):
        raise ValueError("controller log metadata projection requires an object")
    if len(_json_bytes(projected)) > CONTROLLER_LOG_DETAILS_MAX_BYTES:
        raise ValueError("controller log metadata projection exceeds the size bound")
    return projected


class ControllerLogContext:
    """Process-local controller identity, cycle identity, and sequence state."""

    def __init__(
        self,
        component: str,
        *,
        now: Callable[[], str] = _default_now,
        id_factory: Callable[[], str] = _default_id,
    ) -> None:
        if component not in CONTROLLER_COMPONENTS:
            raise ValueError("controller log component is unknown")
        self.component = component
        self._now = now
        self._id_factory = id_factory
        self._lock = threading.Lock()
        self._run_id = _validate_opaque_id(id_factory(), "runId")
        self._cycle_id = _validate_opaque_id(id_factory(), "cycleId")
        self._sequence = 0
        self._consecutive_failures = 0
        self._dropped_records = 0
        self._last_successful_append_at: str | None = None

    @property
    def cycle_id(self) -> str:
        with self._lock:
            return self._cycle_id

    def begin_cycle(self) -> str:
        cycle_id = _validate_opaque_id(self._id_factory(), "cycleId")
        with self._lock:
            self._cycle_id = cycle_id
        return cycle_id

    def build_record(
        self,
        *,
        record_kind: str,
        level: str,
        outcome: str,
        durability_class: str,
        details: Mapping[str, Any],
    ) -> dict[str, Any]:
        if not isinstance(record_kind, str) or not _RECORD_KIND_RE.fullmatch(record_kind):
            raise ValueError("controller log record kind is unknown or unbounded")
        if level not in CONTROLLER_LEVELS:
            raise ValueError("controller log level is unknown")
        if outcome not in CONTROLLER_OUTCOMES:
            raise ValueError("controller log outcome is unknown")
        if durability_class not in CONTROLLER_DURABILITY_CLASSES:
            raise ValueError(
                "controller log durability class is unsupported; audit-critical records require an outbox"
            )
        normalized_details = _validate_details(details)
        observed_at = _validate_observed_at(self._now())
        with self._lock:
            self._sequence += 1
            sequence = self._sequence
            cycle_id = self._cycle_id
            run_id = self._run_id
        return {
            "schemaVersion": CONTROLLER_LOG_SCHEMA_VERSION,
            "observedAt": observed_at,
            "time": observed_at,
            "component": self.component,
            "recordKind": record_kind,
            "type": record_kind,
            "level": level,
            "outcome": outcome,
            "runId": run_id,
            "cycleId": cycle_id,
            "sequence": sequence,
            "durabilityClass": durability_class,
            "details": normalized_details,
        }

    def note_append_failure(
        self,
        *,
        record_kind: str,
        failure_class: str,
    ) -> tuple[dict[str, Any], bool]:
        with self._lock:
            self._consecutive_failures += 1
            self._dropped_records += 1
            consecutive = self._consecutive_failures
            health = {
                "schemaVersion": CONTROLLER_LOG_SCHEMA_VERSION,
                "component": self.component,
                "status": "degraded",
                "observedAt": self._now(),
                "failureClass": failure_class,
                "consecutiveFailures": consecutive,
                "droppedRecords": self._dropped_records,
                "lastSuccessfulAppendAt": self._last_successful_append_at,
                "lastFailedRecordKind": record_kind,
            }
        _validate_health_size(health)
        return health, consecutive == 1 or (consecutive & (consecutive - 1)) == 0

    def note_append_success(self) -> dict[str, Any] | None:
        observed_at = self._now()
        with self._lock:
            prior_failures = self._consecutive_failures
            self._last_successful_append_at = observed_at
            self._consecutive_failures = 0
            if prior_failures == 0:
                return None
            health = {
                "schemaVersion": CONTROLLER_LOG_SCHEMA_VERSION,
                "component": self.component,
                "status": "healthy",
                "observedAt": observed_at,
                "failureClass": None,
                "consecutiveFailures": 0,
                "droppedRecords": self._dropped_records,
                "lastSuccessfulAppendAt": observed_at,
                "lastFailedRecordKind": None,
            }
        _validate_health_size(health)
        return health


def _validate_health_size(health: Mapping[str, Any]) -> None:
    if len(_json_bytes(health)) > CONTROLLER_LOG_HEALTH_MAX_BYTES:
        raise ValueError("controller log health receipt exceeds its size bound")


def classify_controller_exception(error: BaseException) -> str:
    if isinstance(error, PermissionError):
        return "permission_denied"
    if isinstance(error, TimeoutError):
        return "timeout"
    if isinstance(error, BlockingIOError):
        return "locked"
    if isinstance(error, UnicodeError):
        return "decode_error"
    if isinstance(error, ValueError):
        return "invalid_value"
    if isinstance(error, OSError):
        return "os_error"
    return "unexpected_error"


def _fallback_line(
    context: ControllerLogContext,
    *,
    failure_class: str,
    consecutive_failures: int,
    health_state: str,
) -> str:
    return json.dumps(
        {
            "schemaVersion": CONTROLLER_LOG_SCHEMA_VERSION,
            "component": context.component,
            "controllerLog": "diagnostic_degraded",
            "failureClass": failure_class,
            "consecutiveFailures": consecutive_failures,
            "healthState": health_state,
        },
        separators=(",", ":"),
        sort_keys=True,
    )


def write_controller_log(
    *,
    context: ControllerLogContext,
    record_kind: str,
    level: str,
    outcome: str,
    durability_class: str,
    details: Mapping[str, Any],
    append_record: Callable[[dict[str, Any]], None],
    persist_health: Callable[[dict[str, Any]], None],
    emit_fallback: Callable[[str], None],
) -> str:
    record = context.build_record(
        record_kind=record_kind,
        level=level,
        outcome=outcome,
        durability_class=durability_class,
        details=details,
    )
    try:
        append_record(record)
    except Exception as exc:  # noqa: BLE001 - diagnostic failure may not replace domain truth.
        failure_class = classify_controller_exception(exc)
        health, should_emit = context.note_append_failure(
            record_kind=record_kind,
            failure_class=failure_class,
        )
        health_state = "degraded"
        try:
            persist_health(health)
        except Exception:  # noqa: BLE001 - stderr is the last bounded visibility path.
            health_state = "unavailable"
            should_emit = True
        if should_emit:
            emit_fallback(
                _fallback_line(
                    context,
                    failure_class=failure_class,
                    consecutive_failures=int(health["consecutiveFailures"]),
                    health_state=health_state,
                )
            )
        return "diagnostic_degraded"

    recovered = context.note_append_success()
    if recovered is not None:
        try:
            persist_health(recovered)
        except Exception as exc:  # noqa: BLE001 - the primary diagnostic append succeeded.
            emit_fallback(
                _fallback_line(
                    context,
                    failure_class=classify_controller_exception(exc),
                    consecutive_failures=0,
                    health_state="unavailable",
                )
            )
    return "written"


def _bounded_result_counters(result: Any) -> dict[str, int]:
    if not isinstance(result, Mapping):
        return {}
    counters: dict[str, int] = {}
    for key in sorted(result):
        value = result[key]
        if (
            isinstance(key, str)
            and _DETAIL_KEY_RE.fullmatch(key)
            and isinstance(value, int)
            and not isinstance(value, bool)
        ):
            counters[key] = max(-(2**53 - 1), min(2**53 - 1, value))
            if len(counters) == 32:
                break
    return counters


def controller_cycle(
    context: ControllerLogContext,
    emit: Callable[[str, dict[str, Any], str, str], None],
    *,
    monotonic_ns: Callable[[], int] = time_module.monotonic_ns,
) -> Callable[[Callable[..., _R]], Callable[..., _R]]:
    """Decorate one controller iteration without changing its domain result."""

    def decorate(function: Callable[..., _R]) -> Callable[..., _R]:
        @wraps(function)
        def wrapped(*args: Any, **kwargs: Any) -> _R:
            context.begin_cycle()
            started_ns = monotonic_ns()
            try:
                emit("cycle_started", {}, "info", "started")
            except Exception:
                pass
            try:
                result = function(*args, **kwargs)
            except Exception as exc:
                duration_ms = max(0, (monotonic_ns() - started_ns) // 1_000_000)
                try:
                    emit(
                        "cycle_failed",
                        {
                            "failureClass": classify_controller_exception(exc),
                            "durationMs": duration_ms,
                            "counters": {},
                        },
                        "error",
                        "failed",
                    )
                except Exception:
                    pass
                raise
            duration_ms = max(0, (monotonic_ns() - started_ns) // 1_000_000)
            try:
                emit(
                    "cycle_completed",
                    {
                        "durationMs": duration_ms,
                        "counters": _bounded_result_counters(result),
                    },
                    "info",
                    "completed",
                )
            except Exception:
                pass
            return result

        return wrapped

    return decorate


def parse_controller_log_record(raw: str) -> dict[str, Any]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("controller log record is invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise ValueError("controller log record root must be an object")
    if "schemaVersion" not in parsed and set(parsed) == _CORE_FIELDS - {"schemaVersion"}:
        raise ValueError("controller log v1-shaped record is missing schemaVersion")
    if parsed.get("schemaVersion") != CONTROLLER_LOG_SCHEMA_VERSION:
        return {"classification": "legacy_unversioned", "record": parsed}
    if set(parsed) != _CORE_FIELDS:
        raise ValueError("controller log v1 record has unknown or missing fields")
    observed_at = _validate_observed_at(parsed["observedAt"])
    if parsed["time"] != observed_at:
        raise ValueError("controller log v1 compatibility time must match observedAt")
    if parsed["component"] not in CONTROLLER_COMPONENTS:
        raise ValueError("controller log v1 component is unknown")
    record_kind = parsed["recordKind"]
    if not isinstance(record_kind, str) or not _RECORD_KIND_RE.fullmatch(record_kind):
        raise ValueError("controller log v1 record kind is unknown or unbounded")
    if parsed["type"] != record_kind:
        raise ValueError("controller log v1 compatibility type must match recordKind")
    if parsed["level"] not in CONTROLLER_LEVELS:
        raise ValueError("controller log v1 level is unknown")
    if parsed["outcome"] not in CONTROLLER_OUTCOMES:
        raise ValueError("controller log v1 outcome is unknown")
    _validate_opaque_id(parsed["runId"], "runId")
    _validate_opaque_id(parsed["cycleId"], "cycleId")
    sequence = parsed["sequence"]
    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1:
        raise ValueError("controller log v1 sequence must be a positive integer")
    if parsed["durabilityClass"] not in CONTROLLER_DURABILITY_CLASSES:
        raise ValueError("controller log v1 durability class is unsupported")
    _validate_details(parsed["details"])
    return {"classification": "v1", "record": parsed}
