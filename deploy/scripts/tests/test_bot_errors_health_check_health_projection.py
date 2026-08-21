"""F01: the daily health probe must authenticate and must never promote the
public liveness envelope into identity/auth verdicts.

Register F01 contract: `health_identity_missing` is actionable only after a
privileged (diagnostic) projection is proven; a missing/rejected token yields
unobserved/inconclusive evidence, never a workload FAIL.
"""
from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()

PUBLIC_BODY = json.dumps(
    {
        "schema_version": "health.public.v1",
        "status": "healthy",
        "generated_at": "2026-08-20T00:00:00Z",
        "startupNotification": {"state": "sent"},
    }
)

DIAGNOSTIC_BODY_NO_NAME = json.dumps(
    {
        "schema_version": "health.v3",
        "status": "healthy",
        "generated_at": "2026-08-20T00:00:00Z",
        "whatsapp": {"connected": True, "connection": {"state": "connected"}},
        "instance": {},
    }
)


def _freeze_body_age(monkeypatch) -> None:
    # Pin the clock so generated_at freshness markers never contaminate the
    # identity assertions under test.
    monkeypatch.setattr(_mod, "current_epoch", lambda: _mod.parse_iso_epoch("2026-08-20T00:00:00Z"))


def test_public_envelope_never_yields_identity_missing(monkeypatch) -> None:
    _freeze_body_age(monkeypatch)
    details = _mod.health_probe_details(200, PUBLIC_BODY, "primary-bot")
    assert "health_identity_missing" not in details
    line = _mod.format_health_probe("http://127.0.0.1:9099/health", 200, PUBLIC_BODY, "primary-bot")
    assert not line.startswith("FAIL")


def test_diagnostic_body_without_name_still_flags_identity_missing(monkeypatch) -> None:
    # token_sent=True: identity is only assertable under the AUTHENTICATED
    # diagnostic projection.
    _freeze_body_age(monkeypatch)
    details = _mod.health_probe_details(200, DIAGNOSTIC_BODY_NO_NAME, "primary-bot", True)
    assert "health_identity_missing" in details


def test_anonymous_diagnostic_shaped_body_hits_projection_ceiling(monkeypatch) -> None:
    # Authority-lattice ceiling: an UNAUTHENTICATED diagnostic-shaped body is
    # invalid evidence for privileged claims — identity/auth/DB/provider fields
    # must not be evaluated from it, and it must not fail the workload.
    _freeze_body_age(monkeypatch)
    body = json.dumps(
        {
            "status": "healthy",
            "generated_at": "2026-08-20T00:00:00Z",
            "whatsapp": {"connected": True, "connection": {"state": "connected"}},
            "instance": {"name": "other-bot"},
        }
    )
    line = _mod.format_health_probe("http://127.0.0.1:9099/health", 200, body, "primary-bot", False)
    assert "health_identity_mismatch" not in line
    assert "health_identity_missing" not in line
    assert "health_projection=unobserved" in line
    assert "health_unauthenticated_disclosure" in line
    assert not line.startswith("FAIL")


class _FakeResponse:
    status = 200

    def __init__(self, body: str) -> None:
        self._body = body.encode("utf-8")

    def read(self, n: int) -> bytes:
        return self._body[:n]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_probe_health_sends_resolved_bearer(monkeypatch) -> None:
    _freeze_body_age(monkeypatch)
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", "tok-123")
    seen: dict[str, str | None] = {}

    def fake_urlopen(req, timeout=None):
        seen["auth"] = req.get_header("Authorization")
        return _FakeResponse(DIAGNOSTIC_BODY_NO_NAME)

    monkeypatch.setattr(_mod, "urlopen", fake_urlopen)
    _mod.probe_health(9099, "primary-bot")
    assert seen.get("auth") == "Bearer tok-123"


def test_probe_health_missing_token_still_probes_and_warns(monkeypatch) -> None:
    # The anonymous attempt MUST still happen: a DOWN on-demand agent is detected
    # via connection-refused on this very path (see the on-demand agent test in
    # tests/scripts/bot-errors-health-check.test.ts). Missing-token semantics are
    # expressed as a WARN marker + truthful projection evidence, never a silent
    # public reading and never a workload FAIL.
    _freeze_body_age(monkeypatch)
    monkeypatch.delenv("WHATSOUP_HEALTH_TOKEN", raising=False)
    monkeypatch.delenv("BOT_ERRORS_HEALTH_TOKEN_PRIMARY_BOT", raising=False)
    monkeypatch.setenv("HOME", "/nonexistent-home-for-token-isolation")
    seen: dict[str, object] = {}

    def fake_urlopen(req, timeout=None):
        seen["auth"] = req.get_header("Authorization")
        return _FakeResponse(PUBLIC_BODY)

    monkeypatch.setattr(_mod, "urlopen", fake_urlopen)
    line = _mod.probe_health(9099, "primary-bot")

    assert seen["auth"] is None
    assert line.startswith("WARN")
    assert "health_token_missing" in line
    assert "health_projection=public" in line
    assert not line.startswith("FAIL")


def test_probe_health_missing_token_connection_refused_stays_legacy_fail(monkeypatch) -> None:
    monkeypatch.delenv("WHATSOUP_HEALTH_TOKEN", raising=False)
    monkeypatch.delenv("BOT_ERRORS_HEALTH_TOKEN_PRIMARY_BOT", raising=False)
    monkeypatch.setenv("HOME", "/nonexistent-home-for-token-isolation")

    def refused_urlopen(req, timeout=None):
        raise _mod.URLError("Connection refused")

    monkeypatch.setattr(_mod, "urlopen", refused_urlopen)
    line = _mod.probe_health(9099, "primary-bot")

    assert line.startswith("FAIL")
    assert "Connection refused" in line


def test_token_rejected_is_warn_not_identity_fail(monkeypatch) -> None:
    _freeze_body_age(monkeypatch)
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", "tok-123")

    def fake_urlopen(req, timeout=None):
        # Token sent but the server still returned the public projection:
        # the token was rejected — monitoring-config debt, not workload failure.
        return _FakeResponse(PUBLIC_BODY)

    monkeypatch.setattr(_mod, "urlopen", fake_urlopen)
    line = _mod.probe_health(9099, "primary-bot")
    assert "health_identity_missing" not in line
    assert not line.startswith("FAIL")
    assert "health_token_rejected" in line
    assert line.startswith("WARN")


def test_public_503_without_token_is_not_promoted_to_workload_failure(monkeypatch) -> None:
    _freeze_body_age(monkeypatch)
    body = json.dumps({**json.loads(PUBLIC_BODY), "status": "unhealthy"})

    line = _mod.format_health_probe(
        "http://127.0.0.1:9099/health",
        503,
        body,
        "primary-bot",
        False,
    )

    assert "health_projection=public" in line
    assert not line.startswith("FAIL")


def test_token_rejected_public_503_is_monitoring_warning_not_workload_failure(monkeypatch) -> None:
    _freeze_body_age(monkeypatch)
    body = json.dumps({**json.loads(PUBLIC_BODY), "status": "unhealthy"})

    line = _mod.format_health_probe(
        "http://127.0.0.1:9099/health",
        503,
        body,
        "primary-bot",
        True,
    )

    assert "health_projection=unobserved" in line
    assert "health_token_rejected" in line
    assert line.startswith("WARN")


def test_dry_injected_body_is_authorized_diagnostic_evidence(monkeypatch) -> None:
    # BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON is operator-supplied fixture content,
    # not an anonymous network read: it evaluates under the diagnostic
    # projection (identity checks apply) without any token in the environment.
    _freeze_body_age(monkeypatch)
    monkeypatch.delenv("WHATSOUP_HEALTH_TOKEN", raising=False)
    monkeypatch.delenv("BOT_ERRORS_HEALTH_TOKEN_PRIMARY_BOT", raising=False)
    monkeypatch.setenv("BOT_ERRORS_DRY_HEALTH_RESPONSE_JSON", DIAGNOSTIC_BODY_NO_NAME)
    monkeypatch.setenv("BOT_ERRORS_DRY_HEALTH_STATUS", "200")
    line = _mod.probe_health(9099, "primary-bot")
    assert "health_projection=diagnostic" in line
    assert "health_unauthenticated_disclosure" not in line
    assert "health_identity_missing" in line
