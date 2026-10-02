"""The per-host daily-health check scans the event archives once per run.

``daily_health_events`` reads and parses every archived event file. The
per-host loop in ``collect_problems`` called it once PER HOST, so a fleet of 15
hosts parsed the ~18k-file archive 15 times per watchdog run (12-14 s CPU every
5 minutes). These tests pin that the loop scans once, that every host gets the
same verdict a standalone per-host call gives, and that a scan failure is
still reported for every host (the fail-loud ``DailyHealthEventError`` path).

The filename is NOT used to skip parsing: a daily-health event can be archived
under a name without "daily-health" in it (``<ts>.health-<id>.json``), which
``test_daily_health_event_without_daily_health_in_its_name_still_counts`` pins.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

_SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_wd = dispatcher_fixtures.load_module_from_path(
    "bot_errors_watchdog_scan_once", _SCRIPTS_DIR / "bot-errors-heartbeat-watchdog.py"
)

_FRESH = "relay-alpha"
_STALE = "relay-bravo"
_ABSENT = "relay-charlie"
_HOSTS = [_FRESH, _STALE, _ABSENT]
_MAX_AGE = 25 * 60 * 60


def _iso(epoch: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def _relay_event(root: Path, dirname: str, host: str, created: int, suffix: str = "") -> Path:
    directory = root / dirname
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (
        f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(created))}.relay-{host}"
        f".bot-errors-health.daily-health.health-{created}.json{suffix}"
    )
    path.write_text(
        json.dumps({"source": "daily-health", "createdAt": _iso(created)}), encoding="utf-8"
    )
    return path


@pytest.fixture()
def archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("BOT_ERRORS_DAILY_HEALTH_HOSTS", ",".join(_HOSTS))
    monkeypatch.delenv("BOT_ERRORS_DRY_DAILY_HEALTH_AGE_SECONDS", raising=False)
    monkeypatch.setattr(_wd, "optional_daily_health_hosts", lambda: [])
    monkeypatch.setattr(_wd, "collector_reachability_evidence", lambda host: "")
    now = int(time.time())
    _relay_event(tmp_path, "sent", _FRESH, now - 3600, ".1.sent")
    _relay_event(tmp_path, "storm-collapsed", _STALE, now - 3 * 86400, ".storm-x.1.collapsed")
    # Bulk that is not daily-health: it must be read, but contributes nothing.
    noise = tmp_path / "suppressed"
    noise.mkdir(parents=True, exist_ok=True)
    for index in range(20):
        (noise / f"20261002T000000Z.q.release-drift.n{index}.json.1.suppressed").write_text(
            json.dumps({"source": "release-drift", "createdAt": _iso(now)}), encoding="utf-8"
        )
    return tmp_path


def _count_scans(monkeypatch: pytest.MonkeyPatch) -> dict[str, int]:
    calls = {"scans": 0}
    real = _wd.daily_health_events

    def counted():
        calls["scans"] += 1
        return real()

    monkeypatch.setattr(_wd, "daily_health_events", counted)
    return calls


def _problems() -> dict[str, str]:
    args = argparse.Namespace(max_daily_health_age=_MAX_AGE)
    return _wd.collect_problems(args, checks={"daily_health"})


def test_per_host_check_scans_the_archive_once(archive, monkeypatch) -> None:
    calls = _count_scans(monkeypatch)
    problems = _problems()
    assert calls["scans"] == 1
    assert set(problems) == {f"daily_health:{_STALE}", f"daily_health:{_ABSENT}"}


def test_shared_scan_gives_each_host_its_standalone_verdict(archive, monkeypatch) -> None:
    scan = _wd.daily_health_scan()
    for host in _HOSTS:
        assert _wd.daily_health_age(host, scan=scan) == _wd.daily_health_age(host)
    fresh_age, fresh_detail = _wd.daily_health_age(_FRESH, scan=scan)
    assert fresh_age is not None and fresh_age < _MAX_AGE
    assert f"relay-{_FRESH}" in fresh_detail
    stale_age, _ = _wd.daily_health_age(_STALE, scan=scan)
    assert stale_age is not None and stale_age > _MAX_AGE
    absent_age, absent_detail = _wd.daily_health_age(_ABSENT, scan=scan)
    assert absent_age is None
    assert f"no daily-health event for {_ABSENT}" in absent_detail


def test_scan_failure_is_reported_for_every_host(archive, monkeypatch) -> None:
    calls = {"scans": 0}

    def failing():
        calls["scans"] += 1
        raise _wd.DailyHealthEventError("directory=x pattern=*.json* error=OSError: boom")

    monkeypatch.setattr(_wd, "daily_health_events", failing)
    problems = _problems()
    assert calls["scans"] == 1
    assert set(problems) == {f"daily_health:{host}" for host in _HOSTS}
    for host in _HOSTS:
        assert "failed to scan daily-health events" in problems[f"daily_health:{host}"]
        assert "boom" in problems[f"daily_health:{host}"]


def test_standalone_call_without_a_scan_still_scans(archive, monkeypatch) -> None:
    calls = _count_scans(monkeypatch)
    age, _ = _wd.daily_health_age(_FRESH)
    assert calls["scans"] == 1
    assert age is not None and age < _MAX_AGE


def test_daily_health_event_without_daily_health_in_its_name_still_counts(
    archive, monkeypatch
) -> None:
    """Archived names like ``<ts>.health-<id>.json`` carry source=daily-health."""
    now = int(time.time())
    path = archive / "sent" / f"20261002T000000Z.health-{now}-1.json.{now}.sent"
    path.write_text(
        json.dumps({
            "source": "daily-health",
            "createdAt": _iso(now - 60),
            "machine": "Example-Machine",
            "diagnostics": {"remoteHost": _ABSENT},
        }),
        encoding="utf-8",
    )
    events = _wd.daily_health_events()
    assert any(found == path for found, _created, _data in events)
