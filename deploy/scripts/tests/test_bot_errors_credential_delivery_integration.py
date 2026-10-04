"""Credential-cycle commits must preserve delivery and terminal-replay semantics."""
from __future__ import annotations

import json

import pytest

from deploy.scripts.tests.test_bot_errors_credential_repage import (
    DEAD,
    HOUR,
    OTHER_CRITICAL,
    SECTION,
    T0,
    Crash,
    fail_group_sends_of,
    make_rig,
    open_now,
    plain_event,
    watchdog_event,
)


def test_a_credential_timer_commit_does_not_record_a_failed_legacy_renotify(make_rig):
    rig = make_rig()
    first = plain_event(OTHER_CRITICAL, "hosta", "bot-one", T0)
    rig.clock.set(T0)
    rig.put(first)
    open_now(rig, T0)
    key = rig.d.incident_key(first)
    fields = ("lastSentAt", "lastNotifiedAt", "renotifyCount", "renotifyIntervalSeconds")
    before_state = rig.state()
    before = before_state["openIncidents"][key]
    assert len(rig.group_for(first["id"])) == 1
    assert rig.page_times() == [T0]

    due = T0 + 8 * HOUR
    rig.clock.set(due)
    repeated = plain_event(OTHER_CRITICAL, "hosta", "bot-one", due)
    rig.put(repeated)
    fail_group_sends_of(rig, repeated["id"])
    rig.email_rule = lambda subject, body: "fail"
    assert rig.cycle() is None

    after_state = rig.state()
    after = after_state["openIncidents"][key]
    assert any(f"event: {repeated['id']}" in send["text"] for send in rig.group_attempts)
    assert rig.group_for(repeated["id"]) == []
    assert rig.disposition(repeated["id"]) == ["outbox"]
    assert {field: after.get(field) for field in fields} == {
        field: before.get(field) for field in fields
    }
    assert after_state["lastSentAt"][key] == before_state["lastSentAt"][key]
    assert after_state.get("deliverySeq") == before_state.get("deliverySeq")
    assert after_state.get("deliveredSendNonces") == before_state.get("deliveredSendNonces")
    # The later credential timer persisted the shared payload despite the failed group send.
    assert rig.entry("hosta|bot-one")["lastPageAt"] == due
    assert rig.page_times() == [T0, due]


@pytest.mark.parametrize("replay", ["apply", "skip", "expire"])
def test_a_member_terminal_replay_has_one_observation_and_no_duplicate_page(make_rig, monkeypatch, replay):
    rig = make_rig()
    open_now(rig, T0)
    assert rig.page_times() == [T0]
    # Settle the preceding class-send outcome before testing a separate crash boundary.
    assert rig.cycle_at(T0 + 1) is None
    rig.clock.set(T0 + 60)
    event = watchdog_event(DEAD, "hosta", "bot-one", T0 + 60)
    rig.put(event)
    key = rig.d.incident_key(event)
    seq_before = rig.state()["deliverySeq"]

    if replay == "skip":
        rig.crash_before("archive_path")
    else:
        real_commit = rig.d.IncidentStateCycle.commit

        def stop_before_terminal_commit(cycle):
            for path in rig.paths["processing"].glob("*.processing"):
                stored = json.loads(path.read_text())
                if stored.get("id") == event["id"] and stored.get("delivery", {}).get("status") == "sent":
                    raise Crash("terminal event durable before the incident commit")
            return real_commit(cycle)

        monkeypatch.setattr(rig.d.IncidentStateCycle, "commit", stop_before_terminal_commit)

    assert isinstance(rig.cycle(), Crash)
    assert rig.disposition(event["id"]) == ["processing"]
    assert len(rig.group_for(event["id"])) == 1
    before = rig.state()
    conditions = before[SECTION]
    assert DEAD in " ".join(rig.members("hosta|bot-one"))
    if replay == "skip":
        assert before["deliverySeq"] == seq_before + 1
        assert key in before["openIncidents"]
    else:
        assert before["deliverySeq"] == seq_before
        assert key not in before["openIncidents"]

    rig.restart()
    if replay == "expire":
        replacement_epoch = "f" * 16 if before["deliveryEpoch"] != "f" * 16 else "e" * 16
        rig.edit_state(lambda state: state.update(deliveryEpoch=replacement_epoch))
    assert rig.cycle() is None
    after = rig.state()
    assert after[SECTION] == conditions
    assert rig.page_times() == [T0]
    assert len(rig.group_for(event["id"])) == 1
    assert rig.disposition(event["id"]) == ["sent"]
    if replay == "expire":
        assert key not in after["openIncidents"]
        assert key not in after["lastSentAt"]
        assert after["deliverySeq"] == seq_before
        assert after["terminalReplayExpiredCount"] == 1
        expired = [record for record in rig.log() if record.get("type") == "terminal_replay_expired"]
        assert len(expired) == 1
        assert expired[0]["details"].get("epochChanged") is True
    else:
        assert after["deliverySeq"] == seq_before + 1
        record = after["openIncidents"][key]
        assert record["eventId"] == event["id"]
        assert record["lastSentAt"] == record["lastNotifiedAt"] == T0 + 60
        assert record["renotifyCount"] == 0
        assert after["lastSentAt"][key] == T0 + 60
        assert not after.get("terminalReplayExpiredCount")
        assert any(record.get("type") == "terminal_replay_archived" for record in rig.log())
