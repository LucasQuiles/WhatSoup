"""The daily profile-missing alert raised by the health check and the watchdog.

When a producer cannot load its health profile (FleetConfigError) it still exits
2, and first queues one critical alert per (host, producer, UTC day):

- event type ``alert``, severity ``critical``, the producer's usual ``source``
  and ``alertSource=profile-missing:<producer>``; no force-notify;
- evidence lines ``kind=profile-missing``, ``producer=``, ``host=``,
  ``utc_day=`` and ``error=``, with the private profile path redacted;
- the event is published first and the marker second. A marker for the same
  producer, host and day suppresses, even for a different error. Anything that
  cannot prove that (absent, other day, other host, wrong schema, future day,
  unparseable, unreadable) alerts again;
- one stderr line per run says which stage happened, after the unchanged
  fail-closed line.

This is daily suppression after a successful marker, not exactly-once: a
marker failure after publication and two overlapping runs can each produce a
second event. The tests pin that bound instead of asserting zero duplicates.

Expected values come from that contract, not from the producers' helpers.
HOME, the state root and the outbox are temp dirs, the host is ``host-a``, the
clock is the producer's dry clock, and nothing leaves the temp outbox.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable
from unittest import mock

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]

DAY1 = "2026-09-27"
DAY2 = "2026-09-28"
EPOCH1 = int(datetime(2026, 9, 27, 12, tzinfo=timezone.utc).timestamp())
EPOCH2 = int(datetime(2026, 9, 28, 12, tzinfo=timezone.utc).timestamp())

HEALTH = "health-check"
WATCHDOG = "heartbeat-watchdog"

_MODULES: dict[str, Any] = {}


def _module(name: str) -> Any:
    if name not in _MODULES:
        filename = "bot-errors-health-check.py" if name == HEALTH else "bot-errors-heartbeat-watchdog.py"
        spec = importlib.util.spec_from_file_location(f"profile_missing_event_{name.replace('-', '_')}", _SCRIPTS / filename)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        _MODULES[name] = module
    return _MODULES[name]


class Producer:
    """One producer wired to temp paths, plus the contract values it must meet."""

    def __init__(self, name: str, monkeypatch, tmp_path: Path) -> None:
        self.name = name
        self.module = _module(name)
        self.monkeypatch = monkeypatch
        self.tmp_path = tmp_path
        self.state_dir = tmp_path / "state"
        self.outbox = self.state_dir / "outbox"
        self.private_profile = tmp_path / "home" / ".config" / "whatsoup" / "health-profile.json"
        if name == HEALTH:
            self.clock_env = "BOT_ERRORS_DRY_NOW_EPOCH"
            self.marker_path = self.state_dir / "health-check-profile-missing.json"
            self.first_line = "bot-errors-health-check: fail-closed: "
            self.prefix = "bot-errors-health-check: profile-missing"
            self.source = "daily-health"
            tracked = tmp_path / "repo" / "deploy" / "health-profiles" / "host-a.json"
            monkeypatch.setattr(self.module, "script_relative_profile_path", lambda: tracked)
            monkeypatch.setattr(
                self.module, "tool_inventory", mock.Mock(side_effect=AssertionError("daily() probed with no profile"))
            )
            self._run: Callable[[], int] = self.module.daily
        else:
            self.clock_env = "BOT_ERRORS_DRY_NOW"
            self.marker_path = self.state_dir / "heartbeat-watchdog-profile-missing.json"
            self.first_line = "configuration_error: "
            self.prefix = "profile-missing"
            self.source = "heartbeat-watchdog"
            monkeypatch.setattr(self.module, "REPO_ROOT", tmp_path / "repo")
            monkeypatch.setenv("BOT_ERRORS_WATCHDOG_CHECKS", "local_services")
            self.session = mock.Mock(side_effect=AssertionError("controller state opened"))
            monkeypatch.setattr(self.module, "open_watchdog_state_session", self.session)
            self._run = lambda: self.module.run_once(SimpleNamespace())

    def run(self, epoch: int) -> int:
        self.monkeypatch.setenv(self.clock_env, str(epoch))
        return self._run()

    def events(self) -> list[tuple[Path, dict[str, Any]]]:
        if not self.outbox.exists():
            return []
        found = []
        for path in sorted(self.outbox.glob("*.json")):
            event = json.loads(path.read_text(encoding="utf-8"))
            if str(event.get("alertSource", "")).startswith("profile-missing:"):
                found.append((path, event))
        return found

    def producer_events(self) -> list[tuple[Path, dict[str, Any]]]:
        return [item for item in self.events() if item[1]["alertSource"] == f"profile-missing:{self.name}"]

    def marker(self) -> dict[str, Any] | None:
        if not self.marker_path.exists():
            return None
        return json.loads(self.marker_path.read_text(encoding="utf-8"))

    def seed_marker(self, content: str) -> None:
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.state_dir.chmod(0o700)
        self.marker_path.write_text(content, encoding="utf-8")
        self.marker_path.chmod(0o600)


def _contract_marker(**overrides: Any) -> dict[str, Any]:
    marker = {
        "schemaVersion": 1,
        "kind": "profile-missing-marker",
        "producer": HEALTH,
        "host": "host-a",
        "utcDay": DAY1,
        "eventId": "seeded",
        "errorSha256": "0" * 64,
    }
    marker.update(overrides)
    return marker


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path: Path):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    for name in (
        "BOT_ERRORS_HEALTH_PROFILE",
        "BOT_ERRORS_HEALTH_PROFILE_JSON",
        "BOT_ERRORS_SAFE_SHAPE_CRED_PATH",
        "BOT_ERRORS_FLEET_SENTINEL_STATE_DIR",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(tmp_path / "state" / "outbox"))
    monkeypatch.setattr(_module(HEALTH).socket, "gethostname", lambda: "host-a.example")


@pytest.fixture(params=[HEALTH, WATCHDOG])
def producer(request, monkeypatch, tmp_path: Path) -> Producer:
    return Producer(request.param, monkeypatch, tmp_path)


def _err_lines(capsys) -> list[str]:
    return capsys.readouterr().err.strip().splitlines()


# ---------------------------------------------------------------------------
# First emission
# ---------------------------------------------------------------------------

def test_first_failure_queues_one_critical_event_and_exits_2(producer: Producer, capsys):
    assert producer.run(EPOCH1) == 2

    lines = _err_lines(capsys)
    assert len(lines) == 2
    assert lines[0].startswith(producer.first_line + "health profile missing")
    events = producer.events()
    assert len(events) == 1
    path, event = events[0]
    assert lines[1] == f"{producer.prefix} event queued: {path}"

    assert event["eventType"] == "alert"
    assert event["severity"] == "critical"
    assert event["source"] == producer.source
    assert event["alertSource"] == f"profile-missing:{producer.name}"
    assert "forceNotify" not in event["diagnostics"]
    assert "criticalAsset" not in event
    evidence = event["evidence"].splitlines()
    assert evidence[:4] == [
        "kind=profile-missing",
        f"producer={producer.name}",
        "host=host-a",
        f"utc_day={DAY1}",
    ]
    assert evidence[4].startswith("error=health profile missing")
    assert "resolver order:" in evidence[4]
    assert event["summary"] == (
        f"profile-missing: {producer.name} on host-a cannot load its health profile; exiting 2"
    )
    if producer.name == HEALTH:
        assert event["instance"] == "bot-errors-health"

    marker = producer.marker()
    assert marker == {
        "schemaVersion": 1,
        "kind": "profile-missing-marker",
        "producer": producer.name,
        "host": "host-a",
        "utcDay": DAY1,
        "eventId": path.stem,
        "errorSha256": marker["errorSha256"],
    }
    assert re.fullmatch(r"[0-9a-f]{64}", marker["errorSha256"])


def test_private_path_stays_on_stderr_only(producer: Producer, capsys):
    assert producer.run(EPOCH1) == 2

    lines = _err_lines(capsys)
    assert str(producer.private_profile) in lines[0]
    (_, event), = producer.events()
    payload = json.dumps(event)
    assert str(producer.private_profile) not in payload
    assert ".config/whatsoup/health-profile.json" not in payload
    marker_text = producer.marker_path.read_text(encoding="utf-8")
    assert str(producer.private_profile) not in marker_text
    assert "health profile missing" not in marker_text


# ---------------------------------------------------------------------------
# Daily suppression key: (host, producer, UTC day)
# ---------------------------------------------------------------------------

def test_same_day_rerun_is_suppressed_and_still_exits_2(producer: Producer, capsys):
    assert producer.run(EPOCH1) == 2
    capsys.readouterr()

    assert producer.run(EPOCH1 + 3600) == 2

    lines = _err_lines(capsys)
    assert len(lines) == 2
    assert lines[0].startswith(producer.first_line)
    assert lines[1] == f"{producer.prefix} event suppressed: already queued for host-a on {DAY1}"
    assert len(producer.events()) == 1


def test_different_error_same_day_is_suppressed(producer: Producer, monkeypatch, capsys):
    assert producer.run(EPOCH1) == 2
    first_hash = producer.marker()["errorSha256"]
    capsys.readouterr()

    gone = producer.tmp_path / "gone.json"
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE", str(gone))
    assert producer.run(EPOCH1 + 3600) == 2

    lines = _err_lines(capsys)
    assert f"health profile missing: {gone}" in lines[0]
    assert lines[1] == f"{producer.prefix} event suppressed: already queued for host-a on {DAY1}"
    assert len(producer.events()) == 1
    assert producer.marker()["errorSha256"] == first_hash


def test_next_utc_day_alerts_again(producer: Producer, capsys):
    assert producer.run(EPOCH1) == 2
    assert producer.run(EPOCH2) == 2

    events = producer.events()
    assert len(events) == 2
    assert [event["evidence"].splitlines()[3] for _, event in events] == [f"utc_day={DAY1}", f"utc_day={DAY2}"]
    assert producer.marker()["utcDay"] == DAY2


def test_other_host_is_independent(producer: Producer, monkeypatch, capsys):
    assert producer.run(EPOCH1) == 2
    capsys.readouterr()

    monkeypatch.setattr(producer.module.socket, "gethostname", lambda: "host-b.example")
    assert producer.run(EPOCH1 + 60) == 2

    lines = _err_lines(capsys)
    assert lines[1] == f"{producer.prefix} marker does not prove suppression (wrong-host); alerting"
    assert lines[2].startswith(f"{producer.prefix} event queued: ")
    assert len(producer.events()) == 2
    assert producer.marker()["host"] == "host-b"


def test_other_producer_is_independent(monkeypatch, tmp_path: Path, capsys):
    health = Producer(HEALTH, monkeypatch, tmp_path)
    watchdog = Producer(WATCHDOG, monkeypatch, tmp_path)

    assert health.run(EPOCH1) == 2
    assert watchdog.run(EPOCH1) == 2
    assert health.run(EPOCH1 + 60) == 2
    assert watchdog.run(EPOCH1 + 60) == 2

    assert len(health.producer_events()) == 1
    assert len(watchdog.producer_events()) == 1
    assert health.marker()["producer"] == HEALTH
    assert watchdog.marker()["producer"] == WATCHDOG


def test_invalid_inline_profile_json_alerts_and_exits_2(monkeypatch, tmp_path: Path, capsys):
    health = Producer(HEALTH, monkeypatch, tmp_path)
    monkeypatch.setenv("BOT_ERRORS_HEALTH_PROFILE_JSON", "{not json")

    assert health.run(EPOCH1) == 2

    lines = _err_lines(capsys)
    assert lines[0].startswith("bot-errors-health-check: fail-closed: health profile is not valid JSON")
    (_, event), = health.events()
    error_line = event["evidence"].splitlines()[4]
    assert "BOT_ERRORS_HEALTH_PROFILE_JSON" in error_line
    assert "is not valid JSON" in error_line
    assert health.marker()["utcDay"] == DAY1


# ---------------------------------------------------------------------------
# Stage-specific failures
# ---------------------------------------------------------------------------

def test_event_publish_failure_writes_no_marker(producer: Producer, monkeypatch, capsys):
    monkeypatch.setattr(producer.module, "outbox_event", mock.Mock(side_effect=OSError("disk full")))

    assert producer.run(EPOCH1) == 2

    lines = _err_lines(capsys)
    assert len(lines) == 2
    assert lines[0].startswith(producer.first_line + "health profile missing")
    assert lines[1] == f"{producer.prefix} event not written (event publish failed; no marker written): OSError: disk full"
    assert producer.marker() is None


def test_marker_failure_after_publish_reports_stage_and_next_run_alerts(producer: Producer, monkeypatch, capsys):
    real_publish = producer.module.publish_state_json
    failing = {"on": True}

    def publish(*args, **kwargs):
        if failing["on"]:
            raise OSError("marker disk full")
        return real_publish(*args, **kwargs)

    monkeypatch.setattr(producer.module, "publish_state_json", publish)

    assert producer.run(EPOCH1) == 2
    lines = _err_lines(capsys)
    (path, _), = producer.events()
    assert lines[1] == (
        f"{producer.prefix} event queued at {path} but marker write failed "
        "(OSError: marker disk full); the next run will alert again"
    )
    assert producer.marker() is None

    failing["on"] = False
    assert producer.run(EPOCH1 + 60) == 2
    assert len(producer.events()) == 2
    assert producer.marker()["utcDay"] == DAY1


# ---------------------------------------------------------------------------
# Markers that cannot prove suppression
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "seed, reason",
    [
        (_contract_marker(utcDay=DAY2), "future-day"),
        (_contract_marker(schemaVersion=2), "wrong-schema"),
        ({"note": "not a marker"}, "wrong-schema"),
        (_contract_marker(utcDay="yesterday"), "malformed-day"),
    ],
)
def test_marker_that_cannot_prove_suppression_is_overwritten(producer: Producer, capsys, seed, reason):
    seed = {**seed, "producer": producer.name} if "producer" in seed else seed
    producer.seed_marker(json.dumps(seed))

    assert producer.run(EPOCH1) == 2

    lines = _err_lines(capsys)
    assert lines[1] == f"{producer.prefix} marker does not prove suppression ({reason}); alerting"
    assert lines[2].startswith(f"{producer.prefix} event queued: ")
    assert len(producer.events()) == 1
    assert producer.marker()["utcDay"] == DAY1


def test_unparseable_marker_alerts_and_is_left_in_place(producer: Producer, capsys):
    producer.seed_marker("{not json")

    assert producer.run(EPOCH1) == 2

    lines = _err_lines(capsys)
    assert len(lines) == 3
    assert lines[1].startswith(f"{producer.prefix} marker read failed (DurableWriteError: ")
    assert lines[1].endswith("alerting without suppression and leaving the marker in place")
    (path, _), = producer.events()
    assert lines[2] == (
        f"{producer.prefix} event queued at {path} but marker not written (existing marker unreadable); "
        "the next run will alert again"
    )
    assert producer.marker_path.read_text(encoding="utf-8") == "{not json"


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads mode-000 files")
def test_unreadable_marker_alerts_and_is_left_in_place(producer: Producer, capsys):
    producer.seed_marker(json.dumps(_contract_marker(producer=producer.name)))
    producer.marker_path.chmod(0)
    try:
        assert producer.run(EPOCH1) == 2
    finally:
        producer.marker_path.chmod(0o600)

    lines = _err_lines(capsys)
    assert lines[1].startswith(f"{producer.prefix} marker read failed (")
    assert "marker not written (existing marker unreadable)" in lines[2]
    assert len(producer.events()) == 1
    assert producer.marker() == _contract_marker(producer=producer.name)


# ---------------------------------------------------------------------------
# Overlapping runs: a bounded duplicate, not zero
# ---------------------------------------------------------------------------

def test_overlapping_runs_queue_at_least_one_and_at_most_two_events(producer: Producer, monkeypatch, capsys):
    """Both runs read "due" before either marker lands (forced by a barrier).

    The marker's compare-and-swap cannot stop the second event; this pins the
    documented bound (1..2 events), never zero and never more than one per run.
    Health event ids are unique per run, so health shows exactly 2 events and
    one lost marker race. The watchdog's event id is fixed per second, so its
    two runs may land on one file.
    """
    producer.monkeypatch.setenv(producer.clock_env, str(EPOCH1))
    real_observe = producer.module.observe_profile_missing_marker
    barrier = threading.Barrier(2, timeout=10)

    def observe():
        observed = real_observe()
        barrier.wait()
        return observed

    monkeypatch.setattr(producer.module, "observe_profile_missing_marker", observe)
    results: list[Any] = []

    def worker():
        try:
            results.append(producer._run())
        except BaseException as exc:  # surfaced below
            results.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert results == [2, 2]
    # A broken barrier would read as "marker read failed" and fake the race.
    assert not barrier.broken
    err = capsys.readouterr().err
    assert "marker read failed" not in err
    assert 1 <= len(producer.events()) <= 2
    assert producer.marker()["utcDay"] == DAY1
    if producer.name == HEALTH:
        assert len(producer.events()) == 2
        assert err.count("but marker write failed") == 1


# ---------------------------------------------------------------------------
# Watchdog: controller state and the unchanged ValueError path
# ---------------------------------------------------------------------------

def test_watchdog_profile_failure_never_opens_controller_state(monkeypatch, tmp_path: Path, capsys):
    watchdog = Producer(WATCHDOG, monkeypatch, tmp_path)

    assert watchdog.run(EPOCH1) == 2

    watchdog.session.assert_not_called()
    out = capsys.readouterr().out.splitlines()
    assert len(out) == 1
    assert json.loads(out[0])["verdict"] == "configuration_error"
    assert len(watchdog.events()) == 1


def test_watchdog_value_error_path_is_byte_identical_and_queues_nothing(monkeypatch, tmp_path: Path, capsys):
    watchdog = Producer(WATCHDOG, monkeypatch, tmp_path)
    monkeypatch.setenv("BOT_ERRORS_WATCHDOG_CHECKS", "bogus")
    emit = mock.Mock(side_effect=AssertionError("profile-missing emitted for a ValueError"))
    monkeypatch.setattr(watchdog.module, "emit_profile_missing_event", emit)

    assert watchdog.run(EPOCH1) == 2

    message = (
        "BOT_ERRORS_WATCHDOG_CHECKS contains unknown token(s): bogus. Valid checks: "
        "browser_debug,clock_skew,collector,collector_roster,daily_health,dispatcher,"
        "dm_roundtrip,fleet_sentinel,local_instance_health,local_services,q_loop,"
        "queue_backlog,supervision_deadman,turn_failure_rate,wedge_signature"
    )
    captured = capsys.readouterr()
    assert captured.err == f"configuration_error: {message}\n"
    assert captured.out == (
        '{"error": "' + message + '", "time": "2026-09-27T12:00:00Z", "verdict": "configuration_error"}\n'
    )
    emit.assert_not_called()
    watchdog.session.assert_not_called()
    assert watchdog.events() == []
    assert watchdog.marker() is None
