"""Regression tests for BOT ERRORS credential-path redaction regexes."""
from __future__ import annotations

import importlib.util
import time
from pathlib import Path
from typing import Callable

import pytest

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]


def _load_module(script_name: str):
    spec = importlib.util.spec_from_file_location(script_name.replace("-", "_"), _SCRIPT_ROOT / script_name)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_REDACTORS: list[tuple[str, str, str]] = [
    ("bot-errors-collector.py", "redact_collector_text", "[REDACTED_CREDENTIAL_PATH]"),
    ("bot-errors-dispatcher.py", "redact", "[REDACTED CREDENTIAL PATH]"),
    ("bot-errors-emit.py", "redact", "[REDACTED CREDENTIAL PATH]"),
    ("bot-errors-health-check.py", "redact_event_text", "[REDACTED_CREDENTIAL_PATH]"),
    ("bot-errors-heartbeat-watchdog.py", "redact_watchdog_text", "[REDACTED_CREDENTIAL_PATH]"),
    ("bot-errors-q-loop.py", "redact_text", "[REDACTED CREDENTIAL PATH]"),
    ("bot-errors-runner.py", "redact", "[REDACTED CREDENTIAL PATH]"),
]


@pytest.mark.parametrize(("script_name", "func_name", "marker"), _REDACTORS)
def test_deep_home_credential_paths_still_redact(script_name: str, func_name: str, marker: str):
    mod = _load_module(script_name)
    redact: Callable[[str], str] = getattr(mod, func_name)

    text = "path=/srv/operator/.config/whatsoup/instances/main/auth/creds.json"
    redacted = redact(text)

    assert marker in redacted
    assert "creds.json" not in redacted


@pytest.mark.parametrize(("script_name", "func_name", "marker"), _REDACTORS)
def test_config_secrets_paths_still_redact(script_name: str, func_name: str, marker: str):
    mod = _load_module(script_name)
    redact: Callable[[str], str] = getattr(mod, func_name)

    text = "source=/srv/operator/.config/secrets/provider.env token=visible"
    redacted = redact(text)

    assert marker in redacted
    assert ".config/secrets" not in redacted
    assert "provider.env" not in redacted


@pytest.mark.parametrize(("script_name", "func_name", "_marker"), _REDACTORS)
@pytest.mark.parametrize(
    "raw",
    [
        "Authorization: Bearer " + "sk-" + "live-" + "a" * 26,
        "token='" + "sk-" + "live-" + "b" * 26 + "'",
        "github=" + "ghp_" + "c" * 26,
        "aws=" + "AKIA" + "1" * 16,
        "jwt=" + "eyJ" + "a" * 12 + "." + "eyJ" + "b" * 12 + "." + "c" * 16,
        "url=https://user:password" + "@" + "host.invalid/path",
        "key=-----BEGIN " + "PRIVATE KEY-----\\nabc\\n-----END " + "PRIVATE KEY-----",
        "jid=" + "14155551234" + "@" + "s.whatsapp.net",
    ],
)
def test_common_secret_fixtures_redact_across_consumers(script_name: str, func_name: str, _marker: str, raw: str):
    mod = _load_module(script_name)
    redact: Callable[[str], str] = getattr(mod, func_name)

    redacted = redact(raw)

    assert "sk-live" not in redacted
    assert "ghp_" not in redacted
    assert "AKIA1111111111111111" not in redacted
    assert "eyJabcdefghijk" not in redacted
    assert "user:password@" not in redacted
    assert "BEGIN " + "PRIVATE KEY" not in redacted
    assert "14155551234" not in redacted


@pytest.mark.parametrize(("script_name", "func_name", "_marker"), _REDACTORS)
@pytest.mark.parametrize(
    "leak",
    [
        "123456789:6@s.whatsapp.net",
        "12345:6@lid",
        "123456@s.whatsapp.net",
        "123456-2@s.whatsapp.net",
    ],
)
def test_device_suffixed_jids_fully_masked_across_consumers(
    script_name: str,
    func_name: str,
    _marker: str,
    leak: str,
):
    mod = _load_module(script_name)
    redact: Callable[[str], str] = getattr(mod, func_name)

    redacted = redact("jid=" + leak)

    # The bare numeric local part must not survive verbatim for any form:
    # device-suffixed (:N), device-dash (-N), or plain.
    assert leak not in redacted
    assert leak.split("@", 1)[0] not in redacted


@pytest.mark.parametrize(("script_name", "func_name", "_marker"), _REDACTORS)
@pytest.mark.parametrize(
    ("raw", "expected_prefix"),
    [
        ("authorization=authzsecret" + "d" * 20, "authorization="),
        ("authorization: authzsecret" + "e" * 20, "authorization: "),
    ],
)
def test_authorization_assignment_values_redact_across_consumers(
    script_name: str,
    func_name: str,
    _marker: str,
    raw: str,
    expected_prefix: str,
):
    mod = _load_module(script_name)
    redact: Callable[[str], str] = getattr(mod, func_name)

    redacted = redact(raw)

    assert redacted.startswith(expected_prefix)
    assert "[REDACTED]" in redacted
    assert "authzsecret" not in redacted


@pytest.mark.parametrize(("script_name", "func_name", "_marker"), _REDACTORS)
def test_repeated_pathlike_nonmatches_do_not_backtrack(script_name: str, func_name: str, _marker: str):
    mod = _load_module(script_name)
    redact: Callable[[str], str] = getattr(mod, func_name)

    hostile = "/" + "!/" * 250 + "not-a-credential-path"
    started = time.monotonic()
    redact(hostile)
    elapsed = time.monotonic() - started

    assert elapsed < 0.5


def _load_ssot_redactor() -> Callable[[str], str]:
    spec = importlib.util.spec_from_file_location(
        "bead054_bot_errors_redaction", _SCRIPT_ROOT / "lib" / "bot_errors_redaction.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return lambda text: mod.redact_bot_errors_text(text, credential_path_marker="[REDACTED CREDENTIAL PATH]")


def test_url_userinfo_scheme_does_not_backtrack():
    """BEAD-054 (ReDoS): `URL_USERINFO_RE` previously used an unbounded `[a-z0-9+.-]*`
    scheme wildcard, which backtracked quadratically on adversarial scheme-shaped
    runs (`apikey.`*N): a 140KB input took ~8s. The bounded `{0,30}` form keeps the
    scan linear (finishes in tens of milliseconds here). Mirror of the TS C1 timing
    assertion in tests/redaction-parity.test.ts. Generous sub-second threshold to
    avoid CI flakiness while still separating the fixed (<1s) from the regressed (~8s)."""
    redact = _load_ssot_redactor()
    adversarial = "apikey." * 20000  # ~140KB, no `://`, no trailing `@`
    started = time.monotonic()
    out = redact(adversarial)
    elapsed = time.monotonic() - started

    assert elapsed < 1.0, f"URL_USERINFO_RE backtracked: {elapsed:.3f}s"
    # No `://…@` userinfo present, so the adversarial input passes through unchanged.
    assert out == adversarial


@pytest.mark.parametrize(("script_name", "func_name", "_marker"), _REDACTORS)
def test_operational_diagnostics_remain_actionable(script_name: str, func_name: str, _marker: str):
    mod = _load_module(script_name)
    redact: Callable[[str], str] = getattr(mod, func_name)

    samples = [
        "credential: credential_requirement=fleet-token credential_path_redacted=true",
        "baileys_version=2.3000.1020194169",
        "outbound_success_at=2026-06-11 10:15:02",
    ]
    for raw in samples:
        assert redact(raw) == raw
