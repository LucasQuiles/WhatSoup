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

from support import card_hygiene, dispatcher_fixtures  # noqa: E402

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
                {"name": "pair-line", "expected": "always_on"},
            ],
        },
        {
            "host": "host-2",
            "role": "bot-host",
            "instances": [
                {"name": "far-line", "expected": "always_on"},
                {"name": "retired-line", "expected": "blocked"},
                {"name": "shared", "expected": "blocked"},
                {"name": "far-pair-line", "expected": "always_on"},
            ],
        },
    ],
}

LINES = {
    "linked-line": {"name": "linked-line", "linkedStatus": "linked", "linkedStatusConfidence": "confirmed"},
    "logged-line": {"name": "logged-line", "linkedStatus": "unlinked", "linkedStatusConfidence": "confirmed"},
    "inferred-line": {"name": "inferred-line", "linkedStatus": "linked", "linkedStatusConfidence": "inferred"},
    "shared": {"name": "shared", "linkedStatus": "linked", "linkedStatusConfidence": "confirmed"},
    "pair-line": {"name": "pair-line", "linkedStatus": "linked", "linkedStatusConfidence": "confirmed"},
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
    # Relay 19 B4: every card these tests render is checked for machine fields.
    loaded.rendered_cards = card_hygiene.install_card_hygiene_hook(loaded)
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


def _healthy_probe(bot: str, *, outbound_at: int | None = None, uptime: int = 60) -> str:
    """A daily-health reading of a connected line; the recovery path's proof shape."""
    probe = (
        f"health {bot}: 200 status=healthy wa_connected=true state=connected auth_bond_status=present "
        f"auth_bond_creds_exists=true auth_bond_creds_size=512 auth_failure_class=none "
        f"lifecycle_process_uptime_seconds={uptime} reconnect_attempts=0"
    )
    if outbound_at is not None:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(outbound_at))
        probe += f" outbound_success_evidence=provider_acknowledged_or_better outbound_success_at={stamp}"
    return probe


def _proven(record: dict, bot: str) -> dict:
    """The record with a send after the incident in its own health reading (relay 19 B1)."""
    return {**record, "lastEvidence": _healthy_probe(bot, outbound_at=int(record["openedAt"]) + 3600)}


def _packets(mod) -> list[dict]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(mod.state_paths()["packets"].glob("*.json"))]


def _log_types(mod) -> list[str]:
    return [record.get("type") for record in dispatcher_fixtures.dispatch_log_records(mod.state_paths())]


# --- C2: recheck at renotify time ---------------------------------------------


def test_linked_line_with_a_send_after_the_incident_is_retired_on_recheck_without_a_message(mod):
    now = int(time.time())
    key = "hub-1|linked-line|instance_logged_out"
    _write_state(mod, {key: _proven(_physical(now - 5 * 86400, now - 4 * 86400), "linked-line")})
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
        "verdict": "cleared on recheck", "host": "hub-1", "bot": "linked-line",
        "reason": "linked, confirmed; outbound send after the incident",
    }
    assert state["lineRecheckRetired"][key]["ref"] == packet["ref"]


@pytest.mark.parametrize("evidence", [
    None,  # no health reading at all
    "health linked-line: 200 status=healthy wa_connected=true state=connected auth_bond_status=present "
    "auth_bond_creds_exists=true auth_bond_creds_size=512 lifecycle_process_uptime_seconds=60 reconnect_attempts=0",
    "health other-line: 200 status=healthy wa_connected=true state=connected auth_bond_status=present "
    "auth_bond_creds_exists=true auth_bond_creds_size=512 lifecycle_process_uptime_seconds=99999 reconnect_attempts=0",
])
def test_linked_line_without_recovery_proof_stays_open_and_listed(mod, evidence):
    # Relay 19 B1: "linked, confirmed" alone is not the clear requirement of a
    # protected bond-loss incident (server-revoked bond, manual relink). Only
    # the recovery path's proof (a send after the incident, or a sustained
    # stable connection) retires it; otherwise it stays open and on the card.
    now = int(time.time())
    key = "hub-1|linked-line|whatsapp_device_bond_lost"
    record = _physical(now - 5 * 86400, now - 4 * 86400)
    if evidence is not None:
        record["lastEvidence"] = evidence
    _write_state(mod, {key: record})
    sends = _sends(mod)

    assert mod.sweep_stale_incidents(mod.state_paths()) == (0, 0, None)
    assert sends == []
    state = _state(mod)
    assert key in state["openIncidents"]
    assert "lineRecheckRetired" not in state or key not in state["lineRecheckRetired"]
    assert state["openIncidents"][key]["lastLineRecheckVerdict"] == "could_not_check"

    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 1
    [card] = sends
    assert "linked-line (hub-1)" in card
    assert key in _state(mod)["openIncidents"]


def test_linked_line_with_a_sustained_stable_connection_is_retired(mod):
    now = int(time.time())
    key = "hub-1|linked-line|whatsapp_device_bond_lost"
    record = _physical(now - 5 * 86400, now - 4 * 86400)
    record["lastEvidence"] = _healthy_probe("linked-line", uptime=mod.SUSTAINED_STABILITY_MIN_UPTIME_SECONDS)
    _write_state(mod, {key: record})
    _sends(mod)

    assert mod.sweep_stale_incidents(mod.state_paths()) == (0, 0, None)
    state = _state(mod)
    assert key not in state["openIncidents"]
    assert state["lineRecheckRetired"][key]["disposition"] == "cleared on recheck"


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
    # Both records await a physical relink: the card keeps that action (relay 19 B2).
    assert card.startswith("🟡 *WhatsApp lines needing a relink: 2*")
    assert "far-line (host-2)" in card and "shared (unknown host)" in card
    assert "You: Action needed: relink or retire each line that needs a QR relink (Lucas)" in card


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
        # A stale logout with no standing action: listed as could not check.
        "hub-1|inferred-line|instance_logged_out": {"status": "stale", "openedAt": OLD - 86400, "lastSeenAt": OLD},
        "hub-1|linked-line|whatsapp_device_bond_lost": _proven(_physical(OLD - 86400, OLD), "linked-line"),
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


# Two producers page one bond loss under two keys: the host's daily health
# check ("<host>|<bot>|daily-health:whatsapp_device_bond_lost") and the
# collector, which does not know the host ("unknown|<bot>|whatsapp_device_bond_lost").
# Records reconstructed from two delivered stale digests of 2026-10-16 and the
# incident state they came from; host and line names neutralised.
_BOND_LOST_CLEAR = (
    "clear only after WhatsApp is connected with a non-empty auth bond and a successful outbound send "
    "after the relinked creds mtime and after the incident"
)


def _iso_epoch(text: str) -> int:
    return calendar.timegm(time.strptime(text, "%Y-%m-%dT%H:%M:%SZ"))


def _two_producer_pair(host: str, bot: str) -> dict:
    return {
        f"{host}|{bot}|daily-health:whatsapp_device_bond_lost": _physical(
            _iso_epoch("2026-09-03T11:20:22Z"),
            _iso_epoch("2026-09-03T11:20:22Z"),
            clearRequirement="connected WhatsApp state, present non-empty auth bond, and successful outbound send after relink",
        ),
        f"unknown|{bot}|whatsapp_device_bond_lost": _physical(
            _iso_epoch("2026-09-03T08:32:30Z"),
            _iso_epoch("2026-09-25T00:48:32Z"),
            clearRequirement=_BOND_LOST_CLEAR,
            suppressedCount=3093,
        ),
    }


def test_two_producer_keys_for_one_linked_line_are_each_rechecked_and_close_without_a_message(mod):
    incidents = {key: _proven(record, "pair-line") for key, record in _two_producer_pair("hub-1", "pair-line").items()}
    _write_state(mod, incidents)
    sends = _sends(mod)

    assert mod.sweep_stale_incidents(mod.state_paths()) == (0, 0, None)

    assert sends == []
    state = _state(mod)
    for key in incidents:
        assert key not in state["openIncidents"], key
        assert state["lineRecheckRetired"][key]["disposition"] == "cleared on recheck"
    packets = {packet["incidentKey"]: packet for packet in _packets(mod)}
    assert set(packets) == set(incidents)
    for key, packet in packets.items():
        # The recheck is the close reason, on the incident's own packet.
        assert packet["disposition"] == "cleared on recheck"
        assert packet["lineCheck"] == {
            "verdict": "cleared on recheck", "host": "hub-1", "bot": "pair-line",
            "reason": "linked, confirmed; outbound send after the incident",
        }
        assert state["lineRecheckRetired"][key]["ref"] == packet["ref"]
    assert _log_types(mod).count("line_recheck_retired") == 2
    assert len(mod.fleet_reads) == 1, "one live line read per sweep, not per key"


def test_two_producer_keys_for_a_line_on_another_host_are_one_could_not_check_line(mod):
    incidents = _two_producer_pair("host-2", "far-pair-line")
    _write_state(mod, incidents)
    sends = _sends(mod)

    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 1

    [card] = sends
    lines = card.split("\n")
    # Relay 19 B2: a line on another host cannot be checked here, but its
    # records still await a physical relink, so the card keeps that action,
    # who takes it and on which host.
    assert lines[0] == "🟡 *WhatsApp lines needing a relink: 1*"
    assert lines[1] == "far-pair-line (host-2) since 09-03: needs a QR relink on host-2 (could not check the line)"
    assert lines[2] == "You: Action needed: relink or retire each line that needs a QR relink (Lucas)"
    assert "No action needed" not in card
    state = _state(mod)
    for key in incidents:
        assert key in state["openIncidents"], "could not check never retires"
    packet = mod.read_notice_packet(mod.state_paths(), lines[-1][5:])
    [group] = packet["included"]
    assert group["verdict"] == "could_not_check"
    assert sorted(group["incidentKeys"]) == sorted(incidents)
    assert group["reasons"] == ["line is on another host"] * 2


def test_line_card_packet_keeps_every_field_of_each_members_old_notice(mod):
    # Relay 19 B5: one grouped card replaces a per-incident notice per member;
    # its packet keeps, per member, the record and the old notice's full body.
    incidents = _two_producer_pair("host-2", "far-pair-line")
    _write_state(mod, incidents)
    sends = _sends(mod)

    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 1

    [card] = sends
    packet = json.loads(json.dumps(mod.read_notice_packet(mod.state_paths(), card.rsplit("Ref: ", 1)[1])))
    [group] = packet["included"]
    members = {member["incidentKey"]: member for member in group["members"]}
    assert set(members) == set(incidents)
    for key, record in incidents.items():
        member = members[key]
        for field in ("status", "lastSummary", "openedAt", "lastSeenAt", "failureCode", "recoverability",
                      "clearRequirement", "assetKind"):
            assert member["record"][field] == record[field], (key, field)
        assert member["record"].get("suppressedCount") == record.get("suppressedCount")
        assert member["verdict"] == "could_not_check" and member["reason"] == "line is on another host"
        assert member["requestedAction"] == mod.physical_action_text()
        old_notice = mod.stale_incident_event(key, record, NOW, ignore_cadence=True)
        old_body = mod.format_event(old_notice)
        body = member["notice"]["body"]
        # The old notice's fields, label by label (the id and created time are per render).
        old_labels = [field["label"] for field in mod.body_fields(old_body)]
        assert [field["label"] for field in member["notice"]["bodyFields"]] == old_labels
        for line in old_body.split("\n"):
            if line.startswith(("  > event:", "  > created:")):
                continue
            assert line in body.split("\n"), (key, line)
        assert f"incident_key={key}" in body
        assert f"suppressed_duplicates={record.get('suppressedCount', 0)}" in body
        assert record["clearRequirement"][:60] in body


def test_a_member_whose_recheck_raises_keeps_its_record_and_old_notice(mod, monkeypatch):
    # Relay 20 M2: the could-not-check member of a recheck that raised keeps
    # the record and the old notice like every other member (contract A).
    key = "hub-1|inferred-line|instance_logged_out"
    record = _physical(OLD - 86400, OLD, suppressedCount=2)
    _write_state(mod, {key: record})
    sends = _sends(mod)

    def _check(self, machine, bot, record=None):
        raise TypeError("bad record")

    monkeypatch.setattr(mod.LineChecker, "check", _check)

    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 1

    [card] = sends
    assert "inferred-line (hub-1)" in card
    packet = mod.read_notice_packet(mod.state_paths(), card.rsplit("Ref: ", 1)[1])
    [group] = packet["included"]
    [member] = group["members"]
    assert member["incidentKey"] == key and member["verdict"] == "could_not_check"
    for field in ("status", "lastSummary", "openedAt", "lastSeenAt", "failureCode", "suppressedCount"):
        assert member["record"][field] == record[field], field
    old_notice = mod.stale_incident_event(key, record, NOW, ignore_cadence=True)
    assert member["notice"]["noticeId"] == mod.notice_id_of(old_notice)
    assert f"incident_key={key}" in member["notice"]["body"]
    assert member["notice"]["bodyFields"]


def test_a_member_whose_old_notice_cannot_be_built_still_keeps_its_record(mod, monkeypatch):
    # Relay 20 M2: each of record and notice is built in its own guard, so a
    # second error never stops the card or drops the other field.
    key = "hub-1|inferred-line|instance_logged_out"
    record = _physical(OLD - 86400, OLD)
    _write_state(mod, {key: record})
    sends = _sends(mod)

    def _raise(*a, **k):
        raise TypeError("bad record")

    monkeypatch.setattr(mod.LineChecker, "check", _raise)
    monkeypatch.setattr(mod, "stale_incident_event", _raise)

    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 1

    [card] = sends
    [group] = mod.read_notice_packet(mod.state_paths(), card.rsplit("Ref: ", 1)[1])["included"]
    [member] = group["members"]
    assert member["record"]["openedAt"] == record["openedAt"]
    assert "notice" not in member
    assert "line_card_member_field_failed" in _log_types(mod)


def test_unreadable_fleet_api_is_could_not_check_and_never_retires(mod, monkeypatch):
    monkeypatch.setattr(mod, "read_fleet_lines_for_recheck", lambda: mod.FleetLinesRead(None, "fleet_api_status_503"))
    _write_state(mod, {"hub-1|linked-line|instance_logged_out": _physical(OLD - 86400, OLD)})
    sends = _sends(mod)

    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 1

    assert "hub-1|linked-line|instance_logged_out" in _state(mod)["openIncidents"]
    [card] = sends
    assert card.startswith("🟡 *WhatsApp lines needing a relink: 1*")
    assert "linked-line (hub-1) since " in card and "(could not check the line)" in card


def test_could_not_check_lines_with_no_requested_action_need_no_one(mod):
    # "No action needed" only when no listed line asks for one (relay 19 B2).
    _write_state(mod, {
        "host-2|far-line|instance_logged_out": {"status": "stale", "openedAt": OLD - 86400, "lastSeenAt": OLD},
    })
    sends = _sends(mod)

    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 1

    [card] = sends
    lines = card.split("\n")
    assert lines[0] == "🟡 *WhatsApp lines that could not be checked: 1*"
    assert lines[1] == "far-line (host-2)"
    assert lines[2:4] == ["Handling: Q to check these lines", "You: No action needed"]


def test_remote_bond_loss_awaiting_relink_asks_the_owner_beside_unchecked_lines(mod):
    _write_state(mod, {
        "host-2|far-line|whatsapp_device_bond_lost": _physical(OLD - 86400, OLD),
        "hub-1|inferred-line|instance_logged_out": {"status": "stale", "openedAt": OLD - 86400, "lastSeenAt": OLD},
    })
    sends = _sends(mod)

    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 1

    [card] = sends
    lines = card.split("\n")
    since = time.strftime("%m-%d", time.gmtime(OLD - 86400))
    assert lines[0] == "🟡 *WhatsApp lines needing a relink: 1*"
    assert lines[1] == f"far-line (host-2) since {since}: needs a QR relink on host-2 (could not check the line)"
    assert lines[2] == "Could not check 1: inferred-line (hub-1)"
    assert lines[3] == "You: Action needed: relink or retire each line that needs a QR relink (Lucas)"


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


# --- Relay 19 S1: a packet-only notice stays pending until its packet exists ----


def _break_packet_store(mod) -> Path:
    packets = mod.state_paths()["packets"]
    packets.parent.mkdir(parents=True, exist_ok=True)
    if packets.is_dir():
        packets.rmdir()
    packets.write_text("not a directory", encoding="utf-8")
    return packets


def _mend_packet_store(packets: Path) -> None:
    packets.unlink()


def test_line_retirement_waits_for_its_packet(mod):
    now = int(time.time())
    key = "host-2|retired-line|whatsapp_device_bond_lost"
    _write_state(mod, {key: _physical(now - 9 * 86400, now - 8 * 86400)})
    sends = _sends(mod)
    packets = _break_packet_store(mod)

    assert mod.sweep_stale_incidents(mod.state_paths()) == (0, 0, None)

    state = _state(mod)
    assert key in state["openIncidents"], "no packet, no retirement"
    assert key not in state.get("lineRecheckRetired", {})
    assert "line_recheck_retire_pending" in _log_types(mod)
    assert sends == []

    _mend_packet_store(packets)
    assert mod.sweep_stale_incidents(mod.state_paths()) == (0, 0, None)
    state = _state(mod)
    assert key not in state["openIncidents"]
    ref = state["lineRecheckRetired"][key]["ref"]
    assert mod.read_notice_packet(mod.state_paths(), ref)["incidentKey"] == key


def test_information_deferral_waits_for_its_packet(mod):
    paths = mod.state_paths()
    sends = _sends(mod)
    packets = _break_packet_store(mod)
    event = _info_event("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "self_restart_completed")
    path = dispatcher_fixtures.write_outbox_event(paths, "20261016080000.q.info.json", event)

    ok, detail = mod.process_one(path, paths)

    assert (ok, detail) == (False, "information_deferral_pending")
    assert sends == []
    assert not _state(mod).get("informationSummary", {}).get("pending")
    assert [p for p in paths["suppressed"].iterdir() if not p.name.startswith(".")] == []
    queued = json.loads(path.read_text(encoding="utf-8"))
    assert queued["delivery"]["status"] == "queued"
    assert queued["delivery"]["nextAttemptAtEpoch"] > int(time.time())
    assert "information_deferral_pending" in _log_types(mod)

    _mend_packet_store(packets)
    queued["delivery"]["nextAttemptAtEpoch"] = 0
    path.write_text(json.dumps(queued), encoding="utf-8")
    assert mod.process_one(path, paths) == (True, "suppressed")
    [entry] = _state(mod)["informationSummary"]["pending"]
    assert entry["noticeId"] == event["id"] and entry["ref"]


def test_an_information_notice_whose_packet_stays_pending_is_dead_lettered_with_a_page(mod):
    # Relay 20 S-a: the requeue gives the attempt back, so without a cap a
    # notice whose packet can never be written requeues every 900 s with no
    # page. After BOT_ERRORS_DELIVERY_MAX_ATTEMPTS tries it is dead-lettered,
    # and the dead-letter meta-alert pages.
    paths = mod.state_paths()
    sends = _sends(mod)
    _break_packet_store(mod)
    event = _info_event("abababab-abab-4bab-8bab-abababababab", "self_restart_completed")
    path = dispatcher_fixtures.write_outbox_event(paths, "20261016080000.q.info.json", event)

    for _ in range(mod.BOT_ERRORS_DELIVERY_MAX_ATTEMPTS - 1):
        assert mod.process_one(path, paths) == (False, "information_deferral_pending")
        queued = json.loads(path.read_text(encoding="utf-8"))
        queued["delivery"]["nextAttemptAtEpoch"] = 0
        path.write_text(json.dumps(queued), encoding="utf-8")
    ok, detail = mod.process_one(path, paths)

    assert ok is False and detail.startswith("dead_letter"), detail
    assert not path.exists()
    [dead] = [p for p in paths["dead_letter"].glob("*.json")]
    assert json.loads(dead.read_text(encoding="utf-8"))["event"]["id"] == event["id"]
    assert "information_deferral_dead_lettered" in _log_types(mod)
    assert sends == []
    assert mod.queue_dead_letter_meta_alert(paths, int(time.time())) == 1


def test_auto_close_summary_waits_for_its_packet(mod):
    now = int(time.time())
    key = "hub-1|worker|runtime-tool-error:provider-cli:Bash"
    _write_state(mod, {key: {
        "status": "stale",
        "severity": "warning",
        "openedAt": now - 5 * 86400,
        "lastSeenAt": now - 5 * 86400,
        "lastSummary": "Agent tool failure: Bash",
    }})
    _sends(mod)
    packets = _break_packet_store(mod)

    _sent, _failed, err = mod.sweep_stale_incidents(mod.state_paths())

    assert err is not None
    state = _state(mod)
    assert key not in state["openIncidents"]
    assert state["staleAutocloseDigest"]["pendingCount"] == 1, "the close stays counted for the next try"
    assert not state.get("informationSummary", {}).get("pending")

    _mend_packet_store(packets)
    assert mod.sweep_stale_incidents(mod.state_paths())[2] is None
    state = _state(mod)
    assert state["staleAutocloseDigest"]["pendingCount"] == 0
    [entry] = state["informationSummary"]["pending"]
    assert entry["ref"] and entry["count"] == 1


# --- Relay 19 S4: one bad record or roster never stops the rest ------------------


def test_a_bad_member_record_is_could_not_check_and_the_card_still_goes_out(mod):
    _write_state(mod, {
        "hub-1|logged-line|instance_logged_out": _physical(OLD - 86400, OLD),
        # An opened time no clock can print (time.gmtime overflows); a float
        # keeps it inside what the state store accepts.
        "hub-1|inferred-line|instance_logged_out": _physical(1e20, OLD),
    })
    sends = _sends(mod)

    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 1

    [card] = sends
    assert "logged-line (hub-1) since " in card
    assert "inferred-line (hub-1)" in card
    state = _state(mod)
    assert "hub-1|inferred-line|instance_logged_out" in state["openIncidents"]


def test_a_recheck_that_raises_is_could_not_check_and_the_sweep_goes_on(mod, monkeypatch):
    now = int(time.time())
    _write_state(mod, {
        "hub-1|inferred-line|instance_logged_out": _physical(now - 5 * 86400, now - 4 * 86400),
        "hub-1|logged-line|instance_logged_out": _physical(now - 5 * 86400, now - 4 * 86400),
    })
    sends = _sends(mod)
    real_check = mod.LineChecker.check

    def _check(self, machine, bot, record=None):
        if bot == "inferred-line":
            raise TypeError("bad record")
        return real_check(self, machine, bot, record)

    monkeypatch.setattr(mod.LineChecker, "check", _check)

    assert mod.sweep_stale_incidents(mod.state_paths()) == (0, 0, None)

    assert sends == []
    state = _state(mod)
    bad = state["openIncidents"]["hub-1|inferred-line|instance_logged_out"]
    assert bad["lastLineRecheckVerdict"] == "could_not_check"
    assert state["openIncidents"]["hub-1|logged-line|instance_logged_out"]["lastLineRecheckVerdict"] == "logged_out"
    assert "line_recheck_member_failed" in _log_types(mod)


@pytest.mark.parametrize("instances", [5, "far-line", None, {"name": "x"}])
def test_a_roster_with_a_non_list_instances_value_never_aborts_the_sweep(mod, tmp_path, instances):
    broken = json.loads(json.dumps(ROSTER))
    broken["hosts"].append({"host": "host-3", "role": "bot-host", "instances": instances})
    roster = tmp_path / "fleet-broken.json"
    roster.write_text(json.dumps(broken), encoding="utf-8")
    os.environ["BOT_ERRORS_FLEET_SENTINEL_HOSTS"] = str(roster)
    now = int(time.time())
    _write_state(mod, {
        "hub-1|logged-line|instance_logged_out": _physical(now - 5 * 86400, now - 4 * 86400),
        "host-2|retired-line|whatsapp_device_bond_lost": _physical(now - 9 * 86400, now - 8 * 86400),
    })
    _sends(mod)

    assert mod.sweep_stale_incidents(mod.state_paths()) == (0, 0, None)

    state = _state(mod)
    assert state["openIncidents"]["hub-1|logged-line|instance_logged_out"]["lastLineRecheckVerdict"] == "logged_out"
    assert state["lineRecheckRetired"]["host-2|retired-line|whatsapp_device_bond_lost"]["disposition"] == "line retired"


# --- Relay 19 S2: an ambiguous daily send is sent-unconfirmed, never resent ----


def _ambiguous_sends(mod, phase: str) -> list[str]:
    tries: list[str] = []

    def _ambiguous(text, *a, **k):
        tries.append(text)
        raise mod.AmbiguousSendOutcome("reply never came", phase=phase)

    mod.send_whatsapp = _ambiguous  # type: ignore[assignment]
    return tries


def test_ambiguous_line_card_send_is_not_resent_that_day(mod):
    _write_state(mod, {"hub-1|logged-line|instance_logged_out": _physical(OLD - 86400, OLD)})
    tries = _ambiguous_sends(mod, mod.JSON_RPC_POST_REQUEST_PHASE)

    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 1
    section = _state(mod)["lineCheckCard"]
    assert section["lastSentDay"] == DAY and section["lastSendUnconfirmed"] is True
    assert "line_check_card_sent_unconfirmed" in _log_types(mod)
    assert mod.send_daily_line_card(mod.state_paths(), now=NOW + mod.DAILY_CARD_RETRY_SECONDS) == 0
    assert len(tries) == 1


def test_ambiguous_summary_send_is_not_resent_that_day(mod):
    paths = mod.state_paths()
    path = dispatcher_fixtures.write_outbox_event(paths, "20261016080000.q.info.json", _info_event(
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "self_restart_completed"))
    assert mod.process_one(path, paths) == (True, "suppressed")
    tries = _ambiguous_sends(mod, mod.JSON_RPC_POST_REQUEST_PHASE)

    assert mod.send_daily_information_summary(paths, now=NOW) == 1
    section = _state(mod)["informationSummary"]
    assert section["pending"] == [] and section["lastSentDay"] == DAY and section["lastSendUnconfirmed"] is True
    assert "information_summary_sent_unconfirmed" in _log_types(mod)
    assert mod.send_daily_information_summary(paths, now=NOW + mod.DAILY_CARD_RETRY_SECONDS) == 0
    assert len(tries) == 1


def test_a_send_that_failed_before_the_request_is_still_retried(mod):
    _write_state(mod, {"hub-1|logged-line|instance_logged_out": _physical(OLD - 86400, OLD)})
    tries = _ambiguous_sends(mod, mod.JSON_RPC_HANDSHAKE_PHASE)

    assert mod.send_daily_line_card(mod.state_paths(), now=NOW) == 0
    assert "lastSentDay" not in _state(mod)["lineCheckCard"]
    assert mod.send_daily_line_card(mod.state_paths(), now=NOW + mod.DAILY_CARD_RETRY_SECONDS) == 0
    assert len(tries) == 2


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


def test_auto_close_counts_every_pending_close_not_the_key_sample(mod):
    # Relay 19 S5: pendingKeys keeps a 200-key sample; pendingCount is the truth.
    sample = [f"hub-1|worker-{index}|runtime-tool-error:provider-cli:Bash" for index in range(200)]
    _write_state(mod, {}, staleAutocloseDigest={
        "pendingKeys": sample, "pendingCount": 350, "firstPendingAt": OLD, "lastDigestAt": 0,
    })
    sends = _sends(mod)

    assert mod.sweep_stale_incidents(mod.state_paths()) == (0, 0, None)

    [entry] = _state(mod)["informationSummary"]["pending"]
    assert entry["count"] == 350
    packet = mod.read_notice_packet(mod.state_paths(), entry["ref"])
    assert "closed_count=350" in packet["body"]
    assert mod.send_daily_information_summary(mod.state_paths(), now=NOW) == 1
    [card] = sends
    assert "Closed 350 old alerts that stopped reporting; they reopen if the problem returns" in card


def test_summary_shows_the_notices_dropped_when_its_queue_was_full(mod):
    paths = mod.state_paths()
    path = dispatcher_fixtures.write_outbox_event(paths, "20261016080000.q.info.json", _info_event(
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "self_restart_completed"))
    assert mod.process_one(path, paths) == (True, "suppressed")
    state = _state(mod)
    state["informationSummary"]["droppedFromSummary"] = 7
    mod.state_paths()["incident_state"].write_text(json.dumps(state), encoding="utf-8")
    sends = _sends(mod)

    assert mod.send_daily_information_summary(paths, now=NOW) == 1

    [card] = sends
    assert f"{mod.CARD_CLIP} 7 older notices not listed: the summary was full" in card.split("\n")
    packet = mod.read_notice_packet(paths, card.rsplit("Ref: ", 1)[1])
    assert packet["droppedFromSummary"] == 7
    assert _state(mod)["informationSummary"].get("droppedFromSummary", 0) == 0


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


def _recovered_observation(event_id: str) -> dict:
    event = _info_event(event_id, "remote-writefail-ack-failed")
    event.update({
        "machine": "hub-1",
        "instance": "bot-errors-collector",
        "summary": "remote writefail ack recovered: mini5",
        "evidence": "remote=mini5 writefail_ack_all_cleared=true",
        "diagnostics": {"remote": "mini5:/srv/bot-errors"},
    })
    return event


def test_information_after_a_page_the_group_saw_gets_its_own_resolved_card_at_once(mod):
    paths = mod.state_paths()
    sends = _sends(mod)
    event = _recovered_observation("99999999-9999-4999-8999-999999999999")
    opened = _iso_epoch(event["createdAt"]) - 2 * 3600
    _write_state(mod, {mod.incident_key(event): {
        "status": "open",
        "openedAt": opened,
        "lastNotifiedAt": opened,
        "lastSummary": "BOT ERRORS collector cannot terminal-ack remote writefail: mini5",
    }})
    path = dispatcher_fixtures.write_outbox_event(paths, "20261016080000.collector.recovered.json", event)
    assert mod.process_one(path, paths) == (True, "sent")
    [card] = sends
    lines = card.split("\n")
    # Relay 19 S8: the observation does not close the incident, so the card
    # says what happened (the producer's words) and that it is still open.
    # Relay 20 M3: it is information (contract B): the information icon and
    # at most four lines.
    assert len(lines) <= 4
    assert lines[0] == "ℹ️ *remote writefail ack recovered: mini5*"
    assert lines[1] == "Where: hub-1 - bot-errors-collector"
    assert lines[2] == "You: No action needed; the earlier alert stays open until its own clear arrives (open for 2h 0m)"
    assert lines[-1].startswith("Ref: ")
    assert "Recovered" not in card and not any(line.startswith(("✅", "🟡")) for line in lines)
    assert mod.incident_key(event) in _state(mod)["openIncidents"]
    assert not _state(mod).get("informationSummary", {}).get("pending")
    assert [p for p in paths["suppressed"].iterdir() if not p.name.startswith(".")] == []


def test_information_after_a_page_never_says_recovered_while_the_incident_stays_open(mod):
    paths = mod.state_paths()
    sends = _sends(mod)
    event = _recovered_observation("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
    event["summary"] = "remote writefail ack retried: mini5"
    opened = NOW - 2 * 3600
    _write_state(mod, {mod.incident_key(event): {
        "status": "open",
        "openedAt": opened,
        "lastNotifiedAt": opened,
        "lastSummary": "BOT ERRORS collector cannot terminal-ack remote writefail: mini5",
    }})
    path = dispatcher_fixtures.write_outbox_event(paths, "20261016080000.collector.retried.json", event)
    assert mod.process_one(path, paths) == (True, "sent")
    [card] = sends
    assert "recovered" not in card.lower()
    assert card.split("\n", 1)[0] == "ℹ️ *remote writefail ack retried: mini5*"
    assert "the earlier alert stays open" in card
    assert mod.incident_key(event) in _state(mod)["openIncidents"], "an observation never closes the incident"


def test_information_after_a_page_that_asked_the_owner_keeps_the_owner_request(mod):
    # Relay 20 M3 (Opus N9): when the page it follows asked the owner to act,
    # the information card says that request still stands, never "No action needed".
    paths = mod.state_paths()
    sends = _sends(mod)
    event = _recovered_observation("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    opened = NOW - 3600
    _write_state(mod, {mod.incident_key(event): {
        "status": "open",
        "openedAt": opened,
        "lastNotifiedAt": opened,
        "lastSummary": "BOT ERRORS collector cannot terminal-ack remote writefail: mini5",
        "ownerRequest": "You: Action needed: do the owner step in the packet",
    }})
    path = dispatcher_fixtures.write_outbox_event(paths, "20261016080000.collector.recovered.json", event)
    assert mod.process_one(path, paths) == (True, "sent")
    [card] = sends
    lines = card.split("\n")
    assert len(lines) <= 4 and lines[0].startswith("ℹ️ *")
    assert lines[2] == "You: The earlier request still stands: do the owner step in the packet; the alert stays open"
    assert "No action needed" not in card and "Recovered" not in card


def test_a_relink_page_with_no_stored_request_still_keeps_the_relink_request(mod):
    # A record written before ownerRequest existed: its awaiting_physical status
    # is the relink request the page made.
    paths = mod.state_paths()
    sends = _sends(mod)
    event = _recovered_observation("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
    opened = NOW - 3600
    _write_state(mod, {mod.incident_key(event): {
        "status": "awaiting_physical",
        "openedAt": opened,
        "lastNotifiedAt": opened,
        "lastSummary": "linked-device bond lost",
    }})
    path = dispatcher_fixtures.write_outbox_event(paths, "20261016080000.collector.recovered.json", event)
    assert mod.process_one(path, paths) == (True, "sent")
    [card] = sends
    assert "You: The earlier request still stands: relink the WhatsApp line or retire it; the alert stays open" in card


def test_a_delivered_page_records_its_owner_request_and_a_later_page_without_one_clears_it(mod):
    state = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
    page = {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "critical",
        "id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "createdAt": "2026-10-16T08:00:00Z",
        "machine": "hub-1",
        "instance": "fixture-bot",
        "source": "health_body_degraded",
        "summary": "fixture-bot degraded",
        "criticalAsset": {"failure": {"operatorAction": "Lucas to restore the provider sign-in"}},
    }
    mod.mark_incident_sent(page, state)
    record = state["openIncidents"][mod.incident_key(page)]
    assert record["ownerRequest"] == "You: Action needed: do the owner step in the packet"
    later = {key: value for key, value in page.items() if key != "criticalAsset"}
    later["id"] = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee0"
    mod.mark_incident_sent(later, state)
    assert "ownerRequest" not in state["openIncidents"][mod.incident_key(page)]


def test_information_with_no_earlier_page_still_goes_to_the_daily_summary(mod):
    paths = mod.state_paths()
    sends = _sends(mod)
    event = _recovered_observation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    # An open record the group was never paged for does not count as a page.
    _write_state(mod, {mod.incident_key(event): {"status": "open", "openedAt": OLD}})
    path = dispatcher_fixtures.write_outbox_event(paths, "20261016080000.collector.recovered.json", event)
    assert mod.process_one(path, paths) == (True, "suppressed")
    assert sends == []
    [pending] = _state(mod)["informationSummary"]["pending"]
    assert pending["noticeId"] == event["id"]
    [archived] = [p for p in paths["suppressed"].iterdir() if not p.name.startswith(".")]
    assert json.loads(archived.read_text())["delivery"]["suppressedReason"] == mod.INFO_SUMMARY_DEFERRED_REASON
