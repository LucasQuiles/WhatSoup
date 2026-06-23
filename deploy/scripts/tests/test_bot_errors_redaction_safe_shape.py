"""B1 — safe-shape credential-path redaction.

When BOT_ERRORS_SAFE_SHAPE_CRED_PATH is enabled, a credential-adjacent path is
redacted to an *actionable shape* that preserves the directory category + a
redacted leaf (e.g. ``~/.config/whatsoup/[REDACTED]``) instead of the opaque
bare ``[REDACTED CREDENTIAL PATH]`` marker. A real secret VALUE (token string)
is still fully redacted regardless of the gate.

Default-off preserves the legacy bare-marker output (honored by the SSOT /
parity regression suites in test_bot_errors_redaction_regex.py and the TS
emit-alert / auth-cli redaction tests).
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Callable

import pytest

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]


def _load_module(script_name: str):
    spec = importlib.util.spec_from_file_location(script_name.replace("-", "_"), _SCRIPT_ROOT / script_name)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _redact() -> Callable[[str], str]:
    return getattr(_load_module("bot-errors-emit.py"), "redact")


def test_default_off_keeps_legacy_bare_marker(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("BOT_ERRORS_SAFE_SHAPE_CRED_PATH", raising=False)
    redact = _redact()
    out = redact("expected_path=~/.config/whatsoup/fleet-tokens.json")
    assert "[REDACTED CREDENTIAL PATH]" in out
    assert "fleet-tokens.json" not in out


def test_safe_shape_preserves_dir_and_marks_leaf(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BOT_ERRORS_SAFE_SHAPE_CRED_PATH", "1")
    redact = _redact()
    out = redact("expected_path=~/.config/whatsoup/fleet-tokens.json")
    # Operator can still see WHICH dir category + that it's a tokens file.
    assert "~/.config/whatsoup/" in out
    assert "[REDACTED]" in out
    # The bare opaque marker is gone — the shape is actionable.
    assert "[REDACTED CREDENTIAL PATH]" not in out
    # The leaf filename's secret-ish portion is not exposed verbatim.
    assert "fleet-tokens.json" not in out


def test_safe_shape_still_fully_redacts_a_real_token_value(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BOT_ERRORS_SAFE_SHAPE_CRED_PATH", "1")
    redact = _redact()
    secret = "ghp_" + "z" * 30
    out = redact(f"path=~/.config/whatsoup/creds.json secret_value {secret} here")
    # The real secret token value is fully gone regardless of the safe-shape gate.
    assert secret not in out
    assert "[REDACTED GITHUB TOKEN]" in out
    # The path is safe-shaped, not opaquely marked.
    assert "~/.config/whatsoup/[REDACTED]" in out
