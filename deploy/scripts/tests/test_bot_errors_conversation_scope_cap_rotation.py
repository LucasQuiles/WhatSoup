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
import time
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
    "BOT_ERRORS_CONVERSATION_SCOPE_RETENTION_SECONDS",
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


def _load(state_dir: Path, cap: int, retention: int | None = None):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    os.environ["BOT_ERRORS_CONVERSATION_SCOPE_MAX_KEYS"] = str(cap)
    if retention is not None:
        os.environ["BOT_ERRORS_CONVERSATION_SCOPE_RETENTION_SECONDS"] = str(retention)
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


# ---------------------------------------------------------------------------
# The "represented after overflow" default must be scoped to what was EVICTED.
# ---------------------------------------------------------------------------
#
# A global "has anything ever evicted?" flag answers the wrong question. The
# call site asks whether THIS key was evicted, and the two diverge immediately:
# the sidecar empties for ordinary reasons (a closed incident's key is popped,
# aged records are popped and then the emptied key, the whole map is popped when
# empty, and the per-cycle sweep runs all of that on idle cycles). After one
# eviction anywhere, an absent key is the normal state, so a global flag
# silences every genuinely new conversation for the life of the state file.


def _fresh_conversation(mod, paths, key_index: int, scope_index: int, rnd: int) -> int:
    """One rejection for a NEW conversation on `key_index`; returns pages sent."""
    event_id = f"evt-k{key_index:04d}-s{scope_index:04d}-r{rnd}"
    event = {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "warning",
        "machine": MACHINE,
        "instance": f"instance-{key_index:04d}",
        "source": SOURCE,
        "id": event_id,
        "createdAt": mod.now_iso(),
        "conversationScope": f"cs1_{scope_index:016x}",
        "summary": {"failureClass": "unknown", "length": 44, "correlationDigest": "de" * 32},
        "evidence": {"failureClass": "Error", "length": 88, "correlationDigest": f"{scope_index:064d}"},
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    path = paths["outbox"] / f"20260902{rnd:06d}.instance-{key_index:04d}.{SOURCE}.{event_id}.json"
    path.write_text(json.dumps(event, indent=2))
    path.chmod(0o600)
    calls: list = []
    with patch.object(mod, "send_whatsapp", side_effect=lambda *a, **k: calls.append(a)):
        mod.run_once(64)
    return len(calls)


def test_a_new_conversation_on_a_never_evicted_key_still_pages(tmp_path):
    """Leg (a): an eviction ELSEWHERE must not silence an untouched key.

    The decisive shape, and the one a global flag gets wrong. Capacity
    eviction happens on some key. A DIFFERENT key that was never evicted then
    loses its sidecar entry the ordinary way -- its records age past the
    retention window and the sweep drops the emptied key -- while its incident
    stays open. Its next conversation is one nobody has been told about, and
    the gate exists to deliver exactly that.
    """
    cap = 8
    mod = _load(tmp_path / "never-evicted", cap, retention=1)
    paths = _dirs(mod)

    first = _round(mod, paths, cap + 1, 1)
    assert first == cap + 1, first
    state = mod.load_incident_state(paths)
    survivors = sorted(state.get("conversationScopes") or {})
    assert len(survivors) == cap, f"the fixture must evict for capacity: {len(survivors)}"
    survivor = survivors[-1]
    key_index = int(survivor.split("|")[1].split("-")[1])

    # Age every record out, then let an idle cycle sweep the emptied keys.
    time.sleep(2)
    with patch.object(mod, "send_whatsapp", side_effect=lambda *a, **k: None):
        mod.run_once(8)
    state = mod.load_incident_state(paths)
    assert not (state.get("conversationScopes") or {}), "the sweep must empty the sidecar"
    assert survivor in (state.get("openIncidents") or {}), "the incident must stay open"

    pages = _fresh_conversation(mod, paths, key_index, 9001, 2)

    assert pages == 1, (
        "a conversation nobody has been told about, under a key that was never "
        f"evicted, must still page: pages = {pages}"
    )


def test_an_evicted_keys_conversation_is_suppressed_then_pages_after_the_ttl(tmp_path):
    """Leg (b): the tombstone is bounded, not permanent."""
    cap = 8
    mod = _load(tmp_path / "tombstone-ttl", cap, retention=2)
    paths = _dirs(mod)

    _round(mod, paths, cap + 1, 1)
    state = mod.load_incident_state(paths)
    present = set(state.get("conversationScopes") or {})
    evicted = [
        index for index in range(cap + 1)
        if f"{MACHINE}|instance-{index:04d}|{SOURCE}" not in present
    ]
    assert evicted, "the fixture must actually evict a key"

    inside = _fresh_conversation(mod, paths, evicted[0], 9002, 2)
    assert inside == 0, (
        f"inside the tombstone window an evicted key's conversation must be "
        f"suppressed: pages = {inside}"
    )

    time.sleep(3)  # past the 2s retention window
    after = _fresh_conversation(mod, paths, evicted[0], 9003, 3)
    assert after == 1, (
        f"once the tombstone has expired the key must page again: pages = {after}"
    )


def test_an_idle_sweep_does_not_silence_a_new_conversation(tmp_path):
    """Leg (d): emptying the sidecar is not the same as evicting for capacity."""
    cap = 8
    mod = _load(tmp_path / "idle-then-new", cap)
    paths = _dirs(mod)

    _round(mod, paths, cap + 1, 1)
    calls: list = []
    with patch.object(mod, "send_whatsapp", side_effect=lambda *a, **k: calls.append(a)):
        mod.run_once(8)  # idle cycle: sweeps, no queued events
    assert calls == [], "the idle cycle must not page"

    pages = _fresh_conversation(mod, paths, cap + 40, 9004, 2)

    assert pages == 1, (
        f"a brand-new key after an idle sweep must page: pages = {pages}"
    )


def _scopeless_alert(mod, paths, key_index: int, rnd: int) -> int:
    """An admission rejection carrying NO conversationScope."""
    event_id = f"evt-noscope-k{key_index:04d}-r{rnd}"
    event = {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "warning",
        "machine": MACHINE,
        "instance": f"instance-{key_index:04d}",
        "source": SOURCE,
        "id": event_id,
        "createdAt": mod.now_iso(),
        "summary": {"failureClass": "unknown", "length": 44, "correlationDigest": "de" * 32},
        "evidence": {"failureClass": "Error", "length": 88, "correlationDigest": f"{key_index:064d}"},
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    path = paths["outbox"] / f"20260902{rnd:06d}.instance-{key_index:04d}.{SOURCE}.{event_id}.json"
    path.write_text(json.dumps(event, indent=2))
    path.chmod(0o600)
    calls: list = []
    with patch.object(mod, "send_whatsapp", side_effect=lambda *a, **k: calls.append(a)):
        mod.run_once(64)
    return len(calls)


def test_an_incident_opened_without_a_conversation_still_admits_a_new_one(tmp_path):
    """Leg (e): an open incident with NO subtree is not an evicted key.

    An admission rejection can arrive with no conversationScope at all. It
    opens an incident and records no sidecar subtree, so that key looks
    exactly like one whose records were dropped. Under a global "something
    evicted" flag the next genuinely new conversation under that key was
    silenced; the tombstone is per key, and this key has none, so it pages.
    """
    cap = 8
    mod = _load(tmp_path / "scopeless", cap)
    paths = _dirs(mod)

    # A capacity eviction elsewhere, so any global overflow signal is latched.
    _round(mod, paths, cap + 1, 1)
    state = mod.load_incident_state(paths)
    assert len(state.get("conversationScopes") or {}) == cap, "the fixture must evict"

    key_index = cap + 700
    assert _scopeless_alert(mod, paths, key_index, 2) == 1, "the scopeless alert must page"
    state = mod.load_incident_state(paths)
    key = f"{MACHINE}|instance-{key_index:04d}|{SOURCE}"
    assert key in (state.get("openIncidents") or {}), "it must open an incident"
    assert key not in (state.get("conversationScopes") or {}), "and record no subtree"

    pages = _fresh_conversation(mod, paths, key_index, 9005, 3)

    assert pages == 1, (
        "a genuinely new conversation under an incident opened without one "
        f"must page: pages = {pages}"
    )


def test_a_tombstone_survives_the_closed_incident_sweep(tmp_path):
    """The tombstone must outlive the branch that drops the key's subtree.

    The sweep pops the whole per-key subtree when the incident is no longer
    open. A tombstone stored inside that subtree would die in the same window
    the terminal-replay repair does, and the eviction it records would be
    forgotten while the eviction's consequences persist. It lives at the state
    root instead, and this pins that placement rather than leaving it to
    inspection.
    """
    cap = 8
    mod = _load(tmp_path / "tombstone-survives", cap)
    now = int(time.time())
    key = f"{MACHINE}|instance-gone|{SOURCE}"

    state = {
        "version": 1,
        "openIncidents": {},  # incident CLOSED: the sweep drops this key's subtree
        "lastSentAt": {},
        "conversationScopes": {key: {"cs1_00000000000000aa": {"lastSeenAt": now, "eventIds": {}}}},
        mod.CONVERSATION_SCOPE_EVICTED_FIELD: {key: now},
    }

    mod.sweep_conversation_scopes(state, now)

    assert key not in (state.get("conversationScopes") or {}), (
        "the closed-incident branch must still drop the subtree"
    )
    assert key in (state.get(mod.CONVERSATION_SCOPE_EVICTED_FIELD) or {}), (
        "the eviction tombstone must survive the sweep that drops the subtree"
    )
