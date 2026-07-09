"""provider_reauth_required dispatcher semantics (WS-ALERT spec §3).

The source must classify as a hard outage (never Pattern-D transient-held: the
whole point is that the generic health_body_degraded path buried a dead-credential
incident for 5.5 weeks), supersede ONLY its own generic symptom, and pair with
the standard clear carrying AGENT_PROVIDER_AUTH_RECOVERED evidence.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

# Copied verbatim from test_bot_errors_transient_tiering.py:17-60 (module-load +
# env-fixture idiom), per the task brief's explicit instruction.
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
    spec = importlib.util.spec_from_file_location("bot_errors_provider_reauth_dispatcher", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


@pytest.fixture
def dispatcher():
    return _load()


_MACHINE = "host-a"
_INSTANCE = "inst-a"


def _alert(
    source: str = "provider_reauth_required",
    *,
    machine: str = _MACHINE,
    instance: str = _INSTANCE,
    severity: str = "critical",
    evidence: str = "model_usability_status=credential-unavailable evidence_schema_version=1",
) -> dict:
    return {
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


def _clear(source: str = "provider_reauth_required", **kw) -> dict:
    evt = _alert(source, **kw)
    evt["eventType"] = "clear"
    return evt


def test_provider_reauth_classifies_outage(dispatcher):
    event = {
        "source": "provider_reauth_required",
        "instance": "inst-a",
        "machine": "host-a",
        "severity": "critical",
        "evidence": "model_usability_status=credential-unavailable evidence_schema_version=1",
    }
    assert dispatcher.classify_failure_mode(event) == "outage"


def test_provider_reauth_never_in_transient_sources(dispatcher):
    assert "provider_reauth_required" not in dispatcher.TRANSIENT_SOURCES


def test_provider_reauth_inhibits_only_health_body_degraded(dispatcher):
    # The brief's skeleton names this dispatcher.INHIBITION_MAP, but that
    # identifier is a DERIVED module-level dict (_load_inhibition_map(): a copy
    # of the seed below, optionally unioned with a BOT_ERRORS_INHIBITION_MAP env
    # override). The module-level dict literally edited in Step 3 -- the one
    # with entries like "whatsapp_device_bond_lost": {...} at ~L221-255 -- is
    # actually named SUPERSEDED_SOURCES_BY_ALERT_SOURCE; INHIBITION_MAP seeds
    # from it at import time. Asserting on the real, non-env-overridable
    # identifier is the direct, stable lock (an INHIBITION_MAP assertion would
    # also need BOT_ERRORS_INHIBITION_MAP added to _ENV_KEYS to stay immune to
    # ambient env, for no added protection over asserting the seed directly).
    inhibition = dispatcher.SUPERSEDED_SOURCES_BY_ALERT_SOURCE
    assert inhibition["provider_reauth_required"] == {"health_body_degraded"}


def test_recovery_clear_closes_the_incident(dispatcher, tmp_path):
    # Sibling drive pattern: test_bot_errors_transient_tiering.py::
    # test_promoted_record_retired_on_close drives a clear through
    # mark_incident_sent(clear, state) and asserts on state["openIncidents"] /
    # state["transientState"]; test_bot_errors_f8_clock_skew_and_clear_requirement
    # .py::test_clear_still_closes_incident_despite_mismatch confirms the same
    # function is the one real close path ("mark_incident_sent removes it from
    # openIncidents"). mark_incident_sent is also the function that OPENS an
    # incident on an alert (its is_incident_alert branch) -- same function, same
    # state accessor, for both halves of the pairing driven here.
    state: dict = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
    alert = _alert()
    key = dispatcher.incident_key(alert)

    dispatcher.mark_incident_sent(alert, state)
    assert key in state["openIncidents"]  # sanity: the alert opened the incident

    # The source is never transient-held: classify_failure_mode(alert) == "outage"
    # from the very first sighting (locked by test_provider_reauth_classifies_outage
    # above), so apply_transient_tiering's first line ("if classify_failure_mode(event)
    # != 'transient': return None") means no transientState[key] record is ever
    # created for this source. Prove it directly rather than asserting a vacuous
    # negative: resolve_transient_on_clear pops transientState[key] and returns a
    # suppress-reason only when a held (non-promoted) record exists; with no
    # record at all it must decline (return None) -- there is nothing for Pattern D
    # to retire, so the close that follows cannot be running through it.
    assert key not in state.get("transientState", {})
    clear = _clear(evidence="clear_code=AGENT_PROVIDER_AUTH_RECOVERED proof=primary_model_probe_ok")
    assert dispatcher.resolve_transient_on_clear(clear, state, key) is None

    dispatcher.mark_incident_sent(clear, state)

    assert key not in state["openIncidents"]  # closed via the standard clear path
    assert key not in state.get("transientState", {})  # still nothing Pattern D touched


def test_diagnostic_code_identity_across_rails():
    # Repo root: this file lives at deploy/scripts/tests/, so parents[0] =
    # deploy/scripts/tests, parents[1] = deploy/scripts, parents[2] = deploy,
    # parents[3] = repo root -- verified directly (src/runtimes/agent/runtime.ts
    # resolves under it). The brief's inline "parents[2]" guess is one level
    # short (that index is deploy/, not the repo root); parents[1] for
    # bot-errors-health-check.py (matching every sibling file's _SCRIPT
    # convention) is unaffected and correct as given.
    repo_root = Path(__file__).resolve().parents[3]
    health_check = (repo_root / "deploy" / "scripts" / "bot-errors-health-check.py").read_text()
    runtime = (repo_root / "src" / "runtimes" / "agent" / "runtime.ts").read_text()
    assert "AGENT_PROVIDER_AUTH_REQUIRED" in health_check
    assert "AGENT_PROVIDER_AUTH_REQUIRED" in runtime  # Task 7's criticalAsset builder
