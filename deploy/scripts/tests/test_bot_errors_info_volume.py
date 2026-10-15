"""Fewer BOT INFO messages (relay 16 C1-C3).

C1  an auto-close of old non-actionable incidents sends nothing: packet only,
    counted in the daily information summary;
C2  an old logged-out / bond-lost incident is rechecked against the line's live
    state (local fleet /api/lines + fleet roster) before it is re-announced:
    linked + confirmed closes it "cleared on recheck"; a line the roster no
    longer expects to run closes it "line retired"; an unlinked line is listed
    once a day in one grouped card; an inferred or unreadable reading is listed
    as "could not check" and never retired;
C3  an information-only notice is folded into one daily summary at 13:00Z.

All fixtures are synthetic: neutral host and line names, no chat ids.
"""
from __future__ import annotations

import calendar
import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

_SCRIPT = _TESTS_DIR.parent / "bot-errors-dispatcher.py"
_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_MACHINE",
    "BOT_ERRORS_FLEET_SENTINEL_HOSTS",
    "BOT_ERRORS_INFO_SUMMARY_HOUR_UTC",
]
_clean_env = dispatcher_fixtures.make_env_scrub_fixture(_ENV_KEYS)

# 2026-10-16 13:05:00Z: five minutes into the daily card slot.
DAY = "2026-10-16"
SLOT = calendar.timegm(time.strptime(DAY, "%Y-%m-%d")) + 13 * 3600
NOW = SLOT + 300
OLD = NOW - 3 * 86400

ROSTER = {
    "schemaVersion": 1,
    "hosts": [
        {
            "host": "hub-1",
            "role": "central",
            "instances": [
                {"name": "linked-line", "expected": "always_on"},
                {"name": "logged-line", "expected": "always_on"},
                {"name": "inferred-line", "expected": "always_on"},
                {"name": "shared", "expected": "always_on"},
            ],
        },
        {
            "host": "host-2",
            "role": "bot-host",
            "instances": [
                {"name": "far-line", "expected": "always_on"},
                {"name": "retired-line", "expected": "blocked"},
                {"name": "shared", "expected": "blocked"},
            ],
        },
    ],
}

LINES = {
    "linked-line": {"name": "linked-line", "linkedStatus": "linked", "linkedStatusConfidence": "confirmed"},
    "logged-line": {"name": "logged-line", "linkedStatus": "unlinked", "linkedStatusConfidence": "confirmed"},
    "inferred-line": {"name": "inferred-line", "linkedStatus": "linked", "linkedStatusConfidence": "inferred"},
    "shared": {"name": "shared", "linkedStatus": "linked", "linkedStatusConfidence": "confirmed"},
}


@pytest.fixture
def mod(tmp_path, monkeypatch):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path / "state")
    os.environ["BOT_ERRORS_MACHINE"] = "hub-1"
    roster = tmp_path / "fleet.json"
    roster.write_text(json.dumps(ROSTER), encoding="utf-8")
    os.environ["BOT_ERRORS_FLEET_SENTINEL_HOSTS"] = str(roster)
    spec = importlib.util.spec_from_file_location(f"bot_errors_dispatcher_info_volume_{tmp_path.name}", _SCRIPT)
    loaded = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(loaded)  # type: ignore[union-attr]
    loaded.setup_dirs()
    reads: list[int] = []

    def _lines():
        reads.append(1)
        return loaded.FleetLinesRead(dict(LINES))

    monkeypatch.setattr(loaded, "read_fleet_lines_for_recheck", _lines)
    loaded.fleet_reads = reads
    return loaded


def _sends(mod) -> list[str]:
    sends: list[str] = []
    mod.send_whatsapp = lambda text, *a, **k: sends.append(text)  # type: ignore[assignment]
    return sends


def _write_state(mod, incidents: dict, **extra) -> None:
    path = mod.state_paths()["incident_state"]
    state = {"version": 1, "openIncidents": incidents, "lastSentAt": {key: OLD for key in incidents}, **extra}
    path.write_text(json.dumps(state), encoding="utf-8")
    path.chmod(0o600)


def _state(mod) -> dict:
    return json.loads(mod.state_paths()["incident_state"].read_text(encoding="utf-8"))


def _physical(opened: int, last_seen: int, **extra) -> dict:
    return {
        "status": "awaiting_physical",
        "openedAt": opened,
        "lastSeenAt": last_seen,
        "lastSummary": "unknown - 40 chars - digest 0a1b2c3d",
        "failureCode": "WA_AUTH_BOND_SERVER_REVOKED",
        "recoverability": "manual_relink_required",
        "assetKind": "whatsapp_linked_device",
        **extra,
    }


def _packets(mod) -> list[dict]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(mod.state_paths()["packets"].glob("*.json"))]


def _log_types(mod) -> list[str]:
    return [record.get("type") for record in dispatcher_fixtures.dispatch_log_records(mod.state_paths())]


# --- C2: recheck at renotify time ---------------------------------------------


def test_linked_and_confirmed_line_is_retired_on_recheck_without_a_message(mod):
    now = int(time.time())
    key = "hub-1|linked-line|instance_logged_out"
    _write_state(mod, {key: _physical(now - 5 * 86400, now - 4 * 86400)})
    sends = _sends(mod)

    sent, failed, err = mod.sweep_stale_incidents(mod.state_paths())

    assert (sent, failed, err) == (0, 0, None)
    assert sends == []
    state = _state(mod)
    assert key not in state["openIncidents"]
    assert state["lineRecheckRetired"][key]["disposition"] == "cleared on recheck"
    [packet] = _packets(mod)
    assert packet["disposition"] == "cleared on recheck"
    assert packet["incidentKey"] == key
    assert packet["lineCheck"] == {
        "verdict": "cleared on recheck", "host": "hub-1", "bot": "linked-line", "reason": "linked, confirmed",
    }
    assert state["lineRecheckRetired"][key]["ref"] == packet["ref"]


def test_roster_retired_line_closes_as_line_retired_and_never_reaches_the_card(mod):
    now = int(time.time())
    key = "host-2|retired-line|whatsapp_device_bond_lost"
    _write_state(mod, {key: _physical(now - 9 * 86400, now - 8 * 86400)})
    sends = _sends(mod)

    assert mod.sweep_stale_incidents(mod.state_paths()) == (0, 0, None)

    assert sends == []
    state = _state(mod)
    assert key not in state["openIncidents"]
    assert state["lineRecheckRetired"][key]["disposition"] == "line retired"
    [packet] = _packets(mod)
    assert packet["disposition"] == "line retired"
    assert packet["lineCheck"]["reason"] == "roster expected=blocked"
    assert mod.fleet_reads == [], "a retired line needs no live read"
    # And the daily card has nothing to list.
    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 0
    assert sends == []


def test_same_name_retired_on_one_host_is_never_retired_where_ambiguous_or_always_on(mod):
    # "shared" is blocked on host-2 but always_on on hub-1.
    _write_state(mod, {
        "host-2|shared|instance_logged_out": _physical(OLD - 86400, OLD),
        "unknown|shared|instance_logged_out": _physical(OLD - 86400, OLD),
        "host-2|far-line|instance_logged_out": _physical(OLD - 86400, OLD),
    })
    sends = _sends(mod)

    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 1

    state = _state(mod)
    assert list(state["lineRecheckRetired"]) == ["host-2|shared|instance_logged_out"]
    # Ambiguous host: could not check, never retired. An always_on line on
    # another host: could not check (this host's fleet API lists only its own).
    assert "unknown|shared|instance_logged_out" in state["openIncidents"]
    assert "host-2|far-line|instance_logged_out" in state["openIncidents"]
    [card] = sends
    assert card.startswith("🟡 *WhatsApp lines that could not be checked: 2*")
    assert "far-line (host-2)" in card and "shared (unknown host)" in card


def test_unlinked_line_is_deferred_and_listed_once_in_the_daily_card(mod):
    now = int(time.time())
    key = "hub-1|logged-line|instance_logged_out"
    _write_state(mod, {key: _physical(now - 5 * 86400, now - 4 * 86400)})
    sends = _sends(mod)

    assert mod.sweep_stale_incidents(mod.state_paths()) == (0, 0, None)
    assert sends == []
    record = _state(mod)["openIncidents"][key]
    assert record["lastLineRecheckVerdict"] == "logged_out"
    assert "stale_renotify_deferred_to_line_card" in _log_types(mod)
    # The cadence advanced: the next sweep does not recheck again.
    mod.sweep_stale_incidents(mod.state_paths())
    assert len(mod.fleet_reads) == 1


def test_daily_card_merges_one_bot_and_separates_could_not_check(mod):
    _write_state(mod, {
        "hub-1|logged-line|instance_logged_out": _physical(OLD - 2 * 86400, OLD),
        "hub-1|logged-line|whatsapp_device_bond_lost": _physical(OLD - 86400, OLD),
        "hub-1|logged-line|daily-health:whatsapp_device_bond_lost": _physical(OLD - 86400, OLD),
        "hub-1|bot-errors-health|daily-health-fail:logged-line": _physical(OLD - 86400, OLD),
        "hub-1|inferred-line|instance_logged_out": _physical(OLD - 86400, OLD),
        "hub-1|linked-line|whatsapp_device_bond_lost": _physical(OLD - 86400, OLD),
        # Not stale yet: no recheck, not listed.
        "hub-1|far-line|instance_logged_out": _physical(NOW - 3600, NOW - 600),
    })
    sends = _sends(mod)

    # Before 13:00Z nothing goes out.
    assert mod.send_daily_line_card(mod.state_paths(), now=SLOT - 60) == 0
    assert sends == []

    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 1
    [card] = sends
    lines = card.split("\n")
    since = time.strftime("%m-%d", time.gmtime(OLD - 2 * 86400))
    assert lines[0] == "🟡 *WhatsApp lines logged out: 1*"
    assert lines[1] == f"logged-line (hub-1) since {since}: needs a QR relink on hub-1"
    assert lines[2] == "Could not check 1: inferred-line (hub-1)"
    assert lines[3] == "You: Action needed: relink or retire each logged-out line (Lucas)"
    assert re.fullmatch(r"Ref: [0-9a-f]{8}", lines[4])
    assert not card.startswith(("🔴 *", "🔴 ⚡ "))
    state = _state(mod)
    # linked + confirmed closed on the card's recheck; the rest stay open.
    assert "hub-1|linked-line|whatsapp_device_bond_lost" not in state["openIncidents"]
    assert "hub-1|inferred-line|instance_logged_out" in state["openIncidents"]
    assert "hub-1|logged-line|instance_logged_out" in state["openIncidents"]
    packet = mod.read_notice_packet(mod.state_paths(), lines[4][5:])
    [logged, unchecked] = packet["included"]
    assert logged["bot"] == "logged-line" and len(logged["incidentKeys"]) == 4
    assert unchecked["verdict"] == "could_not_check" and unchecked["reasons"] == ["linked, inferred"]

    # Once a UTC day.
    assert mod.send_daily_line_card(mod.state_paths(), now=NOW + 3600) == 0
    assert len(sends) == 1


def test_unreadable_fleet_api_is_could_not_check_and_never_retires(mod, monkeypatch):
    monkeypatch.setattr(mod, "read_fleet_lines_for_recheck", lambda: mod.FleetLinesRead(None, "fleet_api_status_503"))
    _write_state(mod, {"hub-1|linked-line|instance_logged_out": _physical(OLD - 86400, OLD)})
    sends = _sends(mod)

    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 1

    assert "hub-1|linked-line|instance_logged_out" in _state(mod)["openIncidents"]
    [card] = sends
    assert card.startswith("🟡 *WhatsApp lines that could not be checked: 1*")
    assert "linked-line (hub-1)" in card


def test_live_fleet_api_is_not_read_under_a_test_runner(mod, monkeypatch):
    monkeypatch.undo()  # the real reader
    assert os.environ.get("PYTEST_CURRENT_TEST")
    assert mod.read_fleet_lines_for_recheck().lines is None


def test_failed_line_card_is_retried_later_the_same_day(mod):
    _write_state(mod, {"hub-1|logged-line|instance_logged_out": _physical(OLD - 86400, OLD)})

    def _boom(text, *a, **k):
        raise RuntimeError("group line unavailable")

    mod.send_whatsapp = _boom  # type: ignore[assignment]
    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 0
    sends = _sends(mod)
    assert mod.send_daily_line_card(mod.state_paths(), now=NOW + 60) == 0  # inside the retry gap
    assert mod.send_daily_line_card(mod.state_paths(), now=NOW + mod.DAILY_CARD_RETRY_SECONDS) == 1
    assert len(sends) == 1


# --- C1: auto-close -----------------------------------------------------------


def test_auto_close_sends_nothing_writes_a_packet_and_counts_in_the_summary(mod):
    now = int(time.time())
    key = "hub-1|worker|runtime-tool-error:provider-cli:Bash"
    _write_state(mod, {key: {
        "status": "stale",
        "severity": "warning",
        "openedAt": now - 5 * 86400,
        "lastSeenAt": now - 5 * 86400,
        "lastSummary": "Agent tool failure: Bash",
    }})
    sends = _sends(mod)

    assert mod.sweep_stale_incidents(mod.state_paths()) == (0, 0, None)

    assert sends == []
    assert key not in _state(mod)["openIncidents"]
    [entry] = _state(mod)["informationSummary"]["pending"]
    assert entry["noticeKind"] == "stale-autoclose" and entry["count"] == 1
    packet = mod.read_notice_packet(mod.state_paths(), entry["ref"])
    assert packet["disposition"] == "daily information summary"
    assert "closed_keys=" + key in packet["body"]

    assert mod.send_daily_information_summary(mod.state_paths(), now=NOW) == 1
    [card] = sends
    assert "Closed 1 old alert that stopped reporting; it reopens if the problem returns" in card


# --- C3: information-only notices -----------------------------------------------


def _info_event(event_id: str, source: str, *, severity: str = "info") -> dict:
    kind = ("observation", "observation") if severity == "info" else ("incident_alert", "alert")
    return {
        "schemaVersion": 2,
        "eventKind": kind[0],
        "eventType": kind[1],
        "severity": severity,
        "id": event_id,
        "createdAt": "2026-10-16T08:00:00Z",
        "instance": "q",
        "source": source,
        "summary": {"failureClass": "unknown", "length": 40, "correlationDigest": "ab" * 32},
        "evidence": {"failureClass": "unknown", "length": 10, "correlationDigest": "cd" * 32},
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0},
    }


def test_information_events_between_summaries_become_one_summary_at_13z(mod):
    paths = mod.state_paths()
    sends = _sends(mod)
    events = [
        _info_event("11111111-1111-4111-8111-111111111111", "self_restart_completed"),
        _info_event("22222222-2222-4222-8222-222222222222", "provider_fallback_reverted"),
        _info_event("33333333-3333-4333-8333-333333333333", "self_restart_completed"),
        _info_event("44444444-4444-4444-8444-444444444444", "model-currency"),
    ]
    for index, event in enumerate(events):
        path = dispatcher_fixtures.write_outbox_event(paths, f"2026101608000{index}.q.info.json", event)
        ok, detail = mod.process_one(path, paths)
        assert (ok, detail) == (True, "suppressed")
    assert sends == []
    suppressed = sorted(paths["suppressed"].iterdir())
    assert len(suppressed) == 4
    assert {
        json.loads(p.read_text())["delivery"]["suppressedReason"] for p in suppressed
    } == {mod.INFO_SUMMARY_DEFERRED_REASON}
    pending = _state(mod)["informationSummary"]["pending"]
    assert [entry["noticeId"] for entry in pending] == [event["id"] for event in events]

    assert mod.send_daily_information_summary(paths, now=SLOT - 1) == 0
    assert sends == []
    assert mod.send_daily_information_summary(paths, now=NOW) == 1
    [card] = sends
    lines = card.split("\n")
    assert lines[0] == "ℹ️ *Information since the last summary: 3*"
    assert lines[1:4] == [
        "Q restarted and is back online (2x)",
        "Q is back on its main AI provider",
        "Q: newer AI model available",
    ]
    assert lines[4] == "You: No action needed"
    ref = lines[5][5:]
    summary = mod.read_notice_packet(paths, ref)
    assert [entry["ref"] for entry in summary["included"]] == [entry["ref"] for entry in pending]
    for entry in summary["included"]:
        assert mod.read_notice_packet(paths, entry["ref"])["noticeId"] == entry["noticeId"]
    assert not card.startswith(("🔴 *", "🔴 ⚡ "))
    assert _state(mod)["informationSummary"]["pending"] == []

    # One summary a UTC day: a later notice waits for tomorrow's.
    path = dispatcher_fixtures.write_outbox_event(paths, "20261016140000.q.info.json", _info_event(
        "55555555-5555-4555-8555-555555555555", "recovery_debt_attention"))
    assert mod.process_one(path, paths) == (True, "suppressed")
    assert mod.send_daily_information_summary(paths, now=NOW + 3600) == 0
    assert mod.send_daily_information_summary(paths, now=NOW + 86400) == 1
    assert len(sends) == 2


def test_warning_and_action_notices_keep_their_own_card(mod):
    paths = mod.state_paths()
    sends = _sends(mod)
    warning = _info_event("66666666-6666-4666-8666-666666666666", "model-currency", severity="warning")
    path = dispatcher_fixtures.write_outbox_event(paths, "20261016090000.q.warning.json", warning)
    assert mod.process_one(path, paths) == (True, "sent")
    [card] = sends
    assert card.startswith("🟠 *Q: AI model in use is being retired*")
    assert "informationSummary" not in _state(mod) or not _state(mod)["informationSummary"].get("pending")


def test_failed_summary_keeps_its_notices_for_a_retry(mod):
    paths = mod.state_paths()
    path = dispatcher_fixtures.write_outbox_event(paths, "20261016080000.q.info.json", _info_event(
        "77777777-7777-4777-8777-777777777777", "self_restart_completed"))
    mod.process_one(path, paths)

    def _boom(text, *a, **k):
        raise RuntimeError("group line unavailable")

    mod.send_whatsapp = _boom  # type: ignore[assignment]
    assert mod.send_daily_information_summary(paths, now=NOW) == 0
    assert len(_state(mod)["informationSummary"]["pending"]) == 1
    sends = _sends(mod)
    assert mod.send_daily_information_summary(paths, now=NOW + mod.DAILY_CARD_RETRY_SECONDS) == 1
    assert len(sends) == 1 and _state(mod)["informationSummary"]["pending"] == []


def test_a_notice_deferred_twice_keeps_one_summary_entry(mod):
    paths = mod.state_paths()
    event = _info_event("88888888-8888-4888-8888-888888888888", "self_restart_completed")
    state = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
    first = mod.defer_information_notice(paths, state, dict(event), notice_kind="outbox")
    second = mod.defer_information_notice(paths, state, dict(event), notice_kind="outbox")
    assert first == second
    assert [entry["noticeId"] for entry in state["informationSummary"]["pending"]] == [event["id"]]
