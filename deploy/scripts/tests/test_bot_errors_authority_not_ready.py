"""IncidentStore authority that is not ready must hold BOT ERRORS work, never lose it.

Not ready means: the authority settings are missing, the producer credential is
missing or unreadable, the authority refused the credential (401) or its scope
(403), or rate-limited the producer (429). The event stays in the outbox with
backoff and is never quarantined or dead-lettered for that reason. Only an
identity conflict or a malformed authority reply is terminal.

A notice the dispatcher derives inside a pass (flap storm, flap resolve, stale
renotify, auto-close digest, poison meta-alert, credential meta-alert) must not
reach a transport without a grant either.
"""

from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
_DISPATCHER = _SCRIPTS / "bot-errors-dispatcher.py"
_HEALTH = _SCRIPTS / "bot-errors-health-check.py"

SOURCE = "agent_turn_admission_rejected"
INSTANCE = "instance-x"
MACHINE = "unknown"
SCOPE = "cs1_a1b2c3d4e5f60718"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_CONVERSATION_SCOPED_SOURCES",
    "BOT_ERRORS_DRY_SEND_CAPTURE",
    "BOT_ERRORS_DRY_AUTHORITY_CAPTURE",
    "BOT_ERRORS_TEST_MODE",
    "BOT_ERRORS_INCIDENT_AUTHORITY_URL",
    "BOT_ERRORS_DISPATCHER_AUTHORITY_CREDENTIAL_FILE",
    "BOT_ERRORS_INCIDENT_AUTHORITY_MAX_ATTEMPTS",
]
_LOOPBACK_AUTHORITY = "http://127.0.0.1:7419/api/signals"


@pytest.fixture(autouse=True)
def _clean_env():
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    for k in _ENV_KEYS:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


@pytest.fixture
def credential_root():
    # The credential reader requires every parent to be private to the user.
    with TemporaryDirectory(prefix="whatsoup-authority-not-ready-", dir=Path.home()) as directory:
        root = Path(directory)
        root.chmod(0o700)
        yield root


def _load_module(script: Path, state_dir: Path, name: str):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location(f"{name}_{state_dir.name}", script)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _load(state_dir: Path):
    return _load_module(_DISPATCHER, state_dir, "bot_errors_dispatcher_not_ready")


def _event(event_id: str) -> dict:
    return {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "warning",
        "machine": MACHINE,
        "instance": INSTANCE,
        "source": SOURCE,
        "id": event_id,
        "createdAt": "2026-09-02T02:33:05.995Z",
        "conversationScope": SCOPE,
        "summary": {"failureClass": "unknown", "length": 44, "correlationDigest": "de" * 32},
        "evidence": {"failureClass": "Error", "length": 88, "correlationDigest": "00" * 32},
        "delivery": {"attempts": 1, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }


def _open_incident(mod, paths, event: dict) -> None:
    key = mod.incident_key(event)
    now = int(time.time())
    mod.save_incident_state(paths, {
        "version": 1,
        "openIncidents": {key: {"status": "open", "openedAt": now - 600}},
        "lastSentAt": {key: now - 60},
        "conversationScopes": {},
    })


def _seed_outbox(paths, event: dict) -> Path:
    queued = paths["outbox"] / f"20260902.{INSTANCE}.{SOURCE}.{event['id']}.json"
    queued.write_text(json.dumps(event, indent=2))
    queued.chmod(0o600)
    return queued


class _Response:
    def __init__(self, status: int):
        self.status = status

    def read(self, limit):
        return b"{}"[:limit]

    def getheader(self, _name):
        return None


class _Connection:
    def __init__(self, status: int, requests: list):
        self.status = status
        self.requests = requests

    def request(self, method, path, body, headers):
        self.requests.append(path)

    def getresponse(self):
        return _Response(self.status)

    def close(self):
        return


def _authority_answering(mod, status: int, requests: list):
    """The real client, with its connection replaced by one fixed HTTP answer."""
    real = mod.IncidentAuthorityClient

    def build(url, credential, **kwargs):
        return real(
            url,
            credential,
            connection_factory=lambda _host, _port, _timeout: _Connection(status, requests),
            **kwargs,
        )

    return build


def _write_credential(root: Path) -> Path:
    path = root / "dispatcher.credential"
    path.write_text("narrow-secret\n", encoding="utf-8")
    path.chmod(0o600)
    return path


def _assert_held_in_outbox(paths, reason: str, count: int = 1) -> None:
    held = sorted(paths["outbox"].glob("*.json"))
    assert len(held) == count, f"not-ready events must stay in the outbox: {held!r}"
    assert list(paths["quarantine"].glob("*authority-rejected*")) == []
    assert [p for p in paths["dead_letter"].glob("*") if p.is_file()] == []
    for path in held:
        delivery = json.loads(path.read_text()).get("delivery") or {}
        assert delivery.get("incidentAuthorityStatus") == "not_ready"
        assert delivery.get("incidentAuthorityError") == reason
        assert delivery.get("incidentAuthorityAttempts") == 0
        assert delivery.get("nextAttemptAtEpoch", 0) > int(time.time()) - 5


@pytest.mark.parametrize(
    "case,reason",
    [
        ("not_configured", "incident_authority_not_configured"),
        ("credential_missing", "authority_credential_unreadable"),
        ("credential_rejected", "authority_credential_rejected"),
        ("scope_denied", "authority_scope_denied"),
        ("rate_limited", "incident_authority_rate_limited"),
    ],
)
def test_authority_not_ready_keeps_the_event_in_the_outbox(tmp_path, credential_root, case, reason):
    # With a cap of one attempt, any reason that counted as an attempt would
    # dead-letter the event on the first refusal.
    os.environ["BOT_ERRORS_INCIDENT_AUTHORITY_MAX_ATTEMPTS"] = "1"
    mod = _load(tmp_path / f"not-ready-{case}")
    paths = mod.setup_dirs()
    event = _event(f"evt-not-ready-{case}")
    _open_incident(mod, paths, event)
    queued = _seed_outbox(paths, event)
    env: dict[str, str] = {}
    requests: list = []
    client = mod.IncidentAuthorityClient
    if case == "credential_missing":
        env = {
            "BOT_ERRORS_INCIDENT_AUTHORITY_URL": _LOOPBACK_AUTHORITY,
            "BOT_ERRORS_DISPATCHER_AUTHORITY_CREDENTIAL_FILE": str(credential_root / "not-enrolled"),
        }
    elif case != "not_configured":
        status = {"credential_rejected": 401, "scope_denied": 403, "rate_limited": 429}[case]
        env = {
            "BOT_ERRORS_INCIDENT_AUTHORITY_URL": _LOOPBACK_AUTHORITY,
            "BOT_ERRORS_DISPATCHER_AUTHORITY_CREDENTIAL_FILE": str(_write_credential(credential_root)),
        }
        client = _authority_answering(mod, status, requests)
    calls: list = []

    with patch.dict(os.environ, env), patch.object(mod, "IncidentAuthorityClient", client), patch.object(
        mod, "send_whatsapp", side_effect=lambda *args, **_kwargs: calls.append(args)
    ):
        result = mod.process_one(queued, paths)

    assert result == (False, "incident_authority_not_ready")
    assert calls == [], "a not-ready authority must stop the send"
    _assert_held_in_outbox(paths, reason)


def test_a_malformed_authority_reply_stays_terminal(tmp_path, credential_root):
    mod = _load(tmp_path / "malformed-reply")
    paths = mod.setup_dirs()
    event = _event("evt-malformed-reply")
    _open_incident(mod, paths, event)
    queued = _seed_outbox(paths, event)
    requests: list = []
    env = {
        "BOT_ERRORS_INCIDENT_AUTHORITY_URL": _LOOPBACK_AUTHORITY,
        "BOT_ERRORS_DISPATCHER_AUTHORITY_CREDENTIAL_FILE": str(_write_credential(credential_root)),
    }
    with patch.dict(os.environ, env), patch.object(
        mod, "IncidentAuthorityClient", _authority_answering(mod, 201, requests)
    ), patch.object(mod, "send_whatsapp", side_effect=AssertionError("must not send")):
        result = mod.process_one(queued, paths)

    assert result == (False, "incident_authority_rejected")
    assert len(list(paths["quarantine"].glob("*authority-rejected*"))) == 1


def test_a_rate_refusal_stops_asking_for_the_rest_of_the_cycle(tmp_path, credential_root):
    mod = _load(tmp_path / "rate-limited")
    paths = mod.setup_dirs()
    for index in range(3):
        _seed_outbox(paths, _event(f"evt-rate-{index}"))
    requests: list = []
    env = {
        "BOT_ERRORS_INCIDENT_AUTHORITY_URL": _LOOPBACK_AUTHORITY,
        "BOT_ERRORS_DISPATCHER_AUTHORITY_CREDENTIAL_FILE": str(_write_credential(credential_root)),
    }
    with patch.dict(os.environ, env), patch.object(
        mod, "IncidentAuthorityClient", _authority_answering(mod, 429, requests)
    ):
        mod.begin_incident_authority_cycle()
        counts = mod.authorize_ready_events(paths)
        assert counts["not_ready"] == 3
        assert counts["accepted"] == 0
        assert len(requests) == 1, "one rate refusal must stop the preflight from asking again"

        late = _event("evt-rate-late")
        with pytest.raises(mod.AuthorityNotReady):
            mod.accept_incident_authority(late, mod.producer_claim(late))
        assert len(requests) == 1, "the rest of the cycle must not ask either"

        mod.begin_incident_authority_cycle()
        later = _event("evt-rate-next-cycle")
        with pytest.raises(mod.AuthorityNotReady):
            mod.accept_incident_authority(later, mod.producer_claim(later))
        assert len(requests) == 2, "the next cycle asks again"

    _assert_held_in_outbox(paths, "incident_authority_rate_limited", count=3)


def test_the_not_ready_state_keeps_its_first_time_and_clears_on_acceptance(tmp_path):
    mod = _load(tmp_path / "state-record")
    paths = mod.setup_dirs()
    mod.begin_incident_authority_cycle()
    assert mod.authority_not_ready_record(paths) is None

    first = _event("evt-state-first")
    with pytest.raises(mod.AuthorityNotReady):
        mod.accept_incident_authority(first, mod.producer_claim(first))
    record = mod.authority_not_ready_record(paths)
    assert record["reason"] == "incident_authority_not_configured"
    assert isinstance(record["since"], str)

    earlier = {"reason": "authority_credential_rejected", "since": "2026-11-01T00:00:00.000Z"}
    paths["state"].write_text(json.dumps({"incidentAuthorityNotReady": earlier}))
    mod.begin_incident_authority_cycle()
    # No request this cycle (every event in backoff): the earlier record stands.
    assert mod.authority_not_ready_record(paths) == earlier

    second = _event("evt-state-second")
    with pytest.raises(mod.AuthorityNotReady):
        mod.accept_incident_authority(second, mod.producer_claim(second))
    assert mod.authority_not_ready_record(paths) == {
        "reason": "incident_authority_not_configured",
        "since": earlier["since"],
    }

    accepted = _event("evt-state-accepted")
    with patch.dict(os.environ, {
        "BOT_ERRORS_TEST_MODE": "1",
        "BOT_ERRORS_DRY_AUTHORITY_CAPTURE": str(paths["root"] / "dry-authority.jsonl"),
    }):
        mod.accept_incident_authority(accepted, mod.producer_claim(accepted))
    assert mod.authority_not_ready_record(paths) is None


def test_a_refused_meta_alert_keeps_the_quarantine_record(tmp_path):
    mod = _load(tmp_path / "meta-refused")
    paths = mod.setup_dirs()
    poison = paths["outbox"] / "20260902.instance-x.poison.json"
    poison.write_text("{not json")
    calls: list = []
    with patch.object(mod, "send_whatsapp", side_effect=lambda *a, **_k: calls.append(a)), patch.object(
        mod, "email_fallback", side_effect=lambda *a, **_k: calls.append(a) or True
    ):
        dest = mod.quarantine_poison(poison, paths["quarantine"], "unreadable")

    assert dest.exists()
    assert calls == [], "the meta-alert has no grant, so neither channel may send"
    log_text = (paths["logs"] / "dispatch.jsonl").read_text()
    assert '"quarantine"' in log_text
    assert "authority_refused" in log_text


def _derived_events(mod) -> dict[str, dict]:
    key = mod.incident_key(_event("evt-derived-source"))
    now = int(time.time())
    entry = {"cumulativeCount": 5, "firstTripAt": now - 120, "lastTripAt": now - 5}
    stale = mod.stale_incident_event(
        key,
        {
            "status": "open",
            "openedAt": now - 10 * mod.INCIDENT_STALE_SECONDS,
            "lastSeenAt": now - 2 * mod.INCIDENT_STALE_SECONDS,
            "lastSummary": "quiet source",
        },
        now,
    )
    assert stale is not None
    return {
        "flap_storm": mod.flap_storm_event(key, entry, "warning", now),
        "flap_resolve": mod.flap_resolve_event(key, entry, now),
        "stale_renotify": stale,
        "autoclose_digest": mod.stale_autoclose_summary_event([key], now),
    }


@pytest.mark.parametrize("kind", ["flap_storm", "flap_resolve", "stale_renotify", "autoclose_digest"])
def test_a_derived_notice_without_a_grant_never_reaches_transport(tmp_path, kind):
    mod = _load(tmp_path / f"derived-{kind}")
    mod.setup_dirs()
    event = _derived_events(mod)[kind]
    calls: list = []
    with patch.object(mod, "send_whatsapp", side_effect=lambda *a, **_k: calls.append(a)):
        with pytest.raises(mod.AuthorityUnavailable):
            mod.send_authorized_whatsapp(event, mod.format_event(event))
    assert calls == [], f"the {kind} notice reached the transport without a grant"


def test_a_credential_meta_alert_without_a_grant_sends_nothing(tmp_path):
    mod = _load(tmp_path / "credential-meta")
    mod.setup_dirs()
    calls: list = []
    with patch.object(mod, "send_whatsapp", side_effect=lambda *a, **_k: calls.append(a)), patch.object(
        mod, "email_fallback", side_effect=lambda *a, **_k: calls.append(a) or True
    ):
        taken = mod.credential_meta_alert("credential_expired", "summary", time.monotonic() + 60)
    assert taken is None
    assert calls == []


def _load_health(state_dir: Path):
    return _load_module(_HEALTH, state_dir, "bot_errors_health_not_ready")


def test_the_health_report_names_a_not_ready_authority(tmp_path):
    health = _load_health(tmp_path / "health-line")
    state = {
        "incidentAuthorityNotReady": {"reason": "authority_credential_rejected", "since": health.now_iso()},
        "counts": {"outbox": 4},
    }
    line = health.authority_not_ready_line(state)
    assert line is not None and line.startswith("WARN incident_authority: not_ready")
    assert "reason=authority_credential_rejected" in line
    assert "events_waiting=4" in line
    assert health.authority_not_ready_line({"counts": {"outbox": 4}}) is None


def test_the_deadman_condition_fires_after_the_bound_while_events_wait(tmp_path):
    health = _load_health(tmp_path / "health-deadman")
    since = health.now_iso()
    since_epoch = int(health.parse_iso_epoch(since))
    bound = health.AUTHORITY_NOT_READY_DEADMAN_SECONDS
    state = {
        "incidentAuthorityNotReady": {"reason": "incident_authority_not_configured", "since": since},
        "counts": {"outbox": 2},
    }
    assert health.authority_not_ready_member(state, since_epoch + bound - 1) is None
    assert health.authority_not_ready_member(state, since_epoch + bound) == {
        "reason": "incident_authority_not_configured",
        "not_ready_seconds": bound,
        "events_waiting": 2,
    }
    idle = {**state, "counts": {"outbox": 0}}
    assert health.authority_not_ready_member(idle, since_epoch + bound) is None
