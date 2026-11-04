"""Diagnostic contradictions must hold incident recovery without widening it."""
from copy import deepcopy
import json

import pytest
from hypothesis import HealthCheck, given, settings, strategies as st

from test_bot_errors_daily_health_saliency import (
    _env, _load_health, dirs, recovery_case,
)


@pytest.mark.parametrize("fields,held", [
    ("status=degraded", True),
    ("wa_connected=false", True),
    ("state=reconnecting", True),
    ("auth_bond_status=missing", True),
    ("auth_bond_creds_exists=false", True),
    ("auth_bond_creds_size=0", True),
    ("auth_bond_creds_size=-1", True),
    ("auth_failure_class=logged_out", True),
    ("auth_bond_at_risk", True),
    ("physical_intervention_required", True),
    ("", False),
    ("auth_bond_creds_size=NaN", False),
    ("auth_bond_creds_size=128", False),
    ("health_generated_at_missing", False),
    ("last_disconnect_reason=old_auth_bond_at_risk", False),
])
@settings(database=None, deadline=None, max_examples=18, derandomize=True,
          suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(order=st.permutations((0, 1, 2)), copies=st.integers(min_value=1, max_value=3))
def test_diagnostic_contradiction_holds_only_matching_target(
    recovery_case, fields, held, order, copies,
):
    dispatcher, state, key, event, _ = recovery_case()
    specific = "test-machine|line-a|instance_unreachable"
    other = "test-machine|line-b|instance_unreachable"
    for candidate in (specific, other):
        state["openIncidents"][candidate] = {"status": "open", "eventCreatedAtEpoch": 1780185600}
    good = event["evidence"]
    contrary = "health line-a: WARN 200 fixture health_projection=diagnostic instance_name=line-a " + fields
    lines = [good, contrary, good.replace("line-a", "line-b")]
    event["evidence"] = "\n".join(lines[index] for index in order for _ in range(copies))
    expected = {other} if held else {key, specific, other}
    assert set(dispatcher.daily_health_recovered_incident_keys(event, state)) == expected


@pytest.mark.parametrize("identity", [
    "health_projection=public instance_name=line-a",
    "health_projection=unobserved instance_name=line-a",
    "health_projection=diagnostic instance_name=line-b",
    "health_projection=diagnostic", "instance_name=line-a",
])
@settings(database=None, deadline=None, max_examples=8, derandomize=True,
          suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(contrary_first=st.booleans(), copies=st.integers(min_value=1, max_value=4))
def test_unattributed_observation_does_not_add_a_veto(recovery_case, identity, contrary_first, copies):
    dispatcher, state, key, event, _ = recovery_case()
    contrary = "health line-a: WARN 200 fixture " + identity + " wa_connected=false"
    lines = [event["evidence"]] + [contrary] * copies
    event["evidence"] = "\n".join(reversed(lines) if contrary_first else lines)
    assert dispatcher.daily_health_recovered_incident_keys(event, state) == [key]


@pytest.fixture
def formatted_probe(dirs, monkeypatch):
    health = _load_health(*dirs)
    monkeypatch.setattr(health, "current_epoch", lambda: 1780185900)
    monkeypatch.setenv("BOT_ERRORS_AUTH_BOND_WRITE_INFLIGHT_GRACE_SECONDS", "10")
    body = {
        "schema_version": "health.v3", "status": "healthy",
        "generated_at": "2026-05-31T00:05:00Z", "instance": {"name": "line-a"},
        "whatsapp": {
            "connected": True, "connection": {"state": "connected", "auth_failure_class": "none"},
            "auth_bond": {
                "status": "present", "creds": {"exists": True, "size": 128},
                "backup": {"latest": str(dirs[0] / "absent-backup")},
            },
        },
    }

    def render(kind):
        value = deepcopy(body)
        bond = value["whatsapp"]["auth_bond"]
        if kind.startswith("grace") or kind == "expired":
            bond.update(status="invalid", issues=["creds_json_empty"])
            bond["creds"].update(size=0, mtime="2026-05-31T00:05:00Z")
        if kind == "expired":
            bond["creds"]["mtime"] = "2026-05-31T00:04:50Z"
        if kind in {"disconnected", "grace_disconnected"}:
            value["status"] = "degraded"
            value["whatsapp"]["connected"] = False
            value["whatsapp"]["connection"]["state"] = "reconnecting"
        return health.format_health_probe("http://127.0.0.1:19000/health", 200, json.dumps(value), "line-a", True, False)

    return render


@pytest.mark.parametrize("kind,held", [
    ("disconnected", True), ("grace", False), ("grace_disconnected", True), ("expired", True),
])
@settings(database=None, deadline=None, max_examples=6, derandomize=True,
          suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(order=st.permutations((0, 1, 2)))
def test_formatted_diagnostic_veto_survives_dispatch_and_store_reload(
    recovery_case, dirs, monkeypatch, formatted_probe, kind, held, order,
):
    dispatcher, state, key, event, _ = recovery_case()
    specific = "test-machine|line-a|instance_unreachable"
    local = "test-machine|line-a|whatsapp_auth_bond_local_failure"
    protected = "test-machine|line-a|whatsapp_device_bond_lost"
    other = "test-machine|line-b|instance_unreachable"
    for candidate in (specific, local, protected, other):
        state["openIncidents"][candidate] = {"status": "open", "eventCreatedAtEpoch": 1780185600}
    good = "health line-a: " + formatted_probe("healthy")
    contrary = "health line-a: " + formatted_probe(kind)
    lines = [good, contrary, good.replace("line-a", "line-b")]
    event.update({
        "schemaVersion": 1, "id": "diagnostic-contradiction", "eventType": "alert",
        "severity": "critical", "summary": "Diagnostic recovery evidence",
        "evidence": "\n".join(lines[index] for index in order),
    })
    monkeypatch.setattr(dispatcher, "MAINTENANCE_ENABLED", True)

    def unexpected_send(*args, **kwargs):
        pytest.fail("maintenance must suppress provider notification")

    monkeypatch.setattr(dispatcher, "send_whatsapp", unexpected_send)
    with _env(*dirs):
        paths = dispatcher.setup_dirs()
        dispatcher.maintenance_state_path().write_text(json.dumps({
            "test-machine|bot-errors-health": {"expiresAt": 1780189200, "reason": "fixture"},
        }))
        path = paths["outbox"] / "diagnostic-contradiction.json"
        path.write_text(json.dumps(event))
        path.chmod(0o600)
        with dispatcher.open_dispatcher_state_session() as session:
            loaded = session.load()
            cycle = dispatcher.IncidentStateCycle(session, loaded.payload, loaded.capability)
            cycle.payload.update(state)
            cycle.commit()
            assert dispatcher.process_one(path, paths, cycle) == (True, "suppressed")
        with dispatcher.open_dispatcher_state_session() as session:
            persisted = session.load().payload
        for candidate in (key, specific, local):
            assert (candidate in persisted["openIncidents"]) == held
        assert protected in persisted["openIncidents"]
        assert other not in persisted["openIncidents"]
        assert not path.exists()
        later = deepcopy(event)
        later["createdAt"] = "2026-05-31T00:06:00Z"
        later["evidence"] = good
        dispatcher.close_recovered_daily_health_incidents(later, persisted)
        assert not ({key, specific, local} & persisted["openIncidents"].keys())
        assert protected in persisted["openIncidents"]


@pytest.mark.parametrize("corruption", [
    ("auth_bond_creds_exists=true", "auth_bond_creds_exists=false"),
    ("auth_bond_status=invalid", "auth_bond_status=missing"),
    ("auth_bond_issues=creds_json_empty", "auth_bond_issues=identity_missing"),
    ("auth_bond_credential_write_inflight=true", ""),
])
@settings(database=None, deadline=None, max_examples=8, derandomize=True,
          suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(contrary_first=st.booleans(), copies=st.integers(min_value=1, max_value=4))
def test_inconsistent_grace_marker_does_not_hide_contradictions(
    recovery_case, formatted_probe, corruption, contrary_first, copies,
):
    dispatcher, state, _, event, _ = recovery_case()
    contrary = "health line-a: " + formatted_probe("grace").replace(*corruption)
    lines = [event["evidence"]] + [contrary] * copies
    event["evidence"] = "\n".join(reversed(lines) if contrary_first else lines)
    assert dispatcher.daily_health_recovered_incident_keys(event, state) == []


def test_ambiguous_endpoint_ownership_remains_unverified(recovery_case):
    dispatcher, state, key, event, _ = recovery_case()
    specific = "test-machine|line-a|instance_unreachable"
    state["openIncidents"][specific] = {"status": "open", "eventCreatedAtEpoch": 1780185600}
    event["evidence"] += "\nhealth line-a: FAIL http://127.0.0.1:19001/health timed out"
    assert dispatcher.daily_health_recovered_incident_keys(event, state) == [specific]
    assert key in state["openIncidents"]


def test_contradiction_vetoes_protected_recovery_even_with_outbound_proof(
    recovery_case, formatted_probe,
):
    dispatcher, state, _, event, _ = recovery_case()
    protected = "test-machine|line-a|whatsapp_device_bond_lost"
    state["openIncidents"] = {
        protected: {"status": "awaiting_physical", "eventCreatedAtEpoch": 1780185600},
    }
    good = "health line-a: " + formatted_probe("healthy") + (
        " outbound_success_evidence=provider_acknowledged_or_better"
        " outbound_success_at=2026-05-31T00:04:00Z"
    )
    event["evidence"] = good + "\nhealth line-a: " + formatted_probe("disconnected")
    assert dispatcher.close_recovered_daily_health_incidents(event, state) == []
    assert protected in state["openIncidents"]
    event["evidence"] = good
    assert dispatcher.close_recovered_daily_health_incidents(event, state) == [protected]


def test_grace_sample_alone_is_not_positive_recovery(recovery_case, formatted_probe):
    dispatcher, state, key, event, _ = recovery_case()
    event["evidence"] = "health line-a: " + formatted_probe("grace")
    assert dispatcher.close_recovered_daily_health_incidents(event, state) == []
    assert key in state["openIncidents"]
