"""Non-emitting, facts-bound BOT ERRORS human-report preview.

The request identifies records under roots selected by trusted launch
configuration.  This module verifies bounded bytes and binding equality; it
does not authenticate the caller, a provider, or a WhatsApp identity.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import errno
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import socket
import stat
from typing import Any, Iterable, Mapping


REPORT_SCHEMA = "bot-errors-human-report/v2"
RECORD_SCHEMA = "bot-errors-human-report-record/v1"
MAX_EVIDENCE_BYTES = 65_536
MAX_REQUEST_BYTES = 65_536
_LOCATOR_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*):(/.*)$")
_SCOPES = frozenset(("target", "all-hosts"))
_STATES = frozenset((
    "accepted",
    "investigating",
    "recovered",
    "closed",
    "failed",
    "retained/unaccepted",
    "waiting_approval",
    "paused",
    "recovery_unverified",
))
_SEVERITIES = frozenset(("critical", "error", "warning", "info"))
_MARKUP = ("*", "_", "`", "~", "|")
_RAW_SHA256_RE = re.compile(r"(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])")


class ReportQualificationError(ValueError):
    """Stable, non-sensitive reason a preview cannot be rendered."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ReportLimits:
    """Caller policy limits; these do not claim a transport-wide limit."""

    max_characters: int | None = None
    max_utf8_bytes: int | None = None


@dataclass(frozen=True)
class IncidentBinding:
    incident_id: str
    generation: int
    scope: str
    coverage_complete: bool


@dataclass(frozen=True)
class VerifiedRecord:
    locator: str
    payload: Mapping[str, Any]


@dataclass(frozen=True)
class HandlingFacts:
    condition: str
    condition_ids: tuple[str, ...]
    target: str
    impact: str | None
    severity: str
    state: str
    work_started: bool
    administrative_closure: bool
    next_action: str
    reader_action: str | None
    owner_decision: str
    owner_action: str | None


@dataclass(frozen=True)
class QualifiedHumanReport:
    condition: str
    condition_ids: tuple[str, ...]
    target: str
    impact: str | None
    severity: str
    state: str
    work_started: bool
    administrative_closure: bool
    next_action: str
    reader_action: str | None
    owner_decision: str
    owner_action: str | None
    details_locator: str


def _mapping(value: object, code: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ReportQualificationError(code)
    return value


def _safe_text(value: object, code: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ReportQualificationError(code)
    text = value
    if any(ord(character) < 32 or ord(character) == 127 for character in text):
        raise ReportQualificationError(f"unsafe_{code.removeprefix('missing_')}")
    if any(character in text for character in _MARKUP):
        raise ReportQualificationError(f"unsafe_{code.removeprefix('missing_')}")
    if _RAW_SHA256_RE.search(text):
        raise ReportQualificationError(f"unsafe_{code.removeprefix('missing_')}")
    return text


def _optional_text(value: object, code: str) -> str | None:
    if value is None:
        return None
    return _safe_text(value, code)


def _required_bool(value: object, code: str) -> bool:
    if not isinstance(value, bool):
        raise ReportQualificationError(code)
    return value


def _binding(value: object, code: str) -> IncidentBinding:
    data = _mapping(value, code)
    incident_id = _safe_text(data.get("incidentId"), "missing_incident_id")
    generation = data.get("generation")
    if isinstance(generation, bool) or not isinstance(generation, int) or generation < 0:
        raise ReportQualificationError("invalid_generation")
    scope = data.get("scope")
    if scope not in _SCOPES:
        raise ReportQualificationError("invalid_coverage_scope")
    coverage_complete = _required_bool(data.get("coverageComplete"), "missing_coverage_complete")
    if scope == "all-hosts" and not coverage_complete:
        raise ReportQualificationError("all_hosts_partial_coverage")
    return IncidentBinding(incident_id, generation, scope, coverage_complete)


def _local_hosts() -> frozenset[str]:
    return frozenset(name.lower() for name in (socket.gethostname(), socket.getfqdn()) if name)


def _absolute_path(path: Path, code: str) -> Path:
    if not path.is_absolute() or ".." in path.parts:
        raise ReportQualificationError(code)
    return path


def _open_directory_no_symlink(path: Path, code: str) -> int:
    """Open every directory component from `/` with O_NOFOLLOW."""
    path = _absolute_path(path, code)
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open("/", directory_flags)
    try:
        for part in path.parts[1:]:
            next_fd = os.open(part, directory_flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
    except OSError as exc:
        os.close(fd)
        if exc.errno == errno.ELOOP:
            raise ReportQualificationError("evidence_symlink") from exc
        raise ReportQualificationError(code) from exc
    return fd


def _approved_roots(values: Iterable[Path | str]) -> tuple[Path, ...]:
    roots = tuple(_absolute_path(Path(value), "invalid_approved_evidence_root") for value in values)
    if not roots:
        raise ReportQualificationError("missing_approved_evidence_root")
    for root in roots:
        descriptor = _open_directory_no_symlink(root, "invalid_approved_evidence_root")
        os.close(descriptor)
    return roots


def _record_bytes(path: Path, roots: tuple[Path, ...]) -> bytes:
    path = _absolute_path(path, "invalid_evidence_locator")
    root = next((candidate for candidate in roots if path.is_relative_to(candidate)), None)
    if root is None:
        raise ReportQualificationError("evidence_outside_approved_roots")
    relative = path.relative_to(root)
    if not relative.parts:
        raise ReportQualificationError("invalid_evidence_locator")
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory_fd = _open_directory_no_symlink(root, "invalid_approved_evidence_root")
    try:
        for component in relative.parts[:-1]:
            next_fd = os.open(component, directory_flags, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = next_fd
        try:
            file_fd = os.open(
                relative.parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd,
            )
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise ReportQualificationError("evidence_symlink") from exc
            raise ReportQualificationError("evidence_unavailable") from exc
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise ReportQualificationError("evidence_symlink") from exc
        raise ReportQualificationError("evidence_unavailable") from exc
    finally:
        os.close(directory_fd)
    try:
        file_stat = os.fstat(file_fd)
        if not stat.S_ISREG(file_stat.st_mode):
            raise ReportQualificationError("evidence_unavailable")
        with os.fdopen(file_fd, "rb", closefd=True) as evidence_file:
            file_fd = None
            contents = evidence_file.read(MAX_EVIDENCE_BYTES + 1)
    except OSError as exc:
        raise ReportQualificationError("evidence_unavailable") from exc
    finally:
        if file_fd is not None:
            try:
                os.close(file_fd)
            except OSError:
                pass
    if len(contents) > MAX_EVIDENCE_BYTES:
        raise ReportQualificationError("evidence_too_large")
    return contents


def _load_record(value: object, *, expected_kind: str, expected_binding: IncidentBinding, roots: tuple[Path, ...]) -> VerifiedRecord:
    reference = _mapping(value, "missing_evidence_reference")
    locator = reference.get("locator")
    digest = reference.get("sha256")
    if not isinstance(locator, str):
        raise ReportQualificationError("invalid_evidence_locator")
    if any(ord(character) < 32 or ord(character) == 127 for character in locator):
        raise ReportQualificationError("locator_control_character")
    match = _LOCATOR_RE.fullmatch(locator)
    if match is None:
        raise ReportQualificationError("invalid_evidence_locator")
    host, raw_path = match.groups()
    if host.lower() not in _local_hosts():
        raise ReportQualificationError("evidence_not_local")
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ReportQualificationError("invalid_evidence_sha256")
    contents = _record_bytes(Path(raw_path), roots)
    actual_digest = hashlib.sha256(contents).hexdigest()
    if not hmac.compare_digest(digest, actual_digest):
        raise ReportQualificationError("evidence_hash_mismatch")
    try:
        payload = json.loads(contents.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReportQualificationError("invalid_evidence_record") from exc
    record = _mapping(payload, "invalid_evidence_record")
    if record.get("schema") != RECORD_SCHEMA or record.get("kind") != expected_kind:
        raise ReportQualificationError(f"{expected_kind}_record_kind_mismatch")
    if _binding(record.get("binding"), "invalid_evidence_binding") != expected_binding:
        raise ReportQualificationError(f"{expected_kind}_binding_mismatch")
    _mapping(record.get("facts"), "invalid_evidence_facts")
    return VerifiedRecord(locator=locator, payload=record)


def _required_text_list(value: object, *, missing_code: str, invalid_code: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not value:
        raise ReportQualificationError(missing_code)
    try:
        entries = tuple(_safe_text(entry, invalid_code) for entry in value)
    except ReportQualificationError as exc:
        if exc.code.startswith("missing_") or exc.code.startswith("unsafe_"):
            raise ReportQualificationError(invalid_code) from exc
        raise
    if len(set(entries)) != len(entries):
        raise ReportQualificationError(invalid_code)
    return entries


def _handling_facts(record: VerifiedRecord) -> HandlingFacts:
    facts = _mapping(record.payload.get("facts"), "invalid_evidence_facts")
    condition = _safe_text(facts.get("condition"), "missing_condition")
    condition_ids = _required_text_list(
        facts.get("conditionIds"), missing_code="missing_condition_ids", invalid_code="invalid_condition_ids",
    )
    target = _safe_text(facts.get("target"), "missing_target")
    impact = _optional_text(facts.get("impact"), "invalid_impact")
    severity = facts.get("severity")
    if severity not in _SEVERITIES:
        raise ReportQualificationError("invalid_severity")
    state = facts.get("state")
    if state not in _STATES:
        raise ReportQualificationError("invalid_handling_state")
    work_started = _required_bool(facts.get("workStarted"), "missing_work_started")
    administrative_closure = _required_bool(
        facts.get("administrativeClosure", False), "invalid_administrative_closure",
    )
    if state == "accepted" and work_started:
        raise ReportQualificationError("accepted_after_started_work")
    if state == "investigating" and not work_started:
        raise ReportQualificationError("investigation_without_started_work")
    if state == "closed" and not administrative_closure:
        raise ReportQualificationError("closed_without_recovery_classification")
    if state != "closed" and administrative_closure:
        raise ReportQualificationError("administrative_closure_wrong_state")
    next_action = _safe_text(facts.get("next"), "missing_next")
    reader_action = _optional_text(facts.get("readerAction"), "invalid_reader_action")
    owner_decision = facts.get("ownerDecision")
    if owner_decision not in {"open", "closed", "not_required"}:
        raise ReportQualificationError("invalid_owner_decision")
    owner_action = _optional_text(facts.get("ownerAction"), "invalid_owner_action")
    if owner_decision == "open" and owner_action is None:
        raise ReportQualificationError("open_owner_decision_without_action")
    if owner_decision != "open" and owner_action is not None:
        raise ReportQualificationError("owner_action_conflicts_with_decision")
    if owner_decision == "open":
        if reader_action is not None and reader_action != owner_action:
            raise ReportQualificationError("reader_action_conflicts_with_owner_action")
        reader_action = owner_action
    elif reader_action is not None:
        raise ReportQualificationError("reader_action_conflicts_with_owner_decision")
    if state == "waiting_approval" and owner_decision != "open":
        raise ReportQualificationError("waiting_approval_without_open_owner_decision")
    return HandlingFacts(
        condition=condition,
        condition_ids=condition_ids,
        target=target,
        impact=impact,
        severity=severity,
        state=state,
        work_started=work_started,
        administrative_closure=administrative_closure,
        next_action=next_action,
        reader_action=reader_action,
        owner_decision=owner_decision,
        owner_action=owner_action,
    )


def _require_accepted_owner(request: Mapping[str, Any], binding: IncidentBinding, roots: tuple[Path, ...]) -> None:
    ownership = _load_record(
        request.get("ownershipRecord"), expected_kind="ownership", expected_binding=binding, roots=roots,
    )
    owner_facts = _mapping(ownership.payload.get("facts"), "invalid_evidence_facts")
    acceptance = owner_facts.get("acceptance")
    if acceptance is None:
        raise ReportQualificationError("missing_owner_acceptance")
    if acceptance != "accepted":
        raise ReportQualificationError("ownership_not_accepted")
    _safe_text(owner_facts.get("ownerIdentity"), "missing_owner_identity")


def _require_recovery_observation(
    request: Mapping[str, Any],
    binding: IncidentBinding,
    roots: tuple[Path, ...],
    handling: HandlingFacts,
) -> None:
    recovery = _load_record(
        request.get("recoveryRecord"), expected_kind="recovery", expected_binding=binding, roots=roots,
    )
    facts = _mapping(recovery.payload.get("facts"), "invalid_evidence_facts")
    if facts.get("recoveryProof") is not True:
        raise ReportQualificationError("missing_recovery_proof")
    if facts.get("completeObservation") is not True:
        raise ReportQualificationError("incomplete_recovery_observation")
    verified_condition_ids = _required_text_list(
        facts.get("verifiedConditionIds"),
        missing_code="recovery_condition_set_mismatch",
        invalid_code="recovery_condition_set_mismatch",
    )
    if set(verified_condition_ids) != set(handling.condition_ids):
        raise ReportQualificationError("recovery_condition_set_mismatch")
    if facts.get("verifiedTarget") != handling.target:
        raise ReportQualificationError("recovery_target_mismatch")
    if facts.get("verifiedScope") != binding.scope:
        raise ReportQualificationError("recovery_scope_mismatch")
    observed_at = facts.get("observedAt")
    if not isinstance(observed_at, str):
        raise ReportQualificationError("invalid_recovery_observation_time")
    try:
        observed = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ReportQualificationError("invalid_recovery_observation_time") from exc
    if observed.tzinfo is None:
        raise ReportQualificationError("invalid_recovery_observation_time")
    if facts.get("verificationResult") != "passed":
        raise ReportQualificationError("recovery_verification_failed")


def qualify_report(document: object, *, approved_roots: Iterable[Path | str]) -> QualifiedHumanReport:
    """Verify retained records and derive every rendered fact from handling data."""
    roots = _approved_roots(approved_roots)
    request = _mapping(document, "invalid_report_document")
    if request.get("schema") != REPORT_SCHEMA:
        raise ReportQualificationError("unsupported_report_schema")
    if "next" in request or "readerAction" in request:
        raise ReportQualificationError("preview_action_not_allowed")
    binding = _binding(request.get("binding"), "missing_request_binding")
    handling = _load_record(
        request.get("handlingRecord"), expected_kind="handling", expected_binding=binding, roots=roots,
    )
    handling_facts = _handling_facts(handling)

    if handling_facts.state == "paused" and "maintenanceRecord" in request:
        # The preview has no authenticated maintenance-authority mechanism.
        # Hash-valid local bytes cannot elevate a pause into a maintenance claim.
        raise ReportQualificationError("maintenance_authority_unqualified")

    if handling_facts.state in {"accepted", "investigating"}:
        _require_accepted_owner(request, binding, roots)
    elif request.get("ownershipRecord") is not None:
        _load_record(
            request.get("ownershipRecord"), expected_kind="ownership", expected_binding=binding, roots=roots,
        )

    recovery_reference = request.get("recoveryRecord")
    if handling_facts.state == "recovered":
        _require_recovery_observation(request, binding, roots, handling_facts)
    elif recovery_reference is not None:
        raise ReportQualificationError("unexpected_recovery_record")

    return QualifiedHumanReport(
        condition=handling_facts.condition,
        condition_ids=handling_facts.condition_ids,
        target=handling_facts.target,
        impact=handling_facts.impact,
        severity=handling_facts.severity,
        state=handling_facts.state,
        work_started=handling_facts.work_started,
        administrative_closure=handling_facts.administrative_closure,
        next_action=handling_facts.next_action,
        reader_action=handling_facts.reader_action,
        owner_decision=handling_facts.owner_decision,
        owner_action=handling_facts.owner_action,
        details_locator=handling.locator,
    )


def _status_and_icon(report: QualifiedHumanReport) -> tuple[str, str]:
    if report.state == "paused":
        return "⏸️", "Paused; recovery not verified"
    if report.state == "recovered":
        return "✅", "Service restored"
    if report.state == "closed":
        return "⚪", "Tracking closed without recovery proof"
    icons = {"critical": "🔴", "error": "🟠", "warning": "🟡", "info": "🔵"}
    icon = icons[report.severity]
    if report.state == "accepted":
        return icon, "Accepted; investigation not started"
    if report.state == "investigating":
        return icon, "Investigating"
    if report.state == "retained/unaccepted":
        return icon, "Retained; not accepted"
    if report.state == "waiting_approval":
        return icon, "Waiting for approval"
    if report.state == "recovery_unverified":
        return icon, "Recovery not verified"
    return icon, "Investigation blocked"


def _validated_limit(value: int | None, code: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ReportQualificationError(code)
    return value


def render_human_report(report: QualifiedHumanReport, *, limits: ReportLimits | None = None) -> str:
    """Render user-facing facts only; required content is never truncated."""
    limits = limits or ReportLimits()
    max_characters = _validated_limit(limits.max_characters, "invalid_character_limit")
    max_utf8_bytes = _validated_limit(limits.max_utf8_bytes, "invalid_utf8_byte_limit")
    icon, status = _status_and_icon(report)
    impact = "Impact not yet confirmed." if report.impact is None or report.impact.lower() == "unknown" else f"Impact: {report.impact}" + ("" if report.impact[-1:] in ".!?" else ".")
    lines = [
        f"{icon} *{report.condition} — {report.target}*",
        "",
        impact,
        f"Status: {status}",
        f"Next: {report.next_action}",
    ]
    if report.reader_action is not None:
        lines.append(f"Reader action: {report.reader_action}")
    lines.append(f"Details: {report.details_locator}")
    rendered = "\n".join(lines)
    if max_characters is not None and len(rendered) > max_characters:
        raise ReportQualificationError("report_exceeds_character_limit")
    if max_utf8_bytes is not None and len(rendered.encode("utf-8")) > max_utf8_bytes:
        raise ReportQualificationError("report_exceeds_utf8_byte_limit")
    return rendered


def qualify_report_file(path: Path, *, approved_roots: Iterable[Path | str]) -> QualifiedHumanReport:
    """Read one bounded preview request; no transport or state mutation occurs."""
    try:
        with path.open("rb") as request_file:
            contents = request_file.read(MAX_REQUEST_BYTES + 1)
    except OSError as exc:
        raise ReportQualificationError("report_input_unavailable") from exc
    if len(contents) > MAX_REQUEST_BYTES:
        raise ReportQualificationError("report_input_too_large")
    try:
        document = json.loads(contents.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReportQualificationError("report_input_unavailable") from exc
    return qualify_report(document, approved_roots=approved_roots)
