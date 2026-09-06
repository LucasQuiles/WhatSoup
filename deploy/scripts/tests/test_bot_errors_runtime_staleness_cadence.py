"""Runtime-staleness cadence-receipt wiring (#2341, leaf 1).

Exercises ``run_once`` directly rather than ``main``: ``main`` refuses on any
non-Linux host before it reaches the cycle, so calling it here would prove
nothing about the stamping on a developer machine and would still prove nothing
different on CI.

Probe and emit are supplied as fixtures. What is under test is which clock a
given cycle outcome is allowed to move, not systemd behaviour.
"""
from __future__ import annotations

import importlib
import importlib.util
import json
from pathlib import Path
import sys

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

pcr = importlib.import_module("lib.producer_cadence_receipt")

_SCRIPT = _SCRIPTS / "bot-errors-runtime-staleness.py"
RUNTIME_STALENESS = pcr.ProducerIdentity.RUNTIME_STALENESS

FIXTURE_INSTANCE = "fixture"
FRESH_OBSERVATION = {"running": True, "stale": False, "critical": False, "lag_seconds": 0}
STALE_OBSERVATION = {"running": True, "stale": True, "critical": False, "lag_seconds": 90}
STOPPED_OBSERVATION = {"running": False, "stale": False, "critical": False, "lag_seconds": None}

EMIT_ACCEPTED = 0
EMIT_REJECTED = 1


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_runtime_st_cadence", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()


@pytest.fixture()
def state_dir(tmp_path, monkeypatch):
    root = tmp_path / "bot-errors"
    root.mkdir(mode=0o700)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root))
    return root


def _receipt():
    return json.loads(pcr.receipt_path(RUNTIME_STALENESS).read_text(encoding="utf-8"))


def _stub_cycle(monkeypatch, *, observation=None, probe_error=None, emit_rc=EMIT_ACCEPTED):
    def _probe(_instance):
        if probe_error is not None:
            raise _mod.ProbeError(probe_error)
        return dict(observation)

    monkeypatch.setattr(_mod, "probe_instance", _probe)
    monkeypatch.setattr(_mod, "emit_event", lambda argv, *, dry_run: emit_rc)


def test_completed_cycle_stamps_both_clocks(state_dir, monkeypatch, capsys):
    _stub_cycle(monkeypatch, observation=FRESH_OBSERVATION)

    assert _mod.run_once(instances=[FIXTURE_INSTANCE], dry_run=False) == 0
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["schemaVersion"] == pcr.CADENCE_RECEIPT_SCHEMA_VERSION
    assert receipt["producer"] == "bot-errors-runtime-staleness"
    assert receipt["producerToken"] == "runtime-staleness"
    assert receipt["lastAttemptAt"]
    assert receipt["lastSuccessfulObservationAt"]
    assert receipt["outcome"] == "success"
    assert receipt["stage"] == "complete"
    assert receipt["mode"] == "emit"
    assert receipt["durableWrite"] == "written"


def test_probe_error_advances_only_the_attempt_clock(state_dir, monkeypatch, capsys):
    _stub_cycle(monkeypatch, probe_error="timeout")

    assert _mod.run_once(instances=[FIXTURE_INSTANCE], dry_run=False) == 2
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["lastAttemptAt"]
    assert receipt["lastSuccessfulObservationAt"] is None
    assert receipt["outcome"] == "probe_error"
    assert receipt["stage"] == "observation"
    assert receipt["durableWrite"] == "not_reached"


def test_probe_error_after_a_success_preserves_the_success_clock(
    state_dir, monkeypatch, capsys
):
    _stub_cycle(monkeypatch, observation=FRESH_OBSERVATION)
    assert _mod.run_once(instances=[FIXTURE_INSTANCE], dry_run=False) == 0
    success_stamp = _receipt()["lastSuccessfulObservationAt"]
    assert success_stamp

    _stub_cycle(monkeypatch, probe_error="command_error")
    assert _mod.run_once(instances=[FIXTURE_INSTANCE], dry_run=False) == 2
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["lastSuccessfulObservationAt"] == success_stamp
    assert receipt["outcome"] == "probe_error"


def test_emit_failure_does_not_advance_the_success_clock(state_dir, monkeypatch, capsys):
    _stub_cycle(monkeypatch, observation=STALE_OBSERVATION, emit_rc=EMIT_REJECTED)

    assert _mod.run_once(instances=[FIXTURE_INSTANCE], dry_run=False) == 1
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["lastAttemptAt"]
    assert receipt["lastSuccessfulObservationAt"] is None
    assert receipt["outcome"] == "emit_failure"
    assert receipt["stage"] == "durable_write"
    assert receipt["durableWrite"] == "failed"


def test_discovery_failure_advances_only_the_attempt_clock(state_dir, monkeypatch, capsys):
    def _raise():
        raise _mod.ProbeError("command_error")

    monkeypatch.setattr(_mod, "discover_instances", _raise)

    assert _mod.run_once(instances=None, dry_run=False) == 2
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["lastAttemptAt"]
    assert receipt["lastSuccessfulObservationAt"] is None
    assert receipt["outcome"] == "probe_error"
    assert receipt["stage"] == "observation"


def test_empty_fleet_is_a_probe_error_not_a_success(state_dir, monkeypatch, capsys):
    # A discovery command that silently stops matching real units looks
    # identical to a healthy empty fleet, so it must never advance the success
    # clock.
    monkeypatch.setattr(_mod, "discover_instances", lambda: [])

    assert _mod.run_once(instances=None, dry_run=False) == 2
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["lastSuccessfulObservationAt"] is None
    assert receipt["outcome"] == "probe_error"


def test_observe_mode_is_recorded_as_observe(state_dir, monkeypatch, capsys):
    _stub_cycle(monkeypatch, observation=FRESH_OBSERVATION)

    assert _mod.run_once(instances=[FIXTURE_INSTANCE], dry_run=True) == 0
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["mode"] == "observe"
    assert receipt["lastSuccessfulObservationAt"]


def test_receipt_records_no_fetch_step_for_this_producer(state_dir, monkeypatch, capsys):
    # This producer has no fetch step at all, which is a permanent structural
    # fact. not_attempted would say "had one and did not use it this cycle",
    # so an evaluator could read a missing capability as a per-cycle choice.
    _stub_cycle(monkeypatch, observation=FRESH_OBSERVATION)

    assert _mod.run_once(instances=[FIXTURE_INSTANCE], dry_run=False) == 0
    capsys.readouterr()

    assert _receipt()["fetchStatus"] == "not_applicable"


def test_observe_mode_success_over_a_running_instance_still_writes_durably(
    state_dir, monkeypatch, capsys
):
    # The asymmetry the evaluator must not flatten: unlike tree-provenance,
    # this producer's per-instance high-water mark is written in observe mode
    # too, so an observe-mode success here is stronger evidence.
    #
    # Method limit: probe_instance is stubbed, so this asserts the
    # classification the producer derives from the observation's own running
    # flag -- the same flag production derives it from -- not that a byte
    # reached disk.
    _stub_cycle(monkeypatch, observation=FRESH_OBSERVATION)

    assert _mod.run_once(instances=[FIXTURE_INSTANCE], dry_run=True) == 0
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["mode"] == "observe"
    assert receipt["outcome"] == "success"
    assert receipt["durableWrite"] == "written"


def test_observe_mode_success_over_a_stopped_fleet_owes_no_durable_write(
    state_dir, monkeypatch, capsys
):
    # Every discovered instance stopped: no emit, no pending-clear save, and
    # no high-water mark, yet the cycle succeeds. That is the one shape in
    # which this producer's observe-mode success is as weak as the tree
    # producer's, and an all-stopped fleet is an ordinary incident state.
    _stub_cycle(monkeypatch, observation=STOPPED_OBSERVATION)

    assert _mod.run_once(instances=[FIXTURE_INSTANCE], dry_run=True) == 0
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["outcome"] == "success"
    assert receipt["durableWrite"] == "not_owed"
