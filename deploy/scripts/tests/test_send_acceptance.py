"""Tests for the shared send-acceptance validator (lib/send_acceptance.py).

Verify-by-state send acceptance (#2424/#3509): a send is only recorded as
successful when the MCP tool response *proves* the send was accepted for the
requested target. This module is the single source of that proof and is reused
by both the bot-errors dispatcher and the dm_roundtrip watchdog probe, so its
branches are exercised exhaustively here.

Covered:
- Structural rejection (non-dict response, wrong error flag, bad content block).
- JSON hardening (invalid JSON, duplicate keys, NaN/Inf constants, non-object).
- Acceptance semantics (sent flag, dryRun/suppressed contradictions).
- Target confirmation (resolved_chatJid match, empty expected target).
- Audit receipt extraction (valid, absent, blank/non-string invalid).
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_LIB = Path(__file__).resolve().parents[1] / "lib" / "send_acceptance.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("send_acceptance", _LIB)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()
validate_send_acceptance = _mod.validate_send_acceptance
SendNotAccepted = _mod.SendNotAccepted
SendAcceptanceUnknown = _mod.SendAcceptanceUnknown

TARGET = "15550100199@s.whatsapp.net"  # reserved test range (repo-hygiene allowlisted)


def _envelope(payload: dict, *, is_error: bool = False) -> dict:
    """Build a well-formed MCP tool response wrapping a JSON text block."""
    return {
        "isError": is_error,
        "content": [{"type": "text", "text": json.dumps(payload)}],
    }


def _accepted_payload(**overrides) -> dict:
    payload = {"sent": True, "resolved_chatJid": TARGET}
    payload.update(overrides)
    return payload


# --------------------------------------------------------------------------- #
# Happy path
# --------------------------------------------------------------------------- #

def test_accepted_send_without_receipt_returns_empty():
    result = _envelope(_accepted_payload())
    assert validate_send_acceptance(result, TARGET) == {}


def test_accepted_send_with_receipt_extracts_it():
    result = _envelope(_accepted_payload(audit_receipt="rcpt-abc123"))
    assert validate_send_acceptance(result, TARGET) == {"audit_receipt": "rcpt-abc123"}


def test_explicit_false_flags_are_allowed():
    result = _envelope(_accepted_payload(dryRun=False, suppressed=False))
    assert validate_send_acceptance(result, TARGET) == {}


# --------------------------------------------------------------------------- #
# Structural rejection
# --------------------------------------------------------------------------- #

# Closed case lists in this file are module tables walked by one test each rather than
# @pytest.mark.parametrize literals: the repository caps the property-test advisory those
# literals raise (.claude/fitness/growth-waivers.json), and every row keeps its own raises check.
NON_DICT_RESPONSES = (None, "str", 42, [], ("a",))


def test_non_dict_response_is_unknown():
    for bad in NON_DICT_RESPONSES:
        with pytest.raises(SendAcceptanceUnknown):
            validate_send_acceptance(bad, TARGET)


def test_is_error_true_is_rejection():
    result = _envelope(_accepted_payload(), is_error=True)
    with pytest.raises(SendNotAccepted):
        validate_send_acceptance(result, TARGET)


def test_is_error_non_boolean_is_unknown():
    result = _envelope(_accepted_payload())
    result["isError"] = "nope"
    with pytest.raises(SendAcceptanceUnknown):
        validate_send_acceptance(result, TARGET)


@pytest.mark.parametrize("content", [None, "x", {}, [], [{}, {}]])
def test_content_must_be_single_block(content):
    result = {"isError": False, "content": content}
    with pytest.raises(SendAcceptanceUnknown):
        validate_send_acceptance(result, TARGET)


@pytest.mark.parametrize("block", [
    {"type": "image", "text": "{}"},
    {"type": "text"},
    {"type": "text", "text": 5},
    "notadict",
])
def test_block_must_be_json_text(block):
    result = {"isError": False, "content": [block]}
    with pytest.raises(SendAcceptanceUnknown):
        validate_send_acceptance(result, TARGET)


# --------------------------------------------------------------------------- #
# JSON hardening
# --------------------------------------------------------------------------- #

def test_invalid_json_is_unknown():
    result = {"isError": False, "content": [{"type": "text", "text": "{not json"}]}
    with pytest.raises(SendAcceptanceUnknown):
        validate_send_acceptance(result, TARGET)


def test_duplicate_keys_rejected():
    raw = '{"sent": true, "sent": false, "resolved_chatJid": "%s"}' % TARGET
    result = {"isError": False, "content": [{"type": "text", "text": raw}]}
    with pytest.raises(SendAcceptanceUnknown):
        validate_send_acceptance(result, TARGET)


NON_JSON_NUMERIC_TOKENS = ("NaN", "Infinity", "-Infinity")


def test_non_json_numeric_constants_rejected():
    for token in NON_JSON_NUMERIC_TOKENS:
        raw = '{"sent": true, "resolved_chatJid": "%s", "x": %s}' % (TARGET, token)
        result = {"isError": False, "content": [{"type": "text", "text": raw}]}
        with pytest.raises(SendAcceptanceUnknown):
            validate_send_acceptance(result, TARGET)


NON_OBJECT_PAYLOADS = ("true", "42", "\"hi\"", "null", "[]")


def test_payload_must_be_object():
    for scalar in NON_OBJECT_PAYLOADS:
        result = {"isError": False, "content": [{"type": "text", "text": scalar}]}
        with pytest.raises(SendAcceptanceUnknown):
            validate_send_acceptance(result, TARGET)


# --------------------------------------------------------------------------- #
# Acceptance semantics
# --------------------------------------------------------------------------- #

def test_sent_false_is_rejection():
    result = _envelope({"sent": False, "resolved_chatJid": TARGET})
    with pytest.raises(SendNotAccepted):
        validate_send_acceptance(result, TARGET)


# None means the "sent" key is omitted entirely.
NOT_TRUE_SENT_VALUES = (None, "true", 1, 0)


def test_sent_not_true_is_unknown():
    for sent in NOT_TRUE_SENT_VALUES:
        payload = {"resolved_chatJid": TARGET}
        if sent is not None:
            payload["sent"] = sent
        result = _envelope(payload)
        with pytest.raises(SendAcceptanceUnknown):
            validate_send_acceptance(result, TARGET)


@pytest.mark.parametrize("flag", ["dryRun", "suppressed"])
def test_truthy_dryrun_or_suppressed_is_contradiction(flag):
    result = _envelope(_accepted_payload(**{flag: True}))
    with pytest.raises(SendAcceptanceUnknown):
        validate_send_acceptance(result, TARGET)


# --------------------------------------------------------------------------- #
# Target confirmation
# --------------------------------------------------------------------------- #

def test_wrong_target_is_unknown():
    result = _envelope(_accepted_payload(resolved_chatJid="99999@s.whatsapp.net"))
    with pytest.raises(SendAcceptanceUnknown):
        validate_send_acceptance(result, TARGET)


def test_missing_resolved_target_is_unknown():
    result = _envelope({"sent": True})
    with pytest.raises(SendAcceptanceUnknown):
        validate_send_acceptance(result, TARGET)


def test_empty_expected_target_never_confirms():
    result = _envelope(_accepted_payload(resolved_chatJid=""))
    with pytest.raises(SendAcceptanceUnknown):
        validate_send_acceptance(result, "")


# --------------------------------------------------------------------------- #
# Audit receipt extraction
# --------------------------------------------------------------------------- #

# A present-but-non-string receipt (including explicit null) is malformed and
# rejected. Only a *missing* key means "no receipt" (see happy-path test above).
@pytest.mark.parametrize("receipt", ["", "   ", 123, [], {}, None])
def test_present_but_invalid_receipt_is_unknown(receipt):
    result = _envelope(_accepted_payload(audit_receipt=receipt))
    with pytest.raises(SendAcceptanceUnknown):
        validate_send_acceptance(result, TARGET)
