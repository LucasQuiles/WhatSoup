"""Tests for #2135: bounded JSONL retention for controller diagnostics.

fails-before:  dispatch.jsonl / heartbeat-watchdog.jsonl grow unbounded (pure
               append, no size/age checks).
passes-after:  _trim_jsonl fires after append when the file exceeds
               MAX_{DISPATCH,HEARTBEAT}_JSONL_BYTES and keeps only the
               newest records fitting under the threshold.

No regression: files under the max_bytes threshold are untouched.
Env override:  BOT_ERRORS_DISPATCH_JSONL_MAX_BYTES changes the threshold.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path


# ---------------------------------------------------------------------------
# Helper: load the watchdog module
# ---------------------------------------------------------------------------

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]


def _load_watchdog():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_watchdog_2135",
        _SCRIPT_ROOT / "bot-errors-heartbeat-watchdog.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _load_dispatcher():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_dispatcher_2135",
        _SCRIPT_ROOT / "bot-errors-dispatcher.py",
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _write_jsonl(path: Path, records: list[dict]) -> Path:
    lines = [json.dumps(r, sort_keys=True) + "\n" for r in records]
    path.write_text("".join(lines), encoding="utf-8")
    return path


def _jsonl_bytes(path: Path) -> int:
    return path.stat().st_size


def _jsonl_count(path: Path) -> int:
    return len(path.read_text(encoding="utf-8").splitlines())


# ---------------------------------------------------------------------------
# _trim_jsonl unit tests
# ---------------------------------------------------------------------------


class TestTrimJsonl:
    """_trim_jsonl removes oldest records when the file exceeds max_bytes."""

    def test_file_under_threshold_is_untouched(self, tmp_path: Path):
        """No-regression: a small file is not modified."""
        mod = _load_watchdog()
        path = tmp_path / "test.jsonl"
        records = [{"i": i, "data": "x" * 100} for i in range(10)]
        _write_jsonl(path, records)
        original = _jsonl_bytes(path)

        mod._trim_jsonl(path, original * 2)

        assert _jsonl_bytes(path) == original, "file must not change when under threshold"
        assert _jsonl_count(path) == 10, "all records must survive"

    def test_trim_removes_oldest_when_over_threshold(self, tmp_path: Path):
        """When file exceeds max_bytes, oldest records are removed."""
        mod = _load_watchdog()
        path = tmp_path / "test.jsonl"
        records = [{"i": i, "data": "x" * 1000} for i in range(200)]
        _write_jsonl(path, records)
        total = _jsonl_bytes(path)

        threshold = total // 3
        mod._trim_jsonl(path, threshold)

        assert _jsonl_bytes(path) <= threshold, (
            f"file must be <= {threshold} bytes after trim"
        )
        remaining = _jsonl_count(path)
        assert 1 <= remaining < 200, f"some records should remain ({remaining})"

        lines = path.read_text(encoding="utf-8").splitlines()
        for line in lines:
            record = json.loads(line)
            assert record["i"] >= 200 - remaining, (
                f"old record i={record['i']} survived but should have been trimmed"
            )

    def test_empty_file_is_untouched(self, tmp_path: Path):
        """An empty file is not modified."""
        mod = _load_watchdog()
        path = tmp_path / "test.jsonl"
        path.write_text("", encoding="utf-8")

        mod._trim_jsonl(path, 1000)
        assert path.read_text(encoding="utf-8") == "", "empty file must stay empty"

    def test_nonexistent_file_is_safe(self, tmp_path: Path):
        """A nonexistent path does not cause an error."""
        mod = _load_watchdog()
        path = tmp_path / "nonexistent.jsonl"

        mod._trim_jsonl(path, 1000)

        assert not path.exists(), "trim must not create a missing file"

    def test_trim_single_record_preserves_it(self, tmp_path: Path):
        """A single record larger than threshold is preserved."""
        mod = _load_watchdog()
        path = tmp_path / "test.jsonl"
        large = {"data": "x" * 100000}
        _write_jsonl(path, [large])

        mod._trim_jsonl(path, 100)

        assert _jsonl_count(path) == 1, "at least one record must survive"
        assert json.loads(path.read_text(encoding="utf-8")) == large

    def test_env_override_dispatch_max_bytes(self):
        """BOT_ERRORS_DISPATCH_JSONL_MAX_BYTES env var overrides the default."""
        import os
        os.environ["BOT_ERRORS_DISPATCH_JSONL_MAX_BYTES"] = "10485760"
        try:
            mod = _load_dispatcher()
            assert mod.MAX_DISPATCH_JSONL_BYTES == 10 * 1024 * 1024
        finally:
            os.environ.pop("BOT_ERRORS_DISPATCH_JSONL_MAX_BYTES", None)

    def test_heartbeat_default_is_separate(self):
        """The heartbeat watchdog has its own threshold independent from dispatcher."""
        mod = _load_watchdog()
        assert mod.MAX_HEARTBEAT_JSONL_BYTES == 50 * 1024 * 1024
