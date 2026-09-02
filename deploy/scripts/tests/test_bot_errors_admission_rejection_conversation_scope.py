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


def _raise_transport(*args, **kwargs):
    raise RuntimeError("transport down")


def _gate_then_deliver(mod, event: dict, state: dict) -> str | None:
    """Evaluate the gate, then record delivery when it says send.

    Mirrors process_one: should_suppress_send decides, and only a successful
    send reaches mark_incident_sent, which is where representation is
    recorded. Tests that want the post-delivery state must go through this
    rather than calling the predicate twice, because the predicate is pure.
    """
    reason = mod.should_suppress_send(event, state)
    if reason is None:
        mod.record_conversation_scope_delivered(
            event, state, mod.incident_key(event), int(time.time())
        )
    return reason

SOURCE = "agent_turn_admission_rejected"
INSTANCE = "instance-x"
MACHINE = "unknown"
KEY = f"{MACHINE}|{INSTANCE}|{SOURCE}"

# Synthetic conversation scopes in the emitted shape: the cs1_ version tag
# followed by 16 lowercase hex characters.
SCOPE_A = "cs1_a1b2c3d4e5f60718"
SCOPE_B = "cs1_0f1e2d3c4b5a6978"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_CONVERSATION_SCOPED_SOURCES",
    "BOT_ERRORS_CONVERSATION_SCOPE_RETENTION_SECONDS",
    "BOT_ERRORS_CONVERSATION_SCOPE_MAX_PER_KEY",
    "BOT_ERRORS_INCIDENT_COOLDOWN_SECONDS",
    "BOT_ERRORS_EMAIL_FALLBACK",
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
    assert _gate_then_deliver(mod, _event(SCOPE_A, "evt-a1", 1), state) is None
    # Chat A's own repeat dedupes into the open incident, exactly as before.
    repeat = _gate_then_deliver(mod, _event(SCOPE_A, "evt-a2", 2), state)
    assert repeat is not None and "duplicate suppressed" in repeat
    # Chat B has never been represented: it must reach the operator too.
    assert _gate_then_deliver(mod, _event(SCOPE_B, "evt-b1", 3), state) is None
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
        _gate_then_deliver(mod, _event(scope, f"evt-{scope}", i), state)
        for i, scope in enumerate((SCOPE_A, SCOPE_B), start=1)
    ]
    second_pass = [
        _gate_then_deliver(mod, _event(scope, f"evt-{scope}-again", i), state)
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
    assert _gate_then_deliver(mod, _event(SCOPE_A, "evt-a1", 1), state) is None
    repeat = _gate_then_deliver(mod, _event(SCOPE_A, "evt-a2", 2), state)
    assert repeat is not None and "cooldown active" in repeat
    # Chat B is unrepresented: cooldown must not swallow it.
    assert _gate_then_deliver(mod, _event(SCOPE_B, "evt-b1", 3), state) is None


# ---------------------------------------------------------------------------
# (b) repeated rejections in ONE conversation still dedupe
# ---------------------------------------------------------------------------

def test_repeat_rejections_in_one_conversation_still_dedupe(tmp_path):
    mod = _load(tmp_path)
    state = _open_state()
    reasons = [
        _gate_then_deliver(mod, _event(SCOPE_A, f"evt-a{i}", i), state)
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

    assert _gate_then_deliver(mod, _event(SCOPE_B, "evt-b1", 2), state) is None
    for index in range(2, 8):
        reason = _gate_then_deliver(mod, _event(SCOPE_B, f"evt-b{index}", index), state)
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
    assert _gate_then_deliver(mod, event, state) is None

    # The retry carries the ORIGINAL id, so it is already in eventIds, and a
    # delivery record that never reached "sent". That combination is what the
    # retry guarantee is about, and it is the boundary of the replay guard:
    # a non-sent status still forces, a "sent" status does not.
    event["delivery"] = {
        "attempts": 1,
        "status": "queued",
        "nextAttemptAtEpoch": 0,
        "lastError": "transport down",
    }
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
    """Neither delivered surface can render a raw identifier.

    SCOPE, corrected: this test formats the event ONCE itself and hands the
    result to two mocks it installed, so it pins the privacy property on both
    surfaces and nothing more. It does NOT pin the dispatcher's "one
    format_event call feeds both routes" invariant, which its earlier
    docstring claimed -- no dispatcher code runs here, so any implementation
    that formatted twice would pass this unchanged. Pinning that invariant
    needs the assertion driven through process_one, which the email route
    blocks under a test state dir (see
    test_the_email_delivery_branch_records_representation).
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


def test_an_untagged_scope_is_rejected_whatever_its_digits(tmp_path):
    """The tag is the whole validity test; no digest value is special-cased.

    Bare hex was ambiguous, because decimal digits are hex digits, so a raw
    conversation local part satisfied any plain hex test. That forced an
    all-decimal rejection which discarded about one genuine digest in 1,845.
    Requiring the tag removes both the ambiguity and the false rejection: a
    raw identifier never carries it, and every real digest does.
    """
    mod = _load(tmp_path)
    state = _open_state()

    untagged = [
        "a1b2c3d4e5f60718",   # a real digest, but untagged
        "1555010019900001",   # all-decimal, the case that used to need a rule
        "15550100199",        # a raw personal local part
        "15550100199443",     # a raw LID-shaped local part
    ]
    for index, value in enumerate(untagged):
        event = _event(value, f"evt-untagged-{index}", index)
        assert mod.event_conversation_scope(event) is None, f"{value!r} must not validate"
        assert value not in mod.format_event(event)
        mod.should_suppress_send(event, state)
        assert value not in json.dumps(state)

    # An all-decimal DIGEST is now perfectly valid, because the tag carries
    # the meaning. This is the case the old rule threw away.
    all_decimal_digest = _event("cs1_1234567890123456", "evt-decimal-digest", 9)
    assert mod.event_conversation_scope(all_decimal_digest) == "cs1_1234567890123456"


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

    # Go through the gate-then-record path rather than calling the predicate
    # twice. The predicate is PURE, so a second bare call re-runs the same
    # inputs and pins nothing about what delivery recorded; only the recorded
    # state makes the retry assertion load-bearing.
    first = _gate_then_deliver(mod, event, state)
    event["delivery"] = {
        "attempts": 1,
        "status": "queued",
        "nextAttemptAtEpoch": 0,
        "lastError": "transport down",
    }
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
    assert _gate_then_deliver(mod, _event(SCOPE_B, "evt-first", 1), state) is None
    later = _gate_then_deliver(mod, _event(SCOPE_B, "evt-second", 2), state)
    assert later is not None and "duplicate suppressed" in later


def test_an_event_with_no_id_falls_back_to_recording_once(tmp_path):
    """An id-less event cannot be retry-deduped; fail toward the old behaviour."""
    mod = _load(tmp_path)
    state = _open_state()
    first = _event(SCOPE_B, "", 1)
    first.pop("id", None)
    second = _event(SCOPE_B, "", 2)
    second.pop("id", None)
    assert _gate_then_deliver(mod, first, state) is None
    repeat = _gate_then_deliver(mod, second, state)
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
    # Mixed-hex fixtures, every one valid, comfortably more than the cap of 4.
    # The previous fixtures used f"{i:016x}" over 0..11, of which ten were
    # all-decimal and silently rejected, leaving two scopes against a cap of
    # four so the assertion could never fail.
    scope_values = [f"cs1_a{i:015x}" for i in range(12)]
    for index, scope in enumerate(scope_values):
        assert mod.event_conversation_scope(_event(scope, f"evt-{index}", index)) == scope
        _gate_then_deliver(mod, _event(scope, f"evt-{index}", index), state)
    scopes = state["conversationScopes"][KEY]
    # The overflow sentinel is bookkeeping, not a conversation, so the bound
    # is over TRACKED scopes.
    tracked = {k: v for k, v in scopes.items() if k != mod.CONVERSATION_SCOPE_OVERFLOW_KEY}
    assert len(tracked) <= 4
    for record in tracked.values():
        assert isinstance(record, dict)
        assert len(record.get("eventIds", {})) <= 4


# ---------------------------------------------------------------------------
# delivery lifecycle — "represented" must mean DELIVERED, not merely evaluated
# ---------------------------------------------------------------------------

def _outbox_event(mod, paths, scope: str, event_id: str) -> Path:
    """Write a real outbox event so process_one can claim and process it."""
    event = {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "warning",
        "machine": MACHINE,
        "instance": INSTANCE,
        "source": SOURCE,
        "id": event_id,
        "createdAt": mod.now_iso(),
        "summary": {"failureClass": "unknown", "length": 44, "correlationDigest": "de" * 32},
        "evidence": {"failureClass": "Error", "length": 88, "correlationDigest": "00" * 32},
        "conversationScope": scope,
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    stamp = mod.now_iso().replace(":", "").replace("-", "")
    path = paths["outbox"] / f"{stamp}.{INSTANCE}.{SOURCE}.{event_id}.json"
    path.write_text(json.dumps(event, indent=2))
    path.chmod(0o600)
    return path


def _prepare_dirs(mod, paths) -> None:
    for key in ("outbox", "processing", "sent", "suppressed", "dead_letter", "quarantine", "logs"):
        if key in paths:
            paths[key].mkdir(parents=True, exist_ok=True)


def _seed_open_incident(mod, paths) -> None:
    mod.save_incident_state(paths, _open_state())


def test_a_conversation_is_not_represented_when_delivery_dead_letters(tmp_path):
    """The whole point of the forced alert is that an operator sees it.

    An undelivered alert that still marks its conversation represented is
    worse than no gate at all: the conversation is now silent AND believed
    covered. Reproduced through the real process_one with every delivery
    route failing, so the event exhausts its attempts and dead-letters.
    """
    mod = _load(tmp_path)
    paths = mod.state_paths()
    _prepare_dirs(mod, paths)
    _seed_open_incident(mod, paths)

    mod.send_whatsapp = _raise_transport  # type: ignore[assignment]
    mod.email_fallback = lambda subject, body: False  # type: ignore[assignment]

    path = _outbox_event(mod, paths, SCOPE_B, "evt-b-forced")
    event = json.loads(path.read_text())
    event["delivery"]["attempts"] = 99
    path.write_text(json.dumps(event, indent=2))

    ok, detail = mod.process_one(path, paths)
    assert ok is False and "dead_letter" in detail

    reloaded = mod.load_incident_state(paths)
    scopes = reloaded.get("conversationScopes", {}).get(KEY, {})
    assert SCOPE_B not in scopes, (
        "the conversation was marked represented although the alert never "
        "reached an operator"
    )


def test_a_distinct_later_alert_is_still_forced_after_a_dead_letter(tmp_path):
    """The consequence of the above, stated as the operator sees it."""
    mod = _load(tmp_path)
    paths = mod.state_paths()
    _prepare_dirs(mod, paths)
    _seed_open_incident(mod, paths)

    mod.send_whatsapp = _raise_transport  # type: ignore[assignment]
    mod.email_fallback = lambda subject, body: False  # type: ignore[assignment]
    path = _outbox_event(mod, paths, SCOPE_B, "evt-b-forced")
    event = json.loads(path.read_text())
    event["delivery"]["attempts"] = 99
    path.write_text(json.dumps(event, indent=2))
    mod.process_one(path, paths)

    reloaded = mod.load_incident_state(paths)
    later = _event(SCOPE_B, "evt-b-distinct", 2)
    assert mod.should_suppress_send(later, reloaded) is None, (
        "a conversation whose only alert was lost must not be suppressed"
    )


def test_a_delivered_alert_does_mark_the_conversation_represented(tmp_path):
    """The positive control: delivery is what records representation."""
    mod = _load(tmp_path)
    paths = mod.state_paths()
    _prepare_dirs(mod, paths)
    _seed_open_incident(mod, paths)

    sent: list[str] = []
    mod.send_whatsapp = lambda text, *a, **k: sent.append(text)  # type: ignore[assignment]

    path = _outbox_event(mod, paths, SCOPE_B, "evt-b-delivered")
    ok, _ = mod.process_one(path, paths)
    assert ok is True and sent

    reloaded = mod.load_incident_state(paths)
    scopes = reloaded.get("conversationScopes", {}).get(KEY, {})
    assert SCOPE_B in scopes


def test_the_email_delivery_branch_records_representation(tmp_path):
    """Email is a real operator-visible route, so it records representation.

    Scope limit, stated rather than papered over: process_one's email branch
    cannot be driven end-to-end from a test, because
    email_fallback_blocked_reason vetoes the route whenever the state
    directory looks like a test root, returning "test_state_dir". That guard
    is deliberate and predates this change, and defeating it would mean
    faking a production-shaped state root.

    So this asserts the property that branch depends on: the delivery
    recorder marks a conversation represented. The branch's own call to it is
    covered by reading the source, not by execution, and that limit is
    disclosed in the pull request body rather than implied to be tested.
    """
    mod = _load(tmp_path)
    assert mod.email_fallback_blocked_reason(
        _event(SCOPE_B, "evt-probe", 1), state_dir=mod.state_paths()["root"]
    ) == "test_state_dir", "the veto this test documents no longer applies; drive the branch instead"

    state = _open_state()
    event = _event(SCOPE_B, "evt-emailed", 1)
    assert mod.should_suppress_send(event, state) is None

    mod.record_conversation_scope_delivered(event, state, KEY, int(time.time()))
    assert SCOPE_B in state["conversationScopes"][KEY]
    assert mod.should_suppress_send(_event(SCOPE_B, "evt-after", 2), state) is not None


def test_a_suppressed_event_id_is_not_recorded_as_forced(tmp_path):
    """The inverse error: a suppressed event must not look like a forced one.

    If suppressed ids were stored as forced, re-evaluating one after a crash
    would page an operator for an alert that was deliberately silenced.
    """
    mod = _load(tmp_path)
    state = _open_state()

    first = _event(SCOPE_B, "evt-first", 1)
    assert _gate_then_deliver(mod, first, state) is None

    suppressed = _event(SCOPE_B, "evt-suppressed", 2)
    assert _gate_then_deliver(mod, suppressed, state) is not None

    record = state["conversationScopes"][KEY][SCOPE_B]
    assert "evt-suppressed" not in record.get("eventIds", {}), (
        "a suppressed event id was recorded as though it had been forced"
    )


def test_the_predicate_does_not_mutate_state(tmp_path):
    """Evaluation is a question, not a decision.

    The predicate is consulted before anything is delivered, so it must not
    write. Recording belongs to the delivery transition.
    """
    mod = _load(tmp_path)
    state = _open_state()
    before = json.dumps(state, sort_keys=True)
    mod.conversation_scope_is_unrepresented(_event(SCOPE_B, "evt-probe", 1), state, KEY, int(time.time()))
    assert json.dumps(state, sort_keys=True) == before, "the predicate mutated incident state"


# ---------------------------------------------------------------------------
# capacity — a large incident must not become an unbounded alert loop
# ---------------------------------------------------------------------------

def test_cycling_more_conversations_than_the_cap_does_not_page_forever(tmp_path):
    """Eviction must not recycle a known conversation back into "new".

    The per-key cap drops the oldest scope. With more failing conversations
    than the cap, each one is evicted before it recurs, so every recurrence
    looks unrepresented and forces another notification — turning one large
    incident into a permanent alert loop, and defeating the storm
    consolidation that exists to stop exactly that.

    Measured before the fix: 5 conversations cycling against a cap of 4
    produced 30 forced notifications over 30 events. Bounded behaviour is one
    per conversation, then quiet.
    """
    mod = _load(tmp_path, {"BOT_ERRORS_CONVERSATION_SCOPE_MAX_PER_KEY": "4"})
    state = _open_state()
    state["flapState"] = {KEY: {"stormAt": 1, "tripTimestamps": [], "cumulativeCount": 9}}

    scopes = [f"cs1_c{i:015x}" for i in range(5)]
    forced = 0
    for cycle in range(6):
        for index, scope in enumerate(scopes):
            event = _event(scope, f"evt-{cycle}-{index}", index)
            if _gate_then_deliver(mod, event, state) is None:
                forced += 1

    assert forced <= len(scopes), (
        f"{forced} notifications for {len(scopes)} conversations over 30 events; "
        "eviction is recycling known conversations into 'new'"
    )


def test_overflow_is_recorded_so_the_condition_is_visible(tmp_path):
    """Silently capping is how the loop hid; the overflow is stated."""
    mod = _load(tmp_path, {"BOT_ERRORS_CONVERSATION_SCOPE_MAX_PER_KEY": "4"})
    state = _open_state()
    for index in range(9):
        event = _event(f"cs1_d{index:015x}", f"evt-{index}", index)
        _gate_then_deliver(mod, event, state)

    records = state["conversationScopes"][KEY]
    assert len(records) <= 4 + 1  # the cap, plus the overflow marker itself
    assert mod.CONVERSATION_SCOPE_OVERFLOW_KEY in records


def test_a_genuinely_new_conversation_still_pages_under_the_cap(tmp_path):
    """The bound must not silence conversations while there is room."""
    mod = _load(tmp_path, {"BOT_ERRORS_CONVERSATION_SCOPE_MAX_PER_KEY": "8"})
    state = _open_state()
    forced = 0
    for index in range(4):
        event = _event(f"cs1_e{index:015x}", f"evt-{index}", index)
        if _gate_then_deliver(mod, event, state) is None:
            forced += 1
    assert forced == 4


# ---------------------------------------------------------------------------
# retention — the sidecar is bounded by the state lifecycle, not by traffic
# ---------------------------------------------------------------------------

def test_expired_scope_records_are_swept_without_new_traffic(tmp_path):
    """Retention that only runs on traffic is not retention.

    A quiet or decommissioned instance would otherwise hold conversation
    digests past the window forever, because expiry only ran when another
    event for that same key entered the gate.
    """
    mod = _load(tmp_path, {"BOT_ERRORS_CONVERSATION_SCOPE_RETENTION_SECONDS": "60"})
    state = _open_state()
    state["conversationScopes"] = {
        KEY: {SCOPE_A: {"lastSeenAt": int(time.time()) - 600, "eventIds": {}}}
    }
    removed = mod.sweep_conversation_scopes(state, int(time.time()))
    assert removed >= 1
    assert "conversationScopes" not in state or KEY not in state["conversationScopes"]


def test_closing_an_incident_drops_its_scope_subtree(tmp_path):
    """A closed incident's per-conversation bookkeeping is dead weight."""
    mod = _load(tmp_path)
    state = _open_state()
    state["conversationScopes"] = {
        "unknown|instance-x|some_other_closed_source": {
            SCOPE_A: {"lastSeenAt": int(time.time()), "eventIds": {}}
        }
    }
    mod.sweep_conversation_scopes(state, int(time.time()))
    assert "unknown|instance-x|some_other_closed_source" not in state.get(
        "conversationScopes", {}
    )


def test_the_outer_key_cap_is_enforced(tmp_path):
    """A long tail of historical keys cannot grow the map without limit."""
    mod = _load(tmp_path, {"BOT_ERRORS_CONVERSATION_SCOPE_MAX_KEYS": "3"})
    now = int(time.time())
    state = _open_state()
    # All keys open, so only the outer cap can bound them.
    for index in range(9):
        key = f"unknown|instance-x|source_{index}"
        state["openIncidents"][key] = {"status": "open", "openedAt": now}
        state.setdefault("conversationScopes", {})[key] = {
            SCOPE_A: {"lastSeenAt": now - index, "eventIds": {}}
        }
    mod.sweep_conversation_scopes(state, now)
    assert len(state["conversationScopes"]) <= 3


def test_the_sweep_runs_on_save(tmp_path):
    """Wired into the lifecycle, not merely available."""
    mod = _load(tmp_path, {"BOT_ERRORS_CONVERSATION_SCOPE_RETENTION_SECONDS": "60"})
    paths = mod.state_paths()
    paths["incident_state"].parent.mkdir(parents=True, exist_ok=True)
    state = _open_state()
    state["conversationScopes"] = {
        KEY: {SCOPE_A: {"lastSeenAt": int(time.time()) - 600, "eventIds": {}}}
    }
    mod.save_incident_state(paths, state)
    reloaded = mod.load_incident_state(paths)
    assert SCOPE_A not in reloaded.get("conversationScopes", {}).get(KEY, {})


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
    assert _gate_then_deliver(mod, _event(SCOPE_B, "evt-b1", 2), state) is None
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
    # Mixed-hex, every value valid, well past the cap of 4. The previous
    # fixtures were f"{i:016x}" over 0..11: ten were all-decimal and silently
    # rejected, so only two scopes ever reached the cap assertion.
    scope_values = [f"cs1_b{i:015x}" for i in range(12)]
    for index, scope in enumerate(scope_values):
        assert mod.event_conversation_scope(_event(scope, f"evt-{index}", index)) == scope
        _gate_then_deliver(mod, _event(scope, f"evt-{index}", index), state)
    tracked = {
        k: v
        for k, v in state["conversationScopes"][KEY].items()
        if k != mod.CONVERSATION_SCOPE_OVERFLOW_KEY
    }
    assert len(tracked) <= 4

    # Retention: an entry older than the window is pruned, so that
    # conversation is "new" again and re-notifies.
    state["conversationScopes"] = {
        KEY: {SCOPE_B: {"lastSeenAt": int(time.time()) - 600, "eventIds": {}}}
    }
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


def test_a_malformed_overflow_counter_does_not_break_post_delivery_bookkeeping(tmp_path):
    """codex LOW-8: a non-numeric overflowCount must not raise out of bookkeeping.

    mark_incident_sent runs at try-depth 0 in process_one, AFTER send_whatsapp
    has already paged the operator and BEFORE incident.commit(). A raise there
    leaves the claimed file in processing/ with the scope unrecorded, so the
    next cycle reclaims it, still finds the conversation unrepresented, pages
    again and raises again. That is an unbounded page loop, not one duplicate.
    The module's own defensive integer helper (int_field, used 41 times) exists
    for exactly this; the raw int() on the overflow counter was a pattern fork.
    """
    mod = _load(tmp_path, {"BOT_ERRORS_CONVERSATION_SCOPE_MAX_PER_KEY": "2"})
    now = int(time.time())
    event = _event(SCOPE_A, "evt-overflow-malformed", 41)
    key = mod.incident_key(event)
    state = {
        "version": 1,
        "openIncidents": {key: {"status": "open"}},
        "lastSentAt": {},
        "conversationScopes": {
            key: {
                "cs1_00000000000000aa": {"lastSeenAt": now, "eventIds": {}},
                "cs1_00000000000000bb": {"lastSeenAt": now, "eventIds": {}},
                "cs1_00000000000000cc": {"lastSeenAt": now, "eventIds": {}},
                mod.CONVERSATION_SCOPE_OVERFLOW_KEY: {
                    "eventIds": {},
                    "overflowedAt": now,
                    "lastSeenAt": now,
                    "overflowCount": "corrupt",
                },
            }
        },
    }

    mod.mark_incident_sent(event, state)

    overflow = state["conversationScopes"][key][mod.CONVERSATION_SCOPE_OVERFLOW_KEY]
    # The malformed value is treated as 0 and the increment still lands, so the
    # predicate keeps its "this key overflowed" signal instead of losing it.
    assert overflow["overflowCount"] == 1


# ---------------------------------------------------------------------------
# (g) the crash window between the state commit and the archive rename
# ---------------------------------------------------------------------------

def _sent_delivery() -> dict:
    """The delivery record process_one writes BEFORE it archives the file."""
    return {"attempts": 1, "status": "sent", "nextAttemptAtEpoch": 0, "lastError": None}


def test_a_delivered_event_replayed_after_a_crash_is_not_paged_again(tmp_path):
    """codex MED-1: the crash window re-pages an event already delivered.

    process_one publishes the sent record into the processing file and commits
    incident state, THEN os.replace()s the file into sent/. A crash in that
    window leaves a file in processing/ whose delivery.status is already
    "sent". reclaim_processing bounces it back to the outbox and ready()
    accepts it, so the gate sees the SAME delivered event again and forces a
    second page for a conversation an operator has already been shown.
    """
    mod = _load(tmp_path)
    state = _open_state()
    event = _event(SCOPE_B, "evt-delivered-then-crashed", 11)
    assert _gate_then_deliver(mod, event, state) is None

    event["delivery"] = _sent_delivery()
    reason = mod.should_suppress_send(event, state)

    assert reason is not None, "an already-delivered event must not be paged again"


def test_a_delivered_event_replayed_into_an_open_storm_does_not_escape(tmp_path):
    """ocwx HIGH-2: the storm-branch instance of the same replay.

    The narrow storm exception exists for the FIRST sighting of a conversation
    nobody has been told about. An event whose delivery already succeeded is
    not that, so it must stay consolidated as a storm member.
    """
    mod = _load(tmp_path)
    state = _open_state()
    state["flapState"] = {KEY: {"stormAt": 1, "tripTimestamps": [], "cumulativeCount": 5}}
    event = _event(SCOPE_B, "evt-storm-delivered", 12)
    assert _gate_then_deliver(mod, event, state) is None

    event["delivery"] = _sent_delivery()
    reason = mod.should_suppress_send(event, state)

    assert reason is not None and "flap_storm_member" in reason


def test_control_the_same_replay_is_a_duplicate_when_the_scope_gate_is_off(tmp_path):
    """CONTROL: the re-page belongs to this gate, not to the deployer.

    With BOT_ERRORS_CONVERSATION_SCOPED_SOURCES empty — the rollback the
    configuration table documents — the identical replay is suppressed as an
    ordinary duplicate. This leg passes both before and after the fix; it is
    here to prove the defect is this branch's and not a pre-existing property
    of the reclaim path.
    """
    mod = _load(tmp_path, {"BOT_ERRORS_CONVERSATION_SCOPED_SOURCES": ""})
    state = _open_state()
    event = _event(SCOPE_B, "evt-delivered-gate-off", 13)
    event["delivery"] = _sent_delivery()

    reason = mod.should_suppress_send(event, state)

    assert reason is not None and "duplicate suppressed" in reason
