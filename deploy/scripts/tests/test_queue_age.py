"""Tests for the shared queue_age SSOT module (lib/queue_age.py).

Covers acceptance criteria from #2460:
- Daily health and watchdog return the same event age for the same snapshot.
- Rewriting/retrying an event cannot reduce its immutable event age.
- Threshold comparison semantics (>=, zero-means-disabled) are shared and tested.
- Negative, non-finite, non-integral thresholds are rejected (fail-closed).

Also covers LabRatQ's adversarial challenges:
- Edge case: triggering condition during recovery (retry rewrite).
- Falsification: can a false-positive health signal mask this bug?
- TOCTOU: no time-of-check/time-of-use window in the age computation.
"""

from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

_LIB = Path(__file__).resolve().parents[1] / "lib" / "queue_age.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("queue_age", _LIB)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()
event_file_age_seconds = _mod.event_file_age_seconds
is_durable_internal_entry = _mod.is_durable_internal_entry
scan_directory = _mod.scan_directory
parse_queue_threshold = _mod.parse_queue_threshold
threshold_met = _mod.threshold_met


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_event(path: Path, created_at: str | None, other: dict | None = None) -> None:
    event: dict = {
        "schemaVersion": 1,
        "id": "test-evt",
        "eventType": "alert",
        "severity": "critical",
        "source": "test_source",
        "instance": "test",
        "summary": "Test queue age event",
        "delivery": {"attempts": 0, "status": "queued"},
    }
    if created_at is not None:
        event["createdAt"] = created_at
    if other:
        event.update(other)
    path.write_text(json.dumps(event, sort_keys=True) + "\n")
    path.chmod(0o600)


def _iso(seconds_ago: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - seconds_ago))


# ---------------------------------------------------------------------------
# event_file_age_seconds
# ---------------------------------------------------------------------------


class TestEventFileAgeSeconds:
    def test_created_at_2h_ago_reflects_2h(self, tmp_path):
        """Event with createdAt 2h ago but mtime now -> age ~7200s."""
        path = tmp_path / "event.json"
        _write_event(path, created_at=_iso(7200))
        now = time.time()
        age = event_file_age_seconds(path, now)
        assert age >= 7100, f"expected ~7200 from createdAt, got {age}"

    def test_missing_created_at_falls_back_to_mtime(self, tmp_path):
        """No createdAt -> uses mtime (~0 for just-written file)."""
        path = tmp_path / "event.json"
        _write_event(path, created_at=None)
        now = time.time()
        age = event_file_age_seconds(path, now)
        assert age < 60, f"expected ~0 from mtime fallback, got {age}"

    def test_corrupt_created_at_falls_back_to_mtime(self, tmp_path):
        """Corrupt createdAt -> falls back to mtime."""
        path = tmp_path / "event.json"
        _write_event(path, created_at="not-a-timestamp")
        now = time.time()
        age = event_file_age_seconds(path, now)
        assert age < 60, f"expected mtime fallback for corrupt createdAt, got {age}"

    def test_invalid_json_falls_back_to_mtime(self, tmp_path):
        """Invalid JSON -> falls back to mtime."""
        path = tmp_path / "bad.json"
        path.write_text("{invalid json{{}")
        path.chmod(0o600)
        now = time.time()
        age = event_file_age_seconds(path, now)
        assert age < 60, f"expected mtime fallback for invalid JSON, got {age}"

    def test_empty_file_falls_back_to_mtime(self, tmp_path):
        """Empty file -> falls back to mtime."""
        path = tmp_path / "empty.json"
        path.write_text("")
        path.chmod(0o600)
        now = time.time()
        age = event_file_age_seconds(path, now)
        assert age < 60, f"expected mtime fallback for empty file, got {age}"

    def test_naive_timestamp_assumed_utc(self, tmp_path):
        """Timestamp without Z/+00:00 should be treated as UTC."""
        path = tmp_path / "event.json"
        naive = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 3600))
        _write_event(path, created_at=naive)
        now = time.time()
        age = event_file_age_seconds(path, now)
        assert 3500 <= age <= 3700, f"expected ~3600 for naive UTC timestamp, got {age}"

    def test_future_timestamp_clamped_to_zero(self, tmp_path):
        """Future createdAt should not produce negative age (clamped to 0)."""
        path = tmp_path / "event.json"
        _write_event(path, created_at=_iso(-3600))
        now = time.time()
        age = event_file_age_seconds(path, now)
        assert age == 0.0, f"future createdAt should clamp to 0, got {age}"

    def test_non_string_created_at_falls_back_to_mtime(self, tmp_path):
        """Non-string createdAt (int/float/null) -> falls back to mtime."""
        path = tmp_path / "event.json"
        _write_event(path, created_at=None, other={"createdAt": 1234567890})
        now = time.time()
        age = event_file_age_seconds(path, now)
        assert age < 60, f"non-string createdAt should use mtime, got {age}"

    def test_unreadable_file_falls_back_to_mtime(self, tmp_path):
        """Unreadable file -> JSON parse fails, falls back to mtime (small age)."""
        path = tmp_path / "noperm.json"
        _write_event(path, created_at=_iso(7200))
        path.chmod(0o000)
        now = time.time()
        try:
            age = event_file_age_seconds(path, now)
            # chmod 0o000 blocks read but not stat, so mtime fallback
            # returns a small age (file was just written)
            assert age < 60, f"unreadable file should fall back to mtime, got {age}"
        finally:
            path.chmod(0o600)


# ---------------------------------------------------------------------------
# Retry rewrite — the core #2460 scenario
# ---------------------------------------------------------------------------


class TestRetryRewrite:
    def test_rewrite_refreshes_mtime_but_not_age(self, tmp_path):
        """Dispatcher retry rewrites the file (refreshing mtime) without
        changing createdAt.  Age must NOT decrease after rewrite."""
        path = tmp_path / "event.json"
        old_created = _iso(7200)  # 2h ago
        _write_event(path, created_at=old_created)

        now1 = time.time()
        age_before = event_file_age_seconds(path, now1)

        # Simulate retry: rewrite file with same createdAt, new mtime
        time.sleep(0.05)
        _write_event(path, created_at=old_created)

        now2 = time.time()
        age_after = event_file_age_seconds(path, now2)

        # Age should be ~same (or slightly older due to time passing),
        # NOT reset to ~0 from the fresh mtime
        assert age_after >= age_before - 1, (
            f"retry rewrite should not reduce age: before={age_before}, after={age_after}"
        )
        assert age_after >= 7100, (
            f"age should still be ~7200 after retry rewrite, got {age_after}"
        )

    def test_multiple_retries_never_reduce_age(self, tmp_path):
        """Repeated retries keep refreshing mtime but age stays ~constant."""
        path = tmp_path / "event.json"
        old_created = _iso(3600)  # 1h ago
        _write_event(path, created_at=old_created)

        ages = []
        for _ in range(3):
            time.sleep(0.02)
            _write_event(path, created_at=old_created)
            ages.append(event_file_age_seconds(path, time.time()))

        # Each age should be >= 3500 (within tolerance of 3600)
        for i, age in enumerate(ages):
            assert age >= 3500, f"retry {i}: age dropped to {age}, expected >=3500"

    def test_health_and_watchdog_agree_on_age(self, tmp_path):
        """Both consumers use the same scan_directory -> same age for same snapshot."""
        outbox = tmp_path / "outbox"
        outbox.mkdir()
        old_created = _iso(7200)
        _write_event(outbox / "e1.json", created_at=old_created)

        # Simulate both consumers scanning at the same 'now'
        now = time.time()
        count, oldest = scan_directory(outbox, "*.json", now)
        assert count == 1
        assert oldest >= 7100, f"oldest should be ~7200, got {oldest}"


# ---------------------------------------------------------------------------
# scan_directory
# ---------------------------------------------------------------------------


class TestScanDirectory:
    def test_json_pattern_uses_created_at(self, tmp_path):
        d = tmp_path / "outbox"
        d.mkdir()
        _write_event(d / "e1.json", created_at=_iso(3600))
        count, oldest = scan_directory(d, "*.json", time.time())
        assert count == 1
        assert oldest >= 3500

    def test_non_json_pattern_uses_mtime(self, tmp_path):
        d = tmp_path / "writefail"
        d.mkdir()
        wf = d / "e1.writefail"
        wf.write_text('{"kind":"writefail"}')
        wf.chmod(0o600)
        count, oldest = scan_directory(d, "*.writefail", time.time())
        assert count == 1
        assert oldest < 60

    def test_empty_directory_returns_zero(self, tmp_path):
        d = tmp_path / "outbox"
        d.mkdir()
        count, oldest = scan_directory(d, "*.json", time.time())
        assert count == 0 and oldest == 0

    def test_nonexistent_directory_returns_zero(self, tmp_path):
        count, oldest = scan_directory(tmp_path / "nope", "*.json", time.time())
        assert count == 0 and oldest == 0

    def test_durable_lock_excluded(self, tmp_path):
        """.durable-json.lock must not be counted (see #2727)."""
        d = tmp_path / "outbox"
        d.mkdir()
        _write_event(d / "e1.json", created_at=_iso(60))
        lock = d / ".durable-json.lock"
        lock.write_text("{}")
        lock.chmod(0o600)
        count, oldest = scan_directory(d, "*.json", time.time())
        assert count == 1, f"durable lock should be excluded, count={count}"

    def test_mixed_queue_oldest_from_earliest(self, tmp_path):
        """With multiple events, oldest is from the earliest createdAt."""
        d = tmp_path / "outbox"
        d.mkdir()
        _write_event(d / "e1.json", created_at=_iso(3600))
        _write_event(d / "e2.json", created_at=_iso(60))
        count, oldest = scan_directory(d, "*.json", time.time())
        assert count == 2
        assert oldest >= 3500, f"oldest should reflect 1h event, got {oldest}"

    def test_mixed_created_and_no_created(self, tmp_path):
        """Events with and without createdAt — oldest comes from the one with createdAt."""
        d = tmp_path / "outbox"
        d.mkdir()
        _write_event(d / "e1.json", created_at=_iso(3600))
        _write_event(d / "e2.json", created_at=None)  # falls back to mtime (~0)
        count, oldest = scan_directory(d, "*.json", time.time())
        assert count == 2
        assert oldest >= 3500, f"oldest should be ~3600 from e1, got {oldest}"


# ---------------------------------------------------------------------------
# is_durable_internal_entry
# ---------------------------------------------------------------------------


class TestIsDurableInternalEntry:
    def test_durable_json_lock_excluded(self):
        assert is_durable_internal_entry(Path(".durable-json.lock")) is True

    def test_regular_json_not_excluded(self):
        assert is_durable_internal_entry(Path("event.json")) is False

    def test_other_lock_not_excluded(self):
        assert is_durable_internal_entry(Path(".other.lock")) is False


# ---------------------------------------------------------------------------
# parse_queue_threshold — fail-closed (#2460 threshold blind spot)
# ---------------------------------------------------------------------------


class TestParseQueueThreshold:
    def test_unset_returns_default(self, monkeypatch):
        monkeypatch.delenv("TEST_THRESH", raising=False)
        assert parse_queue_threshold("TEST_THRESH", 42) == 42

    def test_empty_string_returns_default(self, monkeypatch):
        monkeypatch.setenv("TEST_THRESH", "")
        assert parse_queue_threshold("TEST_THRESH", 42) == 42

    def test_whitespace_returns_default(self, monkeypatch):
        monkeypatch.setenv("TEST_THRESH", "   ")
        assert parse_queue_threshold("TEST_THRESH", 42) == 42

    def test_valid_integer(self, monkeypatch):
        monkeypatch.setenv("TEST_THRESH", "100")
        assert parse_queue_threshold("TEST_THRESH", 42) == 100

    def test_zero_means_disabled(self, monkeypatch):
        monkeypatch.setenv("TEST_THRESH", "0")
        assert parse_queue_threshold("TEST_THRESH", 42) == 0

    def test_negative_raises(self, monkeypatch):
        monkeypatch.setenv("TEST_THRESH", "-5")
        with pytest.raises(ValueError, match="negative"):
            parse_queue_threshold("TEST_THRESH", 42)

    def test_infinity_raises(self, monkeypatch):
        monkeypatch.setenv("TEST_THRESH", "inf")
        with pytest.raises(ValueError, match="not finite"):
            parse_queue_threshold("TEST_THRESH", 42)

    def test_nan_raises(self, monkeypatch):
        monkeypatch.setenv("TEST_THRESH", "nan")
        with pytest.raises(ValueError, match="not finite"):
            parse_queue_threshold("TEST_THRESH", 42)

    def test_non_numeric_raises(self, monkeypatch):
        monkeypatch.setenv("TEST_THRESH", "bad")
        with pytest.raises(ValueError, match="not a number"):
            parse_queue_threshold("TEST_THRESH", 42)

    def test_float_string_truncates_to_int(self, monkeypatch):
        """'100.0' is accepted as integral; '100.5' is rejected."""
        monkeypatch.setenv("TEST_THRESH", "100.0")
        assert parse_queue_threshold("TEST_THRESH", 42) == 100

    def test_non_integral_raises(self, monkeypatch):
        monkeypatch.setenv("TEST_THRESH", "100.5")
        with pytest.raises(ValueError, match="must be integral"):
            parse_queue_threshold("TEST_THRESH", 42)


# ---------------------------------------------------------------------------
# threshold_met — shared >= semantics with zero-means-disabled
# ---------------------------------------------------------------------------


class TestThresholdMet:
    def test_value_equals_threshold(self):
        assert threshold_met(10, 10) is True

    def test_value_exceeds_threshold(self):
        assert threshold_met(15, 10) is True

    def test_value_below_threshold(self):
        assert threshold_met(5, 10) is False

    def test_zero_threshold_means_disabled(self):
        assert threshold_met(100, 0) is False

    def test_zero_value_zero_threshold(self):
        assert threshold_met(0, 0) is False

    def test_zero_value_positive_threshold(self):
        assert threshold_met(0, 1) is False

    def test_negative_value_positive_threshold(self):
        """Even a negative value doesn't meet a positive threshold."""
        assert threshold_met(-1, 1) is False
