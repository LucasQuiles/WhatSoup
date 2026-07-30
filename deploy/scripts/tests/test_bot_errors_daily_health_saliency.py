"""Tests for daily-health saliency (Task 4) across health-check + dispatcher.

TDD: written BEFORE implementation. The rb-bot lesson — a real per-instance
FAIL in daily-health was detected daily but buried inside the generic summary
event and storm-collapsed, so a multi-day outage went unnoticed. Verifies:
- emit_per_instance_health_failures emits ONE salient critical, force-notify
  event per failing instance (alertSource set, evidence carries the fail lines)
- non-per-instance FAIL lines (required_tools, profile) emit NO event
- _instance_from_fail_line extracts the instance for each real format and
  returns None for non-per-instance / empty / short lines
- the daily-health info summary and the daily-health-fail critical never fold:
  they carry DISTINCT sources, so incident_key separates them without needing
  severity baked into the key (which would break the hand-built 3-part keys in
  stronger_open_incident_for / daily_health_recovered / stale-key parsing)
- distinct daily-health-fail instances get distinct incident_source + key
- forceNotify level is derived for daily-health-fail force-notify events
- daily-health-fail critical is an incident alert and is NOT swallowed by the
  daily-health info-retention suppression branch
"""
from __future__ import annotations

import contextlib
import importlib.util
import json
import os
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module loader (mirrors test_bot_errors_collector_backoff.py)
# ---------------------------------------------------------------------------

_SCRIPTS = Path(__file__).resolve().parents[1]
_HEALTH_SCRIPT = _SCRIPTS / "bot-errors-health-check.py"
_DISPATCHER_SCRIPT = _SCRIPTS / "bot-errors-dispatcher.py"


def _load_module(name: str, script: Path, extra_env: dict[str, str] | None = None):
    """Load a module with env vars active during exec_module."""
    env_backup: dict[str, str | None] = {}
    if extra_env:
        for k, v in extra_env.items():
            env_backup[k] = os.environ.get(k)
            os.environ[k] = v
    try:
        spec = importlib.util.spec_from_file_location(name, script)
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
def dirs(tmp_path: Path):
    state_dir = tmp_path / "bot-errors"
    outbox_dir = tmp_path / "outbox"
    state_dir.mkdir(mode=0o700)
    outbox_dir.mkdir(mode=0o700)
    return state_dir, outbox_dir


def _load_health(state_dir: Path, outbox_dir: Path):
    return _load_module(
        "bot_errors_health_check",
        _HEALTH_SCRIPT,
        extra_env={
            "BOT_ERRORS_STATE_DIR": str(state_dir),
            "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
        },
    )


def _load_dispatcher(state_dir: Path, outbox_dir: Path):
    return _load_module(
        "bot_errors_dispatcher",
        _DISPATCHER_SCRIPT,
        extra_env={
            "BOT_ERRORS_STATE_DIR": str(state_dir),
            "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
        },
    )


def _read_events(paths: list[Path]) -> list[dict]:
    return [json.loads(Path(p).read_text()) for p in paths]


# ---------------------------------------------------------------------------
# T1: single instance — one salient critical force-notify event
# ---------------------------------------------------------------------------

def test_single_instance_emits_one_salient_event(dirs):
    state_dir, outbox_dir = dirs
    health = _load_health(state_dir, outbox_dir)
    with _env(state_dir, outbox_dir):
        paths = health.emit_per_instance_health_failures([
            "FAIL config line-a: missing required tokens.env",
            "health line-a: FAIL probe down",
        ])
    assert len(paths) == 1
    event = _read_events(paths)[0]
    assert event["severity"] == "critical"
    assert event["source"] == "daily-health-fail"
    assert event["alertSource"] == "line-a"
    assert event["diagnostics"]["forceNotify"] is True
    assert "FAIL config line-a: missing required tokens.env" in event["evidence"]
    assert "health line-a: FAIL probe down" in event["evidence"]


# ---------------------------------------------------------------------------
# T2: two instances — one event each, alertSource correct
# ---------------------------------------------------------------------------

def test_two_instances_emit_one_event_each(dirs):
    state_dir, outbox_dir = dirs
    health = _load_health(state_dir, outbox_dir)
    with _env(state_dir, outbox_dir):
        paths = health.emit_per_instance_health_failures([
            "FAIL config line-a: bad",
            "FAIL socket line-b: missing",
        ])
    events = _read_events(paths)
    sources = sorted(e["alertSource"] for e in events)
    assert sources == ["line-a", "line-b"]
    assert all(e["source"] == "daily-health-fail" for e in events)
    assert all(e["severity"] == "critical" for e in events)


# ---------------------------------------------------------------------------
# T3: non-per-instance FAIL — no event
# ---------------------------------------------------------------------------

def test_non_per_instance_fail_emits_no_event(dirs):
    state_dir, outbox_dir = dirs
    health = _load_health(state_dir, outbox_dir)
    with _env(state_dir, outbox_dir):
        paths = health.emit_per_instance_health_failures([
            "FAIL required_tools: required_missing=jq",
        ])
    files = list(Path(outbox_dir).glob("*.json"))
    assert paths == [] and files == []


# ---------------------------------------------------------------------------
# T4: _instance_from_fail_line extraction + None cases
# ---------------------------------------------------------------------------

def test_instance_from_fail_line_extraction(dirs):
    state_dir, outbox_dir = dirs
    health = _load_health(state_dir, outbox_dir)
    f = health._instance_from_fail_line
    extracted = {
        "FAIL config line-a: bad": "line-a",
        "FAIL health line-b: probe down": "line-b",
        "FAIL socket main-line: missing": "main-line",
        "FAIL service line-a: inactive": "line-a",
        "FAIL service_enabled line-b: disabled": "line-b",
        "FAIL auth_bond main-line: lost": "main-line",
        "FAIL provider_probe line-a: 500": "line-a",
        "health line-a: FAIL probe down": "line-a",
        "FAIL primary_phone_state line-b: drift": "line-b",
        "FAIL profile_coverage line-a: not declared": "line-a",
        "FAIL profile_coverage_service main-line: active undeclared": "main-line",
        # tree-provenance guard lines key on the (redacted) branch name
        "FAIL tree_provenance main: direct_to_protected_branch ahead=32": "main",
    }
    for line, expected in extracted.items():
        assert f(line) == expected, line
    none_cases = [
        "FAIL required_tools: x",
        "FAIL profile: x",
        "",
        "FAIL",
        # second token is a filesystem path, not an instance id — must NOT
        # mis-attribute (and must never leak the path as an instance name).
        "config /srv/whatsoup/state/instances/line-a/config.json: invalid JSON: x",
        # slash-bearing branch names hit the path-separator rejection; the
        # tree-provenance guard's own alert still covers those branches.
        "FAIL tree_provenance preserve/polluted-head: direct_to_protected_branch",
    ]
    assert [f(line) for line in none_cases] == [None] * len(none_cases)


# ---------------------------------------------------------------------------
# T5: the daily-health info SUMMARY and the daily-health-fail CRITICAL never
# fold. Separation is by SOURCE (daily-health vs daily-health-fail), so the
# critical per-instance event is not collapsed into the generic info summary.
# (We deliberately do NOT bake severity into incident_key: the key format is
# reconstructed by hand in stronger_open_incident_for / daily_health_recovered
# / incident_event_fields_from_key, which all assume the 3-part shape.)
# ---------------------------------------------------------------------------

def test_summary_and_fail_events_do_not_fold(dirs):
    state_dir, outbox_dir = dirs
    dispatcher = _load_dispatcher(state_dir, outbox_dir)
    summary = {
        "machine": "test-machine",
        "instance": "bot-errors-health",
        "source": "daily-health",
        "severity": "info",
    }
    fail = {
        "machine": "test-machine",
        "instance": "bot-errors-health",
        "source": "daily-health-fail",
        "alertSource": "line-a",
        "severity": "critical",
    }
    # Distinct sources -> distinct incident_source -> distinct incident_key.
    assert dispatcher.incident_source(summary) != dispatcher.incident_source(fail)
    assert dispatcher.incident_key(summary) != dispatcher.incident_key(fail)
    # The fail event is keyed per instance via the qualified source.
    assert dispatcher.incident_key(fail).endswith("daily-health-fail:line-a")


# ---------------------------------------------------------------------------
# T6: distinct instances → distinct incident_source AND incident_key
# ---------------------------------------------------------------------------

def test_distinct_instances_distinct_keys(dirs):
    state_dir, outbox_dir = dirs
    dispatcher = _load_dispatcher(state_dir, outbox_dir)
    a = {
        "machine": "test-machine",
        "instance": "bot-errors-health",
        "source": "daily-health-fail",
        "alertSource": "line-a",
        "severity": "critical",
    }
    b = dict(a, alertSource="line-b")
    assert dispatcher.incident_source(a) != dispatcher.incident_source(b)
    assert dispatcher.incident_key(a) != dispatcher.incident_key(b)
    assert dispatcher.incident_source(a) == "daily-health-fail:line-a"


# ---------------------------------------------------------------------------
# T7: force_notify_level derived for daily-health-fail force-notify events
# ---------------------------------------------------------------------------

def test_force_notify_level_for_daily_health_fail(dirs):
    state_dir, outbox_dir = dirs
    dispatcher = _load_dispatcher(state_dir, outbox_dir)
    forced = {
        "source": "daily-health-fail",
        "severity": "critical",
        "diagnostics": {"forceNotify": True, "forceNotifyLevel": "critical"},
    }
    unforced = {
        "source": "daily-health-fail",
        "severity": "critical",
        "diagnostics": {},
    }
    assert dispatcher.force_notify_level(forced) == "critical"
    assert dispatcher.force_notify_level(unforced) is None


# ---------------------------------------------------------------------------
# T8: daily-health-fail critical is an incident alert; info-retention branch
# (keyed on source=="daily-health") cannot match daily-health-fail.
# ---------------------------------------------------------------------------

def test_daily_health_fail_not_swallowed_by_info_retention(dirs):
    state_dir, outbox_dir = dirs
    dispatcher = _load_dispatcher(state_dir, outbox_dir)
    event = {
        "schemaVersion": 1,
        "machine": "test-machine",
        "instance": "bot-errors-health",
        "source": "daily-health-fail",
        "alertSource": "line-a",
        "severity": "critical",
        "eventType": "alert",
        "evidence": "instance: line-a\nFAIL config line-a: bad",
        "diagnostics": {"forceNotify": True, "forceNotifyLevel": "critical"},
    }
    assert dispatcher.is_incident_alert(event) is True
    reason = dispatcher.should_suppress_send(event, {})
    info_retention = (
        "daily-health info events are retained for heartbeat freshness "
        "but not posted to BOT ERRORS"
    )
    assert reason != info_retention


# ---------------------------------------------------------------------------
# T9: a stale daily-health-fail incident key reconstructs to the correct
# (source, alertSource) split — NOT a malformed compound source token.
# (incident_event_fields_from_key must handle daily-health-fail: like it
# handles daily-health: and heartbeat-watchdog:.)
# ---------------------------------------------------------------------------

def test_stale_daily_health_fail_key_reconstructs_source_and_alert(dirs):
    state_dir, outbox_dir = dirs
    dispatcher = _load_dispatcher(state_dir, outbox_dir)
    key = "test-machine|bot-errors-health|daily-health-fail:line-a"
    fields = dispatcher.incident_event_fields_from_key(key)
    assert fields["machine"] == "test-machine"
    assert fields["instance"] == "bot-errors-health"
    assert fields["source"] == "daily-health-fail"
    assert fields["alertSource"] == "line-a"
    # And the more-specific prefix must not be swallowed by daily-health:
    plain = dispatcher.incident_event_fields_from_key("test-machine|bot-errors-health|daily-health:line-b")
    assert plain["source"] == "daily-health"
    assert plain["alertSource"] == "line-b"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@contextlib.contextmanager
def _env(state_dir: Path, outbox_dir: Path):
    env_map = {
        "BOT_ERRORS_STATE_DIR": str(state_dir),
        "BOT_ERRORS_OUTBOX_DIR": str(outbox_dir),
    }
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
