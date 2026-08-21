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
    _freeze_body_age(monkeypatch)
    details = _mod.health_probe_details(200, DIAGNOSTIC_BODY_NO_NAME, "primary-bot")
    assert "health_identity_missing" in details


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
