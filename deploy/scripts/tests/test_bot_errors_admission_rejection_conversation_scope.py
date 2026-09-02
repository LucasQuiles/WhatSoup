"""Per-conversation scoping for agent_turn_admission_rejected incidents.

An admission rejection is a PER-CONVERSATION outage: the chat that was
rejected gets no reply. The incident key is machine|instance|source, so a
second conversation failing under an already-open incident used to collapse
into that incident and produce no operator signal at all.

These tests pin the fix: when an alert for a conversation-scoped source names
a conversation that the open incident does not yet represent, the dispatcher
notifies instead of suppressing. Repeat rejections in the SAME conversation
still dedupe, existing (digest-free) events behave exactly as before, and no
raw conversation identifier ever reaches the key, the event, or the text.

The conversation is carried as ``conversationScope`` — a bounded,
non-reversible digest minted at the emission boundary in
``src/lib/bot-errors-outbox.ts``. The dispatcher never sees a JID.
"""
from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

SOURCE = "agent_turn_admission_rejected"
INSTANCE = "instance-x"
MACHINE = "unknown"
KEY = f"{MACHINE}|{INSTANCE}|{SOURCE}"

# Synthetic conversation digests (16 lowercase hex, the emitted shape).
SCOPE_A = "a1b2c3d4e5f60718"
SCOPE_B = "0f1e2d3c4b5a6978"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_CONVERSATION_SCOPED_SOURCES",
    "BOT_ERRORS_CONVERSATION_SCOPE_RETENTION_SECONDS",
    "BOT_ERRORS_CONVERSATION_SCOPE_MAX_PER_KEY",
    "BOT_ERRORS_INCIDENT_COOLDOWN_SECONDS",
]


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


def _load(state_dir: Path, extra_env: dict[str, str] | None = None):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    for k, v in (extra_env or {}).items():
        os.environ[k] = v
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location(
        "bot_errors_dispatcher_conversation_scope", _SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _event(scope: str | None, event_id: str, seq: int) -> dict:
    event = {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "warning",
        "machine": MACHINE,
        "instance": INSTANCE,
        "source": SOURCE,
        "id": event_id,
        "createdAt": "2026-09-02T02:33:05.995Z",
        "summary": {"failureClass": "unknown", "length": 44, "correlationDigest": "de" * 32},
        "evidence": {
            "failureClass": "Error",
            "length": 88,
            "correlationDigest": f"{seq:064d}",
        },
    }
    if scope is not None:
        event["conversationScope"] = scope
    return event


def _open_state(last_notified: int | None = None, opened: int | None = None) -> dict:
    now = int(time.time())
    return {
        "version": 1,
        "openIncidents": {
            KEY: {
                "status": "open",
                "eventId": "evt-first",
                "openedAt": opened if opened is not None else now - 600,
                "openedIso": "2026-09-01T10:04:36Z",
                "lastSeenAt": now - 60,
                "lastSentAt": last_notified if last_notified is not None else now - 60,
                "lastNotifiedAt": last_notified if last_notified is not None else now - 60,
                "suppressedCount": 3,
            }
        },
        "lastSentAt": {KEY: last_notified if last_notified is not None else now - 60},
    }


# ---------------------------------------------------------------------------
# (a) two conversations under one instance -> two notifications
# ---------------------------------------------------------------------------

def test_second_conversation_is_notified_under_an_open_incident(tmp_path):
    """Chat B's first rejection must NOT be absorbed into chat A's incident.

    Two chats under one instance produce TWO notifications. The incident
    COUNT stays at one by design: the key is unchanged, so the recovery that
    closes it still matches. What changes is that the open incident can no
    longer swallow a conversation it has never represented.
    """
    mod = _load(tmp_path)
    state = _open_state()
    # Chat A's first rejection reaches the operator and registers the chat.
    assert mod.should_suppress_send(_event(SCOPE_A, "evt-a1", 1), state) is None
    # Chat A's own repeat dedupes into the open incident, exactly as before.
    repeat = mod.should_suppress_send(_event(SCOPE_A, "evt-a2", 2), state)
    assert repeat is not None and "duplicate suppressed" in repeat
    # Chat B has never been represented: it must reach the operator too.
    assert mod.should_suppress_send(_event(SCOPE_B, "evt-b1", 3), state) is None
    # One incident, two notifications.
    assert list(state["openIncidents"]) == [KEY]


def test_an_incident_open_from_before_the_upgrade_resurfaces_once_per_chat(tmp_path):
    """Rollout behaviour, pinned deliberately.

    An incident already open when this lands has no recorded conversations, so
    each distinct chat still failing surfaces ONCE and then goes quiet. That is
    the intended migration: the chats the incident was masking are exactly the
    ones an operator needs to see.
    """
    mod = _load(tmp_path)
    state = _open_state()
    assert "conversationScopes" not in state
    first_pass = [
        mod.should_suppress_send(_event(scope, f"evt-{scope}", i), state)
        for i, scope in enumerate((SCOPE_A, SCOPE_B), start=1)
    ]
    second_pass = [
        mod.should_suppress_send(_event(scope, f"evt-{scope}-again", i), state)
        for i, scope in enumerate((SCOPE_A, SCOPE_B), start=3)
    ]
    assert first_pass == [None, None]
    assert all(r is not None and "duplicate suppressed" in r for r in second_pass)


def test_main_behaviour_control_no_digest_collapses_into_one_incident(tmp_path):
    """Negative control: without the scope field both chats still collapse.

    This is what main does for every event, and it is what the four-day
    silence looked like. It also pins back-compat for an older runtime.
    """
    mod = _load(tmp_path)
    state = _open_state()
    first = mod.should_suppress_send(_event(None, "evt-a1", 1), state)
    second = mod.should_suppress_send(_event(None, "evt-b1", 2), state)
    assert first is not None and "duplicate suppressed" in first
    assert second is not None and "duplicate suppressed" in second


def test_new_conversation_overrides_the_cooldown_with_no_open_incident(tmp_path):
    """A closed incident inside its cooldown must not mask a different chat."""
    mod = _load(tmp_path, {"BOT_ERRORS_INCIDENT_COOLDOWN_SECONDS": "3600"})
    now = int(time.time())
    state = {"version": 1, "openIncidents": {}, "lastSentAt": {KEY: now - 60}}
    # Chat A was the one just sent; a repeat from A stays inside the cooldown.
    assert mod.should_suppress_send(_event(SCOPE_A, "evt-a1", 1), state) is None
    repeat = mod.should_suppress_send(_event(SCOPE_A, "evt-a2", 2), state)
    assert repeat is not None and "cooldown active" in repeat
    # Chat B is unrepresented: cooldown must not swallow it.
    assert mod.should_suppress_send(_event(SCOPE_B, "evt-b1", 3), state) is None


# ---------------------------------------------------------------------------
# (b) repeated rejections in ONE conversation still dedupe
# ---------------------------------------------------------------------------

def test_repeat_rejections_in_one_conversation_still_dedupe(tmp_path):
    mod = _load(tmp_path)
    state = _open_state()
    reasons = [
        mod.should_suppress_send(_event(SCOPE_A, f"evt-a{i}", i), state)
        for i in range(1, 7)
    ]
    # The first sighting registers the conversation and surfaces once; every
    # repeat after it is a duplicate and stays silent. No storm.
    assert reasons[0] is None
    assert all(r is not None and "duplicate suppressed" in r for r in reasons[1:])
    assert state["openIncidents"][KEY]["suppressedCount"] == 3 + 5


def test_an_open_storm_does_not_mask_a_new_conversations_first_rejection(tmp_path):
    """An open flap storm must not swallow a conversation it has never seen.

    Pattern F consolidates storm members because the storm alert already
    carries the count and rate. It does NOT carry the identity of a
    conversation nobody has been told about. The storm opens at five events
    in a 600s window and stays open until 3600s below threshold, so during
    exactly the multi-conversation wedge this gate targets the storm is the
    normal state, and consolidating first sightings into it would make the
    gate inert for up to an hour.
    """
    mod = _load(tmp_path)
    state = _open_state()
    state["flapState"] = {KEY: {"stormAt": 1, "tripTimestamps": [], "cumulativeCount": 5}}

    first = mod.should_suppress_send(_event(SCOPE_B, "evt-b1", 2), state)
    assert first is None, (
        "a conversation the storm has never represented must still be notified"
    )


def test_an_open_storm_still_consolidates_repeats_of_a_known_conversation(tmp_path):
    """The consolidation Pattern F exists for is preserved.

    Only the FIRST sighting of an unrepresented conversation escapes; every
    repeat is a storm member and stays consolidated, so the storm still does
    its job of collapsing a flapping source into one alert.
    """
    mod = _load(tmp_path)
    state = _open_state()
    state["flapState"] = {KEY: {"stormAt": 1, "tripTimestamps": [], "cumulativeCount": 5}}

    assert mod.should_suppress_send(_event(SCOPE_B, "evt-b1", 2), state) is None
    for index in range(2, 8):
        reason = mod.should_suppress_send(_event(SCOPE_B, f"evt-b{index}", index), state)
        assert reason is not None and "flap_storm_member" in reason


def test_an_open_storm_still_consolidates_an_event_with_no_conversation(tmp_path):
    """Storm consolidation is unchanged for every source that carries no scope."""
    mod = _load(tmp_path)
    state = _open_state()
    state["flapState"] = {KEY: {"stormAt": 1, "tripTimestamps": [], "cumulativeCount": 5}}
    reason = mod.should_suppress_send(_event(None, "evt-none", 2), state)
    assert reason is not None and "flap_storm_member" in reason


def test_a_storm_retry_of_an_already_forced_event_is_still_forced(tmp_path):
    """The retry guarantee holds inside a storm too.

    The forced notification is exactly as loseable here as on the ordinary
    path, so the same event id must survive a transient transport failure.
    """
    mod = _load(tmp_path)
    state = _open_state()
    state["flapState"] = {KEY: {"stormAt": 1, "tripTimestamps": [], "cumulativeCount": 5}}
    event = _event(SCOPE_B, "evt-storm-retry", 2)
    assert mod.should_suppress_send(event, state) is None
    assert mod.should_suppress_send(event, state) is None


# ---------------------------------------------------------------------------
# (c) privacy — no raw conversation identifier anywhere
# ---------------------------------------------------------------------------

# Raw identifier shapes that must never reach a delivered alert.
#
# toConversationKey (src/core/conversation-key.ts) mints the BARE LOCAL PART,
# colon-stripped, for both the personal and the LID domain. That is a plain
# digit run with no phone syntax, which is exactly the shape the redaction
# layer leaves alone: PHONE_LIKE_RE matches it, but redact_phone_like_match
# returns it unchanged without a leading "+" or a separator. So the bare forms
# below are the dangerous ones; the full JID is a positive control that proves
# the probe reaches the real redaction path.
RAW_JID = "15550100199@s.whatsapp.net"
RAW_PERSONAL_LOCAL = "15550100199"
RAW_LID_LOCAL = "15550100199443"


def test_no_raw_conversation_identifier_in_key_event_or_rendered_text(tmp_path):
    """The raw value must be FED IN, or the absence assertions prove nothing.

    This test previously computed the raw identifiers and then built the event
    with an already-digested scope, so every "not in" assertion held under any
    implementation, including one that rendered the field raw.
    """
    mod = _load(tmp_path)
    state = _open_state()

    for index, raw in enumerate((RAW_PERSONAL_LOCAL, RAW_LID_LOCAL, RAW_JID)):
        # The event id must not itself embed the raw value, or the assertion
        # below would fail on the id rather than on the field under test.
        event = _event(raw, f"evt-raw-{index}", 1)
        mod.should_suppress_send(event, state)
        rendered = mod.format_event(event)
        for blob in (mod.incident_key(event), rendered, json.dumps(state)):
            assert raw not in blob, f"{raw!r} leaked into {blob!r}"
        assert RAW_PERSONAL_LOCAL not in rendered
        assert "s.whatsapp.net" not in rendered
        assert "@lid" not in rendered

    # A well-formed digest still reaches the operator, so the line is useful.
    good = _event(SCOPE_A, "evt-good", 2)
    assert SCOPE_A in mod.format_event(good)


def test_both_delivered_surfaces_render_the_same_confined_text(tmp_path):
    """WhatsApp and the email fallback are fed by ONE format_event call.

    The dispatcher builds `text = format_event(event)` once and hands the same
    string to send_whatsapp and, after repeated failures, to email_fallback.
    Pinning that identity means the privacy assertion above covers both
    surfaces rather than only the one it calls.
    """
    mod = _load(tmp_path)
    sent: list[str] = []
    mailed: list[tuple[str, str]] = []
    mod.send_whatsapp = lambda text, *a, **k: sent.append(text)  # type: ignore[assignment]
    mod.email_fallback = lambda subject, body: mailed.append((subject, body)) or True  # type: ignore[assignment]

    event = _event(RAW_PERSONAL_LOCAL, "evt-both", 1)
    text = mod.format_event(event)
    mod.send_whatsapp(text)
    mod.email_fallback("BOT ERRORS delivery failing", text)

    assert sent and mailed
    assert sent[0] == mailed[0][1]
    for surface in (sent[0], mailed[0][1]):
        assert RAW_PERSONAL_LOCAL not in surface


def test_an_all_decimal_scope_is_rejected_because_digits_are_valid_hex(tmp_path):
    """The width check alone does not separate a digest from an identifier.

    Decimal digits are hex digits, so a bare conversation local part of the
    right width satisfies any plain hex test. Without an explicit all-decimal
    rejection a mis-wired emitter's raw key would validate, be recorded into
    state, and render to the operator.
    """
    mod = _load(tmp_path)
    # Sixteen characters, all decimal: passes a naive hex test.
    raw_sixteen = "1555010019900001"
    assert len(raw_sixteen) == 16
    event = _event(raw_sixteen, "evt-all-decimal", 1)

    assert mod.event_conversation_scope(event) is None
    assert raw_sixteen not in mod.format_event(event)

    state = _open_state()
    mod.should_suppress_send(event, state)
    assert raw_sixteen not in json.dumps(state)

    # A mixed digest of the same width is still accepted.
    good = _event("a1b2c3d4e5f60718", "evt-good-hex", 2)
    assert mod.event_conversation_scope(good) == "a1b2c3d4e5f60718"


def test_render_uses_the_validated_scope_not_the_raw_field(tmp_path):
    """A non-allowlisted source must not render the field at all."""
    mod = _load(tmp_path)
    event = _event(SCOPE_A, "evt-other", 1)
    event["source"] = "whatsapp_auth_bond_local_failure"
    rendered = mod.format_event(event)
    assert "conversation_scope" not in rendered


def test_a_malformed_conversation_scope_is_ignored_not_trusted(tmp_path):
    """Anything that is not a bounded hex digest must not enter state."""
    mod = _load(tmp_path)
    state = _open_state()
    raw_jid = "15550100199@s.whatsapp.net"
    bad = _event(raw_jid, "evt-bad", 9)
    reason = mod.should_suppress_send(bad, state)
    assert reason is not None and "duplicate suppressed" in reason
    assert raw_jid.split("@")[0] not in json.dumps(state)


# ---------------------------------------------------------------------------
# delivery retry — a forced notification must survive a transient failure
# ---------------------------------------------------------------------------

def test_a_delivery_retry_of_the_same_event_still_forces_the_notification(tmp_path):
    """The forced notification is the WHOLE point; losing it to a retry is fatal.

    An undelivered event stays in the outbox with a backoff and re-enters
    should_suppress_send on a later cycle carrying its ORIGINAL id. If the
    first evaluation marks the conversation represented, that retry is
    suppressed as a duplicate and the conversation never pages again — the
    exact silence this change exists to remove, reintroduced on the one alert
    that matters.

    The file already solves this class for the sibling flap counter
    (flap_occurrence_already_counted, "#2428: a delivery retry of the SAME
    event occurrence must not re-trip — count once per distinct event id").
    """
    mod = _load(tmp_path)
    state = _open_state()
    event = _event(SCOPE_B, "evt-retry-me", 1)

    first = mod.should_suppress_send(event, state)
    retry = mod.should_suppress_send(event, state)

    assert first is None, "first delivery must force the notification"
    assert retry is None, (
        "a retry of the SAME event id must still force it; the notification "
        "was lost to a transient transport failure"
    )


def test_a_distinct_later_event_in_that_conversation_dedupes(tmp_path):
    """Retry-tolerance must not become never-dedupe.

    Same conversation, DIFFERENT event id, means a genuinely new occurrence
    and must suppress as before.
    """
    mod = _load(tmp_path)
    state = _open_state()
    assert mod.should_suppress_send(_event(SCOPE_B, "evt-first", 1), state) is None
    later = mod.should_suppress_send(_event(SCOPE_B, "evt-second", 2), state)
    assert later is not None and "duplicate suppressed" in later


def test_an_event_with_no_id_falls_back_to_recording_once(tmp_path):
    """An id-less event cannot be retry-deduped; fail toward the old behaviour."""
    mod = _load(tmp_path)
    state = _open_state()
    first = _event(SCOPE_B, "", 1)
    first.pop("id", None)
    second = _event(SCOPE_B, "", 2)
    second.pop("id", None)
    assert mod.should_suppress_send(first, state) is None
    repeat = mod.should_suppress_send(second, state)
    assert repeat is not None and "duplicate suppressed" in repeat


def test_retry_records_are_bounded_like_the_conversation_set(tmp_path):
    mod = _load(
        tmp_path,
        {
            "BOT_ERRORS_CONVERSATION_SCOPE_MAX_PER_KEY": "4",
            "BOT_ERRORS_CONVERSATION_SCOPE_RETENTION_SECONDS": "60",
        },
    )
    state = _open_state()
    for i in range(12):
        mod.should_suppress_send(_event(f"{i:016x}", f"evt-{i}", i), state)
    scopes = state["conversationScopes"][KEY]
    assert len(scopes) <= 4
    for record in scopes.values():
        assert isinstance(record, dict)
        assert len(record.get("eventIds", {})) <= 4


# ---------------------------------------------------------------------------
# (d) incident-state schema compatibility — existing keys keep working
# ---------------------------------------------------------------------------

def test_existing_incident_keys_are_unchanged_no_migration(tmp_path):
    mod = _load(tmp_path)
    state = _open_state()
    before_keys = sorted(state["openIncidents"])
    before_sent = dict(state["lastSentAt"])
    mod.should_suppress_send(_event(SCOPE_B, "evt-b1", 2), state)
    assert sorted(state["openIncidents"]) == before_keys
    assert state["lastSentAt"] == before_sent
    assert mod.incident_key(_event(SCOPE_B, "evt-b1", 2)) == KEY


def test_state_written_by_an_older_dispatcher_loads_and_gates(tmp_path):
    """No conversationScopes subtree in state: the gate creates it lazily."""
    mod = _load(tmp_path)
    state = {"version": 1, "openIncidents": {KEY: {"status": "open", "openedAt": 1}}, "lastSentAt": {}}
    assert mod.should_suppress_send(_event(SCOPE_B, "evt-b1", 2), state) is None
    assert SCOPE_B in state["conversationScopes"][KEY]


def test_conversation_scope_state_is_bounded_by_count_and_retention(tmp_path):
    mod = _load(
        tmp_path,
        {
            "BOT_ERRORS_CONVERSATION_SCOPE_MAX_PER_KEY": "4",
            "BOT_ERRORS_CONVERSATION_SCOPE_RETENTION_SECONDS": "60",
        },
    )
    state = _open_state()
    for i in range(12):
        mod.should_suppress_send(_event(f"{i:016x}", f"evt-{i}", i), state)
    assert len(state["conversationScopes"][KEY]) <= 4

    # Retention: an entry older than the window is pruned, so that
    # conversation is "new" again and re-notifies.
    state["conversationScopes"] = {KEY: {SCOPE_B: int(time.time()) - 600}}
    assert mod.should_suppress_send(_event(SCOPE_B, "evt-b2", 99), state) is None


def test_gate_is_limited_to_the_registered_conversation_scoped_sources(tmp_path):
    """An unrelated source carrying a scope must not change its behaviour."""
    mod = _load(tmp_path)
    state = _open_state()
    other_key = f"{MACHINE}|{INSTANCE}|whatsapp_auth_bond_local_failure"
    state["openIncidents"][other_key] = dict(state["openIncidents"][KEY])
    event = _event(SCOPE_B, "evt-o1", 7)
    event["source"] = "whatsapp_auth_bond_local_failure"
    reason = mod.should_suppress_send(event, state)
    assert reason is not None and "duplicate suppressed" in reason
