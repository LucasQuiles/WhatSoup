"""A held ambiguous delivery must get louder once it outlives the bound (#2424).

hold_ambiguous_send parks a send whose outcome cannot be proven and emits ONE
bounded metadata-only signal. Nothing then bounds the hold: reclaim_processing
skips every held record through is_held_delivery, no age predicate exists, and
the queue signals do not distinguish a held item from a backlog. The operator
is paged by a critical queue alarm that stays critical until a human acts, and
nothing in the log ever says the hold itself has gone stale.

This suite owns the bound. It does NOT change the disposition: the item stays
held, in processing/, at the same status, never re-sent, never dead-lettered,
never auto-disposed. The only new behaviour is a second, louder, once-only
signal at the threshold.

The threshold is the dispatcher's own stale-incident clock, reused rather than
reinvented, so the hold ages out on the same schedule as every other stale
condition this dispatcher already reports.

The load-bearing assertions are the second pass and the negative control.
A single-pass test would pass against an implementation that re-signals every
cycle, which would turn one stuck alarm into an unbounded log storm; a test
without the young-record control would pass against an implementation that
escalates unconditionally, which would defeat the bound entirely.
"""

from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path
from unittest.mock import patch

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

SOURCE = "agent_turn_admission_rejected"
INSTANCE = "instance-x"
MACHINE = "unknown"
SCOPE = "cs1_a1b2c3d4e5f60718"
EVENT_ID = "evt-2424-d0-held"
# Two records in one processing/ directory need two names: _seed_processing
# builds the filename from the id, so a shared id would silently seed one file.
UNEXPIRED_EVENT_ID = "evt-2424-d0-unexpired"
ESCALATED_EVENT_ID = "evt-2424-d0-escalated"

HELD_STATUS = "outcome_unknown"

# Durable delivery fields the hold already writes. Named as literals rather
# than read off the module so a rename shows up here as a failed assertion
# about the record on disk, not as a silently renamed test.
HELD_AT_FIELD = "outcomeUnknownAt"
HELD_REASON_FIELD = "outcomeUnknownReason"
HELD_SIGNAL_FIELD = "outcomeUnknownSignalledAt"

# The second, once-only stamp this leaf adds beside the first.
HELD_ESCALATED_FIELD = "outcomeUnknownEscalatedAt"

# The first signal, already emitted at warning level when the hold is taken.
HELD_SIGNAL_KIND = "delivery_outcome_unknown_held"
# The louder one, emitted once when the hold outlives the threshold.
HELD_ESCALATION_KIND = "delivery_outcome_unknown_escalated"
# Louder means a higher controller level, not a second copy of the same line.
# The requirement is RELATIVE, so both ends are pinned: the first-signal level
# is asserted against the production hold path in its own test below, and the
# escalation is asserted to outrank it. Pinning only the escalation would stay
# green if someone raised the first signal to match it.
FIRST_SIGNAL_LEVEL = "warning"
ESCALATION_LEVEL = "error"
LEVEL_RANK = {"debug": 0, "info": 1, "warning": 2, "error": 3}

# The write-ahead marker that makes a "sending" record ambiguous rather than
# never-issued. A record carrying it is what the first hold acts on.
SEND_ISSUED_FIELD = "sendIssuedAt"
IN_FLIGHT_STATUS = "sending"
STALE_ISSUED_AT_UTC = "2026-09-01T00:00:00Z"
# A hold instant with no zone. It parses, so it gets past a try/except, and it
# would be read against host-local time.
NAIVE_HELD_AT = "2026-09-01T00:00:00"

# The signal must stay content-free: bounded counts and booleans only. Any key
# outside this set is a new disclosure channel and has to be argued for.
ESCALATION_DETAIL_KEYS = frozenset({"attempts", "held"})

# A stamp far enough past the bound that no plausible clock skew puts the
# record back inside it, and far enough inside it for the negative control.
THRESHOLD_MARGIN_SECONDS = 3600

SEEDED_ATTEMPTS = 1
STALE_ISSUED_AT = "2026-09-01T00:00:00Z"
HOLD_REASON = "restart found an issued send with no recorded outcome"

# Two reclaim passes over one unchanged on-disk state. The second pass is the
# restart: it reads the record the first pass published.
RECLAIM_PASSES = 2
ESCALATIONS_EXPECTED_ONCE = 1
NO_ESCALATIONS = 0
NO_SENDS = 0

ONE_SEND = 1

# The status the documented release procedure restores before moving the file
# back to outbox/. The runbook says status is the only field to edit, so every
# other field the hold wrote survives into the record's next life.
RELEASED_STATUS = "queued"

# A hold instant with a fixed, known epoch. The boundary case is asserted
# against an age computed from THIS stamp rather than from the wall clock: a
# wall-clock stamp lands on the threshold or one second past it depending on
# whether a second ticks mid-test, and that second is the whole distinction.
BOUNDARY_HELD_AT = "2026-09-01T00:00:00Z"
ONE_SECOND = 1

# The typed outcome that makes a send unprovable. Classification is by type and
# phase, never by message text, so only the real exception reaches the hold.
POST_REQUEST_PHASE = "phase=post_request"
AMBIGUOUS_SEND_MESSAGE = "no reply arrived after the request left"

# The single durable publication site for a held record's state; the escalation
# rides the same component as the first hold, which is why the injected failure
# below is keyed on it.
HELD_PUBLICATION_COMPONENT = "dispatcher.process_held_state"
INJECTED_PUBLICATION_FAILURE = "injected escalation publication failure"
ESCALATION_PUBLICATION_FAILED_KIND = "delivery_escalation_publication_failed"
ESCALATION_FAILURES_EXPECTED_ONCE = 1
# The disclosed cost of appending the log line BEFORE the publication, already
# carried by the first-signal path: a publication that never reached disk left
# no stamp, so the retry re-appends the line. One duplicate LINE per retried
# escalation, never a second escalation on the durable record.
RETRIED_ESCALATION_SIGNALS = 2

# An incident already open, with no conversation recorded, so a released record
# put back in outbox/ is genuinely due for a send rather than suppressed.
INCIDENT_OPENED_AGO_SECONDS = 600
INCIDENT_LAST_SENT_AGO_SECONDS = 60

RELEASED_EVENT_ID = "evt-2424-d0-released"
GUARD_EVENT_ID = "evt-2424-d0-guard"
BOUNDARY_EVENT_ID = "evt-2424-d0-boundary"
# Sorted AFTER EVENT_ID, because reclaim_processing walks processing/ in sorted
# order and the containment case needs the FAILING record handled first.
COMPANION_EVENT_ID = "evt-2424-d0-other"

_ENV_KEYS = ["BOT_ERRORS_STATE_DIR", "BOT_ERRORS_CONVERSATION_SCOPED_SOURCES"]


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


def _load(state_dir: Path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location(
        f"bot_errors_dispatcher_held_age_{state_dir.name}", _SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _iso_seconds_ago(seconds: int) -> str:
    """A canonical UTC stamp in the past, relative to the running clock.

    Derived from the clock rather than hard-coded, so the age these tests
    assert on cannot drift into or out of the bound as the calendar moves.
    """
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - seconds))


def _held_event(held_at: str, event_id: str = EVENT_ID, **delivery: object) -> dict:
    """A record already parked by hold_ambiguous_send, with its first signal spent."""
    record = {
        "attempts": SEEDED_ATTEMPTS,
        "status": HELD_STATUS,
        "nextAttemptAtEpoch": 0,
        "lastError": None,
        "sendIssuedAt": STALE_ISSUED_AT,
        HELD_AT_FIELD: held_at,
        HELD_REASON_FIELD: HOLD_REASON,
        HELD_SIGNAL_FIELD: held_at,
    }
    record.update(delivery)
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
        "delivery": record,
    }


def _seed_processing(paths, event: dict) -> Path:
    claimed = paths["processing"] / (
        f"20260902.{INSTANCE}.{SOURCE}.{event['id']}.json.999.processing"
    )
    claimed.write_text(json.dumps(event, indent=2))
    claimed.chmod(0o600)
    return claimed


def _cycle(mod, paths) -> list:
    """reclaim -> ready -> process_one, exactly as run_once sequences it.

    The sender spy is the honest count of remote sends: a bound that released
    the record would show up here as a send, not merely as a moved file.
    """
    mod.reclaim_processing(paths)
    calls: list = []

    def _spy(*args, **kwargs):
        calls.append(args)

    with patch.object(mod, "send_whatsapp", side_effect=_spy):
        for queued in sorted(paths["outbox"].glob("*.json")):
            if mod.ready(queued, paths["quarantine"]):
                mod.process_one(queued, paths)
    return calls


def _processing_records(paths) -> list[dict]:
    records = []
    for path in sorted(paths["processing"].glob("*")):
        try:
            records.append(json.loads(path.read_text()))
        except ValueError:
            continue
    return records


def _delivery_of(record: dict) -> dict:
    delivery = record.get("delivery")
    return delivery if isinstance(delivery, dict) else {}


def _record_kind(record: dict) -> str:
    for key in ("kind", "recordKind", "type"):
        value = record.get(key)
        if isinstance(value, str):
            return value
    return ""


def _log_lines(paths) -> list[str]:
    log_path = paths["logs"] / "dispatch.jsonl"
    if not log_path.exists():
        return []
    return [line for line in log_path.read_text().splitlines() if line.strip()]


def _signals_of_kind(paths, kind: str) -> list[dict]:
    signals = []
    for line in _log_lines(paths):
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict) and _record_kind(record) == kind:
            signals.append(record)
    return signals


# --------------------------------------------------------------------------
# The bound: a hold that outlives the stale-incident clock gets louder, once.
# --------------------------------------------------------------------------


def test_a_hold_older_than_the_threshold_escalates_exactly_once(tmp_path):
    """Two passes over one unchanged record produce ONE louder signal.

    The second pass is the restart. The stamp committed by the first pass is
    the only thing that stops it, which is why the assertion is on the count
    across both passes rather than on the first pass alone.
    """
    mod = _load(tmp_path / "held-aged-out")
    paths = mod.setup_dirs()
    threshold = mod.INCIDENT_STALE_SECONDS
    held_at = _iso_seconds_ago(threshold + THRESHOLD_MARGIN_SECONDS)
    claimed = _seed_processing(paths, _held_event(held_at))

    sends: list = []
    for _ in range(RECLAIM_PASSES):
        sends.extend(_cycle(mod, paths))

    escalations = _signals_of_kind(paths, HELD_ESCALATION_KIND)
    assert len(escalations) == ESCALATIONS_EXPECTED_ONCE, (
        f"a hold past the {threshold}s bound must escalate exactly once across "
        f"{RECLAIM_PASSES} passes, saw {len(escalations)}"
    )
    assert escalations[0].get("level") == ESCALATION_LEVEL, (
        "the escalation must be LOUDER than the first signal, which is "
        f"{FIRST_SIGNAL_LEVEL}"
    )
    assert LEVEL_RANK[ESCALATION_LEVEL] > LEVEL_RANK[FIRST_SIGNAL_LEVEL], (
        "louder is a relative requirement: the escalation level must outrank "
        "the first-signal level, which the sibling test pins to production"
    )
    assert len(sends) == NO_SENDS, "an escalated hold must never be re-sent"


def test_the_alias_is_the_stale_incident_constant_not_a_second_knob(tmp_path):
    """The threshold is the existing clock reused, asserted directly.

    Every other test derives its stamps from INCIDENT_STALE_SECONDS, so an
    alias that drifted to a different value would be caught in one direction
    only. The manifest marker pins the alias NAME; this pins its value.
    """
    mod = _load(tmp_path / "held-alias")
    assert mod.HELD_DELIVERY_ESCALATE_SECONDS == mod.INCIDENT_STALE_SECONDS, (
        "HELD_DELIVERY_ESCALATE_SECONDS must be the stale-incident constant, "
        "not an independently defaulted second threshold"
    )


def test_a_first_hold_still_stamps_its_instant_reason_and_level(tmp_path):
    """The production hold path is unchanged by the escalation branch.

    hold_ambiguous_send now skips mark_outcome_unknown for a record that is
    already held. Every real caller passes a record at status "sending", so the
    gate must be inert for them: the hold instant, the redacted reason and the
    first-signal level all have to survive. This also pins FIRST_SIGNAL_LEVEL to
    what production actually emits, which is what makes "louder" relative.
    """
    mod = _load(tmp_path / "held-first-hold")
    paths = mod.setup_dirs()
    event = _held_event(_iso_seconds_ago(0), EVENT_ID)
    # Back to the state the send path leaves behind: issued, outcome unknown,
    # none of the hold fields written yet.
    event["delivery"]["status"] = IN_FLIGHT_STATUS
    event["delivery"][SEND_ISSUED_FIELD] = STALE_ISSUED_AT_UTC
    for field in (HELD_AT_FIELD, HELD_REASON_FIELD, HELD_SIGNAL_FIELD):
        event["delivery"].pop(field, None)
    _seed_processing(paths, event)

    _cycle(mod, paths)

    records = _processing_records(paths)
    assert len(records) == 1
    delivery = _delivery_of(records[0])
    assert delivery.get("status") == HELD_STATUS, "the record must be held"
    assert delivery.get(HELD_AT_FIELD), "the first hold must stamp its instant"
    assert delivery.get(HELD_REASON_FIELD), "the first hold must stamp its reason"
    assert delivery.get(HELD_SIGNAL_FIELD), "the first hold must stamp its signal"
    assert not delivery.get(HELD_ESCALATED_FIELD), (
        "a hold taken now is inside the bound and must not escalate in the same pass"
    )
    first_signals = _signals_of_kind(paths, HELD_SIGNAL_KIND)
    assert len(first_signals) == ESCALATIONS_EXPECTED_ONCE
    assert first_signals[0].get("level") == FIRST_SIGNAL_LEVEL, (
        "the first signal's level is the baseline the escalation must exceed"
    )


def test_an_escalated_hold_stays_held_in_place(tmp_path):
    """Escalation changes the signal, never the disposition.

    Status, location and the hold instant are all asserted: an implementation
    that re-derived the hold through mark_outcome_unknown would rewrite the age
    basis and quietly reset the bound it was supposed to enforce.
    """
    mod = _load(tmp_path / "held-stays-held")
    paths = mod.setup_dirs()
    threshold = mod.INCIDENT_STALE_SECONDS
    held_at = _iso_seconds_ago(threshold + THRESHOLD_MARGIN_SECONDS)
    _seed_processing(paths, _held_event(held_at))

    _cycle(mod, paths)

    records = _processing_records(paths)
    assert len(records) == 1, "the held record must stay in processing/"
    delivery = _delivery_of(records[0])
    assert delivery.get("status") == HELD_STATUS, "the record must stay held"
    assert delivery.get(HELD_AT_FIELD) == held_at, (
        "the age basis must not be rewritten by the escalation"
    )
    assert delivery.get(HELD_SIGNAL_FIELD) == held_at, (
        "the first-signal stamp must not be rewritten by the escalation"
    )
    assert delivery.get(HELD_ESCALATED_FIELD), (
        "the escalation must commit its own durable once-only stamp"
    )
    assert not list(paths["outbox"].glob("*.json")), (
        "an escalated hold must not be returned to the outbox"
    )


def test_the_escalation_signal_is_content_free(tmp_path):
    """No body, no identifiers: bounded counts and booleans only."""
    mod = _load(tmp_path / "held-content-free")
    paths = mod.setup_dirs()
    threshold = mod.INCIDENT_STALE_SECONDS
    held_at = _iso_seconds_ago(threshold + THRESHOLD_MARGIN_SECONDS)
    _seed_processing(paths, _held_event(held_at))

    _cycle(mod, paths)

    escalations = _signals_of_kind(paths, HELD_ESCALATION_KIND)
    assert len(escalations) == ESCALATIONS_EXPECTED_ONCE
    details = escalations[0].get("details")
    assert isinstance(details, dict), "the escalation must carry bounded details"
    # Exact, not a subset: a subset check also passes on an empty dict, so a
    # change that projected every field away would read as content-free while
    # actually being content-LESS, and the operator would lose the attempt count.
    assert set(details) == ESCALATION_DETAIL_KEYS, (
        f"escalation detail keys must be exactly {sorted(ESCALATION_DETAIL_KEYS)}, "
        f"saw {sorted(details)}"
    )
    for line in _log_lines(paths):
        assert EVENT_ID not in line, "no event identifier may reach the dispatch log"
        assert HOLD_REASON not in line, "no free-text hold reason may reach the log"


# --------------------------------------------------------------------------
# Negative control: the bound must actually bind.
# --------------------------------------------------------------------------


def test_a_hold_younger_than_the_threshold_does_not_escalate(tmp_path):
    """Inside the bound, nothing louder is emitted and no stamp is written.

    Without this control an implementation that escalated every held record on
    sight would pass the suite while destroying the bound.
    """
    mod = _load(tmp_path / "held-still-young")
    paths = mod.setup_dirs()
    threshold = mod.INCIDENT_STALE_SECONDS
    held_at = _iso_seconds_ago(max(threshold - THRESHOLD_MARGIN_SECONDS, 0))
    _seed_processing(paths, _held_event(held_at))

    sends = _cycle(mod, paths)

    escalations = _signals_of_kind(paths, HELD_ESCALATION_KIND)
    assert len(escalations) == NO_ESCALATIONS, (
        f"a hold inside the {threshold}s bound must not escalate"
    )
    records = _processing_records(paths)
    assert len(records) == 1
    assert not _delivery_of(records[0]).get(HELD_ESCALATED_FIELD), (
        "no escalation stamp may be written inside the bound"
    )
    assert len(sends) == NO_SENDS


# --------------------------------------------------------------------------
# Idempotency: an already-escalated hold is silent forever after.
# --------------------------------------------------------------------------


def test_an_already_escalated_hold_does_not_escalate_again(tmp_path):
    """The stamp on disk is the authority, including across a restart."""
    mod = _load(tmp_path / "held-already-escalated")
    paths = mod.setup_dirs()
    threshold = mod.INCIDENT_STALE_SECONDS
    held_at = _iso_seconds_ago(threshold + THRESHOLD_MARGIN_SECONDS)
    already = _iso_seconds_ago(THRESHOLD_MARGIN_SECONDS)
    _seed_processing(paths, _held_event(held_at, **{HELD_ESCALATED_FIELD: already}))

    for _ in range(RECLAIM_PASSES):
        _cycle(mod, paths)

    escalations = _signals_of_kind(paths, HELD_ESCALATION_KIND)
    assert len(escalations) == NO_ESCALATIONS, (
        "a hold carrying an escalation stamp must never signal again"
    )
    records = _processing_records(paths)
    assert len(records) == 1
    assert _delivery_of(records[0]).get(HELD_ESCALATED_FIELD) == already, (
        "the existing escalation stamp must not be rewritten"
    )


def test_a_quiet_pass_over_a_held_record_publishes_nothing(tmp_path):
    """A parked record must not burn a durable generation on every cycle.

    The bound puts held records back inside a function that publishes. If a
    pass that changes nothing still published, one hold would rewrite its own
    durable record every cycle for as long as it stayed parked -- unbounded
    write amplification on the queue this issue exists to keep quiet. Asserted
    on the publisher itself, because the record's CONTENT is identical either
    way and a byte comparison would pass against the defect.
    """
    mod = _load(tmp_path / "held-quiet-pass")
    paths = mod.setup_dirs()
    threshold = mod.INCIDENT_STALE_SECONDS
    inside_the_bound = _iso_seconds_ago(max(threshold - THRESHOLD_MARGIN_SECONDS, 0))
    already = _iso_seconds_ago(THRESHOLD_MARGIN_SECONDS)
    _seed_processing(paths, _held_event(inside_the_bound, UNEXPIRED_EVENT_ID))
    _seed_processing(
        paths,
        _held_event(
            _iso_seconds_ago(threshold + THRESHOLD_MARGIN_SECONDS),
            ESCALATED_EVENT_ID,
            **{HELD_ESCALATED_FIELD: already},
        ),
    )

    publications: list = []
    real_publish = mod.publish_state_json

    def _counting_publish(*args, **kwargs):
        publications.append(kwargs.get("component"))
        return real_publish(*args, **kwargs)

    with patch.object(mod, "publish_state_json", side_effect=_counting_publish):
        for _ in range(RECLAIM_PASSES):
            mod.reclaim_processing(paths)

    assert publications == [], (
        "a reclaim pass that changes nothing must not republish a held record, "
        f"saw {len(publications)} publication(s)"
    )


def test_an_unparseable_hold_instant_does_not_escalate(tmp_path):
    """No age basis, no bound: the record stays held and silent, never wedged.

    Fail-closed in the direction that cannot make #2424 worse. A malformed
    stamp must not raise out of reclaim_processing either, because a raise
    there strands every other stranded alert behind it.
    """
    mod = _load(tmp_path / "held-unparseable")
    paths = mod.setup_dirs()
    _seed_processing(paths, _held_event("not-a-timestamp"))

    sends = _cycle(mod, paths)

    assert len(_signals_of_kind(paths, HELD_ESCALATION_KIND)) == NO_ESCALATIONS
    records = _processing_records(paths)
    assert len(records) == 1
    assert _delivery_of(records[0]).get("status") == HELD_STATUS
    assert len(sends) == NO_SENDS


def test_a_zoneless_hold_instant_does_not_escalate(tmp_path):
    """A naive stamp parses but has no zone, so it is not an age basis.

    Read against host-local time it would shift the bound by the UTC offset,
    firing hours early or late on any host that is not on UTC. A try/except
    alone does not catch this: the value parses cleanly.
    """
    mod = _load(tmp_path / "held-zoneless")
    paths = mod.setup_dirs()
    _seed_processing(paths, _held_event(NAIVE_HELD_AT))

    _cycle(mod, paths)

    assert len(_signals_of_kind(paths, HELD_ESCALATION_KIND)) == NO_ESCALATIONS
    records = _processing_records(paths)
    assert len(records) == 1
    assert not _delivery_of(records[0]).get(HELD_ESCALATED_FIELD)


# --------------------------------------------------------------------------
# A SECOND hold is a second bound: the release round trip.
# --------------------------------------------------------------------------


def _open_incident(mod, paths, event: dict) -> None:
    """An open incident with no conversation recorded: the send is due.

    Without it a released record put back in outbox/ can be suppressed instead
    of sent, and the test would fail on scaffolding rather than on the bound.
    """
    key = mod.incident_key(event)
    now = int(time.time())
    mod.save_incident_state(paths, {
        "version": 1,
        "openIncidents": {key: {"status": "open", "openedAt": now - INCIDENT_OPENED_AGO_SECONDS}},
        "lastSentAt": {key: now - INCIDENT_LAST_SENT_AGO_SECONDS},
        "conversationScopes": {},
    })


def _single_processing_path(mod, paths) -> Path:
    """The one claimed record in processing/, ignoring the durable-write lock.

    Selected with the dispatcher's own entry predicate, which is what
    reclaim_processing walks with, so this helper and production agree on what
    counts as a record.
    """
    claimed = sorted(
        path for path in paths["processing"].glob("*") if mod.safe_is_data_entry(path)
    )
    assert len(claimed) == 1, f"expected exactly one claimed file: {claimed!r}"
    return claimed[0]


def _release_to_outbox(mod, paths, claimed: Path) -> Path:
    """The release the runbook documents, and nothing beyond it.

    README-bot-errors.md: set delivery.status back to "queued", move the file
    into outbox/ under its original name, and status is the only field to
    edit. Every stamp the hold wrote therefore survives, which is what makes
    the dispatcher, not the operator, responsible for resetting them.
    """
    record = json.loads(claimed.read_text())
    record["delivery"]["status"] = RELEASED_STATUS
    target = paths["outbox"] / mod.original_name_from_processing(claimed)
    target.write_text(json.dumps(record, indent=2))
    target.chmod(0o600)
    claimed.unlink()
    return target


def _ambiguous_send_cycle(mod, paths) -> list:
    """One cycle whose send leaves the outcome unproven, as production does.

    Spelled out here rather than parameterised into the shared _cycle helper:
    this is the only case in this file that needs the send to raise, and every
    other test depends on _cycle being the honest zero-send count.
    """
    mod.reclaim_processing(paths)
    calls: list = []

    def _spy(*args, **kwargs):
        calls.append(args)
        raise mod.AmbiguousSendOutcome(AMBIGUOUS_SEND_MESSAGE, phase=POST_REQUEST_PHASE)

    with patch.object(mod, "send_whatsapp", side_effect=_spy):
        for queued in sorted(paths["outbox"].glob("*.json")):
            if mod.ready(queued, paths["quarantine"]):
                mod.process_one(queued, paths)
    return calls


def _age_hold_on_disk(claimed: Path, seconds: int) -> None:
    """Stand in for `seconds` of wall clock passing over a parked record.

    Only the age basis moves. Everything the dispatcher published, including
    whatever stamps it wrote, is left exactly as it wrote it.
    """
    record = json.loads(claimed.read_text())
    record["delivery"][HELD_AT_FIELD] = _iso_seconds_ago(seconds)
    claimed.write_text(json.dumps(record, indent=2))


def test_a_re_held_record_escalates_again_after_an_operator_release(tmp_path):
    """A NEW hold gets a new bound, not a spent one.

    The once-only stamp is once per HOLD, not once per record forever.
    mark_outcome_unknown rewrites the age basis on every new hold, so a record
    an operator released and the transport held again starts a fresh clock. If
    the previous hold's escalation stamp survives that rewrite, the age
    predicate returns False for the rest of the record's life: it can then sit
    held and silent forever, which is the condition the bound exists to end,
    and it is unreachable for exactly the population most likely to go
    ambiguous twice.

    Every step is a production entry point or the documented operator
    procedure. The release edits delivery.status and nothing else.
    """
    mod = _load(tmp_path / "held-re-held")
    paths = mod.setup_dirs()
    threshold = mod.INCIDENT_STALE_SECONDS
    aged = _iso_seconds_ago(threshold + THRESHOLD_MARGIN_SECONDS)
    event = _held_event(aged, RELEASED_EVENT_ID)
    _open_incident(mod, paths, event)
    _seed_processing(paths, event)

    # 1. The first hold outlives the bound and escalates once.
    _cycle(mod, paths)
    first_round = len(_signals_of_kind(paths, HELD_ESCALATION_KIND))
    assert first_round == ESCALATIONS_EXPECTED_ONCE, (
        f"the first hold must escalate once before it is released, saw {first_round}"
    )
    first_hold_at = _delivery_of(_processing_records(paths)[0]).get(HELD_AT_FIELD)

    # 2. The operator releases it, exactly as the runbook says.
    _release_to_outbox(mod, paths, _single_processing_path(mod, paths))

    # 3. The send goes ambiguous again, so production takes a SECOND hold.
    sends = _ambiguous_send_cycle(mod, paths)
    assert len(sends) == ONE_SEND, (
        f"the released record must reach the send path once, saw {len(sends)}"
    )
    second = _delivery_of(_processing_records(paths)[0])
    assert second.get("status") == HELD_STATUS, (
        f"the released record must be held again, not requeued: {second!r}"
    )
    assert second.get(HELD_AT_FIELD) and second.get(HELD_AT_FIELD) != first_hold_at, (
        "the second hold must stamp a NEW age basis, otherwise the assertions "
        f"below are not about a new hold at all: {second.get(HELD_AT_FIELD)!r}"
    )
    assert not second.get(HELD_ESCALATED_FIELD), (
        "a new hold restarts the clock, so the previous hold's escalation stamp "
        "must not survive it: a stamp that does disables the bound for this "
        f"record permanently, saw {second.get(HELD_ESCALATED_FIELD)!r}"
    )

    # 4. The new hold outlives the bound in its turn, and says so once.
    _age_hold_on_disk(
        _single_processing_path(mod, paths), threshold + THRESHOLD_MARGIN_SECONDS
    )
    for _ in range(RECLAIM_PASSES):
        mod.reclaim_processing(paths)

    second_round = len(_signals_of_kind(paths, HELD_ESCALATION_KIND)) - first_round
    assert second_round == ESCALATIONS_EXPECTED_ONCE, (
        f"the second hold must escalate exactly once across {RECLAIM_PASSES} "
        f"passes, saw {second_round}"
    )
    final = _delivery_of(_processing_records(paths)[0])
    assert final.get("status") == HELD_STATUS, (
        f"the re-escalated record still stays held in place: {final!r}"
    )


# --------------------------------------------------------------------------
# The escalation's own failure branch, its guard, and the boundary second.
# --------------------------------------------------------------------------


def _failing_publication(mod, component: str):
    """Fail exactly one durable publication, leaving every other one real."""
    original = mod.publish_state_json

    def _publish(*args, **kwargs):
        if kwargs.get("component") == component:
            raise RuntimeError(INJECTED_PUBLICATION_FAILURE)
        return original(*args, **kwargs)

    return patch.object(mod, "publish_state_json", side_effect=_publish)


def test_a_failing_escalation_publication_is_contained_and_retried(tmp_path):
    """One record whose escalation cannot be published must not strand the rest.

    run_once calls reclaim_processing bare, so a raise here aborts the whole
    cycle -- and every later cycle, because the record that raises is still
    parked. The containment, the line that announces it and the absence of a
    stamp are all pinned here: without a test, a later edit can delete the log
    line for free and a failed escalation becomes silent, or stamp the record
    anyway and lose the escalation entirely.
    """
    mod = _load(tmp_path / "held-escalation-publication-fails")
    paths = mod.setup_dirs()
    threshold = mod.INCIDENT_STALE_SECONDS
    aged = _iso_seconds_ago(threshold + THRESHOLD_MARGIN_SECONDS)
    _seed_processing(paths, _held_event(aged))
    # An ordinary claimed record, parked behind the failing one in sorted order.
    companion = _held_event(aged, COMPANION_EVENT_ID)
    companion["delivery"]["status"] = RELEASED_STATUS
    companion["delivery"].pop(SEND_ISSUED_FIELD, None)
    companion_claimed = _seed_processing(paths, companion)

    with _failing_publication(mod, HELD_PUBLICATION_COMPONENT):
        mod.reclaim_processing(paths)

    assert not companion_claimed.exists(), (
        "the pass must not stop at the record whose escalation failed"
    )
    reclaimed = sorted(p.name for p in paths["outbox"].glob("*.json"))
    assert len(reclaimed) == ONE_SEND, (
        f"the record behind it must still be reclaimed to outbox/: {reclaimed!r}"
    )

    failures = _signals_of_kind(paths, ESCALATION_PUBLICATION_FAILED_KIND)
    assert len(failures) == ESCALATION_FAILURES_EXPECTED_ONCE, (
        f"a refused escalation publication must announce itself once, saw {len(failures)}"
    )

    stranded = _delivery_of(_processing_records(paths)[0])
    assert stranded.get("status") == HELD_STATUS, (
        f"the record whose escalation failed stays held: {stranded!r}"
    )
    assert not stranded.get(HELD_ESCALATED_FIELD), (
        "a refused publication must leave no escalation stamp, or the record "
        f"reads as reported while nothing was: {stranded.get(HELD_ESCALATED_FIELD)!r}"
    )

    # Injection removed: the next pass retries and the stamp reaches disk.
    mod.reclaim_processing(paths)
    retried = _delivery_of(_processing_records(paths)[0])
    assert retried.get(HELD_ESCALATED_FIELD), (
        f"the retried escalation must reach disk: {retried!r}"
    )
    escalations = len(_signals_of_kind(paths, HELD_ESCALATION_KIND))
    assert escalations == RETRIED_ESCALATION_SIGNALS, (
        "one duplicate line per retried escalation was expected, the disclosed "
        f"cost of logging before publishing, got {escalations}"
    )


def test_escalate_held_delivery_refuses_a_record_that_is_not_held(tmp_path):
    """The entry point carries its own held guard, not just its caller's.

    The age predicate answers a question about TIME, not about disposition: a
    released record still carries the hold instant its release did not clear,
    so the predicate says due while the record is queued. Without a guard here
    the function hands that record to hold_ambiguous_send, which parks it
    again, and reports True while emitting nothing. That is a queued alert
    silently flipped back to held by the one function whose docstring promises
    the disposition never changes.
    """
    mod = _load(tmp_path / "held-guard")
    paths = mod.setup_dirs()
    threshold = mod.INCIDENT_STALE_SECONDS
    released = _held_event(
        _iso_seconds_ago(threshold + THRESHOLD_MARGIN_SECONDS), GUARD_EVENT_ID
    )
    released["delivery"]["status"] = RELEASED_STATUS
    claimed = _seed_processing(paths, released)
    before = json.dumps(released, sort_keys=True)

    escalated = mod.escalate_held_delivery(paths, claimed, released, int(time.time()))

    assert escalated is False, (
        "a record that is not held must never enter the escalation path"
    )
    assert json.dumps(released, sort_keys=True) == before, (
        f"a released record must come back unmodified: {released!r}"
    )
    assert len(_signals_of_kind(paths, HELD_ESCALATION_KIND)) == NO_ESCALATIONS, (
        "and nothing may be signalled about it"
    )


def test_the_bound_fires_at_exactly_the_threshold_second(tmp_path):
    """The predicate is `>=`, pinned at the second in both directions.

    Every other test in this file uses a margin, so an implementation that
    compared with `>` would pass all of them. The age is computed from the
    record's own parsed instant rather than from the wall clock, because a
    wall-clock stamp lands on the threshold or one second past it depending on
    whether a second ticks mid-test, and that second is the whole question.
    """
    mod = _load(tmp_path / "held-boundary")
    event = _held_event(BOUNDARY_HELD_AT, BOUNDARY_EVENT_ID)
    held_epoch = mod.delivery_held_epoch(event)
    assert held_epoch is not None, "the fixture stamp must be a usable age basis"
    threshold = mod.HELD_DELIVERY_ESCALATE_SECONDS

    assert mod.held_delivery_escalation_due(event, held_epoch + threshold) is True, (
        "an age exactly equal to the bound must escalate: the predicate is `>=`"
    )
    assert (
        mod.held_delivery_escalation_due(event, held_epoch + threshold - ONE_SECOND)
        is False
    ), (
        "one second inside the bound must stay silent, which is what makes the "
        "assertion above a boundary rather than a restatement of the margin cases"
    )
