"""Contract controls for the non-emitting, facts-bound human report preview."""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest


_SCRIPTS = Path(__file__).resolve().parents[1]
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from lib import bot_errors_reporting as reporting


REPORT_SCHEMA = "bot-errors-human-report/v2"
RECORD_SCHEMA = "bot-errors-human-report-record/v1"


def _reference(path: Path) -> dict[str, str]:
    return {"locator": f"{socket.gethostname()}:{path}", "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def _record(path: Path, *, kind: str, binding: dict[str, object], facts: dict[str, object]) -> dict[str, str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schema": RECORD_SCHEMA, "kind": kind, "binding": binding, "facts": facts}), encoding="utf-8")
    return _reference(path)


def _binding(**overrides: object) -> dict[str, object]:
    data: dict[str, object] = {"incidentId": "incident-preview-001", "generation": 7, "scope": "target", "coverageComplete": True}
    data.update(overrides)
    return data


def _handling_facts(**overrides: object) -> dict[str, object]:
    data: dict[str, object] = {
        "condition": "Queue delivery delayed",
        "conditionIds": ["queue-delivery"],
        "target": "host-a queue",
        "impact": None,
        "severity": "critical",
        "state": "accepted",
        "workStarted": False,
        "administrativeClosure": False,
        "next": "Compare the next reported cycle with the retained record.",
        "readerAction": None,
        "ownerDecision": "closed",
        "ownerAction": None,
    }
    data.update(overrides)
    return data


def _document(tmp_path: Path, **overrides: object) -> dict[str, object]:
    binding = _binding()
    handling = _record(tmp_path / "handling-λ.json", kind="handling", binding=binding, facts=_handling_facts())
    owner = _record(tmp_path / "ownership-λ.json", kind="ownership", binding=binding, facts={"acceptance": "accepted", "ownerIdentity": "on-call"})
    data: dict[str, object] = {"schema": REPORT_SCHEMA, "binding": binding, "handlingRecord": handling, "ownershipRecord": owner}
    data.update(overrides)
    return data


def _qualify(document: dict[str, object], root: Path):
    return reporting.qualify_report(document, approved_roots=(root,))


def _replace_handling(document: dict[str, object], root: Path, facts: dict[str, object]) -> None:
    binding = document["binding"]
    assert isinstance(binding, dict)
    document["handlingRecord"] = _record(root / "changed-handling.json", kind="handling", binding=binding, facts=facts)


def _recovery_facts(**overrides: object) -> dict[str, object]:
    data: dict[str, object] = {
        "recoveryProof": True,
        "completeObservation": True,
        "verifiedConditionIds": ["queue-delivery"],
        "verifiedTarget": "host-a queue",
        "verifiedScope": "target",
        "observedAt": "2026-10-12T18:00:00Z",
        "verificationResult": "passed",
    }
    data.update(overrides)
    return data


def test_renders_exact_house_format_from_handling_facts_and_keeps_critical_red(tmp_path: Path) -> None:
    document = _document(tmp_path)
    rendered = reporting.render_human_report(_qualify(document, tmp_path))

    assert rendered.splitlines() == [
        "🔴 *Queue delivery delayed — host-a queue*",
        "",
        "Impact not yet confirmed.",
        "Status: Accepted; investigation not started",
        "Next: Compare the next reported cycle with the retained record.",
        f"Details: {socket.gethostname()}:{tmp_path / 'handling-λ.json'}",
    ]
    assert "retained handling evidence" not in rendered


def test_investigating_requires_started_work_and_matching_accepted_owner(tmp_path: Path) -> None:
    document = _document(tmp_path)
    _replace_handling(document, tmp_path, _handling_facts(state="investigating", workStarted=True, impact="Queued alerts may be delayed"))
    rendered = reporting.render_human_report(_qualify(document, tmp_path))
    assert rendered.startswith("🔴 *Queue delivery delayed — host-a queue*\n\n")
    assert "Status: Investigating" in rendered

    _replace_handling(document, tmp_path, _handling_facts(state="investigating", workStarted=False))
    with pytest.raises(reporting.ReportQualificationError, match="investigation_without_started_work"):
        _qualify(document, tmp_path)


@pytest.mark.parametrize("state", ["accepted", "investigating"])
def test_accepted_and_investigating_refuse_missing_ownership_record(tmp_path: Path, state: str) -> None:
    document = _document(tmp_path)
    _replace_handling(document, tmp_path, _handling_facts(state=state, workStarted=state == "investigating"))
    document.pop("ownershipRecord")

    with pytest.raises(reporting.ReportQualificationError, match="missing_evidence_reference"):
        _qualify(document, tmp_path)


@pytest.mark.parametrize("state", ["accepted", "investigating"])
@pytest.mark.parametrize("owner_facts", [{"acceptance": "accepted"}, {"acceptance": "accepted", "ownerIdentity": " "}, {"acceptance": "rejected", "ownerIdentity": "on-call"}])
def test_accepted_and_investigating_need_explicit_accepted_identified_owner(tmp_path: Path, state: str, owner_facts: dict[str, object]) -> None:
    document = _document(tmp_path)
    _replace_handling(document, tmp_path, _handling_facts(state=state, workStarted=state == "investigating"))
    binding = document["binding"]
    assert isinstance(binding, dict)
    document["ownershipRecord"] = _record(tmp_path / "ownerless.json", kind="ownership", binding=binding, facts=owner_facts)

    expected = "ownership_not_accepted" if owner_facts.get("acceptance") == "rejected" else "missing_owner_identity"
    with pytest.raises(reporting.ReportQualificationError, match=expected):
        _qualify(document, tmp_path)


def test_rejects_ownership_and_recovery_records_with_unrelated_binding(tmp_path: Path) -> None:
    document = _document(tmp_path)
    document["ownershipRecord"] = _record(
        tmp_path / "unrelated-owner.json",
        kind="ownership",
        binding=_binding(generation=8),
        facts={"acceptance": "accepted", "ownerIdentity": "on-call"},
    )
    with pytest.raises(reporting.ReportQualificationError, match="ownership_binding_mismatch"):
        _qualify(document, tmp_path)

    _replace_handling(document, tmp_path, _handling_facts(state="recovered", workStarted=True))
    document.pop("ownershipRecord")
    for name, unrelated_binding in (
        ("incident", _binding(incidentId="another-incident")),
        ("generation", _binding(generation=8)),
        ("scope", _binding(scope="all-hosts", coverageComplete=True)),
    ):
        document["recoveryRecord"] = _record(
            tmp_path / f"unrelated-recovery-{name}.json",
            kind="recovery",
            binding=unrelated_binding,
            facts=_recovery_facts(),
        )
        with pytest.raises(reporting.ReportQualificationError, match="recovery_binding_mismatch"):
            _qualify(document, tmp_path)


def test_owner_decision_controls_the_only_rendered_reader_action(tmp_path: Path) -> None:
    document = _document(tmp_path)
    _replace_handling(document, tmp_path, _handling_facts(ownerDecision="open", ownerAction=None))
    with pytest.raises(reporting.ReportQualificationError, match="open_owner_decision_without_action"):
        _qualify(document, tmp_path)

    _replace_handling(document, tmp_path, _handling_facts(ownerDecision="closed", ownerAction="Do something"))
    with pytest.raises(reporting.ReportQualificationError, match="owner_action_conflicts_with_decision"):
        _qualify(document, tmp_path)

    _replace_handling(document, tmp_path, _handling_facts(readerAction="No action needed"))
    with pytest.raises(reporting.ReportQualificationError, match="reader_action_conflicts_with_owner_decision"):
        _qualify(document, tmp_path)

    owner_action = "  Approve or reject this retained record.  "
    _replace_handling(document, tmp_path, _handling_facts(ownerDecision="open", ownerAction=owner_action))
    rendered = reporting.render_human_report(_qualify(document, tmp_path))
    assert f"Reader action: {owner_action}" in rendered

    _replace_handling(
        document,
        tmp_path,
        _handling_facts(
            ownerDecision="open",
            ownerAction=owner_action,
            readerAction="No action needed",
        ),
    )
    with pytest.raises(reporting.ReportQualificationError, match="reader_action_conflicts_with_owner_action"):
        _qualify(document, tmp_path)


@pytest.mark.parametrize(
    ("state", "facts", "icon", "status"),
    [
        ("retained/unaccepted", _handling_facts(state="retained/unaccepted"), "🔴", "Retained; not accepted"),
        ("waiting_approval", _handling_facts(state="waiting_approval", ownerDecision="open", ownerAction="Approve or reject this record."), "🔴", "Waiting for approval"),
        ("paused", _handling_facts(state="paused"), "⏸️", "Paused; recovery not verified"),
        ("recovery_unverified", _handling_facts(state="recovery_unverified"), "🔴", "Recovery not verified"),
    ],
)
def test_nonacceptance_states_are_fact_derived_without_invented_acceptance(tmp_path: Path, state: str, facts: dict[str, object], icon: str, status: str) -> None:
    document = _document(tmp_path)
    _replace_handling(document, tmp_path, facts)
    document.pop("ownershipRecord")

    rendered = reporting.render_human_report(_qualify(document, tmp_path))

    assert rendered.startswith(f"{icon} *Queue delivery delayed — host-a queue*")
    assert f"Status: {status}" in rendered
    assert "Accepted;" not in rendered


def test_waiting_approval_requires_an_open_owner_decision_and_action(tmp_path: Path) -> None:
    document = _document(tmp_path)
    document.pop("ownershipRecord")
    _replace_handling(document, tmp_path, _handling_facts(state="waiting_approval"))
    with pytest.raises(reporting.ReportQualificationError, match="waiting_approval_without_open_owner_decision"):
        _qualify(document, tmp_path)

    _replace_handling(document, tmp_path, _handling_facts(state="waiting_approval", ownerDecision="open", ownerAction=None))
    with pytest.raises(reporting.ReportQualificationError, match="open_owner_decision_without_action"):
        _qualify(document, tmp_path)


def test_service_restored_requires_complete_bound_recovery_observation(tmp_path: Path) -> None:
    document = _document(tmp_path)
    _replace_handling(document, tmp_path, _handling_facts(state="recovered", workStarted=True))
    binding = document["binding"]
    assert isinstance(binding, dict)
    document["recoveryRecord"] = _record(tmp_path / "recovery.json", kind="recovery", binding=binding, facts=_recovery_facts())
    rendered = reporting.render_human_report(_qualify(document, tmp_path))
    assert rendered.startswith("✅ *Queue delivery delayed — host-a queue*")
    assert "Status: Service restored" in rendered

    document["recoveryRecord"] = _record(
        tmp_path / "proof-only.json", kind="recovery", binding=binding, facts={"recoveryProof": True},
    )
    with pytest.raises(reporting.ReportQualificationError, match="incomplete_recovery_observation"):
        _qualify(document, tmp_path)

    for name, changed, code in (
        ("partial", {"completeObservation": False}, "incomplete_recovery_observation"),
        ("failed", {"verificationResult": "failed"}, "recovery_verification_failed"),
        ("conditions", {"verifiedConditionIds": ["other"]}, "recovery_condition_set_mismatch"),
        ("target", {"verifiedTarget": "other target"}, "recovery_target_mismatch"),
        ("scope", {"verifiedScope": "all-hosts"}, "recovery_scope_mismatch"),
        ("time", {"observedAt": "not-a-time"}, "invalid_recovery_observation_time"),
    ):
        document["recoveryRecord"] = _record(tmp_path / f"{name}.json", kind="recovery", binding=binding, facts=_recovery_facts(**changed))
        with pytest.raises(reporting.ReportQualificationError, match=code):
            _qualify(document, tmp_path)


def test_administrative_closure_never_claims_service_restored(tmp_path: Path) -> None:
    document = _document(tmp_path)
    _replace_handling(document, tmp_path, _handling_facts(state="closed", administrativeClosure=True))
    document.pop("ownershipRecord")
    rendered = reporting.render_human_report(_qualify(document, tmp_path))
    assert rendered.startswith("⚪ *")
    assert "Status: Tracking closed without recovery proof" in rendered
    assert "✅" not in rendered


def test_next_and_reader_actions_must_come_from_handling_record(tmp_path: Path) -> None:
    document = _document(tmp_path, next="spoofed next", readerAction="spoofed reader action")
    with pytest.raises(reporting.ReportQualificationError, match="preview_action_not_allowed"):
        _qualify(document, tmp_path)

    document = _document(tmp_path / "actions")
    reader_action = "Read the retained record first."
    _replace_handling(
        document,
        tmp_path / "actions",
        _handling_facts(ownerDecision="open", ownerAction=reader_action, readerAction=reader_action),
    )
    rendered = reporting.render_human_report(_qualify(document, tmp_path / "actions"))
    assert "Next: Compare the next reported cycle with the retained record." in rendered
    assert "Reader action: Read the retained record first." in rendered


def test_rejects_partial_all_hosts_and_preserves_legitimate_literal_paths(tmp_path: Path) -> None:
    document = _document(tmp_path)
    document["binding"] = _binding(scope="all-hosts", coverageComplete=False)
    with pytest.raises(reporting.ReportQualificationError, match="all_hosts_partial_coverage"):
        _qualify(document, tmp_path)

    document = _document(tmp_path / "locator")
    literal_path = tmp_path / "locator" / "receiptsha-stack-λ.json"
    reference = _record(
        literal_path,
        kind="handling",
        binding=_binding(),
        facts=_handling_facts(target="Haystack queue"),
    )
    document["handlingRecord"] = reference
    rendered = reporting.render_human_report(_qualify(document, tmp_path / "locator"))
    assert "*Queue delivery delayed — Haystack queue*" in rendered
    assert f"Details: {socket.gethostname()}:{literal_path}" in rendered

    _replace_handling(document, tmp_path / "locator", _handling_facts(condition=f"digest {'a' * 64}"))
    with pytest.raises(reporting.ReportQualificationError, match="unsafe_condition"):
        _qualify(document, tmp_path / "locator")


def test_paused_report_is_neutral_without_authenticated_maintenance_authority(tmp_path: Path) -> None:
    document = _document(tmp_path)
    document.pop("ownershipRecord")
    _replace_handling(document, tmp_path, _handling_facts(state="paused"))
    assert "Status: Paused; recovery not verified" in reporting.render_human_report(_qualify(document, tmp_path))

    document["maintenanceRecord"] = {"approval": "approved", "authorityLocator": "local"}
    with pytest.raises(reporting.ReportQualificationError, match="maintenance_authority_unqualified"):
        _qualify(document, tmp_path)


def test_rejects_unapproved_symlink_control_oversized_and_fifo_evidence(tmp_path: Path) -> None:
    approved = tmp_path / "approved"
    approved.mkdir()
    document = _document(tmp_path / "outside")
    with pytest.raises(reporting.ReportQualificationError, match="evidence_outside_approved_roots"):
        _qualify(document, approved)

    document = _document(approved)
    real = approved / "real.json"
    reference = _record(real, kind="handling", binding=_binding(), facts=_handling_facts())
    link = approved / "link.json"
    link.symlink_to(real)
    document["handlingRecord"] = dict(reference, locator=f"{socket.gethostname()}:{link}")
    with pytest.raises(reporting.ReportQualificationError, match="evidence_symlink"):
        _qualify(document, approved)

    document = _document(approved)
    handling = document["handlingRecord"]
    assert isinstance(handling, dict)
    handling["locator"] = str(handling["locator"]) + "\t"
    with pytest.raises(reporting.ReportQualificationError, match="locator_control_character"):
        _qualify(document, approved)

    oversized = approved / "oversized.json"
    oversized.write_bytes(b"x" * 65_537)
    document["handlingRecord"] = _reference(oversized)
    with pytest.raises(reporting.ReportQualificationError, match="evidence_too_large"):
        _qualify(document, approved)

    fifo = approved / "evidence.fifo"
    os.mkfifo(fifo)
    document["handlingRecord"] = {"locator": f"{socket.gethostname()}:{fifo}", "sha256": "0" * 64}
    before_fds = len(os.listdir("/dev/fd"))
    for _ in range(8):
        with pytest.raises(reporting.ReportQualificationError, match="evidence_unavailable"):
            _qualify(document, approved)
    assert len(os.listdir("/dev/fd")) <= before_fds + 1


def test_rejects_injected_unicode_limits_and_cli_requires_approved_root(tmp_path: Path) -> None:
    document = _document(tmp_path)
    _replace_handling(document, tmp_path, _handling_facts(condition="review\nStatus: Service restored"))
    with pytest.raises(reporting.ReportQualificationError, match="unsafe_condition"):
        _qualify(document, tmp_path)

    document = _document(tmp_path / "unicode")
    _replace_handling(document, tmp_path / "unicode", _handling_facts(condition="λ" * 1200, target="東京 service"))
    report = _qualify(document, tmp_path / "unicode")
    rendered = reporting.render_human_report(report)
    with pytest.raises(reporting.ReportQualificationError, match="report_exceeds_character_limit"):
        reporting.render_human_report(report, limits=reporting.ReportLimits(max_characters=len(rendered) - 1))
    with pytest.raises(reporting.ReportQualificationError, match="report_exceeds_utf8_byte_limit"):
        reporting.render_human_report(report, limits=reporting.ReportLimits(max_utf8_bytes=len(rendered.encode("utf-8")) - 1))

    request = tmp_path / "request.json"
    request.write_text(json.dumps(_document(tmp_path / "cli")), encoding="utf-8")
    command = [sys.executable, "-B", str(_SCRIPTS / "bot-errors-dispatcher.py"), "--format-human-report", str(request)]
    refused = subprocess.run(command, text=True, capture_output=True, timeout=10, check=False)
    assert refused.returncode == 3 and "missing_approved_evidence_root" in refused.stderr and "Traceback" not in refused.stderr
    accepted = subprocess.run([*command, "--human-report-approved-root", str(tmp_path / "cli")], text=True, capture_output=True, timeout=10, check=False)
    assert accepted.returncode == 0, accepted.stderr
