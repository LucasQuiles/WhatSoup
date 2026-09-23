"""Stale-parent masking in root-cause inhibition (Pattern C).

Defect pinned here: suppressing a child symptom used to write ``lastSeenAt`` onto
the STRONGER (parent) incident. A parent opened weeks earlier therefore never
aged out, and while its status stayed ``awaiting_physical`` it swallowed every
later child critical, including evidence that the instance was connected again.
A real new logout on that instance was then folded into the stale parent and
paged nobody.

Covered:
- (a) suppressing a child leaves the parent's own lastSeenAt/lastSeenIso alone
  and records the suppression in lastSuppressedSymptomAt/Iso.
- (b) a connectivity-loss parent in awaiting_physical is retired by a child that
  reports the instance connected; the child is then processed (not suppressed).
- (c) after retirement a new instance_logged_out alert opens a fresh incident and
  is sent (no fold into the old record, no cooldown).
- (d) controls: a child that does not contradict the parent (disconnected, no
  reading, created before the parent opened, or a non-connectivity root) keeps
  being suppressed.
- (e) INHIBITION disabled: no suppression and no retirement (behaviour unchanged).

Neutral fixtures only: host label ``host-a`` and instance ``sample``.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"

_ENV_KEYS = [
    "BOT_ERRORS_INHIBITION_ENABLED",
    "BOT_ERRORS_INHIBITION_MAP",
    "BOT_ERRORS_SEND_DAILY_HEALTH_INFO",
    "BOT_ERRORS_TRANSIENT_SOURCES",
]

_clean_env = dispatcher_fixtures.make_env_scrub_fixture(_ENV_KEYS)

_MACHINE = "host-a"
_INSTANCE = "sample"
# Parent opened "weeks ago" relative to the children below.
_PARENT_CREATED_EPOCH = int(time.time()) - 36 * 86400
_PARENT_LAST_SEEN = _PARENT_CREATED_EPOCH + 60
_CONNECTED_EVIDENCE = (
    "health_status=degraded whatsapp_connected=true connection_state=connected "
    "health_body_degraded_polls=3"
)


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_stale_parent_masking", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _iso(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _alert(source: str, *, evidence: str = "", created: int | None = None, event_id: str | None = None) -> dict:
    return {
        "schemaVersion": 1,
        "id": event_id or f"evt-{source}-{created or 'now'}",
        "createdAt": _iso(created if created is not None else int(time.time())),
        "eventType": "alert",
        "severity": "critical",
        "machine": _MACHINE,
        "instance": _INSTANCE,
        "source": source,
        "summary": f"summary for {source}",
        "evidence": evidence or f"evidence for {source}",
    }


def _state_with_parent(mod, root_source: str, *, status: str = "awaiting_physical") -> tuple[dict, str]:
    """Open a parent through the real send path, then age it like the live record."""
    state: dict = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
    root = _alert(root_source, created=_PARENT_CREATED_EPOCH, event_id=f"evt-root-{root_source}")
    mod.mark_incident_sent(root, state)
    key = mod.incident_key(root)
    record = state["openIncidents"][key]
    record["status"] = status
    record["openedAt"] = _PARENT_CREATED_EPOCH
    record["lastSeenAt"] = _PARENT_LAST_SEEN
    record["lastSeenIso"] = _iso(_PARENT_LAST_SEEN)
    record["lastNotifiedAt"] = _PARENT_LAST_SEEN
    record["suppressedCount"] = 2201
    state["lastSentAt"][key] = _PARENT_LAST_SEEN
    return state, key


# ---------------------------------------------------------------------------
# (a) suppression does not refresh the parent's own liveness
# ---------------------------------------------------------------------------

def test_suppressed_child_does_not_refresh_parent_last_seen():
    mod = _load()
    state, parent_key = _state_with_parent(mod, "instance_logged_out")
    child = _alert(
        "health_body_degraded",
        evidence="health_status=degraded whatsapp_connected=false connection_state=disconnected",
    )

    reason = mod.should_suppress_send(child, state)

    assert reason is not None and "inhibited_by:instance_logged_out" in reason
    record = state["openIncidents"][parent_key]
    assert record["lastSeenAt"] == _PARENT_LAST_SEEN
    assert record["lastSeenIso"] == _iso(_PARENT_LAST_SEEN)
    assert int(record["lastSuppressedSymptomAt"]) >= _PARENT_LAST_SEEN
    assert record["lastSuppressedSymptomIso"]
    assert record["suppressedCount"] == 2202


def test_parent_ages_into_stale_digest_despite_suppressed_children():
    # With the parent's lastSeenAt no longer refreshed by children, the stale
    # sweep sees it as quiet and emits its digest.
    mod = _load()
    state, parent_key = _state_with_parent(mod, "instance_logged_out")
    for i in range(3):
        mod.should_suppress_send(_alert(f"local_health:{_INSTANCE}", event_id=f"evt-lh-{i}"), state)

    record = state["openIncidents"][parent_key]
    digest = mod.stale_incident_event(parent_key, record, int(time.time()))

    assert digest is not None
    assert "incident_status=awaiting_physical" in digest["evidence"]


# ---------------------------------------------------------------------------
# (b) contradiction retirement
# ---------------------------------------------------------------------------

def test_connected_child_retires_awaiting_physical_logout_parent_and_is_processed(capsys):
    mod = _load()
    state, parent_key = _state_with_parent(mod, "instance_logged_out")
    child = _alert("health_body_degraded", evidence=_CONNECTED_EVIDENCE, event_id="evt-child-connected")

    reason = mod.should_suppress_send(child, state)

    assert reason is None, reason
    assert parent_key not in state["openIncidents"]
    assert parent_key not in state["lastSentAt"]
    audit = state["contradictionRetirements"][-1]
    assert audit["incidentKey"] == parent_key
    assert audit["reason"] == "contradicted_by_child_evidence"
    assert audit["status"] == "awaiting_physical"
    assert audit["suppressedCount"] == 2201
    assert audit["childEventId"] == "evt-child-connected"
    assert audit["contradictingEvidence"] == "whatsapp_connected=true connection_state=connected"
    retired = child["diagnostics"]["retiredStrongerIncidents"]
    assert [entry["incidentKey"] for entry in retired] == [parent_key]
    assert f"retired stronger incident {parent_key}" in capsys.readouterr().err


def test_connected_child_retires_bond_lost_and_logout_parents_together():
    mod = _load()
    state, bond_key = _state_with_parent(mod, "whatsapp_device_bond_lost")
    logout_state, logout_key = _state_with_parent(mod, "instance_logged_out")
    state["openIncidents"][logout_key] = logout_state["openIncidents"][logout_key]
    state["lastSentAt"][logout_key] = logout_state["lastSentAt"][logout_key]
    child = _alert("health_body_degraded", evidence=_CONNECTED_EVIDENCE)

    assert mod.should_suppress_send(child, state) is None
    assert bond_key not in state["openIncidents"]
    assert logout_key not in state["openIncidents"]


def test_structured_whatsapp_connected_diagnostic_retires_parent():
    mod = _load()
    state, parent_key = _state_with_parent(mod, "whatsapp_device_bond_lost")
    child = _alert("health_body_degraded", evidence="health_status=degraded")
    child["diagnostics"] = {"whatsappConnected": True}

    assert mod.should_suppress_send(child, state) is None
    assert parent_key not in state["openIncidents"]


def test_daily_health_prefixed_connectivity_root_is_retired():
    os.environ["BOT_ERRORS_INHIBITION_MAP"] = (
        '{"daily-health:whatsapp_device_bond_lost": ["health_body_degraded"]}'
    )
    mod = _load()
    state: dict = {"version": 1, "openIncidents": {}, "lastSentAt": {}}
    scope = mod.incident_scope(_alert("health_body_degraded"))
    parent_key = f"{scope}|daily-health:whatsapp_device_bond_lost"
    state["openIncidents"][parent_key] = {
        "status": "awaiting_physical",
        "openedAt": _PARENT_CREATED_EPOCH,
        "eventCreatedAtEpoch": _PARENT_CREATED_EPOCH,
        "lastSeenAt": _PARENT_LAST_SEEN,
    }

    assert mod.should_suppress_send(_alert("health_body_degraded", evidence=_CONNECTED_EVIDENCE), state) is None
    assert parent_key not in state["openIncidents"]


# ---------------------------------------------------------------------------
# (c) a later real logout opens a fresh incident and sends
# ---------------------------------------------------------------------------

def test_new_logout_after_retirement_opens_fresh_incident_and_sends():
    mod = _load()
    state, parent_key = _state_with_parent(mod, "instance_logged_out")
    child = _alert("health_body_degraded", evidence=_CONNECTED_EVIDENCE)
    assert mod.should_suppress_send(child, state) is None
    assert parent_key not in state["openIncidents"]

    new_logout = _alert("instance_logged_out", event_id="evt-new-logout")
    assert mod.incident_key(new_logout) == parent_key

    reason = mod.should_suppress_send(new_logout, state)
    assert reason is None, reason

    mod.mark_incident_sent(new_logout, state)
    record = state["openIncidents"][parent_key]
    assert record["eventId"] == "evt-new-logout"
    assert record["openedAt"] > _PARENT_CREATED_EPOCH
    assert int(record.get("suppressedCount") or 0) == 0
    assert record["status"] == "open"


# ---------------------------------------------------------------------------
# (d) controls: a parent whose condition still holds keeps suppressing
# ---------------------------------------------------------------------------

def test_disconnected_child_keeps_being_suppressed():
    mod = _load()
    state, parent_key = _state_with_parent(mod, "instance_logged_out")
    child = _alert(
        "health_body_degraded",
        evidence="whatsapp_connected=false connection_state=logged_out",
    )

    reason = mod.should_suppress_send(child, state)

    assert reason is not None and "inhibited_by:instance_logged_out" in reason
    assert parent_key in state["openIncidents"]
    assert "contradictionRetirements" not in state
    assert state["openIncidents"][parent_key]["lastSeenAt"] == _PARENT_LAST_SEEN


def test_last_reading_wins_disconnected_after_connected_keeps_suppressing():
    mod = _load()
    state, parent_key = _state_with_parent(mod, "instance_logged_out")
    child = _alert(
        "health_body_degraded",
        evidence="whatsapp_connected=true connection_state=connected\nwhatsapp_connected=false connection_state=disconnected",
    )

    assert mod.should_suppress_send(child, state) is not None
    assert parent_key in state["openIncidents"]


def test_child_without_connectivity_reading_keeps_being_suppressed():
    mod = _load()
    state, parent_key = _state_with_parent(mod, "whatsapp_device_bond_lost")

    assert mod.should_suppress_send(_alert("outbound_send_failed"), state) is not None
    assert parent_key in state["openIncidents"]
    assert state["openIncidents"][parent_key]["lastSeenAt"] == _PARENT_LAST_SEEN


def test_connected_child_created_before_parent_opened_does_not_retire():
    mod = _load()
    state, parent_key = _state_with_parent(mod, "instance_logged_out")
    child = _alert(
        "health_body_degraded",
        evidence=_CONNECTED_EVIDENCE,
        created=_PARENT_CREATED_EPOCH - 600,
    )

    assert mod.should_suppress_send(child, state) is not None
    assert parent_key in state["openIncidents"]
    assert state["openIncidents"][parent_key]["lastSeenAt"] == _PARENT_LAST_SEEN


def test_connected_child_does_not_retire_non_connectivity_root():
    mod = _load()
    state, parent_key = _state_with_parent(mod, "instance_unreachable", status="open")
    child = _alert("instance_degraded", evidence=_CONNECTED_EVIDENCE)

    assert mod.should_suppress_send(child, state) is not None
    assert parent_key in state["openIncidents"]
    assert state["openIncidents"][parent_key]["lastSeenAt"] == _PARENT_LAST_SEEN


# ---------------------------------------------------------------------------
# (e) INHIBITION disabled: unchanged fail-open behaviour
# ---------------------------------------------------------------------------

def test_inhibition_disabled_neither_suppresses_nor_retires():
    # Behaviour-preservation control: with the gate off the stronger lookup is a
    # no-op, so the child sends and the parent is left exactly as it was.
    os.environ["BOT_ERRORS_INHIBITION_ENABLED"] = "0"
    mod = _load()
    state, parent_key = _state_with_parent(mod, "instance_logged_out")
    before = dict(state["openIncidents"][parent_key])

    for evidence in (_CONNECTED_EVIDENCE, "whatsapp_connected=false connection_state=disconnected"):
        child = _alert("health_body_degraded", evidence=evidence)
        assert mod.should_suppress_send(child, state) is None
        assert "retiredStrongerIncidents" not in child.get("diagnostics", {})

    assert state["openIncidents"][parent_key] == before
    assert "contradictionRetirements" not in state
