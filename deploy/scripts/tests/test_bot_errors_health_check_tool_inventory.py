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
