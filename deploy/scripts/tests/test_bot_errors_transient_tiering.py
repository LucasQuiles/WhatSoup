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
import sys
import time
from pathlib import Path

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

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
    evidence: str = "status=degraded polls=3 whatsapp_connected=true connection_state=connected degradation_causes=enrichment_stale",
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


_empty_state = dispatcher_fixtures.empty_state


def _key(mod, event) -> str:
    return mod.incident_key(event)


# ---------------------------------------------------------------------------
# classify_failure_mode
# ---------------------------------------------------------------------------

def test_classify_health_body_degraded_connected_hold_class_is_transient():
    mod = _load()
    # Connected bond + only hold-class causes -> held (the pre-#2409 behavior
    # survives ONLY for hold-class cause vectors).
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
    evt = _alert(
        evidence="status=degraded",
        diagnostics={"whatsappConnected": True, "degradationCauses": ["enrichment_stale"]},
    )
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
    evt2 = _alert(
        evidence="whatsapp_connected=false poll=1 whatsapp_connected=true poll=2 degradation_causes=enrichment_stale"
    )
    assert mod.classify_failure_mode(evt2) == "transient"


# ---------------------------------------------------------------------------
# #2409 Car 7b: cause-aware disposition (fail toward visibility)
# ---------------------------------------------------------------------------

def test_connected_page_class_cause_is_outage():
    mod = _load()
    evt = _alert(
        evidence="status=degraded whatsapp_connected=true degradation_causes=provider_execution_pressure"
    )
    assert mod.classify_failure_mode(evt) == "outage", (
        "a user-impacting cause must not be downgraded merely because transport is connected"
    )


def test_connected_fallback_exhausted_is_outage():
    mod = _load()
    evt = _alert(
        evidence="status=degraded whatsapp_connected=true degradation_causes=fallback_chain_exhausted"
    )
    assert mod.classify_failure_mode(evt) == "outage"


def test_mixed_hold_and_page_causes_page_dominates():
    mod = _load()
    evt = _alert(
        evidence=(
            "status=degraded whatsapp_connected=true "
            "degradation_causes=enrichment_stale,turn_recovery_degraded,memory_context_degraded"
        )
    )
    assert mod.classify_failure_mode(evt) == "outage"


def test_unknown_cause_token_fails_visible():
    mod = _load()
    evt = _alert(
        evidence="status=degraded whatsapp_connected=true degradation_causes=totally_new_cause"
    )
    assert mod.classify_failure_mode(evt) == "outage"


def test_empty_cause_vector_fails_visible():
    mod = _load()
    evt = _alert(evidence="status=degraded whatsapp_connected=true degradation_causes=")
    assert mod.classify_failure_mode(evt) == "outage"


def test_missing_cause_vector_fails_visible():
    mod = _load()
    evt = _alert(evidence="status=degraded whatsapp_connected=true connection_state=connected")
    assert mod.classify_failure_mode(evt) == "outage", (
        "an absent cause vector proves nothing about impact; fail toward visibility"
    )


def test_registry_unavailable_fails_visible(monkeypatch):
    mod = _load()
    mod.DEGRADATION_DISPOSITIONS_PATH = mod.Path("/nonexistent/fault-taxonomy-registry.json")
    mod._DEGRADATION_DISPOSITIONS_CACHE["loaded"] = False
    evt = _alert()
    assert mod.classify_failure_mode(evt) == "outage", (
        "a missing or unreadable disposition registry must not silently blanket-hold"
    )


def test_operational_fallback_trio_stays_held_regression_pin():
    mod = _load()
    evt = _alert(
        evidence=(
            "status=degraded whatsapp_connected=true degradation_causes="
            "provider_fallback_active,primary_model_unusable,primary_model_evidence_stale"
        )
    )
    assert mod.classify_failure_mode(evt) == "transient", (
        "the proven operational-fallback family is hold-class; the cause-aware path must never re-page it"
    )


def test_event_loop_starved_alone_stays_held():
    mod = _load()
    evt = _alert(
        evidence="status=degraded whatsapp_connected=true degradation_causes=event_loop_starved"
    )
    assert mod.classify_failure_mode(evt) == "transient", (
        "event_loop_starved requires corroboration before paging; single-signal stays hold"
    )


def test_structured_diagnostics_causes_take_precedence():
    mod = _load()
    evt = _alert(
        evidence="status=degraded whatsapp_connected=true degradation_causes=enrichment_stale",
        diagnostics={"whatsappConnected": True, "degradationCauses": ["provider_execution_pressure"]},
    )
    assert mod.classify_failure_mode(evt) == "outage", (
        "structured diagnostics outrank evidence-token parsing"
    )


def test_malformed_structured_causes_fail_visible():
    mod = _load()
    evt = _alert(
        evidence="status=degraded whatsapp_connected=true degradation_causes=enrichment_stale",
        diagnostics={"whatsappConnected": True, "degradationCauses": [42]},
    )
    assert mod.classify_failure_mode(evt) == "outage", (
        "a malformed structured vector must not silently fall back to evidence parsing"
    )


def test_multi_poll_cause_vector_last_reading_wins():
    mod = _load()
    evt = _alert(
        evidence=(
            "degradation_causes=provider_execution_pressure poll=1 whatsapp_connected=true "
            "degradation_causes=enrichment_stale poll=2"
        )
    )
    assert mod.classify_failure_mode(evt) == "transient"
    evt2 = _alert(
        evidence=(
            "degradation_causes=enrichment_stale poll=1 whatsapp_connected=true "
            "degradation_causes=provider_execution_pressure poll=2"
        )
    )
    assert mod.classify_failure_mode(evt2) == "outage"

# ---------------------------------------------------------------------------
# #2409 Car 7c: policy-family matrix + inhibition contract + registry-shape pins
# ---------------------------------------------------------------------------

_HOLD_FAMILY_REPRESENTATIVES = {
    "provider_fallback": "provider_fallback_active",
    "auth_transport": "connection_churn",
    "enrichment": "enrichment_stale",
    "memory": "memory_context_degraded",
    "event_loop": "event_loop_starved",
    "durability": "durability_debt",
    "continuity": "continuity_gap_open",
    "agent_runtime": "agent_auto_compact_backoff",
    "mode_specific": "chat_runtime_degraded",
    "turn_capability": "turn_finalization_degraded",
}

_PAGE_FAMILY_REPRESENTATIVES = {
    "provider_fallback": "provider_execution_pressure",
    "turn_capability": "turn_recovery_degraded",
    "auth_transport": "auth_bond_degraded",
    "durability": "durability_evidence_unreadable",
    "continuity": "continuity_gap_unreadable",
    "schema": "schema_not_ready",
    "polls": "pending_polls_unreadable",
    "agent_runtime": "agent_recent_crashes",
    "sentinel": "unclassified",
}


def _cause_alert(cause: str) -> dict:
    return _alert(
        evidence=f"status=degraded whatsapp_connected=true degradation_causes={cause}"
    )


def test_hold_family_representatives_are_held_end_to_end(tmp_path):
    mod = _load()
    for family, cause in _HOLD_FAMILY_REPRESENTATIVES.items():
        state = _empty_state()
        evt = _cause_alert(cause)
        reason = mod.apply_transient_tiering(evt, state, _key(mod, evt), 1_000)
        assert reason is not None, f"{family}/{cause} must be held inside the soft window"
        assert evt["severity"] == "warning", f"{family}/{cause} held tier must be warning"
        assert _key(mod, evt) in state["transientState"], f"{family}/{cause} must record hold state"


def test_page_family_representatives_are_never_tiered(tmp_path):
    mod = _load()
    for family, cause in _PAGE_FAMILY_REPRESENTATIVES.items():
        state = _empty_state()
        evt = _cause_alert(cause)
        reason = mod.apply_transient_tiering(evt, state, _key(mod, evt), 1_000)
        assert reason is None, f"{family}/{cause} must page immediately (no hold)"
        assert evt["severity"] == "critical", f"{family}/{cause} severity must not be downgraded"
        assert "transientState" not in state or _key(mod, evt) not in state.get("transientState", {}), (
            f"{family}/{cause} must not create hold bookkeeping"
        )


def test_event_loop_starved_recovery_before_promotion_is_silent(tmp_path):
    mod = _load()
    state = _empty_state()
    evt = _cause_alert("event_loop_starved")
    key = _key(mod, evt)
    assert mod.apply_transient_tiering(evt, state, key, 1_000) is not None
    clear = _clear(evidence="status=healthy whatsapp_connected=true")
    silent = mod.resolve_transient_on_clear(clear, state, key)
    assert silent is not None, "a held single-signal starvation that recovers must clear silently"
    assert key not in state.get("transientState", {})


def test_registry_empty_dispositions_block_fails_visible(tmp_path):
    mod = _load()
    registry_path = tmp_path / "fault-taxonomy-registry.json"
    registry_path.write_text('{"degradationCauseDispositions": {"dispositions": {}}}', encoding="utf-8")
    mod.DEGRADATION_DISPOSITIONS_PATH = registry_path
    assert mod.classify_failure_mode(_cause_alert("enrichment_stale")) == "outage", (
        "an empty dispositions block is an untrusted policy; fail toward visibility"
    )


def test_registry_poisoned_sibling_entry_fails_the_whole_policy(tmp_path):
    # Discriminating shape (from the #3281 review): the probed cause carries a
    # VALID hold tier, and only a SIBLING entry is malformed. This classifies
    # outage solely because the loader poisons the whole policy on any bad
    # tier — the classifier's per-cause hold check cannot mask it, so a loader
    # that started accepting arbitrary tiers turns this RED.
    mod = _load()
    registry_path = tmp_path / "fault-taxonomy-registry.json"
    registry_path.write_text(
        '{"degradationCauseDispositions": {"dispositions": {'
        '"enrichment_stale": {"impactTier": "hold"}, '
        '"bogus_cause": {"impactTier": "sideways"}}}}',
        encoding="utf-8",
    )
    mod.DEGRADATION_DISPOSITIONS_PATH = registry_path
    assert mod.classify_failure_mode(_cause_alert("enrichment_stale")) == "outage", (
        "one malformed sibling tier must poison the whole policy, not just its own entry"
    )


def test_inhibition_seed_pins_aggregate_symptom_edges():
    mod = _load()
    assert "health_body_degraded" in mod.SUPERSEDED_SOURCES_BY_ALERT_SOURCE["instance_logged_out"]
    assert "health_body_degraded" in mod.SUPERSEDED_SOURCES_BY_ALERT_SOURCE["whatsapp_device_bond_lost"]


def test_open_root_inhibits_aggregate_symptom_preserving_member_state(tmp_path):
    mod = _load()
    state = _empty_state()
    evt = _cause_alert("provider_execution_pressure")
    scope = mod.incident_scope(evt)
    root_key = f"{scope}|instance_logged_out"
    state["openIncidents"][root_key] = {"status": "open", "openedAt": 900}
    found = mod.stronger_open_incident_for(evt, state)
    assert found is not None, "an open logged-out root must inhibit the aggregate symptom"
    stronger_key, record = found
    assert stronger_key == root_key
    mod.mark_suppressed_by_stronger(evt, stronger_key, record, 1_000)
    assert record["suppressedCount"] == 1
    assert "provider_execution_pressure" in str(record.get("lastSuppressedSymptomEvidence") or ""), (
        "the suppressed aggregate's cause vector must be preserved on the root record"
    )


def test_open_root_tracks_suppressed_aggregate_clear(tmp_path):
    mod = _load()
    state = _empty_state()
    clear = _clear(evidence="status=healthy whatsapp_connected=true")
    scope = mod.incident_scope(clear)
    root_key = f"{scope}|instance_logged_out"
    state["openIncidents"][root_key] = {"status": "open", "openedAt": 900}
    found = mod.stronger_open_incident_for(clear, state)
    assert found is not None
    stronger_key, record = found
    mod.mark_suppressed_by_stronger(clear, stronger_key, record, 1_000)
    assert record["suppressedClearCount"] == 1, (
        "a suppressed aggregate clear must be tracked so member recovery is never silently lost"
    )
