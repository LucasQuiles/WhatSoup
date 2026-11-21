"""Conformance controls for the private BOT ERRORS submission adapter."""

from __future__ import annotations

import sys
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest


_SCRIPTS = Path(__file__).resolve().parents[1]
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from lib import bot_errors_submission as submission


def test_submission_adapter_exposes_the_two_native_normalizers() -> None:
    assert callable(getattr(submission, "normalize_monitor_submission", None))
    assert callable(getattr(submission, "normalize_signal_submission", None))


def _monitor_request(**changes: object):
    request: dict[str, object] = {
        "source": "queue-monitor",
        "event_id": "event-001",
        "generation": "generation-001",
        "payload_sha256": "a" * 64,
        "kind": "signal",
        "expected_transport_host": "host-a",
    }
    request.update(changes)
    return submission.MonitorSubmissionRequest(**request)


def _monitor_outer(**changes: object) -> dict[str, object]:
    receipt: dict[str, object] = {
        "schema": "monitor-submission/1",
        "source": "queue-monitor",
        "event_id": "event-001",
        "generation": "generation-001",
        "disposition": "accepted",
        "notification_state": "api_accepted",
        "reason": "native event retained",
        "exit_code": 0,
    }
    receipt.update(changes)
    return receipt


def _monitor_retained(**changes: object) -> dict[str, object]:
    disposition = changes.get("disposition", "accepted")
    receipt: dict[str, object] = {
        "schema": "monitor-submission-receipt/1",
        "source": "queue-monitor",
        "event_id": "event-001",
        "generation": "generation-001",
        "kind": "signal",
        "payload_sha256": "a" * 64,
        "state": "retained",
        "disposition": disposition,
        "notification_state": "api_accepted",
        "reason": "native event retained",
        "caller_obligation": "transferred" if disposition == "accepted" else "pending",
        "created_at": "2026-10-12T18:18:00Z",
        "updated_at": "2026-10-12T18:18:01Z",
    }
    receipt.update(changes)
    return receipt


def _signal_request():
    return submission.SignalSubmissionRequest(
        producer_id="producer-host-a",
        signal_id="signal-001",
        payload_digest="sha256:" + "b" * 64,
    )


def _signal_receipt(**changes: object) -> dict[str, object]:
    receipt: dict[str, object] = {
        "schemaVersion": 1,
        "eventId": 17,
        "producerId": "producer-host-a",
        "signalId": "signal-001",
        "payloadDigest": "sha256:" + "b" * 64,
        "receivedAt": "2026-10-12T18:18:00.000Z",
        "disposition": "stored_no_state_change",
        "incidentId": None,
        "transitionId": None,
        "receiptId": "rcpt-17",
    }
    receipt.update(changes)
    return receipt


def test_monitor_acceptance_requires_bound_retained_receipt_and_never_remediation_acceptance() -> None:
    expected = _monitor_request()
    result = submission.normalize_monitor_submission(
        expected,
        _monitor_outer(),
        retained_receipt=_monitor_retained(),
        observed_transport_host="host-a",
    )

    assert result.disposition == "accepted"
    assert result.durably_accepted is True
    assert result.transport_stage == "process_exit_0"
    assert result.remediation_acceptance == "unknown"
    assert result.native_source == expected.source
    assert result.native_event == expected.event_id
    assert result.generation == expected.generation
    assert result.native_state == "retained"
    assert result.native_disposition == "accepted"
    assert result.target_binding == "verified"


def test_monitor_request_is_immutable_and_retained_payload_digest_is_identity_bound() -> None:
    expected = _monitor_request()
    with pytest.raises(FrozenInstanceError):
        expected.payload_sha256 = "c" * 64  # type: ignore[misc]

    result = submission.normalize_monitor_submission(
        expected,
        _monitor_outer(),
        retained_receipt=_monitor_retained(payload_sha256="c" * 64),
        observed_transport_host="host-a",
    )

    assert result.disposition == "unknown"
    assert result.reason == "retained_payload_digest_mismatch"


def test_monitor_requires_explicit_transport_host_and_rejects_wrong_host() -> None:
    expected = _monitor_request()
    wrong_host = submission.normalize_monitor_submission(
        expected,
        _monitor_outer(),
        retained_receipt=_monitor_retained(),
        observed_transport_host="host-b",
    )
    unknown_host = submission.normalize_monitor_submission(
        _monitor_request(expected_transport_host=None),
        _monitor_outer(),
        retained_receipt=_monitor_retained(),
        observed_transport_host=None,
    )
    blank_host = submission.normalize_monitor_submission(
        _monitor_request(expected_transport_host=None),
        _monitor_outer(),
        retained_receipt=_monitor_retained(),
        observed_transport_host="",
    )

    assert wrong_host.disposition == "unknown"
    assert wrong_host.reason == "transport_host_mismatch"
    assert wrong_host.target_binding == "prohibited"
    assert unknown_host.disposition == "accepted"
    assert unknown_host.observed_transport_host is None
    assert unknown_host.target_binding == "prohibited"
    assert blank_host.disposition == "unknown"
    assert blank_host.reason == "invalid_transport_host"


def test_monitor_rejects_wrong_native_source_event_and_old_generation() -> None:
    wrong_source = submission.normalize_monitor_submission(
        _monitor_request(),
        _monitor_outer(source="other-monitor"),
        retained_receipt=_monitor_retained(),
        observed_transport_host="host-a",
    )
    wrong_event = submission.normalize_monitor_submission(
        _monitor_request(),
        _monitor_outer(),
        retained_receipt=_monitor_retained(event_id="event-002"),
        observed_transport_host="host-a",
    )
    old_generation = submission.normalize_monitor_submission(
        _monitor_request(),
        _monitor_outer(generation="generation-000"),
        retained_receipt=_monitor_retained(generation="generation-000"),
        observed_transport_host="host-a",
    )

    assert wrong_source.reason == "source_mismatch"
    assert wrong_event.reason == "retained_event_id_mismatch"
    assert old_generation.reason == "generation_mismatch"
    assert old_generation.generation == "generation-001"


def test_monitor_duplicate_requires_retained_accepted_and_named_policy_is_external_context() -> None:
    duplicate = submission.normalize_monitor_submission(
        _monitor_request(),
        _monitor_outer(disposition="duplicate", reason="event identity is already retained"),
        retained_receipt=_monitor_retained(),
        observed_transport_host="host-a",
    )
    malformed_duplicate = submission.normalize_monitor_submission(
        _monitor_request(),
        _monitor_outer(disposition="duplicate", reason="event identity is already retained"),
        retained_receipt=_monitor_retained(disposition="unknown", notification_state="unknown"),
        observed_transport_host="host-a",
    )
    suppressed = submission.normalize_monitor_submission(
        _monitor_request(),
        _monitor_outer(disposition="policy_suppressed", notification_state="unknown"),
        retained_receipt=_monitor_retained(disposition="policy_suppressed", notification_state="unknown"),
        observed_transport_host="host-a",
        policy_name="maintenance-window",
    )

    assert duplicate.disposition == "duplicate"
    assert duplicate.native_disposition == "accepted"
    assert malformed_duplicate.disposition == "unknown"
    assert malformed_duplicate.reason == "outer_retained_disposition_mismatch"
    assert suppressed.disposition == "policy_suppressed"
    assert suppressed.policy == "maintenance-window"


def test_monitor_nonzero_exit_and_outer_without_retained_receipt_fail_closed() -> None:
    nonzero = submission.normalize_monitor_submission(
        _monitor_request(),
        _monitor_outer(exit_code=1),
        retained_receipt=_monitor_retained(),
        observed_transport_host="host-a",
    )
    outer_only = submission.normalize_monitor_submission(
        _monitor_request(),
        _monitor_outer(),
        observed_transport_host="host-a",
    )

    assert nonzero.disposition == "unknown"
    assert nonzero.reason == "nonzero_exit_contradicts_durable_receipt"
    assert nonzero.transport_stage == "process_exit_nonzero"
    assert outer_only.disposition == "unknown"
    assert outer_only.reason == "retained_receipt_missing"


def test_monitor_stale_unknown_and_rejected_retained_receipts_never_confirm_acceptance() -> None:
    stale_unknown = submission.normalize_monitor_submission(
        _monitor_request(),
        _monitor_outer(disposition="unknown", notification_state="unknown"),
        retained_receipt=_monitor_retained(generation="generation-000", disposition="unknown", notification_state="unknown"),
        observed_transport_host="host-a",
    )
    rejected = submission.normalize_monitor_submission(
        _monitor_request(),
        _monitor_outer(disposition="rejected", notification_state="unknown"),
        retained_receipt=_monitor_retained(disposition="rejected", notification_state="unknown"),
        observed_transport_host="host-a",
    )

    assert stale_unknown.disposition == "unknown"
    assert stale_unknown.reason == "retained_generation_mismatch"
    assert rejected.disposition == "rejected"
    assert rejected.native_state == "retained"
    assert rejected.native_disposition == "rejected"


def test_signal_accepted_receipt_projects_durable_acceptance_without_remediation_acceptance() -> None:
    expected = _signal_request()
    result = submission.normalize_signal_submission(
        expected,
        _signal_receipt(),
        http_status=201,
        idempotent_replay=False,
    )

    assert result.disposition == "accepted"
    assert result.durably_accepted is True
    assert result.transport_stage == "http_201_created"
    assert result.remediation_acceptance == "unknown"
    assert result.native_source == expected.producer_id
    assert result.native_event == expected.signal_id
    assert result.receipt_event_id == 17


def test_signal_idempotent_replay_maps_to_duplicate() -> None:
    result = submission.normalize_signal_submission(
        _signal_request(),
        _signal_receipt(),
        http_status=200,
        idempotent_replay=True,
    )

    assert result.disposition == "duplicate"
    assert result.durably_accepted is True
    assert result.transport_stage == "http_200_idempotent_replay"


def test_signal_same_identity_changed_payload_maps_only_the_native_conflict_to_rejected() -> None:
    expected = _signal_request()
    changed = submission.SignalSubmissionRequest(
        producer_id=expected.producer_id,
        signal_id=expected.signal_id,
        payload_digest="sha256:" + "c" * 64,
    )
    result = submission.normalize_signal_submission(
        changed,
        None,
        http_status=409,
        idempotent_replay=False,
        error_code="signal_identity_conflict",
    )

    assert result.disposition == "rejected"
    assert result.durably_accepted is False
    assert result.reason == "signal_identity_conflict"
    assert result.remediation_acceptance == "unknown"


def test_signal_wrong_producer_and_event_identity_fail_closed() -> None:
    wrong_producer = submission.normalize_signal_submission(
        _signal_request(),
        _signal_receipt(producerId="producer-host-b"),
        http_status=201,
        idempotent_replay=False,
    )
    wrong_event = submission.normalize_signal_submission(
        _signal_request(),
        _signal_receipt(signalId="signal-002"),
        http_status=201,
        idempotent_replay=False,
    )

    assert wrong_producer.disposition == "unknown"
    assert wrong_producer.reason == "producer_id_mismatch"
    assert wrong_event.disposition == "unknown"
    assert wrong_event.reason == "signal_id_mismatch"


def test_signal_malformed_replay_flag_and_ambiguous_http_cannot_confirm_acceptance() -> None:
    malformed = submission.normalize_signal_submission(
        _signal_request(),
        _signal_receipt(),
        http_status=201,
        idempotent_replay="false",  # type: ignore[arg-type]
    )
    ambiguous = submission.normalize_signal_submission(
        _signal_request(),
        _signal_receipt(),
        http_status=200,
        idempotent_replay=False,
    )

    assert malformed.disposition == "unknown"
    assert malformed.reason == "invalid_idempotent_replay_flag"
    assert ambiguous.disposition == "unknown"
    assert ambiguous.reason == "ambiguous_http_status_or_replay_flag"


def test_signal_nested_malformed_receipt_fields_fail_closed_without_raising() -> None:
    malformed_disposition = submission.normalize_signal_submission(
        _signal_request(),
        _signal_receipt(disposition=[]),
        http_status=201,
        idempotent_replay=False,
    )
    malformed_incident = submission.normalize_signal_submission(
        _signal_request(),
        _signal_receipt(incidentId={"id": 17}),
        http_status=201,
        idempotent_replay=False,
    )
    malformed_transition = submission.normalize_signal_submission(
        _signal_request(),
        _signal_receipt(transitionId=[]),
        http_status=201,
        idempotent_replay=False,
    )

    assert malformed_disposition.disposition == "unknown"
    assert malformed_disposition.reason == "invalid_signal_disposition"
    assert malformed_incident.disposition == "unknown"
    assert malformed_incident.reason == "invalid_incident_id"
    assert malformed_transition.disposition == "unknown"
    assert malformed_transition.reason == "invalid_transition_id"


def test_signal_stored_state_and_quarantine_are_native_durable_acceptance_not_suppression() -> None:
    stored = submission.normalize_signal_submission(
        _signal_request(),
        _signal_receipt(disposition="stored_no_state_change"),
        http_status=201,
        idempotent_replay=False,
    )
    quarantined = submission.normalize_signal_submission(
        _signal_request(),
        _signal_receipt(disposition="stored_quarantined_observation"),
        http_status=201,
        idempotent_replay=False,
    )

    assert stored.disposition == "accepted"
    assert quarantined.disposition == "accepted"
    assert stored.native_disposition == "stored_no_state_change"
    assert quarantined.native_disposition == "stored_quarantined_observation"
    assert stored.policy is None
    assert quarantined.policy is None
