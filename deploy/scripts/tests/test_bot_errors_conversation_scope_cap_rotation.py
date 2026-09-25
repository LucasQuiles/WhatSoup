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
import re
import time
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
_SCRIPT = _SCRIPTS / "bot-errors-dispatcher.py"
sys.path.insert(0, str(_SCRIPTS))
sys.path.insert(0, str(_SCRIPTS / "lib"))

# The shipped retention default, stated as a literal ON PURPOSE. The ageing
# helper seeds against this rather than against the module's constant, so
# widening the window makes the expiry leg fail instead of tracking it.
SHIPPED_RETENTION_SECONDS = 7 * 24 * 3600

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


def _age_state_past_retention(mod, paths, margin: int = 60) -> None:
    """Push every scope record and tombstone past the retention window.

    Deterministic by construction: the code under test compares stored
    timestamps against `time.time()`, so moving the stored values backwards is
    the same input a real wait would eventually produce, without the wait.

    The age is ABSOLUTE, not derived from the retention constant. Deriving it
    would make these legs insensitive to that constant: widen the window and
    the seed widens with it, so the leg would pass under any retention value
    and stop being a coverage assertion at all. Seeding a fixed age keeps the
    leg falsifiable -- widening the window past this age must make the expiry
    leg fail. The assertion below pins the shipped default, so a deliberate
    change to it fails here loudly and self-explaining rather than silently
    weakening the leg.
    """
    from lib.controller_state import open_controller_state

    assert mod.CONVERSATION_SCOPE_RETENTION_SECONDS == SHIPPED_RETENTION_SECONDS, (
        "the retention default moved: these legs seed a fixed age of "
        f"{SHIPPED_RETENTION_SECONDS}s + margin so they stay sensitive to it. "
        f"Update SHIPPED_RETENTION_SECONDS to "
        f"{mod.CONVERSATION_SCOPE_RETENTION_SECONDS} deliberately, never by "
        "deriving the seed from the constant."
    )
    session = open_controller_state(
        paths["incident_state"],
        component="dispatcher-incident",
        bootstrap=mod.dispatcher_bootstrap_state,
        validate_payload=mod.validate_dispatcher_state,
        lock_timeout_seconds=10,
    )
    stale = int(time.time()) - SHIPPED_RETENTION_SECONDS - margin
    with session:
        result = session.load()
        payload = dict(result.payload or {})
        for records in (payload.get("conversationScopes") or {}).values():
            if isinstance(records, dict):
                for record in records.values():
                    if isinstance(record, dict):
                        record["lastSeenAt"] = stale
        stones = payload.get(mod.CONVERSATION_SCOPE_EVICTED_FIELD)
        if isinstance(stones, dict):
            payload[mod.CONVERSATION_SCOPE_EVICTED_FIELD] = {k: stale for k in stones}
        session.save(payload, result.capability)


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
    mod = _load(tmp_path / "never-evicted", cap)
    paths = _dirs(mod)

    first = _round(mod, paths, cap + 1, 1)
    assert first == cap + 1, first
    state = mod.load_incident_state(paths)
    survivors = sorted(state.get("conversationScopes") or {})
    assert len(survivors) == cap, f"the fixture must evict for capacity: {len(survivors)}"
    survivor = survivors[-1]
    key_index = int(survivor.split("|")[1].split("-")[1])

    # Age every record out, then let an idle cycle sweep the emptied keys.
    _age_state_past_retention(mod, paths)
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
    mod = _load(tmp_path / "tombstone-ttl", cap)
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

    # Expire the tombstone by moving its stamp back, not by waiting for it.
    _age_state_past_retention(mod, paths)
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


# ---------------------------------------------------------------------------
# The retention window, pinned against the value the documentation states.
# ---------------------------------------------------------------------------
#
# The legs above seed a fixed age and so fail if the constant widens past it,
# but they do not say what the constant SHOULD be. These do: they read the
# documented default out of docs/configuration.md and assert the behaviour
# changes on either side of it. Code and documentation drifting apart fails
# here, in the direction that matters -- an operator reading the retention row
# is told exactly when a conversation can force a notification again.


def _documented_retention_seconds() -> int:
    """The retention default as docs/configuration.md states it."""
    doc = (Path(__file__).resolve().parents[3] / "docs" / "configuration.md").read_text()
    row = next(
        line for line in doc.splitlines()
        if "BOT_ERRORS_CONVERSATION_SCOPE_RETENTION_SECONDS" in line and "|" in line
    )
    value = re.search(r"\|\s*`(\d+)`\s*\(", row) or re.search(r"\|\s*`(\d+)`\s*\|", row)
    assert value, f"could not read the documented retention default from: {row!r}"
    return int(value.group(1))


def test_the_retention_window_matches_the_documented_value(tmp_path):
    """A record one second past the documented window is swept; one second inside is kept."""
    documented = _documented_retention_seconds()
    mod = _load(tmp_path / "retention-boundary", 8)
    assert mod.CONVERSATION_SCOPE_RETENTION_SECONDS == documented, (
        f"code retention {mod.CONVERSATION_SCOPE_RETENTION_SECONDS}s disagrees with "
        f"docs/configuration.md {documented}s"
    )

    now = int(time.time())
    key = f"{MACHINE}|instance-0000|{SOURCE}"

    def sweep_with_age(age: int) -> bool:
        state = {
            "version": 1,
            "openIncidents": {key: {"status": "open"}},
            "lastSentAt": {},
            "conversationScopes": {key: {"cs1_00000000000000aa": {
                "lastSeenAt": now - age, "eventIds": {}}}},
        }
        mod.sweep_conversation_scopes(state, now)
        return key in (state.get("conversationScopes") or {})

    assert sweep_with_age(documented - 1), (
        f"a record {documented - 1}s old is inside the documented window and must be kept"
    )
    assert not sweep_with_age(documented + 1), (
        f"a record {documented + 1}s old is past the documented window and must be swept"
    )


def test_the_tombstone_ttl_matches_the_documented_value(tmp_path):
    """The eviction tombstone expires on the same documented window."""
    documented = _documented_retention_seconds()
    mod = _load(tmp_path / "tombstone-boundary", 8)

    now = int(time.time())
    key = f"{MACHINE}|instance-0000|{SOURCE}"

    def evicted_at(age: int) -> bool:
        state = {mod.CONVERSATION_SCOPE_EVICTED_FIELD: {key: now - age}}
        return mod.conversation_scope_key_was_evicted(state, key, now)

    assert evicted_at(documented - 1), (
        f"a tombstone {documented - 1}s old is inside the documented window and must hold"
    )
    assert not evicted_at(documented + 1), (
        f"a tombstone {documented + 1}s old is past the documented window and must expire"
    )


# ---------------------------------------------------------------------------
# Saturation: more cycling keys than BOTH maps can hold together.
# ---------------------------------------------------------------------------
#
# A key is suppressed only if it sits in conversationScopes or carries an exact
# tombstone. Both maps are bounded by the same cap with oldest-drop, so at most
# 2C keys can be known at once. Cycling 2C+1 distinct keys guarantees at least
# one key is in neither map every round: it pages, and recording it evicts
# another key and drops another tombstone, cascading through the whole set
# inside one cycle. Exactness cannot survive that -- "every new conversation
# pages" and "every evicted conversation stays suppressed" cannot both hold in
# finite exact state -- so the contract says which yields: above saturation,
# suppression wins, and the state file records that it is in force.


def _seed_open_incident_without_records(mod, paths, key: str, now: int) -> None:
    """An open incident whose scope subtree is gone, neighbours untouched."""
    from lib.controller_state import open_controller_state

    session = open_controller_state(
        paths["incident_state"],
        component="dispatcher-incident",
        bootstrap=mod.dispatcher_bootstrap_state,
        validate_payload=mod.validate_dispatcher_state,
        lock_timeout_seconds=10,
    )
    with session:
        result = session.load()
        payload = dict(result.payload or {})
        payload.setdefault("openIncidents", {})[key] = {
            "status": "open", "openedAt": now - 600, "lastSeenAt": now,
        }
        payload.setdefault("lastSentAt", {})[key] = now - 60
        session.save(payload, result.capability)


def test_cycling_more_keys_than_both_maps_hold_does_not_re_page_every_round(tmp_path):
    """MUST-4: above 2C keys the gate must not amplify."""
    cap = 2
    keys = cap * 2 + 1
    mod = _load(tmp_path / "saturation-small", cap)
    paths = _dirs(mod)

    pages = [_round(mod, paths, keys, rnd) for rnd in (1, 2, 3, 4)]

    assert pages == [keys, 0, 0, 0], (
        "cycling more keys than the scope map and the tombstone map can hold "
        f"together must not re-page every round: {pages}"
    )


def test_the_saturation_threshold_is_not_a_small_number_artifact(tmp_path):
    """Same at the shipped cap's scale."""
    cap = 8
    keys = cap * 2 + 1
    mod = _load(tmp_path / "saturation-large", cap)
    paths = _dirs(mod)

    pages = [_round(mod, paths, keys, rnd) for rnd in (1, 2, 3, 4)]

    assert pages == [keys, 0, 0, 0], f"pages per round = {pages}"


def test_a_never_evicted_key_pages_while_its_neighbours_are_fresh(tmp_path):
    """The leg that discriminates between the two candidate saturation rules.

    Cap C with C fresh keys live, and a key K whose records aged out while its
    incident stayed open. K's next conversation is one nobody has been told
    about, so it must page. A rule keyed on "the map is at capacity" silences
    it; a rule keyed on "a tombstone was dropped for capacity" does not,
    because nothing has been dropped here.
    """
    cap = 2
    mod = _load(tmp_path / "fresh-neighbours", cap)
    paths = _dirs(mod)

    # C keys, so the map is exactly at capacity with nothing evicted.
    first = _round(mod, paths, cap, 1)
    assert first == cap, first
    state = mod.load_incident_state(paths)
    assert len(state.get("conversationScopes") or {}) == cap, "no eviction may have occurred"
    assert not (state.get(mod.CONVERSATION_SCOPE_EVICTED_FIELD) or {}), "no tombstones either"

    # K: an open incident whose scope records aged out, neighbours still fresh.
    now = int(time.time())
    key_index = cap + 300
    key = f"{MACHINE}|instance-{key_index:04d}|{SOURCE}"
    _seed_open_incident_without_records(mod, paths, key, now)

    pages = _fresh_conversation(mod, paths, key_index, 9100, 2)

    assert pages == 1, (
        "a conversation nobody has been told about must page while the map is "
        f"merely full and nothing has been dropped: pages = {pages}"
    )


def test_the_drop_marker_is_written_then_expires(tmp_path):
    """The saturation signal is fresh after a drop and gone once it ages out."""
    cap = 2
    mod = _load(tmp_path / "drop-marker", cap)
    paths = _dirs(mod)

    _round(mod, paths, cap * 2 + 1, 1)
    state = mod.load_incident_state(paths)
    marker = state.get(mod.CONVERSATION_SCOPE_GLOBAL_OVERFLOW_FIELD) or {}
    assert marker.get("tombstonesDroppedAt"), (
        f"a tombstone dropped for capacity must stamp the marker: {marker!r}"
    )
    assert marker.get("tombstonesDroppedCount", 0) >= 1, marker
    assert mod.conversation_scopes_have_overflowed(state), "the freshness test must hold"

    # Age the stamp past the window: the sweep clears it and saturation lifts.
    state[mod.CONVERSATION_SCOPE_GLOBAL_OVERFLOW_FIELD]["tombstonesDroppedAt"] = (
        int(time.time()) - SHIPPED_RETENTION_SECONDS - 60
    )
    mod.sweep_conversation_scopes(state, int(time.time()))
    assert not mod.conversation_scopes_have_overflowed(state), (
        f"an aged drop marker must stop asserting saturation: "
        f"{state.get(mod.CONVERSATION_SCOPE_GLOBAL_OVERFLOW_FIELD)!r}"
    )
