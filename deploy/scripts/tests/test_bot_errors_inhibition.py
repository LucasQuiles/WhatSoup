"""Tests for Pattern C — inhibition table (root cause suppresses symptom).

While a root-cause incident is OPEN for a scope (machine|instance), the
dispatcher suppresses that scope's known downstream SYMPTOM incidents. This
extends the existing ``stronger_open_incident_for`` machinery with new seed
edges (bond loss / logout / host-unreachable each suppress per-instance
``local_health``) and an env gate. Auto-release is automatic: suppression is
derived at decision time from open-incident state — no persistent flag — so a
symptom is sent again the moment the root incident is gone.

Covered:
- symptom suppressed while root open, tagged ``inhibited_by:<root_source>``.
- released when the root incident is absent / cleared.
- a root incident is never self-suppressed.
- per-instance scoping: a root on instance A does NOT suppress a symptom on
  instance B.
- gate-off (``BOT_ERRORS_INHIBITION_ENABLED=0``) restores prior behavior.
- malformed ``BOT_ERRORS_INHIBITION_MAP`` falls back to the seed (no crash).
- a valid ``BOT_ERRORS_INHIBITION_MAP`` override adds a new edge.

Neutral fixtures only: host label ``host-a`` and instance ``sample`` — no real
machine names or address-shaped tokens that would trip the publication guard.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

_ENV_KEYS = [
    "BOT_ERRORS_INHIBITION_ENABLED",
    "BOT_ERRORS_INHIBITION_MAP",
    "BOT_ERRORS_SEND_DAILY_HEALTH_INFO",
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


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_inhibition", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_MACHINE = "host-a"
_INSTANCE = "sample"


def _alert(source: str, *, machine: str = _MACHINE, instance: str = _INSTANCE) -> dict:
    return {
        "schemaVersion": 1,
        "id": f"evt-{source}",
        "eventType": "alert",
        "severity": "critical",
        "machine": machine,
        "instance": instance,
        "source": source,
        "summary": f"summary for {source}",
        "evidence": f"evidence for {source}",
    }


def _clear(source: str, *, machine: str = _MACHINE, instance: str = _INSTANCE) -> dict:
    evt = _alert(source, machine=machine, instance=instance)
    evt["eventType"] = "clear"
    return evt


def _open_root_state(mod, root_source: str, *, machine: str = _MACHINE, instance: str = _INSTANCE) -> dict:
    """Incident state with one OPEN root incident keyed for the given scope."""
    key = mod.incident_key(_alert(root_source, machine=machine, instance=instance))
    return {
        "version": 1,
        "openIncidents": {
            key: {
                "status": "open",
                "openedAt": 1000,
                "lastNotifiedAt": 1000,
            }
        },
        "lastSentAt": {},
    }


# ---------------------------------------------------------------------------
# Symptom suppressed while root open, with inhibited_by tag
# ---------------------------------------------------------------------------

def test_symptom_suppressed_while_root_open():
    mod = _load()
    state = _open_root_state(mod, "whatsapp_device_bond_lost")
    symptom = _alert("instance_logged_out")

    reason = mod.should_suppress_send(symptom, state)

    assert reason is not None
    assert "inhibited_by:whatsapp_device_bond_lost" in reason


def test_local_health_qualified_symptom_suppressed():
    # local_health:<instance> matches the bare "local_health" symptom token.
    mod = _load()
    state = _open_root_state(mod, "whatsapp_device_bond_lost")
    symptom = _alert(f"local_health:{_INSTANCE}")

    reason = mod.should_suppress_send(symptom, state)

    assert reason is not None
    assert "inhibited_by:whatsapp_device_bond_lost" in reason


def test_root_record_audited_with_inhibited_by_reason():
    mod = _load()
    state = _open_root_state(mod, "instance_logged_out")
    symptom = _alert(f"local_health:{_INSTANCE}")

    mod.should_suppress_send(symptom, state)

    root_key = mod.incident_key(_alert("instance_logged_out"))
    record = state["openIncidents"][root_key]
    assert record["lastSuppressedSymptomReason"] == "inhibited_by:instance_logged_out"
    assert record["lastSuppressedSymptomSource"] == f"local_health:{_INSTANCE}"


# ---------------------------------------------------------------------------
# Auto-release when root absent / cleared
# ---------------------------------------------------------------------------

def test_symptom_not_suppressed_when_root_absent():
    mod = _load()
    state = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
    symptom = _alert("instance_logged_out")

    # No open root -> Pattern C does not suppress. (First-sight alert sends.)
    assert mod.stronger_open_incident_for(symptom, state) is None


def test_symptom_released_when_root_cleared():
    mod = _load()
    state = _open_root_state(mod, "whatsapp_device_bond_lost")
    root_key = mod.incident_key(_alert("whatsapp_device_bond_lost"))

    # Symptom suppressed while root open.
    assert mod.stronger_open_incident_for(_alert("instance_logged_out"), state) is not None

    # Root clears -> remove it from open incidents (auto-release, no flag).
    state["openIncidents"].pop(root_key)
    assert mod.stronger_open_incident_for(_alert("instance_logged_out"), state) is None


def test_closed_root_does_not_suppress():
    mod = _load()
    state = _open_root_state(mod, "whatsapp_device_bond_lost")
    root_key = mod.incident_key(_alert("whatsapp_device_bond_lost"))
    state["openIncidents"][root_key]["status"] = "resolved"

    assert mod.stronger_open_incident_for(_alert("instance_logged_out"), state) is None


# ---------------------------------------------------------------------------
# Root never self-suppressed
# ---------------------------------------------------------------------------

def test_root_never_self_suppressed():
    mod = _load()
    # Root incident open; the same root source arrives again — it must not be
    # suppressed by itself even though it keys to its own open record.
    state = _open_root_state(mod, "whatsapp_device_bond_lost")
    root_event = _alert("whatsapp_device_bond_lost")

    assert mod.stronger_open_incident_for(root_event, state) is None


# ---------------------------------------------------------------------------
# Per-instance scoping
# ---------------------------------------------------------------------------

def test_root_on_instance_a_does_not_suppress_symptom_on_instance_b():
    mod = _load()
    state = _open_root_state(mod, "whatsapp_device_bond_lost", instance="alpha")
    symptom_other = _alert("instance_logged_out", instance="beta")

    assert mod.stronger_open_incident_for(symptom_other, state) is None

    # Same instance is suppressed (sanity: the scoping is the only difference).
    symptom_same = _alert("instance_logged_out", instance="alpha")
    assert mod.stronger_open_incident_for(symptom_same, state) is not None


# ---------------------------------------------------------------------------
# Gate-off restores prior behavior (fail-open)
# ---------------------------------------------------------------------------

def test_gate_off_disables_inhibition():
    os.environ["BOT_ERRORS_INHIBITION_ENABLED"] = "0"
    mod = _load()
    state = _open_root_state(mod, "whatsapp_device_bond_lost")
    symptom = _alert("instance_logged_out")

    assert mod.stronger_open_incident_for(symptom, state) is None


@pytest.mark.parametrize("value", ["false", "no", "off", "0"])
def test_gate_off_accepts_falsey_values(value):
    os.environ["BOT_ERRORS_INHIBITION_ENABLED"] = value
    mod = _load()
    assert mod.INHIBITION_ENABLED is False
    state = _open_root_state(mod, "instance_logged_out")
    assert mod.stronger_open_incident_for(_alert(f"local_health:{_INSTANCE}"), state) is None


# ---------------------------------------------------------------------------
# Malformed env map falls back to seed
# ---------------------------------------------------------------------------

def test_malformed_inhibition_map_falls_back_to_seed(capsys):
    os.environ["BOT_ERRORS_INHIBITION_MAP"] = "{not valid json"
    mod = _load()

    # Seed edges still present and functional.
    assert "whatsapp_device_bond_lost" in mod.INHIBITION_MAP
    assert "local_health" in mod.INHIBITION_MAP["whatsapp_device_bond_lost"]
    state = _open_root_state(mod, "whatsapp_device_bond_lost")
    assert mod.stronger_open_incident_for(_alert("instance_logged_out"), state) is not None

    err = capsys.readouterr().err
    assert "BOT_ERRORS_INHIBITION_MAP ignored" in err


def test_wrong_shape_inhibition_map_falls_back_to_seed():
    os.environ["BOT_ERRORS_INHIBITION_MAP"] = '["not", "an", "object"]'
    mod = _load()
    # Falls back to the seed; no crash.
    assert mod.INHIBITION_MAP["instance_unreachable"]  # seed survived


# ---------------------------------------------------------------------------
# Valid env override adds an edge
# ---------------------------------------------------------------------------

def test_env_override_adds_edge():
    os.environ["BOT_ERRORS_INHIBITION_MAP"] = '{"custom_root": ["custom_symptom"]}'
    mod = _load()

    assert "custom_symptom" in mod.INHIBITION_MAP["custom_root"]

    state = _open_root_state(mod, "custom_root")
    symptom = _alert("custom_symptom")
    result = mod.stronger_open_incident_for(symptom, state)
    assert result is not None


def test_env_override_unions_over_seed():
    # Override augments an existing seed root rather than replacing its set.
    os.environ["BOT_ERRORS_INHIBITION_MAP"] = '{"whatsapp_device_bond_lost": ["extra_symptom"]}'
    mod = _load()

    bond = mod.INHIBITION_MAP["whatsapp_device_bond_lost"]
    assert "extra_symptom" in bond
    assert "instance_logged_out" in bond  # seed edge preserved


# ---------------------------------------------------------------------------
# close_superseded_incidents — prefix-aware close of qualified local_health
# ---------------------------------------------------------------------------
# Stored health incidents key as "{scope}|local_health:<instance>" (qualified
# by incident_source). The bare "local_health" token in the symptom set only
# pops the exact key "{scope}|local_health", which never exists — so the close
# must also match the qualified key in the same scope. These tests pin that
# prefix-aware close AND confirm exact-match behavior is unchanged.

def _health_incident_key(mod, *, machine: str = _MACHINE, instance: str = _INSTANCE) -> str:
    return mod.incident_key(_alert(f"local_health:{instance}", machine=machine, instance=instance))


def test_superseded_closes_qualified_local_health_same_scope():
    mod = _load()
    health_key = _health_incident_key(mod)
    state = {
        "version": 1,
        "openIncidents": {
            health_key: {"status": "open", "openedAt": 1000, "lastNotifiedAt": 1000},
        },
        "lastSentAt": {health_key: 1000},
    }
    root = _alert("whatsapp_device_bond_lost")

    mod.close_superseded_incidents(root, state)

    assert health_key not in state["openIncidents"]
    assert health_key not in state["lastSentAt"]


def test_superseded_does_not_close_local_health_in_different_scope():
    mod = _load()
    # Health incident lives on a DIFFERENT instance than the dispatched root.
    other_health_key = _health_incident_key(mod, instance="beta")
    state = {
        "version": 1,
        "openIncidents": {
            other_health_key: {"status": "open", "openedAt": 1000, "lastNotifiedAt": 1000},
        },
        "lastSentAt": {other_health_key: 1000},
    }
    root = _alert("whatsapp_device_bond_lost", instance="alpha")

    mod.close_superseded_incidents(root, state)

    # Different scope is untouched.
    assert other_health_key in state["openIncidents"]
    assert other_health_key in state["lastSentAt"]


def test_superseded_exact_match_close_unchanged():
    mod = _load()
    # Non-prefixed symptom (instance_logged_out) still closes via exact key,
    # while an unrelated open incident in the same scope is preserved.
    scope = mod.incident_scope(_alert("whatsapp_device_bond_lost"))
    logged_out_key = f"{scope}|instance_logged_out"
    unrelated_key = f"{scope}|some_other_source"
    state = {
        "version": 1,
        "openIncidents": {
            logged_out_key: {"status": "open"},
            unrelated_key: {"status": "open"},
        },
        "lastSentAt": {logged_out_key: 1000, unrelated_key: 1000},
    }
    root = _alert("whatsapp_device_bond_lost")

    mod.close_superseded_incidents(root, state)

    assert logged_out_key not in state["openIncidents"]
    assert logged_out_key not in state["lastSentAt"]
    # Source not in the symptom set is left alone (exact-match semantics).
    assert unrelated_key in state["openIncidents"]
    assert unrelated_key in state["lastSentAt"]
