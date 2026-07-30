#!/usr/bin/env python3
"""Safety tests for BOT ERRORS daily-health artifact metadata adapter."""
import io
import json
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bot_errors_daily_health_artifact_probe as probe  # noqa: E402
from bot_errors_daily_health_artifact_probe import (  # noqa: E402
    alert_source_class,
    build_report,
    classify_line,
    classify_plugin_line,
    classify_runtime_manifest_line,
    evidence_summary,
    has_instance_reference_from_fail_line,
    normalize_category,
    read_artifact,
    parse_artifact_text,
    safe_enum,
)

PROBE_PATH = Path(__file__).resolve().parents[1] / "bot_errors_daily_health_artifact_probe.py"


SECRET_EVIDENCE = "\n".join(
    [
        "machine: private-hostname",
        "profile: role=central path=/Users/testuser/private/profile.json",
        "FAIL provider_probe ana-bot: provider=claude-cli target=primary command=/Users/testuser/bin/claude failure_class=provider_auth_required rc=1 output=canary-must-not-leak provider_auth_context=headless_login_keychain_blocked provider_probe_signal=headless_auth_probe_blocked status=advisory_inconclusive",
        "provider_probe ew-bot: provider=opencode-cli target=fallback command=/Users/testuser/bin/opencode status=ok rc=0",
        "FAIL runtime_manifest deploy/scripts/bot-errors-health-check.py: missing_marker=canary-must-not-leak path=/Users/testuser/private/deploy/scripts/bot-errors-health-check.py",
        "runtime_manifest: files=10 root=/Users/testuser/LAB/WhatSoup",
        "FAIL plugin_coverage ana-bot: missing=1/2 inherited_enabled=secret-plugin inherited_disabled=none",
        "OK plugin_dir ana-bot[0]: /Users/testuser/.claude/plugins exists=True",
        "FAIL disk: usage=99 path=/Users/testuser/private/disk",
        "WARN rustdesk: expected running",
        "health ana-bot: FAIL health_probe_auth_failed url=http://127.0.0.1:9090/health",
        "socket ana-bot: /tmp/private.sock exists=False jid=15551234567@g.us",
    ]
)


def event_fixture() -> dict:
    return {
        "schemaVersion": 1,
        "id": "health-secret-id",
        "eventType": "alert",
        "severity": "critical",
        "createdAt": "2026-06-15T00:00:00Z",
        "machine": "private-hostname",
        "platform": "darwin",
        "instance": "ana-bot",
        "source": "daily-health",
        "summary": "BOT ERRORS provider failure for ana-bot canary-must-not-leak",
        "evidence": SECRET_EVIDENCE,
        "process": {"pid": 123, "cwd": "/Users/testuser/private", "argv": ["/Users/testuser/bin/python", "--token", "canary-must-not-leak"]},
        "runtime": {"provenance": {"path": "/Users/testuser/private/runtime"}},
        "diagnostics": {
            "logHints": ["/Users/testuser/private/logs/health.out.log"],
            "queue": "/Users/testuser/private/outbox",
        },
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
        "criticalAsset": {
            "code": "AGENT_PROVIDER_AUTH_REQUIRED",
            "assetKind": "agent_provider",
            "domain": "provider_access",
            "recoverability": "operator_recoverable",
            "confidence": "confirmed",
            "instance": "ana-bot",
            "operatorAction": "Restore private credential.",
        },
        "alertSource": "provider_probe:ana-bot:provider_auth_required",
    }


def assert_no_fixture_payloads(rendered: str) -> None:
    for forbidden in [
        "ana-bot",
        "ew-bot",
        "private-hostname",
        "canary-must-not-leak",
        "/Users/testuser/private",
        "/Users/testuser/bin/claude",
        "/Users/testuser/bin/opencode",
        "/Users/testuser/.claude/plugins",
        "/tmp/private.sock",
        "15551234567@g.us",
        "secret-plugin",
        "health-secret-id",
        "BOT ERRORS provider failure",
    ]:
        assert forbidden not in rendered, forbidden


def test_event_json_artifact_counts_health_classes_without_raw_payloads():
    raw = json.dumps(event_fixture(), sort_keys=True)
    report = build_report(raw, "fixture")
    rendered = json.dumps(report, sort_keys=True)
    assert report["schema"] == "bot-errors-daily-health-artifact-report", report
    assert report["artifact"]["type"] == "event_json", report
    assert report["event"]["event_type"] == "alert", report
    assert report["event"]["severity"] == "critical", report
    assert report["event"]["source"] == "daily-health", report
    assert report["event"]["alert_source_class"] == "provider_probe", report
    assert report["event"]["status"] == "observed", report
    assert report["event"]["summary_bytes"] == len(event_fixture()["summary"].encode("utf-8")), report
    assert report["event"]["critical_asset_known_field_count"] == 5, report
    assert report["reportVerdict"] == "valid", report
    assert report["evidence"]["provider_failure_class_counts"] == {"provider_auth_required": 1}, report
    assert report["evidence"]["runtime_manifest_class_counts"]["fail_missing_marker"] == 1, report
    assert report["evidence"]["plugin_class_counts"]["coverage_fail_missing"] == 1, report
    assert report["evidence"]["line_class_counts"]["fail"] >= 4, report
    assert report["evidence"]["inferred_severity_from_lines"] == "critical", report
    assert_no_fixture_payloads(rendered)


def test_plain_text_artifact_has_no_event_but_keeps_counts():
    report = build_report(SECRET_EVIDENCE, "fixture")
    rendered = json.dumps(report, sort_keys=True)
    assert report["artifact"]["type"] == "plain_text", report
    assert report["event"]["status"] == "not_applicable", report
    assert report["reportVerdict"] == "inconclusive", report
    assert report["evidence"]["provider_status_class_counts"]["ok"] == 1, report
    assert report["evidence"]["provider_field_counts"]["provider_probe_signal"] == 1, report
    assert report["evidence"]["instance_reference_count"] >= 2, report
    assert_no_fixture_payloads(rendered)


def test_daily_health_artifact_cli_suppresses_payloads():
    with tempfile.TemporaryDirectory(prefix="daily-health-artifact-") as tmp_dir:
        artifact = Path(tmp_dir) / "event.json"
        artifact.write_text(json.dumps(event_fixture(), sort_keys=True), encoding="utf-8")
        result = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve().parents[1] / "bot_errors_daily_health_artifact_probe.py"),
                "--artifact",
                str(artifact),
                "--pretty",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        report = json.loads(result.stdout)
        assert result.stderr == "", result.stderr
        assert report["artifact"]["source"] == "file", report
        assert report["evidence"]["provider_failure_class_counts"]["provider_auth_required"] == 1, report
        assert_no_fixture_payloads(result.stdout)


# --------------------------------------------------------------------------
# Unhappy-path: no artifact (type=none), empty, malformed JSON, json-non-object
# --------------------------------------------------------------------------
def test_no_artifact_yields_type_none_and_absent_event():
    # read_artifact(path=None, stdin=False) -> empty raw, source label "none"
    raw, source_label = read_artifact(None, use_stdin=False)
    assert raw == "", raw
    assert source_label == "none", source_label
    report = build_report(raw, source_label)
    # fail-closed to a typed missing observation, not a fake-clean parsed report
    assert report["artifact"]["type"] == "none", report
    assert report["artifact"]["evidence_available"] is False, report
    assert report["event"]["status"] == "missing", report
    assert report["reportVerdict"] == "inconclusive", report
    assert report["evidence"] == {}, report


def test_whitespace_only_artifact_is_typed_none_not_silent_clean():
    # Non-empty bytes but only whitespace -> still type=none (fail closed)
    report = build_report("   \n\t  \n", "fixture")
    assert report["artifact"]["type"] == "none", report
    assert report["artifact"]["evidence_available"] is False, report
    assert report["evidence"] == {}, report
    assert report["event"]["status"] == "missing", report


def test_malformed_event_json_is_invalid_not_plain_text():
    # JSON-looking truncated input must not be reclassified as ordinary evidence.
    malformed = "{not valid json\nFAIL disk: usage=99 path=/secret/x"
    event, evidence, artifact_type = parse_artifact_text(malformed)
    assert event is None, event
    assert artifact_type == "invalid_json", artifact_type
    assert evidence == "", evidence
    report = build_report(malformed, "fixture")
    assert report["schema_version"] == "0.2", report
    assert report["observations"]["daily_health_artifact"]["status"] == "invalid_json", report
    assert report["reportVerdict"] == "invalid", report
    assert report["evidence"] == {}, report
    rendered = json.dumps(report, sort_keys=True)
    assert "/secret/x" not in rendered, rendered


def test_json_non_object_artifact_is_invalid_shape_not_evidence_text():
    # A valid JSON array/scalar is not an event object and cannot be evidence text.
    event, evidence, artifact_type = parse_artifact_text("[1, 2, 3]")
    assert event is None, event
    assert artifact_type == "json_non_object", artifact_type
    assert evidence == "", evidence
    report = build_report("[1, 2, 3]", "fixture")
    assert report["artifact"]["type"] == "json_non_object", report
    assert report["observations"]["daily_health_artifact"]["status"] == "invalid_shape", report
    assert report["reportVerdict"] == "invalid", report
    assert report["evidence"] == {}, report


def test_unsupported_event_schema_is_not_a_valid_observation():
    event = {
        "schemaVersion": 999,
        "eventType": "alert",
        "severity": "critical",
        "source": "daily-health",
        "evidence": "",
    }
    report = build_report(json.dumps(event), "fixture")
    observation = report["observations"]["daily_health_artifact"]
    assert observation["status"] == "unsupported_version", observation
    assert observation["schemaStatus"] == "unsupported_version", observation
    assert report["event"]["status"] == "unsupported_version", report
    assert report["reportVerdict"] == "inconclusive", report


def test_missing_required_event_fields_are_invalid_not_parsed():
    report = build_report(json.dumps({"schemaVersion": 1, "eventType": "alert", "severity": "critical"}), "fixture")
    observation = report["observations"]["daily_health_artifact"]
    assert observation["status"] == "invalid_shape", observation
    assert observation["schemaStatus"] == "missing_required", observation
    assert observation["counts"] == {
        "expected": 5,
        "observed_valid": 3,
        "invalid": 2,
        "skipped": 0,
        "unknown": 0,
    }, observation
    assert report["event"]["status"] == "invalid_shape", report
    assert report["reportVerdict"] == "invalid", report


def test_each_required_event_field_is_checked():
    valid = {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "critical",
        "source": "daily-health",
        "evidence": "",
    }
    for missing in valid:
        event = dict(valid)
        del event[missing]
        observation = build_report(json.dumps(event), "fixture")["observations"]["daily_health_artifact"]
        assert observation["status"] == "invalid_shape", (missing, observation)
        assert observation["schemaStatus"] == "missing_required", (missing, observation)


def test_scalar_json_values_are_invalid_shape_not_plain_text():
    for raw in ("null", "false", "1", '"event"'):
        report = build_report(raw, "fixture")
        assert report["artifact"]["type"] == "json_non_object", (raw, report)
        assert report["observations"]["daily_health_artifact"]["status"] == "invalid_shape", (raw, report)
        assert report["evidence"] == {}, (raw, report)


def test_scalar_json_with_whitespace_is_invalid_shape_not_plain_text():
    for raw in ("null\n", "false ", "1\t", '"event"\n'):
        report = build_report(raw, "fixture")
        assert report["artifact"]["type"] == "json_non_object", (raw, report)
        assert report["observations"]["daily_health_artifact"]["status"] == "invalid_shape", (raw, report)
        assert report["evidence"] == {}, (raw, report)


def test_bom_prefixed_json_is_never_reclassified_as_plain_text():
    report = build_report("\ufeffnull", "fixture")
    assert report["artifact"]["type"] == "invalid_json", report
    assert report["observations"]["daily_health_artifact"]["status"] == "invalid_json", report
    assert report["evidence"] == {}, report


def test_non_integer_schema_version_is_invalid_shape():
    for version in (True, 1.0, "1"):
        event = {
            "schemaVersion": version,
            "eventType": "alert",
            "severity": "critical",
            "source": "daily-health",
            "evidence": "",
        }
        report = build_report(json.dumps(event), "fixture")
        observation = report["observations"]["daily_health_artifact"]
        assert observation["status"] == "invalid_shape", (version, observation)
        assert observation["error_class"] == "invalid_event_field", (version, observation)


def test_explicit_plain_text_mode_cannot_claim_valid_event_observation():
    raw = json.dumps({
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "critical",
        "source": "daily-health",
        "evidence": "FAIL disk: usage=99",
    })
    report = build_report(raw, "fixture", "plain-text")
    observation = report["observations"]["daily_health_artifact"]
    assert report["artifact"]["type"] == "plain_text", report
    assert observation["inputMode"] == "plain_text", observation
    assert observation["status"] == "not_applicable", observation
    assert report["event"]["status"] == "not_applicable", report
    assert report["reportVerdict"] == "inconclusive", report


def test_ambiguous_plain_text_is_not_recast_as_invalid_json():
    report = build_report("false alarm\nFAIL disk: usage=99", "fixture")
    assert report["artifact"]["type"] == "plain_text", report
    assert report["observations"]["daily_health_artifact"]["status"] == "not_applicable", report
    assert report["evidence"]["failure_category_counts"] == {"disk": 1}, report


def test_known_provider_compatibility_failure_class_is_preserved():
    report = build_report("FAIL provider_probe bot: failure_class=provider_compatibility_degraded", "fixture")
    assert report["evidence"]["provider_failure_class_counts"] == {"provider_compatibility_degraded": 1}, report


def test_unknown_evidence_tokens_are_collapsed_without_raw_or_hash_values():
    sentinel = "private-value-must-not-leak"
    event = {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "critical",
        "source": "daily-health",
        "evidence": f"FAIL {sentinel}: failure_class={sentinel} status={sentinel}",
        "diagnostics": {sentinel: sentinel},
        "criticalAsset": {"code": sentinel},
        "alertSource": sentinel,
    }
    report = build_report(json.dumps(event), "fixture")
    rendered = json.dumps(report, sort_keys=True)
    assert report["evidence"]["failure_category_counts"] == {"other": 1}, report
    assert report["evidence"]["provider_status_class_counts"] == {"other": 1}, report
    assert "sha256" not in rendered, rendered
    assert sentinel not in rendered, rendered


def test_artifact_and_event_views_are_derived_from_one_observation():
    report = build_report("[1, 2, 3]", "fixture")
    observation = report["observations"]["daily_health_artifact"]
    assert report["artifact"]["inputMode"] == observation["inputMode"], report
    assert report["artifact"]["formatStatus"] == observation["formatStatus"], report
    assert report["artifact"]["schemaStatus"] == observation["schemaStatus"], report
    assert report["event"]["status"] == observation["status"], report


def test_caller_source_label_is_bounded_not_emitted_verbatim():
    sentinel = "/Users/testuser/private-artifact.json"
    report = build_report("plain evidence", sentinel)
    rendered = json.dumps(report, sort_keys=True)
    assert report["artifact"]["source"] == "caller_supplied", report
    assert sentinel not in rendered, rendered


def test_missing_artifact_file_emits_read_error_report_without_path():
    missing = "/tmp/no-such-daily-health-artifact-input.json"
    result = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--artifact", missing],
        capture_output=True, text=True, timeout=30,
    )
    report = json.loads(result.stdout)
    assert result.returncode == 0, result.stderr
    assert report["observations"]["daily_health_artifact"]["status"] == "read_error", report
    assert report["reportVerdict"] == "invalid", report
    assert missing not in result.stdout, result.stdout


def test_event_json_with_empty_evidence_is_valid_but_has_no_evidence_summary():
    event_obj = {"schemaVersion": 1, "eventType": "clear", "severity": "info", "source": "daily-health", "evidence": ""}
    report = build_report(json.dumps(event_obj), "fixture")
    assert report["artifact"]["type"] == "event_json", report
    assert report["artifact"]["evidence_available"] is False, report
    assert report["evidence"] == {}, report
    assert report["event"]["status"] == "observed", report
    assert report["event"]["event_type"] == "clear", report


# --------------------------------------------------------------------------
# safe_enum: absent + out-of-allow-set hashing (no raw value leak)
# --------------------------------------------------------------------------
def test_safe_enum_absent_for_non_string_and_empty():
    assert safe_enum(None, SAFE := {"a"}) == "absent"
    assert safe_enum(123, {"a"}) == "absent"
    assert safe_enum("   ", {"a"}) == "absent"


def test_safe_enum_collapses_unknown_value_without_echoing_it():
    secret = "private-instance-name-leak"
    out = safe_enum(secret, {"alert", "clear"})
    assert out == "other", out
    assert secret not in out, out


def test_event_unknown_enum_values_are_invalid_and_not_raw():
    event_obj = {
        "schemaVersion": 1,
        "eventType": "weird-type-secret",
        "severity": "weird-sev-secret",
        "source": "weird-source-secret",
        "evidence": "info only",
    }
    report = build_report(json.dumps(event_obj), "fixture")
    assert report["event"]["status"] == "invalid_shape", report
    assert report["reportVerdict"] == "invalid", report
    rendered = json.dumps(report, sort_keys=True)
    for raw in ("weird-type-secret", "weird-sev-secret", "weird-source-secret"):
        assert raw not in rendered, raw


def test_each_enum_field_rejects_an_unknown_value_independently():
    valid = {
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "critical",
        "source": "daily-health",
        "evidence": "",
    }
    for field in ("eventType", "severity", "source"):
        event = dict(valid)
        event[field] = "unknown-private-value"
        observation = build_report(json.dumps(event), "fixture")["observations"]["daily_health_artifact"]
        assert observation["status"] == "invalid_shape", (field, observation)
        assert observation["counts"]["observed_valid"] == 4, (field, observation)
        assert observation["counts"]["invalid"] == 1, (field, observation)


# --------------------------------------------------------------------------
# normalize_category: empty + path_like
# --------------------------------------------------------------------------
def test_normalize_category_empty_for_whitespace_only_line():
    assert normalize_category("   ") == "empty"
    assert normalize_category("\t\t") == "empty"


def test_normalize_category_path_like_suppresses_path():
    assert normalize_category("FAIL /Users/testuser/private/x.json bad") == "path_like"
    assert normalize_category("WARN C:\\secret\\path failed") == "path_like"


# --------------------------------------------------------------------------
# classify_line: blank + config-invalid-JSON -> fail
# --------------------------------------------------------------------------
def test_classify_line_blank_and_config_invalid_json():
    assert classify_line("   ") == "blank"
    assert classify_line("config instance.json invalid JSON near line 3") == "fail"
    assert classify_line("config instance.json loaded successfully") == "info"
    assert classify_line("note: invalid JSON mentioned as historical context") == "info"
    assert classify_line("just an info line") == "info"
    assert classify_line("WARN something") == "warn"


# --------------------------------------------------------------------------
# has_instance_reference_from_fail_line: too few tokens, non-instance prefix, path-like
# --------------------------------------------------------------------------
def test_instance_reference_returns_false_for_too_few_tokens():
    assert has_instance_reference_from_fail_line("FAIL health") is False
    assert has_instance_reference_from_fail_line("health") is False


def test_instance_reference_returns_false_for_non_instance_prefix():
    assert has_instance_reference_from_fail_line("FAIL disk something") is False


def test_instance_reference_returns_false_for_path_like_candidate():
    # candidate (2nd token) containing a slash is a path -> suppressed (None)
    assert has_instance_reference_from_fail_line("FAIL health /Users/testuser/private/x") is False


def test_instance_reference_counts_real_instance_name_without_hashing_it():
    assert has_instance_reference_from_fail_line("FAIL health ana-bot:") is True


# --------------------------------------------------------------------------
# classify_runtime_manifest_line: every fail sub-class + hash/summary/other
# --------------------------------------------------------------------------
def test_runtime_manifest_line_returns_none_when_absent():
    assert classify_runtime_manifest_line("FAIL disk: usage=99") is None


def test_runtime_manifest_fail_subclasses():
    cases = {
        "FAIL runtime_manifest x: unsupported schemaVersion 9": "fail_unsupported_schema",
        "FAIL runtime_manifest x: files must be a list": "fail_files_not_list",
        "FAIL runtime_manifest x: duplicate path entry": "fail_duplicate_path",
        "FAIL runtime_manifest x: missing_marker absent": "fail_missing_marker",
        "FAIL runtime_manifest x: missing path on disk": "fail_missing_path",
        "FAIL runtime_manifest x: invalid expected sha256 value": "fail_invalid_expected_hash",
        "FAIL runtime_manifest x: cannot hash file": "fail_unreadable",
        "FAIL runtime_manifest x: cannot read file": "fail_unreadable",
        "FAIL runtime_manifest x: some novel failure": "fail_other",
    }
    for line, expected in cases.items():
        assert classify_runtime_manifest_line(line) == expected, (line, expected)


def test_runtime_manifest_hash_summary_and_other_lines():
    # hash check line: must mention runtime_manifest and carry sha256=/expected=
    assert (
        classify_runtime_manifest_line("runtime_manifest file.py sha256=abcd expected=abcd")
        == "hash_check_line"
    )
    assert classify_runtime_manifest_line("runtime_manifest file.py sha256=abcd") == "other"
    assert classify_runtime_manifest_line("runtime_manifest file.py expected=abcd") == "other"
    assert classify_runtime_manifest_line("runtime_manifest: files=10 root=/x") == "summary_line"
    # mentions runtime_manifest but matches neither fail/hash/summary -> "other"
    assert classify_runtime_manifest_line("note about runtime_manifest in passing") == "other"


def test_runtime_manifest_classes_aggregate_in_evidence_summary():
    evidence = "\n".join([
        "FAIL runtime_manifest a: duplicate path entry",
        "FAIL runtime_manifest b: cannot read file",
        "runtime_manifest: files=3 root=/x",
    ])
    summary = evidence_summary(evidence)
    counts = summary["runtime_manifest_class_counts"]
    assert counts["fail_duplicate_path"] == 1, counts
    assert counts["fail_unreadable"] == 1, counts
    assert counts["summary_line"] == 1, counts


# --------------------------------------------------------------------------
# classify_plugin_line: every sub-class branch
# --------------------------------------------------------------------------
def test_plugin_line_returns_none_when_absent():
    assert classify_plugin_line("FAIL disk: usage=99") is None


def test_plugin_line_subclasses():
    cases = {
        "FAIL plugin_coverage x: enabledPlugins must be an object or null": "coverage_fail_invalid_enabled_plugins",
        "FAIL plugin_coverage x: missing=1/2": "coverage_fail_missing",
        "plugin_coverage x: inherits global config": "coverage_inherits_global",
        "plugin_coverage x: ok all present": "coverage_ok",
        "plugin_coverage x: partial state": "coverage_other",
        "FAIL plugin_dir x: missing": "plugin_dir_fail",
        "OK plugin_dir x: present": "plugin_dir_ok",
        "FAIL plugins settings x: broken": "settings_fail",
        "plugins settings: missing file": "settings_missing",
        "plugins settings: present and valid": "settings_present",
        "plugins: no instance configs found": "no_instance_configs",
        "plugins x: skipped (disabled)": "instance_skipped",
        "plugins x: active": "other",
        "FAIL plugins x: bad config": "instance_fail",
        "some plugin mention with no known prefix": "other",
    }
    for line, expected in cases.items():
        assert classify_plugin_line(line) == expected, (line, expected)


def test_plugin_classes_aggregate_in_evidence_summary():
    evidence = "\n".join([
        "OK plugin_dir ana[0]: present",
        "plugins: no instance configs found",
        "plugin_coverage x: ok all present",
    ])
    counts = evidence_summary(evidence)["plugin_class_counts"]
    assert counts["plugin_dir_ok"] == 1, counts
    assert counts["no_instance_configs"] == 1, counts
    assert counts["coverage_ok"] == 1, counts


def test_evidence_summary_separates_warning_categories_and_severity_classes():
    warning_only = evidence_summary("WARN rustdesk: expected running\nordinary information")
    assert warning_only["warning_category_counts"] == {"rustdesk": 1}, warning_only
    assert warning_only["failure_category_counts"] == {}, warning_only
    assert warning_only["inferred_severity_from_lines"] == "warning", warning_only

    infra_fail_only = evidence_summary("FAIL disk: usage=99")
    assert infra_fail_only["inferred_severity_from_lines"] == "warning", infra_fail_only

    non_infra_fail = evidence_summary("FAIL provider_probe bot: unavailable")
    assert non_infra_fail["inferred_severity_from_lines"] == "critical", non_infra_fail

    info_only = evidence_summary("ordinary information")
    assert info_only["inferred_severity_from_lines"] == "info", info_only


# --------------------------------------------------------------------------
# alert_source_class: absent, source_update, other-hashed
# --------------------------------------------------------------------------
def test_alert_source_class_absent_for_non_string_and_empty():
    assert alert_source_class(None) == "absent"
    assert alert_source_class("   ") == "absent"
    assert alert_source_class(42) == "absent"


def test_alert_source_class_known_prefixes():
    assert alert_source_class("provider_probe:ana-bot:x") == "provider_probe"
    assert alert_source_class("runtime_manifest:foo") == "runtime_manifest"
    assert alert_source_class("primary_phone:ana") == "primary_phone"


def test_alert_source_class_source_update_literal():
    assert alert_source_class("source_update") == "source_update"


def test_alert_source_class_unknown_is_collapsed_not_raw():
    secret = "secret-internal-source-name"
    out = alert_source_class(secret)
    assert out == "other", out
    assert secret not in out, out


# --------------------------------------------------------------------------
# CLI: stdin path, file path, mutually-exclusive flag error
# --------------------------------------------------------------------------
def test_main_stdin_path_reads_artifact_and_emits_report(monkeypatch_stdin="FAIL disk: usage=99 path=/secret/p"):
    orig_argv, orig_stdin = sys.argv, sys.stdin
    sys.argv = [str(PROBE_PATH), "--stdin"]
    sys.stdin = io.StringIO(monkeypatch_stdin)
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        sys.argv, sys.stdin = orig_argv, orig_stdin
    assert rc == 0, rc
    report = json.loads(buf.getvalue())
    assert report["artifact"]["source"] == "stdin", report
    assert report["artifact"]["type"] == "plain_text", report
    assert report["evidence"]["failure_category_counts"].get("disk") == 1, report
    assert "/secret/p" not in buf.getvalue(), buf.getvalue()


def test_read_artifact_stdin_branch_returns_stdin_label():
    orig_stdin = sys.stdin
    sys.stdin = io.StringIO("hello evidence")
    try:
        raw, label = read_artifact(None, use_stdin=True)
    finally:
        sys.stdin = orig_stdin
    assert raw == "hello evidence", raw
    assert label == "stdin", label


def test_read_artifact_file_branch_reads_path_with_label_file():
    with tempfile.TemporaryDirectory(prefix="daily-health-read-") as tmp_dir:
        artifact = Path(tmp_dir) / "ev.txt"
        artifact.write_text("WARN rustdesk: expected running", encoding="utf-8")
        raw, label = read_artifact(artifact, use_stdin=False)
    assert raw == "WARN rustdesk: expected running", raw
    assert label == "file", label


def test_main_pretty_file_mode_emits_indented_json():
    with tempfile.TemporaryDirectory(prefix="daily-health-main-") as tmp_dir:
        artifact = Path(tmp_dir) / "ev.txt"
        artifact.write_text("FAIL dns: lookup failed", encoding="utf-8")
        orig_argv = sys.argv
        sys.argv = [str(PROBE_PATH), "--artifact", str(artifact), "--pretty"]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                rc = probe.main()
        finally:
            sys.argv = orig_argv
    assert rc == 0, rc
    out = buf.getvalue()
    assert "\n  " in out, "pretty output should be indented"
    report = json.loads(out)
    assert report["artifact"]["source"] == "file", report
    assert report["evidence"]["failure_category_counts"].get("dns") == 1, report


def test_main_rejects_both_artifact_and_stdin():
    orig_argv = sys.argv
    sys.argv = [str(PROBE_PATH), "--artifact", "/tmp/x", "--stdin"]
    try:
        raised = False
        try:
            probe.main()
        except SystemExit as exc:
            raised = True
            assert exc.code == 2, exc.code  # argparse error exit
        assert raised, "expected SystemExit from mutually-exclusive flags"
    finally:
        sys.argv = orig_argv


def test_cli_stdin_subprocess_suppresses_payloads():
    # e2e through the real __main__ entrypoint with stdin feed.
    result = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--stdin"],
        input=SECRET_EVIDENCE,
        capture_output=True,
        text=True,
        check=True,
    )
    report = json.loads(result.stdout)
    assert result.stderr == "", result.stderr
    assert report["artifact"]["source"] == "stdin", report
    assert report["evidence"]["provider_failure_class_counts"]["provider_auth_required"] == 1, report
    assert_no_fixture_payloads(result.stdout)


def test_cli_strict_is_distinct_from_report_only_mode():
    malformed = '{"schemaVersion": 1'
    report_only = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--stdin"],
        input=malformed,
        capture_output=True, text=True, timeout=30,
    )
    strict = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--stdin", "--strict"],
        input=malformed,
        capture_output=True, text=True, timeout=30,
    )
    assert report_only.returncode == 0, report_only.stderr
    assert json.loads(report_only.stdout)["reportVerdict"] == "invalid", report_only.stdout
    assert strict.stdout, strict.stderr
    assert json.loads(strict.stdout)["reportVerdict"] == "invalid", strict.stdout
    assert strict.returncode == 2, strict.stderr


def test_cli_strict_accepts_valid_event_v1():
    event = json.dumps({
        "schemaVersion": 1,
        "eventType": "alert",
        "severity": "critical",
        "source": "daily-health",
        "evidence": "",
    })
    result = subprocess.run(
        [sys.executable, str(PROBE_PATH), "--stdin", "--strict"],
        input=event,
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["reportVerdict"] == "valid", result.stdout


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} BOT ERRORS daily-health artifact tests passed")
