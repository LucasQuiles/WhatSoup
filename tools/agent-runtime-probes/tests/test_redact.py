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


def test_boolean_under_sensitive_key_preserved_not_clobbered():
    # Regression (M1c): a boolean under a sensitive-named key that is NOT allowlisted must be
    # preserved, not clobbered to the truthy string "<redacted>". A bool is never a credential,
    # and clobbering False -> "<redacted>" silently flips falsy telemetry/attestation to truthy.
    out = redact({"token_present": False, "auth_ok": True, "has_secret": False}, "")
    assert out["token_present"] is False, out
    assert out["auth_ok"] is True, out
    assert out["has_secret"] is False, out


def test_password_hash_value_still_redacted_after_allowlist_port():
    # Security trim (M1b port-forward): the allowlist must NOT let a *_hash suffix pass a
    # credential hash through. A password/secret hash value does not match SECRET_VALUE, so it
    # would leak if the key were allowlisted by bare suffix. It must stay redacted by key name.
    out = redact({"password_hash": "a94a8fe5ccb19ba61c4c0873d391e987"}, "")
    assert out["password_hash"] == "<redacted>", out


def test_token_reasoning_proxy_opaque_value_redacted():
    # Security trim (M1b port-forward): token_reasoning_proxy is ambiguous; an opaque string
    # value must remain redacted (we do NOT allowlist it).
    out = redact({"token_reasoning_proxy": "opaque-proxy-string-xyz"}, "")
    assert out["token_reasoning_proxy"] == "<redacted>", out


def test_benign_token_counts_preserved_after_allowlist_port():
    # Port-forward benign telemetry: integer count fields under token-named keys are preserved.
    cfg = {"input_tokens": 1280, "output_tokens": 42, "cache_read_input_tokens": 9,
           "content_hash": "deadbeefcafebabe", "no_secrets_attested": True}
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
