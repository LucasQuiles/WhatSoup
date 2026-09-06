"""Cadence-receipt schema and writer semantics (#2341, leaf 1).

Covers the module contract that both producers depend on: the schema version,
the closed producer vocabulary, and the clock rules. The per-producer wiring is
tested in test_bot_errors_tree_provenance_cadence.py and
test_bot_errors_runtime_staleness_cadence.py.

The lock-skip case is proven HERE at the writer API and nowhere else in this
leaf: the wrapper that detects lock contention is out of scope for leaf 1, so
no producer code path reaches lock_skip yet. This file proves the writer
refuses to move either clock for that outcome; it does not prove the wrapper
calls it.
"""
from __future__ import annotations

import importlib
import json
import sys
import time
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

pcr = importlib.import_module("lib.producer_cadence_receipt")
durable_json = importlib.import_module("lib.durable_json")

# Named so a reader sees which producer a case is about without decoding an
# index; the contract forbids three-plus bare literal parametrize cases.
TREE = pcr.ProducerIdentity.TREE_PROVENANCE
RUNTIME_STALENESS = pcr.ProducerIdentity.RUNTIME_STALENESS
BOTH_PRODUCERS = (TREE, RUNTIME_STALENESS)


@pytest.fixture()
def state_dir(tmp_path, monkeypatch):
    root = tmp_path / "bot-errors"
    root.mkdir(mode=0o700)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root))
    return root


# A fixed instant, so a stamp is reproducible and two stamps differ only when
# the test moved the clock between them.
_BASE_EPOCH = 1_700_000_000


class _SteppedClock:
    """Second-resolution receipt clock the test moves by hand.

    The writer stamps at second resolution and a test body runs in
    microseconds, so two real publications inside one test carry equal stamps.
    An assertion that a clock was PRESERVED across those two publications then
    compares two equal values and passes whether or not the writer preserved
    anything. Advancing this clock between the calls makes the preserved value
    and the newly stamped value distinct, so such an assertion can fail.
    """

    def __init__(self) -> None:
        self._epoch = _BASE_EPOCH

    def __call__(self) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self._epoch))

    def advance(self, seconds: int = 60) -> str:
        self._epoch += seconds
        return self()


@pytest.fixture()
def clock(monkeypatch):
    stepped = _SteppedClock()
    monkeypatch.setattr(pcr, "receipt_clock", stepped)
    return stepped


def _payload(producer):
    return json.loads(pcr.receipt_path(producer).read_text(encoding="utf-8"))


def test_schema_version_is_pinned():
    assert pcr.CADENCE_RECEIPT_SCHEMA_VERSION == 1


def test_producer_vocabulary_is_the_closed_pair_of_unit_names():
    assert {member.value for member in pcr.ProducerIdentity} == {
        "bot-errors-tree-provenance",
        "bot-errors-runtime-staleness",
    }


def test_every_producer_has_a_wrapper_token_and_a_receipt_filename():
    for producer in pcr.ProducerIdentity:
        assert pcr.WRAPPER_TOKENS[producer]
        assert pcr.RECEIPT_FILENAMES[producer].endswith(".json")
    # Distinct files: a partial write of one producer must not be able to
    # corrupt the other producer's clocks.
    assert len(set(pcr.RECEIPT_FILENAMES.values())) == len(pcr.ProducerIdentity)


def test_outcome_vocabulary_is_bounded():
    assert {member.value for member in pcr.CadenceOutcome} == {
        "in_progress",
        "success",
        "probe_error",
        "emit_failure",
        "lock_skip",
    }


def test_stage_vocabulary_is_bounded():
    assert {member.value for member in pcr.CadenceStage} == {
        "pre_exec",
        "cycle_start",
        "observation",
        "durable_write",
        "complete",
    }


def test_fetch_status_vocabulary_is_bounded():
    # not_applicable is the producer that has no fetch step at all;
    # not_attempted is a producer that has one and did not use it. An
    # evaluator that cannot tell those apart reads a permanent structural
    # state as a per-cycle choice.
    assert {member.value for member in pcr.FetchStatus} == {
        "requested",
        "refused",
        "not_attempted",
        "not_applicable",
    }


def test_durable_write_vocabulary_is_bounded():
    assert {member.value for member in pcr.DurableWrite} == {
        "written",
        "not_owed",
        "failed",
        "not_reached",
    }


def test_invocation_context_vocabulary_is_bounded():
    assert {member.value for member in pcr.InvocationContext} == {
        "scheduled",
        "manual",
        "unknown",
    }


def test_a_scheduler_invocation_identifier_marks_the_cycle_scheduled(monkeypatch):
    monkeypatch.setenv(pcr.INVOCATION_ID_ENV, "b8f0c9d2e1a4")
    assert pcr.invocation_context() is pcr.InvocationContext.SCHEDULED


def test_no_scheduler_invocation_identifier_marks_the_cycle_manual(monkeypatch):
    # The case this field exists for: an operator running the detector by hand
    # during an incident must not refresh the clocks an evaluator reads as
    # proof that the timer is alive.
    monkeypatch.delenv(pcr.INVOCATION_ID_ENV, raising=False)
    assert pcr.invocation_context() is pcr.InvocationContext.MANUAL


def test_a_blank_scheduler_invocation_identifier_is_unknown(monkeypatch):
    # Set but carrying no identifier is neither proof of a scheduled cycle nor
    # proof of a hand run, so it must not be reported as either.
    monkeypatch.setenv(pcr.INVOCATION_ID_ENV, "   ")
    assert pcr.invocation_context() is pcr.InvocationContext.UNKNOWN


def test_the_receipt_records_the_context_token_not_the_identifier(state_dir, monkeypatch):
    secret_identifier = "0123456789abcdef0123456789abcdef"
    monkeypatch.setenv(pcr.INVOCATION_ID_ENV, secret_identifier)

    pcr.record_cycle_attempt(TREE, mode=pcr.CadenceMode.EMIT)
    receipt = _payload(TREE)
    assert receipt["invocationContext"] == "scheduled"
    assert secret_identifier not in json.dumps(receipt)


def test_clock_field_names_are_the_two_the_evaluator_will_read():
    assert pcr.LAST_ATTEMPT_AT_FIELD == "lastAttemptAt"
    assert pcr.LAST_SUCCESSFUL_OBSERVATION_AT_FIELD == "lastSuccessfulObservationAt"


@pytest.mark.parametrize("producer", BOTH_PRODUCERS, ids=lambda p: p.value)
def test_attempt_stamps_the_attempt_clock_and_leaves_success_absent(state_dir, producer):
    pcr.record_cycle_attempt(producer, mode=pcr.CadenceMode.EMIT)
    receipt = _payload(producer)
    assert receipt["schemaVersion"] == pcr.CADENCE_RECEIPT_SCHEMA_VERSION
    assert receipt["producer"] == producer.value
    assert receipt["producerToken"] == pcr.WRAPPER_TOKENS[producer]
    assert receipt["lastAttemptAt"]
    assert receipt["lastSuccessfulObservationAt"] is None
    assert receipt["outcome"] == "in_progress"
    assert receipt["stage"] == "cycle_start"
    assert receipt["mode"] == "emit"


@pytest.mark.parametrize("producer", BOTH_PRODUCERS, ids=lambda p: p.value)
def test_success_does_not_move_the_attempt_clock(state_dir, clock, producer):
    pcr.record_cycle_attempt(producer, mode=pcr.CadenceMode.EMIT)
    attempt_stamp = _payload(producer)["lastAttemptAt"]

    # Move the clock so the attempt stamp the success must preserve and the
    # stamp the success writes are different values.
    success_stamp = clock.advance()
    assert success_stamp != attempt_stamp

    pcr.record_cycle_success(
        producer, mode=pcr.CadenceMode.EMIT, durable_write=pcr.DurableWrite.WRITTEN
    )
    receipt = _payload(producer)
    assert receipt["lastAttemptAt"] == attempt_stamp
    assert receipt["lastSuccessfulObservationAt"] == success_stamp
    assert receipt["outcome"] == "success"
    assert receipt["stage"] == "complete"


@pytest.mark.parametrize("producer", BOTH_PRODUCERS, ids=lambda p: p.value)
def test_failure_after_a_success_leaves_the_success_clock_where_it_was(state_dir, clock, producer):
    pcr.record_cycle_attempt(producer, mode=pcr.CadenceMode.EMIT)
    pcr.record_cycle_success(
        producer, mode=pcr.CadenceMode.EMIT, durable_write=pcr.DurableWrite.WRITTEN
    )
    success_stamp = _payload(producer)["lastSuccessfulObservationAt"]

    # The later cycle runs at a different instant, so a success clock that
    # wrongly advanced would carry the new value rather than this one.
    later_stamp = clock.advance()
    assert later_stamp != success_stamp

    pcr.record_cycle_attempt(producer, mode=pcr.CadenceMode.EMIT)
    pcr.record_cycle_failure(
        producer,
        outcome=pcr.CadenceOutcome.PROBE_ERROR,
        stage=pcr.CadenceStage.OBSERVATION,
        mode=pcr.CadenceMode.EMIT,
        durable_write=pcr.DurableWrite.NOT_REACHED,
    )
    receipt = _payload(producer)
    assert receipt["lastSuccessfulObservationAt"] == success_stamp
    assert receipt["lastAttemptAt"] == later_stamp
    assert receipt["outcome"] == "probe_error"
    assert receipt["stage"] == "observation"


@pytest.mark.parametrize("producer", BOTH_PRODUCERS, ids=lambda p: p.value)
def test_lock_skip_moves_neither_clock(state_dir, clock, producer):
    pcr.record_cycle_attempt(producer, mode=pcr.CadenceMode.EMIT)
    pcr.record_cycle_success(
        producer, mode=pcr.CadenceMode.EMIT, durable_write=pcr.DurableWrite.WRITTEN
    )
    before = _payload(producer)

    # The refused cycle happens later than the cycle that set both clocks, so
    # a clock that wrongly advanced would hold this stamp instead of the old
    # one, and the invocation clock has somewhere to move to.
    skip_stamp = clock.advance()
    assert skip_stamp != before["lastAttemptAt"]
    assert skip_stamp != before["lastSuccessfulObservationAt"]

    pcr.record_lock_skip(producer, mode=pcr.CadenceMode.EMIT)
    after = _payload(producer)
    assert after["lastAttemptAt"] == before["lastAttemptAt"]
    assert after["lastSuccessfulObservationAt"] == before["lastSuccessfulObservationAt"]
    assert after["outcome"] == "lock_skip"
    assert after["stage"] == "pre_exec"
    # The invocation clock is what separates a contended lock from a stopped
    # timer, so it must move even though neither cadence clock does.
    assert after["lastInvocationAt"] == skip_stamp
    assert after["lastInvocationAt"] > before["lastInvocationAt"]


@pytest.mark.parametrize("producer", BOTH_PRODUCERS, ids=lambda p: p.value)
def test_success_without_a_recorded_attempt_backfills_the_attempt_clock(state_dir, clock, producer):
    # The attempt receipt is publishable and therefore losable: both producers
    # swallow a receipt failure, so a cycle can reach its success stamp with no
    # attempt stamp on disk. A success beside a null attempt clock reads as an
    # observation nobody tried for, and the later evaluator has to treat that
    # pair as malformed. An attempt always precedes a success within the same
    # cycle, so the success stamp backfills it.
    success_stamp = clock.advance()
    pcr.record_cycle_success(
        producer, mode=pcr.CadenceMode.EMIT, durable_write=pcr.DurableWrite.WRITTEN
    )
    receipt = _payload(producer)
    assert receipt["lastAttemptAt"] == success_stamp
    assert receipt["lastSuccessfulObservationAt"] == success_stamp


def test_a_clock_written_under_a_different_schema_version_is_not_carried_forward(state_dir):
    pcr.record_cycle_attempt(TREE, mode=pcr.CadenceMode.EMIT)
    pcr.record_cycle_success(
        TREE, mode=pcr.CadenceMode.EMIT, durable_write=pcr.DurableWrite.WRITTEN
    )
    assert _payload(TREE)["lastSuccessfulObservationAt"]

    stale = _payload(TREE)
    stale["schemaVersion"] = pcr.CADENCE_RECEIPT_SCHEMA_VERSION + 1
    monkeyed = pcr.receipt_path(TREE)
    monkeyed.write_text(json.dumps(stale), encoding="utf-8")
    # The durable reader refuses any group- or world-accessible bit on a
    # private leaf, so restore the writer's own mode after the raw overwrite.
    monkeyed.chmod(0o600)

    pcr.record_cycle_attempt(TREE, mode=pcr.CadenceMode.EMIT)
    assert _payload(TREE)["lastSuccessfulObservationAt"] is None


def test_a_clock_written_under_a_declared_compatible_version_is_carried_forward(
    state_dir, monkeypatch
):
    # The negative case above is the safe default; this is the escape hatch a
    # migration needs. Only one version exists today, so the compatible set is
    # injected rather than exercised through a real second version: what is
    # under test is that the writer consults the set at all, so a future bump
    # that declares compatibility does not publish a null success clock and
    # page the operator through a migration.
    other_version = pcr.CADENCE_RECEIPT_SCHEMA_VERSION + 1
    monkeypatch.setattr(
        pcr,
        "CLOCK_COMPATIBLE_SCHEMA_VERSIONS",
        frozenset({pcr.CADENCE_RECEIPT_SCHEMA_VERSION, other_version}),
    )

    pcr.record_cycle_attempt(TREE, mode=pcr.CadenceMode.EMIT)
    pcr.record_cycle_success(
        TREE, mode=pcr.CadenceMode.EMIT, durable_write=pcr.DurableWrite.WRITTEN
    )
    success_stamp = _payload(TREE)["lastSuccessfulObservationAt"]

    prior = _payload(TREE)
    prior["schemaVersion"] = other_version
    receipt_file = pcr.receipt_path(TREE)
    receipt_file.write_text(json.dumps(prior), encoding="utf-8")
    receipt_file.chmod(0o600)

    pcr.record_cycle_attempt(TREE, mode=pcr.CadenceMode.EMIT)
    carried = _payload(TREE)
    assert carried["lastSuccessfulObservationAt"] == success_stamp
    assert carried["schemaVersion"] == pcr.CADENCE_RECEIPT_SCHEMA_VERSION


# Two values a corrupted or hand-edited receipt can carry that Python's
# equality reads as the declared version 1. Named rather than inlined so a
# reader sees which coercion each case is about.
BOOLEAN_TRUE_VERSION = True
FLOAT_ONE_VERSION = 1.0
VERSIONS_THAT_MERELY_COMPARE_EQUAL = (BOOLEAN_TRUE_VERSION, FLOAT_ONE_VERSION)


@pytest.mark.parametrize(
    "version",
    VERSIONS_THAT_MERELY_COMPARE_EQUAL,
    ids=("boolean_true", "float_one"),
)
def test_a_clock_written_under_a_non_integer_version_is_not_carried_forward(
    state_dir, version
):
    # ``True in frozenset({1})`` and ``1.0 in frozenset({1})`` both evaluate
    # true, so a membership test alone accepts a version field that was never
    # declared clock-compatible and carries a clock across an undeclared
    # meaning. The version a receipt claims is the whole warrant for reusing
    # its clocks, so the check has to be strict on type as well as on value.
    pcr.record_cycle_attempt(TREE, mode=pcr.CadenceMode.EMIT)
    pcr.record_cycle_success(
        TREE, mode=pcr.CadenceMode.EMIT, durable_write=pcr.DurableWrite.WRITTEN
    )
    assert _payload(TREE)["lastSuccessfulObservationAt"]

    corrupted = _payload(TREE)
    corrupted["schemaVersion"] = version
    receipt_file = pcr.receipt_path(TREE)
    receipt_file.write_text(json.dumps(corrupted), encoding="utf-8")
    # The durable reader refuses any group- or world-accessible bit on a
    # private leaf, so restore the writer's own mode after the raw overwrite.
    receipt_file.chmod(0o600)

    pcr.record_cycle_attempt(TREE, mode=pcr.CadenceMode.EMIT)
    assert _payload(TREE)["lastSuccessfulObservationAt"] is None


@pytest.mark.parametrize("producer", BOTH_PRODUCERS, ids=lambda p: p.value)
def test_receipt_carries_no_path_hostname_or_command_evidence(state_dir, producer):
    pcr.record_cycle_attempt(producer, mode=pcr.CadenceMode.OBSERVE)
    pcr.record_cycle_success(
        producer,
        mode=pcr.CadenceMode.OBSERVE,
        fetch_status=pcr.FetchStatus.NOT_ATTEMPTED,
        durable_write=pcr.DurableWrite.NOT_OWED,
    )
    receipt = _payload(producer)
    assert set(receipt) == {
        "schemaVersion",
        "producer",
        "producerToken",
        "lastInvocationAt",
        "lastAttemptAt",
        "lastSuccessfulObservationAt",
        "outcome",
        "stage",
        "mode",
        "fetchStatus",
        "invocationContext",
        "durableWrite",
    }
    rendered = json.dumps(receipt)
    assert str(state_dir) not in rendered
    # Every value is a bounded token, an ISO-8601 stamp or an integer, so no
    # path separator can appear at all.
    assert "/" not in rendered


def test_published_receipt_survives_the_strict_durable_reader(state_dir):
    # The durable reader refuses a leaf that is group- or world-accessible,
    # multiply linked, or not owned by this user. A receipt that fails it would
    # turn every later cycle into a publication refusal, so assert the writer's
    # own output passes it rather than only that the bytes are on disk.
    pcr.record_cycle_attempt(TREE, mode=pcr.CadenceMode.EMIT)
    path = pcr.receipt_path(TREE)
    target = durable_json.durable_json_target(
        trusted_root=path.parent.resolve(strict=True),
        relative_path=path.name,
    )
    observation = durable_json.observe_json(target)
    assert observation.payload is not None
    assert observation.payload["producer"] == TREE.value
