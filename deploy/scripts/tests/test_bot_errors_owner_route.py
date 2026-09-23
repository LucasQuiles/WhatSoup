"""Owner critical route (deploy/scripts/lib/owner_route.py).

The route copies selected critical alerts to the owner's direct chat and e-mail
after the group send. Covered:
- inert without its environment;
- qualification: incident alerts only, critical only, routed sources only,
  first open and escalated reminders but not plain still-open renotifies;
- one owner message per incident key per interval, with the floor recorded
  before the send, and old keys pruned;
- a failed WhatsApp send still sends the e-mail, and neither failure raises;
- the dispatch-log record keeps its delivery outcome through the controller-log
  metadata filter (free-text statuses were silently dropped);
- the dispatcher hook never lets a route failure affect group delivery.

Neutral fixtures only: host label ``host-a``, instance ``sample``.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import time
import types
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from lib import owner_route  # noqa: E402
from lib.controller_log import metadata_only_controller_details  # noqa: E402

_DISPATCHER = _SCRIPTS / "bot-errors-dispatcher.py"

# A placeholder target: the route passes it through without parsing it.
_JID = "owner-chat.invalid"


def _load_dispatcher():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_owner_route", _DISPATCHER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _alert(source: str = "provider_fallback_activated", *, severity: str = "critical",
           evidence: str = "", event_id: str = "0123456789abcdef") -> dict:
    return {
        "id": event_id,
        "source": source,
        "severity": severity,
        "eventType": "alert",
        "machine": "host-a",
        "instance": "sample",
        "evidence": evidence,
    }


class _Recorder:
    def __init__(self, *, send_raises: bool = False, email_ok: bool = True) -> None:
        self.sends: list[dict] = []
        self.emails: list[tuple[str, str]] = []
        self.logs: list[dict] = []
        self.send_raises = send_raises
        self.email_ok = email_ok

    def rpc(self, socket_path, method, params, timeout=15.0):
        self.sends.append({"socket": socket_path, "method": method, "params": params})
        if self.send_raises:
            raise OSError("socket unavailable")
        return {"ok": True}

    def email(self, subject: str, body: str) -> bool:
        self.emails.append((subject, body))
        return self.email_ok

    def log(self, record: dict) -> None:
        self.logs.append(record)


@pytest.fixture()
def route_env(monkeypatch, tmp_path):
    for key in list(__import__("os").environ):
        if key.startswith("BOT_ERRORS_OWNER_ROUTE_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_JID", _JID)
    monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_SOCKET", str(tmp_path / "line.sock"))
    # Send acceptance is validated by the shared helper; accept any result here.
    monkeypatch.setattr(owner_route, "validate_send_acceptance", lambda result, jid: {"audit_receipt": "r1"})
    return tmp_path


def _route(event: dict, rec: _Recorder, state_dir: Path, *, is_alert: bool = True, key: str | None = None) -> None:
    owner_route.route_owner_critical(
        event,
        key=key or f"host-a|sample|{event['source']}",
        is_alert=is_alert,
        group_text="group text",
        state_dir=state_dir,
        json_rpc_call=rec.rpc,
        email_fallback=rec.email,
        log=rec.log,
    )


def test_route_is_inert_without_its_environment(monkeypatch, tmp_path):
    monkeypatch.delenv("BOT_ERRORS_OWNER_ROUTE_JID", raising=False)
    monkeypatch.delenv("BOT_ERRORS_OWNER_ROUTE_SOCKET", raising=False)
    rec = _Recorder()
    _route(_alert(), rec, tmp_path)
    assert rec.sends == [] and rec.emails == [] and rec.logs == []
    assert not (tmp_path / "owner-route-state.json").exists()


@pytest.mark.parametrize(
    ("event", "is_alert", "reason"),
    [
        (_alert(), False, "not_incident_alert"),
        (_alert(severity="warning"), True, "not_critical"),
        (_alert(source="health_body_degraded"), True, "source_not_routed"),
        (_alert(evidence="incident_still_open=true\nescalated=false"), True, "non_escalated_renotify"),
        (_alert(evidence="incident_still_open=true\nescalated=true\nage_seconds=90000"), True, None),
        (_alert(), True, None),
    ],
)
def test_qualification(event, is_alert, reason):
    sources = [s for s in owner_route.DEFAULT_SOURCES.split(",") if s]
    assert owner_route.qualifies(event, sources, is_alert) == reason


def test_default_sources_match_the_owner_decisions():
    sources = set(owner_route.DEFAULT_SOURCES.split(","))
    # Added after the credential outage and the logout review.
    assert {"provider_credential_dead", "instance_logged_out", "whatsapp_device_bond_lost"} <= sources
    # The unverified model probe flaps every 15 minutes; it is not routed.
    unverified = _alert(source="agent365-reliability-fleet_host_sample_primary_model_usable_unverified")
    assert owner_route.qualifies(unverified, sorted(sources), True) == "source_not_routed"
    failed = _alert(source="agent365-reliability-fleet_host_sample_primary_model_usable")
    assert owner_route.qualifies(failed, sorted(sources), True) is None


def test_one_message_per_key_per_interval(route_env):
    rec = _Recorder()
    _route(_alert(), rec, route_env)
    _route(_alert(event_id="fedcba9876543210"), rec, route_env)
    assert len(rec.sends) == 1
    assert len(rec.emails) == 1
    skipped = [r for r in rec.logs if r["type"] == "owner_route_skipped"]
    assert len(skipped) == 1 and skipped[0]["skippedMinInterval"] is True

    # A different incident key is not throttled by the first.
    _route(_alert(), rec, route_env, key="host-a|other|provider_fallback_activated")
    assert len(rec.sends) == 2


def test_floor_is_recorded_before_the_send(route_env):
    rec = _Recorder(send_raises=True, email_ok=False)
    _route(_alert(), rec, route_env)
    state = json.loads((route_env / "owner-route-state.json").read_text())
    assert "host-a|sample|provider_fallback_activated" in state
    # A retry inside the interval stays quiet: a missed copy, never a duplicate.
    _route(_alert(), rec, route_env)
    assert len(rec.sends) == 1


def test_old_keys_are_pruned(route_env):
    stale = int(time.time()) - owner_route.STATE_RETENTION_SECONDS - 60
    (route_env / "owner-route-state.json").write_text(
        json.dumps({"host-a|gone|provider_fallback_activated": {"lastAt": stale, "eventId": "old"}})
    )
    _route(_alert(), _Recorder(), route_env)
    state = json.loads((route_env / "owner-route-state.json").read_text())
    assert "host-a|gone|provider_fallback_activated" not in state
    assert "host-a|sample|provider_fallback_activated" in state


def test_failed_whatsapp_send_still_emails_and_never_raises(route_env):
    rec = _Recorder(send_raises=True)
    _route(_alert(), rec, route_env)
    assert len(rec.emails) == 1
    sent = [r for r in rec.logs if r["type"] == "owner_route_sent"]
    assert sent[0]["whatsappAccepted"] is False
    assert sent[0]["emailAccepted"] is True


def test_email_can_be_disabled(route_env, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_OWNER_ROUTE_EMAIL", "0")
    rec = _Recorder()
    _route(_alert(), rec, route_env)
    assert rec.emails == []
    sent = [r for r in rec.logs if r["type"] == "owner_route_sent"][0]
    assert sent["emailEnabled"] is False and sent["emailAccepted"] is None


@pytest.mark.parametrize("send_raises", [False, True])
def test_delivery_outcome_survives_the_controller_log_filter(route_env, send_raises):
    rec = _Recorder(send_raises=send_raises)
    _route(_alert(), rec, route_env)
    record = [r for r in rec.logs if r["type"] == "owner_route_sent"][0]
    details = metadata_only_controller_details({k: v for k, v in record.items() if k != "type"})
    assert details["whatsappAccepted"] is (not send_raises)
    assert details["emailAccepted"] is True
    assert details["emailEnabled"] is True


def test_owner_line_is_plain_and_names_host_and_instance():
    line = owner_route.owner_line(_alert(source="provider_credential_dead"))
    assert line.startswith("host-a/sample: provider credential dead")
    escalated = owner_route.owner_line(
        _alert(evidence="incident_still_open=true\nescalated=true\nage_seconds=90000")
    )
    assert "still open after 25 h (escalated reminder)" in escalated


def test_dispatcher_hook_swallows_route_failures(tmp_path, monkeypatch):
    dispatcher = _load_dispatcher()
    logged: list[dict] = []
    monkeypatch.setattr(dispatcher, "append_dispatch_log", lambda paths, record: logged.append(record))
    failing = types.ModuleType("lib.owner_route")

    def boom(*_args, **_kwargs):
        raise RuntimeError("route exploded")

    failing.route_owner_critical = boom
    monkeypatch.setitem(sys.modules, "lib.owner_route", failing)
    dispatcher.route_to_owner(_alert(), {"root": tmp_path}, "group text")
    assert logged == [{"type": "owner_route_error", "eventId": "0123456789abcdef"}]
