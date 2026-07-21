"""Pure normalization boundary for BOT ERRORS legacy and version-2 events."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
import re
from typing import Any


class ObservationState(str, Enum):
    FAULT = "fault"
    HEALTHY = "healthy"
    UNKNOWN = "unknown"


class ClearPolicyKind(str, Enum):
    SAME_SOURCE_NEWER = "same_source_newer"
    HEALTH_SNAPSHOT = "health_snapshot"
    OUTBOUND_AFTER_INCIDENT = "outbound_after_incident"
    AUTH_BOND_AND_OUTBOUND = "auth_bond_and_outbound"
    SOURCE_QUIET_AND_HEALTH = "source_quiet_and_health"
    MANUAL_ACK = "manual_ack"


class QuarantineReasonCode(str, Enum):
    EVENT_NOT_OBJECT = "event_not_object"
    UNSUPPORTED_SCHEMA_VERSION = "unsupported_schema_version"
    INVALID_EVENT_TYPE = "invalid_event_type"
    MISSING_INCIDENT_IDENTITY = "missing_incident_identity"
    INVALID_CREATED_AT = "invalid_created_at"
    INVALID_V2_OBSERVATION = "invalid_v2_observation"
    INVALID_V2_CLEAR_POLICY = "invalid_v2_clear_policy"
    INVALID_V2_REMEDIATION = "invalid_v2_remediation"


@dataclass(frozen=True)
class QuarantineReason:
    code: QuarantineReasonCode

    @property
    def receipt(self) -> str:
        return f"protocol:{self.code.value}"


@dataclass(frozen=True)
class NormalizedClearPolicy:
    kind: ClearPolicyKind
    minimum_schema_version: int
    proof_ref: str | None = None
    proof_observed_at: str | None = None
    proof_observed_at_epoch: int | None = None


@dataclass(frozen=True)
class NormalizedRemediation:
    recoverability: str
    requested_action: str
    authorization: str


@dataclass(frozen=True)
class NormalizedObservation:
    schema_version: int
    event_id: str
    event_type: str
    incident_key: str
    incident_source: str
    state: ObservationState
    observed_at: str
    observed_at_epoch: int
    confidence: str
    clear_policy: NormalizedClearPolicy
    remediation: NormalizedRemediation
    fingerprint: str | None = None
    producer_sequence: int | None = None
    target_incident_key: str | None = None
    requires_same_incident_key: bool = False
    requires_newer_observation: bool = False
    failure_code: str = ""
    classification: str = "standard"

    def clear_is_fresh_for(
        self,
        open_incident_key: str,
        opening_observed_at_epoch: int,
        clock_skew_tolerance_seconds: int,
    ) -> bool:
        if self.state is not ObservationState.HEALTHY:
            return False
        if self.requires_same_incident_key and open_incident_key != self.target_incident_key:
            return False
        if self.requires_newer_observation:
            return self.observed_at_epoch >= opening_observed_at_epoch - clock_skew_tolerance_seconds
        return True


_POLICY_STRENGTH = {
    ClearPolicyKind.SAME_SOURCE_NEWER: 0,
    ClearPolicyKind.HEALTH_SNAPSHOT: 1,
    ClearPolicyKind.SOURCE_QUIET_AND_HEALTH: 2,
    ClearPolicyKind.OUTBOUND_AFTER_INCIDENT: 3,
    ClearPolicyKind.AUTH_BOND_AND_OUTBOUND: 4,
    ClearPolicyKind.MANUAL_ACK: 5,
}
_CONFIDENCE = {"suspected", "probable", "confirmed"}
_RECOVERABILITY = {
    "auto_recoverable",
    "operator_recoverable",
    "manual_relink_required",
    "manual_repair_required",
    "unrecoverable",
    "unknown",
}
_AUTHORIZATION = {
    "automatic_read_only",
    "automatic_safe_retry",
    "owner_required",
    "physical_required",
}
_ACTION_RE = re.compile(r"^[a-z][a-z0-9_.:-]{0,127}$")
_FINGERPRINT_RE = re.compile(r"^[a-f0-9]{64}$")
_PROOF_REF_MAX_LENGTH = 512
_IDENTITY_FIELD_MAX_LENGTH = 256
_INCIDENT_KEY_MAX_LENGTH = 512
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_WEAK_AUTH_FAILURE_CODE = "WEAK_LOGGED_OUT_SIGNAL"
_TERMINAL_AUTH_FAILURE_CODE = "WA_AUTH_BOND_SERVER_REVOKED"
_AUTH_BOND_FAILURE_CODES = {
    "DEVICE_BOND_LOST",
    "WA_AUTH_BOND_LOCAL_CORRUPT_RESTORABLE",
    "WA_AUTH_BOND_LOCAL_CORRUPT_UNRESTORABLE",
    "WA_AUTH_BOND_LOCAL_INVALID",
    "WA_AUTH_BOND_LOCAL_MISSING_RESTORABLE",
    "WA_AUTH_BOND_LOCAL_MISSING_UNRESTORABLE",
    "WA_AUTH_BOND_LOCAL_REPAIR_VERIFIED",
    "WA_AUTH_BOND_PERMISSION_DRIFT",
    "WA_AUTH_BOND_RELINK_VERIFIED",
    "WA_AUTH_BOND_SERVER_REVOKED",
    "WA_AUTH_BOND_SNAPSHOT_CAPTURE_FAILED",
}


def stronger_clear_policy(
    first: ClearPolicyKind,
    second: ClearPolicyKind,
) -> ClearPolicyKind:
    """Return the stronger typed minimum without consulting free-form text."""
    return first if _POLICY_STRENGTH[first] >= _POLICY_STRENGTH[second] else second


def _reason(code: QuarantineReasonCode) -> QuarantineReason:
    return QuarantineReason(code)


def _bounded_identity(value: Any, limit: int = _IDENTITY_FIELD_MAX_LENGTH) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit


def _timestamp(value: Any) -> tuple[str, int] | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return raw, int(parsed.timestamp())


def _critical_failure(event: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    critical = event.get("criticalAsset")
    if not isinstance(critical, dict):
        return {}, {}
    asset = critical.get("asset")
    failure = critical.get("failure")
    return (
        asset if isinstance(asset, dict) else {},
        failure if isinstance(failure, dict) else {},
    )


def _has_structured_weak_auth_evidence(event: dict[str, Any]) -> bool:
    """Recognize the bounded contradictory diagnostic emitted by health-poller."""
    critical = event.get("criticalAsset")
    refs = critical.get("evidenceRefs") if isinstance(critical, dict) else None
    if not isinstance(refs, list) or len(refs) > 32:
        return False
    facts: dict[str, str] = {}
    for ref in refs:
        if not isinstance(ref, str) or len(ref) > 128 or ref.count("=") != 1:
            continue
        key, value = ref.split("=", 1)
        facts[key.strip()] = value.strip().lower()
    try:
        weak_polls = int(facts.get("weak_signal_polls", "-1"))
    except ValueError:
        return False
    return (
        facts.get("connected") == "false"
        and facts.get("state") == "connecting"
        and facts.get("disconnect_class") == "none"
        and facts.get("reconnect_phase") == "backoff"
        and facts.get("reconnect_attempts") == "0"
        and weak_polls >= 3
    )


def _recognized_critical_policy(
    event: dict[str, Any],
    *,
    is_logged_out_physical_signal: bool,
    is_verified_device_bond_lost_signal: bool,
) -> ClearPolicyKind:
    asset, failure = _critical_failure(event)
    code = str(failure.get("code") or "").strip().upper()
    if code == _WEAK_AUTH_FAILURE_CODE or _has_structured_weak_auth_evidence(event):
        return ClearPolicyKind.SAME_SOURCE_NEWER
    if code == _TERMINAL_AUTH_FAILURE_CODE and not (
        is_logged_out_physical_signal or is_verified_device_bond_lost_signal
    ):
        return ClearPolicyKind.SAME_SOURCE_NEWER
    if is_logged_out_physical_signal or is_verified_device_bond_lost_signal:
        return ClearPolicyKind.AUTH_BOND_AND_OUTBOUND
    if code in _AUTH_BOND_FAILURE_CODES:
        return ClearPolicyKind.AUTH_BOND_AND_OUTBOUND
    if code == "FLAP_STORM":
        return ClearPolicyKind.SOURCE_QUIET_AND_HEALTH
    if str(asset.get("kind") or "") == "bot_errors_delivery":
        return ClearPolicyKind.OUTBOUND_AFTER_INCIDENT
    return ClearPolicyKind.SAME_SOURCE_NEWER


def _legacy_remediation(
    event: dict[str, Any],
    state: ObservationState,
    *,
    is_logged_out_physical_signal: bool,
    is_verified_device_bond_lost_signal: bool,
) -> tuple[NormalizedRemediation, str, str, str]:
    _, failure = _critical_failure(event)
    failure_code = str(failure.get("code") or "").strip()
    if _has_structured_weak_auth_evidence(event) or failure_code == _WEAK_AUTH_FAILURE_CODE or (
        failure_code == _TERMINAL_AUTH_FAILURE_CODE
        and not (is_logged_out_physical_signal or is_verified_device_bond_lost_signal)
    ):
        return (
            NormalizedRemediation("auto_recoverable", "observe_recovery", "automatic_read_only"),
            _WEAK_AUTH_FAILURE_CODE,
            "probable",
            "inferred_transient",
        )
    if is_logged_out_physical_signal or is_verified_device_bond_lost_signal:
        return (
            NormalizedRemediation("manual_relink_required", "preserve_and_relink", "physical_required"),
            failure_code or _TERMINAL_AUTH_FAILURE_CODE,
            str(failure.get("confidence") or "confirmed"),
            "physical_intervention",
        )
    recoverability = str(failure.get("recoverability") or "unknown").strip()
    if recoverability not in _RECOVERABILITY:
        recoverability = "unknown"
    if recoverability in {"manual_repair_required", "unrecoverable"}:
        authorization = "owner_required"
    elif recoverability == "manual_relink_required":
        authorization = "physical_required"
    else:
        authorization = "automatic_read_only"
    confidence = str(failure.get("confidence") or "suspected").strip()
    if confidence not in _CONFIDENCE:
        confidence = "suspected"
    action = "observe_recovery" if state is ObservationState.HEALTHY else "observe_event"
    return (
        NormalizedRemediation(recoverability, action, authorization),
        failure_code,
        confidence,
        "standard",
    )


def normalize_observation(
    event: dict[str, Any],
    *,
    incident_key: str,
    incident_source: str,
    is_logged_out_physical_signal: bool = False,
    is_verified_device_bond_lost_signal: bool = False,
) -> NormalizedObservation | QuarantineReason:
    """Normalize one already-identified event without I/O or state mutation."""
    if not isinstance(event, dict):
        return _reason(QuarantineReasonCode.EVENT_NOT_OBJECT)

    raw_version = event.get("schemaVersion", 1)
    if type(raw_version) is not int or raw_version not in {1, 2}:
        return _reason(QuarantineReasonCode.UNSUPPORTED_SCHEMA_VERSION)
    schema_version = int(raw_version)

    event_type = event.get("eventType", "alert" if schema_version == 1 else None)
    if not isinstance(event_type, str) or event_type not in {"alert", "clear"}:
        return _reason(QuarantineReasonCode.INVALID_EVENT_TYPE)
    source_identity = event.get("source") or event.get("alertSource")
    if not all((
        _bounded_identity(event.get("machine")),
        _bounded_identity(event.get("instance")),
        _bounded_identity(source_identity),
        _bounded_identity(incident_key, _INCIDENT_KEY_MAX_LENGTH),
        _bounded_identity(incident_source),
    )):
        return _reason(QuarantineReasonCode.MISSING_INCIDENT_IDENTITY)
    created = _timestamp(event.get("createdAt"))
    if created is None:
        if schema_version == 1 and event_type == "alert":
            created_at, created_at_epoch = "", 0
        else:
            return _reason(QuarantineReasonCode.INVALID_CREATED_AT)
    else:
        created_at, created_at_epoch = created

    if schema_version == 1:
        state = ObservationState.HEALTHY if event_type == "clear" else ObservationState.FAULT
        minimum_policy = _recognized_critical_policy(
            event,
            is_logged_out_physical_signal=is_logged_out_physical_signal,
            is_verified_device_bond_lost_signal=is_verified_device_bond_lost_signal,
        )
        remediation, failure_code, confidence, classification = _legacy_remediation(
            event,
            state,
            is_logged_out_physical_signal=is_logged_out_physical_signal,
            is_verified_device_bond_lost_signal=is_verified_device_bond_lost_signal,
        )
        return NormalizedObservation(
            schema_version=1,
            event_id=str(event.get("id") or ""),
            event_type=str(event_type),
            incident_key=incident_key,
            incident_source=incident_source,
            state=state,
            observed_at=created_at,
            observed_at_epoch=created_at_epoch,
            confidence=confidence,
            clear_policy=NormalizedClearPolicy(minimum_policy, 1),
            remediation=remediation,
            target_incident_key=incident_key if state is ObservationState.HEALTHY else None,
            requires_same_incident_key=True,
            requires_newer_observation=True,
            failure_code=failure_code,
            classification=classification,
        )

    observation = event.get("observation")
    observed = _timestamp(event.get("observedAt"))
    if not isinstance(observation, dict) or observed is None:
        return _reason(QuarantineReasonCode.INVALID_V2_OBSERVATION)
    observed_at, observed_at_epoch = observed
    if observed_at_epoch > created_at_epoch:
        return _reason(QuarantineReasonCode.INVALID_V2_OBSERVATION)
    try:
        state = ObservationState(observation.get("state"))
    except (TypeError, ValueError):
        return _reason(QuarantineReasonCode.INVALID_V2_OBSERVATION)
    confidence = observation.get("confidence")
    fingerprint = observation.get("fingerprint")
    producer_sequence = observation.get("producerSequence")
    if (
        not isinstance(confidence, str)
        or confidence not in _CONFIDENCE
        or not isinstance(fingerprint, str)
        or not _FINGERPRINT_RE.fullmatch(fingerprint)
    ):
        return _reason(QuarantineReasonCode.INVALID_V2_OBSERVATION)
    if producer_sequence is not None and (
        isinstance(producer_sequence, bool)
        or not isinstance(producer_sequence, int)
        or producer_sequence < 0
        or producer_sequence > _MAX_SAFE_INTEGER
    ):
        return _reason(QuarantineReasonCode.INVALID_V2_OBSERVATION)
    if (event_type == "alert" and state is ObservationState.HEALTHY) or (
        event_type == "clear" and state is not ObservationState.HEALTHY
    ):
        return _reason(QuarantineReasonCode.INVALID_V2_OBSERVATION)

    policy = event.get("clearPolicy")
    if not isinstance(policy, dict):
        return _reason(QuarantineReasonCode.INVALID_V2_CLEAR_POLICY)
    try:
        policy_kind = ClearPolicyKind(policy.get("kind"))
    except (TypeError, ValueError):
        return _reason(QuarantineReasonCode.INVALID_V2_CLEAR_POLICY)
    if policy.get("minimumSchemaVersion") != 2:
        return _reason(QuarantineReasonCode.INVALID_V2_CLEAR_POLICY)
    proof_ref = policy.get("proofRef")
    if proof_ref is not None and (
        not isinstance(proof_ref, str)
        or not proof_ref.strip()
        or len(proof_ref.strip()) > _PROOF_REF_MAX_LENGTH
    ):
        return _reason(QuarantineReasonCode.INVALID_V2_CLEAR_POLICY)
    proof_observed = None
    if policy.get("proofObservedAt") is not None:
        if proof_ref is None:
            return _reason(QuarantineReasonCode.INVALID_V2_CLEAR_POLICY)
        proof_observed = _timestamp(policy.get("proofObservedAt"))
        if proof_observed is None or proof_observed[1] > observed_at_epoch:
            return _reason(QuarantineReasonCode.INVALID_V2_CLEAR_POLICY)
    if event_type == "clear" and policy_kind is not ClearPolicyKind.SAME_SOURCE_NEWER and proof_ref is None:
        return _reason(QuarantineReasonCode.INVALID_V2_CLEAR_POLICY)

    critical_minimum = _recognized_critical_policy(
        event,
        is_logged_out_physical_signal=is_logged_out_physical_signal,
        is_verified_device_bond_lost_signal=is_verified_device_bond_lost_signal,
    )
    policy_kind = stronger_clear_policy(policy_kind, critical_minimum)

    remediation = event.get("remediation")
    if not isinstance(remediation, dict):
        return _reason(QuarantineReasonCode.INVALID_V2_REMEDIATION)
    recoverability = remediation.get("recoverability")
    requested_action = remediation.get("requestedAction")
    authorization = remediation.get("authorization")
    if (
        not isinstance(recoverability, str)
        or recoverability not in _RECOVERABILITY
        or not isinstance(authorization, str)
        or authorization not in _AUTHORIZATION
        or not isinstance(requested_action, str)
        or _ACTION_RE.fullmatch(requested_action) is None
    ):
        return _reason(QuarantineReasonCode.INVALID_V2_REMEDIATION)

    _, failure = _critical_failure(event)
    failure_code = str(failure.get("code") or "").strip()
    classification = "standard"
    if _has_structured_weak_auth_evidence(event) or failure_code == _WEAK_AUTH_FAILURE_CODE or (
        failure_code == _TERMINAL_AUTH_FAILURE_CODE
        and not (is_logged_out_physical_signal or is_verified_device_bond_lost_signal)
    ):
        failure_code = _WEAK_AUTH_FAILURE_CODE
        recoverability = "auto_recoverable"
        authorization = "automatic_read_only"
        classification = "inferred_transient"
    elif is_logged_out_physical_signal or is_verified_device_bond_lost_signal:
        recoverability = "manual_relink_required"
        authorization = "physical_required"
        classification = "physical_intervention"

    return NormalizedObservation(
        schema_version=2,
        event_id=str(event.get("id") or ""),
        event_type=str(event_type),
        incident_key=incident_key,
        incident_source=incident_source,
        state=state,
        observed_at=observed_at,
        observed_at_epoch=observed_at_epoch,
        confidence=str(confidence),
        clear_policy=NormalizedClearPolicy(
            policy_kind,
            2,
            proof_ref.strip() if isinstance(proof_ref, str) else None,
            proof_observed[0] if proof_observed else None,
            proof_observed[1] if proof_observed else None,
        ),
        remediation=NormalizedRemediation(
            str(recoverability),
            requested_action,
            str(authorization),
        ),
        fingerprint=fingerprint,
        producer_sequence=producer_sequence,
        target_incident_key=incident_key if state is ObservationState.HEALTHY else None,
        requires_same_incident_key=state is ObservationState.HEALTHY,
        requires_newer_observation=state is ObservationState.HEALTHY,
        failure_code=failure_code,
        classification=classification,
    )
