from __future__ import annotations

import errno
import json
from pathlib import Path
import sys
import threading

import pytest

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_ROOT))

from lib.controller_log import (
    CONTROLLER_LOG_HEALTH_MAX_BYTES,
    ControllerLogContext,
    classify_controller_exception,
    controller_cycle,
    metadata_only_controller_details,
    parse_controller_log_record,
    write_controller_log,
)


COMPONENTS = (
    "collector",
    "dispatcher",
    "heartbeat_watchdog",
    "q_loop",
    "deadman",
)

CORE_FIELDS = {
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


def make_context(component: str = "dispatcher") -> ControllerLogContext:
    ids = iter(
        (
            f"{component}-run",
            f"{component}-bootstrap",
            f"{component}-cycle-a",
            f"{component}-cycle-b",
        )
    )
    return ControllerLogContext(
        component,
        now=lambda: "2026-07-28T12:00:00Z",
        id_factory=lambda: next(ids),
    )


def write_record(
    context: ControllerLogContext,
    *,
    append_record,
    persist_health=lambda _record: None,
    emit_fallback=lambda _line: None,
    record_kind: str = "synthetic_observation",
    details: dict | None = None,
):
    return write_controller_log(
        context=context,
        record_kind=record_kind,
        level="info",
        outcome="observed",
        durability_class="diagnostic_best_effort",
        details=details or {"count": 1},
        append_record=append_record,
        persist_health=persist_health,
        emit_fallback=emit_fallback,
    )


def test_all_components_emit_the_same_v1_envelope() -> None:
    observed = []
    for component in COMPONENTS:
        context = make_context(component)
        context.begin_cycle()
        captured = []
        result = write_record(context, append_record=captured.append)
        assert result == "written"
        assert len(captured) == 1
        observed.append(captured[0])

    assert all(set(record) == CORE_FIELDS for record in observed)
    for component, record in zip(COMPONENTS, observed, strict=True):
        assert record == {
            "schemaVersion": 1,
            "observedAt": "2026-07-28T12:00:00Z",
            "time": "2026-07-28T12:00:00Z",
            "component": component,
            "recordKind": "synthetic_observation",
            "type": "synthetic_observation",
            "level": "info",
            "outcome": "observed",
            "runId": f"{component}-run",
            "cycleId": f"{component}-cycle-a",
            "sequence": 1,
            "durabilityClass": "diagnostic_best_effort",
            "details": {"count": 1},
        }


@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("component", "unknown"),
        ("level", "fatal"),
        ("outcome", "maybe"),
        ("durability_class", "audit_critical"),
        ("record_kind", "contains spaces"),
        ("record_kind", "x" * 97),
    ),
)
def test_envelope_rejects_unknown_or_unbounded_values(field: str, value: str) -> None:
    kwargs = {
        "context": make_context(),
        "record_kind": "synthetic_observation",
        "level": "info",
        "outcome": "observed",
        "durability_class": "diagnostic_best_effort",
        "details": {"count": 1},
        "append_record": lambda _record: None,
        "persist_health": lambda _record: None,
        "emit_fallback": lambda _line: None,
    }
    if field == "component":
        with pytest.raises(ValueError, match="component"):
            make_context(value)
        return
    kwargs[field] = value
    with pytest.raises(ValueError):
        write_controller_log(**kwargs)


def test_envelope_rejects_reserved_detail_collisions_and_oversize_details() -> None:
    context = make_context()
    with pytest.raises(ValueError, match="reserved"):
        write_record(
            context,
            append_record=lambda _record: None,
            details={"component": "shadow"},
        )
    with pytest.raises(ValueError, match="size"):
        write_record(
            context,
            append_record=lambda _record: None,
            details={"bounded": "x" * 20_000},
        )


def test_sequence_is_unique_under_concurrent_writers() -> None:
    context = make_context()
    context.begin_cycle()
    captured = []
    capture_lock = threading.Lock()

    def append(record: dict) -> None:
        with capture_lock:
            captured.append(record)

    threads = [
        threading.Thread(target=lambda: write_record(context, append_record=append))
        for _ in range(32)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    sequences = sorted(record["sequence"] for record in captured)
    assert sequences == list(range(1, 33))
    assert len({record["runId"] for record in captured}) == 1
    assert len({record["cycleId"] for record in captured}) == 1


def test_append_failure_is_visible_bounded_and_does_not_raise() -> None:
    context = make_context()
    health = []
    fallback = []

    def fail_append(_record: dict) -> None:
        raise PermissionError("private path and payload must not survive")

    for _ in range(9):
        assert write_record(
            context,
            append_record=fail_append,
            persist_health=health.append,
            emit_fallback=fallback.append,
        ) == "diagnostic_degraded"

    assert len(health) == 9
    assert all(len(json.dumps(record).encode("utf-8")) <= CONTROLLER_LOG_HEALTH_MAX_BYTES for record in health)
    assert health[-1] == {
        "schemaVersion": 1,
        "component": "dispatcher",
        "status": "degraded",
        "observedAt": "2026-07-28T12:00:00Z",
        "failureClass": "permission_denied",
        "consecutiveFailures": 9,
        "droppedRecords": 9,
        "lastSuccessfulAppendAt": None,
        "lastFailedRecordKind": "synthetic_observation",
    }
    assert len(fallback) == 4
    assert all("private path" not in line and "payload" not in line for line in fallback)
    assert [json.loads(line)["consecutiveFailures"] for line in fallback] == [1, 2, 4, 8]


def test_success_after_failure_persists_one_recovery_receipt() -> None:
    context = make_context()
    health = []
    calls = 0

    def append(_record: dict) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("synthetic")

    assert write_record(context, append_record=append, persist_health=health.append) == "diagnostic_degraded"
    assert write_record(context, append_record=append, persist_health=health.append) == "written"
    assert write_record(context, append_record=append, persist_health=health.append) == "written"

    assert [record["status"] for record in health] == ["degraded", "healthy"]
    assert health[-1]["consecutiveFailures"] == 0
    assert health[-1]["droppedRecords"] == 1
    assert health[-1]["lastSuccessfulAppendAt"] == "2026-07-28T12:00:00Z"


def test_cycle_decorator_emits_exact_terminal_receipt_and_preserves_result() -> None:
    context = make_context()
    emitted = []
    ticks = iter((1_000_000_000, 1_007_000_000, 2_000_000_000, 2_011_000_000))

    def emit(kind: str, details: dict, level: str, outcome: str) -> None:
        emitted.append((kind, details, level, outcome, context.cycle_id))

    @controller_cycle(context, emit, monotonic_ns=lambda: next(ticks))
    def succeeds() -> dict:
        return {"processed": 3, "sent": 2, "unsafe": "omitted"}

    result = succeeds()
    assert result == {"processed": 3, "sent": 2, "unsafe": "omitted"}
    assert [entry[0] for entry in emitted] == ["cycle_started", "cycle_completed"]
    assert emitted[1][1] == {
        "durationMs": 7,
        "counters": {"processed": 3, "sent": 2},
    }
    assert emitted[0][4] == emitted[1][4] == "dispatcher-cycle-a"

    emitted.clear()

    @controller_cycle(context, emit, monotonic_ns=lambda: next(ticks))
    def fails() -> None:
        raise TimeoutError("private prose")

    with pytest.raises(TimeoutError, match="private prose"):
        fails()
    assert [entry[0] for entry in emitted] == ["cycle_started", "cycle_failed"]
    assert emitted[1][1] == {
        "failureClass": "timeout",
        "durationMs": 11,
        "counters": {},
    }
    assert emitted[0][4] == emitted[1][4] == "dispatcher-cycle-b"


@pytest.mark.parametrize(
    ("error", "expected"),
    (
        (PermissionError(), "permission_denied"),
        (TimeoutError(), "timeout"),
        (BlockingIOError(), "locked"),
        (UnicodeDecodeError("utf-8", b"x", 0, 1, "bad"), "decode_error"),
        (ValueError(), "invalid_value"),
        (OSError(), "os_error"),
        (RuntimeError(), "unexpected_error"),
    ),
)
def test_exception_classification_is_closed(error: Exception, expected: str) -> None:
    assert classify_controller_exception(error) == expected


def test_parser_marks_legacy_records_without_inventing_identity() -> None:
    legacy = parse_controller_log_record('{"time":"2026-07-28T12:00:00Z","type":"sent"}')
    assert legacy == {
        "classification": "legacy_unversioned",
        "record": {"time": "2026-07-28T12:00:00Z", "type": "sent"},
    }

    context = make_context()
    context.begin_cycle()
    captured = []
    write_record(context, append_record=captured.append)
    current = parse_controller_log_record(json.dumps(captured[0]))
    assert current["classification"] == "v1"
    assert current["record"]["runId"] == "dispatcher-run"


def test_restart_changes_run_identity_and_preserves_canonical_time() -> None:
    first = make_context()
    second_ids = iter(("dispatcher-restarted", "dispatcher-bootstrap"))
    second = ControllerLogContext(
        "dispatcher",
        now=lambda: "2026-07-28T12:00:01Z",
        id_factory=lambda: next(second_ids),
    )
    first_records = []
    second_records = []
    write_record(first, append_record=first_records.append)
    write_record(second, append_record=second_records.append)

    assert first_records[0]["runId"] != second_records[0]["runId"]
    assert second_records[0]["observedAt"] == "2026-07-28T12:00:01Z"
    assert second_records[0]["time"] == second_records[0]["observedAt"]


def test_parser_rejects_removal_or_mutation_of_each_owned_field() -> None:
    context = make_context()
    captured = []
    write_record(context, append_record=captured.append)
    record = captured[0]

    for field in CORE_FIELDS:
        mutated = dict(record)
        mutated.pop(field)
        with pytest.raises(ValueError):
            parse_controller_log_record(json.dumps(mutated))

    mutations = {
        "observedAt": "not-a-time",
        "time": "2026-07-28T12:00:01Z",
        "component": "unknown",
        "recordKind": "contains spaces",
        "type": "different",
        "level": "fatal",
        "outcome": "maybe",
        "runId": "contains spaces",
        "cycleId": "contains spaces",
        "sequence": 0,
        "durabilityClass": "audit_critical",
        "details": {"component": "shadow"},
    }
    for field, value in mutations.items():
        mutated = dict(record)
        mutated[field] = value
        with pytest.raises(ValueError):
            parse_controller_log_record(json.dumps(mutated))


@pytest.mark.parametrize(
    ("scenario", "error", "expected_class"),
    (
        ("disk_full", OSError(errno.ENOSPC, "private prose"), "os_error"),
        ("read_only", OSError(errno.EROFS, "private prose"), "os_error"),
        ("permission", PermissionError(errno.EACCES, "private prose"), "permission_denied"),
        ("unsafe_link", PermissionError(errno.EPERM, "private prose"), "permission_denied"),
        ("interrupted_rotation", InterruptedError(errno.EINTR, "private prose"), "os_error"),
        ("short_write", OSError(errno.EIO, "private prose"), "os_error"),
        ("fsync_failure", OSError(errno.EIO, "private prose"), "os_error"),
    ),
)
def test_storage_faults_share_one_bounded_diagnostic_policy(
    scenario: str,
    error: OSError,
    expected_class: str,
) -> None:
    context = make_context()
    health = []
    fallback = []

    def fail_append(_record: dict) -> None:
        raise error

    assert write_record(
        context,
        append_record=fail_append,
        persist_health=health.append,
        emit_fallback=fallback.append,
    ) == "diagnostic_degraded", scenario
    assert health[-1]["failureClass"] == expected_class
    assert health[-1]["status"] == "degraded"
    assert len(json.dumps(health[-1]).encode("utf-8")) <= CONTROLLER_LOG_HEALTH_MAX_BYTES
    assert "private prose" not in fallback[-1]


def test_metadata_projection_drops_identity_content_and_raw_prose() -> None:
    projected = metadata_only_controller_details(
        {
            "eventId": "event-private",
            "incident_key": "incident-private",
            "path": "/private/path",
            "error": "raw provider prose",
            "body": "message content",
            "remote": "private-host",
            "remoteAckDegraded": True,
            "count": 4,
            "attempts": 2,
            "status": "recovered",
            "harmless": "private-host-shaped-token",
            "nested": {
                "failed": 1,
                "message": "private",
                "verdict": "completed",
            },
            "unbounded": "x" * 200,
        }
    )
    assert projected == {
        "attempts": 2,
        "count": 4,
        "nested": {"failed": 1, "verdict": "completed"},
        "remoteAckDegraded": True,
        "status": "recovered",
    }
    assert "private-host-shaped-token" not in json.dumps(projected)


def test_metadata_projection_requires_boolean_remote_ack_degradation() -> None:
    assert metadata_only_controller_details({"remoteAckDegraded": "healthy"}) == {}


def test_metadata_projection_allowlists_only_closed_recovery_receipt_identity() -> None:
    receipt_id = "0123456789abcdef0123456789abcdef"
    assert metadata_only_controller_details(
        {
            "recoveryReceiptId": receipt_id,
            "eventId": receipt_id,
            "arbitraryId": receipt_id,
        }
    ) == {"recoveryReceiptId": receipt_id}


@pytest.mark.parametrize(
    "receipt_id",
    (
        "0123456789abcdef0123456789abcde",
        "0123456789abcdef0123456789abcdef0",
        "0123456789ABCDEF0123456789ABCDEF",
        "opaque_receipt_01",
    ),
)
def test_metadata_projection_rejects_noncanonical_recovery_receipt_identity(
    receipt_id: str,
) -> None:
    assert metadata_only_controller_details(
        {"recoveryReceiptId": receipt_id}
    ) == {}


@pytest.mark.parametrize(
    "state_mode",
    (
        "bootstrap",
        "valid",
        "recovered",
        "reconciled",
        "recovery_required",
    ),
)
def test_metadata_projection_allowlists_every_exact_controller_state_mode(
    state_mode: str,
) -> None:
    assert metadata_only_controller_details({"stateMode": state_mode}) == {
        "stateMode": state_mode
    }


@pytest.mark.parametrize(
    "reason",
    (
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
    ),
)
def test_metadata_projection_allowlists_every_exact_controller_state_reason(
    reason: str,
) -> None:
    assert metadata_only_controller_details({"reason": reason}) == {
        "reason": reason
    }


def test_controller_state_mode_record_projects_closed_details_end_to_end() -> None:
    context = make_context("collector")
    captured = []
    receipt_id = "0123456789abcdef0123456789abcdef"
    projected = metadata_only_controller_details(
        {
            "component": "collector",
            "stateMode": "recovery_required",
            "reason": "publication_ambiguous",
            "currentGeneration": 7,
            "recoveredGeneration": 6,
            "recoveryReceiptId": receipt_id,
            "occurrenceCount": 3,
        }
    )

    result = write_controller_log(
        context=context,
        record_kind="controller_state_mode",
        level="error",
        outcome="failed",
        durability_class="diagnostic_best_effort",
        details=projected,
        append_record=captured.append,
        persist_health=lambda _record: None,
        emit_fallback=lambda _line: None,
    )

    assert result == "written"
    assert len(captured) == 1
    assert captured[0]["component"] == "collector"
    assert captured[0]["details"] == {
        "currentGeneration": 7,
        "occurrenceCount": 3,
        "reason": "publication_ambiguous",
        "recoveredGeneration": 6,
        "recoveryReceiptId": receipt_id,
        "stateMode": "recovery_required",
    }
    assert "component" not in captured[0]["details"]


def test_metadata_projection_rejects_unknown_controller_state_enums() -> None:
    assert metadata_only_controller_details(
        {
            "stateMode": "future_mode",
            "reason": "future_reason",
            "occurrenceCount": 2,
        }
    ) == {"occurrenceCount": 2}


@pytest.mark.parametrize(
    ("key", "value"),
    (
        ("currentGeneration", -1),
        ("currentGeneration", 2**53),
        ("currentGeneration", True),
        ("recoveredGeneration", -1),
        ("recoveredGeneration", 2**53),
        ("occurrenceCount", -1),
        ("occurrenceCount", 2**31),
        ("occurrenceCount", False),
        ("stagingAttempt", 0),
        ("stagingAttempt", 9),
        ("stagingAttempt", True),
    ),
)
def test_metadata_projection_rejects_invalid_controller_state_numbers(
    key: str,
    value: object,
) -> None:
    assert metadata_only_controller_details({key: value}) == {}


def test_metadata_projection_accepts_only_bounded_controller_state_numbers() -> None:
    assert metadata_only_controller_details(
        {
            "currentGeneration": 2**53 - 1,
            "recoveredGeneration": 0,
            "occurrenceCount": 2**31 - 1,
            "stagingAttempt": 8,
        }
    ) == {
        "currentGeneration": 2**53 - 1,
        "occurrenceCount": 2**31 - 1,
        "recoveredGeneration": 0,
        "stagingAttempt": 8,
    }


def test_metadata_projection_drops_malicious_controller_state_values() -> None:
    canary = "/private/controller-state path with raw prose"
    assert metadata_only_controller_details(
        {
            "component": canary,
            "stateMode": canary,
            "reason": canary,
            "recoveryReceiptId": canary,
            "currentGeneration": canary,
            "recoveredGeneration": "9" * 10_000,
            "occurrenceCount": -(2**80),
            "stagingAttempt": canary,
        }
    ) == {}


def test_metadata_projection_never_leaks_record_names_digests_or_manifest() -> None:
    record_name = (
        ".state.json.0123456789abcdef0123456789abcdef.01.reconciliation-record"
    )
    assert metadata_only_controller_details(
        {
            "stagedRecordSha256": "a" * 64,
            "retainedReconciliationRecords": [
                {
                    "recoveryReceiptId": "0123456789abcdef0123456789abcdef",
                    "finalAttempt": 1,
                    "recordSha256": "a" * 64,
                }
            ],
            "recordName": record_name,
            "stagingAttempt": 2,
        }
    ) == {"stagingAttempt": 2}
