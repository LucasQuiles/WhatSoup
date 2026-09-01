"""Tests for #2135: append-plus-retention through the fenced JSONL helper."""

from __future__ import annotations

import importlib.util
import math
import os
from pathlib import Path
import sys
import uuid


_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
_TEST_ROOT = Path(__file__).resolve().parent
if str(_TEST_ROOT) not in sys.path:
    sys.path.insert(0, str(_TEST_ROOT))

from bounded_jsonl_test_support import line_bytes, load_bounded_jsonl, read_records


def _load_watchdog():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_watchdog_2135",
        _SCRIPT_ROOT / "bot-errors-heartbeat-watchdog.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_dispatcher():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_dispatcher_2135",
        _SCRIPT_ROOT / "bot-errors-dispatcher.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _module():
    return load_bounded_jsonl(f"bounded_jsonl_retention_{uuid.uuid4().hex}")


def _append(module, path: Path, record: dict, max_bytes: int):
    return module.append_bounded_jsonl(
        path,
        record,
        component="fixture.retention",
        max_bytes=max_bytes,
    )


class TestAppendPlusRetention:
    def test_under_threshold_preserves_prefix_and_appends(self, tmp_path: Path) -> None:
        module = _module()
        target = tmp_path / "diagnostic.jsonl"
        existing = b'{"legacy":  1}\n'
        incoming = {"id": "incoming"}
        target.write_bytes(existing)

        result = _append(module, target, incoming, 4096)

        assert result.status == "committed"
        assert result.method == "append"
        assert target.read_bytes() == existing + line_bytes(incoming)

    def test_over_threshold_keeps_newest_ordered_suffix(self, tmp_path: Path) -> None:
        # #3404: retention after compaction is the newest suffix that fits under
        # the low-water target (TRIM_LOW_WATER_RATIO * max_bytes); max_bytes
        # itself is the hard ceiling the file never exceeds.
        module = _module()
        target = tmp_path / "diagnostic.jsonl"
        existing = [{"id": index, "payload": "x" * 64} for index in range(10)]
        incoming = {"id": 10, "payload": "y" * 64}
        target.write_bytes(b"".join(line_bytes(record) for record in existing))
        expected = [existing[-2], existing[-1], incoming]
        expected_bytes = sum(len(line_bytes(record)) for record in expected)
        max_bytes = math.ceil(expected_bytes / module.TRIM_LOW_WATER_RATIO)
        low_water = int(max_bytes * module.TRIM_LOW_WATER_RATIO)
        assert expected_bytes <= low_water < expected_bytes + len(line_bytes(existing[-3]))

        result = _append(module, target, incoming, max_bytes)

        assert result.status == "committed"
        assert result.method == "compact_replace"
        assert read_records(target) == expected
        assert target.stat().st_size == expected_bytes
        assert target.stat().st_size <= low_water <= max_bytes

    def test_empty_file_becomes_one_committed_record(self, tmp_path: Path) -> None:
        module = _module()
        target = tmp_path / "diagnostic.jsonl"
        target.write_bytes(b"")
        incoming = {"id": "incoming"}

        result = _append(module, target, incoming, 4096)

        assert result.status == "committed"
        assert target.read_bytes() == line_bytes(incoming)

    def test_missing_file_becomes_one_private_committed_record(self, tmp_path: Path) -> None:
        module = _module()
        target = tmp_path / "diagnostic.jsonl"
        incoming = {"id": "incoming"}

        result = _append(module, target, incoming, 4096)

        assert result.status == "committed"
        assert target.read_bytes() == line_bytes(incoming)
        assert target.stat().st_mode & 0o777 == 0o600

    def test_oversized_incoming_record_survives_alone(self, tmp_path: Path) -> None:
        module = _module()
        target = tmp_path / "diagnostic.jsonl"
        target.write_bytes(line_bytes({"id": "old"}))
        incoming = {"id": "oversized", "payload": "z" * 1000}

        result = _append(module, target, incoming, 64)

        assert result.status == "committed"
        assert result.oversized_record is True
        assert target.read_bytes() == line_bytes(incoming)

    def test_env_override_dispatch_max_bytes(self) -> None:
        os.environ["BOT_ERRORS_DISPATCH_JSONL_MAX_BYTES"] = "10485760"
        try:
            module = _load_dispatcher()
            assert module.MAX_DISPATCH_JSONL_BYTES == 10 * 1024 * 1024
        finally:
            os.environ.pop("BOT_ERRORS_DISPATCH_JSONL_MAX_BYTES", None)

    def test_heartbeat_default_is_separate(self) -> None:
        module = _load_watchdog()
        assert module.MAX_HEARTBEAT_JSONL_BYTES == 50 * 1024 * 1024
