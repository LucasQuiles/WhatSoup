"""Tests for #2505: deletion-aware runtime staleness via a persisted high-water mark.

The mark is scoped to (instance, boot_epoch): deleting a post-boot source file
cannot flip a verdict back to fresh within the same boot, while a restart or a
different instance never inherits someone else's staleness floor.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-runtime-staleness.py"


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_runtime_st", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load()


def test_is_stale_post_boot_epoch():
    """Newest src mtime > boot epoch → stale (existing behavior)."""
    assert _mod.is_stale(100, 200) is True


def test_is_stale_fresh_pre_boot_epoch():
    """Newest src mtime < boot epoch → fresh (existing behavior)."""
    assert _mod.is_stale(200, 100) is False


def test_deletion_keeps_stale_via_high_water_mark(tmp_path, monkeypatch):
    """Post-boot src observed, then deleted: the mark keeps the verdict stale."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    boot = 100

    effective = _mod.update_staleness_mark("demo", boot, 500)
    assert _mod.is_stale(boot, effective) is True

    # Second probe after deletion: newest surviving src predates boot, but the
    # same-boot mark holds the true staleness floor.
    effective = _mod.update_staleness_mark("demo", boot, 50)
    assert effective == 500
    assert _mod.is_stale(boot, effective) is True


def test_mark_monotone_within_boot(tmp_path, monkeypatch):
    """A lower src epoch within the same boot never lowers the mark."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    assert _mod.update_staleness_mark("demo", 100, 500) == 500
    assert _mod.update_staleness_mark("demo", 100, 300) == 500
    assert _mod.update_staleness_mark("demo", 100, 700) == 700


def test_new_boot_cycle_voids_prior_mark(tmp_path, monkeypatch):
    """After a restart the process runs on-disk code: the old mark must not apply."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    _mod.update_staleness_mark("demo", 100, 500)  # stale under boot=100

    effective = _mod.update_staleness_mark("demo", 1000, 50)  # restarted
    assert effective == 50
    assert _mod.is_stale(1000, effective) is False


def test_cross_instance_isolation(tmp_path, monkeypatch):
    """One stale instance must not poison another instance's verdict."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    _mod.update_staleness_mark("stale-one", 100, 500)

    effective = _mod.update_staleness_mark("fresh-one", 100, 50)
    assert effective == 50
    assert _mod.is_stale(100, effective) is False


def test_fresh_boot_no_prior_state_stays_fresh(tmp_path, monkeypatch):
    """First probe ever, src < boot → fresh (no regression)."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    effective = _mod.update_staleness_mark("demo", 200, 100)
    assert _mod.is_stale(200, effective) is False


def test_corrupt_state_file_recovers(tmp_path, monkeypatch):
    """Truncated/garbage state is treated as empty and rewritten, not fatal."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    (tmp_path / "runtime-staleness-state.json").write_text("{not json", encoding="utf-8")

    assert _mod.update_staleness_mark("demo", 100, 500) == 500
    state = _mod.load_staleness_state()
    assert state["instances"]["demo"] == {"bootEpoch": 100, "maxSrcEpoch": 500}


def test_non_dict_state_treated_as_empty(tmp_path, monkeypatch):
    """A JSON document that is not an object is discarded, not crashed on."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    (tmp_path / "runtime-staleness-state.json").write_text("[1, 2]", encoding="utf-8")

    assert _mod.load_staleness_state() == {}
    assert _mod.update_staleness_mark("demo", 100, 500) == 500


def test_state_write_is_atomic_no_tmp_residue(tmp_path, monkeypatch):
    """Updates go through rename; no .tmp file survives a successful update."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    _mod.update_staleness_mark("demo", 100, 500)

    assert not list(tmp_path.glob("*.tmp"))
    on_disk = json.loads(
        (tmp_path / "runtime-staleness-state.json").read_text(encoding="utf-8")
    )
    assert on_disk["instances"]["demo"]["maxSrcEpoch"] == 500


def test_legacy_unscoped_state_is_ignored(tmp_path, monkeypatch):
    """A pre-scoping state file (bare maxSrcEpoch) must not poison verdicts."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    (tmp_path / "runtime-staleness-state.json").write_text(
        json.dumps({"maxSrcEpoch": 999999}), encoding="utf-8"
    )

    effective = _mod.update_staleness_mark("demo", 200, 100)
    assert effective == 100
    assert _mod.is_stale(200, effective) is False
