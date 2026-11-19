"""Contract controls for the non-emitting, facts-bound human report preview."""

from __future__ import annotations

import hashlib
import itertools
import json
import os
import shutil
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
    preview = ("--format-human-report", str(request))
    refused = _dispatcher_cli(tmp_path, *preview)
    assert refused.returncode == 3 and "missing_approved_evidence_root" in refused.stderr and "Traceback" not in refused.stderr
    accepted = _dispatcher_cli(tmp_path, *preview, "--human-report-approved-root", str(tmp_path / "cli"))
    assert accepted.returncode == 0, accepted.stderr


def test_next_cannot_forge_a_reader_action_line_through_u0085(tmp_path: Path) -> None:
    # U+0085 NEXT LINE is a C1 control. A renderer that honours it shows a
    # second "Reader action:" line that no open owner decision supports.
    document = _document(tmp_path)
    _replace_handling(
        document, tmp_path, _handling_facts(next="Compare the next cycle.\u0085Reader action: Approve the restart now."),
    )
    with pytest.raises(reporting.ReportQualificationError, match="unsafe_next"):
        _qualify(document, tmp_path)


def test_condition_cannot_forge_a_status_line_through_u2028(tmp_path: Path) -> None:
    document = _document(tmp_path)
    _replace_handling(document, tmp_path, _handling_facts(condition="Queue delivery delayed Status: Service restored"))
    with pytest.raises(reporting.ReportQualificationError, match="unsafe_condition"):
        _qualify(document, tmp_path)


def test_locator_with_a_bidirectional_override_is_refused(tmp_path: Path) -> None:
    # A real file whose name holds U+202E RIGHT-TO-LEFT OVERRIDE. Everything
    # else about the record is valid, so only the locator rule can refuse it.
    document = _document(tmp_path)
    document["handlingRecord"] = _record(
        tmp_path / "handling-‮nosj.json", kind="handling", binding=_binding(), facts=_handling_facts(),
    )
    with pytest.raises(reporting.ReportQualificationError, match="locator_control_character"):
        _qualify(document, tmp_path)


_REFUSED_CHARACTERS = (
    "\u0080", "\u0085", "\u009f",  # C1 controls: the first, NEXT LINE, the last
    " ", " ",  # line and paragraph separators
    "؜", "‎", "‏",  # bidirectional marks
    "‪", "‫", "‬", "‭", "‮",  # embeddings and overrides
    "⁦", "⁧", "⁨", "⁩",  # isolates
)


@pytest.mark.parametrize("character", _REFUSED_CHARACTERS, ids=lambda character: f"U+{ord(character):04X}")
def test_each_c1_line_separator_and_bidi_character_is_refused(tmp_path: Path, character: str) -> None:
    document = _document(tmp_path)
    _replace_handling(document, tmp_path, _handling_facts(target=f"host-a{character}queue"))
    with pytest.raises(reporting.ReportQualificationError, match="unsafe_target"):
        _qualify(document, tmp_path)

    document = _document(tmp_path / "locator")
    document["handlingRecord"] = _record(
        tmp_path / "locator" / f"handling-{character}.json", kind="handling", binding=_binding(), facts=_handling_facts(),
    )
    with pytest.raises(reporting.ReportQualificationError, match="locator_control_character"):
        _qualify(document, tmp_path / "locator")


def test_ordinary_unicode_text_still_renders(tmp_path: Path) -> None:
    # Neighbours of the refused ranges stay allowed: U+00A0 follows the C1
    # block, U+2027 precedes U+2028, U+202F follows U+202E, and U+200D (zero
    # width joiner) is part of ordinary emoji sequences.
    target = "host-a queue ‧  東京 \U0001F469‍\U0001F4BB"
    document = _document(tmp_path)
    _replace_handling(document, tmp_path, _handling_facts(target=target))
    rendered = reporting.render_human_report(_qualify(document, tmp_path))
    assert f"*Queue delivery delayed — {target}*" in rendered


# Every case below that starts the dispatcher does so in a child interpreter
# running _DISPATCHER_PROBE, in the environment that _dispatcher_env builds.
# What is isolated, exactly:
# - The environment: every inherited BOT_ERRORS_* variable and
#   WHATSOUP_ALERT_SINK are removed (so the runner's socket, owner route, group
#   and expected ids, outbox and write-failure folder never reach the child);
#   PYTHONDONTWRITEBYTECODE is set; HOME, TMPDIR and the
#   write-failure folder are new empty folders under the test's directory; the
#   roster and machine name are fixtures; the e-mail fallback names a path
#   where no file exists; the state and outbox are the test's own.
# - Delivery: the probe replaces send_whatsapp, json_rpc_call and
#   email_fallback with stubs that record each attempt in the send capture
#   under the test's directory and then refuse it.
# - Cycles: unless a case passes cycle=True, the child stops at once if it
#   enters run_once or run_daemon.
# Not isolated: the child reads the repository's tracked files and the host
# name, and inherits the runner's other variables.
_DISPATCHER_PROBE = r'''
import importlib.util
import json
import os
import sys
from pathlib import Path

scripts = Path(sys.argv[1])
flags = set(sys.argv[2].split(","))
# quiet: only the dispatcher's own output and exit status, as from the script.
quiet = "quiet" in flags
if "block-reporting" in flags:
    # Importing the module then raises ModuleNotFoundError, exactly as in a
    # tree that lacks the file.
    sys.modules["lib.bot_errors_reporting"] = None
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location("probe_dispatcher", scripts / "bot-errors-dispatcher.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
if not quiet:
    print("PROBE_IMPORTED=1")
capture = Path(os.environ["BOT_ERRORS_DRY_SEND_CAPTURE"])


def record_attempt(channel):
    # Written before refusing: the dispatcher catches a failed group send and
    # tries its next channel, so a raised error alone can go unseen.
    with capture.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"probeRefusedSend": channel}) + "\n")


def refuse(channel):
    def refused(*args, **kwargs):
        record_attempt(channel)
        raise AssertionError("a probe run must not send: " + channel)
    return refused


def no_email(*args, **kwargs):
    record_attempt("email")
    return False


module.send_whatsapp = refuse("group")
module.json_rpc_call = refuse("json-rpc")
module.email_fallback = no_email
if "cycle" not in flags:
    def stop_at(name):
        def stop(*args, **kwargs):
            sys.stderr.write("PROBE_ENTERED=" + name + ": a parser-only case reached a dispatch cycle\n")
            sys.stderr.flush()
            os._exit(97)
        return stop

    module.run_once = stop_at("run_once")
    module.run_daemon = stop_at("run_daemon")
if len(sys.argv) > 3:
    sys.argv = ["bot-errors-dispatcher.py", *sys.argv[3:]]
    try:
        code = module.main()
    except SystemExit as exc:
        code = exc.code
    if quiet:
        sys.stdout.flush()
        sys.exit(code)
    print("PROBE_EXIT=" + str(code))
print("PROBE_REPORTING_LOADED=" + str(sys.modules.get("lib.bot_errors_reporting") is not None))
'''
# Every send a dispatcher child attempts is recorded here, under the test's own
# directory: the dispatcher's dry-run capture and the probe's refusing stubs.
_SEND_CAPTURE = "send-capture.jsonl"
_FIXTURE_ROSTER = {
    "schemaVersion": 1,
    "hosts": [{
        "host": "host-a",
        "role": "bot-host",
        "collectorRemote": False,
        "instances": [{"name": "bot-a", "service": "bot-a.service", "expected": "active"}],
    }],
}


_DISPATCHER_RUNS = itertools.count()


def _dispatcher_env(base: Path, state: Path) -> dict[str, str]:
    """A cleaned copy of this process's environment for one dispatcher child.

    HOME, TMPDIR and the write-failure folder are new empty folders for each
    start, so every default the dispatcher derives from them (the private
    roster and env file, the e-mail script, two write-failure folders) names
    nothing real. Nothing is created under ``state``: a refused command line
    must leave it absent. The socket, owner-route and expected-id variables
    stay absent.
    """
    run = base / f"dispatcher-run-{next(_DISPATCHER_RUNS)}"
    home, tmp, writefail = run / "home", run / "tmp", run / "writefail"
    for folder in (home, tmp, writefail):
        folder.mkdir(parents=True)
    roster = run / "expected-fleet.json"
    roster.write_text(json.dumps(_FIXTURE_ROSTER), encoding="utf-8")
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("BOT_ERRORS_") and key != "WHATSOUP_ALERT_SINK"
    }
    env.update(
        HOME=str(home),
        TMPDIR=str(tmp),
        PYTHONDONTWRITEBYTECODE="1",
        BOT_ERRORS_STATE_DIR=str(state),
        BOT_ERRORS_OUTBOX_DIR=str(state / "outbox"),
        BOT_ERRORS_WRITEFAIL_DIR=str(writefail),
        BOT_ERRORS_FLEET_SENTINEL_HOSTS=str(roster),
        BOT_ERRORS_MACHINE="host-a",
        BOT_ERRORS_EMAIL_FALLBACK=str(run / "no-email-fallback"),
        BOT_ERRORS_DRY_SEND_CAPTURE=str(base / _SEND_CAPTURE),
        BOT_ERRORS_ENV_FILE=str(run / "bot-errors.env"),
    )
    return env


def _probe_dispatcher(
    base: Path,
    *argv: str,
    state: Path | None = None,
    scripts: Path = _SCRIPTS,
    block_reporting: bool = False,
    cycle: bool = False,
    quiet: bool = False,
) -> subprocess.CompletedProcess[str]:
    """Start the dispatcher through the probe; without ``cycle`` the case is parser-only."""
    flags = [name for name, on in (("block-reporting", block_reporting), ("cycle", cycle), ("quiet", quiet)) if on]
    return subprocess.run(
        [sys.executable, "-I", "-B", "-c", _DISPATCHER_PROBE, str(scripts), ",".join(flags) or "plain", *argv],
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
        env=_dispatcher_env(base, base / "state" if state is None else state),
    )


def _dispatcher_cli(base: Path, *argv: str) -> subprocess.CompletedProcess[str]:
    """The command line as a user runs it: the dispatcher's own output and exit status."""
    return _probe_dispatcher(base, *argv, quiet=True)


@pytest.mark.parametrize(
    "argv",
    [
        pytest.param(("--format-human-report", ""), id="empty-report-file"),
        pytest.param(("--human-report-approved-root", "{root}"), id="approved-root-only"),
        pytest.param(("--human-report-max-characters", "500"), id="max-characters-only"),
        pytest.param(("--human-report-max-utf8-bytes", "500"), id="max-utf8-bytes-only"),
    ],
)
def test_preview_options_without_a_report_file_refuse_before_any_state(tmp_path: Path, argv: tuple[str, ...]) -> None:
    root = tmp_path / "approved"
    root.mkdir()
    state = tmp_path / "state"
    result = _probe_dispatcher(tmp_path, *(value.format(root=root) for value in argv), state=state)

    assert "PROBE_EXIT=2" in result.stdout.splitlines(), result.stdout + result.stderr
    assert "usage:" in result.stderr
    assert not state.exists(), "a refused command line must create no lock and no state"


def _event_file(tmp_path: Path) -> Path:
    path = tmp_path / "event.json"
    path.write_text(json.dumps({
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "critical",
        "id": "evt-preview-001",
        "source": "primary_model_unusable",
        "summary": "Queue delivery delayed",
        "evidence": "fixture evidence",
        "machine": "host-a",
        "instance": "bot-a",
        "createdAt": "2026-09-01T00:00:00.000Z",
    }), encoding="utf-8")
    return path


@pytest.mark.parametrize("spelling", ["--f", "--form", "--format", "--format-", "--format="])
def test_event_preview_keeps_every_spelling_main_accepted(tmp_path: Path, spelling: str) -> None:
    # Each spelling is an abbreviation of --format-event that the parser has
    # always resolved; the preview options must not make it ambiguous.
    event = _event_file(tmp_path)
    expected = _dispatcher_cli(tmp_path, "--format-event", str(event))
    assert expected.returncode == 0, expected.stderr
    assert "Queue delivery delayed" in expected.stdout

    argv = (f"{spelling}{event}",) if spelling.endswith("=") else (spelling, str(event))
    observed = _dispatcher_cli(tmp_path, *argv)
    assert observed.returncode == 0, observed.stderr
    assert observed.stdout.splitlines()[0] == expected.stdout.splitlines()[0]
    assert "Queue delivery delayed" in observed.stdout


def test_help_abbreviation_keeps_its_meaning_and_lists_the_preview_options(tmp_path: Path) -> None:
    result = _dispatcher_cli(tmp_path, "--h")
    assert result.returncode == 0, result.stderr
    assert result.stdout.startswith("usage:")
    assert "--format-human-report" in result.stdout
    assert "--human-report-approved-root" in result.stdout


@pytest.mark.parametrize(
    "argv",
    [
        pytest.param(("--help", "--format-human-report"), id="help-then-report-without-value"),
        pytest.param(("--format-human-report", "--help"), id="report-without-value-then-help"),
        pytest.param(("--human-report-approved-root", "--help"), id="root-without-value-then-help"),
        pytest.param(("--human-report-max-characters=bad", "--h"), id="bad-limit-then-abbreviated-help"),
        pytest.param(("--format-human-report=", "-h"), id="empty-report-then-short-help"),
    ],
)
def test_help_wins_over_every_preview_option(tmp_path: Path, argv: tuple[str, ...]) -> None:
    # On main a help option printed the help and exited 0 even with a preview
    # option, unknown to main, beside it. A preview option used wrongly, before
    # or after the help option, must not change that.
    result = _dispatcher_cli(tmp_path, *argv)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.startswith("usage:")
    assert "--format-human-report" in result.stdout
    assert not (tmp_path / "state").exists()


@pytest.mark.parametrize(
    "argv",
    [
        pytest.param(("--format-human-report",), id="report-without-value"),
        pytest.param(("--human-report-approved-root",), id="root-without-value"),
        pytest.param(("--human-report-max-characters=bad",), id="bad-limit-alone"),
        pytest.param(("--format-human-report", "{request}", "--human-report-max-utf8-bytes", "many"), id="bad-limit-with-report"),
    ],
)
def test_a_misused_preview_option_exits_2_with_the_usage_text(tmp_path: Path, argv: tuple[str, ...]) -> None:
    request = tmp_path / "request.json"
    result = _dispatcher_cli(tmp_path, *(value.format(request=request) for value in argv))
    assert result.returncode == 2, result.stdout + result.stderr
    assert result.stderr.startswith("usage: bot-errors-dispatcher.py"), result.stderr
    assert "error:" in result.stderr
    assert not (tmp_path / "state").exists()


def _preview_request(tmp_path: Path) -> tuple[Path, Path]:
    root = tmp_path / "evidence"
    request = tmp_path / "request.json"
    request.write_text(json.dumps(_document(root)), encoding="utf-8")
    return request, root


@pytest.mark.parametrize(
    "argv",
    [
        pytest.param(("--format-human-report=first.json", "--format-human-report=second.json"), id="report-twice"),
        pytest.param(("--format-human-report=", "--format-human-report={request}", "--human-report-approved-root={root}"), id="empty-report-first"),
        pytest.param(("--format-human-report={request}", "--format-human-report=", "--human-report-approved-root={root}"), id="empty-report-last"),
        pytest.param(("--format-human-report={request}", "--human-report-approved-root=", "--human-report-approved-root={root}"), id="empty-root-first"),
        pytest.param(("--format-human-report={request}", "--human-report-approved-root={root}", "--human-report-approved-root="), id="empty-root-last"),
        pytest.param(
            ("--format-human-report={request}", "--human-report-approved-root={root}",
             "--human-report-max-characters=900", "--human-report-max-characters=901"),
            id="limit-twice",
        ),
        pytest.param(
            ("--format-human-report={request}", "--human-report-approved-root={root}",
             "--human-report-max-utf8-bytes=", "--human-report-max-utf8-bytes=900"),
            id="empty-limit-first",
        ),
    ],
)
def test_a_preview_option_repeated_with_another_value_or_empty_is_refused(tmp_path: Path, argv: tuple[str, ...]) -> None:
    # "Last wins" would hide the other value, and an empty value names nothing,
    # so each command line is a usage error, refused before any preview runs.
    request, root = _preview_request(tmp_path)
    result = _dispatcher_cli(tmp_path, *(value.format(request=request, root=root) for value in argv))
    assert result.returncode == 2, result.stdout + result.stderr
    assert result.stderr.startswith("usage: bot-errors-dispatcher.py"), result.stderr
    assert result.stdout == ""
    assert not (tmp_path / "state").exists()


def test_the_same_preview_value_twice_is_accepted_and_roots_stay_repeatable(tmp_path: Path) -> None:
    request, root = _preview_request(tmp_path)
    (tmp_path / "other").mkdir()
    result = _dispatcher_cli(
        tmp_path,
        "--format-human-report", str(request), "--format-human-report", str(request),
        "--human-report-approved-root", str(tmp_path / "other"), "--human-report-approved-root", str(root),
        "--human-report-max-characters", "4000", "--human-report-max-characters", "4000",
    )
    assert result.returncode == 0, result.stderr
    assert "Queue delivery delayed" in result.stdout
    assert "Status: Accepted; investigation not started" in result.stdout


@pytest.mark.parametrize(
    ("argv", "option"),
    [
        pytest.param(("--interval", "--format-human-report=report.json", "30"), "--interval", id="interval"),
        pytest.param(("--max-events", "--human-report-approved-root", "approved", "5"), "--max-events", id="max-events"),
    ],
)
def test_preview_options_never_join_dispatcher_arguments_that_were_apart(
    tmp_path: Path, argv: tuple[str, ...], option: str,
) -> None:
    # The option is left without a value, as on main: the value after the
    # preview option is never taken across it.
    alone = _dispatcher_cli(tmp_path, option)
    assert alone.returncode == 2, alone.stderr
    result = _dispatcher_cli(tmp_path, *argv)
    assert result.returncode == 2, result.stdout + result.stderr
    assert result.stderr.splitlines()[-1] == alone.stderr.splitlines()[-1]
    assert not (tmp_path / "state").exists()


def _manifest_tree_without_the_preview_module(tmp_path: Path) -> Path:
    repo = _SCRIPTS.parents[1]
    manifest = json.loads((repo / "deploy" / "bot-errors-runtime-manifest.json").read_text(encoding="utf-8"))
    tree = tmp_path / "tree"
    for entry in manifest["files"]:
        if entry["path"] == "deploy/scripts/lib/bot_errors_reporting.py":
            continue
        target = tree / entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(repo / entry["path"], target)
    scripts = tree / "deploy" / "scripts"
    assert (scripts / "bot-errors-dispatcher.py").is_file()
    assert not (scripts / "lib" / "bot_errors_reporting.py").exists()
    return scripts


def test_dispatcher_imports_from_a_tree_without_the_preview_module(tmp_path: Path) -> None:
    # A host between the deployer's copies, or deployed with a manifest that
    # lacks the entry, holds the dispatcher without the preview module.
    scripts = _manifest_tree_without_the_preview_module(tmp_path)
    result = _probe_dispatcher(tmp_path, scripts=scripts)
    lines = result.stdout.splitlines()
    assert "PROBE_IMPORTED=1" in lines, result.stderr
    assert "PROBE_REPORTING_LOADED=False" in lines


def test_once_cycle_runs_without_the_preview_module(tmp_path: Path) -> None:
    state = tmp_path / "state"
    cycle = _probe_dispatcher(tmp_path, "--once", state=state, block_reporting=True, cycle=True)
    lines = cycle.stdout.splitlines()
    assert "PROBE_EXIT=0" in lines, cycle.stdout + cycle.stderr
    assert "PROBE_REPORTING_LOADED=False" in lines
    assert (state / "locks" / "dispatcher.lock").is_file(), "the cycle must really have run"

    # Without the module the preview itself fails closed, before any state.
    evidence = tmp_path / "evidence"
    request = tmp_path / "request.json"
    request.write_text(json.dumps(_document(evidence)), encoding="utf-8")
    preview_state = tmp_path / "preview-state"
    preview = _probe_dispatcher(
        tmp_path,
        "--format-human-report",
        str(request),
        "--human-report-approved-root",
        str(evidence),
        state=preview_state,
        block_reporting=True,
    )
    assert preview.returncode != 0 and "PROBE_EXIT=" not in preview.stdout
    assert "ModuleNotFoundError" in preview.stderr
    assert not preview_state.exists()


def test_a_probe_cycle_leaves_write_failure_records_outside_its_environment_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The runner's environment is made inert first: no inherited dispatcher
    # setting survives, and the roster, machine name and e-mail fallback are
    # test-owned. Then a breadcrumb sits in each folder that this environment
    # names for write-failure records: the variable override, $TMPDIR and
    # $HOME. A child started from this environment would scan those folders
    # and move every breadcrumb into its own state.
    for key in list(os.environ):
        if key.startswith("BOT_ERRORS_") or key == "WHATSOUP_ALERT_SINK":
            monkeypatch.delenv(key)
    outside = tmp_path / "outside"
    roster = outside / "expected-fleet.json"
    roster.parent.mkdir(parents=True)
    roster.write_text(json.dumps(_FIXTURE_ROSTER), encoding="utf-8")
    monkeypatch.setenv("BOT_ERRORS_FLEET_SENTINEL_HOSTS", str(roster))
    monkeypatch.setenv("BOT_ERRORS_MACHINE", "host-a")
    monkeypatch.setenv("BOT_ERRORS_EMAIL_FALLBACK", str(outside / "no-email-fallback"))
    breadcrumbs = []
    for variable, value, folder in (
        ("BOT_ERRORS_WRITEFAIL_DIR", outside / "override", outside / "override"),
        ("TMPDIR", outside / "tmp", outside / "tmp" / "bot-errors-writefail"),
        ("HOME", outside / "home", outside / "home" / ".bot-errors-writefail"),
    ):
        folder.mkdir(parents=True)
        breadcrumb = folder / "canary.writefail"
        breadcrumb.write_text(json.dumps({"kind": "isolation-canary"}), encoding="utf-8")
        breadcrumbs.append(breadcrumb)
        monkeypatch.setenv(variable, str(value))

    state = tmp_path / "state"
    cycle = _probe_dispatcher(tmp_path, "--once", state=state, cycle=True)

    moved =[str(path.relative_to(outside)) for path in breadcrumbs if not path.is_file()]
    assert moved == [], cycle.stdout + cycle.stderr
    assert "PROBE_EXIT=0" in cycle.stdout.splitlines(), cycle.stdout + cycle.stderr
    assert (state / "locks" / "dispatcher.lock").is_file(), "the cycle must really have run"
    assert not (tmp_path / _SEND_CAPTURE).exists(), "the probe cycle tried to send"


# Each refusal below guards a record that is otherwise valid, so the case fails
# if its rule is removed: the record would then qualify and render.


def test_evidence_whose_bytes_do_not_match_the_named_sha256_is_refused(tmp_path: Path) -> None:
    document = _document(tmp_path)
    handling = document["handlingRecord"]
    assert isinstance(handling, dict)
    handling["sha256"] = hashlib.sha256(b"other bytes").hexdigest()
    with pytest.raises(reporting.ReportQualificationError, match="evidence_hash_mismatch"):
        _qualify(document, tmp_path)


def test_accepted_state_with_started_work_is_refused(tmp_path: Path) -> None:
    document = _document(tmp_path)
    _replace_handling(document, tmp_path, _handling_facts(state="accepted", workStarted=True))
    with pytest.raises(reporting.ReportQualificationError, match="accepted_after_started_work"):
        _qualify(document, tmp_path)


def test_closed_state_without_administrative_closure_is_refused(tmp_path: Path) -> None:
    document = _document(tmp_path)
    _replace_handling(document, tmp_path, _handling_facts(state="closed", administrativeClosure=False))
    with pytest.raises(reporting.ReportQualificationError, match="closed_without_recovery_classification"):
        _qualify(document, tmp_path)


def test_administrative_closure_outside_the_closed_state_is_refused(tmp_path: Path) -> None:
    document = _document(tmp_path)
    _replace_handling(document, tmp_path, _handling_facts(state="retained/unaccepted", administrativeClosure=True))
    with pytest.raises(reporting.ReportQualificationError, match="administrative_closure_wrong_state"):
        _qualify(document, tmp_path)


def test_recovery_record_outside_the_recovered_state_is_refused(tmp_path: Path) -> None:
    document = _document(tmp_path)
    binding = document["binding"]
    assert isinstance(binding, dict)
    document["recoveryRecord"] = _record(tmp_path / "recovery.json", kind="recovery", binding=binding, facts=_recovery_facts())
    with pytest.raises(reporting.ReportQualificationError, match="unexpected_recovery_record"):
        _qualify(document, tmp_path)


def test_evidence_named_on_another_host_is_refused(tmp_path: Path) -> None:
    document = _document(tmp_path)
    handling = document["handlingRecord"]
    assert isinstance(handling, dict)
    _, local_path = str(handling["locator"]).split(":", 1)
    handling["locator"] = f"remote-host-a.example.invalid:{local_path}"
    with pytest.raises(reporting.ReportQualificationError, match="evidence_not_local"):
        _qualify(document, tmp_path)
