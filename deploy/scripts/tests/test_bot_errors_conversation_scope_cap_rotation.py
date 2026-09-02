"""The outer key cap must not turn into a rotating force-notify loop.

The sweep bounds the sidecar to CONVERSATION_SCOPE_MAX_KEYS top-level keys by
evicting the least recently seen. Once the sweep runs on the production save
path, that eviction happens on every commit, and the admission guard used to
read an evicted key as a conversation it had never represented: it force
notified, re-added the key, and evicted another. Above the cap, with cyclic
traffic, every recurrence paged forever and each one also escaped an open
flap storm.

The per-key policy already had the answer: when a key overflows, a sticky
marker inside it tells the guard to treat untracked scopes as represented
rather than new. These tests pin the same policy at the top level, driven
through run_once so the production save path is the one under test.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
_SCRIPT = _SCRIPTS / "bot-errors-dispatcher.py"
sys.path.insert(0, str(_SCRIPTS))
sys.path.insert(0, str(_SCRIPTS / "lib"))

SOURCE = "agent_turn_admission_rejected"
MACHINE = "unknown"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_CONVERSATION_SCOPE_MAX_KEYS",
    "BOT_ERRORS_CONVERSATION_SCOPED_SOURCES",
]


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


def _load(state_dir: Path, cap: int):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    os.environ["BOT_ERRORS_CONVERSATION_SCOPE_MAX_KEYS"] = str(cap)
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location(
        f"bot_errors_dispatcher_cap_{state_dir.name}", _SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _dirs(mod):
    paths = mod.setup_dirs()
    os.chmod(paths["incident_state"].parent, 0o700)
    return paths


def _write(mod, paths, index: int, rnd: int) -> None:
    """One rejection for conversation `index`, as the emitter would write it."""
    event_id = f"evt-k{index:04d}-r{rnd}"
    event = {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "warning",
        "machine": MACHINE,
        "instance": f"instance-{index:04d}",
        "source": SOURCE,
        "id": event_id,
        "createdAt": mod.now_iso(),
        "conversationScope": f"cs1_{index:016x}",
        "summary": {"failureClass": "unknown", "length": 44, "correlationDigest": "de" * 32},
        "evidence": {"failureClass": "Error", "length": 88, "correlationDigest": f"{index:064d}"},
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    path = paths["outbox"] / f"2026090200000{rnd}.instance-{index:04d}.{SOURCE}.{event_id}.json"
    path.write_text(json.dumps(event, indent=2))
    path.chmod(0o600)


def _round(mod, paths, keys: int, rnd: int) -> int:
    """One full dispatcher cycle; returns how many operator pages it sent."""
    for index in range(keys):
        _write(mod, paths, index, rnd)
    calls: list = []
    with patch.object(mod, "send_whatsapp", side_effect=lambda *a, **k: calls.append(a)):
        mod.run_once(keys * 4)
    return len(calls)


def test_above_the_cap_repeats_stay_suppressed_across_cycles(tmp_path):
    """cap+1 conversations, three cycles: only the first round may page."""
    cap = 8
    mod = _load(tmp_path / "rotate", cap)
    paths = _dirs(mod)
    keys = cap + 1

    pages = [_round(mod, paths, keys, rnd) for rnd in (1, 2, 3)]

    assert pages[0] == keys, f"every conversation's first rejection must page: {pages}"
    assert pages[1:] == [0, 0], (
        "a conversation already represented must not page again after the key "
        f"cap evicted its record: pages per round = {pages}"
    )


def test_above_the_cap_repeats_stay_suppressed_under_an_open_storm(tmp_path):
    """Same, with real flap storms open: an evicted key must not escape one.

    The storm is TRIPPED by the detector rather than hand-written into
    flapState. A hand-written entry does not survive a cycle: sweep_flap_storms
    prunes an entry with no trip history and resolves a storm whose members
    have gone quiet, so the fixture would be gone before the assertion ran.
    """
    cap = 8
    mod = _load(tmp_path / "storm", cap)
    paths = _dirs(mod)
    keys = cap + 1

    first = _round(mod, paths, keys, 1)
    assert first == keys, first

    # Trip a storm per key the way production does: FLAP_TRIP_THRESHOLD
    # rejections for the same key inside the window. These extra events are
    # storm members, so they must not page either.
    for burst in range(mod.FLAP_TRIP_THRESHOLD + 1):
        for index in range(keys):
            _write(mod, paths, index, 90 + burst)
        with patch.object(mod, "send_whatsapp", side_effect=lambda *a, **k: None):
            mod.run_once(keys * 4)

    state = mod.load_incident_state(paths)
    storms = [
        key
        for key, entry in (state.get("flapState") or {}).items()
        if isinstance(entry, dict) and entry.get("stormAt")
    ]
    assert storms, "the fixture must actually open at least one flap storm"

    pages = [_round(mod, paths, keys, rnd) for rnd in (2, 3)]

    assert pages == [0, 0], (
        "an evicted conversation must stay consolidated in an open storm "
        f"rather than escaping it: pages per round = {pages}"
    )


def test_a_new_conversation_still_pages_when_nothing_was_evicted(tmp_path):
    """DISCRIMINATOR: 'missing key' must not mean 'represented' by default.

    At exactly the cap with no eviction, a genuinely new conversation is new
    and must page. Without this, the fix would silently swallow first
    sightings whenever a state file was merely truncated, which is the
    alert-loss failure the whole gate exists to remove.
    """
    cap = 8
    mod = _load(tmp_path / "under", cap)
    paths = _dirs(mod)

    first = _round(mod, paths, cap, 1)
    assert first == cap, first
    state = mod.load_incident_state(paths)
    assert len(state.get("conversationScopes") or {}) == cap, "no eviction may have happened"

    for index in range(cap, cap + 1):
        _write(mod, paths, index, 2)
    calls: list = []
    with patch.object(mod, "send_whatsapp", side_effect=lambda *a, **k: calls.append(a)):
        mod.run_once(16)

    assert len(calls) == 1, (
        "a conversation nobody has been told about must still page when no "
        f"eviction has occurred: pages = {len(calls)}"
    )
