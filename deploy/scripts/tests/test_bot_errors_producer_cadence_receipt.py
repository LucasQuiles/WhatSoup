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
    assert {member.value for member in pcr.FetchStatus} == {
        "requested",
        "refused",
        "not_attempted",
    }


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
def test_success_advances_the_success_clock_and_keeps_the_attempt_clock(state_dir, producer):
    pcr.record_cycle_attempt(producer, mode=pcr.CadenceMode.EMIT)
    attempt_stamp = _payload(producer)["lastAttemptAt"]
    pcr.record_cycle_success(producer, mode=pcr.CadenceMode.EMIT)
    receipt = _payload(producer)
    assert receipt["lastAttemptAt"] == attempt_stamp
    assert receipt["lastSuccessfulObservationAt"]
    assert receipt["outcome"] == "success"
    assert receipt["stage"] == "complete"


@pytest.mark.parametrize("producer", BOTH_PRODUCERS, ids=lambda p: p.value)
def test_failure_after_a_success_leaves_the_success_clock_where_it_was(state_dir, producer):
    pcr.record_cycle_attempt(producer, mode=pcr.CadenceMode.EMIT)
    pcr.record_cycle_success(producer, mode=pcr.CadenceMode.EMIT)
    success_stamp = _payload(producer)["lastSuccessfulObservationAt"]

    pcr.record_cycle_attempt(producer, mode=pcr.CadenceMode.EMIT)
    pcr.record_cycle_failure(
        producer,
        outcome=pcr.CadenceOutcome.PROBE_ERROR,
        stage=pcr.CadenceStage.OBSERVATION,
        mode=pcr.CadenceMode.EMIT,
    )
    receipt = _payload(producer)
    assert receipt["lastSuccessfulObservationAt"] == success_stamp
    assert receipt["outcome"] == "probe_error"
    assert receipt["stage"] == "observation"


@pytest.mark.parametrize("producer", BOTH_PRODUCERS, ids=lambda p: p.value)
def test_lock_skip_moves_neither_clock(state_dir, producer):
    pcr.record_cycle_attempt(producer, mode=pcr.CadenceMode.EMIT)
    pcr.record_cycle_success(producer, mode=pcr.CadenceMode.EMIT)
    before = _payload(producer)

    pcr.record_lock_skip(producer, mode=pcr.CadenceMode.EMIT)
    after = _payload(producer)
    assert after["lastAttemptAt"] == before["lastAttemptAt"]
    assert after["lastSuccessfulObservationAt"] == before["lastSuccessfulObservationAt"]
    assert after["outcome"] == "lock_skip"
    assert after["stage"] == "pre_exec"
    # The invocation clock is what separates a contended lock from a stopped
    # timer, so it must move even though neither cadence clock does.
    assert after["lastInvocationAt"] >= before["lastInvocationAt"]


def test_a_clock_written_under_a_different_schema_version_is_not_carried_forward(state_dir):
    pcr.record_cycle_attempt(TREE, mode=pcr.CadenceMode.EMIT)
    pcr.record_cycle_success(TREE, mode=pcr.CadenceMode.EMIT)
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


@pytest.mark.parametrize("producer", BOTH_PRODUCERS, ids=lambda p: p.value)
def test_receipt_carries_no_path_hostname_or_command_evidence(state_dir, producer):
    pcr.record_cycle_attempt(producer, mode=pcr.CadenceMode.OBSERVE)
    pcr.record_cycle_success(
        producer,
        mode=pcr.CadenceMode.OBSERVE,
        fetch_status=pcr.FetchStatus.NOT_ATTEMPTED,
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
