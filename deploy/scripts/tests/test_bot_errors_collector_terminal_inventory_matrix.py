"""#2427 matrix guard: every dispatcher state directory must carry an explicit
collector identity/dedupe disposition.

The dead-letter (#2929) and testleak resurrection defects shared one root
cause: the dispatcher's authoritative directory set and the collector's
local_event_exists candidate list were two independently maintained
hard-coded lists, so a dispatcher-side addition silently escaped dedupe
coverage. This suite pins a closed world over dispatcher state_paths():

- Every key must appear in EXPECTED_DISPOSITIONS below. A new dispatcher
  directory (or renamed key) fails the matrix until a disposition is chosen.
- Every SCANNED entry's directory basename must be derivable from the
  collector's LOCAL_EVENT_LIFECYCLE_DIR_NAMES inventory (plus the env-aware
  outbox entry), so dropping a directory from the collector inventory fails
  the matrix too.

Remote-side note: the acknowledged-claim archive relayed/ lives on the REMOTE
host (REMOTE_ACK_SCRIPT moves claims under the remote root) and can never be
covered by the collector's local scan; the ack-retry reconciliation remainder
of #2427 owns that surface.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

_CONFTEST_PATH = Path(__file__).resolve().parent / "conftest.py"
_conftest_spec = importlib.util.spec_from_file_location("bot_errors_collector_test_conftest", _CONFTEST_PATH)
_conftest = importlib.util.module_from_spec(_conftest_spec)  # type: ignore[arg-type]
_conftest_spec.loader.exec_module(_conftest)  # type: ignore[union-attr]

_load_mod_with_dirs = _conftest._load_mod_with_dirs

_DISPATCHER_PATH = Path(__file__).resolve().parent.parent / "bot-errors-dispatcher.py"


def _load_dispatcher():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_matrix", _DISPATCHER_PATH)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


SCANNED = "scanned"          # in the collector dedupe inventory
SCANNED_ENV = "scanned-env"  # scanned via the env-aware outbox entry
EXEMPT_NON_RECORD = "exempt-non-record"  # directory holds no per-event records
EXEMPT_FILE = "exempt-file"  # a state FILE, not a record directory
EXEMPT_ROOT = "exempt-root"  # the state root itself

# The A5 disposition map. Adding a dispatcher directory without extending this
# map (and, for record dirs, the collector inventory) is a test failure by
# design.
EXPECTED_DISPOSITIONS = {
    "root": EXEMPT_ROOT,
    "outbox": SCANNED_ENV,
    "processing": SCANNED,
    "sent": SCANNED,
    "storm_collapsed": SCANNED,
    "storm_manifests": EXEMPT_NON_RECORD,  # storm manifest indexes, no event id
    "suppressed": SCANNED,
    "quarantine": SCANNED,
    "testleak": SCANNED,
    "writefail_recovered": SCANNED,
    "writefail_quarantine": SCANNED,
    "locks": EXEMPT_NON_RECORD,
    "logs": EXEMPT_NON_RECORD,
    "dead_letter": SCANNED,
    "state": EXEMPT_FILE,
    "incident_state": EXEMPT_FILE,
    "meta_state": EXEMPT_FILE,
}


def test_dispatcher_state_paths_closed_world(tmp_state, monkeypatch):
    """Every dispatcher state key has an explicit disposition — no silent growth."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_state[0]))
    dispatcher = _load_dispatcher()
    keys = set(dispatcher.state_paths().keys())
    assert keys == set(EXPECTED_DISPOSITIONS), (
        "dispatcher state_paths drifted from the collector disposition matrix; "
        "choose a disposition (collector inventory entry or documented exemption) "
        f"for: {sorted(keys.symmetric_difference(set(EXPECTED_DISPOSITIONS)))}"
    )


def test_scanned_dirs_covered_by_collector_inventory(tmp_state, monkeypatch):
    """Every SCANNED dispatcher dir's basename is in the collector SSOT inventory."""
    state_dir, outbox_dir = tmp_state
    collector = _load_mod_with_dirs(state_dir, outbox_dir)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state_dir))
    dispatcher = _load_dispatcher()
    paths = dispatcher.state_paths()

    inventory = set(collector.LOCAL_EVENT_LIFECYCLE_DIR_NAMES)
    for key, disposition in EXPECTED_DISPOSITIONS.items():
        if disposition != SCANNED:
            continue
        basename = paths[key].name
        assert basename in inventory, (
            f"dispatcher dir {key!r} ({basename!r}) is marked scanned but is "
            "missing from collector LOCAL_EVENT_LIFECYCLE_DIR_NAMES"
        )


def test_collector_candidates_derive_from_inventory(tmp_state):
    """local_event_exists scans exactly the SSOT inventory (plus env outbox)."""
    state_dir, outbox_dir = tmp_state
    collector = _load_mod_with_dirs(state_dir, outbox_dir)
    inventory = collector.LOCAL_EVENT_LIFECYCLE_DIR_NAMES
    assert "testleak" in inventory
    assert "dead-letter" in inventory
    candidates = collector.local_event_candidate_dirs()
    basenames = [p.name for p in candidates]
    for name in inventory:
        assert name in basenames, f"inventory dir {name!r} missing from candidates"
    assert len(candidates) == len(inventory) + 1  # + env-aware outbox
