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


def test_observe_mode_is_recorded_as_observe(state_dir, monkeypatch, capsys):
    _stub_clean_snapshot(monkeypatch)

    assert _mod.run_once(do_fetch=False, dry=True, reporter=True) == 0
    capsys.readouterr()

    receipt = _receipt()
    assert receipt["mode"] == "observe"
    assert receipt["lastSuccessfulObservationAt"]


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
