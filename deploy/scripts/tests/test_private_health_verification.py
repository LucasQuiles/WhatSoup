"""Private (authenticated) /health verification and carried disconnect decision.

Plan §7 / §10 PRIVATE_HEALTH_UNVERIFIED: HTTP 200 alone proves none of
authentication, connectivity or debt. A read is verified only with a resolved
token, the diagnostic projection with the expected types, an HTTP status that
agrees with the body's own status, and a fresh generated_at. Each failure has
its own outcome. The consumers also stop reading a bare 401 as confirmed
revocation once the body carries the transport's disconnect_decision.
All identities are fabricated.
"""
from __future__ import annotations

import importlib.util
import json
import socket
import threading
from datetime import datetime, timezone
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


health_reader = _load("health_reader_private_verification", _SCRIPTS / "lib" / "health_reader.py")

NOW_MS = int(datetime(2026, 9, 25, 4, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)
FRESH = "2026-09-25T03:59:58.000Z"
TOKEN = "fabricated-health-token-abc123"


def _body(status: str = "healthy", *, generated_at: str = FRESH, name: str = "fab-bot", **connection) -> dict:
    conn = {"state": "connected", "auth_failure_class": "none", **connection}
    return {
        "status": status,
        "generated_at": generated_at,
        "instance": {"name": name},
        "whatsapp": {"connected": status == "healthy", "connection": conn},
    }


def _verify(http_status, body, **kwargs):
    raw = body if isinstance(body, str) else json.dumps(body)
    return health_reader.verify_private_health(http_status, raw, now_ms=NOW_MS, **kwargs)


# --- disconnect_decision_reading ---------------------------------------------

def test_disconnect_decision_reading_kinds() -> None:
    read = health_reader.disconnect_decision_reading
    assert read({"last_status_code": 401}) == ("absent", None)
    assert read(None) == ("absent", None)
    assert read({"disconnect_decision": None}) == ("none", None)
    assert read({"disconnect_decision": {"version": 1, "classification": "ambiguous_401_parked"}}) == (
        "classified", "ambiguous_401_parked")
    # Unknown future values stay unknown — never terminal, never healthy.
    assert read({"disconnect_decision": {"version": 1, "classification": "device_quarantined_v2"}}) == (
        "unknown", None)
    assert read({"disconnect_decision": {"version": 2, "classification": "ambiguous_401_parked"}}) == (
        "unknown", None)
    assert read({"disconnect_decision": "confirmed_device_removed"}) == ("unknown", None)


def test_python_classification_vocabulary_matches_typescript_source() -> None:
    ts = (_SCRIPTS.parents[1] / "src" / "lib" / "disconnect-classification.ts").read_text(encoding="utf-8")
    block = ts.split("export const DISCONNECT_CLASSIFICATIONS = [", 1)[1].split("] as const;", 1)[0]
    ts_values = {line.strip().strip(",").strip("'") for line in block.splitlines()
                 if line.strip().startswith("'")}
    assert ts_values == set(health_reader.DISCONNECT_CLASSIFICATIONS)


# --- verify_private_health ---------------------------------------------------

def test_fresh_healthy_diagnostic_body_is_verified() -> None:
    verdict = _verify(200, _body())
    assert verdict["verified"] is True
    assert verdict["outcome"] == "verified"
    assert verdict["diagnostic_code"] is None
    assert verdict["service_status"] == "healthy"
    assert verdict["disconnect_classification"] == "absent"


def test_private_degraded_200_is_verified_and_reports_degraded_not_healthy() -> None:
    verdict = _verify(200, _body("degraded"))
    assert verdict["verified"] is True
    assert verdict["service_status"] == "degraded"


def test_private_unhealthy_503_body_is_verified_with_its_classification() -> None:
    body = _body(
        "unhealthy",
        state="disconnected",
        auth_failure_class="auth_401_ambiguous_parked",
        disconnect_decision={"version": 1, "classification": "ambiguous_401_parked"},
    )
    verdict = _verify(503, body)
    assert verdict["verified"] is True
    assert verdict["service_status"] == "unhealthy"
    assert verdict["disconnect_classification"] == "ambiguous_401_parked"


def test_public_only_200_is_rejected_as_public_fallback() -> None:
    public = {"schema_version": "health.public.v1", "status": "healthy", "generated_at": FRESH,
              "startupNotification": {"state": "sent"}}
    verdict = _verify(200, public)
    assert verdict["verified"] is False
    assert verdict["outcome"] == "public_fallback"
    assert verdict["diagnostic_code"] == "PRIVATE_HEALTH_UNVERIFIED"
    assert verdict["service_status"] is None


@pytest.mark.parametrize("raw", ["", "{not json", "<html>502</html>", "[1, 2]", "null", "\"healthy\""])
def test_malformed_json_is_rejected(raw: str) -> None:
    verdict = _verify(200, raw)
    assert verdict["verified"] is False
    assert verdict["outcome"] == "malformed_json"
    assert verdict["service_status"] is None


def test_stale_body_is_rejected_and_future_skew_is_distinct() -> None:
    assert _verify(200, _body(generated_at="2026-09-25T03:58:00.000Z"))["outcome"] == "stale"
    assert _verify(200, _body(generated_at="2026-09-25T04:01:00.000Z"))["outcome"] == "future_skew"
    assert _verify(200, _body(generated_at="not-a-time"))["outcome"] == "schema_invalid"
    naive = _verify(200, _body(generated_at="2026-09-25T03:59:58"))
    assert (naive["outcome"], naive["problem"]) == ("schema_invalid", "generated_at")


def test_http_status_must_agree_with_body_status() -> None:
    assert _verify(200, _body("unhealthy"))["outcome"] == "http_status_mismatch"
    assert _verify(503, _body("healthy"))["outcome"] == "http_status_mismatch"
    assert _verify(500, _body("degraded"))["outcome"] == "http_status_mismatch"


@pytest.mark.parametrize(
    ("mutate", "problem"),
    [
        (lambda b: b.pop("whatsapp"), "projection"),
        (lambda b: b["whatsapp"].__setitem__("connected", "true"), "whatsapp.connected"),
        (lambda b: b["whatsapp"].__setitem__("connection", []), "whatsapp.connection"),
        (lambda b: b["whatsapp"]["connection"].pop("auth_failure_class"), "whatsapp.connection.auth_failure_class"),
        (lambda b: b["whatsapp"]["connection"].__setitem__("disconnect_decision", "parked"),
         "whatsapp.connection.disconnect_decision"),
        (lambda b: b.pop("instance"), "instance.name"),
        (lambda b: b.__setitem__("status", "green"), "status"),
        (lambda b: b.__setitem__("schema_version", 3), "schema_version"),
    ],
)
def test_structure_and_types_are_required(mutate, problem: str) -> None:
    body = _body()
    mutate(body)
    verdict = _verify(200, body)
    assert verdict["verified"] is False
    assert (verdict["outcome"], verdict["problem"]) == ("schema_invalid", problem)


def test_unknown_future_classification_is_verified_but_stays_unknown() -> None:
    body = _body("degraded", disconnect_decision={"version": 1, "classification": "device_quarantined_v2"})
    verdict = _verify(200, body)
    assert verdict["verified"] is True
    assert verdict["disconnect_classification"] == "unknown"


def test_identity_mismatch_is_rejected() -> None:
    assert _verify(200, _body(name="other-bot"), expected_instance="fab-bot")["outcome"] == "identity_mismatch"


# --- read_private_health -----------------------------------------------------

@pytest.fixture
def no_token(monkeypatch, tmp_path):
    for key in ("WHATSOUP_HEALTH_TOKEN", "BOT_ERRORS_HEALTH_TOKEN_FAB_BOT"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))


def test_token_resolution_failure_never_probes(no_token) -> None:
    calls: list = []
    verdict = health_reader.read_private_health("fab-bot", 9, fetch=lambda *a: calls.append(a), now_ms=NOW_MS)
    assert verdict["outcome"] == "token_unresolved"
    assert verdict["diagnostic_code"] == "PRIVATE_HEALTH_UNVERIFIED"
    assert calls == []


def _with_token(monkeypatch) -> None:
    monkeypatch.setenv("BOT_ERRORS_HEALTH_TOKEN_FAB_BOT", TOKEN)


def test_timeout_and_transport_error_are_distinct(monkeypatch) -> None:
    _with_token(monkeypatch)

    def timed_out(_url, _headers):
        raise health_reader.HealthTransportError("read", None, timed_out=True)

    def refused(_url, _headers):
        raise health_reader.HealthTransportError("connect", 61)

    def raw_timeout(_url, _headers):
        raise TimeoutError()

    assert health_reader.read_private_health("fab-bot", 9, fetch=timed_out, now_ms=NOW_MS)["outcome"] == "timeout"
    assert health_reader.read_private_health("fab-bot", 9, fetch=raw_timeout, now_ms=NOW_MS)["outcome"] == "timeout"
    assert health_reader.read_private_health("fab-bot", 9, fetch=refused, now_ms=NOW_MS)["outcome"] == "transport_error"


def test_token_is_sent_only_as_a_header_and_never_returned(monkeypatch) -> None:
    _with_token(monkeypatch)
    seen: dict = {}

    def fetch(url, headers):
        seen["url"], seen["headers"] = url, dict(headers)
        return 200, json.dumps(_body())

    verdict = health_reader.read_private_health("fab-bot", 9099, fetch=fetch, now_ms=NOW_MS)
    assert verdict["verified"] is True
    assert seen["headers"] == {"Authorization": f"Bearer {TOKEN}"}
    assert TOKEN not in seen["url"]
    assert TOKEN not in json.dumps(verdict)


def test_real_loopback_timeout_is_classified_as_timeout(monkeypatch) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    accepted: list = []
    thread = threading.Thread(target=lambda: accepted.append(listener.accept()), daemon=True)
    thread.start()
    try:
        with pytest.raises(health_reader.HealthTransportError) as caught:
            health_reader.fetch_loopback_health(port, "/health", {}, timeout=0.2)
        assert caught.value.timed_out is True
    finally:
        thread.join(timeout=2)
        for conn, _addr in accepted:
            conn.close()
        listener.close()


# --- consumers stop treating every 401 as confirmed revocation ---------------

health_check = _load("bot_errors_health_check_private_verification", _SCRIPTS / "bot-errors-health-check.py")
ground_truth = _load("fleet_ground_truth_private_verification", _SCRIPTS / "fleet-ground-truth.py")


def _probe(monkeypatch, http_status: int, body: dict) -> str:
    monkeypatch.setattr(health_check, "current_epoch",
                        lambda: health_check.parse_iso_epoch(body["generated_at"]))
    return health_check.health_probe_details(http_status, json.dumps(body), "fab-bot", token_sent=True)


def _disconnected(auth_class: str, decision) -> dict:
    body = _body(
        "degraded" if auth_class == "auth_401_ambiguous_retrying" else "unhealthy",
        state="reconnecting" if auth_class == "auth_401_ambiguous_retrying" else "disconnected",
        auth_failure_class=auth_class,
        last_status_code=401,
        last_disconnect_reason="loggedOut",
    )
    if decision is not ...:
        body["whatsapp"]["connection"]["disconnect_decision"] = decision
    return body


def test_health_check_ambiguous_retry_is_not_physical_intervention(monkeypatch) -> None:
    details = _probe(monkeypatch, 200, _disconnected(
        "auth_401_ambiguous_retrying", {"version": 1, "classification": "ambiguous_401_reconnecting"}))
    assert "physical_intervention_required" not in details
    assert "disconnect_classification=ambiguous_401_reconnecting" in details


def test_health_check_parked_401_still_needs_a_human_and_names_its_class(monkeypatch) -> None:
    details = _probe(monkeypatch, 503, _disconnected(
        "auth_401_ambiguous_parked", {"version": 1, "classification": "ambiguous_401_parked"}))
    assert "physical_intervention_required" in details
    assert "auth_failure_class=auth_401_ambiguous_parked" in details


def test_health_check_legacy_body_keeps_the_conservative_401_rule(monkeypatch) -> None:
    body = _disconnected("auth_bond_at_risk", ...)
    details = _probe(monkeypatch, 503, body)
    assert "physical_intervention_required" in details
    assert "disconnect_classification" not in details


def _bond_verdicts(body: dict) -> list:
    verdicts: list = []
    ground_truth._bond_axis(body, NOW_MS, verdicts)
    return [v["verdict"] for v in verdicts]


def test_ground_truth_only_confirmed_removal_is_server_revoked() -> None:
    confirmed = _disconnected("serverside_logout_irreversible",
                              {"version": 1, "classification": "confirmed_device_removed"})
    confirmed["whatsapp"]["connected"] = False
    assert _bond_verdicts(confirmed) == ["needs_physical_repair"]

    parked = _disconnected("auth_401_ambiguous_parked", {"version": 1, "classification": "ambiguous_401_parked"})
    parked["whatsapp"]["connected"] = False
    assert _bond_verdicts(parked) == ["needs_investigation"]

    retrying = _disconnected("auth_401_ambiguous_retrying",
                             {"version": 1, "classification": "ambiguous_401_reconnecting"})
    retrying["whatsapp"]["connected"] = False
    assert _bond_verdicts(retrying) == []

    legacy = _disconnected("none", ...)
    legacy["whatsapp"]["connected"] = False
    assert _bond_verdicts(legacy) == ["needs_physical_repair"]
