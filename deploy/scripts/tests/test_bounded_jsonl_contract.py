from __future__ import annotations

import hashlib
import math
import os
from pathlib import Path
import stat
import sys
import uuid

import pytest


TEST_ROOT = Path(__file__).resolve().parent
if str(TEST_ROOT) not in sys.path:
    sys.path.insert(0, str(TEST_ROOT))

from bounded_jsonl_test_support import line_bytes, load_bounded_jsonl, read_records


def _module():
    return load_bounded_jsonl(f"bounded_jsonl_contract_{uuid.uuid4().hex}")


def _append(module, path: Path, record: dict, max_bytes: int = 4096):
    return module.append_bounded_jsonl(
        path,
        record,
        component="fixture.jsonl",
        max_bytes=max_bytes,
    )


def test_missing_target_commits_private_file(tmp_path: Path) -> None:
    module = _module()
    target = tmp_path / "private" / "diagnostic.jsonl"
    record = {"id": "missing"}

    result = _append(module, target, record)

    assert result.status == "committed"
    assert result.method == "append"
    assert result.stage == "complete"
    assert result.bytes_before == 0
    assert result.bytes_after == len(line_bytes(record))
    assert target.read_bytes() == line_bytes(record)
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert stat.S_IMODE(target.parent.stat().st_mode) == 0o700


def test_empty_target_appends_one_complete_line(tmp_path: Path) -> None:
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    target.write_bytes(b"")
    record = {"id": "empty"}

    result = _append(module, target, record)

    assert result.status == "committed"
    assert result.bytes_before == 0
    assert target.read_bytes() == line_bytes(record)


def test_under_limit_append_preserves_existing_bytes(tmp_path: Path) -> None:
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    existing = b'{"legacy":  1}\n'
    incoming = {"id": "incoming"}
    target.write_bytes(existing)

    result = _append(module, target, incoming, len(existing) + len(line_bytes(incoming)) + 1)

    assert result.status == "committed"
    assert result.method == "append"
    assert target.read_bytes() == existing + line_bytes(incoming)


def test_exact_limit_uses_direct_append(tmp_path: Path) -> None:
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    existing = line_bytes({"id": "existing"})
    incoming = {"id": "incoming"}
    target.write_bytes(existing)
    exact_limit = len(existing) + len(line_bytes(incoming))

    result = _append(module, target, incoming, exact_limit)

    assert result.status == "committed"
    assert result.method == "append"
    assert result.bytes_after == exact_limit
    assert target.read_bytes() == existing + line_bytes(incoming)


def test_over_limit_compaction_keeps_newest_records_in_order(tmp_path: Path) -> None:
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    records = [{"id": index, "payload": "x" * 24} for index in range(8)]
    incoming = {"id": 8, "payload": "y" * 24}
    target.write_bytes(b"".join(line_bytes(record) for record in records))
    max_bytes = sum(len(line_bytes(record)) for record in [records[-2], records[-1], incoming])

    result = _append(module, target, incoming, max_bytes)

    assert result.status == "committed"
    assert result.method == "compact_replace"
    assert result.compacted is True
    assert read_records(target) == [records[-2], records[-1], incoming]
    assert target.stat().st_size <= max_bytes


def test_oversized_incoming_record_survives_and_is_reported(tmp_path: Path) -> None:
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    target.write_bytes(line_bytes({"id": "old"}))
    incoming = {"id": "oversized", "payload": "z" * 256}

    result = _append(module, target, incoming, 32)

    assert result.status == "committed"
    assert result.method == "compact_replace"
    assert result.oversized_record is True
    assert target.read_bytes() == line_bytes(incoming)


def test_unicode_sorted_key_serialization_and_digest(tmp_path: Path) -> None:
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    record = {"z": "é", "a": "雪"}
    expected = line_bytes(record)

    result = _append(module, target, record)

    assert target.read_bytes() == expected
    assert result.record_sha256 == hashlib.sha256(expected).hexdigest()
    assert result.bytes_after == len(expected)


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_nan_and_infinity_fail_before_mutation(tmp_path: Path, value: float) -> None:
    module = _module()
    target = tmp_path / "diagnostic.jsonl"

    result = _append(module, target, {"unsafe": value})

    assert (result.status, result.method, result.stage, result.failure_class) == (
        "not_mutated", "none", "validation", "invalid_input"
    )
    assert result.record_sha256 is None
    assert not target.exists()
    assert not list(tmp_path.glob(".*bounded-jsonl*"))


@pytest.mark.parametrize(
    ("record", "component", "max_bytes", "timeout"),
    [
        ({"id": 1}, "Bad Component", 128, 1.0),
        ({"id": 1}, "fixture.jsonl", 0, 1.0),
        ({"id": 1}, "fixture.jsonl", True, 1.0),
        ({"id": 1}, "fixture.jsonl", 128, 0.0),
        ({"id": 1}, "fixture.jsonl", 128, float("inf")),
        (["not", "a", "mapping"], "fixture.jsonl", 128, 1.0),
    ],
)
def test_invalid_component_limit_timeout_and_record_fail_before_mutation(
    tmp_path: Path,
    record,
    component,
    max_bytes,
    timeout,
) -> None:
    module = _module()
    target = tmp_path / "diagnostic.jsonl"

    result = module.append_bounded_jsonl(
        target,
        record,
        component=component,
        max_bytes=max_bytes,
        lock_timeout_seconds=timeout,
    )

    assert (result.status, result.method, result.stage, result.failure_class) == (
        "not_mutated", "none", "validation", "invalid_input"
    )
    assert result.bytes_before is None
    assert result.bytes_after is None
    assert not target.exists()
    assert not list(tmp_path.glob(".*bounded-jsonl*"))


def test_partial_terminal_line_blocks_append_without_repair(tmp_path: Path) -> None:
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    original = b'{"id":"partial"}'
    target.write_bytes(original)

    result = _append(module, target, {"id": "incoming"}, 4096)

    assert (result.status, result.stage, result.failure_class) == (
        "not_mutated", "inspect", "incomplete_jsonl"
    )
    assert target.read_bytes() == original


def test_malformed_complete_line_blocks_destructive_compaction(tmp_path: Path) -> None:
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    original = b'{"broken":}\n'
    target.write_bytes(original)

    result = _append(module, target, {"id": "incoming"}, 8)

    assert (result.status, result.stage, result.failure_class) == (
        "not_mutated", "inspect", "invalid_jsonl"
    )
    assert target.read_bytes() == original


def _exercise_nonstandard_historical_constant(
    tmp_path: Path,
    constant: str,
) -> tuple[object, Path, bytes, Path]:
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    original = f'{{"id":"legacy","value":{constant}}}\n'.encode("utf-8")
    target.write_bytes(original)

    # 32 (not 40): the append must cross the TRIM_HIGH_WATER_RATIO threshold
    # so the destructive-compaction path is actually exercised under hysteresis.
    result = _append(module, target, {"id": "incoming"}, 32)
    temp = tmp_path / ".diagnostic.jsonl.bounded-jsonl.compact.tmp"
    return result, target, original, temp


def test_historical_nan_blocks_destructive_compaction(tmp_path: Path) -> None:
    result, target, original, temp = _exercise_nonstandard_historical_constant(
        tmp_path,
        "NaN",
    )

    assert (result.status, result.method, result.stage, result.failure_class) == (
        "not_mutated", "compact_replace", "inspect", "invalid_jsonl"
    )
    assert target.read_bytes() == original
    assert not temp.exists()


def test_historical_positive_infinity_blocks_destructive_compaction(
    tmp_path: Path,
) -> None:
    result, target, original, temp = _exercise_nonstandard_historical_constant(
        tmp_path,
        "Infinity",
    )

    assert (result.status, result.method, result.stage, result.failure_class) == (
        "not_mutated", "compact_replace", "inspect", "invalid_jsonl"
    )
    assert target.read_bytes() == original
    assert not temp.exists()


def test_historical_negative_infinity_blocks_destructive_compaction(
    tmp_path: Path,
) -> None:
    result, target, original, temp = _exercise_nonstandard_historical_constant(
        tmp_path,
        "-Infinity",
    )

    assert (result.status, result.method, result.stage, result.failure_class) == (
        "not_mutated", "compact_replace", "inspect", "invalid_jsonl"
    )
    assert target.read_bytes() == original
    assert not temp.exists()


def test_unexpected_serialization_failure_returns_content_free_internal_error(
    tmp_path: Path,
) -> None:
    module = _module()
    target = tmp_path / "diagnostic.jsonl"

    class ExplodingMapping(dict):
        def items(self):
            raise RuntimeError("sensitive serialization detail")

    result = _append(module, target, ExplodingMapping(id="incoming"))

    assert (result.status, result.method, result.stage, result.failure_class) == (
        "not_mutated", "none", "validation", "internal_error"
    )
    assert result.record_sha256 is None
    assert result.bytes_before is None
    assert result.bytes_after is None
    assert not target.exists()
    assert not list(tmp_path.glob(".*bounded-jsonl*"))


def test_equal_records_are_not_deduplicated(tmp_path: Path) -> None:
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    record = {"id": "same"}

    first = _append(module, target, record)
    second = _append(module, target, record)

    assert first.status == second.status == "committed"
    assert read_records(target) == [record, record]


def test_parent_and_target_modes_are_private(tmp_path: Path) -> None:
    module = _module()
    parent = tmp_path / "diagnostics"
    parent.mkdir(mode=0o755)
    target = parent / "diagnostic.jsonl"
    target.write_bytes(line_bytes({"id": "old"}))
    os.chmod(target, 0o644)

    result = _append(module, target, {"id": "new"})

    assert result.status == "committed"
    assert stat.S_IMODE(parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(target.stat().st_mode) == 0o600


def test_require_commit_error_is_content_free(tmp_path: Path) -> None:
    module = _module()
    target = tmp_path / "secret-path.jsonl"
    result = _append(module, target, {"secret-record": math.nan})

    with pytest.raises(module.BoundedJsonlCommitError) as raised:
        module.require_bounded_jsonl_commit(result)

    message = str(raised.value)
    assert "component=fixture.jsonl" in message
    assert "status=not_mutated" in message
    assert "stage=validation" in message
    assert "failure_class=invalid_input" in message
    assert "secret-path" not in message
    assert "secret-record" not in message
    assert raised.value.__cause__ is None


def test_at_cap_appends_amortize_compaction_with_high_water_hysteresis(tmp_path: Path) -> None:
    # production incident (2026-08-28): a JSONL pinned at max_bytes
    # compacted on EVERY append (full read + parse + rewrite per record),
    # stalling outbox drains. Hysteresis: plain-append until the high-water
    # ratio, then one compaction back under max_bytes — the rewrite amortizes
    # over ~0.25 * max_bytes of growth instead of firing per append.
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    probe = line_bytes({"n": 0, "pad": "x" * 80})
    max_bytes = len(probe) * 10
    methods = []
    for n in range(30):
        result = _append(module, target, {"n": n, "pad": "x" * 80}, max_bytes)
        assert result.status == "committed"
        methods.append(result.method)
        assert target.stat().st_size <= int(max_bytes * module.TRIM_HIGH_WATER_RATIO) + len(probe)
    compactions = methods.count("compact_replace")
    assert 1 <= compactions <= 6, methods
    assert methods.count("append") >= 20, methods
