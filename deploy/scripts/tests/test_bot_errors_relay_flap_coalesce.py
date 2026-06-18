"""Tests for Pattern H — relay-host flap coalescing.

The collector emits ``relay_host_down`` (warning) when a peer probe misses and a
paired ``relay_host_recovered`` (info) when it returns. Observed flaps recover in
~6 min — one missed probe interval, not an outage — yet fan out per host, paging a
down AND an up for every blip. Pattern H holds the down (Pattern D machinery) so a
self-healed flap never surfaces, and suppresses the paired recovered when its down
was held-and-unsurfaced — so the blip pages neither leg. A down that PERSISTS past
the promote window still promotes to an outage and pages; its recovery then sends.

FAIL-OPEN everywhere: gate off, no held record, or any error → send as before.
Neutral fixtures only: machines host-a/host-b, remotes peer-a/peer-b.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_RELAY_FLAP_COALESCE",
    "BOT_ERRORS_TRANSIENT_TIERING",
    "BOT_ERRORS_TRANSIENT_PROMOTE_SECONDS",
    "BOT_ERRORS_SEND_DAILY_HEALTH_INFO",
    "BOT_ERRORS_MAINTENANCE_WINDOWS",
    "BOT_ERRORS_INHIBITION_ENABLED",
    "BOT_ERRORS_FLAP_DETECTION",
]


@pytest.fixture(autouse=True)
def _clean_env(tmp_path):
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    for k in _ENV_KEYS:
        os.environ.pop(k, None)
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_relay_dispatcher", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_MACHINE = "host-a"


def _down(remote: str = "peer-a", *, machine: str = _MACHINE, severity: str = "warning") -> dict:
    return {
        "schemaVersion": 1,
        "id": f"evt-down-{remote}",
        "eventType": "alert",
        "severity": severity,
        "machine": machine,
        "instance": "bot-errors-collector",
        "source": "relay_host_down",
        "summary": f"relay host down: {remote}",
        "evidence": "",
        "diagnostics": {"remote": remote},
    }


def _recovered(remote: str = "peer-a", *, machine: str = _MACHINE) -> dict:
    return {
        "schemaVersion": 1,
        "id": f"evt-rec-{remote}",
        "eventType": "alert",
        "severity": "info",
        "machine": machine,
        "instance": "bot-errors-collector",
        "source": "relay_host_recovered",
        "summary": f"relay host recovered: {remote}",
        "evidence": "",
        "diagnostics": {"remote": remote},
    }


def _empty_state() -> dict:
    return {"version": 1, "openIncidents": {}, "lastSentAt": {}}


# ---------------------------------------------------------------------------
# classify_failure_mode — relay_host_down
# ---------------------------------------------------------------------------

def test_relay_down_classifies_transient_when_gate_on():
    mod = _load()
    assert mod.RELAY_FLAP_COALESCE is True
    assert mod.classify_failure_mode(_down()) == "transient"


def test_relay_down_classifies_outage_when_gate_off():
    os.environ["BOT_ERRORS_RELAY_FLAP_COALESCE"] = "0"
    mod = _load()
    assert mod.RELAY_FLAP_COALESCE is False
    # Gate off restores prior behavior: relay_host_down is a hard outage.
    assert mod.classify_failure_mode(_down()) == "outage"


# ---------------------------------------------------------------------------
# down leg: held at warning, never surfaced inside the window
# ---------------------------------------------------------------------------

def test_relay_down_held_not_surfaced():
    mod = _load()
    state = _empty_state()
    reason = mod.should_suppress_send(_down(), state)
    assert reason is not None
    assert reason.startswith("transient_held:")
    # A held transient creates no open incident — only sidecar bookkeeping.
    down_key = mod.incident_key(_down())
    assert down_key in state["transientState"]
    assert down_key not in state["openIncidents"]


# ---------------------------------------------------------------------------
# recovered leg: paired down held → both silent
# ---------------------------------------------------------------------------

def test_recovered_suppressed_when_paired_down_was_held():
    mod = _load()
    state = _empty_state()
    # First the down is held (populates transientState).
    mod.should_suppress_send(_down(), state)
    down_key = mod.incident_key(_down())
    assert down_key in state["transientState"]

    reason = mod.should_suppress_send(_recovered(), state)
    assert reason is not None
    assert reason.startswith("relay_flap_coalesced:")
    assert down_key in reason
    # The held record is retired so it cannot leak into a later promote.
    assert down_key not in state["transientState"]


def test_full_flap_lifecycle_pages_neither_leg():
    mod = _load()
    state = _empty_state()
    down_reason = mod.should_suppress_send(_down("peer-b"), state)
    rec_reason = mod.should_suppress_send(_recovered("peer-b"), state)
    assert down_reason is not None and down_reason.startswith("transient_held:")
    assert rec_reason is not None and rec_reason.startswith("relay_flap_coalesced:")


# ---------------------------------------------------------------------------
# recovered leg: genuine outage recovery still sends
# ---------------------------------------------------------------------------

def test_recovered_sends_when_paired_down_promoted():
    mod = _load()
    state = _empty_state()
    down_key = mod.incident_key(_down())
    state["transientState"] = {down_key: {"transientSince": 0, "promoted": True}}
    # Promoted = the outage was surfaced; the recovery is meaningful news.
    assert mod.should_suppress_send(_recovered(), state) is None


def test_recovered_sends_when_paired_down_has_open_incident():
    mod = _load()
    state = _empty_state()
    down_key = mod.incident_key(_down())
    state["openIncidents"] = {down_key: {"status": "open", "openedAt": 0}}
    assert mod.coalesce_relay_recovered(_recovered(), state) is None


def test_recovered_orphan_sends_fail_toward_visibility():
    mod = _load()
    state = _empty_state()
    # No held record, no open incident: cannot prove the down was held, so never
    # silence a recovery the operator may be waiting on.
    assert mod.coalesce_relay_recovered(_recovered(), state) is None


# ---------------------------------------------------------------------------
# per-remote scoping
# ---------------------------------------------------------------------------

def test_recovered_for_other_remote_not_coalesced():
    mod = _load()
    state = _empty_state()
    mod.should_suppress_send(_down("peer-a"), state)  # hold peer-a only
    # peer-b never went down; its recovery has no held record → send.
    assert mod.coalesce_relay_recovered(_recovered("peer-b"), state) is None


# ---------------------------------------------------------------------------
# gate off restores prior behavior (fail-open)
# ---------------------------------------------------------------------------

def test_gate_off_recovered_always_sends():
    os.environ["BOT_ERRORS_RELAY_FLAP_COALESCE"] = "0"
    mod = _load()
    state = _empty_state()
    down_key = mod.incident_key(_down())
    # Even with a held-looking record present, the disabled gate must not coalesce.
    state["transientState"] = {down_key: {"transientSince": 0}}
    assert mod.coalesce_relay_recovered(_recovered(), state) is None


# ---------------------------------------------------------------------------
# fail-open on malformed state
# ---------------------------------------------------------------------------

def test_coalesce_fail_open_on_bad_transient_state():
    mod = _load()
    state = _empty_state()
    state["transientState"] = "not-a-dict"
    # transient_state.get(...) would raise; the except returns None (send).
    assert mod.coalesce_relay_recovered(_recovered(), state) is None


def test_coalesce_ignores_non_recovered_source():
    mod = _load()
    # A non-relay-recovered event must pass straight through (None).
    assert mod.coalesce_relay_recovered(_down(), _empty_state()) is None
