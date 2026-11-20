"""Observe mode, the default: the authority is asked and its answer recorded,
but every BOT ERRORS notice is delivered exactly as before the authority existed.

The matrix: every authority outcome (granted; refused for an identity conflict,
a rejected credential or a denied scope; not ready for a rate limit, an outage
or an unreadable credential; not configured; a protocol error; an exception the
client did not classify) times every dispatcher send path (a queued alert, the
e-mail leg, the four derived notices, both legs of a meta-alert, a credential
meta-alert, the owner copy) and the Q loop's sends. Observe mode must deliver
what the authority-free baseline delivers, write the same event files, and add
one record line. Enforce mode keeps the earlier behaviour; its tests are in
test_bot_errors_authority_not_ready.py and test_bot_errors_ambiguous_send_outcome.py.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from lib import owner_route  # noqa: E402
from lib.incident_authority import (  # noqa: E402
    AuthorityConflict,
    AuthorityNotReady,
    AuthorityProtocolError,
)

_DISPATCHER = _SCRIPTS / "bot-errors-dispatcher.py"
_Q_LOOP = _SCRIPTS / "bot-errors-q-loop.py"
_HEALTH = _SCRIPTS / "bot-errors-health-check.py"
_MODE = "BOT_ERRORS_INCIDENT_AUTHORITY_MODE"

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
    "BOT_ERRORS_Q_LOOP_AUTHORITY_CREDENTIAL_FILE",
    "BOT_ERRORS_Q_LOOP_STATE_DIR",
    "BOT_ERRORS_OWNER_ROUTE_JID",
    "BOT_ERRORS_OWNER_ROUTE_SOCKET",
    "BOT_ERRORS_INCIDENT_AUTHORITY_MAX_ATTEMPTS",
    _MODE,
]

# Each outcome as the request raises it, and what the record must say.
OUTCOMES: dict[str, tuple[BaseException | None, str, str]] = {
    "granted": (None, "granted", "none"),
    "identity_conflict": (
        AuthorityConflict("incident_authority_identity_conflict"),
        "refused",
        "incident_authority_identity_conflict",
    ),
    "credential_rejected": (
        AuthorityNotReady("authority_credential_rejected"),
        "refused",
        "authority_credential_rejected",
    ),
    "scope_denied": (AuthorityNotReady("authority_scope_denied"), "refused", "authority_scope_denied"),
    "rate_limited": (
        AuthorityNotReady("incident_authority_rate_limited"),
        "not_ready",
        "incident_authority_rate_limited",
    ),
    "unavailable": (
        AuthorityNotReady("incident_authority_unavailable"),
        "not_ready",
        "incident_authority_unavailable",
    ),
    "credential_unreadable": (
        AuthorityNotReady("authority_credential_unreadable"),
        "not_ready",
        "authority_credential_unreadable",
    ),
    "not_configured": (
        AuthorityNotReady("incident_authority_not_configured"),
        "not_configured",
        "incident_authority_not_configured",
    ),
    "protocol_error": (
        AuthorityProtocolError("authority_receipt_malformed"),
        "protocol_error",
        "authority_receipt_malformed",
    ),
    "client_type_error": (TypeError("unhashable type: 'list'"), "protocol_error", "authority_client_error"),
    "client_io_error": (OSError("read failed"), "protocol_error", "authority_client_error"),
}
OUTCOME_NAMES = sorted(OUTCOMES)


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


def _load_dispatcher(state_dir: Path, mode: str | None = None):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    if mode is None:
        os.environ.pop(_MODE, None)
    else:
        os.environ[_MODE] = mode
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location(
        f"bot_errors_dispatcher_observe_{state_dir.name}", _DISPATCHER
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _load_q_loop(state_dir: Path, mode: str | None = None):
    os.environ["BOT_ERRORS_Q_LOOP_STATE_DIR"] = str(state_dir)
    if mode is None:
        os.environ.pop(_MODE, None)
    else:
        os.environ[_MODE] = mode
    state_dir.mkdir(parents=True, exist_ok=True)
    state_dir.chmod(0o700)
    spec = importlib.util.spec_from_file_location(
        f"bot_errors_q_loop_observe_{state_dir.name}", _Q_LOOP
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


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
    """An open incident with no conversation recorded: the send is due."""
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


def _answering(outcome: str, calls: list, clock: dict | None = None):
    """Stand-in for the one request function: records the call, then answers."""
    error = OUTCOMES[outcome][0]

    def request(claim, *, timeout_seconds, rate_limited, deadline_seconds=None):
        calls.append({
            "id": claim.get("id"),
            "timeout": timeout_seconds,
            "rate_limited": rate_limited,
            "deadline": deadline_seconds,
        })
        if clock is not None:
            clock["now"] += clock["step"]
        if error is not None:
            raise error
        return object()

    return request


def _records(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _dispatcher_records(mod, paths) -> list[dict]:
    return _records(mod.incident_authority_record_path(paths))


# Times, epochs and random or content-derived hex (the 16-character delivery
# token, operation ids, digests) differ between two runs without any change in
# delivery.
_VOLATILE = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|[0-9a-f]{16,}|\d{9,}"
)


def _normalized(text: str, root: Path) -> str:
    return _VOLATILE.sub("#", text.replace(str(root), "<root>"))


def _snapshot(paths) -> dict[str, str]:
    """Every state file the dispatcher wrote, apart from its logs and locks."""
    root = paths["root"]
    tree: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if not path.is_file() or relative.parts[0] in {"logs", "locks"}:
            continue
        tree[_normalized(str(relative), root)] = _normalized(path.read_text(errors="replace"), root)
    return tree


# One hour after the matrix event's createdAt.
_MATRIX_SENT_AT = int(datetime.fromisoformat("2026-09-02T02:33:05.995+00:00").timestamp()) + 3600


def _run_queued_alert(state_dir: Path, outcome: str | None) -> dict:
    """One queued alert through process_one, in observe mode.

    outcome None is the baseline: the authority is never asked, which is the
    delivery the dispatcher had before the authority existed.
    """
    mod = _load_dispatcher(state_dir)
    paths = mod.setup_dirs()
    event = _event("evt-observe-matrix")
    _open_incident(mod, paths, event)
    queued = _seed_outbox(paths, event)
    messages: list = []
    calls: list = []
    authority = (
        patch.object(mod, "observe_incident_authority", side_effect=lambda *_a, **_k: None)
        if outcome is None
        else patch.object(mod, "_request_incident_authority", _answering(outcome, calls))
    )
    # The re-delivery age in the message and the stored event is read from the
    # live clock; both runs get the same send time, so the age is compared too.
    stamp = mod.stamp_delivery_freshness
    with authority, patch.object(
        mod, "stamp_delivery_freshness", side_effect=lambda stamped, _current: stamp(stamped, _MATRIX_SENT_AT)
    ), patch.object(
        mod, "send_whatsapp", side_effect=lambda text, *_a, **_k: messages.append(text)
    ):
        mod.begin_incident_authority_cycle()
        result = mod.process_one(queued, paths)
    return {
        "result": result,
        "messages": [_normalized(text, paths["root"]) for text in messages],
        "tree": _snapshot(paths),
        "calls": calls,
        "records": _dispatcher_records(mod, paths),
    }


def test_the_dispatcher_and_the_q_loop_default_to_observe(tmp_path):
    assert _load_dispatcher(tmp_path / "dispatcher").INCIDENT_AUTHORITY_MODE == "observe"
    assert _load_q_loop(tmp_path / "q-loop").INCIDENT_AUTHORITY_MODE == "observe"
    assert _load_dispatcher(tmp_path / "dispatcher-enforce", "enforce").INCIDENT_AUTHORITY_MODE == "enforce"
    assert _load_q_loop(tmp_path / "q-loop-enforce", "enforce").INCIDENT_AUTHORITY_MODE == "enforce"
    assert _load_dispatcher(tmp_path / "dispatcher-typo", "enforced").INCIDENT_AUTHORITY_MODE == "observe"


def test_the_mode_has_one_reader():
    # Both scripts take the mode from the shared reader, once, and never read
    # the setting themselves.
    for script in (_DISPATCHER, _Q_LOOP):
        text = script.read_text(encoding="utf-8")
        assert _MODE not in text, script.name
        assert text.count("incident_authority_mode(os.environ") == 1, script.name


@pytest.mark.parametrize("outcome", OUTCOME_NAMES)
def test_observe_delivers_a_queued_alert_as_without_the_authority(tmp_path, outcome):
    baseline = _run_queued_alert(tmp_path / "baseline", None)
    observed = _run_queued_alert(tmp_path / outcome, outcome)

    assert len(baseline["messages"]) == 1, "the baseline must deliver the alert"
    # The age is compared, not normalized away: one hour, in whole seconds.
    assert "  > delivery_age_seconds: 3600" in baseline["messages"][0].splitlines()
    assert observed["result"] == baseline["result"]
    assert observed["messages"] == baseline["messages"]
    assert observed["tree"] == baseline["tree"], "observe mode must write the same state files"
    assert len(observed["calls"]) == 1, "one request per event per cycle"
    _error, expected_outcome, expected_reason = OUTCOMES[outcome]
    assert observed["records"] == [{
        "time": observed["records"][0]["time"],
        "eventClass": "alert",
        "outcome": expected_outcome,
        "reason": expected_reason,
        "mode": "observe",
    }]
    assert baseline["records"] == []


def test_observe_delivers_on_a_host_with_nothing_configured(tmp_path):
    # The upgrade case, with the real request function and no settings: the
    # alert is sent, the record says not_configured, and nothing is held.
    mod = _load_dispatcher(tmp_path / "nothing-configured")
    paths = mod.setup_dirs()
    event = _event("evt-nothing-configured")
    _open_incident(mod, paths, event)
    queued = _seed_outbox(paths, event)
    messages: list = []
    with patch.object(mod, "send_whatsapp", side_effect=lambda text, *_a, **_k: messages.append(text)):
        mod.begin_incident_authority_cycle()
        mod.authorize_ready_events(paths)
        mod.process_one(queued, paths)
    assert len(messages) == 1
    assert list(paths["outbox"].glob("*.json")) == []
    assert [(r["outcome"], r["reason"]) for r in _dispatcher_records(mod, paths)] == [
        ("not_configured", "incident_authority_not_configured")
    ]
    assert mod.authority_not_ready_record(paths) is None


@pytest.mark.parametrize("outcome", OUTCOME_NAMES)
def test_the_observe_preflight_never_touches_an_event_and_asks_once(tmp_path, outcome):
    mod = _load_dispatcher(tmp_path / f"preflight-{outcome}")
    paths = mod.setup_dirs()
    event = _event(f"evt-preflight-{outcome}")
    _open_incident(mod, paths, event)
    queued = _seed_outbox(paths, event)
    before = queued.read_bytes()
    calls: list = []
    messages: list = []
    with patch.object(mod, "_request_incident_authority", _answering(outcome, calls)), patch.object(
        mod, "send_whatsapp", side_effect=lambda text, *_a, **_k: messages.append(text)
    ):
        mod.begin_incident_authority_cycle()
        counts = mod.authorize_ready_events(paths)
        assert queued.read_bytes() == before, "the observe preflight must not write the event"
        assert counts == {"accepted": 0, "unavailable": 0, "rejected": 0, "not_ready": 0}
        assert len(calls) == 1
        assert mod.authority_not_ready_record(paths) is None, "observe holds nothing for the deadman"
        mod.process_one(queued, paths)
    assert len(calls) == 1, "the send must not ask again for an event asked this cycle"
    assert len(messages) == 1
    assert calls[0]["timeout"] == mod.INCIDENT_AUTHORITY_OBSERVE_TIMEOUT_SECONDS


def test_the_observe_preflight_stops_asking_after_the_request_bound(tmp_path):
    mod = _load_dispatcher(tmp_path / "request-bound")
    paths = mod.setup_dirs()
    bound = mod.INCIDENT_AUTHORITY_OBSERVE_REQUESTS_PER_CYCLE
    seeded = [_seed_outbox(paths, _event(f"evt-bound-{index:02d}")) for index in range(bound + 3)]
    before = [path.read_bytes() for path in seeded]
    calls: list = []
    with patch.object(mod, "_request_incident_authority", _answering("unavailable", calls)):
        mod.begin_incident_authority_cycle()
        mod.authorize_ready_events(paths)
    assert len(calls) == bound
    outcomes = [record["outcome"] for record in _dispatcher_records(mod, paths)]
    assert outcomes.count("not_ready") == bound
    assert outcomes.count("not_asked") == 3
    assert [path.read_bytes() for path in seeded] == before


def test_the_observe_preflight_stops_asking_after_the_time_bound(tmp_path):
    mod = _load_dispatcher(tmp_path / "time-bound")
    paths = mod.setup_dirs()
    for index in range(6):
        _seed_outbox(paths, _event(f"evt-slow-{index:02d}"))
    calls: list = []
    # Each request takes 3 s on this clock; the bound is 8 s of request time,
    # so the third request is the last one started.
    clock = {"now": 0.0, "step": 3.0}
    with patch.object(mod, "_authority_clock", lambda: clock["now"]), patch.object(
        mod, "_request_incident_authority", _answering("unavailable", calls, clock)
    ):
        mod.begin_incident_authority_cycle()
        mod.authorize_ready_events(paths)
    assert mod.INCIDENT_AUTHORITY_OBSERVE_SECONDS_PER_CYCLE == 8.0
    assert len(calls) == 3
    records = _dispatcher_records(mod, paths)
    assert [record["outcome"] for record in records].count("not_asked") == 3
    assert {record["reason"] for record in records if record["outcome"] == "not_asked"} == {
        "incident_authority_cycle_bound"
    }


def test_the_last_observe_request_gets_only_the_time_left_in_the_cycle(tmp_path):
    # Each request is bounded as a whole by its deadline, and the deadline is
    # never longer than what is left of the cycle's request time, so the last
    # request cannot run past the cap.
    mod = _load_dispatcher(tmp_path / "deadline-left")
    paths = mod.setup_dirs()
    for index in range(4):
        _seed_outbox(paths, _event(f"evt-deadline-{index:02d}"))
    calls: list = []
    clock = {"now": 0.0, "step": 3.5}
    with patch.object(mod, "_authority_clock", lambda: clock["now"]), patch.object(
        mod, "_request_incident_authority", _answering("unavailable", calls, clock)
    ):
        mod.begin_incident_authority_cycle()
        mod.authorize_ready_events(paths)
    assert [call["deadline"] for call in calls] == [2.0, 2.0, 1.0]


def test_a_rate_refusal_in_observe_stops_asking_but_holds_nothing(tmp_path):
    mod = _load_dispatcher(tmp_path / "observe-rate")
    paths = mod.setup_dirs()
    for index in range(3):
        _seed_outbox(paths, _event(f"evt-observe-rate-{index}"))
    calls: list = []
    with patch.object(mod, "_request_incident_authority", _answering("rate_limited", calls)):
        mod.begin_incident_authority_cycle()
        mod.authorize_ready_events(paths)
    assert len(calls) == 1
    records = _dispatcher_records(mod, paths)
    assert [(record["outcome"], record["reason"]) for record in records] == [
        ("not_ready", "incident_authority_rate_limited"),
        ("not_asked", "incident_authority_rate_limited"),
        ("not_asked", "incident_authority_rate_limited"),
    ]
    assert mod.authority_not_ready_record(paths) is None


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


@pytest.mark.parametrize("outcome", OUTCOME_NAMES)
@pytest.mark.parametrize("kind", ["flap_storm", "flap_resolve", "stale_renotify", "autoclose_digest"])
def test_observe_sends_every_derived_notice(tmp_path, kind, outcome):
    mod = _load_dispatcher(tmp_path / f"derived-{kind}-{outcome}")
    paths = mod.setup_dirs()
    event = _derived_events(mod)[kind]
    text = mod.format_event(event)
    messages: list = []
    calls: list = []
    with patch.object(mod, "_request_incident_authority", _answering(outcome, calls)), patch.object(
        mod, "send_whatsapp", side_effect=lambda sent, *_a, **_k: messages.append(sent)
    ):
        mod.begin_incident_authority_cycle()
        mod.send_authorized_whatsapp(event, text)
    assert messages == [text], f"the {kind} notice must be sent whatever the authority answers"
    assert len(calls) == 1
    assert _dispatcher_records(mod, paths)[-1]["outcome"] == OUTCOMES[outcome][1]


@pytest.mark.parametrize("outcome", OUTCOME_NAMES)
def test_observe_sends_the_email_leg(tmp_path, outcome):
    mod = _load_dispatcher(tmp_path / f"email-{outcome}")
    mod.setup_dirs()
    event = _event(f"evt-email-{outcome}")
    emails: list = []
    with patch.object(mod, "_request_incident_authority", _answering(outcome, [])), patch.object(
        mod, "email_fallback", side_effect=lambda subject, body, **_k: emails.append((subject, body)) or True
    ):
        mod.begin_incident_authority_cycle()
        assert mod.send_authorized_email(event, "subject", "body") is True
    assert emails == [("subject", "body")]


@pytest.mark.parametrize("outcome", OUTCOME_NAMES)
def test_observe_sends_both_meta_alert_legs(tmp_path, outcome):
    mod = _load_dispatcher(tmp_path / f"meta-{outcome}")
    paths = mod.setup_dirs()
    poison = paths["outbox"] / "20260902.instance-x.poison.json"
    poison.write_text("{not json")
    attempts: list = []
    emails: list = []
    calls: list = []

    def _down(text, *_a, **_k):
        attempts.append(text)
        raise RuntimeError("socket down")

    with patch.object(mod, "_request_incident_authority", _answering(outcome, calls)), patch.object(
        mod, "send_whatsapp", side_effect=_down
    ), patch.object(
        mod, "email_fallback", side_effect=lambda subject, body, **_k: emails.append(subject) or True
    ):
        mod.begin_incident_authority_cycle()
        dest = mod.quarantine_poison(poison, paths["quarantine"], "unreadable")
    assert dest.exists()
    assert len(attempts) == 1 and len(emails) == 1, "both legs run as without the authority"
    assert len(calls) == 1, "both legs of one meta-alert are charged one request"
    records = [
        json.loads(line)
        for line in (paths["logs"] / "dispatch.jsonl").read_text().splitlines()
        if line.strip()
    ]
    quarantined = [record for record in records if record.get("recordKind") == "quarantine"]
    assert (quarantined[0].get("details") or {}).get("emailFallback") == "email_delivered"


@pytest.mark.parametrize("outcome", OUTCOME_NAMES)
def test_observe_sends_a_credential_meta_alert(tmp_path, outcome):
    mod = _load_dispatcher(tmp_path / f"credential-meta-{outcome}")
    mod.setup_dirs()
    messages: list = []
    with patch.object(mod, "_request_incident_authority", _answering(outcome, [])), patch.object(
        mod, "send_whatsapp", side_effect=lambda text, *_a, **_k: messages.append(text)
    ):
        mod.begin_incident_authority_cycle()
        taken = mod.credential_meta_alert("credential_expired", "summary", time.monotonic() + 60)
    assert taken is not None
    assert len(messages) == 1


@pytest.mark.parametrize("value", ["", "abc"])
def test_an_unreadable_max_attempts_setting_never_stops_observe_mode(tmp_path, capsys, value):
    os.environ["BOT_ERRORS_INCIDENT_AUTHORITY_MAX_ATTEMPTS"] = value
    mod = _load_dispatcher(tmp_path / f"attempts-{value or 'empty'}")
    assert mod.INCIDENT_AUTHORITY_MODE == "observe"
    assert mod.INCIDENT_AUTHORITY_MAX_ATTEMPTS == 12
    assert capsys.readouterr().err.count('"incident_authority_max_attempts_invalid"') == 1


def test_an_unreadable_max_attempts_setting_still_stops_enforce_mode(tmp_path):
    # Enforce mode is unchanged: the process stops before it can send.
    os.environ["BOT_ERRORS_INCIDENT_AUTHORITY_MAX_ATTEMPTS"] = "abc"
    with pytest.raises(ValueError):
        _load_dispatcher(tmp_path / "attempts-enforce", mode="enforce")


def _slow_authority(seconds: float):
    def request(claim, *, timeout_seconds, rate_limited, deadline_seconds=None):
        time.sleep(seconds)
        return object()

    return request


def _credential_page_legs(mod, paths, tmp_path, monkeypatch, authority) -> list:
    monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_JID", "owner-chat.invalid")
    monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_SOCKET", str(tmp_path / "line.sock"))
    monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_EMAIL", "1")
    monkeypatch.setattr(owner_route, "validate_send_acceptance", lambda result, jid: {"audit_receipt": "r1"})
    mod._credential_pages[:] = [
        {
            "scope": f"scope-{index}",
            "before": {"lastAttemptAt": index + 1},
            "attemptAt": 1_763_600_000 + index,
            "line": f"page {index}",
            "body": f"body {index}",
            "count": 1,
            "failedAttempts": 0,
            "hours": 4,
        }
        for index in range(3)
    ]
    legs: list = []
    with authority, patch.object(mod.credential_repage, "CLASS_BUDGET_SECONDS", 2.5), patch.object(
        mod,
        "json_rpc_call",
        side_effect=lambda _socket, _method, params, **_k: legs.append(
            ("whatsapp", params["arguments"]["text"])
        ) or {"ok": True},
    ), patch.object(
        mod, "email_fallback", side_effect=lambda subject, _body, **_k: legs.append(("email", subject)) or True
    ):
        mod.begin_incident_authority_cycle()
        mod.send_credential_pages(paths)
    return legs


def test_observe_sends_the_same_credential_pages_with_a_slow_authority(tmp_path, monkeypatch):
    # The class budget is 2.5 s here and each observation takes 0.8 s. Time
    # spent asking must not cut a page or skip its e-mail leg: same pages, same
    # legs, same order as the authority-free baseline. Counted against the
    # budget, the observations would leave 0.9 s for the third page, which a
    # page needs 1 s to start; excluded, each page keeps about 1.5 s of slack.
    baseline_mod = _load_dispatcher(tmp_path / "pages-baseline")
    baseline = _credential_page_legs(
        baseline_mod,
        baseline_mod.setup_dirs(),
        tmp_path,
        monkeypatch,
        patch.object(baseline_mod, "observe_incident_authority", side_effect=lambda *_a, **_k: None),
    )
    slow_mod = _load_dispatcher(tmp_path / "pages-slow")
    slow_paths = slow_mod.setup_dirs()
    slow = _credential_page_legs(
        slow_mod,
        slow_paths,
        tmp_path,
        monkeypatch,
        patch.object(slow_mod, "_request_incident_authority", _slow_authority(0.8)),
    )
    assert baseline == [
        (leg, f"page {index}") for index in range(3) for leg in ("whatsapp", "email")
    ]
    assert slow == baseline
    assert [r["outcome"] for r in _dispatcher_records(slow_mod, slow_paths)] == ["granted"] * 3


def test_observe_time_does_not_shorten_a_credential_meta_alert(tmp_path):
    # The group leg fails; the e-mail leg needs a second of the deadline left.
    # A 1.7 s observation of a 2.5 s deadline must not use up that second:
    # counted, it would leave 0.8 s; excluded, about 1.5 s of slack remain.
    mod = _load_dispatcher(tmp_path / "meta-slow")
    mod.setup_dirs()
    legs: list = []

    def _down(text, *_a, **_k):
        legs.append("whatsapp")
        raise RuntimeError("socket down")

    with patch.object(mod, "_request_incident_authority", _slow_authority(1.7)), patch.object(
        mod, "send_whatsapp", side_effect=_down
    ), patch.object(mod, "email_fallback", side_effect=lambda *_a, **_k: legs.append("email") or True):
        mod.begin_incident_authority_cycle()
        taken = mod.credential_meta_alert(
            mod.credential_repage.META_PASS_ERROR, "summary", time.monotonic() + 2.5
        )
    assert legs == ["whatsapp", "email"]
    assert taken is not None


def test_observe_time_does_not_cut_the_next_credential_meta_alert(tmp_path):
    # Two owed alerts in a 2.5 s budget; each observation takes 1.7 s. The
    # second alert is sent as it would be without the authority: counted, the
    # first observation would leave 0.8 s, under the 1 s an alert needs to start.
    mod = _load_dispatcher(tmp_path / "meta-loop")
    paths = mod.setup_dirs()
    sources = [mod.credential_repage.META_PASS_ERROR, mod.credential_repage.META_ROSTER_UNREADABLE]
    mod._credential_meta_alerts[:] = [
        {"source": name, "line": f"line {name}", "day": "2026-11-20"} for name in sources
    ]
    mod._credential_meta_taken.clear()
    with patch.object(mod, "_request_incident_authority", _slow_authority(1.7)), patch.object(
        mod, "send_whatsapp", side_effect=lambda *_a, **_k: {"ok": "1"}
    ), patch.object(mod, "CREDENTIAL_META_BUDGET_SECONDS", 2.5):
        mod.begin_incident_authority_cycle()
        mod.send_credential_meta_alerts(paths)
    assert [item["source"] for item in mod._credential_meta_taken] == sources


@pytest.mark.parametrize("outcome", OUTCOME_NAMES)
def test_observe_queues_and_sends_the_owner_copy(tmp_path, outcome, monkeypatch):
    mod = _load_dispatcher(tmp_path / f"owner-{outcome}")
    paths = mod.setup_dirs()
    monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_JID", "owner-chat.invalid")
    monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_SOCKET", str(tmp_path / "line.sock"))
    monkeypatch.setattr(owner_route, "validate_send_acceptance", lambda result, jid: {"audit_receipt": "r1"})
    event = {
        "schemaVersion": 1,
        "id": f"owner-{outcome}",
        "summary": "sample alert",
        "source": "provider_fallback_activated",
        "severity": "critical",
        "eventType": "alert",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "machine": "host-a",
        "instance": "sample",
        "evidence": "",
    }
    sends: list = []
    mod._owner_route_queue.clear()
    with patch.object(mod, "_request_incident_authority", _answering(outcome, [])), patch.object(
        mod, "json_rpc_call", side_effect=lambda *a, **_k: sends.append(a) or {"ok": True}
    ):
        mod.begin_incident_authority_cycle()
        mod.route_to_owner(event, paths, "group text")
        assert len(mod._owner_route_queue) == 1, "observe mode must not skip the owner copy"
        mod.drain_owner_route_queue(paths)
    assert len(sends) == 1


def test_observe_records_hold_closed_codes_only(tmp_path):
    mod = _load_dispatcher(tmp_path / "record-shape")
    paths = mod.setup_dirs()
    event = _event("evt-record-shape")
    event["summary"] = "private operator text host-a"
    with patch.object(mod, "_request_incident_authority", _answering("protocol_error", [])):
        mod.begin_incident_authority_cycle()
        mod.observe_incident_authority(event)
    records = _dispatcher_records(mod, paths)
    assert len(records) == 1
    assert set(records[0]) == {"time", "eventClass", "outcome", "reason", "mode"}
    raw = mod.incident_authority_record_path(paths).read_text()
    assert "private operator text" not in raw
    assert str(paths["root"]) not in raw


@pytest.mark.parametrize("outcome", OUTCOME_NAMES)
def test_observe_sends_every_q_loop_notice(tmp_path, outcome):
    q_loop = _load_q_loop(tmp_path / f"q-loop-{outcome}")
    error = OUTCOMES[outcome][0]
    requests: list = []
    sends: list = []

    def _request(claim, *, timeout_seconds, deadline_seconds=None):
        requests.append((timeout_seconds, deadline_seconds))
        if error is not None:
            raise error
        return object()

    state = q_loop.default_state()
    with patch.object(q_loop, "_request_notification_authority", _request), patch.object(
        q_loop, "validate_bot_errors_target", lambda: None
    ), patch.object(q_loop, "rpc_call", side_effect=lambda *a, **_k: sends.append(a) or {"ok": True}):
        sent = q_loop.send_message(
            state,
            "socket.invalid",
            "checkpoint text",
            authority_event_id=f"q-loop-checkpoint-{outcome}",
            authority_observed_epoch=1_763_600_000,
        )
    assert sent is True and len(sends) == 1
    # One request, bounded as a whole by the observe timeout.
    assert requests == [(q_loop.OBSERVE_TIMEOUT_SECONDS, q_loop.OBSERVE_TIMEOUT_SECONDS)]
    assert state["notification_authority"] == {}, "observe mode stores nothing in the loop state"
    records = _records(q_loop.INCIDENT_AUTHORITY_RECORD)
    assert [(r["eventClass"], r["outcome"], r["reason"], r["mode"]) for r in records] == [
        ("q_notice", OUTCOMES[outcome][1], OUTCOMES[outcome][2], "observe")
    ]


def _q_message(body: str, ts: int, pk: int = 10) -> dict:
    return {"pk": pk, "body": body, "timestamp": ts, "sender_name": "q", "sender_jid": "", "is_from_me": 0}


@pytest.mark.parametrize("mode", ["observe", "enforce"])
def test_an_unmatched_q_reply_keeps_the_nudge_armed(tmp_path, mode):
    # Main clears the wait only for a reply it recognises; an ordinary reply
    # ("Investigating") leaves it armed and the nudge goes out when due.
    q_loop = _load_q_loop(tmp_path / f"q-nudge-unmatched-{mode}", mode)
    current = q_loop.now()
    waiting_since = current - q_loop.NUDGE_AFTER_SECONDS - 60
    state = q_loop.default_state()
    state["awaiting_q_since"] = waiting_since
    q_loop.classify_activity(state, [_q_message("Investigating the failing gate now", current - 30)])
    assert state["awaiting_q_since"] == waiting_since
    assert state["last_q_disposition"] == "received"
    nudges: list = []
    with patch.object(
        q_loop, "send_message", side_effect=lambda *_a, **k: nudges.append(k["authority_event_id"]) or True
    ):
        assert q_loop.maybe_send_nudge(state, "socket.invalid") is True
    assert nudges == [f"q-loop-nudge-{waiting_since}"]


@pytest.mark.parametrize(
    "body",
    [
        "APPROVED SCOPE for the gate",
        "APPROVED",
        "BLOCKED: missing evidence",
        "Standing by",
        "You've hit your session limit",
    ],
)
def test_a_recognised_q_reply_still_clears_the_nudge(tmp_path, body):
    q_loop = _load_q_loop(tmp_path / "q-nudge-matched")
    current = q_loop.now()
    state = q_loop.default_state()
    state["awaiting_q_since"] = current - q_loop.NUDGE_AFTER_SECONDS - 60
    q_loop.classify_activity(state, [_q_message(body, current - 30)])
    assert state["awaiting_q_since"] == 0
    with patch.object(q_loop, "send_message", side_effect=AssertionError("no nudge after a recognised reply")):
        assert q_loop.maybe_send_nudge(state, "socket.invalid") is False


def test_enforce_still_stops_a_q_loop_notice_without_a_grant(tmp_path):
    q_loop = _load_q_loop(tmp_path / "q-loop-enforce", "enforce")
    sends: list = []
    with patch.object(q_loop, "validate_bot_errors_target", lambda: None), patch.object(
        q_loop, "rpc_call", side_effect=lambda *a, **_k: sends.append(a) or {"ok": True}
    ):
        sent = q_loop.send_message(
            q_loop.default_state(),
            "socket.invalid",
            "checkpoint text",
            authority_event_id="q-loop-checkpoint-enforce",
            authority_observed_epoch=1_763_600_000,
        )
    assert sent is False and sends == []
    records = _records(q_loop.INCIDENT_AUTHORITY_RECORD)
    assert [(r["outcome"], r["mode"]) for r in records] == [("not_configured", "enforce")]


def test_the_health_report_summarises_the_last_day_of_the_record(tmp_path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path / "health-state")
    spec = importlib.util.spec_from_file_location("bot_errors_health_observe", _HEALTH)
    health = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(health)  # type: ignore[union-attr]
    now = 1_763_600_000
    record = tmp_path / "incident-authority.jsonl"

    def line(age: int, outcome: object, mode: str = "observe", reason: object = "x") -> str:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - age))
        return json.dumps(
            {"time": stamp, "eventClass": "alert", "outcome": outcome, "reason": reason, "mode": mode}
        )

    record.write_text("\n".join([
        # A row whose outcome or reason is not a string is skipped and counted.
        line(30, ["granted"]),
        line(40, 7),
        line(50, "granted", reason=["x"]),
        line(60, "granted"),
        line(120, "granted"),
        line(180, "refused"),
        line(240, "not_ready"),
        line(300, "not_configured"),
        line(360, "protocol_error"),
        line(420, "not_asked"),
        line(90_000, "refused"),  # older than a day: not counted
        "not json",
    ]) + "\n")
    summary = health.incident_authority_record_line("dispatcher", record, now)
    assert summary == (
        "incident_authority_record: producer=dispatcher last_24h total=7 granted=2 refused=1 "
        "not_ready=1 protocol_error=1 not_configured=1 not_asked=1 "
        "would_hold_or_refuse_in_enforce=4 mode=observe skipped=4"
    )
    assert not summary.startswith(("WARN", "FAIL"))
    assert health.incident_authority_record_line("dispatcher", tmp_path / "absent.jsonl", now) is None
