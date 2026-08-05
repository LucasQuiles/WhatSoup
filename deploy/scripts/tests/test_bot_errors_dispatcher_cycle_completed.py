"""Tests for #2483: dispatcher cycle completion marker + deadman detection."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load()


def _setup_paths(tmp_path: Path):
    """Create a minimal paths dict for record_state."""
    dirs = {
        "outbox", "processing", "sent", "suppressed", "quarantine",
        "storm_collapsed", "storm_manifests", "logs", "locks",
        "writefail_recovered", "writefail_quarantine", "testleak",
    }
    paths = {}
    for name in dirs:
        d = tmp_path / name
        d.mkdir(parents=True, exist_ok=True)
        paths[name] = d
    paths["state"] = tmp_path / "dispatcher-state.json"
    paths["root"] = tmp_path
    paths["incident_state"] = tmp_path / "incident-state.json"
    return paths


def test_record_state_accepts_cycle_completed_at(tmp_path):
    """record_state with cycleCompletedAt must include it in the persisted state."""
    paths = _setup_paths(tmp_path)
    _mod.record_state(paths, lastRunAt="2026-08-05T20:00:00Z", cycleCompletedAt="2026-08-05T20:00:01Z")
    state = json.loads(paths["state"].read_text(encoding="utf-8"))
    assert state.get("cycleCompletedAt") == "2026-08-05T20:00:01Z"


def test_record_state_without_cycle_completed_at(tmp_path):
    """record_state without cycleCompletedAt must NOT include it (crash cycle)."""
    paths = _setup_paths(tmp_path)
    _mod.record_state(paths, lastRunAt="2026-08-05T20:00:00Z", failed=1, lastError="crash")
    state = json.loads(paths["state"].read_text(encoding="utf-8"))
    assert "cycleCompletedAt" not in state, "crash cycle must not have cycleCompletedAt"
