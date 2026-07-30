"""Tests for Pattern D — transient-vs-outage severity tiering.

A recoverable soft-fault (SSH timeout to a still-online peer, a health body that
degrades while the WhatsApp link stays connected, an operator-listed transient
source) is HELD at warning tier and NOT pushed to WhatsApp. It only promotes to
the hard-outage (critical) tier — and sends — if it persists past
``TRANSIENT_PROMOTE_SECONDS``. A transient that recovers before promotion never
reaches WhatsApp, and its recovery clear stays silent too. Hard outages (host
offline, unit crash, logout) are never downgraded.

Bookkeeping lives in ``incident_state['transientState'][key]`` — a sidecar that
never touches ``flapState`` (Pattern F accumulation must survive, constraint C1).

FAIL-OPEN everywhere: gate off, or any classification/tiering error, sends as
before. Neutral fixtures only: machines host-a/host-b, instances inst-a/inst-b.
"""
from __future__ import annotations

import importlib.util
import os
import time
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_TRANSIENT_TIERING",
    "BOT_ERRORS_TRANSIENT_PROMOTE_SECONDS",
    "BOT_ERRORS_TRANSIENT_SOURCES",
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
    spec = importlib.util.spec_from_file_location("bot_errors_transient_dispatcher", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_MACHINE = "host-a"
_INSTANCE = "inst-a"


def _alert(
    source: str = "health_body_degraded",
    *,
    machine: str = _MACHINE,
    instance: str = _INSTANCE,
    severity: str = "critical",
    evidence: str = "status=degraded polls=3 whatsapp_connected=true connection_state=connected",
    diagnostics: dict | None = None,
) -> dict:
    evt = {
        "schemaVersion": 1,
        "id": f"evt-{source}",
        "eventType": "alert",
        "severity": severity,
        "machine": machine,
        "instance": instance,
        "source": source,
        "summary": f"summary for {source}",
        "evidence": evidence,
    }
    if diagnostics is not None:
        evt["diagnostics"] = diagnostics
    return evt


def _clear(source: str = "health_body_degraded", **kw) -> dict:
    evt = _alert(source, **kw)
    evt["eventType"] = "clear"
    evt["severity"] = "info"
    return evt


def _empty_state() -> dict:
    return {"version": 1, "openIncidents": {}, "lastSentAt": {}}


def _key(mod, event) -> str:
    return mod.incident_key(event)


# ---------------------------------------------------------------------------
# classify_failure_mode
# ---------------------------------------------------------------------------

def test_classify_health_body_degraded_connected_is_transient():
    mod = _load()
    assert mod.classify_failure_mode(_alert()) == "transient"


def test_classify_health_body_degraded_disconnected_is_outage():
    mod = _load()
    evt = _alert(evidence="status=degraded polls=3 whatsapp_connected=false connection_state=close")
    assert mod.classify_failure_mode(evt) == "outage"


def test_classify_health_body_degraded_no_connection_field_is_outage():
    mod = _load()
    # Absent whatsapp_connected -> cannot prove the bond held -> fail toward outage.
    evt = _alert(evidence="status=degraded polls=3")
    assert mod.classify_failure_mode(evt) == "outage"


def test_classify_health_body_degraded_connected_via_diagnostics():
    mod = _load()
    evt = _alert(evidence="status=degraded", diagnostics={"whatsappConnected": True})
    assert mod.classify_failure_mode(evt) == "transient"


def test_classify_reachability_diagnosis_timeout_is_transient():
    mod = _load()
    evt = _alert(
        source="local_health",
        evidence="",
        diagnostics={"reachabilityDiagnosis": "tailscale_online_ssh_timeout"},
    )
    assert mod.classify_failure_mode(evt) == "transient"


def test_classify_source_suffix_online_ssh_timeout_is_transient():
    mod = _load()
    evt = _alert(source="host_b_online_ssh_timeout", evidence="")
    assert mod.classify_failure_mode(evt) == "transient"


def test_classify_logged_out_is_outage():
    mod = _load()
    assert mod.classify_failure_mode(_alert(source="instance_logged_out", evidence="")) == "outage"


def test_classify_tailscale_offline_is_outage():
    mod = _load()
    evt = _alert(source="host_unreachable", evidence="", diagnostics={"reachabilityDiagnosis": "tailscale_offline"})
    assert mod.classify_failure_mode(evt) == "outage"


def test_classify_unknown_source_defaults_outage():
    mod = _load()
    assert mod.classify_failure_mode(_alert(source="something_new", evidence="")) == "outage"


def test_classify_non_dict_diagnostics_does_not_crash():
    mod = _load()
    evt = _alert(source="instance_logged_out", evidence="")
    evt["diagnostics"] = "not-a-dict"
    assert mod.classify_failure_mode(evt) == "outage"


def test_env_transient_sources_extends_classification():
    os.environ["BOT_ERRORS_TRANSIENT_SOURCES"] = "provider_rate_limited, model_unknown"
    mod = _load()
    assert mod.classify_failure_mode(_alert(source="provider_rate_limited", evidence="")) == "transient"
    assert mod.classify_failure_mode(_alert(source="model_unknown", evidence="")) == "transient"
    assert mod.classify_failure_mode(_alert(source="other", evidence="")) == "outage"


# ---------------------------------------------------------------------------
# apply_transient_tiering — hold / promote
# ---------------------------------------------------------------------------

def test_transient_first_sight_held_at_warning(tmp_path):
    mod = _load()
    state = _empty_state()
    evt = _alert()
    key = _key(mod, evt)
    reason = mod.apply_transient_tiering(evt, state, key, 1000)
    assert reason is not None and reason.startswith("transient_held:")
    assert evt["severity"] == "warning"
    assert evt["diagnostics"]["transientHeld"] is True
    assert evt["diagnostics"]["failureClass"] == "transient"
    rec = state["transientState"][key]
    assert rec["transientSince"] == 1000
    assert rec["heldCount"] == 1
    assert not rec.get("promoted")


def test_transient_held_count_increments(tmp_path):
    mod = _load()
    state = _empty_state()
    key = _key(mod, _alert())
    mod.apply_transient_tiering(_alert(), state, key, 1000)
    mod.apply_transient_tiering(_alert(), state, key, 1100)
    assert state["transientState"][key]["heldCount"] == 2
    # transientSince stays anchored to first sight.
    assert state["transientState"][key]["transientSince"] == 1000


def test_transient_promotes_after_window(tmp_path):
    mod = _load()
    state = _empty_state()
    key = _key(mod, _alert())
    mod.apply_transient_tiering(_alert(), state, key, 1000)
    evt = _alert()
    reason = mod.apply_transient_tiering(evt, state, key, 1000 + 1800)
    assert reason is None  # promoted -> send
    assert evt["severity"] == "critical"
    assert evt["diagnostics"]["transientPromoted"] is True
    assert evt["diagnostics"]["failureClass"] == "outage_promoted"
    assert state["transientState"][key]["promoted"] is True


def test_promotion_is_sticky_within_window(tmp_path):
    mod = _load()
    state = _empty_state()
    key = _key(mod, _alert())
    mod.apply_transient_tiering(_alert(), state, key, 1000)
    mod.apply_transient_tiering(_alert(), state, key, 1000 + 1800)  # promote
    # A later event still inside a fresh window stays promoted (critical, send).
    evt = _alert()
    reason = mod.apply_transient_tiering(evt, state, key, 1000 + 1801)
    assert reason is None
    assert evt["severity"] == "critical"
    assert evt["diagnostics"]["transientPromoted"] is True


def test_custom_promote_seconds_respected(tmp_path):
    os.environ["BOT_ERRORS_TRANSIENT_PROMOTE_SECONDS"] = "60"
    mod = _load()
    assert mod.TRANSIENT_PROMOTE_SECONDS == 60
    state = _empty_state()
    key = _key(mod, _alert())
    assert mod.apply_transient_tiering(_alert(), state, key, 1000) is not None  # held
    assert mod.apply_transient_tiering(_alert(), state, key, 1061) is None  # promoted


def test_outage_not_tiered(tmp_path):
    mod = _load()
    state = _empty_state()
    evt = _alert(source="instance_logged_out", evidence="")
    key = _key(mod, evt)
    assert mod.apply_transient_tiering(evt, state, key, 1000) is None
    assert evt["severity"] == "critical"
    assert "transientState" not in state or key not in state.get("transientState", {})


# ---------------------------------------------------------------------------
# resolve_transient_on_clear
# ---------------------------------------------------------------------------

def test_clear_of_held_transient_silent(tmp_path):
    mod = _load()
    state = _empty_state()
    key = _key(mod, _alert())
    mod.apply_transient_tiering(_alert(), state, key, 1000)
    clear = _clear()
    reason = mod.resolve_transient_on_clear(clear, state, key)
    assert reason is not None and reason.startswith("transient_autoresolved:")
    assert clear["diagnostics"]["transientAutoresolved"] is True
    assert key not in state["transientState"]


def test_clear_of_promoted_transient_flows(tmp_path):
    mod = _load()
    state = _empty_state()
    key = _key(mod, _alert())
    mod.apply_transient_tiering(_alert(), state, key, 1000)
    mod.apply_transient_tiering(_alert(), state, key, 1000 + 1800)  # promote
    reason = mod.resolve_transient_on_clear(_clear(), state, key)
    assert reason is None  # let normal clear handling close the surfaced incident
    assert key not in state["transientState"]  # bookkeeping still retired


def test_clear_without_transient_record_noop(tmp_path):
    mod = _load()
    state = _empty_state()
    assert mod.resolve_transient_on_clear(_clear(), state, _key(mod, _clear())) is None


# ---------------------------------------------------------------------------
# should_suppress_send integration
# ---------------------------------------------------------------------------

def test_should_suppress_holds_transient_alert(tmp_path):
    mod = _load()
    state = _empty_state()
    reason = mod.should_suppress_send(_alert(), state)
    assert reason is not None and reason.startswith("transient_held:")


def test_should_suppress_sends_promoted_transient(tmp_path):
    mod = _load()
    state = _empty_state()
    key = _key(mod, _alert())
    # Pre-seed a transient that opened long ago -> next sighting promotes & sends.
    state["transientState"] = {key: {"transientSince": int(time.time()) - 4000}}
    reason = mod.should_suppress_send(_alert(), state)
    assert reason is None or not reason.startswith("transient_held:")


def test_should_suppress_silences_held_transient_clear(tmp_path):
    mod = _load()
    state = _empty_state()
    key = _key(mod, _alert())
    state["transientState"] = {key: {"transientSince": int(time.time())}}
    reason = mod.should_suppress_send(_clear(), state)
    assert reason is not None and reason.startswith("transient_autoresolved:")


def test_outage_alert_not_held(tmp_path):
    mod = _load()
    state = _empty_state()
    reason = mod.should_suppress_send(_alert(source="instance_logged_out", evidence=""), state)
    assert reason is None or not reason.startswith("transient_held:")


# ---------------------------------------------------------------------------
# Gate off restores prior behavior
# ---------------------------------------------------------------------------

def test_gate_off_disables_tiering(tmp_path):
    os.environ["BOT_ERRORS_TRANSIENT_TIERING"] = "0"
    mod = _load()
    assert mod.TRANSIENT_TIERING_ENABLED is False
    # Classification still works (proves it is the FLAG, not an absent transient).
    assert mod.classify_failure_mode(_alert()) == "transient"
    evt = _alert()
    reason = mod.should_suppress_send(evt, _empty_state())
    assert reason is None or not reason.startswith("transient_held:")
    assert evt["severity"] == "critical"  # not downgraded


# ---------------------------------------------------------------------------
# Pattern F non-interference (constraint C1)
# ---------------------------------------------------------------------------

def test_tiering_does_not_touch_flap_state(tmp_path):
    mod = _load()
    flap = {"host-a|inst-a|health_body_degraded": {"tripTimestamps": [1, 2, 3], "cumulativeCount": 3}}
    state = _empty_state()
    state["flapState"] = {k: dict(v) for k, v in flap.items()}
    key = _key(mod, _alert())
    mod.apply_transient_tiering(_alert(), state, key, 1000)
    assert state["flapState"] == flap  # untouched


# ---------------------------------------------------------------------------
# Fail-open
# ---------------------------------------------------------------------------

def test_failopen_non_dict_transient_state(tmp_path):
    mod = _load()
    state = _empty_state()
    state["transientState"] = "corrupt-not-a-dict"
    # setdefault returns the existing non-dict; guard returns None -> send.
    reason = mod.apply_transient_tiering(_alert(), state, _key(mod, _alert()), 1000)
    assert reason is None


def test_failopen_classify_exception_sends(monkeypatch, tmp_path):
    mod = _load()

    def boom(_event):
        raise RuntimeError("classifier blew up")

    monkeypatch.setattr(mod, "classify_failure_mode", boom)
    state = _empty_state()
    reason = mod.apply_transient_tiering(_alert(), state, _key(mod, _alert()), 1000)
    assert reason is None  # fail-open: send despite the classifier error


# ---------------------------------------------------------------------------
# Review fix C1 — transientState survives a disk round-trip (load side)
# ---------------------------------------------------------------------------

def test_transient_state_persists_across_load(tmp_path):
    mod = _load()
    paths = {"incident_state": tmp_path / "incident-state.json"}
    state = _empty_state()
    key = _key(mod, _alert())
    mod.apply_transient_tiering(_alert(), state, key, 1000)  # held -> records transientSince
    mod.save_incident_state(paths, state)
    reloaded = mod.load_incident_state(paths)
    assert key in reloaded.get("transientState", {})
    assert reloaded["transientState"][key]["transientSince"] == 1000


def test_promote_window_anchored_after_reload(tmp_path):
    # Without C1 the reload would reset transientSince and the window would never
    # elapse. With it, a transient first seen long ago promotes on next sighting.
    mod = _load()
    paths = {"incident_state": tmp_path / "incident-state.json"}
    state = _empty_state()
    key = _key(mod, _alert())
    mod.apply_transient_tiering(_alert(), state, key, 1000)
    mod.save_incident_state(paths, state)
    reloaded = mod.load_incident_state(paths)
    evt = _alert()
    reason = mod.apply_transient_tiering(evt, reloaded, key, 1000 + 1801)
    assert reason is None  # promoted -> send
    assert evt["severity"] == "critical"


# ---------------------------------------------------------------------------
# Review fix I1 — promoted record retired when incident closes
# ---------------------------------------------------------------------------

def test_promoted_record_retired_on_close(tmp_path):
    mod = _load()
    state = _empty_state()
    key = _key(mod, _alert())
    mod.apply_transient_tiering(_alert(), state, key, 1000)
    mod.apply_transient_tiering(_alert(), state, key, 1000 + 1800)  # promote
    assert state["transientState"][key]["promoted"] is True
    # A clear flowing through mark_incident_sent must retire the transient record.
    mod.mark_incident_sent(_clear(), state)
    assert key not in state.get("transientState", {})


# ---------------------------------------------------------------------------
# Review fix I3 — last whatsapp_connected reading wins
# ---------------------------------------------------------------------------

def test_multi_poll_evidence_last_reading_wins(tmp_path):
    mod = _load()
    # Earlier =true, later =false: the most recent disconnect must classify outage.
    evt = _alert(evidence="whatsapp_connected=true poll=1 whatsapp_connected=false poll=2")
    assert mod.classify_failure_mode(evt) == "outage"
    # Earlier =false, later =true: recovered by the last poll -> transient.
    evt2 = _alert(evidence="whatsapp_connected=false poll=1 whatsapp_connected=true poll=2")
    assert mod.classify_failure_mode(evt2) == "transient"
