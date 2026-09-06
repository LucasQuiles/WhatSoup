"""Per-producer cadence receipt for the two release-proof producers (#2341, leaf 1).

Why this exists
---------------
Neither release-proof producer recorded when it last ran or when it last
produced a meaningful observation, so a stopped timer, a launch failure, a
repeatedly failing detector and a healthy silent cycle were indistinguishable
from the outside. This module is the WRITER half only: it stamps two
independent clocks per producer. There is no reader, no evaluator and no
watchdog registration here -- those are later leaves of #2341, and adding them
here would make a dark receipt operator-visible before its dwell is calibrated.

Two clocks, deliberately separate
---------------------------------
``lastAttemptAt`` answers "did the owned cycle start"; it advances at cycle
entry, before any observation exists. ``lastSuccessfulObservationAt`` answers
"did a complete, meaningful domain observation get durably written"; it
advances only after the producer's own durable write has landed. Collapsing
them into one clock is the defect this module cures: a producer that starts
every cycle and fails every observation would look alive under a single clock.

A cycle that never started its owned work -- the wrapper's non-blocking lock
skip -- advances NEITHER clock and records ``lock_skip`` instead, so permanent
lock contention reads as a stalled attempt clock rather than as success.

Durability
----------
Publication reuses the health-check daily receipt sequence
(``observe_json`` -> ``operation_id`` -> ``publish_state_json`` ->
``require_advance``) rather than reimplementing atomic publication. It is
nonetheless a new durable publisher under the repository's own vocabulary, and
it is registered as one in ``deploy/bot-errors-durable-writer-inventory.json``.
Each call observes afresh: two publications in one cycle (attempt, then
outcome) need two observations, because the second publication's ``expected``
version is the one the first publication produced.

Was this cycle real evidence?
-----------------------------
Three fields qualify a clock rather than restating it. ``mode`` says which of
the two shipped producer modes ran. ``durableWrite`` says whether anything
reached disk, which ``mode`` alone cannot: the two producers behave differently
in observe mode. ``invocationContext`` says whether the scheduler ran the cycle
or a person did, so a hand-run detector cannot refresh the clocks that stand
for a live timer.

Redaction
---------
Every field is a bounded token, an ISO-8601 UTC timestamp or an integer. No
path, hostname, process identifier, command output or repository detail may
enter a receipt -- these files are inputs to an operator-facing evaluator.

One file per producer (``RECEIPT_FILENAMES``). Two files keep the clocks
independent by construction, so a partial write of one producer cannot corrupt
the other. Filenames are defined here rather than in ``lib.state_files``
because #2341 leaf 1 scopes this module as the single owner of the receipt
convention; a later leaf that gains a cross-component reader should promote
them to that module.
"""

from __future__ import annotations

from enum import Enum
import os
from pathlib import Path
import time
from typing import Any, Callable, Mapping

from lib.durable_json import (
    PublicationResult,
    durable_json_target,
    observe_json,
    operation_id,
    publish_state_json,
    require_advance,
)
from lib.state_root import state_root

# Bumped only when a field is removed or its meaning changes; a reader that
# sees an unknown version must refuse rather than guess (#2341 C1). Adding a
# field does not bump it: a reader of an earlier version simply does not see
# the new key, and a bump costs a full dwell of blindness on both clocks
# unless the new version is also listed below.
CADENCE_RECEIPT_SCHEMA_VERSION = 1

# Prior schema versions whose clock VALUES still mean what this version's
# clocks mean. A receipt written under any listed version carries its clocks
# forward; anything else drops them, because inheriting a clock across a
# meaning change is how a stale clock becomes a false green.
#
# Today this holds the current version only, so behaviour is unchanged. It
# exists so a future bump has one place to declare clock compatibility:
# dropping both clocks on every bump publishes a null
# lastSuccessfulObservationAt on the first cycle after a migration, which the
# later evaluator reads as "never succeeded" and pages on. A migration must
# not manufacture an alert.
CLOCK_COMPATIBLE_SCHEMA_VERSIONS: frozenset[int] = frozenset(
    {CADENCE_RECEIPT_SCHEMA_VERSION}
)

# The durable-publication component label. One label for both producers: the
# producer is carried in the payload, not in the component name, so the
# operation identity stays stable across a producer rename.
CADENCE_RECEIPT_COMPONENT = "release_proof.producer_cadence_receipt"


class ProducerIdentity(str, Enum):
    """Closed two-value producer vocabulary, keyed by systemd unit name.

    The unit name is the identity rather than the wrapper's ``tree`` /
    ``runtime-staleness`` token because the later evaluator correlates receipts
    against timer state and service outcomes, which are addressed by unit name
    (#2341 C23). The wrapper token is carried alongside in ``producerToken`` so
    no third naming scheme is minted.
    """

    TREE_PROVENANCE = "bot-errors-tree-provenance"
    RUNTIME_STALENESS = "bot-errors-runtime-staleness"


class CadenceOutcome(str, Enum):
    """Bounded outcome vocabulary for one cycle."""

    IN_PROGRESS = "in_progress"
    SUCCESS = "success"
    PROBE_ERROR = "probe_error"
    EMIT_FAILURE = "emit_failure"
    LOCK_SKIP = "lock_skip"


class CadenceStage(str, Enum):
    """Earliest stage the cycle reached, as bounded evidence."""

    PRE_EXEC = "pre_exec"
    CYCLE_START = "cycle_start"
    OBSERVATION = "observation"
    DURABLE_WRITE = "durable_write"
    COMPLETE = "complete"


class CadenceMode(str, Enum):
    """Which of the two shipped producer modes ran.

    An observe-mode cycle is a real cycle but weaker evidence than an emit-mode
    one, so the mode is recorded and an evaluator can never mistake one for the
    other.
    """

    EMIT = "emit"
    OBSERVE = "observe"


class FetchStatus(str, Enum):
    """Whether this cycle refreshed its upstream reference, and how it went.

    Recorded explicitly so the failed-refresh case is visible rather than
    assumed: an evaluator must be able to tell a cycle that deliberately stayed
    offline from one that asked for a refresh and did not get it, because only
    the second means the comparison it reported was against an unproven ref.

    ``REQUESTED``      refresh asked for and obtained.
    ``REFUSED``        refresh asked for and not obtained.
    ``NOT_ATTEMPTED``  the producer has a fetch step and did not use it this
                       cycle -- the scheduled path, which is offline by
                       contract.
    ``NOT_APPLICABLE`` the producer has no fetch step at all. Separate from
                       NOT_ATTEMPTED because a permanent structural fact and a
                       per-cycle choice are different evidence: collapsing them
                       lets an evaluator read a missing capability as a
                       decision the cycle made.
    """

    REQUESTED = "requested"
    REFUSED = "refused"
    NOT_ATTEMPTED = "not_attempted"
    NOT_APPLICABLE = "not_applicable"


class DurableWrite(str, Enum):
    """What became of the durable write this cycle's success clock rests on.

    ``outcome`` says whether the cycle succeeded; this says whether the
    success rests on anything reaching disk. The two producers differ here and
    an evaluator must not flatten them: in observe mode the tree producer
    skips its only durable write entirely, while the runtime-staleness
    producer still writes its per-instance high-water mark unless every
    discovered instance is stopped.

    ``WRITTEN``     the qualifying durable write landed.
    ``NOT_OWED``    the cycle owed no qualifying write -- an observe-mode cycle
                    with nothing to persist.
    ``FAILED``      the write was owed, attempted and did not land.
    ``NOT_REACHED`` the cycle ended before that write was due, or had not
                    reached it yet when this receipt was stamped.

    Scoped to the qualifying write on purpose: a cycle that fails may still
    have persisted an unrelated obligation on its way out, and reporting that
    as a durable write would let an evaluator read a failed cycle as one that
    produced something.
    """

    WRITTEN = "written"
    NOT_OWED = "not_owed"
    FAILED = "failed"
    NOT_REACHED = "not_reached"


class InvocationContext(str, Enum):
    """Whether the scheduler ran this cycle or a person did.

    The receipt is keyed on the unit name, so without this an operator running
    a detector by hand during an incident refreshes the very clocks the later
    evaluator reads as proof the timer is alive -- masking a stopped timer for
    a full dwell.

    ``SCHEDULED`` the service manager supplied an invocation identifier.
    ``MANUAL``    it did not, so nothing vouches for this cycle but the caller.
    ``UNKNOWN``   the variable was present but carried no identifier, which is
                  proof of neither.
    """

    SCHEDULED = "scheduled"
    MANUAL = "manual"
    UNKNOWN = "unknown"


# The service manager exports this for every unit invocation. Only its
# PRESENCE is published: the identifier itself is a machine-correlatable value
# and this receipt admits no such thing (#2341 C21).
INVOCATION_ID_ENV = "INVOCATION_ID"


def invocation_context() -> InvocationContext:
    """Classify this process's invocation from the scheduler's marker.

    This component family already treats the same variable as the systemd
    discriminator, but it treats a blank value as absent. A blank value is
    reported here as UNKNOWN rather than MANUAL: for liveness evidence,
    "something set the variable without an identifier" is a third state, and
    reporting it as a hand run would be a claim this process cannot support.
    """
    raw = os.environ.get(INVOCATION_ID_ENV)
    if raw is None:
        return InvocationContext.MANUAL
    if not raw.strip():
        return InvocationContext.UNKNOWN
    return InvocationContext.SCHEDULED


WRAPPER_TOKENS: Mapping[ProducerIdentity, str] = {
    ProducerIdentity.TREE_PROVENANCE: "tree",
    ProducerIdentity.RUNTIME_STALENESS: "runtime-staleness",
}

RECEIPT_FILENAMES: Mapping[ProducerIdentity, str] = {
    ProducerIdentity.TREE_PROVENANCE: "release-proof-cadence-tree-provenance.json",
    ProducerIdentity.RUNTIME_STALENESS: "release-proof-cadence-runtime-staleness.json",
}

SCHEMA_VERSION_FIELD = "schemaVersion"
PRODUCER_FIELD = "producer"
PRODUCER_TOKEN_FIELD = "producerToken"
LAST_INVOCATION_AT_FIELD = "lastInvocationAt"
LAST_ATTEMPT_AT_FIELD = "lastAttemptAt"
LAST_SUCCESSFUL_OBSERVATION_AT_FIELD = "lastSuccessfulObservationAt"
OUTCOME_FIELD = "outcome"
STAGE_FIELD = "stage"
MODE_FIELD = "mode"
FETCH_STATUS_FIELD = "fetchStatus"
DURABLE_WRITE_FIELD = "durableWrite"
INVOCATION_CONTEXT_FIELD = "invocationContext"


def now_iso() -> str:
    """UTC second-resolution stamp, matching the producers' own format."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# Every publication reads its stamp through this module attribute rather than
# calling now_iso() directly, so a test can move the clock between two
# publications. Stamps are second-resolution and a test body runs in
# microseconds, so two publications otherwise carry the same stamp -- and an
# assertion that a clock did NOT move then compares two equal values and holds
# whether or not the clock rule does. Injecting the clock is what gives those
# assertions a way to be wrong.
receipt_clock: Callable[[], str] = now_iso


def receipt_path(producer: ProducerIdentity) -> Path:
    """Absolute receipt path under the state root the producer units may write."""
    return state_root() / RECEIPT_FILENAMES[producer]


def _ensure_private_dir(path: Path) -> None:
    """Create or narrow the receipt directory to 0700, refusing a symlink.

    Mirrors the tree-provenance producer's own private-directory guard, which
    is the only one of the two that has one: the durable reader rejects any
    group- or world-accessible bit on the parent, so a leaked mode would turn
    every later cycle into a publication refusal rather than a silent widening.

    Kept as a copy rather than consolidated. There is no shared helper to
    import: every publisher under ``deploy/scripts`` carries its own copy of
    this body, so this is the shipped pattern rather than a fork of one. The
    available alternative -- having the domain producers import a private
    helper out of this module -- would make a domain guard depend on the dark
    receipt for its own outbox directory, which is the wrong direction. The
    state root, by contrast, IS resolved by one shared function, because there
    a divergence desynchronises a writer from its reader.
    """
    try:
        path.lstat()
    except FileNotFoundError:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    else:
        if path.is_symlink():
            raise RuntimeError("refusing symlinked private publication directory")
        if not path.is_dir():
            raise RuntimeError("private publication path is not a directory")
    try:
        path.chmod(0o700)
    except OSError:
        pass


def _carried_clock(prior: Mapping[str, Any] | None, field: str) -> str | None:
    """Carry a clock forward from the prior receipt, or drop it.

    A prior receipt written under a schema version this one does not declare
    clock-compatible is not carried: the clock's meaning is exactly what its
    version says it is, and silently inheriting a value across a meaning
    change is how a stale clock becomes a false green.
    """
    if not isinstance(prior, Mapping):
        return None
    if prior.get(SCHEMA_VERSION_FIELD) not in CLOCK_COMPATIBLE_SCHEMA_VERSIONS:
        return None
    value = prior.get(field)
    return value if isinstance(value, str) and value else None


def record_cadence_receipt(
    producer: ProducerIdentity,
    *,
    outcome: CadenceOutcome,
    stage: CadenceStage,
    mode: CadenceMode,
    durable_write: DurableWrite,
    fetch_status: FetchStatus = FetchStatus.NOT_ATTEMPTED,
    advance_attempt: bool = False,
    advance_success: bool = False,
    require_attempt: bool = False,
) -> PublicationResult:
    """Publish one cadence receipt, carrying unadvanced clocks forward.

    ``advance_attempt`` and ``advance_success`` are independent and explicit
    rather than derived from ``outcome``: a caller has to say which clock this
    cycle earned, so a new outcome value cannot silently start advancing a
    clock it did not prove.

    ``require_attempt`` backfills a missing attempt clock with this stamp
    instead of publishing a success beside a null attempt. It never moves an
    attempt clock that is already there.
    """
    root = state_root()
    _ensure_private_dir(root)
    path = root / RECEIPT_FILENAMES[producer]
    target = durable_json_target(
        trusted_root=path.parent.resolve(strict=True),
        relative_path=path.name,
    )
    observation = observe_json(target)
    prior = observation.payload
    stamp = receipt_clock()
    attempt_at = (
        stamp if advance_attempt
        else _carried_clock(prior, LAST_ATTEMPT_AT_FIELD)
    )
    if require_attempt and attempt_at is None:
        # An attempt always precedes a success within one cycle. The attempt
        # receipt is itself publishable and therefore losable -- both producers
        # swallow a receipt failure -- so a success can arrive with no attempt
        # clock on disk. Publishing that pair would claim an observation nobody
        # tried for; this stamp is coarse but true, because the attempt did
        # happen, at or before this instant.
        attempt_at = stamp
    receipt: dict[str, Any] = {
        SCHEMA_VERSION_FIELD: CADENCE_RECEIPT_SCHEMA_VERSION,
        PRODUCER_FIELD: producer.value,
        PRODUCER_TOKEN_FIELD: WRAPPER_TOKENS[producer],
        LAST_INVOCATION_AT_FIELD: stamp,
        LAST_ATTEMPT_AT_FIELD: attempt_at,
        LAST_SUCCESSFUL_OBSERVATION_AT_FIELD: (
            stamp if advance_success
            else _carried_clock(prior, LAST_SUCCESSFUL_OBSERVATION_AT_FIELD)
        ),
        OUTCOME_FIELD: outcome.value,
        STAGE_FIELD: stage.value,
        MODE_FIELD: mode.value,
        FETCH_STATUS_FIELD: fetch_status.value,
        DURABLE_WRITE_FIELD: durable_write.value,
        INVOCATION_CONTEXT_FIELD: invocation_context().value,
    }
    publication_operation = operation_id(
        target,
        receipt,
        component=CADENCE_RECEIPT_COMPONENT,
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        receipt,
        component=CADENCE_RECEIPT_COMPONENT,
        operation_id=publication_operation,
        expected=observation.version,
        generation=(observation.version.generation or 0) + 1,
    )
    require_advance(publication)
    return publication


def record_cycle_attempt(
    producer: ProducerIdentity,
    *,
    mode: CadenceMode,
    fetch_status: FetchStatus = FetchStatus.NOT_ATTEMPTED,
) -> PublicationResult:
    """Stamp ``lastAttemptAt`` because the producer's owned cycle just started.

    Called before any observation exists, so the outcome is ``in_progress``: a
    cycle that dies after this point leaves an attempt with no matching
    success, which is exactly the signal the later evaluator reads.
    """
    return record_cadence_receipt(
        producer,
        outcome=CadenceOutcome.IN_PROGRESS,
        stage=CadenceStage.CYCLE_START,
        mode=mode,
        # The cycle has only just started, so whatever it owes is still ahead
        # of it.
        durable_write=DurableWrite.NOT_REACHED,
        fetch_status=fetch_status,
        advance_attempt=True,
    )


def record_cycle_success(
    producer: ProducerIdentity,
    *,
    mode: CadenceMode,
    durable_write: DurableWrite,
    fetch_status: FetchStatus = FetchStatus.NOT_ATTEMPTED,
) -> PublicationResult:
    """Advance ``lastSuccessfulObservationAt`` after the durable domain write.

    Call this only once the producer's own artefact or state write has landed.
    Calling it on exit zero alone would restore the defect this module cures.

    A success never moves an attempt clock that is already set; it only fills
    one that is missing, so the receipt never claims an observation with no
    attempt behind it.

    ``durable_write`` has no default: the caller has to say whether anything
    reached disk, because a success that owed nothing and a success that wrote
    are different evidence and only the caller knows which this was.
    """
    return record_cadence_receipt(
        producer,
        outcome=CadenceOutcome.SUCCESS,
        stage=CadenceStage.COMPLETE,
        mode=mode,
        durable_write=durable_write,
        fetch_status=fetch_status,
        advance_success=True,
        require_attempt=True,
    )


def record_cycle_failure(
    producer: ProducerIdentity,
    *,
    outcome: CadenceOutcome,
    stage: CadenceStage,
    mode: CadenceMode,
    durable_write: DurableWrite,
    fetch_status: FetchStatus = FetchStatus.NOT_ATTEMPTED,
) -> PublicationResult:
    """Record a cycle that started and did not produce a qualifying observation.

    Leaves ``lastSuccessfulObservationAt`` at whatever the last real success
    set it to; the attempt clock stays where ``record_cycle_attempt`` put it.
    """
    return record_cadence_receipt(
        producer,
        outcome=outcome,
        stage=stage,
        mode=mode,
        durable_write=durable_write,
        fetch_status=fetch_status,
    )


def record_lock_skip(
    producer: ProducerIdentity,
    *,
    mode: CadenceMode,
) -> PublicationResult:
    """Record a cycle the shared lock refused, advancing neither clock.

    The owned cycle never started, so ``lastAttemptAt`` must not move; and
    nothing was observed, so ``lastSuccessfulObservationAt`` must not either.
    ``lastInvocationAt`` still advances, which is what separates a contended
    lock from a stopped timer.
    """
    return record_cadence_receipt(
        producer,
        outcome=CadenceOutcome.LOCK_SKIP,
        stage=CadenceStage.PRE_EXEC,
        mode=mode,
        # The owned cycle never started, so it never owed a durable write.
        durable_write=DurableWrite.NOT_REACHED,
        fetch_status=FetchStatus.NOT_ATTEMPTED,
    )
