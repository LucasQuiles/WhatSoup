"""Authenticated IncidentStore admission for BOT ERRORS side effects.

The client deliberately accepts a producer claim rather than a live dispatcher
record.  Its canonical body therefore stays byte-identical while delivery
attempts, backoff details, and transport errors change around it.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import http.client
import ipaddress
import json
import os
import re
import socket
import stat
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit


MAX_CREDENTIAL_BYTES = 4096
MAX_RESPONSE_BYTES = 16 * 1024
MAX_SIGNAL_BYTES = 32 * 1024
DEFAULT_TIMEOUT_SECONDS = 5.0

# The authority mode, one setting for the dispatcher and the Q loop. "observe"
# (the default) asks for a grant and records the answer, but every notice is
# delivered as before the authority existed. "enforce" sends nothing without a
# grant. The owner switches a host to "enforce" after enrolling it.
AUTHORITY_MODE_SETTING = "BOT_ERRORS_INCIDENT_AUTHORITY_MODE"
AUTHORITY_MODES = ("observe", "enforce")
# Observe-mode bounds: one request per event per cycle with this timeout, and
# at most this many requests and this much request time per cycle. After a
# bound, the rest of the cycle is recorded "not_asked" and still sent.
OBSERVE_TIMEOUT_SECONDS = 2.0
OBSERVE_REQUESTS_PER_CYCLE = 8
OBSERVE_SECONDS_PER_CYCLE = 8.0
AUTHORITY_OUTCOMES = (
    "granted",
    "refused",
    "not_ready",
    "protocol_error",
    "not_configured",
    "not_asked",
)
# Outcomes that enforce mode would have held or refused.
ENFORCE_WOULD_STOP_OUTCOMES = ("refused", "not_ready", "protocol_error", "not_configured")
_RECORD_EVENT_CLASSES = ("alert", "clear", "observation", "q_notice")
_REASON_CODE = re.compile(r"[a-z][a-z0-9_]{0,63}")
_REFUSED_REASONS = (
    "incident_authority_identity_conflict",
    "authority_credential_rejected",
    "authority_scope_denied",
)


def _abort_connection(connection: Any) -> None:
    """End an abandoned request: shut its socket so a blocked read returns."""
    sock = getattr(connection, "sock", None)
    if sock is not None:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:  # intentional: the socket may already be closed
            pass
    try:
        connection.close()
    except Exception:  # noqa: BLE001 - intentional: best effort on an abandoned request
        pass


def incident_authority_mode(environ: Mapping[str, str], warn: Callable[[str], None]) -> str:
    """Return the authority mode; the one reader of the setting.

    Absent, empty or any value other than exactly ``observe`` or ``enforce``
    (after trimming white space) means ``observe``. An unknown value calls
    ``warn`` once with a fixed code; the value itself is never logged.
    """
    value = str(environ.get(AUTHORITY_MODE_SETTING, "") or "").strip()
    if value in AUTHORITY_MODES:
        return value
    if value:
        warn("incident_authority_mode_unknown")
    return "observe"


def _reason_code(text: str) -> str:
    return text if _REASON_CODE.fullmatch(text) else "authority_client_error"


def classify_authority_outcome(error: BaseException | None) -> tuple[str, str]:
    """Map one authority answer to a recorded (outcome, reason code) pair."""
    if error is None:
        return "granted", "none"
    if isinstance(error, AuthorityConflict):
        return "refused", "incident_authority_identity_conflict"
    if isinstance(error, AuthorityNotReady):
        reason = _reason_code(error.reason)
        if reason == "incident_authority_not_configured":
            return "not_configured", reason
        if reason in _REFUSED_REASONS:
            return "refused", reason
        return "not_ready", reason
    if isinstance(error, AuthorityUnavailable):
        return "not_ready", "incident_authority_unavailable"
    if isinstance(error, AuthorityProtocolError):
        return "protocol_error", _reason_code(str(error))
    return "protocol_error", "authority_client_error"


def authority_outcome_record(
    *,
    event_class: str,
    outcome: str,
    reason: str,
    mode: str,
    observed_epoch: int,
) -> dict[str, str]:
    """One record line: time, event class, outcome, reason code and mode.

    Every value is a closed code; no message content, path, name or chat id
    can enter the record.
    """
    return {
        "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(observed_epoch)),
        "eventClass": event_class if event_class in _RECORD_EVENT_CLASSES else "other",
        "outcome": outcome if outcome in AUTHORITY_OUTCOMES else "protocol_error",
        "reason": _reason_code(reason) if outcome in AUTHORITY_OUTCOMES else "authority_client_error",
        "mode": mode if mode in AUTHORITY_MODES else "observe",
    }
_SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,125}$")
_ALLOWED_DISPOSITIONS = {
    "incident_opened",
    "incident_updated",
    "incident_resolved",
    "heartbeat_recorded",
    "notice_recorded",
    "stored_no_state_change",
    "stored_stale_observation",
    "stored_quarantined_observation",
}


class AuthorityError(RuntimeError):
    """Base class with a bounded message safe for operational state."""


class AuthorityUnavailable(AuthorityError):
    """The authority could not durably answer; retry is permitted."""


class AuthorityNotReady(AuthorityUnavailable):
    """This host cannot get an answer yet.

    The settings are missing or invalid, the producer credential is missing,
    unreadable or not private, the authority refused the credential (401) or
    its scope (403), rate-limited the producer (429), or is down (connection
    failure, timeout or any 5xx answer). The protected
    effect waits and is retried with backoff. It is never terminal and never
    counts as an attempt; the message is the bounded reason code.
    """

    @property
    def reason(self) -> str:
        return str(self)


class AuthorityConflict(AuthorityError):
    """The stable identity was already accepted with different bytes."""


class AuthorityProtocolError(AuthorityError):
    """Local configuration or a remote receipt violated the closed contract."""


@dataclass(frozen=True)
class CanonicalSignal:
    signal_id: str
    body: bytes
    payload_digest: str


@dataclass(frozen=True)
class AuthorityGrant:
    receipt_id: str
    event_id: int
    producer_id: str
    signal_id: str
    payload_digest: str
    received_at: str
    disposition: str
    incident_id: int | None
    transition_id: int | None
    replay: bool

    def as_record(self) -> dict[str, Any]:
        """Return the content-free durable subset stored beside an outbox item."""

        return {
            "schemaVersion": 1,
            "receiptId": self.receipt_id,
            "eventId": self.event_id,
            "producerId": self.producer_id,
            "signalId": self.signal_id,
            "payloadDigest": self.payload_digest,
            "receivedAt": self.received_at,
            "disposition": self.disposition,
            "incidentId": self.incident_id,
            "transitionId": self.transition_id,
            "replay": self.replay,
        }


def grant_from_record(
    record: object,
    producer_claim: dict[str, Any],
    *,
    expected_producer_id: str,
) -> AuthorityGrant:
    """Revalidate a persisted grant before a restart skips remote acceptance."""

    if not isinstance(record, dict):
        raise AuthorityProtocolError("authority_grant_missing")
    signal = canonical_signal(producer_claim)
    event_id = record.get("eventId")
    incident_id = record.get("incidentId")
    transition_id = record.get("transitionId")
    disposition = record.get("disposition")
    received_at = record.get("receivedAt")
    if type(event_id) is not int or event_id <= 0:
        raise AuthorityProtocolError("authority_grant_event_invalid")
    if record.get("receiptId") != f"rcpt-{event_id}":
        raise AuthorityProtocolError("authority_grant_receipt_invalid")
    if record.get("producerId") != expected_producer_id:
        raise AuthorityProtocolError("authority_grant_producer_invalid")
    if record.get("signalId") != signal.signal_id or record.get("payloadDigest") != signal.payload_digest:
        raise AuthorityProtocolError("authority_grant_binding_invalid")
    for value in (incident_id, transition_id):
        if value is not None and (type(value) is not int or value <= 0):
            raise AuthorityProtocolError("authority_grant_reference_invalid")
    if disposition not in _ALLOWED_DISPOSITIONS:
        raise AuthorityProtocolError("authority_grant_disposition_invalid")
    _strict_utc(received_at)
    return AuthorityGrant(
        receipt_id=f"rcpt-{event_id}",
        event_id=event_id,
        producer_id=expected_producer_id,
        signal_id=signal.signal_id,
        payload_digest=signal.payload_digest,
        received_at=received_at,
        disposition=disposition,
        incident_id=incident_id,
        transition_id=transition_id,
        replay=bool(record.get("replay")),
    )


def dry_accept_for_test(
    producer_claim: dict[str, Any],
    capture_path: Path,
    *,
    producer_id: str = "bot-errors-dispatcher",
) -> AuthorityGrant:
    """Deterministic no-network receipt for a dry notification test run.

    This seam is valid only when the caller has already selected the existing
    dry notification transport.  Production service templates are guarded from
    defining either dry variable.
    """

    signal = canonical_signal(producer_claim)
    event_id = int(hashlib.sha256(signal.body).hexdigest()[:12], 16)
    capture_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    payload = signal.body + b"\n"
    fd = os.open(
        capture_path,
        os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise AuthorityProtocolError("authority_dry_capture_not_private")
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    observed_at, _ = _strict_utc(
        producer_claim.get("createdAt") or producer_claim.get("authorityObservedAt")
    )
    kind = json.loads(signal.body)["kind"]
    disposition = "incident_opened" if kind == "condition_observed" else "notice_recorded"
    return AuthorityGrant(
        receipt_id=f"rcpt-{event_id}",
        event_id=event_id,
        producer_id=producer_id,
        signal_id=signal.signal_id,
        payload_digest=signal.payload_digest,
        received_at=observed_at,
        disposition=disposition,
        incident_id=event_id if kind == "condition_observed" else None,
        transition_id=event_id if kind == "condition_observed" else None,
        replay=False,
    )


def _digest(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def _stable_hash(*parts: object, length: int = 32) -> str:
    encoded = json.dumps(parts, ensure_ascii=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()[:length]


def _strict_utc(value: object) -> tuple[str, int]:
    if not isinstance(value, str) or len(value) > 64:
        raise AuthorityProtocolError("authority_event_time_invalid")
    candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = dt.datetime.fromisoformat(candidate)
    except ValueError as exc:
        raise AuthorityProtocolError("authority_event_time_invalid") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != dt.timedelta(0):
        raise AuthorityProtocolError("authority_event_time_invalid")
    parsed = parsed.astimezone(dt.timezone.utc)
    canonical = parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return canonical, int(parsed.timestamp() * 1000)


def canonical_signal(producer_claim: dict[str, Any]) -> CanonicalSignal:
    """Project a private producer event into the closed, content-free signal schema."""

    if not isinstance(producer_claim, dict):
        raise AuthorityProtocolError("authority_event_invalid")
    raw_id = producer_claim.get("id")
    if not isinstance(raw_id, str) or not raw_id:
        raise AuthorityProtocolError("authority_event_identity_missing")
    signal_id = f"be-{raw_id}" if _SAFE_ID.fullmatch(raw_id) else f"be-{_stable_hash(raw_id)}"
    signal_id = signal_id[:128]
    observed_at, observed_ms = _strict_utc(
        producer_claim.get("createdAt") or producer_claim.get("authorityObservedAt")
    )
    event_type = str(producer_claim.get("eventType") or "").lower()
    source_fingerprint = _stable_hash(
        producer_claim.get("machine"),
        producer_claim.get("instance"),
        producer_claim.get("source"),
        length=24,
    )
    occurrence_id = f"beo-{source_fingerprint}"
    # Timestamp ordering is primary.  Ten deterministic suffix bits distinguish
    # simultaneous producer events while keeping the value exactly representable
    # by JSON/JavaScript and below SQLite's signed-integer ceiling.  A one-ms
    # advance is always larger than every suffix from the preceding millisecond.
    occurrence_seq = observed_ms * 1024 + (int(_stable_hash(raw_id, length=3), 16) & 0x3FF)
    if occurrence_seq > (2**53) - 1:
        raise AuthorityProtocolError("authority_event_time_out_of_range")
    attributes = {
        "eventClass": event_type if event_type in {"alert", "clear", "info"} else "unknown",
        "sourceFingerprint": source_fingerprint,
    }
    envelope: dict[str, Any] = {
        "schemaVersion": 1,
        "signalId": signal_id,
        "subject": "bot-errors",
        "observedAt": observed_at,
        "attributes": attributes,
    }
    if event_type == "alert":
        envelope.update(
            kind="condition_observed",
            conditionClass="bot_errors_alert",
            occurrenceId=occurrence_id,
            occurrenceSeq=occurrence_seq,
        )
    elif event_type == "clear":
        envelope.update(
            kind="condition_recovered",
            conditionClass="bot_errors_alert",
            occurrenceId=occurrence_id,
            occurrenceSeq=occurrence_seq,
            recoveryProofClass="producer_reported_clear",
        )
    else:
        envelope["kind"] = "notice_recorded"
    body = json.dumps(envelope, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
    if len(body) > MAX_SIGNAL_BYTES:
        raise AuthorityProtocolError("authority_signal_oversized")
    return CanonicalSignal(signal_id=signal_id, body=body, payload_digest=_digest(body))


def _open_private_file(path: Path) -> int:
    if not path.is_absolute():
        raise AuthorityProtocolError("authority_credential_path_not_absolute")
    parts = path.parts
    if not parts or parts[0] != os.sep:
        raise AuthorityProtocolError("authority_credential_path_invalid")
    directory_fd = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY)
    try:
        root_info = os.fstat(directory_fd)
        if (
            not stat.S_ISDIR(root_info.st_mode)
            or root_info.st_uid not in {0, os.geteuid()}
            or root_info.st_mode & 0o022
        ):
            raise AuthorityProtocolError("authority_credential_parent_not_private")
        for component in parts[1:-1]:
            next_fd = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=directory_fd,
            )
            os.close(directory_fd)
            directory_fd = next_fd
            directory_info = os.fstat(directory_fd)
            if (
                not stat.S_ISDIR(directory_info.st_mode)
                or directory_info.st_uid not in {0, os.geteuid()}
                or directory_info.st_mode & 0o022
            ):
                raise AuthorityProtocolError("authority_credential_parent_not_private")
        return os.open(
            parts[-1],
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0),
            dir_fd=directory_fd,
        )
    except OSError as exc:
        raise AuthorityProtocolError("authority_credential_unreadable") from exc
    finally:
        os.close(directory_fd)


def _read_private_credential(path: Path) -> str:
    fd = _open_private_file(path)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise AuthorityProtocolError("authority_credential_not_regular")
        if info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077:
            raise AuthorityProtocolError("authority_credential_not_private")
        data = os.read(fd, MAX_CREDENTIAL_BYTES + 1)
    finally:
        os.close(fd)
    if len(data) > MAX_CREDENTIAL_BYTES:
        raise AuthorityProtocolError("authority_credential_oversized")
    try:
        value = data.decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        raise AuthorityProtocolError("authority_credential_invalid") from exc
    if not value or len(value) > 512 or any(char.isspace() for char in value):
        raise AuthorityProtocolError("authority_credential_invalid")
    return value


@dataclass(frozen=True)
class _Destination:
    scheme: str
    host: str
    port: int
    path: str


def _validate_destination(url: str) -> _Destination:
    try:
        parsed = urlsplit(url)
    except ValueError as exc:
        # urlsplit raises for some malformed addresses (an unclosed IPv6
        # literal, for one); that is a wrong local setting like the rest.
        raise AuthorityProtocolError("authority_destination_invalid") from exc
    if parsed.scheme not in {"http", "https"}:
        raise AuthorityProtocolError("authority_destination_scheme_invalid")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise AuthorityProtocolError("authority_destination_ambiguous")
    if parsed.path != "/api/signals" or not parsed.hostname:
        raise AuthorityProtocolError("authority_destination_path_invalid")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise AuthorityProtocolError("authority_destination_port_invalid") from exc
    if parsed.scheme == "http":
        try:
            if not ipaddress.ip_address(parsed.hostname).is_loopback:
                raise AuthorityProtocolError("authority_plaintext_destination_not_loopback")
        except ValueError as exc:
            raise AuthorityProtocolError("authority_plaintext_destination_not_literal_loopback") from exc
    return _Destination(parsed.scheme, parsed.hostname, port, parsed.path)


class IncidentAuthorityClient:
    def __init__(
        self,
        url: str,
        credential_path: Path,
        *,
        expected_producer_id: str,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        connection_factory: Callable[[str, int, float], Any] | None = None,
    ) -> None:
        try:
            self.destination = _validate_destination(url)
        except AuthorityProtocolError as exc:
            # A wrong local setting: the operator fixes it and the work waits.
            raise AuthorityNotReady(str(exc)) from exc
        self.credential_path = credential_path
        if not expected_producer_id or len(expected_producer_id) > 128:
            raise AuthorityProtocolError("authority_producer_id_invalid")
        self.expected_producer_id = expected_producer_id
        if not 0 < timeout_seconds <= 30:
            raise AuthorityProtocolError("authority_timeout_invalid")
        self.timeout_seconds = timeout_seconds
        self.connection_factory = connection_factory

    def accept(
        self, producer_claim: dict[str, Any], *, deadline_seconds: float | None = None
    ) -> AuthorityGrant:
        """Ask for one grant.

        With ``deadline_seconds`` (observe mode) the whole request, from the
        connection to the last body byte, is bounded by that many seconds: no
        socket operation waits longer, and past the deadline the request is
        closed, left behind and answered as unavailable. Without it (enforce
        mode) each socket operation keeps the client timeout.
        """
        if deadline_seconds is None:
            return self._accept(producer_claim, self.timeout_seconds, [])
        opened: list[Any] = []
        answer: dict[str, Any] = {}

        def ask() -> None:
            try:
                answer["grant"] = self._accept(
                    producer_claim, min(self.timeout_seconds, deadline_seconds), opened
                )
            except BaseException as exc:  # noqa: BLE001 - handed back to the caller below
                answer["error"] = exc

        worker = threading.Thread(target=ask, name="incident-authority-request", daemon=True)
        worker.start()
        worker.join(max(0.0, deadline_seconds))
        if worker.is_alive():
            for connection in opened:
                _abort_connection(connection)
            raise AuthorityNotReady("incident_authority_unavailable")
        if "error" in answer:
            raise answer["error"]
        return answer["grant"]

    def _accept(
        self, producer_claim: dict[str, Any], timeout_seconds: float, opened: list[Any]
    ) -> AuthorityGrant:
        signal = canonical_signal(producer_claim)
        try:
            credential = _read_private_credential(self.credential_path)
        except AuthorityProtocolError as exc:
            # Missing (not enrolled yet), unreadable or not private: nothing
            # is sent, and the work waits for the operator to fix the file.
            raise AuthorityNotReady(str(exc)) from exc
        connection_class = (
            http.client.HTTPSConnection if self.destination.scheme == "https" else http.client.HTTPConnection
        )
        connection = (
            self.connection_factory(
                self.destination.host,
                self.destination.port,
                timeout_seconds,
            )
            if self.connection_factory is not None
            else connection_class(
                self.destination.host,
                self.destination.port,
                timeout=timeout_seconds,
            )
        )
        opened.append(connection)
        try:
            try:
                connection.request(
                    "POST",
                    self.destination.path,
                    body=signal.body,
                    headers={
                        "Authorization": f"Bearer {credential}",
                        "Content-Type": "application/json",
                        "Content-Length": str(len(signal.body)),
                    },
                )
                response = connection.getresponse()
            except (OSError, TimeoutError, http.client.HTTPException) as exc:
                # An outage of the authority holds the work; it is never terminal
                # and never counts toward the attempt cap.
                raise AuthorityNotReady("incident_authority_unavailable") from exc
            # The status decides before the body is read: a refusal or an
            # outage needs no body, so a rate limit is recognised even when its
            # body never arrives, and a large error page is not a protocol error.
            if response.status == 409:
                raise AuthorityConflict("incident_authority_identity_conflict")
            if response.status == 401:
                raise AuthorityNotReady("authority_credential_rejected")
            if response.status == 403:
                raise AuthorityNotReady("authority_scope_denied")
            if response.status == 429:
                raise AuthorityNotReady("incident_authority_rate_limited")
            if 500 <= response.status < 600:
                raise AuthorityNotReady("incident_authority_unavailable")
            if 300 <= response.status < 400:
                raise AuthorityProtocolError("authority_redirect_rejected")
            if response.status not in {200, 201}:
                raise AuthorityProtocolError("authority_response_status_rejected")
            try:
                payload = response.read(MAX_RESPONSE_BYTES + 1)
            except (OSError, TimeoutError, http.client.HTTPException) as exc:
                raise AuthorityNotReady("incident_authority_unavailable") from exc
        finally:
            connection.close()
        if len(payload) > MAX_RESPONSE_BYTES:
            raise AuthorityProtocolError("authority_response_oversized")
        replay = response.status == 200
        replay_header = response.getheader("Idempotent-Replay")
        if replay != (replay_header == "true"):
            raise AuthorityProtocolError("authority_replay_contract_invalid")
        try:
            parsed = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AuthorityProtocolError("authority_receipt_malformed") from exc
        return self._validate_receipt(parsed, signal, replay)

    def _validate_receipt(
        self,
        receipt: object,
        signal: CanonicalSignal,
        replay: bool,
    ) -> AuthorityGrant:
        if not isinstance(receipt, dict):
            raise AuthorityProtocolError("authority_receipt_malformed")
        event_id = receipt.get("eventId")
        incident_id = receipt.get("incidentId")
        transition_id = receipt.get("transitionId")
        disposition = receipt.get("disposition")
        received_at = receipt.get("receivedAt")
        if type(event_id) is not int or event_id <= 0:
            raise AuthorityProtocolError("authority_receipt_event_invalid")
        for value in (incident_id, transition_id):
            if value is not None and (type(value) is not int or value <= 0):
                raise AuthorityProtocolError("authority_receipt_reference_invalid")
        if disposition not in _ALLOWED_DISPOSITIONS:
            raise AuthorityProtocolError("authority_receipt_disposition_invalid")
        _strict_utc(received_at)
        expected = {
            "schemaVersion": 1,
            "receiptId": f"rcpt-{event_id}",
            "producerId": self.expected_producer_id,
            "signalId": signal.signal_id,
            "payloadDigest": signal.payload_digest,
        }
        if any(receipt.get(key) != value for key, value in expected.items()):
            raise AuthorityProtocolError("authority_receipt_binding_invalid")
        return AuthorityGrant(
            receipt_id=expected["receiptId"],
            event_id=event_id,
            producer_id=self.expected_producer_id,
            signal_id=signal.signal_id,
            payload_digest=signal.payload_digest,
            received_at=received_at,
            disposition=disposition,
            incident_id=incident_id,
            transition_id=transition_id,
            replay=replay,
        )
