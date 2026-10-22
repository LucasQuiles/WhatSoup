"""Daily-health display preserves complete findings without changing incident state."""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

import pytest
from hypothesis import HealthCheck, example, given, settings
from hypothesis import strategies as st

_TESTS = Path(__file__).resolve().parent
if str(_TESTS) not in sys.path:
    sys.path.insert(0, str(_TESTS))

from support.dispatcher_fixtures import load_module_from_path

# Property examples only format fresh events; the loaded module has no per-example
# state. Tests that vary the cap explicitly set it on every example.
_render_properties = settings(
    max_examples=40, deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)


@pytest.fixture()
def dispatcher(monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_MAX_MESSAGE_CHARS", "5500")
    return load_module_from_path(
        "bot_errors_daily_health_rendering", _TESTS.parent / "bot-errors-dispatcher.py"
    )


def daily_event(evidence):
    return {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "critical",
        "id": "daily-render-case",
        "createdAt": "2026-09-06T00:00:00Z",
        "machine": "host-a",
        "instance": "instance-a",
        "source": "daily-health",
        "summary": "Daily health found credential issues",
        "evidence": evidence,
        "criticalAsset": {
            "asset": {"kind": "credential", "instance": "instance-a", "owner": "whatsoup"},
            "failure": {
                "code": "credential_permission_drift",
                "domain": "credentials",
                "recoverability": "operator_action_required",
                "confidence": "confirmed",
                "operatorAction": "Restore private file permissions and rerun daily health.",
                "clearRequirement": "The same credential passes the permission check.",
            },
        },
    }


def evidence_body(text):
    return text.split("  > evidence: ", 1)[1].split("\n  > ", 1)[0]


@given(context=st.text(alphabet="abcdefghijklmnopqrstuvwxyz αβ界", max_size=80))
@example(context="")
@_render_properties
def test_daily_line_membership_is_shared_without_new_normalization(dispatcher, context):
    health = load_module_from_path(
        "bot_errors_daily_health_rendering_producer", _TESTS.parent / "bot-errors-health-check.py"
    )

    cases = [
        (f"FAIL {context}", True, False),
        (f"{context} FAIL embedded", True, False),
        (f"WARN {context}", False, True),
        (f"{context} WARN embedded", False, True),
        (f"WARN {context} FAIL overlapping", True, True),
        (f"config {context}: invalid JSON", True, False),
        (f"config {context}: invalid json", False, False),
        (f"fail {context}", False, False),
        (f"FAILURE {context}", False, False),
        (f"OK {context}", False, False),
    ]
    for line, failure, warning in cases:
        assert dispatcher.daily_health_line_is_failure(line) is failure, line
        assert dispatcher.daily_health_line_is_warning(line) is warning, line
    assert health.daily_health_line_is_failure is dispatcher.daily_health_line_is_failure
    assert health.daily_health_line_is_warning is dispatcher.daily_health_line_is_warning


def test_routine_prefix_cannot_hide_complete_failure(dispatcher):
    finding = "FAIL credential target-file.env: mode=0644 is not private"
    event = daily_event("\n".join(["OK routine " + "x" * 80] * 35 + [finding]))

    text = dispatcher.format_event(event)

    assert finding in text
    assert "requested_action:" in text
    assert "evidence_omitted:" in text
    assert len(text) <= dispatcher.MAX_MESSAGE_CHARS


def test_priority_is_stable_and_preserves_duplicate_line_occurrences(dispatcher):
    event = daily_event("\n".join([
        "OK context first",
        "WARN first warning",
        "probe FAIL first failure",
        "probe WARN and FAIL mixed membership",
        "FAIL duplicate finding",
        "FAIL duplicate finding",
        "config instance-a: invalid JSON",
        "probe WARN second warning",
    ]))

    lines = evidence_body(dispatcher.format_event(event)).splitlines()

    assert lines == [
        "probe FAIL first failure",
        "probe WARN and FAIL mixed membership",
        "FAIL duplicate finding",
        "FAIL duplicate finding",
        "config instance-a: invalid JSON",
        "WARN first warning",
        "probe WARN second warning",
        "OK context first",
    ]


def test_long_optional_metadata_cannot_displace_identity_action_or_evidence(dispatcher):
    finding = "FAIL credential target-file.env: mode=0666 is not private"
    event = daily_event(finding)
    event["diagnostics"] = {"logHints": ["log " + "z" * 1000] * 5, "queue": "q" * 1000}
    event["process"] = {"cwd": "working-directory-" * 100}
    event["platform"] = "platform-detail-" * 100

    text = dispatcher.format_event(event)

    assert finding in text
    assert "incident_key: host-a|instance-a|" in text
    assert "failure_code: credential_permission_drift" in text
    assert event["criticalAsset"]["failure"]["operatorAction"] in text
    assert "diagnostics_omitted:" in text
    assert len(text) <= dispatcher.MAX_MESSAGE_CHARS


def test_oversized_finding_is_omitted_whole_without_hiding_shorter_findings(dispatcher):
    oversized = "FAIL oversized-asset " + "x" * 3000
    complete = "FAIL credential target-file.env: mode=0644 is not private"

    text = dispatcher.format_event(daily_event(oversized + "\n" + complete))

    assert complete in text
    assert "FAIL oversized-asset" not in text
    assert "failure_lines=1" in text
    assert "incomplete finding coverage" in text
    assert len(evidence_body(text)) <= 1800


def test_omission_counts_are_occurrences_not_incidents(dispatcher):
    event = daily_event("\n".join([
        "FAIL repeated " + "f" * 2000,
        "FAIL repeated " + "f" * 2000,
        "WARN only " + "w" * 2000,
        "OK context " + "c" * 2000,
    ]))

    text = dispatcher.format_event(event)

    assert "failure_lines=2" in text
    assert "warning_only_lines=1" in text
    assert "context_lines=1" in text
    assert "FAIL repeated" not in text
    assert "WARN only" not in text


def test_redelivery_uncertainty_cannot_be_displaced_by_evidence(dispatcher, monkeypatch):
    monkeypatch.setattr(dispatcher, "MAX_MESSAGE_CHARS", 2400)
    event = daily_event("\n".join(["FAIL check " + "x" * 70] * 50))
    event["delivery"] = {"attempts": 2, "ageAtDeliverySeconds": 7200, "revalidated": False}

    text = dispatcher.format_event(event)

    assert "delivery_age_seconds: 7200" in text
    assert "condition not re-probed before re-send (may be stale)" in text
    assert "evidence_omitted:" in text
    assert len(text) <= 2400


def test_omitted_governing_finding_is_not_presented_as_complete_coverage(dispatcher):
    event = daily_event("\n".join(
        [f"FAIL infrastructure-{index} " + "x" * 500 for index in range(4)]
        + ["FAIL credential governing-file.env " + "y" * 1800]
    ))

    text = dispatcher.format_event(event)

    assert "failure_code: credential_permission_drift" in text
    assert "governing-file.env" not in text
    assert "incomplete finding coverage" in text
    assert "selected asset" in text


def test_warning_only_evidence_survives_routine_prefix(dispatcher):
    warning = "WARN provider probe is inconclusive"
    event = daily_event("\n".join(["OK routine " + "x" * 80] * 35 + [warning]))
    event["severity"] = "warning"
    event.pop("criticalAsset")

    text = dispatcher.format_event(event)

    assert warning in text
    assert evidence_body(text).splitlines()[0] == warning
    assert "failure_lines=0" in text


def test_budget_uses_redacted_and_at_expanded_unicode_text(dispatcher):
    finding = "FAIL credential " + "界@" * 230 + " complete-filename.env"
    expected = dispatcher.redact(finding).replace("@", " at ")
    event = daily_event("OK " + "x" * 1200 + "\n" + finding)

    text = dispatcher.format_event(event)

    assert expected in text
    assert "complete-filename.env" in text
    assert "evidence_omitted:" in text
    assert len(evidence_body(text)) <= 1800
    assert len(text) <= dispatcher.MAX_MESSAGE_CHARS


def test_multiline_credentials_are_redacted_before_line_selection(dispatcher):
    event = daily_event(
        "-----BEGIN " + "PRIVATE KEY-----\nsynthetic-private-material\n-----END " + "PRIVATE KEY-----\n"
        "FAIL credential target-file.env: mode=0644"
    )

    text = dispatcher.format_event(event)

    assert "synthetic-private-material" not in text
    assert "REDACTED PEM PRIVATE KEY" in text
    assert "FAIL credential target-file.env: mode=0644" in text


@given(size=st.integers(min_value=5, max_value=5000))
@example(size=1799)
@example(size=1800)
@example(size=1801)
@_render_properties
def test_evidence_limit_never_splits_a_finding(dispatcher, size):
    finding = "FAIL " + "x" * (size - 5)

    body = evidence_body(dispatcher.format_event(daily_event(finding)))

    assert len(body) <= 1800
    if size <= 1800:
        assert body == finding
    else:
        assert "FAIL " not in body
        assert "failure_lines=1" in body


def test_whole_message_budget_includes_notices_and_optional_fields(dispatcher, monkeypatch):
    event = daily_event("\n".join(["FAIL finding " + "界@" * 30] * 40))
    event["diagnostics"] = {"logHints": ["log " + "x" * 850] * 5}
    for limit in range(128, 5600, 17):
        monkeypatch.setattr(dispatcher, "MAX_MESSAGE_CHARS", limit)

        text = dispatcher.format_event(event)

        assert len(text) <= limit, (limit, len(text))
        assert "INCOMPLETE ALERT" in text or "evidence_omitted:" in text
        if "  > evidence: " in text:
            assert len(evidence_body(text)) <= 1800


def test_rendering_does_not_mutate_evidence_or_incident_identity(dispatcher):
    event = daily_event("OK context\nFAIL credential target-file.env: mode=0644")
    original = deepcopy(event)
    key = dispatcher.incident_key(event)
    classification = dispatcher.classify_event(event)

    dispatcher.format_event(event)

    assert event == original
    assert dispatcher.incident_key(event) == key
    assert dispatcher.classify_event(event) == classification


def test_info_action_remains_the_existing_single_source_of_truth(dispatcher):
    event = daily_event("OK all credentials are private")
    event["severity"] = "info"
    event["eventType"] = "clear"
    event.pop("criticalAsset")

    text = dispatcher.format_event(event)

    assert text.count("requested_action:") == 1
    assert dispatcher.NONACTIONABLE_ACTION in text
    assert "OK all credentials are private" in text
    assert "evidence_omitted:" not in text


@given(source=st.from_regex(r"[a-z][a-z-]{0,30}", fullmatch=True).filter(lambda value: value != "daily-health"))
@example(source="daily-health-fail")
@example(source="daily-health-extra")
@example(source="runtime-agent-failure")
@_render_properties
def test_non_allowlisted_sources_keep_existing_evidence_rendering(dispatcher, source):
    event = daily_event("OK context\nFAIL last finding")
    event["source"] = source

    text = dispatcher.format_event(event)

    assert "  > evidence: OK context\nFAIL last finding" in text
    assert text.index("  > evidence:") < text.index("  > requested_action:")


def test_legacy_mapping_is_confined_before_rendering(dispatcher):
    event = daily_event({"untrusted": "FAIL password=synthetic-private-value"})

    text = dispatcher.format_event(event)

    assert "synthetic-private-value" not in text
    assert "{'untrusted'" not in text
    assert dispatcher.event_text(event, "evidence") in text


def test_small_cap_returns_explicit_incomplete_alert(dispatcher, monkeypatch):
    monkeypatch.setattr(dispatcher, "MAX_MESSAGE_CHARS", 128)

    text = dispatcher.format_event(daily_event("FAIL credential target-file.env"))

    assert "INCOMPLETE ALERT" in text
    assert "retained event" in text
    assert len(text) <= 128
    assert "target-file" not in text


@given(limit=st.integers(min_value=-100, max_value=100))
@example(limit=0)
@example(limit=1)
@example(limit=32)
@_render_properties
def test_cap_too_small_for_honest_fallback_fails_explicitly(dispatcher, monkeypatch, limit):
    monkeypatch.setattr(dispatcher, "MAX_MESSAGE_CHARS", limit)

    with pytest.raises(ValueError, match="BOT_ERRORS_MAX_MESSAGE_CHARS"):
        dispatcher.format_event(daily_event("FAIL credential target-file.env"))


def _run_credential_case(tmp_path, mode, classification):
    # Match the drill's permitted sandbox shape; no live host state is inherited.
    with TemporaryDirectory(prefix="bot-errors-drill.", dir="/tmp") as sandbox:
        root = Path(sandbox)
        fixture_home = root / "fixture-home"
        credential = fixture_home / ".config/whatsoup/tokens.env"
        credential.parent.mkdir(parents=True, mode=0o700)
        credential.write_text("TOKEN=synthetic-credential-body\n", encoding="utf-8")
        credential.chmod(mode)
        state = root / "state"
        capture = root / "sent.log"
        env = {
            "PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(fixture_home),
            "TMPDIR": sandbox,
            "XDG_CONFIG_HOME": str(fixture_home / ".config"),
            "XDG_DATA_HOME": str(fixture_home / ".local/share"),
            "XDG_STATE_HOME": str(fixture_home / ".local/state"),
            "PYTHONDONTWRITEBYTECODE": "1",
            "BOT_ERRORS_STATE_DIR": str(state),
            "BOT_ERRORS_OUTBOX_DIR": str(state / "outbox"),
            "BOT_ERRORS_DRY_SEND_CAPTURE": str(capture),
            "BOT_ERRORS_EMAIL_FALLBACK": str(root / "absent-email-fallback"),
            "BOT_ERRORS_DRY_SYS_PLATFORM": "linux",
            "BOT_ERRORS_DRY_PLATFORM_SYSTEM": "Linux",
            "BOT_ERRORS_DRY_PLATFORM": "linux",
            "BOT_ERRORS_DRY_PLATFORM_RELEASE": "6.0.0-drill",
            "BOT_ERRORS_DRY_CLOCK_STATUS": "synced",
            "BOT_ERRORS_DRY_DISK_FREE_BYTES": str(10 * 1024 ** 3),
            "BOT_ERRORS_DRY_DISK_TOTAL_BYTES": str(100 * 1024 ** 3),
            "BOT_ERRORS_DRY_UPTIME_SECONDS": "3600",
            "BOT_ERRORS_HEALTH_PROFILE_JSON": json.dumps({
                "role": "bot-host", "expectDispatcher": False, "expectQLoop": False,
                "expectPersonalSocket": False, "expectPersonalTools": False,
                "expectConfigInventory": False, "expectPluginInventory": False,
                "requiredCredentialFiles": ["tokens.env"],
            }),
        }
        producer = subprocess.run(
            [sys.executable, str(_TESTS.parent / "bot-errors-health-check.py"), "--daily"],
            env=env, capture_output=True, text=True, timeout=60, check=False,
        )
        (tmp_path / "producer.stdout").write_text(producer.stdout, encoding="utf-8")
        (tmp_path / "producer.stderr").write_text(producer.stderr, encoding="utf-8")
        assert producer.returncode == 0, producer.stderr
        queued = list((state / "outbox").glob("*.json"))
        assert len(queued) == 1
        event = json.loads(queued[0].read_text(encoding="utf-8"))
        (tmp_path / "queued.json").write_text(json.dumps(event), encoding="utf-8")

        dispatched = subprocess.run(
            [sys.executable, str(_TESTS.parent / "bot-errors-dispatcher.py"), "--once"],
            env=env, capture_output=True, text=True, timeout=60, check=False,
        )
        (tmp_path / "dispatcher.stdout").write_text(dispatched.stdout, encoding="utf-8")
        (tmp_path / "dispatcher.stderr").write_text(dispatched.stderr, encoding="utf-8")
        assert dispatched.returncode == 0, dispatched.stderr
        counts = json.loads(dispatched.stdout)
        assert counts["processed"] == 1
        assert counts["failed"] == 0
        assert credential.stat().st_mode & 0o777 == mode

        if classification is None:
            assert event["eventType"] == "clear"
            assert event["severity"] == "info"
            assert "OK credential: credential_requirement=tokens.env" in event["evidence"]
            assert not capture.exists()
        else:
            records = [json.loads(line) for line in capture.read_text(encoding="utf-8").splitlines()]
            (tmp_path / "delivered.json").write_text(json.dumps(records), encoding="utf-8")
            assert len(records) == 1
            text = records[0]["text"]
            for evidence in (event["evidence"], text):
                matches = [line for line in evidence.splitlines() if "FAIL credential:" in line]
                assert len(matches) == 1
                assert classification in matches[0]
                assert "credential_path_basename=tokens.env" in matches[0]
                assert "synthetic-credential-body" not in evidence
        return counts


def test_non_private_credential_alert_retains_complete_failure(tmp_path):
    counts = _run_credential_case(tmp_path, 0o644, "non_private")

    assert counts["sent"] == 1
    assert counts["suppressed"] == 0


def test_world_writable_credential_alert_retains_complete_failure(tmp_path):
    counts = _run_credential_case(tmp_path, 0o666, "world_writable")

    assert counts["sent"] == 1
    assert counts["suppressed"] == 0


def test_private_credential_clear_remains_suppressed(tmp_path):
    counts = _run_credential_case(tmp_path, 0o600, None)

    assert counts["sent"] == 0
    assert counts["suppressed"] == 1
