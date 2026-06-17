#!/usr/bin/env python3
"""Adversarial tests for probelib.redact — proves the historical fail-open hole is closed.

Runnable standalone (`python3 tests/test_redact.py`) and pytest-discoverable.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from probelib import redact  # noqa: E402


def test_secret_in_command_list_redacted():
    # The historical fail-open: a secret token inside a list under a generic key name.
    # Old key-name-only redactor leaked this; content-aware redactor must catch it.
    out = redact({"command": ["mcp", "--token", "sk-abcd1234efgh5678"]}, "mcp_servers")
    assert "sk-abcd1234efgh5678" not in str(out), out


def test_secret_value_under_generic_key():
    out = redact({"args": "pcsk_aaaaaaaaaaaaaaaa"}, "")
    assert out["args"] == "<redacted:value>", out


def test_sensitive_key_name_redacted():
    out = redact({"apiKey": "whatever-value-123456"}, "")
    assert out["apiKey"] == "<redacted>", out


def test_structure_and_safe_values_preserved():
    cfg = {"model": "claude-opus-4-8", "mcp": {"pinecone": {"enabled": True}}, "count": 5}
    assert redact(cfg, "") == cfg


def test_safe_metadata_keys_with_sensitive_words_preserved():
    cfg = {
        "first_token_family": "cmd:git",
        "tokens_sha256_16": "0123456789abcdef",
        "has_secret_word": False,
        "has_url": True,
        "env_key_names": ["WHATSOUP_SOCKET", "MEDIA_BRIDGE_SOCKET"],
        "autoCompactInputTokens": "runtime threshold metadata",
    }
    assert redact(cfg, "") == cfg


def test_jwt_and_email_redacted_plain_kept():
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4fwpMeJ"
    out = redact([jwt, "user@example.com", "plain-value"], "")
    assert out[0].startswith("<redacted"), out
    assert out[1].startswith("<redacted"), out
    assert out[2] == "plain-value", out


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} redactor tests passed")
