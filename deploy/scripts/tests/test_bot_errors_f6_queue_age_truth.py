"""Tests for F6: queue-age truth — createdAt instead of mtime in directory_stats.

TDD — written against the designed contract:
- directory_stats for *.json files reads event's createdAt ISO8601 field as true age.
- If createdAt is missing or unparseable, falls back to st_mtime (no crash).
- oldest_seconds reflects the true oldest event age, not the rewrite-refreshed mtime.
"""
from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path
from typing import Any

import pytest

# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()
directory_stats = _mod.directory_stats


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write_event(path: Path, created_at: str | None, other: dict[str, Any] | None = None) -> None:
    event: dict[str, Any] = {
        "schemaVersion": 1,
        "id": "test-evt",
        "eventType": "alert",
        "severity": "critical",
        "source": "test_source",
        "instance": "ana-bot",
        "machine": "nucles",
        "summary": "Test queue age event",
        "evidence": "testing queue age truth",
        "delivery": {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0, "lastError": None},
    }
    if created_at is not None:
        event["createdAt"] = created_at
    if other:
        event.update(other)
    path.write_text(json.dumps(event, sort_keys=True) + "\n")
    path.chmod(0o600)


# ---------------------------------------------------------------------------
# F6-a: createdAt 2h ago, mtime is now → oldest_seconds ~2h
# ---------------------------------------------------------------------------

class TestCreatedAtOverridesMtime:
    def test_created_at_2h_ago_oldest_reflects_2h(self, tmp_path):
        """Event with createdAt 2h ago but mtime now → oldest_seconds >= 7100."""
        outbox = tmp_path / "outbox"
        outbox.mkdir()
        event_path = outbox / "20260612000000.ana-bot.test.evt001.json"

        two_hours_ago = time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 7200)
        )
        _write_event(event_path, created_at=two_hours_ago)
        # mtime is effectively "now" (just written)

        count, oldest = directory_stats(outbox, "*.json")
        assert count == 1
        # Should reflect ~7200s not ~0s from mtime
        assert oldest >= 7100, (
            f"oldest_seconds should be ~7200 from createdAt 2h ago, got {oldest}"
        )

    def test_mtime_now_without_created_at_is_recent(self, tmp_path):
        """Event without createdAt falls back to mtime (which is 'now' when just written)."""
        outbox = tmp_path / "outbox"
        outbox.mkdir()
        event_path = outbox / "20260612000000.ana-bot.test.evt002.json"

        _write_event(event_path, created_at=None)
        # No createdAt → falls back to mtime which is ~now

        count, oldest = directory_stats(outbox, "*.json")
        assert count == 1
        assert oldest < 60, (
            f"Without createdAt, oldest_seconds should fall back to mtime (~0s), got {oldest}"
        )

    def test_corrupt_created_at_falls_back_to_mtime(self, tmp_path):
        """Corrupt createdAt falls back to mtime — no crash."""
        outbox = tmp_path / "outbox"
        outbox.mkdir()
        event_path = outbox / "20260612000000.ana-bot.test.evt003.json"

        _write_event(event_path, created_at="not-a-valid-timestamp")
        # Corrupt createdAt → fall back to mtime (~now)

        count, oldest = directory_stats(outbox, "*.json")
        assert count == 1
        # Should not crash; oldest should be based on mtime (~now = small value)
        assert oldest < 60, (
            f"Corrupt createdAt should fall back to mtime (~0s), got {oldest}"
        )

    def test_missing_created_at_field_falls_back_to_mtime(self, tmp_path):
        """Event JSON without createdAt key falls back to mtime silently."""
        outbox = tmp_path / "outbox"
        outbox.mkdir()
        event_path = outbox / "20260612000000.ana-bot.test.evt004.json"

        # Write event with no createdAt key at all
        event = {"schemaVersion": 1, "id": "no-created-at", "source": "test"}
        event_path.write_text(json.dumps(event) + "\n")
        event_path.chmod(0o600)

        count, oldest = directory_stats(outbox, "*.json")
        assert count == 1
        assert oldest < 60, (
            f"Missing createdAt should fall back to mtime (~0s), got {oldest}"
        )

    def test_non_json_pattern_uses_mtime(self, tmp_path):
        """Non-JSON files (e.g. *.writefail) still use mtime (unchanged behaviour)."""
        directory = tmp_path / "writefail"
        directory.mkdir()
        wf_path = directory / "20260612000000.test.writefail"
        wf_path.write_text('{"kind":"outbox_write_failure"}')
        wf_path.chmod(0o600)

        count, oldest = directory_stats(directory, "*.writefail")
        assert count == 1
        # mtime-based: ~now
        assert oldest < 60, (
            f"*.writefail (non-json pattern) should use mtime, got {oldest}"
        )

    def test_invalid_json_falls_back_to_mtime(self, tmp_path):
        """Unreadable/invalid JSON event falls back to mtime — no crash."""
        outbox = tmp_path / "outbox"
        outbox.mkdir()
        event_path = outbox / "bad.json"
        event_path.write_text("{invalid json{{}")
        event_path.chmod(0o600)

        # Must not raise
        count, oldest = directory_stats(outbox, "*.json")
        assert count == 1
        assert oldest < 60, f"Invalid JSON should fall back to mtime, got {oldest}"

    def test_multiple_events_oldest_from_earliest_created_at(self, tmp_path):
        """With multiple events, oldest_seconds is from the earliest createdAt."""
        outbox = tmp_path / "outbox"
        outbox.mkdir()

        now = time.time()
        t1 = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 3600))  # 1h ago
        t2 = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 600))   # 10min ago

        e1 = outbox / "e1.json"
        e2 = outbox / "e2.json"
        _write_event(e1, created_at=t1)
        _write_event(e2, created_at=t2)

        count, oldest = directory_stats(outbox, "*.json")
        assert count == 2
        # oldest should reflect 1h event, not 10min event
        assert oldest >= 3500, (
            f"oldest_seconds should be ~3600 from earliest createdAt, got {oldest}"
        )
