"""Shared scaffolding for bot-errors-collector.py test suites.

Extracted during HD-11b review (battery 3): the module loader, tmp_state
fixture, env-scoping context manager, run_once defaults helper, and outbox
inspection helpers were byte-for-byte (or near-byte-for-byte) duplicated
across test_bot_errors_collector_backoff.py, test_bot_errors_collector_reachability.py,
and test_bot_errors_collector_capture_escalation.py. This is the single
source of truth for that scaffolding; do not re-duplicate it in a new
collector test file, import from here instead.

Only used by the bot-errors-collector.py test suites that opt in via
`from conftest import ...` (or, for the `tmp_state` fixture, automatically
via pytest fixture discovery). Other test files under this directory
(dispatcher, health-check, etc.) are unaffected -- pytest only applies a
conftest.py fixture to a test that declares its name as a parameter, and no
other file in this directory uses the `tmp_state` name.

FakeCollectorClock/_patched_collector_clock here mock time.time() only, NOT
time.time_ns() -- callers that mint multiple same-second outbox events of
the same source and need filename-sort-order to reflect emission order
(e.g. asserting an exact alert/clear/alert sequence) need a time_ns-aware
clock patch; that is genuinely test-specific (only
test_bot_errors_collector_capture_escalation.py currently needs it) and is
kept local to that file rather than folded in here.
"""
from __future__ import annotations

import contextlib
import importlib.util
import os
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

_SCRIPT = Path(__file__).resolve().parent.parent / "bot-errors-collector.py"


def _load_module(extra_env: dict[str, str] | None = None):
    """Load the collector module with env vars active during exec_module."""
    env_backup: dict[str, str | None] = {}
    if extra_env:
        for k, v in extra_env.items():
            env_backup[k] = os.environ.get(k)
            os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location("bot_errors_collector", _SCRIPT)
        mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        spec.loader.exec_module(mod)  # type: ignore[union-attr]
        return mod
    finally:
        if extra_env:
            for k, orig in env_backup.items():
                if orig is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = orig


@pytest.fixture()
def tmp_state(tmp_path: Path):
    """Isolated state root with required subdirectories."""
    state_dir = tmp_path / "bot-errors"
    outbox_dir = tmp_path / "outbox"
    state_dir.mkdir(mode=0o700)
    outbox_dir.mkdir(mode=0o700)
    return state_dir, outbox_dir


@contextlib.contextmanager
def _env(state_dir: Path, outbox_dir: Path, extra: dict[str, str] | None = None):
    """Context manager that keeps BOT_ERRORS_* env vars active during test body.

    The collector reads BOT_ERRORS_STATE_DIR and BOT_ERRORS_OUTBOX_DIR at call
    time (not import time), so the env vars must be active during run_once
    execution -- any load_state()/collector_failure_escalate_threshold() (or
    similar env-reading) call made by the test itself must also run inside
    this context, not after it exits.
    """
    env_map = {
        "BOT_ERRORS_STATE_DIR": str(state_dir),
        "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
        "BOT_ERRORS_TAILSCALE_STATUS_COMMAND": "",
    }
    if extra:
        env_map.update(extra)
    backup = {k: os.environ.get(k) for k in env_map}
    for k, v in env_map.items():
        os.environ[k] = v
    try:
        yield
    finally:
        for k, orig in backup.items():
            if orig is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = orig


def _load_mod_with_dirs(state_dir: Path, outbox_dir: Path, extra_env: dict[str, str] | None = None):
    """Load collector module with env vars set (env vars are also restored afterward)."""
    env = {
        "BOT_ERRORS_STATE_DIR": str(state_dir),
        "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
        "BOT_ERRORS_TAILSCALE_STATUS_COMMAND": "",
    }
    if extra_env:
        env.update(extra_env)
    return _load_module(extra_env=env)


def _run_once_defaults(mod, remotes: list[str], **kwargs):
    defaults = dict(
        best_effort_remotes=set(),
        max_events=5,
        timeout=5,
        lease_seconds=30,
        remote_sla=9999,
        alert_cooldown=900,
        recovery_successes=2,
    )
    defaults.update(kwargs)
    return mod.run_once(remotes, **defaults)


class FakeCollectorClock:
    def __init__(self, start: int):
        self.now = start

    def time(self) -> float:
        return float(self.now)

    def advance(self, seconds: int) -> None:
        self.now += seconds

    def set(self, value: int) -> None:
        self.now = value


@contextlib.contextmanager
def _patched_collector_clock(mod, clock: FakeCollectorClock):
    with patch.object(mod, "time") as mock_time:
        mock_time.time.side_effect = clock.time
        mock_time.strftime = time.strftime
        mock_time.gmtime = time.gmtime
        yield


def _all_outbox_events(outbox_dir: Path) -> list[dict[str, Any]]:
    import json

    events = []
    for p in sorted(outbox_dir.glob("*.json")):
        try:
            ev = json.loads(p.read_text())
        except Exception:
            continue
        events.append(ev)
    return events


def _outbox_by_source(outbox_dir: Path) -> dict[str, list[dict[str, Any]]]:
    by_source: dict[str, list[dict[str, Any]]] = {}
    for ev in _all_outbox_events(outbox_dir):
        s = ev.get("source", "_unknown")
        by_source.setdefault(s, []).append(ev)
    return by_source


def _read_collector_state(mod) -> dict[str, Any]:
    """Inspect collector state through the exclusive library session.

    Replaces the removed corrupt-to-empty ``mod.load_state()`` for test
    inspection; must run inside ``_env`` scope like the function it replaced.
    """
    session = mod.open_collector_state_session()
    try:
        return session.load().payload
    finally:
        session.close()
