"""Behavioral tests for the shared authenticated /health reader (register F01).

The load-bearing contract: the public liveness envelope must never be read as
authenticated diagnostics, and a missing/rejected token yields `unobserved`
(fix the token) rather than a workload verdict or the `public` outcome.
"""
import importlib.util
import pathlib

_MOD_PATH = pathlib.Path(__file__).resolve().parents[1] / "lib" / "health_reader.py"
_spec = importlib.util.spec_from_file_location("health_reader", _MOD_PATH)
health_reader = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(health_reader)

DISCLOSED = {"schema_version": "health.v3", "status": "degraded", "whatsapp": {"connected": True}, "instance": {"name": "primary-bot"}}
PUBLIC = {"schema_version": "health.public.v1", "status": "healthy", "generated_at": "2026-08-20T00:00:00Z"}


def test_disclosed_body_is_disclosed() -> None:
    assert health_reader.health_body_is_disclosed(DISCLOSED) is True


def test_public_envelope_is_not_disclosed() -> None:
    assert health_reader.health_body_is_disclosed(PUBLIC) is False


def test_non_dict_and_whatsapp_nondict_are_not_disclosed() -> None:
    assert health_reader.health_body_is_disclosed("nope") is False
    assert health_reader.health_body_is_disclosed({"status": "healthy"}) is False
    assert health_reader.health_body_is_disclosed({"whatsapp": "notadict"}) is False


def test_is_public_envelope() -> None:
    assert health_reader.is_public_envelope(PUBLIC) is True
    assert health_reader.is_public_envelope(DISCLOSED) is False
    assert health_reader.is_public_envelope(None) is False


def test_classify_projection_diagnostic_requires_token() -> None:
    # Authority-lattice public-projection ceiling: a diagnostic-SHAPED body
    # obtained WITHOUT authentication must never gain diagnostic authority —
    # anyone can shape a body; only the accepted token proves the projection.
    assert health_reader.classify_projection(DISCLOSED, token_sent=True) == "diagnostic"
    assert health_reader.classify_projection(DISCLOSED, token_sent=False) == "unobserved"


def test_classify_projection_public_only_without_token() -> None:
    # Public envelope with no token sent is a liveness-only observation.
    assert health_reader.classify_projection(PUBLIC, token_sent=False) == "public"


def test_classify_projection_public_with_token_is_unobserved() -> None:
    # A token WAS sent but we still got the public envelope => the token was
    # rejected; that is unobserved (fix the token), never a public verdict.
    assert health_reader.classify_projection(PUBLIC, token_sent=True) == "unobserved"


def test_classify_projection_unrecognised_and_none_are_unobserved() -> None:
    assert health_reader.classify_projection(None, token_sent=True) == "unobserved"
    assert health_reader.classify_projection({"weird": 1}, token_sent=False) == "unobserved"


def test_instance_health_token_env_override(monkeypatch) -> None:
    monkeypatch.setenv("BOT_ERRORS_HEALTH_TOKEN_PRIMARY_BOT", "  tok-override  ")
    assert health_reader.instance_health_token("primary-bot") == "tok-override"


def test_instance_health_token_shared_env(monkeypatch) -> None:
    monkeypatch.delenv("BOT_ERRORS_HEALTH_TOKEN_PRIMARY_BOT", raising=False)
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", "shared-tok")
    assert health_reader.instance_health_token("primary-bot") == "shared-tok"


def test_instance_health_token_missing(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("BOT_ERRORS_HEALTH_TOKEN_PRIMARY_BOT", raising=False)
    monkeypatch.delenv("WHATSOUP_HEALTH_TOKEN", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))  # no tokens.env under this HOME
    assert health_reader.instance_health_token("primary-bot") is None


def test_read_local_health_missing_token_is_unobserved_without_fetching(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("BOT_ERRORS_HEALTH_TOKEN_PRIMARY_BOT", raising=False)
    monkeypatch.delenv("WHATSOUP_HEALTH_TOKEN", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    called = []

    def _fetch(url, headers):
        called.append(url)
        return (200, "{}")

    projection, status, body = health_reader.read_local_health("primary-bot", 9099, fetch=_fetch)
    assert projection == "unobserved"
    assert called == []  # missing token => do not even probe; operator action is provision the token


def test_read_local_health_diagnostic(monkeypatch) -> None:
    import json
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", "tok")
    sent = {}

    def _fetch(url, headers):
        sent["auth"] = headers.get("Authorization")
        return (200, json.dumps(DISCLOSED))

    projection, status, body = health_reader.read_local_health("primary-bot", 9099, fetch=_fetch)
    assert projection == "diagnostic"
    assert status == 200
    assert sent["auth"] == "Bearer tok"


def test_read_local_health_rejected_token_is_unobserved(monkeypatch) -> None:
    import json
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", "bad-tok")

    def _fetch(url, headers):
        return (200, json.dumps(PUBLIC))  # token rejected -> public envelope

    projection, status, body = health_reader.read_local_health("primary-bot", 9099, fetch=_fetch)
    assert projection == "unobserved"


def test_read_local_health_transport_error_is_unobserved(monkeypatch) -> None:
    monkeypatch.setenv("WHATSOUP_HEALTH_TOKEN", "tok")

    def _fetch(url, headers):
        raise OSError("connection refused")

    projection, status, body = health_reader.read_local_health("primary-bot", 9099, fetch=_fetch)
    assert projection == "unobserved"
    assert status is None
