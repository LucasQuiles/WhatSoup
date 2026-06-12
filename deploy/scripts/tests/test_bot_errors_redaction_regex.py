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
    ("bot-errors-emit.py", "redact", "[REDACTED CREDENTIAL PATH]"),
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


@pytest.mark.parametrize(("script_name", "func_name", "_marker"), _REDACTORS)
def test_repeated_pathlike_nonmatches_do_not_backtrack(script_name: str, func_name: str, _marker: str):
    mod = _load_module(script_name)
    redact: Callable[[str], str] = getattr(mod, func_name)

    hostile = "/" + "!/" * 250 + "not-a-credential-path"
    started = time.monotonic()
    redact(hostile)
    elapsed = time.monotonic() - started

    assert elapsed < 0.5
