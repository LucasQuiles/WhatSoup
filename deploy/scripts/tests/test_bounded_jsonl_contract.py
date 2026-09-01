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
    # #3404: compaction retains the newest records that fit under the LOW-WATER
    # target (TRIM_LOW_WATER_RATIO * max_bytes), not under max_bytes itself, so
    # the file has headroom after the rewrite. Size max_bytes so that exactly
    # the two newest existing records plus the incoming one fit that target.
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    records = [{"id": index, "payload": "x" * 24} for index in range(8)]
    incoming = {"id": 8, "payload": "y" * 24}
    target.write_bytes(b"".join(line_bytes(record) for record in records))
    expected = [records[-2], records[-1], incoming]
    expected_bytes = sum(len(line_bytes(record)) for record in expected)
    max_bytes = math.ceil(expected_bytes / module.TRIM_LOW_WATER_RATIO)
    low_water = int(max_bytes * module.TRIM_LOW_WATER_RATIO)
    assert expected_bytes <= low_water < expected_bytes + len(line_bytes(records[-3]))

    result = _append(module, target, incoming, max_bytes)

    assert result.status == "committed"
    assert result.method == "compact_replace"
    assert result.compacted is True
    assert read_records(target) == expected
    assert result.bytes_after == expected_bytes
    assert target.stat().st_size == expected_bytes
    assert target.stat().st_size <= low_water <= max_bytes


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

    # The existing line plus the incoming record must exceed max_bytes so the
    # append takes the destructive-compaction path (which is what the malformed
    # historical line has to block). Asserted rather than assumed: the budget
    # was once retuned 40 -> 32 only to clear the retired 1.25x high-water
    # overshoot (#3404); under the hard cap 40 exercises the path directly.
    max_bytes = 40
    assert len(original) + len(line_bytes({"id": "incoming"})) > max_bytes
    result = _append(module, target, {"id": "incoming"}, max_bytes)
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


def _fixed_width_record(n: int) -> dict:
    # Zero-padded counter keeps every serialized line the same length so the
    # cap arithmetic below is exact.
    return {"n": f"{n:05d}", "pad": "x" * 80}


def test_max_bytes_is_a_hard_cap_across_many_cap_crossings(tmp_path: Path) -> None:
    # #3404: BOT_ERRORS_*_JSONL_MAX_BYTES means MAXIMUM. Under the retired 1.25x
    # high-water design this run peaked at ~1.21 * max_bytes; the bound must
    # hold after EVERY committed append, across many compaction cycles, and the
    # file must actually reach the cap (so the assertion is not vacuous).
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    probe = line_bytes(_fixed_width_record(0))
    max_bytes = len(probe) * 10
    sizes = []
    compactions = 0
    for n in range(400):
        result = _append(module, target, _fixed_width_record(n), max_bytes)
        assert result.status == "committed", result
        assert result.oversized_record is False
        size = target.stat().st_size
        assert size <= max_bytes, (n, size, max_bytes, result)
        assert result.bytes_after == size
        sizes.append(size)
        compactions += result.method == "compact_replace"
    assert max(sizes) == max_bytes, "run never reached the cap; bound not exercised"
    assert compactions >= 20, "run did not cross the cap many times"


def test_compaction_trims_to_low_water_target_and_keeps_newest_suffix(tmp_path: Path) -> None:
    # #3404: the compaction that fires when an append would cross max_bytes
    # trims the file to TRIM_LOW_WATER_RATIO * max_bytes -- as many of the
    # newest records as fit under that target (not fewer), in order, ending
    # with the incoming record.
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    probe = line_bytes(_fixed_width_record(0))
    max_bytes = len(probe) * 10
    low_water = int(max_bytes * module.TRIM_LOW_WATER_RATIO)
    appended = []
    for n in range(10):
        record = _fixed_width_record(n)
        appended.append(record)
        result = _append(module, target, record, max_bytes)
        assert result.method == "append", (n, result)
    assert target.stat().st_size == max_bytes

    incoming = _fixed_width_record(10)
    appended.append(incoming)
    result = _append(module, target, incoming, max_bytes)

    assert (result.status, result.method, result.compacted) == ("committed", "compact_replace", True)
    assert result.bytes_before == max_bytes
    assert result.bytes_after == target.stat().st_size
    assert result.bytes_after <= low_water
    assert result.bytes_after + len(probe) > low_water, "compaction over-trimmed below the low-water target"
    retained = read_records(target)
    assert retained == appended[-len(retained):]
    assert retained[-1] == incoming
    assert 1 < len(retained) < len(appended)


def test_at_cap_appends_amortize_compaction_via_low_water_headroom(tmp_path: Path) -> None:
    # production incident (2026-08-28): a JSONL pinned at max_bytes compacted on
    # EVERY append (full read + parse + rewrite per record), stalling outbox
    # drains. #3404 keeps max_bytes hard and takes the amortisation from the
    # low-water trim instead: after a compaction the file has
    # (max_bytes - low_water) bytes of headroom, so at least
    # headroom // len(record) plain appends separate consecutive compactions.
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    probe = line_bytes(_fixed_width_record(0))
    max_bytes = len(probe) * 40
    low_water = int(max_bytes * module.TRIM_LOW_WATER_RATIO)
    headroom_records = (max_bytes - low_water) // len(probe)
    assert headroom_records >= 2, "fixture must leave real headroom"
    total = 200
    methods = []
    for n in range(total):
        result = _append(module, target, _fixed_width_record(n), max_bytes)
        assert result.status == "committed", result
        assert target.stat().st_size <= max_bytes
        methods.append(result.method)
    compactions = methods.count("compact_replace")
    assert compactions >= 1, methods
    # The stall signature: a compaction immediately followed by another one.
    for index in range(len(methods) - 1):
        assert not (methods[index] == "compact_replace" and methods[index + 1] == "compact_replace"), (
            index, methods[index - 3 : index + 3]
        )
    # Each compaction buys at least headroom_records plain appends.
    assert compactions <= math.ceil(total / (headroom_records + 1)) + 1, (compactions, methods)
    assert methods.count("append") >= total - compactions


def test_oversized_record_compacts_immediately_even_with_headroom(tmp_path: Path) -> None:
    # The one documented exception to the hard cap: a single record larger than
    # max_bytes evicts everything and becomes the whole file, at once, even when
    # the file had headroom for ordinary appends.
    module = _module()
    target = tmp_path / "diagnostic.jsonl"
    small = [{"id": index} for index in range(3)]
    target.write_bytes(b"".join(line_bytes(record) for record in small))
    max_bytes = target.stat().st_size + 4096
    incoming = {"id": "oversized", "payload": "z" * 5000}
    assert len(line_bytes(incoming)) > max_bytes

    result = _append(module, target, incoming, max_bytes)

    assert (result.status, result.method, result.compacted, result.oversized_record) == (
        "committed", "compact_replace", True, True
    )
    assert target.read_bytes() == line_bytes(incoming)
    assert result.bytes_after == len(line_bytes(incoming))
