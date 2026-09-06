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
