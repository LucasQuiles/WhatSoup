"""Private, non-emitting normalization of BOT ERRORS submission receipts.

This module deliberately has no sender or stateful integration. Its input is
an immutable request plus an observation from one native pipeline, and its
output states only what that observation proves. Neither pipeline proves that
the remediation agent accepted the incident.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import re
from typing import Literal


_HEX_256 = re.compile(r"^[0-9a-f]{64}$")
_SIGNAL_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_MONITOR_DISPOSITIONS = frozenset({"accepted", "duplicate", "policy_suppressed", "rejected", "unknown"})
_MONITOR_RETAINED_DISPOSITIONS = frozenset({"accepted", "policy_suppressed", "rejected", "unknown"})
_NOTIFICATION_STATES = frozenset({"pending", "api_accepted", "failed", "unknown"})
_SIGNAL_DISPOSITIONS = frozenset({
    "incident_opened",
    "incident_updated",
    "incident_resolved",
    "heartbeat_recorded",
    "notice_recorded",
    "stored_no_state_change",
    "stored_stale_observation",
    "stored_quarantined_observation",
})


def _nonempty_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _plain_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _nullable_positive_int(value: object) -> bool:
    return value is None or (_plain_int(value) and value > 0)


@dataclass(frozen=True)
class MonitorSubmissionRequest:
    """The immutable R83 identity and content digest expected by the caller."""

    source: str
    event_id: str
    generation: str
    payload_sha256: str
    kind: Literal["signal", "clear"]
    expected_transport_host: str | None = None

    def __post_init__(self) -> None:
        if not _nonempty_text(self.source):
            raise ValueError("source must be non-empty text")
        if not _nonempty_text(self.event_id):
            raise ValueError("event_id must be non-empty text")
        if not _nonempty_text(self.generation):
            raise ValueError("generation must be non-empty text")
        if not isinstance(self.payload_sha256, str) or _HEX_256.fullmatch(self.payload_sha256) is None:
            raise ValueError("payload_sha256 must be a lowercase SHA-256 hex digest")
        if self.kind not in {"signal", "clear"}:
            raise ValueError("kind must be signal or clear")
        if self.expected_transport_host is not None and not _nonempty_text(self.expected_transport_host):
            raise ValueError("expected_transport_host must be non-empty text or None")


@dataclass(frozen=True)
class SignalSubmissionRequest:
    """The immutable WhatSoup source/event identity and exact-byte digest."""

    producer_id: str
    signal_id: str
    payload_digest: str

    def __post_init__(self) -> None:
        if not _nonempty_text(self.producer_id):
            raise ValueError("producer_id must be non-empty text")
        if not _nonempty_text(self.signal_id):
            raise ValueError("signal_id must be non-empty text")
        if not isinstance(self.payload_digest, str) or _SIGNAL_DIGEST.fullmatch(self.payload_digest) is None:
            raise ValueError("payload_digest must be a sha256:<lowercase hex> digest")


@dataclass(frozen=True)
class SubmissionResult:
    """Common projection while retaining each pipeline's native identities."""

    schema: Literal["bot-errors-submission-result/1"]
    pipeline: Literal["r83-monitor", "whatsoup-signals"]
    disposition: Literal["accepted", "duplicate", "policy_suppressed", "rejected", "unknown"]
    durably_accepted: bool | None
    native_source: str
    native_event: str
    generation: str | None
    payload_digest: str
    transport_stage: str
    native_state: str | None
    native_disposition: str | None
    outer_disposition: str | None
    expected_transport_host: str | None
    observed_transport_host: str | None
    target_binding: Literal["verified", "prohibited"]
    remediation_acceptance: Literal["unknown"] = "unknown"
    notification_state: str | None = None
    policy: str | None = None
    receipt_event_id: int | None = None
    reason: str | None = None


def _monitor_result(
    expected: MonitorSubmissionRequest,
    disposition: Literal["accepted", "duplicate", "policy_suppressed", "rejected", "unknown"],
    durable: bool | None,
    stage: str,
    *,
    notification_state: str | None = None,
    policy: str | None = None,
    native_state: str | None = None,
    native_disposition: str | None = None,
    outer_disposition: str | None = None,
    observed_transport_host: str | None = None,
    reason: str | None = None,
) -> SubmissionResult:
    target_binding: Literal["verified", "prohibited"] = "prohibited"
    if expected.expected_transport_host is not None and observed_transport_host == expected.expected_transport_host:
        target_binding = "verified"
    return SubmissionResult(
        schema="bot-errors-submission-result/1",
        pipeline="r83-monitor",
        disposition=disposition,
        durably_accepted=durable,
        native_source=expected.source,
        native_event=expected.event_id,
        generation=expected.generation,
        payload_digest=expected.payload_sha256,
        transport_stage=stage,
        native_state=native_state,
        native_disposition=native_disposition,
        outer_disposition=outer_disposition,
        expected_transport_host=expected.expected_transport_host,
        observed_transport_host=observed_transport_host,
        target_binding=target_binding,
        notification_state=notification_state,
        policy=policy,
        reason=reason,
    )


def _signal_result(
    expected: SignalSubmissionRequest,
    disposition: Literal["accepted", "duplicate", "policy_suppressed", "rejected", "unknown"],
    durable: bool | None,
    stage: str,
    *,
    receipt_event_id: int | None = None,
    native_disposition: str | None = None,
    reason: str | None = None,
) -> SubmissionResult:
    return SubmissionResult(
        schema="bot-errors-submission-result/1",
        pipeline="whatsoup-signals",
        disposition=disposition,
        durably_accepted=durable,
        native_source=expected.producer_id,
        native_event=expected.signal_id,
        generation=None,
        payload_digest=expected.payload_digest,
        transport_stage=stage,
        native_state=None,
        native_disposition=native_disposition,
        outer_disposition=None,
        expected_transport_host=None,
        observed_transport_host=None,
        target_binding="prohibited",
        receipt_event_id=receipt_event_id,
        reason=reason,
    )


def _monitor_stage(exit_code: object) -> str:
    if not _plain_int(exit_code):
        return "process_exit_unknown"
    return "process_exit_0" if exit_code == 0 else "process_exit_nonzero"


def _validated_retained_monitor_receipt(
    expected: MonitorSubmissionRequest,
    receipt: Mapping[str, object] | object | None,
) -> tuple[Mapping[str, object] | None, str | None]:
    if receipt is None:
        return None, "retained_receipt_missing"
    if not isinstance(receipt, Mapping):
        return None, "retained_receipt_not_object"
    if receipt.get("schema") != "monitor-submission-receipt/1":
        return None, "retained_schema_mismatch"
    if receipt.get("source") != expected.source:
        return None, "retained_source_mismatch"
    if receipt.get("event_id") != expected.event_id:
        return None, "retained_event_id_mismatch"
    if receipt.get("generation") != expected.generation:
        return None, "retained_generation_mismatch"
    if receipt.get("kind") != expected.kind:
        return None, "retained_kind_mismatch"
    payload_digest = receipt.get("payload_sha256")
    if not _nonempty_text(payload_digest):
        return None, "retained_payload_digest_missing"
    if payload_digest != expected.payload_sha256:
        return None, "retained_payload_digest_mismatch"
    if receipt.get("state") != "retained":
        return None, "retained_state_mismatch"
    disposition = receipt.get("disposition")
    if not isinstance(disposition, str) or disposition not in _MONITOR_RETAINED_DISPOSITIONS:
        return None, "invalid_retained_disposition"
    notification_state = receipt.get("notification_state")
    if not isinstance(notification_state, str) or notification_state not in _NOTIFICATION_STATES:
        return None, "invalid_retained_notification_state"
    if not _nonempty_text(receipt.get("reason")):
        return None, "invalid_retained_reason"
    expected_obligation = "transferred" if disposition == "accepted" else "pending"
    if receipt.get("caller_obligation") != expected_obligation:
        return None, "retained_caller_obligation_mismatch"
    if not _nonempty_text(receipt.get("created_at")) or not _nonempty_text(receipt.get("updated_at")):
        return None, "invalid_retained_timestamps"
    return receipt, None


def normalize_monitor_submission(
    expected: MonitorSubmissionRequest,
    outer_receipt: Mapping[str, object] | object,
    *,
    retained_receipt: Mapping[str, object] | object | None = None,
    observed_transport_host: str | None = None,
    policy_name: str | None = None,
) -> SubmissionResult:
    """Project an R83 result only when its retained receipt binds the payload.

    The current monitor-submission/1 outer result supplies process outcome and
    identity but intentionally has no digest.  A separate native retained
    monitor-submission-receipt/1 is required to bind the immutable request.
    """
    if not isinstance(expected, MonitorSubmissionRequest):
        raise TypeError("expected must be MonitorSubmissionRequest")
    if not isinstance(observed_transport_host, (str, type(None))) or (
        isinstance(observed_transport_host, str) and not observed_transport_host.strip()
    ):
        return _monitor_result(expected, "unknown", None, "process_exit_unknown", reason="invalid_transport_host")
    if expected.expected_transport_host is not None:
        if not _nonempty_text(observed_transport_host):
            return _monitor_result(expected, "unknown", None, "process_exit_unknown", observed_transport_host=observed_transport_host, reason="transport_host_missing")
        if observed_transport_host != expected.expected_transport_host:
            return _monitor_result(expected, "unknown", None, "process_exit_unknown", observed_transport_host=observed_transport_host, reason="transport_host_mismatch")
    if not isinstance(outer_receipt, Mapping):
        return _monitor_result(expected, "unknown", None, "process_exit_unknown", observed_transport_host=observed_transport_host, reason="outer_receipt_not_object")
    if outer_receipt.get("schema") != "monitor-submission/1":
        return _monitor_result(expected, "unknown", None, "process_exit_unknown", observed_transport_host=observed_transport_host, reason="schema_mismatch")
    if outer_receipt.get("source") != expected.source:
        return _monitor_result(expected, "unknown", None, "process_exit_unknown", observed_transport_host=observed_transport_host, reason="source_mismatch")
    if outer_receipt.get("event_id") != expected.event_id:
        return _monitor_result(expected, "unknown", None, "process_exit_unknown", observed_transport_host=observed_transport_host, reason="event_id_mismatch")
    if outer_receipt.get("generation") != expected.generation:
        return _monitor_result(expected, "unknown", None, "process_exit_unknown", observed_transport_host=observed_transport_host, reason="generation_mismatch")
    outer_disposition = outer_receipt.get("disposition")
    if not isinstance(outer_disposition, str) or outer_disposition not in _MONITOR_DISPOSITIONS:
        return _monitor_result(expected, "unknown", None, "process_exit_unknown", observed_transport_host=observed_transport_host, reason="invalid_disposition")
    notification_state = outer_receipt.get("notification_state")
    if not isinstance(notification_state, str) or notification_state not in _NOTIFICATION_STATES:
        return _monitor_result(expected, "unknown", None, "process_exit_unknown", observed_transport_host=observed_transport_host, outer_disposition=outer_disposition, reason="invalid_notification_state")
    if not _nonempty_text(outer_receipt.get("reason")):
        return _monitor_result(expected, "unknown", None, "process_exit_unknown", observed_transport_host=observed_transport_host, outer_disposition=outer_disposition, reason="invalid_reason")
    if "exit_code" not in outer_receipt:
        return _monitor_result(expected, "unknown", None, "process_exit_unknown", observed_transport_host=observed_transport_host, outer_disposition=outer_disposition, reason="exit_receipt_missing")
    exit_code = outer_receipt.get("exit_code")
    stage = _monitor_stage(exit_code)
    if not _plain_int(exit_code):
        return _monitor_result(expected, "unknown", None, stage, observed_transport_host=observed_transport_host, outer_disposition=outer_disposition, reason="invalid_exit_code")

    retained, retained_error = _validated_retained_monitor_receipt(expected, retained_receipt)
    if retained_error is not None:
        return _monitor_result(expected, "unknown", None, stage, observed_transport_host=observed_transport_host, outer_disposition=outer_disposition, reason=retained_error)
    assert retained is not None
    retained_disposition = retained["disposition"]
    assert isinstance(retained_disposition, str)
    expected_retained_disposition = "accepted" if outer_disposition == "duplicate" else outer_disposition
    if retained_disposition != expected_retained_disposition:
        return _monitor_result(expected, "unknown", None, stage, observed_transport_host=observed_transport_host, native_state="retained", native_disposition=retained_disposition, outer_disposition=outer_disposition, reason="outer_retained_disposition_mismatch")
    if retained.get("notification_state") != notification_state:
        return _monitor_result(expected, "unknown", None, stage, observed_transport_host=observed_transport_host, native_state="retained", native_disposition=retained_disposition, outer_disposition=outer_disposition, reason="outer_retained_notification_state_mismatch")
    if exit_code != 0 and outer_disposition in {"accepted", "duplicate"}:
        return _monitor_result(expected, "unknown", None, stage, notification_state=notification_state, observed_transport_host=observed_transport_host, native_state="retained", native_disposition=retained_disposition, outer_disposition=outer_disposition, reason="nonzero_exit_contradicts_durable_receipt")
    if outer_disposition == "accepted":
        return _monitor_result(expected, "accepted", True, stage, notification_state=notification_state, observed_transport_host=observed_transport_host, native_state="retained", native_disposition=retained_disposition, outer_disposition=outer_disposition)
    if outer_disposition == "duplicate":
        return _monitor_result(expected, "duplicate", True, stage, notification_state=notification_state, observed_transport_host=observed_transport_host, native_state="retained", native_disposition=retained_disposition, outer_disposition=outer_disposition)
    if outer_disposition == "policy_suppressed":
        if not _nonempty_text(policy_name):
            return _monitor_result(expected, "unknown", None, stage, notification_state=notification_state, observed_transport_host=observed_transport_host, native_state="retained", native_disposition=retained_disposition, outer_disposition=outer_disposition, reason="missing_policy")
        return _monitor_result(expected, "policy_suppressed", False, stage, notification_state=notification_state, policy=policy_name, observed_transport_host=observed_transport_host, native_state="retained", native_disposition=retained_disposition, outer_disposition=outer_disposition)
    if outer_disposition == "rejected":
        return _monitor_result(expected, "rejected", False, stage, notification_state=notification_state, observed_transport_host=observed_transport_host, native_state="retained", native_disposition=retained_disposition, outer_disposition=outer_disposition)
    return _monitor_result(expected, "unknown", None, stage, notification_state=notification_state, observed_transport_host=observed_transport_host, native_state="retained", native_disposition=retained_disposition, outer_disposition=outer_disposition)


def _signal_stage(http_status: object, idempotent_replay: object) -> str:
    if not _plain_int(http_status):
        return "http_unknown"
    if http_status == 201 and idempotent_replay is False:
        return "http_201_created"
    if http_status == 200 and idempotent_replay is True:
        return "http_200_idempotent_replay"
    if http_status == 409 and idempotent_replay is False:
        return "http_409_identity_conflict"
    return f"http_{http_status}_ambiguous"


def _validate_signal_receipt(expected: SignalSubmissionRequest, receipt: Mapping[str, object]) -> tuple[int | None, str | None]:
    """Return the route-assigned event id or the first deterministic failure."""
    if not _plain_int(receipt.get("schemaVersion")) or receipt.get("schemaVersion") != 1:
        return None, "schema_version_mismatch"
    event_id = receipt.get("eventId")
    if not _plain_int(event_id) or event_id <= 0:
        return None, "invalid_receipt_event_id"
    if receipt.get("producerId") != expected.producer_id:
        return None, "producer_id_mismatch"
    if receipt.get("signalId") != expected.signal_id:
        return None, "signal_id_mismatch"
    payload_digest = receipt.get("payloadDigest")
    if not _nonempty_text(payload_digest):
        return None, "payload_digest_missing"
    if payload_digest != expected.payload_digest:
        return None, "payload_digest_mismatch"
    if receipt.get("receiptId") != f"rcpt-{event_id}":
        return None, "receipt_id_mismatch"
    if not _nonempty_text(receipt.get("receivedAt")):
        return None, "invalid_received_at"
    disposition = receipt.get("disposition")
    if not isinstance(disposition, str) or disposition not in _SIGNAL_DISPOSITIONS:
        return None, "invalid_signal_disposition"
    if not _nullable_positive_int(receipt.get("incidentId")):
        return None, "invalid_incident_id"
    if not _nullable_positive_int(receipt.get("transitionId")):
        return None, "invalid_transition_id"
    return event_id, None


def normalize_signal_submission(
    expected: SignalSubmissionRequest,
    receipt: Mapping[str, object] | None | object,
    *,
    http_status: int,
    idempotent_replay: bool,
    error_code: str | None = None,
) -> SubmissionResult:
    """Project an observed WhatSoup response without inventing remediation-agent state."""
    if not isinstance(expected, SignalSubmissionRequest):
        raise TypeError("expected must be SignalSubmissionRequest")
    stage = _signal_stage(http_status, idempotent_replay)
    if not _plain_int(http_status):
        return _signal_result(expected, "unknown", None, stage, reason="invalid_http_status")
    if not isinstance(idempotent_replay, bool):
        return _signal_result(expected, "unknown", None, stage, reason="invalid_idempotent_replay_flag")
    if http_status == 409 and idempotent_replay is False:
        if receipt is not None:
            return _signal_result(expected, "unknown", None, stage, reason="unexpected_receipt_for_identity_conflict")
        if error_code != "signal_identity_conflict":
            return _signal_result(expected, "unknown", None, stage, reason="unexpected_identity_conflict_error")
        return _signal_result(expected, "rejected", False, stage, reason="signal_identity_conflict")
    if not ((http_status == 201 and idempotent_replay is False) or (http_status == 200 and idempotent_replay is True)):
        return _signal_result(expected, "unknown", None, stage, reason="ambiguous_http_status_or_replay_flag")
    if not isinstance(receipt, Mapping):
        return _signal_result(expected, "unknown", None, stage, reason="receipt_not_object")
    event_id, invalid_reason = _validate_signal_receipt(expected, receipt)
    if invalid_reason is not None:
        return _signal_result(expected, "unknown", None, stage, reason=invalid_reason)
    assert event_id is not None
    native_disposition = receipt["disposition"]
    assert isinstance(native_disposition, str)
    if http_status == 201:
        return _signal_result(expected, "accepted", True, stage, receipt_event_id=event_id, native_disposition=native_disposition)
    return _signal_result(expected, "duplicate", True, stage, receipt_event_id=event_id, native_disposition=native_disposition)
