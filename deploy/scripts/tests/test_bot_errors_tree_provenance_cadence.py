"""Tree-provenance cadence-receipt wiring (#2341, leaf 1).

Exercises the producer's own cycle entry, ``run_once``, so the assertion is
about where the two clocks are stamped rather than about the receipt module in
isolation. The domain observation is supplied as a fixture snapshot: what is
under test is the cadence stamping, and a real git tree would make the success
path depend on the state of whatever repo the suite happens to run in.
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

_SCRIPT = _SCRIPTS / "bot-errors-tree-provenance.py"
TREE = pcr.ProducerIdentity.TREE_PROVENANCE


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_tree_provenance_cadence", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()

# A clean offline snapshot: no finding, so run_once takes its success path.
# Key set mirrors gather_tree_provenance's return so provenance_findings runs
# against the real shape rather than a subset that would fail for the wrong
# reason.
CLEAN_SNAPSHOT = {
    "repo_fingerprint": "0" * 12,
    "head": "0" * 40,
    "branch": "feature",
    "branch_redacted": "feature",
    "detached": False,
    "upstream": "origin/feature",
    "upstream_redacted": "origin/feature",
    "upstream_resolved": True,
    "dirty_count": 0,
    "ahead": 0,
    "behind": 0,
    "ancestry": "same",
    "protected_branch": False,
    "phantom_src": [],
    "fetch_attempted": False,
    "fetch_error": None,
}


@pytest.fixture()
def state_dir(tmp_path, monkeypatch):
    root = tmp_path / "bot-errors"
    root.mkdir(mode=0o700)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(root))
    return root


def _receipt():
    return json.loads(pcr.receipt_path(TREE).read_text(encoding="utf-8"))


def _stub_clean_snapshot(monkeypatch):
    monkeypatch.setattr(_mod, "gather_tree_provenance", lambda *a, **k: dict(CLEAN_SNAPSHOT))


def _stub_inspection_error(monkeypatch):
    def _raise(*_args, **_kwargs):
        raise _mod.GitError("fixture inspection failure")

    monkeypatch.setattr(_mod, "gather_tree_provenance", _raise)


def test_completed_cycle_stamps_both_clocks(state_dir, monkeypatch, capsys):
    _stub_clean_snapshot(monkeypatch)
    emitted: list[object] = []
    monkeypatch.setattr(_mod, "emit_outbox_event", lambda event: emitted.append(event))

    assert _mod.run_once(do_fetch=False, dry=False, reporter=True) == 0
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["schemaVersion"] == pcr.CADENCE_RECEIPT_SCHEMA_VERSION
    assert receipt["producer"] == "bot-errors-tree-provenance"
    assert receipt["lastAttemptAt"]
    assert receipt["lastSuccessfulObservationAt"]
    assert receipt["outcome"] == "success"
    assert receipt["mode"] == "emit"
    assert receipt["durableWrite"] == "written"
    assert emitted, "the fixture cycle must reach its durable domain write"


def test_inspection_error_advances_only_the_attempt_clock(state_dir, monkeypatch, capsys):
    _stub_inspection_error(monkeypatch)

    assert _mod.run_once(do_fetch=False, dry=False, reporter=True) == 2
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["lastAttemptAt"]
    assert receipt["lastSuccessfulObservationAt"] is None
    assert receipt["outcome"] == "probe_error"
    assert receipt["stage"] == "observation"
    # The cycle died before it owed anything durable, which is a different
    # state from owing a write and failing it.
    assert receipt["durableWrite"] == "not_reached"


def test_inspection_error_after_a_success_preserves_the_success_clock(
    state_dir, monkeypatch, capsys
):
    _stub_clean_snapshot(monkeypatch)
    monkeypatch.setattr(_mod, "emit_outbox_event", lambda event: None)
    assert _mod.run_once(do_fetch=False, dry=False, reporter=True) == 0
    success_stamp = _receipt()["lastSuccessfulObservationAt"]
    assert success_stamp

    _stub_inspection_error(monkeypatch)
    assert _mod.run_once(do_fetch=False, dry=False, reporter=True) == 2
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["lastSuccessfulObservationAt"] == success_stamp
    assert receipt["outcome"] == "probe_error"


def test_event_write_failure_does_not_advance_the_success_clock(
    state_dir, monkeypatch, capsys
):
    _stub_clean_snapshot(monkeypatch)

    def _fail(_event):
        raise OSError("fixture outbox failure")

    monkeypatch.setattr(_mod, "emit_outbox_event", _fail)

    assert _mod.run_once(do_fetch=False, dry=False, reporter=True) == 1
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["lastAttemptAt"]
    assert receipt["lastSuccessfulObservationAt"] is None
    assert receipt["outcome"] == "emit_failure"
    assert receipt["stage"] == "durable_write"
    assert receipt["durableWrite"] == "failed"


def test_observe_mode_is_recorded_as_observe(state_dir, monkeypatch, capsys):
    _stub_clean_snapshot(monkeypatch)

    assert _mod.run_once(do_fetch=False, dry=True, reporter=True) == 0
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["mode"] == "observe"
    assert receipt["lastSuccessfulObservationAt"]


def test_observe_mode_success_records_that_nothing_durable_was_owed(
    state_dir, monkeypatch, capsys
):
    # This producer skips its only durable write in observe mode, so an
    # observe-mode success clock records "the inspection completed", not "an
    # observation was durably written". The receipt has to say which, because
    # the installer admits only observe mode and the evaluator would otherwise
    # weight a soak cycle as full emit-mode proof.
    _stub_clean_snapshot(monkeypatch)
    emitted: list[object] = []
    monkeypatch.setattr(_mod, "emit_outbox_event", lambda event: emitted.append(event))

    assert _mod.run_once(do_fetch=False, dry=True, reporter=True) == 0
    capsys.readouterr()

    assert emitted == [], "observe mode must not reach the durable domain write"
    receipt = _receipt()
    assert receipt["outcome"] == "success"
    assert receipt["durableWrite"] == "not_owed"


def test_offline_cycle_records_fetch_not_attempted(state_dir, monkeypatch, capsys):
    _stub_clean_snapshot(monkeypatch)
    monkeypatch.setattr(_mod, "emit_outbox_event", lambda event: None)

    assert _mod.run_once(do_fetch=False, dry=False, reporter=True) == 0
    capsys.readouterr()

    # The scheduled path is offline by contract, so the receipt must say so
    # explicitly rather than leaving a reader to assume it.
    assert _receipt()["fetchStatus"] == "not_attempted"


def test_successful_refresh_is_recorded_as_requested(state_dir, monkeypatch, capsys):
    snapshot = dict(CLEAN_SNAPSHOT)
    snapshot["fetch_attempted"] = True
    monkeypatch.setattr(_mod, "gather_tree_provenance", lambda *a, **k: dict(snapshot))
    monkeypatch.setattr(_mod, "emit_outbox_event", lambda event: None)

    assert _mod.run_once(do_fetch=True, dry=False, reporter=True) == 0
    capsys.readouterr()

    assert _receipt()["fetchStatus"] == "requested"


def test_a_failing_receipt_write_leaves_the_cycle_and_its_domain_write_intact(
    state_dir, monkeypatch, capsys
):
    # The swallow is what makes a dark receipt safe to ship: the guard's own
    # verdict is what operators depend on today, so a receipt that cannot be
    # written must degrade to a stderr line rather than abort the cycle.
    # Without a test, a later refactor could turn the swallow into a crash, or
    # drop the token, with every gate still green.
    _stub_clean_snapshot(monkeypatch)
    emitted: list[object] = []
    monkeypatch.setattr(_mod, "emit_outbox_event", lambda event: emitted.append(event))

    def _raise(*_args, **_kwargs):
        raise RuntimeError("fixture receipt failure")

    # Exactly one recorder raises, so "one token" is unambiguous.
    monkeypatch.setattr(_mod, "record_cycle_success", _raise)

    assert _mod.run_once(do_fetch=False, dry=False, reporter=True) == 0
    captured = capsys.readouterr()

    assert emitted, "the domain write must still land when the receipt fails"
    token_lines = [
        line for line in captured.err.splitlines() if "cadence_receipt_error" in line
    ]
    assert token_lines == ["tree_provenance cadence_receipt_error RuntimeError"]


def test_failed_refresh_is_recorded_as_refused(state_dir, monkeypatch, capsys):
    # The case the issue thread names: the cycle completed, but its upstream
    # comparison was against a ref it could not prove current. A success clock
    # that advanced without recording this would read as full proof.
    snapshot = dict(CLEAN_SNAPSHOT)
    snapshot["fetch_attempted"] = True
    snapshot["fetch_error"] = "fetch_failed:rc=128"
    monkeypatch.setattr(_mod, "gather_tree_provenance", lambda *a, **k: dict(snapshot))
    monkeypatch.setattr(_mod, "emit_outbox_event", lambda event: None)

    assert _mod.run_once(do_fetch=True, dry=False, reporter=True) == 0
    capsys.readouterr()

    assert _receipt()["fetchStatus"] == "refused"
