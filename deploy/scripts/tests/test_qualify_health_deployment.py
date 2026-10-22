"""Loopback behavioral tests for deployment /health qualification.

The qualifier is intentionally separate from the source-test health reader:
it observes absent, synthetic-invalid, and host-resolved-token requests against
one local HTTP server and emits a redacted receipt only.
"""
from __future__ import annotations

import importlib.util
import json
import os
import plistlib
import stat
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest


_SCRIPT = Path(__file__).resolve().parents[1] / "qualify-health-deployment.py"
_HEALTH_PROFILE = Path(__file__).resolve().parents[1] / "health-deployment-qualification-profile.json"
_DEPLOYMENT_PROFILE = Path(__file__).resolve().parents[1] / "deployment-qualification-profile.json"
_PACKAGE = Path(__file__).resolve().parents[3] / "package.json"


def _load():
    spec = importlib.util.spec_from_file_location("qualify_health_deployment", _SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


qualifier = _load()

VALID_TOKEN = "synthetic-valid-token"
PROTECTED_SENTINEL = "SYNTHETIC_PRIVATE_ACCOUNT_JID"
PUBLIC = {
    "schema_version": "health.public.v1",
    "status": "healthy",
    "generated_at": "2026-09-13T00:00:00Z",
    "startupNotification": {
        "state": "disabled",
        "policy": "disabled",
        "stabilitySeconds": None,
        "bootCountSinceNotification": None,
        "lastBootAt": None,
        "lastNotifiedAt": None,
        "nextEligibleAt": None,
        "lastSendAt": None,
    },
}
DIAGNOSTIC = {
    "status": "healthy",
    "generated_at": "2026-09-13T00:00:00Z",
    "instance": {},
    "whatsapp": {
        "connected": True,
        "account_jid": PROTECTED_SENTINEL,
        "connection": {"state": "connected"},
    },
    "sqlite": {
        "fact_export_pending": 2,
        "fact_export_oldest_pending_age_s": 14,
        "fact_export_latest_ack_age_s": 3,
        "fact_export_consumer_state": "current",
    },
}


class _HealthServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, handler, *, valid_body=DIAGNOSTIC, public_body=PUBLIC, sleep=0.0, response_status=None):
        super().__init__(("127.0.0.1", 0), handler)
        self.valid_body = valid_body
        self.public_body = public_body
        self.sleep = sleep
        self.response_status = response_status
        self.requests: list[str | None] = []


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def do_GET(self):
        assert self.path == "/health"
        if self.server.sleep:
            time.sleep(self.server.sleep)
        auth = self.headers.get("Authorization")
        self.server.requests.append(auth)
        body = self.server.valid_body if auth == f"Bearer {VALID_TOKEN}" else self.server.public_body
        data = json.dumps(body).encode("utf-8") if not isinstance(body, str) else body.encode("utf-8")
        status = self.server.response_status
        if status is None:
            status = 503 if isinstance(body, dict) and body.get("status") == "unhealthy" else 200
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except BrokenPipeError:
            pass


class _RedirectHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def do_GET(self):
        self.server.requests.append(self.headers.get("Authorization"))
        self.send_response(302)
        self.send_header("Location", self.server.target_url)
        self.end_headers()


class _CaptureHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def do_GET(self):
        self.server.requests.append(self.headers.get("Authorization"))
        self.send_response(200)
        self.end_headers()


class _SlowDripHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "20")
        self.end_headers()
        for _ in range(20):
            try:
                self.wfile.write(b" ")
                self.wfile.flush()
            except BrokenPipeError:
                return
            time.sleep(0.03)


@pytest.fixture
def health_server():
    server = _HealthServer(_Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def _profile(port: int, timeout_seconds: float = 0.2) -> dict:
    return {
        "schema_version": "health.deployment-qualification-profile.v1",
        "profile_kind": "deployment",
        "timeout_seconds": timeout_seconds,
        "port": port,
    }


def test_profiles_keep_source_tests_separate_and_cover_all_deployment_areas():
    health_profile = json.loads(_HEALTH_PROFILE.read_text())
    health_profile["port"] = 9090
    assert qualifier.parse_profile(health_profile) == {"port": 9090, "timeout_seconds": 5.0}

    deployment_profile = json.loads(_DEPLOYMENT_PROFILE.read_text())
    assert deployment_profile["receipt_contract"] == {
        "contract": "arc.observation.v1",
        "every_required_area": "supported_or_explicitly_unresolved",
        "exceptions_are_nonpromoting": True,
    }
    assert deployment_profile["scope"] == {
        "platform": "macos",
        "host_binding": "private_parameter",
        "shared_record": "neutral",
    }
    assert {area["id"] for area in deployment_profile["required_areas"]} == {
        "health_boundary",
        "host_recovery",
        "runtime_filesystem",
        "permissions_identity",
        "tcc",
        "network_operations",
    }
    health_area = next(area for area in deployment_profile["required_areas"] if area["id"] == "health_boundary")
    assert health_area["requires"] == ["absent_public", "invalid_public", "valid_diagnostic"]
    source_reference = deployment_profile["source_test_reference"]
    registration_name = source_reference["named_profile_registration"]
    assert registration_name == "test:deployment-qualification"
    assert source_reference["source_command_location"] == (
        f'package.json:scripts["{registration_name}"]'
    )
    assert source_reference["source_command_location"] != "package.json:scripts.test"
    assert deployment_profile["source_test_reference"]["source_test_pass_qualifies_deployment"] is False
    assert "message_send" in deployment_profile["forbidden_mutations"]
    package = json.loads(_PACKAGE.read_text())
    assert isinstance(package["scripts"]["test"], str) and package["scripts"]["test"]
    registration = package["scripts"][registration_name]
    assert "pytest-runner.sh" in registration
    for path in (
        "deploy/scripts/tests/test_qualify_health_deployment.py",
        "deploy/scripts/tests/test_health_reader.py",
        "deploy/scripts/tests/test_deployment_effective_config.py",
        "deploy/scripts/tests/test_effective_config_cli_integration.py",
        "deploy/scripts/tests/test_write_effective_config_record.py",
    ):
        assert path in registration


def _bound_context() -> dict[str, str]:
    return {
        "arc_commit": "a" * 40,
        "qfleet_commit": "b" * 40,
        "whatsoup_commit": "c" * 40,
        "run_context_digest": "d" * 64,
    }


def _bound_target() -> dict[str, str]:
    return {
        "host_ref": "host_abcdefgh",
        "user_ref": "usr_abcdefgh",
        "instance_ref": "inst_abcdefgh",
        "inventory_host": "synthetic-host",
        "instance_name": "synthetic-instance",
    }


def _bound_record(port: int) -> dict:
    return {
        "target": _bound_target(),
        "configured": {"instance": {"name": "synthetic-instance", "healthPort": port}},
        "limits": {"timeout_seconds": 0.2},
    }


def test_bound_effective_record_controls_the_health_target_and_refusal_probes_nothing(
    health_server, monkeypatch, tmp_path,
):
    root = tmp_path / "private-root"
    root.mkdir(mode=0o700)
    record = root / "effective.json"
    record.write_text("{}")
    record.chmod(0o600)
    expected_context = _bound_context()
    expected_target = _bound_target()
    calls = []

    def load_record(target, **kwargs):
        calls.append((target, kwargs))
        return _bound_record(health_server.server_port)

    monkeypatch.setattr(qualifier.deployment_effective_config, "load_effective_config", load_record)
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)

    receipt = qualifier.qualify_health_deployment_from_effective_record(
        profile=json.loads(_HEALTH_PROFILE.read_text()),
        effective_record_root=root,
        effective_record_path=record,
        expected_sha256="e" * 64,
        expected_context=expected_context,
        expected_target=expected_target,
    )

    assert receipt["outcome"] == "qualified"
    assert len(calls) == 2
    assert calls[0] == calls[1]
    assert calls[0][1] == {
        "expected_sha256": "e" * 64,
        "expected_context": expected_context,
        "expected_target": expected_target,
    }
    assert [request for request in health_server.requests] == [None, f"Bearer {qualifier.SYNTHETIC_INVALID_TOKEN}", f"Bearer {VALID_TOKEN}"]

    def refuse_record(*_args, **_kwargs):
        raise qualifier.deployment_effective_config.EffectiveConfigRefusal()

    monkeypatch.setattr(qualifier.deployment_effective_config, "load_effective_config", refuse_record)
    monkeypatch.setattr(qualifier, "_fetch_loopback", lambda *_args: pytest.fail("refused evidence must not probe"))
    with pytest.raises(qualifier.deployment_effective_config.EffectiveConfigRefusal):
        qualifier.qualify_health_deployment_from_effective_record(
            profile=json.loads(_HEALTH_PROFILE.read_text()),
            effective_record_root=root,
            effective_record_path=record,
            expected_sha256="e" * 64,
            expected_context=expected_context,
            expected_target=expected_target,
        )


def test_cli_refuses_a_port_override_when_an_effective_record_is_selected(
    health_server, monkeypatch, tmp_path, capsys,
):
    root = tmp_path / "private-root"
    root.mkdir(mode=0o700)
    record = root / "effective.json"
    record.write_text("{}")
    record.chmod(0o600)
    context = _bound_context()
    target = _bound_target()
    monkeypatch.setattr(
        qualifier.deployment_effective_config,
        "load_effective_config",
        lambda *_args, **_kwargs: pytest.fail("a bound port override must refuse before record access"),
    )
    monkeypatch.setattr(qualifier.sys, "argv", [
        "qualify-health-deployment", "--instance", target["instance_name"],
        "--port", str(health_server.server_port),
        "--effective-record-root", str(root), "--effective-record", str(record),
        "--effective-record-sha256", "e" * 64,
        "--arc-commit", context["arc_commit"], "--qfleet-commit", context["qfleet_commit"],
        "--whatsoup-commit", context["whatsoup_commit"], "--run-context-digest", context["run_context_digest"],
        "--host-ref", target["host_ref"], "--user-ref", target["user_ref"],
        "--instance-ref", target["instance_ref"], "--inventory-host", target["inventory_host"],
    ])

    assert qualifier.main() == 3

    receipt = json.loads(capsys.readouterr().out)
    assert receipt["unresolved"] == ["effective_record_unavailable"]
    assert health_server.requests == []


def test_bound_effective_record_change_during_health_observation_refuses_receipt(
    health_server, monkeypatch, tmp_path,
):
    root = tmp_path / "private-root"
    root.mkdir(mode=0o700)
    record = root / "effective.json"
    record.write_text("{}")
    record.chmod(0o600)
    calls = []

    def load_record(target, **kwargs):
        calls.append((target, kwargs))
        if health_server.requests:
            raise qualifier.deployment_effective_config.EffectiveConfigRefusal()
        return _bound_record(health_server.server_port)

    monkeypatch.setattr(qualifier.deployment_effective_config, "load_effective_config", load_record)
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)

    with pytest.raises(qualifier.deployment_effective_config.EffectiveConfigRefusal):
        qualifier.qualify_health_deployment_from_effective_record(
            profile=json.loads(_HEALTH_PROFILE.read_text()),
            effective_record_root=root,
            effective_record_path=record,
            expected_sha256="e" * 64,
            expected_context=_bound_context(),
            expected_target=_bound_target(),
        )

    assert len(calls) == 2
    assert calls[0] == calls[1]
    assert health_server.requests == [
        None, f"Bearer {qualifier.SYNTHETIC_INVALID_TOKEN}", f"Bearer {VALID_TOKEN}",
    ]


def test_refuses_launch_agent_token_fallback_through_a_nonprivate_parent(tmp_path, monkeypatch):
    home = tmp_path / "home"
    launch_agents = home / "Library" / "LaunchAgents"
    launch_agents.mkdir(parents=True, mode=0o700)
    launch_agents.chmod(0o755)
    plist = launch_agents / "com.whatsoup.synthetic-instance.plist"
    plist.write_bytes(plistlib.dumps({"EnvironmentVariables": {"WHATSOUP_HEALTH_TOKEN": VALID_TOKEN}}))
    plist.chmod(0o600)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("WHATSOUP_HEALTH_TOKEN", raising=False)
    monkeypatch.delenv("BOT_ERRORS_HEALTH_TOKEN_SYNTHETIC_INSTANCE", raising=False)

    assert qualifier._validate_launch_agent_path("synthetic-instance", plist) is None
    assert qualifier.resolve_deployment_token("synthetic-instance", launch_agent_plist=plist) is None


def test_qualifies_public_absent_invalid_and_host_resolved_diagnostic_over_loopback(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert receipt["outcome"] == "qualified"
    assert receipt["disclosure_outcome"] == "qualified"
    assert receipt["service_health_outcome"] == "qualified"
    assert [leg["leg"] for leg in receipt["legs"]] == ["absent", "invalid", "valid"]
    absent, invalid, valid = receipt["legs"]
    assert (absent["projection"], absent["body"]) == ("public", "public_valid")
    assert (invalid["projection"], invalid["body"]) == ("public", "public_valid")
    assert (valid["projection"], valid["body"]) == ("diagnostic", "diagnostic_valid")
    assert [leg["http_status_contract"] for leg in receipt["legs"]] == ["matched", "matched", "matched"]
    assert valid["safe"] == {
        "status": "healthy",
        "generated_at_ms": 1789257600000,
        "connected": True,
        "queue": {
            "available": True,
            "consumer_state": "current",
            "pending": 2,
            "oldest_pending_age_s": 14,
            "latest_ack_age_s": 3,
        },
    }
    dumped = json.dumps(receipt)
    for forbidden in (VALID_TOKEN, PROTECTED_SENTINEL, "Authorization", "account_jid", "whatsapp", "sqlite"):
        assert forbidden not in dumped
    assert health_server.requests[0] is None
    assert health_server.requests[1] == f"Bearer {qualifier.SYNTHETIC_INVALID_TOKEN}"
    assert health_server.requests[2] == f"Bearer {VALID_TOKEN}"


def test_marks_public_extra_or_protected_fields_not_qualified(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    health_server.public_body = {**PUBLIC, "whatsapp": {"connected": True}}

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert receipt["outcome"] == "not_qualified"
    assert receipt["disclosure_outcome"] == "not_qualified"
    assert receipt["service_health_outcome"] == "qualified"
    assert [leg["body"] for leg in receipt["legs"][:2]] == ["public_invalid", "public_invalid"]
    assert "public_disclosure_violation" in receipt["unresolved"]


def test_marks_nested_startup_notification_disclosure_not_qualified(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    health_server.public_body = {
        **PUBLIC,
        "startupNotification": {**PUBLIC["startupNotification"], "private_message": "synthetic-secret"},
    }

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert receipt["outcome"] == "not_qualified"
    assert [leg["body"] for leg in receipt["legs"][:2]] == ["public_invalid", "public_invalid"]
    assert "public_disclosure_violation" in receipt["unresolved"]


def test_rejects_an_unrecognized_public_schema_version_even_with_closed_fields(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    health_server.public_body = {**PUBLIC, "schema_version": "health.public.unexpected-v999"}

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert qualifier._public_body_valid(health_server.public_body) is False
    assert [leg["body"] for leg in receipt["legs"][:2]] == ["public_invalid", "public_invalid"]
    assert receipt["outcome"] == "not_qualified"


def test_malformed_public_field_types_fail_qualification_without_classifier_error(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    health_server.public_body = {**PUBLIC, "status": ["healthy"]}

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert receipt["outcome"] == "not_qualified"
    assert [leg["body"] for leg in receipt["legs"][:2]] == ["public_invalid", "public_invalid"]


def test_marks_malformed_valid_body_inconclusive(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    health_server.valid_body = "not-json"

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert receipt["outcome"] == "inconclusive"
    assert receipt["legs"][2]["body"] == "malformed"
    assert receipt["legs"][2]["projection"] == "unobserved"
    assert "valid_body_malformed" in receipt["unresolved"]


def test_requires_protected_diagnostic_container_types_without_emitting_them(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    health_server.valid_body = {key: value for key, value in DIAGNOSTIC.items() if key != "instance"}

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert receipt["outcome"] == "not_qualified"
    assert receipt["legs"][2]["body"] == "diagnostic_invalid"
    assert receipt["legs"][2]["diagnostic_shape"] == "invalid"
    assert "diagnostic_shape_invalid" in receipt["unresolved"]


def test_http_200_with_a_degraded_diagnostic_status_qualifies_the_boundary(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    health_server.valid_body = {**DIAGNOSTIC, "status": "degraded"}

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert receipt["legs"][2]["http_status"] == 200
    assert receipt["legs"][2]["http_status_contract"] == "matched"
    assert receipt["legs"][2]["body"] == "diagnostic_valid"
    assert receipt["legs"][2]["safe"]["status"] == "degraded"
    assert receipt["disclosure_outcome"] == "qualified"
    assert receipt["service_health_outcome"] == "not_qualified"
    assert receipt["outcome"] == "not_qualified"


def test_source_consistent_503_unhealthy_responses_qualify_the_boundary(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    health_server.public_body = {**PUBLIC, "status": "unhealthy"}
    health_server.valid_body = {**DIAGNOSTIC, "status": "unhealthy"}

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert [leg["http_status"] for leg in receipt["legs"]] == [503, 503, 503]
    assert [leg["http_status_contract"] for leg in receipt["legs"]] == ["matched", "matched", "matched"]
    assert receipt["disclosure_outcome"] == "qualified"
    assert receipt["service_health_outcome"] == "not_qualified"
    assert receipt["outcome"] == "not_qualified"


def test_healthy_status_with_disconnected_transport_does_not_qualify_service(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    health_server.valid_body = {
        **DIAGNOSTIC,
        "whatsapp": {**DIAGNOSTIC["whatsapp"], "connected": False},
    }

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert receipt["disclosure_outcome"] == "qualified"
    assert receipt["service_health_outcome"] == "not_qualified"
    assert receipt["outcome"] == "not_qualified"


@pytest.mark.parametrize("status,expected_exit", [("healthy", 0), ("unhealthy", 2)])
def test_cli_reports_disclosure_and_service_health_independently(status, expected_exit, health_server, monkeypatch, capsys):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    health_server.public_body = {**PUBLIC, "status": status}
    health_server.valid_body = {**DIAGNOSTIC, "status": status}
    monkeypatch.setattr(qualifier.sys, "argv", [
        "qualify-health-deployment", "--instance", "synthetic-instance",
        "--port", str(health_server.server_port),
    ])

    assert qualifier.main() == expected_exit

    output = capsys.readouterr()
    receipt = json.loads(output.out)
    assert output.err == ""
    assert receipt["disclosure_outcome"] == "qualified"
    assert receipt["service_health_outcome"] == ("qualified" if expected_exit == 0 else "not_qualified")
    assert receipt["outcome"] == receipt["service_health_outcome"]
    assert len(receipt["legs"]) == 3
    assert VALID_TOKEN not in output.out
    assert PROTECTED_SENTINEL not in output.out


def test_cli_profile_error_reports_both_outcomes_as_inconclusive(tmp_path, monkeypatch, capsys):
    profile = tmp_path / "synthetic-private-profile.json"
    profile.write_text('{"schema_version":"unsupported"}')
    monkeypatch.setattr(qualifier.sys, "argv", [
        "qualify-health-deployment", "--instance", "synthetic-instance",
        "--port", "9090", "--profile", str(profile),
    ])

    assert qualifier.main() == 3

    output = capsys.readouterr()
    receipt = json.loads(output.out)
    assert output.err == ""
    assert receipt["outcome"] == "inconclusive"
    assert receipt["disclosure_outcome"] == "inconclusive"
    assert receipt["service_health_outcome"] == "inconclusive"
    assert receipt["legs"] == []
    assert receipt["unresolved"] == ["profile_unavailable"]
    assert str(profile) not in output.out


@pytest.mark.parametrize("body,status", [("not-json", 200), (DIAGNOSTIC, 302), ({"status": "healthy"}, 200)])
def test_service_health_requires_valid_authenticated_diagnostic(body, status, health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    health_server.valid_body = body
    health_server.response_status = status

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert receipt["service_health_outcome"] == "inconclusive"
    assert receipt["outcome"] != "qualified"


def test_mismatched_health_status_and_http_status_does_not_qualify(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    health_server.response_status = 503

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert [leg["http_status_contract"] for leg in receipt["legs"]] == ["mismatched", "mismatched", "mismatched"]
    assert receipt["outcome"] == "not_qualified"
    assert "health_status_code_mismatch" in receipt["unresolved"]


def test_unsupported_status_code_is_inconclusive(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    health_server.response_status = 418

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert [leg["http_status_contract"] for leg in receipt["legs"]] == ["unsupported", "unsupported", "unsupported"]
    assert receipt["outcome"] == "inconclusive"
    assert "health_status_code_unsupported" in receipt["unresolved"]


def test_diagnostic_error_status_is_inconclusive(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    health_server.valid_body = {**DIAGNOSTIC, "status": "error"}

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert receipt["legs"][2]["http_status_contract"] == "unsupported"
    assert receipt["outcome"] == "inconclusive"
    assert "health_status_code_unsupported" in receipt["unresolved"]


def test_marks_missing_host_token_inconclusive_but_keeps_public_legs(health_server, monkeypatch, tmp_path):
    monkeypatch.delenv("WHATSOUP_HEALTH_TOKEN", raising=False)
    monkeypatch.delenv("BOT_ERRORS_HEALTH_TOKEN_SYNTHETIC_INSTANCE", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert receipt["outcome"] == "inconclusive"
    assert receipt["legs"][0]["body"] == "public_valid"
    assert receipt["legs"][1]["body"] == "public_valid"
    assert receipt["legs"][2] == {
        "leg": "valid",
        "observed_at_ms": receipt["legs"][2]["observed_at_ms"],
        "token": "unavailable",
        "fetch": "not_attempted",
        "body": "none",
        "projection": "unobserved",
        "diagnostic_shape": "not_applicable",
        "http_status_contract": "not_observed",
        "safe": {},
    }
    assert "host_token_unavailable" in receipt["unresolved"]


def test_marks_rejected_host_token_inconclusive(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", "synthetic-rejected-token")

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert receipt["outcome"] == "inconclusive"
    valid = receipt["legs"][2]
    assert (valid["projection"], valid["body"]) == ("unobserved", "public_valid")
    assert "host_token_rejected" in receipt["unresolved"]


def test_marks_loopback_timeout_inconclusive(monkeypatch):
    server = _HealthServer(_Handler, sleep=0.3)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    try:
        receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(server.server_port, 0.03))
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()

    assert receipt["outcome"] == "inconclusive"
    assert [leg["fetch"] for leg in receipt["legs"]] == ["timeout", "timeout", "timeout"]
    assert "loopback_timeout" in receipt["unresolved"]


def test_does_not_follow_loopback_health_redirect_or_forward_bearer():
    capture = _HealthServer(_CaptureHandler)
    redirect = _HealthServer(_RedirectHandler)
    redirect.target_url = f"http://127.0.0.1:{capture.server_port}/capture"
    capture_thread = threading.Thread(target=capture.serve_forever, daemon=True)
    redirect_thread = threading.Thread(target=redirect.serve_forever, daemon=True)
    capture_thread.start()
    redirect_thread.start()
    try:
        result = qualifier._fetch_loopback(
            redirect.server_port,
            f"Bearer {VALID_TOKEN}",
            0.5,
        )
    finally:
        redirect.shutdown()
        capture.shutdown()
        redirect_thread.join(timeout=2)
        capture_thread.join(timeout=2)
        redirect.server_close()
        capture.server_close()

    assert result["fetch"] == "response"
    assert result["http_status"] == 302
    assert redirect.requests == [f"Bearer {VALID_TOKEN}"]
    assert capture.requests == []


def test_enforces_total_deadline_against_a_slow_drip_body():
    server = _HealthServer(_SlowDripHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    started = time.monotonic()
    try:
        result = qualifier._fetch_loopback(server.server_port, None, 0.10)
        elapsed = time.monotonic() - started
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()

    assert result["fetch"] == "timeout"
    assert elapsed < 0.35


def test_marks_deadline_unsupported_inconclusive_without_making_a_request(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    monkeypatch.setattr(qualifier, "_deadline_supported", lambda: False)

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert receipt["outcome"] == "inconclusive"
    assert [leg["fetch"] for leg in receipt["legs"]] == [
        "deadline_unsupported", "deadline_unsupported", "deadline_unsupported",
    ]
    assert "loopback_deadline_unsupported" in receipt["unresolved"]
    assert health_server.requests == []


def test_rejects_oversized_body_even_when_its_prefix_is_valid_public_json(health_server, monkeypatch):
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", VALID_TOKEN)
    public_json = json.dumps(PUBLIC)
    health_server.public_body = public_json + (" " * (qualifier.MAX_BODY_BYTES + 1 - len(public_json)))

    receipt = qualifier.qualify_health_deployment("synthetic-instance", _profile(health_server.server_port))

    assert receipt["outcome"] == "inconclusive"
    assert [leg["body"] for leg in receipt["legs"][:2]] == ["oversized", "oversized"]
    assert "public_body_oversized" in receipt["unresolved"]


def test_rejects_unsafe_instance_name_before_health_reader_resolution(monkeypatch):
    called: list[str] = []
    monkeypatch.setattr(qualifier.health_reader, "instance_health_token", lambda name: called.append(name) or None)

    with pytest.raises(qualifier.ProfileError):
        qualifier.qualify_health_deployment("../escape", _profile(9090))

    assert called == []


def test_accepts_only_current_user_regular_nonlink_launch_agent_plist(monkeypatch, tmp_path):
    monkeypatch.delenv("WHATSOUP_HEALTH_TOKEN", raising=False)
    monkeypatch.delenv("BOT_ERRORS_HEALTH_TOKEN_SYNTHETIC_INSTANCE", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    plist_dir = tmp_path / "Library" / "LaunchAgents"
    plist_dir.mkdir(parents=True, mode=0o700)
    plist = plist_dir / "com.whatsoup.synthetic-instance.plist"
    with plist.open("wb") as handle:
        plistlib.dump({"EnvironmentVariables": {"WHATSOUP_HEALTH_TOKEN": VALID_TOKEN}}, handle)
    os.chmod(plist, stat.S_IRUSR | stat.S_IWUSR)

    assert qualifier.resolve_deployment_token("synthetic-instance", launch_agent_plist=plist) == VALID_TOKEN

    link = plist_dir / "com.whatsoup.link-instance.plist"
    link.symlink_to(plist)
    assert qualifier.resolve_deployment_token("link-instance", launch_agent_plist=link) is None

    os.chmod(plist, stat.S_IRUSR | stat.S_IWUSR | stat.S_IWGRP)
    assert qualifier.resolve_deployment_token("synthetic-instance", launch_agent_plist=plist) is None


def test_refuses_launch_agent_plist_substitution_after_validation_without_authorization(
    health_server, monkeypatch, tmp_path,
):
    monkeypatch.delenv("WHATSOUP_HEALTH_TOKEN", raising=False)
    monkeypatch.delenv("BOT_ERRORS_HEALTH_TOKEN_SYNTHETIC_INSTANCE", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    plist_dir = tmp_path / "Library" / "LaunchAgents"
    plist_dir.mkdir(parents=True, mode=0o700)
    plist = plist_dir / "com.whatsoup.synthetic-instance.plist"
    attacker = tmp_path / "attacker.plist"
    with plist.open("wb") as handle:
        plistlib.dump({"EnvironmentVariables": {"WHATSOUP_HEALTH_TOKEN": VALID_TOKEN}}, handle)
    with attacker.open("wb") as handle:
        plistlib.dump({"EnvironmentVariables": {"WHATSOUP_HEALTH_TOKEN": "synthetic-attacker-token"}}, handle)
    os.chmod(plist, stat.S_IRUSR | stat.S_IWUSR)
    os.chmod(attacker, stat.S_IRUSR | stat.S_IWUSR)

    original_validate = qualifier._validate_launch_agent_path

    def swap_after_validation(instance, explicit_path):
        checked = original_validate(instance, explicit_path)
        assert checked is not None
        plist.unlink()
        plist.symlink_to(attacker)
        return checked

    monkeypatch.setattr(qualifier, "_validate_launch_agent_path", swap_after_validation)
    receipt = qualifier.qualify_health_deployment(
        "synthetic-instance", _profile(health_server.server_port), launch_agent_plist=plist,
    )

    assert health_server.requests == [None, f"Bearer {qualifier.SYNTHETIC_INVALID_TOKEN}"]
    assert f"Bearer synthetic-attacker-token" not in health_server.requests
    assert receipt["legs"][2]["token"] == "unavailable"
    assert receipt["legs"][2]["fetch"] == "not_attempted"


def test_refuses_private_regular_plist_replacement_after_validation_without_authorization(
    health_server, monkeypatch, tmp_path,
):
    monkeypatch.delenv("WHATSOUP_HEALTH_TOKEN", raising=False)
    monkeypatch.delenv("BOT_ERRORS_HEALTH_TOKEN_SYNTHETIC_INSTANCE", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    plist_dir = tmp_path / "Library" / "LaunchAgents"
    plist_dir.mkdir(parents=True, mode=0o700)
    plist = plist_dir / "com.whatsoup.synthetic-instance.plist"
    attacker = tmp_path / "attacker.plist"
    with plist.open("wb") as handle:
        plistlib.dump({"EnvironmentVariables": {"WHATSOUP_HEALTH_TOKEN": VALID_TOKEN}}, handle)
    with attacker.open("wb") as handle:
        plistlib.dump({"EnvironmentVariables": {"WHATSOUP_HEALTH_TOKEN": "synthetic-attacker-token"}}, handle)
    os.chmod(plist, stat.S_IRUSR | stat.S_IWUSR)
    os.chmod(attacker, stat.S_IRUSR | stat.S_IWUSR)

    original_validate = qualifier._validate_launch_agent_path

    def replace_after_validation(instance, explicit_path):
        checked = original_validate(instance, explicit_path)
        assert checked is not None
        os.replace(attacker, plist)
        return checked

    monkeypatch.setattr(qualifier, "_validate_launch_agent_path", replace_after_validation)
    receipt = qualifier.qualify_health_deployment(
        "synthetic-instance", _profile(health_server.server_port), launch_agent_plist=plist,
    )

    assert health_server.requests == [None, f"Bearer {qualifier.SYNTHETIC_INVALID_TOKEN}"]
    assert f"Bearer synthetic-attacker-token" not in health_server.requests
    assert receipt["legs"][2]["token"] == "unavailable"
    assert receipt["legs"][2]["fetch"] == "not_attempted"
