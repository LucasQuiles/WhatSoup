"""Shared fixtures and helpers for the BOT ERRORS dispatcher test modules (not deployed).

Single source of truth for helper bodies that were byte-identical copies across the
dispatcher-scope modules in `deploy/scripts/tests/`. Every function here is a verbatim
move: same body, same semantics, no behaviour change. Importers keep their own local
spelling by aliasing (`_write_event = dispatcher_fixtures.write_outbox_event`), so no
call site changed.

Two helpers in the directory were both spelled `_write_event` and are NOT the same
function -- one takes an explicit filename, the other derives a fixed one from the event
id. They keep distinct names here (`write_outbox_event` / `write_socket_down_outbox_event`)
because the shared spelling was the only reason they read as one helper.

This module lives in `support/` rather than `conftest.py` on purpose. The directory's
`conftest.py` scopes itself to the collector suites, and the suite runs under
`--import-mode=importlib`, which does not put the test directory on `sys.path` -- so
importers add it explicitly, the idiom already settled in this directory by
`bounded_jsonl_test_support.py`. An autouse fixture in `conftest.py` would apply to every
module in the directory, which is a behaviour change rather than a deduplication.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from typing import Any

import pytest


def make_env_scrub_fixture(keys):
    """Return an autouse fixture that removes `keys` for the test and restores them after.

    A factory, not a shared constant: every importing module scrubs a different key list.
    Bind the result to the module attribute the tests expect
    (`_clean_env = make_env_scrub_fixture(_ENV_KEYS)`) -- pytest registers a fixture under
    the module attribute name, not the inner function's name, so name-based lookup and
    autouse discovery both behave exactly as they did for a local `def`.
    """

    @pytest.fixture(autouse=True)
    def _env_scrub():
        saved = {k: os.environ.get(k) for k in keys}
        for k in keys:
            os.environ.pop(k, None)
        yield
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    return _env_scrub


def write_outbox_event(paths: dict[str, Path], filename: str, event: dict[str, Any]) -> Path:
    """Write `event` to the outbox under an explicit `filename`, mode 0600.

    Producers publish events 0600 (emit + durable_json enforce it); the fenced dispatcher
    rejects looser modes, so the fixture must match.
    """
    path = paths["outbox"] / filename
    path.write_text(json.dumps(event), encoding="utf-8")
    path.chmod(0o600)
    return path


def write_socket_down_outbox_event(paths: dict[str, Path], event: dict[str, Any]) -> Path:
    """Write a socket-down alert to the outbox under its canonical filename, mode 0600.

    The filename is fixed to the one scenario both importers exercise: a socket_down alert
    from a single instance at a pinned timestamp, varying only by event id.
    """
    event_path = paths["outbox"] / f"20260612000000.ana-bot.socket_down.{event['id']}.json"
    event_path.write_text(json.dumps(event, indent=2, sort_keys=True) + "\n")
    event_path.chmod(0o600)
    return event_path


def fallback_script(tmp_path: Path, exit_code: int) -> Path:
    """Write an executable stub fallback script that exits with `exit_code`."""
    script = tmp_path / "fake-fallback.sh"
    script.write_text(f"#!/bin/sh\nexit {exit_code}\n")
    script.chmod(0o755)
    return script


def dispatch_log_records(paths: dict[str, Path]) -> list[dict[str, Any]]:
    """Return the parsed dispatch.jsonl records, or [] when the log does not exist."""
    log_path = paths["logs"] / "dispatch.jsonl"
    if not log_path.exists():
        return []
    return [json.loads(line) for line in log_path.read_text().splitlines() if line.strip()]


def empty_state() -> dict:
    """Return a fresh, empty incident-state document."""
    return {"version": 1, "openIncidents": {}, "lastSentAt": {}}


def capture_sends(mod) -> list[str]:
    """Replace `mod.send_whatsapp` with a recorder and return the list it appends to."""
    sends: list[str] = []
    mod.send_whatsapp = lambda text, *a, **k: sends.append(text)  # type: ignore[assignment]
    return sends


def load_module_from_path(name: str, path: Path):
    """Load the script at `path` as a module named `name`.

    Asserts both `spec` and `spec.loader` before building the module, matching the
    stronger form the folded clones already used -- a missing spec otherwise surfaces as
    an opaque TypeError from module_from_spec rather than a named assertion.
    """
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
