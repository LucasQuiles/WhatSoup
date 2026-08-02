"""Regression tests for #2427 (quick slice): collector dedupe must cover the
dispatcher's dead-letter directory.

Falsifier reproduced in the issue: the identity parser (local_record_event_identity)
already understands the dead-letter record's nested `event` object, but
local_event_exists() omitted `dead-letter` from its candidate directories, so a
delayed remote claim matching a terminal dead-letter record was never recognized
as already-delivered. Without the fix, a reoffered remote claim would resurrect
the terminal event with a fresh outbox copy and a reset delivery budget.

This slice only adds the missing directory to the dedupe inventory. It does not
touch fail-closed diagnostics, retention protocol, missing/empty remote identity
handling, or the testleak terminal directory -- those remain open under #2427.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

# Shared module loader / tmp_state fixture -- see conftest.py docstring.
# Loaded via importlib (not `from conftest import ...`) because this repo's
# collector test suites run under --import-mode=importlib, which does not
# add the test directory to sys.path.
_CONFTEST_PATH = Path(__file__).resolve().parent / "conftest.py"
_conftest_spec = importlib.util.spec_from_file_location("bot_errors_collector_test_conftest", _CONFTEST_PATH)
_conftest = importlib.util.module_from_spec(_conftest_spec)  # type: ignore[arg-type]
_conftest_spec.loader.exec_module(_conftest)  # type: ignore[union-attr]

_load_mod_with_dirs = _conftest._load_mod_with_dirs
_env = _conftest._env


def _dead_letter_record(event_id: str, created_at: str) -> dict[str, object]:
    """Shape written by bot-errors-dispatcher.py's move_to_dead_letter(): the
    original event nested under an "event" key, alongside terminal delivery
    metadata."""
    return {
        "event": {
            "id": event_id,
            "createdAt": created_at,
            "source": "outbound_delivery_ambiguous",
            "summary": "terminal test record",
        },
        "delivery": {"status": "dead_letter", "terminatedAt": "2026-08-02T00:00:00Z"},
        "terminated_at": "2026-08-02T00:00:00Z",
    }


def test_local_event_exists_finds_nested_dead_letter_record(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    dead_letter_dir = state_dir / "dead-letter"
    dead_letter_dir.mkdir(mode=0o700)
    record = _dead_letter_record("terminal-event-1", "2026-08-01T12:00:00.000Z")
    (dead_letter_dir / "terminal-event-1.dead_letter.json").write_text(
        json.dumps(record), encoding="utf-8"
    )

    # local_event_exists() reads BOT_ERRORS_STATE_DIR at call time via
    # state_root() -- _load_mod_with_dirs() only sets it during module exec,
    # so the call itself must stay inside _env() or it silently falls back
    # to the real ~/.local/state/bot-errors on the host.
    with _env(state_dir, outbox_dir):
        assert mod.local_event_exists("terminal-event-1") is True


def test_local_event_exists_respects_created_at_on_dead_letter_record(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    dead_letter_dir = state_dir / "dead-letter"
    dead_letter_dir.mkdir(mode=0o700)
    record = _dead_letter_record("terminal-event-2", "2026-08-01T12:00:00.000Z")
    (dead_letter_dir / "terminal-event-2.dead_letter.json").write_text(
        json.dumps(record), encoding="utf-8"
    )

    # Same id, differing non-empty createdAt: a reused identity with a new
    # creation time must not be treated as the same terminal record.
    with _env(state_dir, outbox_dir):
        assert mod.local_event_exists("terminal-event-2", created_at="2026-08-01T13:00:00.000Z") is False


def test_local_event_exists_false_for_unrelated_id_with_dead_letter_present(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    dead_letter_dir = state_dir / "dead-letter"
    dead_letter_dir.mkdir(mode=0o700)
    record = _dead_letter_record("terminal-event-3", "2026-08-01T12:00:00.000Z")
    (dead_letter_dir / "terminal-event-3.dead_letter.json").write_text(
        json.dumps(record), encoding="utf-8"
    )

    with _env(state_dir, outbox_dir):
        assert mod.local_event_exists("some-other-event-id") is False


def test_local_event_exists_false_when_dead_letter_directory_absent(tmp_state):
    """No dead-letter/ directory at all (e.g. dispatcher never created one) must
    not raise -- local_event_exists already tolerates missing candidate dirs."""
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)

    assert (state_dir / "dead-letter").exists() is False
    with _env(state_dir, outbox_dir):
        assert mod.local_event_exists("terminal-event-4") is False
