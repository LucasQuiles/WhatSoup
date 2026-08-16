"""Falsifiers for #2408 (slice 6a): typed tool-inventory probe outcomes.

A probe failure (unset socket, transport fault, RPC error, malformed
inventory) must never be reported as observed tool absence: "missing" may
only be computed from a successful, well-formed tools/list response, the
daily summary must speak "inventory unobserved" for probe failures, and
probe evidence must carry bounded outcome tokens instead of raw exception
text.

Loads bot-errors-health-check.py via importlib (hyphen in filename prevents
normal import) and drives tool_inventory / required_tools_daily_sections
with a monkeypatched json_rpc.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check_tool_inventory", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def mod(monkeypatch):
    module = _load_module()
    for var in (
        "BOT_ERRORS_DRY_TOOL_NAMES",
        "BOT_ERRORS_DRY_TOOL_NAMES_SEQUENCE",
    ):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("BOT_ERRORS_TOOL_LIST_ATTEMPTS", "1")
    monkeypatch.setenv("BOT_ERRORS_TOOL_LIST_RETRY_DELAY_SECONDS", "0")
    monkeypatch.setattr(module, "SOCKET_PATH", "/tmp/inventory-probe.sock")
    monkeypatch.setattr(module, "REQUIRED_TOOLS", ["list_chats", "send_message"])
    return module


def _run(mod, rpc):
    mod.json_rpc = rpc
    return mod.tool_inventory({})


def _assert_probe_failure(lines, probe, expected_outcome, forbidden_fragments=()):
    assert probe["outcome"] == expected_outcome
    assert probe["missing"] == []
    joined = "\n".join(lines)
    assert "required_missing=" not in joined, "a failed probe must not claim observed absence"
    for fragment in ("list_chats", "send_message", *forbidden_fragments):
        assert fragment not in joined, f"probe evidence leaked {fragment!r}"


# ===========================================================================
# Probe failures must never claim observed tool absence
# ===========================================================================

def test_unset_socket_is_probe_config_missing_not_missing_tools(mod, monkeypatch):
    monkeypatch.setattr(mod, "SOCKET_PATH", "")
    lines, probe = mod.tool_inventory({})
    assert probe["outcome"] == "probe_config_missing"
    assert probe["missing"] == []
    joined = "\n".join(lines)
    assert "BOT_ERRORS_SOCKET_PATH" in joined
    assert "required_missing=" not in joined


def test_connection_refused_is_transport_unreachable(mod):
    def rpc(*_args, **_kwargs):
        raise ConnectionRefusedError("connect to /private/topology/personal.sock refused")

    lines, probe = _run(mod, rpc)
    assert probe["outcome"] == "transport_unreachable"
    _assert_probe_failure(lines, probe, "transport_unreachable", ("/private/topology",))


def test_rpc_timeout_is_transport_unreachable(mod):
    def rpc(*_args, **_kwargs):
        raise RuntimeError("timeout waiting for JSON-RPC response")

    lines, probe = _run(mod, rpc)
    assert probe["outcome"] == "transport_unreachable"
    _assert_probe_failure(lines, probe, "transport_unreachable")


def test_socket_file_vanished_is_transport_unreachable(mod):
    def rpc(*_args, **_kwargs):
        raise RuntimeError("socket missing: /private/topology/personal.sock")

    lines, probe = _run(mod, rpc)
    assert probe["outcome"] == "transport_unreachable"
    _assert_probe_failure(lines, probe, "transport_unreachable", ("/private/topology",))


def test_rpc_error_response_is_rpc_error(mod):
    def rpc(*_args, **_kwargs):
        raise RuntimeError("rpc error: {'code': -32000, 'message': 'secret internals'}")

    lines, probe = _run(mod, rpc)
    assert probe["outcome"] == "rpc_error"
    _assert_probe_failure(lines, probe, "rpc_error", ("secret internals", "-32000"))


def test_malformed_json_is_inventory_malformed(mod):
    def rpc(*_args, **_kwargs):
        raise json.JSONDecodeError("Expecting value", "private raw line", 0)

    lines, probe = _run(mod, rpc)
    assert probe["outcome"] == "inventory_malformed"
    _assert_probe_failure(lines, probe, "inventory_malformed", ("private raw line",))


def test_non_list_tools_payload_is_inventory_malformed(mod):
    lines, probe = _run(mod, lambda *_a, **_k: {"tools": "not-a-list"})
    assert probe["outcome"] == "inventory_malformed"
    assert probe["missing"] == []
    _assert_probe_failure(lines, probe, "inventory_malformed", ("not-a-list",))


def test_malformed_tool_entries_are_inventory_malformed(mod):
    lines, probe = _run(mod, lambda *_a, **_k: {"tools": [{"name": "send_message"}, {"nope": 1}]})
    assert probe["outcome"] == "inventory_malformed"
    assert probe["missing"] == []
    assert "required_missing=" not in "\n".join(lines)


# ===========================================================================
# Observed inventory keeps computing genuine set difference
# ===========================================================================

def test_observed_subset_reports_exactly_the_observed_difference(mod):
    lines, probe = _run(mod, lambda *_a, **_k: {"tools": [{"name": "send_message"}]})
    assert probe["outcome"] == "inventory_missing"
    assert probe["missing"] == ["list_chats"]
    assert any("required_missing=list_chats" in line for line in lines)


def test_complete_inventory_is_inventory_ok(mod):
    lines, probe = _run(
        mod, lambda *_a, **_k: {"tools": [{"name": "send_message"}, {"name": "list_chats"}]}
    )
    assert probe["outcome"] == "inventory_ok"
    assert probe["missing"] == []
    assert any("required_missing=none" in line for line in lines)


def test_skipped_profile_is_skipped(mod):
    lines, probe = mod.tool_inventory({"expectPersonalTools": False})
    assert probe["outcome"] == "skipped"
    assert probe["missing"] == []
    assert any("skipped by health profile" in line for line in lines)


# ===========================================================================
# Retry transitions
# ===========================================================================

def test_retry_from_probe_failure_to_complete_inventory_emits_no_missing_claim(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_TOOL_LIST_ATTEMPTS", "2")
    calls = {"n": 0}

    def rpc(*_args, **_kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionRefusedError("first attempt refused")
        return {"tools": [{"name": "send_message"}, {"name": "list_chats"}]}

    lines, probe = _run(mod, rpc)
    assert calls["n"] == 2
    assert probe["outcome"] == "inventory_ok"
    assert probe["missing"] == []
    assert "required_missing=none" in "\n".join(lines)


def test_retry_from_probe_failure_to_observed_subset_reports_only_that_subset(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_TOOL_LIST_ATTEMPTS", "2")
    calls = {"n": 0}

    def rpc(*_args, **_kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("timeout waiting for JSON-RPC response")
        return {"tools": [{"name": "send_message"}]}

    lines, probe = _run(mod, rpc)
    assert calls["n"] == 2
    assert probe["outcome"] == "inventory_missing"
    assert probe["missing"] == ["list_chats"]


def test_observed_subset_then_probe_failure_keeps_the_observed_subset(mod, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_TOOL_LIST_ATTEMPTS", "2")
    calls = {"n": 0}

    def rpc(*_args, **_kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"tools": [{"name": "send_message"}]}
        raise ConnectionRefusedError("second attempt refused")

    lines, probe = _run(mod, rpc)
    assert probe["outcome"] == "inventory_missing"
    assert probe["missing"] == ["list_chats"], "an observed subset outranks a later probe failure"


# ===========================================================================
# Daily summary honesty
# ===========================================================================

def test_daily_sections_for_probe_failure_say_unobserved_not_missing(mod):
    fail_line, failure_entry, summary = mod.required_tools_daily_sections(
        {"outcome": "transport_unreachable", "missing": []}
    )
    assert "outcome=transport_unreachable" in fail_line
    assert "unobserved" in failure_entry
    assert "unobserved" in summary
    for text in (fail_line, failure_entry, summary):
        assert "missing required tools" not in text
        assert "required_missing=" not in text


def test_daily_sections_for_observed_absence_keep_missing_wording(mod):
    fail_line, failure_entry, summary = mod.required_tools_daily_sections(
        {"outcome": "inventory_missing", "missing": ["list_chats"]}
    )
    assert fail_line == "FAIL required_tools: required_missing=list_chats"
    assert failure_entry == "required tools missing: list_chats"
    assert summary == "BOT ERRORS daily health found issues: missing required tools list_chats"


def test_daily_sections_for_healthy_outcomes_are_silent(mod):
    assert mod.required_tools_daily_sections({"outcome": "inventory_ok", "missing": []}) == (None, None, None)
    assert mod.required_tools_daily_sections({"outcome": "skipped", "missing": []}) == (None, None, None)


# ===========================================================================
# Banked Car 5 review nits (same file)
# ===========================================================================

def test_bounded_service_status_keeps_darwin_process_fallback_token(mod):
    assert mod._bounded_service_status("active_process_fallback") == "active_process_fallback"


# ===========================================================================
# Runtime contract binding from the initialize handshake (#2408 slice 6b)
# ===========================================================================

def _handshake_rpc(handshake, tools):
    def rpc(*_args, initialize_sink=None, **_kwargs):
        if initialize_sink is not None:
            initialize_sink.update(handshake)
        return {"tools": tools}

    return rpc


_FULL_TOOLS = [{"name": "send_message"}, {"name": "list_chats"}]
_GOOD_HANDSHAKE = {
    "protocolVersion": "2024-11-05",
    "serverInfo": {"name": "whatsoup", "version": "0.1.0"},
}


def test_contract_captured_from_initialize_handshake(mod):
    lines, probe = _run(mod, _handshake_rpc(_GOOD_HANDSHAKE, _FULL_TOOLS))
    assert probe["outcome"] == "inventory_ok"
    assert probe["contract"] == {
        "protocolVersion": "2024-11-05",
        "serverName": "whatsoup",
        "serverVersion": "0.1.0",
    }
    assert any("contract: protocol=2024-11-05 server=whatsoup/0.1.0" in line for line in lines)


def test_protocol_version_drift_is_protocol_mismatch_not_missing(mod):
    drifted = {"protocolVersion": "2099-01-01", "serverInfo": {"name": "whatsoup", "version": "9.9.9"}}
    lines, probe = _run(mod, _handshake_rpc(drifted, _FULL_TOOLS))
    assert probe["outcome"] == "protocol_mismatch"
    assert probe["missing"] == []
    assert probe["contract"]["protocolVersion"] == "2099-01-01"
    assert "required_missing=" not in "\n".join(lines)


def test_profile_tool_contract_selects_expectations_on_identity_match(mod):
    profile = {
        "toolContract": {
            "serverName": "whatsoup",
            "protocolVersion": "2024-11-05",
            "requiredTools": ["send_message", "extra_tool"],
        }
    }
    mod.json_rpc = _handshake_rpc(_GOOD_HANDSHAKE, _FULL_TOOLS)
    lines, probe = mod.tool_inventory(profile)
    assert probe["outcome"] == "inventory_missing"
    assert probe["missing"] == ["extra_tool"], "expectations must come from the matched contract, not the default set"
    assert any("required_missing=extra_tool" in line for line in lines)


def test_profile_tool_contract_identity_mismatch_fails_closed(mod):
    profile = {
        "toolContract": {
            "serverName": "whatsoup",
            "protocolVersion": "2024-11-05",
            "requiredTools": ["send_message", "extra_tool"],
        }
    }
    other = {"protocolVersion": "2024-11-05", "serverInfo": {"name": "other-server", "version": "0.1.0"}}
    mod.json_rpc = _handshake_rpc(other, _FULL_TOOLS)
    lines, probe = mod.tool_inventory(profile)
    assert probe["outcome"] == "protocol_mismatch"
    assert probe["missing"] == []
    assert "required_missing=" not in "\n".join(lines)


def test_unknown_identity_without_profile_contract_keeps_observed_inventory(mod):
    lines, probe = _run(mod, _handshake_rpc({}, [{"name": "send_message"}]))
    assert probe["outcome"] == "inventory_missing"
    assert probe["missing"] == ["list_chats"]
    assert probe["contract"] == {"protocolVersion": None, "serverName": None, "serverVersion": None}


def test_unknown_identity_with_profile_contract_fails_closed(mod):
    profile = {
        "toolContract": {
            "serverName": "whatsoup",
            "protocolVersion": "2024-11-05",
            "requiredTools": ["send_message"],
        }
    }
    mod.json_rpc = _handshake_rpc({}, _FULL_TOOLS)
    lines, probe = mod.tool_inventory(profile)
    assert probe["outcome"] == "protocol_mismatch"
    assert probe["missing"] == []


def test_real_socket_initialize_sink_captures_handshake(mod, tmp_path, monkeypatch):
    import socket as socket_module
    import tempfile
    import threading

    # AF_UNIX sun_path is capped (~104 bytes on darwin); pytest tmp_path is too
    # deep, so the socket lives in a short mkdtemp dir cleaned up below.
    short_dir = tempfile.mkdtemp(prefix="ti-")
    socket_path = str(Path(short_dir) / "probe.sock")
    server = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)
    server.bind(socket_path)
    server.listen(1)

    def serve_once():
        conn, _addr = server.accept()
        with conn:
            reader = conn.makefile("r", encoding="utf-8", newline="\n")
            writer = conn.makefile("w", encoding="utf-8", newline="\n")
            init_req = json.loads(reader.readline())
            writer.write(json.dumps({
                "jsonrpc": "2.0",
                "id": init_req["id"],
                "result": {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {"name": "whatsoup", "version": "0.1.0"},
                },
            }) + "\n")
            writer.flush()
            call_req = json.loads(reader.readline())
            writer.write(json.dumps({
                "jsonrpc": "2.0",
                "id": call_req["id"],
                "result": {"tools": [{"name": "send_message"}]},
            }) + "\n")
            writer.flush()

    thread = threading.Thread(target=serve_once, daemon=True)
    thread.start()
    try:
        sink: dict = {}
        result = mod.json_rpc(socket_path, "tools/list", {}, timeout=5.0, initialize_sink=sink)
        thread.join(timeout=5)
    finally:
        server.close()
        import shutil

        shutil.rmtree(short_dir, ignore_errors=True)
    assert result == {"tools": [{"name": "send_message"}]}
    assert sink["protocolVersion"] == "2024-11-05"
    assert sink["serverInfo"] == {"name": "whatsoup", "version": "0.1.0"}


# ===========================================================================
# Delivery-level classifier: info only for proven-ok statuses (Car 5 nit)
# ===========================================================================

def test_delivery_level_info_only_for_proven_ok_statuses(mod):
    assert mod._deadman_delivery_level("sent") == "info"
    assert mod._deadman_delivery_level("suppressed_cooldown") == "info"
    assert mod._deadman_delivery_level("failed") == "warning"
    assert mod._deadman_delivery_level("outcome_unknown") == "warning"
    assert mod._deadman_delivery_level("not_attempted") == "warning"
    assert mod._deadman_delivery_level("garbage-token") == "warning"


# ===========================================================================
# #2408 slice 6c: predicate lifecycle + durable last-trustworthy inventory
# ===========================================================================

def _probe_missing(mod, missing, observed_count=3):
    return mod._tool_probe(
        "inventory_missing",
        missing=missing,
        observed_count=observed_count,
        attempts="1/1",
        contract={"protocolVersion": "2024-11-05", "serverName": "whatsoup", "serverVersion": "0.1.0"},
    )


def _probe_ok(mod, observed_count=5):
    return mod._tool_probe(
        "inventory_ok",
        observed_count=observed_count,
        attempts="1/1",
        contract={"protocolVersion": "2024-11-05", "serverName": "whatsoup", "serverVersion": "0.1.0"},
    )


@pytest.fixture()
def lifecycle_mod(mod, monkeypatch, tmp_path):
    monkeypatch.setattr(mod, "state_root", lambda: tmp_path)
    return mod


def test_observed_missing_opens_condition_and_records_trustworthy(lifecycle_mod):
    mod = lifecycle_mod
    state = mod.load_tool_inventory_state()
    dirty, events, extra = mod.required_tools_lifecycle(state, _probe_missing(mod, ["send_message"]), 1_000)
    assert dirty is True
    assert len(events) == 1
    event_type, severity, summary, evidence = events[0]
    assert event_type == "alert"
    assert severity == "critical"
    assert "send_message" in summary
    assert "FAIL required_tools: required_missing=send_message" in evidence
    assert state["openCondition"]["kind"] == "inventory_missing"
    assert state["openCondition"]["openedAtEpoch"] == 1_000
    trustworthy = state["lastTrustworthy"]
    assert trustworthy["observedAtEpoch"] == 1_000
    assert trustworthy["missing"] == ["send_message"]
    assert trustworthy["observedCount"] == 3


def test_probe_failure_opens_condition_with_distinct_evidence(lifecycle_mod):
    mod = lifecycle_mod
    state = mod.load_tool_inventory_state()
    dirty, events, extra = mod.required_tools_lifecycle(state, mod._tool_probe("transport_unreachable"), 1_000)
    assert dirty is True
    assert len(events) == 1
    event_type, severity, summary, evidence = events[0]
    assert event_type == "alert"
    assert severity == "critical"
    assert "unobserved" in summary
    assert "FAIL required_tools_probe: outcome=transport_unreachable" in evidence
    assert "required_missing=" not in evidence, "a failed probe must not claim observed absence"
    assert state["openCondition"]["kind"] == "probe_failure"
    assert state["lastTrustworthy"] is None


def test_probe_failure_never_touches_last_trustworthy(lifecycle_mod):
    mod = lifecycle_mod
    state = mod.load_tool_inventory_state()
    mod.required_tools_lifecycle(state, _probe_missing(mod, ["send_message"]), 1_000)
    before = json.loads(json.dumps(state["lastTrustworthy"]))
    dirty, events, extra = mod.required_tools_lifecycle(state, mod._tool_probe("rpc_error"), 2_000)
    assert state["lastTrustworthy"] == before, "a failed probe must never rewrite the trustworthy record"
    joined = "\n".join([*extra, events[0][3]])
    assert "last-trustworthy" in joined
    assert "age=" in joined and "observed=" in joined
    assert "/" not in joined.replace("1/1", ""), f"lifecycle evidence leaked a path: {joined!r}"


def test_recovery_clears_exactly_once(lifecycle_mod):
    mod = lifecycle_mod
    state = mod.load_tool_inventory_state()
    mod.required_tools_lifecycle(state, _probe_missing(mod, ["send_message"]), 1_000)
    dirty, events, _extra = mod.required_tools_lifecycle(state, _probe_ok(mod), 2_000)
    assert dirty is True
    assert [event[0] for event in events] == ["clear"]
    assert events[0][1] == "info"
    assert state["openCondition"] is None
    dirty, events, _extra = mod.required_tools_lifecycle(state, _probe_ok(mod), 3_000)
    assert events == [], "a second healthy run must not manufacture another recovery"


def test_recovery_without_open_condition_is_quiet(lifecycle_mod):
    mod = lifecycle_mod
    state = mod.load_tool_inventory_state()
    dirty, events, _extra = mod.required_tools_lifecycle(state, _probe_ok(mod), 1_000)
    assert events == []
    assert state["openCondition"] is None
    assert state["lastTrustworthy"]["observedAtEpoch"] == 1_000


def test_skipped_probe_neither_opens_nor_clears(lifecycle_mod):
    mod = lifecycle_mod
    state = mod.load_tool_inventory_state()
    mod.required_tools_lifecycle(state, mod._tool_probe("transport_unreachable"), 1_000)
    opened = json.loads(json.dumps(state["openCondition"]))
    dirty, events, extra = mod.required_tools_lifecycle(state, mod._tool_probe("skipped"), 2_000)
    assert dirty is False
    assert events == []
    assert extra == []
    assert state["openCondition"] == opened, "a skipped probe cannot verify recovery nor drop the pending clear"


def test_restart_preserves_identity_and_pending_clear(lifecycle_mod):
    mod = lifecycle_mod
    state = mod.load_tool_inventory_state()
    mod.required_tools_lifecycle(state, mod._tool_probe("transport_unreachable"), 1_000)
    mod.save_tool_inventory_state(state)

    reloaded = mod.load_tool_inventory_state()
    assert reloaded["openCondition"]["openedAtEpoch"] == 1_000
    dirty, events, _extra = mod.required_tools_lifecycle(reloaded, _probe_ok(mod), 2_000)
    assert [event[0] for event in events] == ["clear"], "restart must not lose the pending clear"
    assert reloaded["openCondition"] is None


def test_repeated_identical_alert_keeps_identity_and_is_not_dirty(lifecycle_mod):
    mod = lifecycle_mod
    state = mod.load_tool_inventory_state()
    mod.required_tools_lifecycle(state, mod._tool_probe("transport_unreachable"), 1_000)
    dirty, events, _extra = mod.required_tools_lifecycle(state, mod._tool_probe("transport_unreachable"), 2_000)
    assert [event[0] for event in events] == ["alert"], "the condition must keep re-alerting while unhealthy"
    assert dirty is False, "an unchanged condition must not rewrite durable state"
    assert state["openCondition"]["openedAtEpoch"] == 1_000


def test_probe_failure_then_observed_missing_is_one_condition(lifecycle_mod):
    mod = lifecycle_mod
    state = mod.load_tool_inventory_state()
    mod.required_tools_lifecycle(state, mod._tool_probe("transport_unreachable"), 1_000)
    dirty, events, _extra = mod.required_tools_lifecycle(state, _probe_missing(mod, ["send_message"]), 2_000)
    assert [event[0] for event in events] == ["alert"]
    assert state["openCondition"]["kind"] == "inventory_missing"
    assert state["openCondition"]["openedAtEpoch"] == 1_000, "kind churn must not re-open the incident identity"


def test_corrupt_state_file_fails_open_with_bounded_error(lifecycle_mod):
    mod = lifecycle_mod
    mod.tool_inventory_state_path().write_text("{not json", encoding="utf-8")
    state = mod.load_tool_inventory_state()
    assert state["openCondition"] is None
    assert state["lastTrustworthy"] is None
    assert len(state.get("loadError") or "") <= 240
    dirty, events, _extra = mod.required_tools_lifecycle(state, _probe_ok(mod), 1_000)
    assert events == []


def test_tool_inventory_state_rejects_unproven_publication(lifecycle_mod, monkeypatch):
    mod = lifecycle_mod
    import sys

    sys.path.insert(0, str(_SCRIPT.parent))
    from lib import durable_json

    unproven = durable_json.PublicationResult(
        component="health_check.tool_inventory_state",
        durability=durable_json.DurabilityProof.UNPROVEN,
        confinement=durable_json.ConfinementProof.PROVEN,
        cleanup=durable_json.CleanupState.NOT_REQUIRED,
        authority=durable_json.AuthorityState.UNKNOWN,
        stage=durable_json.WriteStage.PARENT_SYNC,
        error_class=durable_json.ErrorClass.IO,
        generation=1,
        private_operation_id="private-operation",
        private_content_sha256="private-digest",
    )
    monkeypatch.setattr(mod, "publish_state_json", lambda *_args, **_kwargs: unproven)
    with pytest.raises(Exception) as raised:
        mod.save_tool_inventory_state({"schemaVersion": 1, "lastTrustworthy": None, "openCondition": None})
    assert type(raised.value).__name__ == "DurableWriteError"
    assert not mod.tool_inventory_state_path().exists()


def test_required_tools_alert_source_constant(mod):
    assert mod.REQUIRED_TOOLS_ALERT_SOURCE == "required_tools"


# ===========================================================================
# #2408 slice 6c: critical-asset registration for the two FAIL classes
# ===========================================================================

def test_critical_asset_observed_missing_is_confirmed_availability(mod):
    asset = mod.critical_asset_from_health_evidence("FAIL required_tools: required_missing=send_message")
    assert asset["failure"]["code"] == "MCP_REQUIRED_TOOLS_MISSING"
    assert asset["failure"]["domain"] == "tool_availability"
    assert asset["failure"]["confidence"] == "confirmed"
    assert asset["asset"]["kind"] == "mcp_tool_inventory"


def test_critical_asset_probe_failure_is_probable_observability(mod):
    asset = mod.critical_asset_from_health_evidence("FAIL required_tools_probe: outcome=transport_unreachable")
    assert asset["failure"]["code"] == "MCP_TOOL_INVENTORY_UNOBSERVED"
    assert asset["failure"]["domain"] == "tool_observability"
    assert asset["failure"]["confidence"] == "probable"
    assert asset["asset"]["kind"] == "mcp_tool_inventory"


def test_critical_asset_tool_predicate_never_overrides_event_instance(mod):
    evidence = "\n".join([
        "FAIL required_tools: required_missing=send_message",
        "health personal: connected recent_activity=ok",
    ])
    asset = mod.critical_asset_from_health_evidence(evidence)
    assert asset["failure"]["code"] == "MCP_REQUIRED_TOOLS_MISSING"
    assert mod.critical_asset_instance(asset) is None, (
        "a sibling instance token must not become the incident instance: the "
        "companion clear keys on the default instance, and an override here "
        "would orphan the open incident"
    )


def test_critical_asset_auth_bond_priority_beats_tool_predicate(mod):
    evidence = "\n".join([
        "FAIL auth_bond personal: mode_violation=creds.json",
        "FAIL required_tools_probe: outcome=rpc_error",
    ])
    asset = mod.critical_asset_from_health_evidence(evidence)
    assert asset["failure"]["code"] == "WA_AUTH_BOND_PERMISSION_DRIFT", (
        "credential-integrity classification must keep priority over the tool predicate"
    )
