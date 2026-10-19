"""Side notices require real acceptance and persist uncertain outcomes separately."""
from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest

_TESTS = Path(__file__).resolve().parent
if str(_TESTS) not in sys.path:
    sys.path.insert(0, str(_TESTS))
from support import dispatcher_fixtures

NOW = 1_790_000_000
TARGET = "111111100000000@g.us"
KEY = "host-a|sample|health_body_degraded"


@pytest.fixture
def notice(tmp_path, monkeypatch):
    for key in ("BOT_ERRORS_DRY_SEND_CAPTURE", "BOT_ERRORS_DRY_SEND_FAIL", "BOT_ERRORS_OUTBOX_DIR"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("BOT_ERRORS_JID", TARGET)
    monkeypatch.setenv("BOT_ERRORS_EXPECTED_JID", TARGET)
    monkeypatch.setenv("BOT_ERRORS_SOCKET_PATH", str(tmp_path / "test.sock"))
    monkeypatch.setenv("BOT_ERRORS_FLAP_TRIP_THRESHOLD", "1")
    monkeypatch.setenv("BOT_ERRORS_FLAP_PROMOTE_SECONDS", "100")
    monkeypatch.setenv("BOT_ERRORS_FLAP_CRITICAL_COUNT", "1000")
    monkeypatch.setenv("BOT_ERRORS_SUPPRESS_STALE_INFO_RENOTIFY", "false")
    spec = importlib.util.spec_from_file_location("side_notice_dispatcher", _TESTS.parent / "bot-errors-dispatcher.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod.time, "time", lambda: NOW)
    paths = mod.setup_dirs()
    return mod, paths


def event(event_id="notice"):
    return {
        "schemaVersion": 1, "eventType": "alert", "severity": "critical",
        "machine": "host-a", "instance": "sample", "source": "health_body_degraded",
        "summary": "health is degraded", "evidence": "degraded", "id": event_id,
        "createdAt": "2026-09-21T13:33:20Z",
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
    }


def response(payload):
    return {"isError": False, "content": [{"type": "text", "text": json.dumps(payload)}]}


def transport(monkeypatch, mod, payload):
    calls = []
    def rpc(*args, **kwargs):
        calls.append((args, kwargs))
        return response(payload)
    monkeypatch.setattr(mod, "json_rpc_call", rpc)
    return calls


def stage(paths, event_id):
    dispatcher_fixtures.write_outbox_event(paths, event_id + ".json", event(event_id))


def stale_record(mod, paths):
    record = {"status": "open", "openedAt": NOW - 86400, "lastSeenAt": NOW - 86400,
              "lastNotifiedAt": NOW - 86400, "lastSummary": "health is degraded"}
    mod.save_incident_state(paths, {"version": 1, "openIncidents": {KEY: record}, "lastSentAt": {}})
    return record


def test_storm_rejection_does_not_open_or_suppress(notice, monkeypatch):
    mod, paths = notice
    calls = transport(monkeypatch, mod, {"sent": False})
    stage(paths, "rejected")
    assert mod.flap_scan_outbox(paths) == 0
    entry = mod.load_incident_state(paths)["flapState"][KEY]
    assert len(calls) == 1
    assert not entry.get("stormAt")
    assert not entry.get("lastStormEmitAt")
    assert not (mod.should_suppress_send(event("member"), mod.load_incident_state(paths)) or "").startswith("flap_storm_member")


def test_storm_unknown_is_persisted_without_success_or_immediate_repeat(notice, monkeypatch):
    mod, paths = notice
    calls = transport(monkeypatch, mod, {})
    stage(paths, "uncertain")
    assert mod.flap_scan_outbox(paths) == 0
    state = mod.load_incident_state(paths)
    entry = state["flapState"][KEY]
    assert not entry.get("stormAt")
    assert not entry.get("lastStormEmitAt")
    assert entry["unconfirmedStorm"]["lastStormEmitAt"] == NOW
    assert not (mod.should_suppress_send(event("member"), state) or "").startswith("flap_storm_member")
    stage(paths, "next-occurrence")
    assert mod.flap_scan_outbox(paths) == 0
    assert len(calls) == 1
    kinds = [r["recordKind"] for r in dispatcher_fixtures.dispatch_log_records(paths)]
    assert "flap_storm_unconfirmed" in kinds
    assert "flap_storm" not in kinds


def test_storm_confirmed_acceptance_opens_and_suppresses(notice, monkeypatch):
    mod, paths = notice
    transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    stage(paths, "accepted")
    assert mod.flap_scan_outbox(paths) == 1
    entry = mod.load_incident_state(paths)["flapState"][KEY]
    assert entry["stormAt"] == NOW
    assert entry["lastStormEmitAt"] == NOW
    assert "unconfirmedStorm" not in entry


def test_stale_rejection_does_not_advance_notified_state(notice, monkeypatch):
    mod, paths = notice
    prior = stale_record(mod, paths)
    calls = transport(monkeypatch, mod, {"sent": False})
    sent, failed, error = mod.sweep_stale_incidents(paths)
    assert (sent, failed) == (0, 1)
    assert error
    record = mod.load_incident_state(paths)["openIncidents"][KEY]
    assert len(calls) == 1
    assert record["lastNotifiedAt"] == prior["lastNotifiedAt"]
    assert not record.get("staleRenotifyCount")


def test_stale_unknown_holds_the_cadence_without_claiming_notification(notice, monkeypatch):
    mod, paths = notice
    prior = stale_record(mod, paths)
    calls = transport(monkeypatch, mod, {})
    assert mod.sweep_stale_incidents(paths)[0] == 0
    record = mod.load_incident_state(paths)["openIncidents"][KEY]
    assert record["lastNotifiedAt"] == prior["lastNotifiedAt"]
    assert not record.get("staleRenotifyCount")
    assert record["lastStaleRenotifyUnconfirmedAt"] == NOW
    assert mod.sweep_stale_incidents(paths) == (0, 0, None)
    assert len(calls) == 1


def test_stale_confirmed_acceptance_advances_notification(notice, monkeypatch):
    mod, paths = notice
    stale_record(mod, paths)
    transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    assert mod.sweep_stale_incidents(paths) == (1, 0, None)
    record = mod.load_incident_state(paths)["openIncidents"][KEY]
    assert record["lastNotifiedAt"] == NOW
    assert record["staleRenotifyCount"] == 1


def test_meta_rejection_uses_fallback_instead_of_claiming_sent(notice, monkeypatch):
    mod, _paths = notice
    transport(monkeypatch, mod, {"sent": False})
    emails = []
    monkeypatch.setattr(mod, "email_fallback", lambda *a, **k: emails.append(a) or True)
    direct, email, error = mod.send_meta_alert(event(), "test alert")
    assert (direct, email) == ("failed", "email_delivered")
    assert error and len(emails) == 1


def test_meta_unknown_is_distinct_from_sent_and_from_rejection(notice, monkeypatch):
    mod, _paths = notice
    transport(monkeypatch, mod, {})
    monkeypatch.setattr(mod, "email_fallback", lambda *a, **k: False)
    direct, email, error = mod.send_meta_alert(event(), "test alert")
    assert (direct, email) == ("sent_unconfirmed", "failed")
    assert error


def test_credential_rejection_without_fallback_remains_owed(notice, monkeypatch):
    mod, _paths = notice
    transport(monkeypatch, mod, {"sent": False})
    monkeypatch.setattr(mod, "email_fallback", lambda *a, **k: False)
    assert mod.credential_meta_alert(mod.credential_repage.META_PASS_ERROR, "test alert", time.monotonic() + 20) is None


def test_credential_unknown_is_taken_once_with_explicit_ambiguity(notice, monkeypatch):
    mod, _paths = notice
    transport(monkeypatch, mod, {})
    monkeypatch.setattr(mod, "email_fallback", lambda *a, **k: False)
    records = []
    day = mod.credential_meta_alert(mod.credential_repage.META_PASS_ERROR, "test alert", time.monotonic() + 20, log=records.append)
    assert day == mod._utc_day()
    assert len(records) == 1 and records[0]["ambiguous"] is True


def test_unknown_storm_allows_one_confirmed_escalation_after_its_cadence(notice, monkeypatch):
    mod, paths = notice
    unknown_calls = transport(monkeypatch, mod, {})
    stage(paths, "unknown-warning")
    assert mod.flap_scan_outbox(paths) == 0
    monkeypatch.setattr(mod.time, "time", lambda: NOW + mod.FLAP_PROMOTE_SECONDS)
    accepted_calls = transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    stage(paths, "escalation")
    assert mod.flap_scan_outbox(paths) == 1
    entry = mod.load_incident_state(paths)["flapState"][KEY]
    assert entry["stormSeverity"] == "critical"
    assert "unconfirmedStorm" not in entry
    stage(paths, "member")
    assert mod.flap_scan_outbox(paths) == 0
    assert len(unknown_calls) == len(accepted_calls) == 1


def test_uncertain_escalation_keeps_confirmed_warning_and_does_not_repeat(notice, monkeypatch):
    mod, paths = notice
    transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    stage(paths, "warning")
    assert mod.flap_scan_outbox(paths) == 1
    monkeypatch.setattr(mod.time, "time", lambda: NOW + mod.FLAP_PROMOTE_SECONDS)
    calls = transport(monkeypatch, mod, {})
    stage(paths, "uncertain-escalation")
    assert mod.flap_scan_outbox(paths) == 0
    entry = mod.load_incident_state(paths)["flapState"][KEY]
    assert entry["stormSeverity"] == "warning"
    assert entry["lastStormEmitAt"] == NOW
    assert entry["unconfirmedStorm"]["stormSeverity"] == "critical"
    stage(paths, "next-member")
    assert mod.flap_scan_outbox(paths) == 0
    assert len(calls) == 1


def test_a_storm_after_a_quiet_period_does_not_inherit_old_uncertainty(notice, monkeypatch):
    mod, paths = notice
    transport(monkeypatch, mod, {})
    stage(paths, "old-storm")
    assert mod.flap_scan_outbox(paths) == 0
    later = NOW + mod.FLAP_STABLE_SECONDS + mod.FLAP_WINDOW_SECONDS + 1
    monkeypatch.setattr(mod.time, "time", lambda: later)
    transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    stage(paths, "new-storm")
    assert mod.flap_scan_outbox(paths) == 1
    entry = mod.load_incident_state(paths)["flapState"][KEY]
    assert entry["stormSeverity"] == "warning"
    assert entry["stormAt"] == later
    assert "unconfirmedStorm" not in entry


def test_unknown_storm_state_survives_a_failed_dispatch_log_append(notice, monkeypatch):
    mod, paths = notice
    calls = transport(monkeypatch, mod, {})
    append = mod.append_dispatch_log
    def fail_unknown(paths_arg, payload):
        if payload["type"] == "flap_storm_unconfirmed":
            raise OSError("test log failure")
        return append(paths_arg, payload)
    monkeypatch.setattr(mod, "append_dispatch_log", fail_unknown)
    stage(paths, "unknown")
    assert mod.flap_scan_outbox(paths) == 0
    assert mod.load_incident_state(paths)["flapState"][KEY]["unconfirmedStorm"]
    stage(paths, "later-occurrence")
    assert mod.flap_scan_outbox(paths) == 0
    assert len(calls) == 1


def test_stale_unknown_allows_a_confirmed_new_scheduled_notice(notice, monkeypatch):
    mod, paths = notice
    stale_record(mod, paths)
    transport(monkeypatch, mod, {})
    assert mod.sweep_stale_incidents(paths)[0] == 0
    later = NOW + mod.INCIDENT_STALE_RENOTIFY_SECONDS
    monkeypatch.setattr(mod.time, "time", lambda: later)
    calls = transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    assert mod.sweep_stale_incidents(paths) == (1, 0, None)
    record = mod.load_incident_state(paths)["openIncidents"][KEY]
    assert record["lastNotifiedAt"] == later
    assert record["staleRenotifyCount"] == 1
    assert len(calls) == 1


def test_meta_and_credential_confirmed_acceptance_avoid_fallback(notice, monkeypatch):
    mod, _paths = notice
    calls = transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    emails = []
    monkeypatch.setattr(mod, "email_fallback", lambda *a, **k: emails.append(a) or False)
    assert mod.send_meta_alert(event(), "test alert") == ("sent", "not_attempted", None)
    assert mod.credential_meta_alert(mod.credential_repage.META_PASS_ERROR, "test alert", time.monotonic() + 20) == mod._utc_day()
    assert len(calls) == 2 and emails == []


def test_storm_persists_uncertainty_before_a_process_exit_during_send(notice, monkeypatch):
    mod, paths = notice
    def crash(*args, **kwargs):
        raise SystemExit("test crash after request")
    monkeypatch.setattr(mod, "json_rpc_call", crash)
    stage(paths, "crashed-send")
    with pytest.raises(SystemExit):
        mod.flap_scan_outbox(paths)
    entry = mod.load_incident_state(paths)["flapState"][KEY]
    assert entry["unconfirmedStorm"]["lastStormEmitAt"] == NOW
    assert not entry.get("stormAt")
    calls = transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    stage(paths, "new-occurrence")
    assert mod.flap_scan_outbox(paths) == 0
    assert calls == []


def test_stale_persists_uncertainty_before_a_process_exit_during_send(notice, monkeypatch):
    mod, paths = notice
    prior = stale_record(mod, paths)
    def crash(*args, **kwargs):
        raise SystemExit("test crash after request")
    monkeypatch.setattr(mod, "json_rpc_call", crash)
    with pytest.raises(SystemExit):
        mod.sweep_stale_incidents(paths)
    record = mod.load_incident_state(paths)["openIncidents"][KEY]
    assert record["lastStaleRenotifyUnconfirmedAt"] == NOW
    assert record["lastNotifiedAt"] == prior["lastNotifiedAt"]
    calls = transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    assert mod.sweep_stale_incidents(paths) == (0, 0, None)
    assert calls == []


def test_rejected_storm_releases_uncertain_intent_for_a_later_attempt(notice, monkeypatch):
    mod, paths = notice
    transport(monkeypatch, mod, {"sent": False})
    stage(paths, "rejected-storm")
    assert mod.flap_scan_outbox(paths) == 0
    assert "unconfirmedStorm" not in mod.load_incident_state(paths)["flapState"][KEY]
    calls = transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    stage(paths, "new-storm")
    assert mod.flap_scan_outbox(paths) == 1
    assert len(calls) == 1


def test_rejected_stale_releases_uncertain_intent_for_the_failure_retry(notice, monkeypatch):
    mod, paths = notice
    stale_record(mod, paths)
    transport(monkeypatch, mod, {"sent": False})
    assert mod.sweep_stale_incidents(paths)[:2] == (0, 1)
    assert "lastStaleRenotifyUnconfirmedAt" not in mod.load_incident_state(paths)["openIncidents"][KEY]
    monkeypatch.setattr(mod.time, "time", lambda: NOW + mod.INCIDENT_STALE_FAILURE_RETRY_SECONDS)
    calls = transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    assert mod.sweep_stale_incidents(paths) == (1, 0, None)
    assert len(calls) == 1


def test_rejected_escalation_restores_the_previous_unknown_storm(notice, monkeypatch):
    mod, paths = notice
    transport(monkeypatch, mod, {})
    stage(paths, "unknown-first")
    assert mod.flap_scan_outbox(paths) == 0
    prior = mod.load_incident_state(paths)["flapState"][KEY]["unconfirmedStorm"]
    monkeypatch.setattr(mod.time, "time", lambda: NOW + mod.FLAP_PROMOTE_SECONDS)
    transport(monkeypatch, mod, {"sent": False})
    stage(paths, "rejected-escalation")
    assert mod.flap_scan_outbox(paths) == 0
    entry = mod.load_incident_state(paths)["flapState"][KEY]
    assert entry["unconfirmedStorm"] == prior
    assert not entry.get("stormAt")


def test_rejected_stale_attempt_restores_the_previous_unknown_notice(notice, monkeypatch):
    mod, paths = notice
    stale_record(mod, paths)
    transport(monkeypatch, mod, {})
    assert mod.sweep_stale_incidents(paths)[0] == 0
    record = mod.load_incident_state(paths)["openIncidents"][KEY]
    prior = {key: value for key, value in record.items() if key.startswith("lastStaleRenotifyUnconfirmed")}
    monkeypatch.setattr(mod.time, "time", lambda: NOW + mod.INCIDENT_STALE_RENOTIFY_SECONDS)
    transport(monkeypatch, mod, {"sent": False})
    assert mod.sweep_stale_incidents(paths)[:2] == (0, 1)
    record = mod.load_incident_state(paths)["openIncidents"][KEY]
    assert {key: value for key, value in record.items() if key.startswith("lastStaleRenotifyUnconfirmed")} == prior
    assert not record.get("staleRenotifyCount")


def test_storm_confirmation_is_durable_before_the_log(notice, monkeypatch):
    mod, paths = notice
    transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    append = mod.append_dispatch_log
    def crash_after_send(paths_arg, payload):
        if payload["type"] == "flap_storm":
            raise SystemExit("test crash before log")
        return append(paths_arg, payload)
    monkeypatch.setattr(mod, "append_dispatch_log", crash_after_send)
    stage(paths, "confirmed")
    with pytest.raises(SystemExit):
        mod.flap_scan_outbox(paths)
    entry = mod.load_incident_state(paths)["flapState"][KEY]
    assert entry["lastStormEmitAt"] == NOW
    assert "unconfirmedStorm" not in entry


def test_stale_confirmation_is_durable_before_the_log(notice, monkeypatch):
    mod, paths = notice
    stale_record(mod, paths)
    transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    append = mod.append_dispatch_log
    def crash_after_send(paths_arg, payload):
        if payload["type"] == "stale_renotify":
            raise SystemExit("test crash before log")
        return append(paths_arg, payload)
    monkeypatch.setattr(mod, "append_dispatch_log", crash_after_send)
    with pytest.raises(SystemExit):
        mod.sweep_stale_incidents(paths)
    record = mod.load_incident_state(paths)["openIncidents"][KEY]
    assert record["lastNotifiedAt"] == NOW
    assert record["staleRenotifyCount"] == 1
    assert "lastStaleRenotifyUnconfirmedAt" not in record


def test_intent_write_failure_prevents_the_storm_send(notice, monkeypatch):
    mod, paths = notice
    calls = transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    save = mod.save_incident_state
    def fail_intent(paths_arg, state):
        if state.get("flapState", {}).get(KEY, {}).get("unconfirmedStorm"):
            raise OSError("test durable intent unavailable")
        return save(paths_arg, state)
    monkeypatch.setattr(mod, "save_incident_state", fail_intent)
    stage(paths, "unsent")
    assert mod.flap_scan_outbox(paths) == 0
    assert calls == []
    entry = mod.load_incident_state(paths)["flapState"][KEY]
    assert not entry.get("stormAt") and "unconfirmedStorm" not in entry


def test_intent_write_failure_prevents_the_stale_send(notice, monkeypatch):
    mod, paths = notice
    prior = stale_record(mod, paths)
    calls = transport(monkeypatch, mod, {"sent": True, "resolved_chatJid": TARGET})
    save = mod.save_incident_state
    def fail_intent(paths_arg, state):
        if state["openIncidents"][KEY].get("lastStaleRenotifyUnconfirmedAt"):
            raise OSError("test durable intent unavailable")
        return save(paths_arg, state)
    monkeypatch.setattr(mod, "save_incident_state", fail_intent)
    assert mod.sweep_stale_incidents(paths)[:2] == (0, 1)
    assert calls == []
    record = mod.load_incident_state(paths)["openIncidents"][KEY]
    assert record["lastNotifiedAt"] == prior["lastNotifiedAt"]
    assert "lastStaleRenotifyUnconfirmedAt" not in record
