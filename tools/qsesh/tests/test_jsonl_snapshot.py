"""T10 stable JSONL snapshot contracts."""

from __future__ import annotations

import hashlib
import os
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest
from qsesh.errors import QseshError
from qsesh.model import FileStamp, Harness, SourceCandidate, SourceSnapshot
from qsesh.sources.base import ReadOnlySourceFS, SourceRead
from qsesh.sources.jsonl import (
    JsonlSourceAdapter,
    SnapshotKind,
    SnapshotObservation,
)

NATIVE_ID = "11111111-1111-4111-8111-111111111111"
NOW_US = 2_000_000_000
LIVE_WINDOW_US = 600_000_000
OLD_UPDATED_US = NOW_US - LIVE_WINDOW_US - 1


def stamp(
    *,
    size: int = 3,
    inode: int = 2,
    mtime_ns: int = OLD_UPDATED_US * 1000,
    ctime_ns: int = 7,
) -> FileStamp:
    return FileStamp(
        device=1,
        inode=inode,
        size=size,
        mtime_ns=mtime_ns,
        ctime_ns=ctime_ns,
    )


class FakeSourceFS:
    def __init__(self, root: Path, *, raw_bytes: bytes = b"{}\n") -> None:
        self.path = root / "project" / f"{NATIVE_ID}.jsonl"
        self.discovery_stamp = stamp(size=len(raw_bytes))
        self.read_result = SourceRead(
            raw_bytes=raw_bytes,
            before=self.discovery_stamp,
            after=self.discovery_stamp,
        )
        self.read_error: QseshError | None = None
        self.read_calls = 0
        self.max_bytes: int | None = None

    def iter_files(self, root: Path) -> tuple[Path, ...]:
        assert root == self.path.parents[1]
        return (self.path,)

    def stat(self, path: Path) -> FileStamp:
        assert path == self.path
        return self.discovery_stamp

    def read_bytes(self, path: Path, *, max_bytes: int) -> SourceRead:
        assert path == self.path
        self.read_calls += 1
        self.max_bytes = max_bytes
        if self.read_error is not None:
            raise self.read_error
        return self.read_result


def adapter_and_candidate(
    tmp_path: Path, *, raw_bytes: bytes = b"{}\n"
) -> tuple[JsonlSourceAdapter, SourceCandidate, FakeSourceFS]:
    root = tmp_path / "claude"
    source_fs = FakeSourceFS(root, raw_bytes=raw_bytes)
    adapter = JsonlSourceAdapter(
        host_id="host-test-001",
        harness=Harness.CLAUDE,
        root=root,
        source_fs=source_fs,
    )
    candidate = adapter.discover().candidates[0]
    return adapter, candidate, source_fs


def test_exact_ten_minute_boundary_is_skipped_without_read(tmp_path: Path) -> None:
    adapter, candidate, source_fs = adapter_and_candidate(tmp_path)
    boundary_now = candidate.updated_at_us + LIVE_WINDOW_US

    result = adapter.snapshot(candidate, now_us=boundary_now)

    assert result == SnapshotObservation(
        candidate=candidate,
        kind=SnapshotKind.SKIPPED_LIVE,
    )
    assert source_fs.read_calls == 0


def test_one_microsecond_beyond_live_window_accepts_exact_bytes(
    tmp_path: Path,
) -> None:
    raw_bytes = b'{"type":"fixture"}\n'
    adapter, candidate, source_fs = adapter_and_candidate(tmp_path, raw_bytes=raw_bytes)
    now_us = candidate.updated_at_us + LIVE_WINDOW_US + 1

    result = adapter.snapshot(candidate, now_us=now_us)

    assert isinstance(result, SourceSnapshot)
    assert result.candidate == candidate
    assert result.raw_bytes == raw_bytes
    assert (
        result.source_digest == hashlib.blake2b(raw_bytes, digest_size=32).hexdigest()
    )
    assert result.schema_fingerprint == "unclassified-jsonl-v1"
    assert result.harness_version is None
    assert source_fs.read_calls == 1
    assert source_fs.max_bytes == len(raw_bytes)


def test_real_descriptor_boundary_preserves_exact_source_bytes(tmp_path: Path) -> None:
    root = tmp_path / "claude"
    path = root / "project" / f"{NATIVE_ID}.jsonl"
    path.parent.mkdir(parents=True)
    raw_bytes = b'{"one":1}\n{"two":2}\n'
    path.write_bytes(raw_bytes)
    mtime_ns = 1_000_000_000_000
    os.utime(path, ns=(mtime_ns, mtime_ns))
    adapter = JsonlSourceAdapter(
        host_id="host-test-001",
        harness=Harness.CLAUDE,
        root=root,
        source_fs=ReadOnlySourceFS(),
    )
    candidate = adapter.discover().candidates[0]

    result = adapter.snapshot(
        candidate,
        now_us=candidate.updated_at_us + LIVE_WINDOW_US + 1,
    )

    assert isinstance(result, SourceSnapshot)
    assert result.raw_bytes == raw_bytes
    assert (
        result.source_digest == hashlib.blake2b(raw_bytes, digest_size=32).hexdigest()
    )


@pytest.mark.parametrize(
    "now_us",
    [OLD_UPDATED_US - 1, OLD_UPDATED_US, OLD_UPDATED_US + LIVE_WINDOW_US],
)
def test_future_recent_and_boundary_candidates_are_skipped_before_read(
    tmp_path: Path, now_us: int
) -> None:
    adapter, candidate, source_fs = adapter_and_candidate(tmp_path)

    result = adapter.snapshot(candidate, now_us=now_us)

    assert isinstance(result, SnapshotObservation)
    assert result.kind is SnapshotKind.SKIPPED_LIVE
    assert source_fs.read_calls == 0


def test_complete_malformed_json_is_snapshotted_without_parsing(tmp_path: Path) -> None:
    malformed = b'{"broken":]\n'
    adapter, candidate, _source_fs = adapter_and_candidate(
        tmp_path, raw_bytes=malformed
    )

    result = adapter.snapshot(candidate, now_us=NOW_US)

    assert isinstance(result, SourceSnapshot)
    assert result.raw_bytes == malformed
    assert (
        result.source_digest == hashlib.blake2b(malformed, digest_size=32).hexdigest()
    )


@pytest.mark.parametrize("raw_bytes", [b"", b"{}", b'{"partial":true'])
def test_empty_or_incomplete_final_line_is_source_raced_not_published(
    tmp_path: Path, raw_bytes: bytes
) -> None:
    adapter, candidate, source_fs = adapter_and_candidate(tmp_path, raw_bytes=raw_bytes)

    result = adapter.snapshot(candidate, now_us=NOW_US)

    assert result == SnapshotObservation(
        candidate=candidate,
        kind=SnapshotKind.SOURCE_RACED,
    )
    assert not isinstance(result, SourceSnapshot)
    assert source_fs.read_calls == (0 if raw_bytes == b"" else 1)


def test_discovery_to_read_same_size_mutation_is_source_raced(tmp_path: Path) -> None:
    adapter, candidate, source_fs = adapter_and_candidate(tmp_path)
    changed_stamp = stamp(size=3, ctime_ns=8)
    source_fs.read_result = SourceRead(
        raw_bytes=b"[]\n",
        before=changed_stamp,
        after=changed_stamp,
    )

    result = adapter.snapshot(candidate, now_us=NOW_US)

    assert result.kind is SnapshotKind.SOURCE_RACED


@pytest.mark.parametrize(
    "before,after,raw_bytes",
    [
        (stamp(size=3, ctime_ns=8), stamp(size=3), b"{}\n"),
        (stamp(size=3), stamp(size=4, ctime_ns=8), b"{}\n"),
        (stamp(size=3), stamp(size=3, inode=3), b"{}\n"),
        (stamp(size=3), stamp(size=3), b"{}\n\n"),
        (stamp(size=3), stamp(size=3), b"{}\nextra"),
        (stamp(size=3), stamp(size=3), b"{}"),
    ],
)
def test_pre_post_or_exact_byte_count_change_is_source_raced(
    tmp_path: Path,
    before: FileStamp,
    after: FileStamp,
    raw_bytes: bytes,
) -> None:
    adapter, candidate, source_fs = adapter_and_candidate(tmp_path)
    source_fs.read_result = SourceRead(
        raw_bytes=raw_bytes,
        before=before,
        after=after,
    )

    result = adapter.snapshot(candidate, now_us=NOW_US)

    assert result.kind is SnapshotKind.SOURCE_RACED


@pytest.mark.parametrize("phase", ["source-read", "source-read-cap"])
def test_disappearance_or_bounded_growth_is_source_raced(
    tmp_path: Path, phase: str
) -> None:
    adapter, candidate, source_fs = adapter_and_candidate(tmp_path)
    error = QseshError("QS-E-SOURCE-READ", phase=phase)
    if phase == "source-read":
        error.__cause__ = FileNotFoundError()
    source_fs.read_error = error

    result = adapter.snapshot(candidate, now_us=NOW_US)

    assert result.kind is SnapshotKind.SOURCE_RACED


def test_permission_failure_remains_typed_source_error(tmp_path: Path) -> None:
    adapter, candidate, source_fs = adapter_and_candidate(tmp_path)
    error = QseshError("QS-E-SOURCE-READ", phase="source-read")
    error.__cause__ = PermissionError()
    source_fs.read_error = error

    with pytest.raises(QseshError) as caught:
        adapter.snapshot(candidate, now_us=NOW_US)

    assert caught.value is error
    assert caught.value.code == "QS-E-SOURCE-READ"


@pytest.mark.parametrize("now_us", [True, -1, 1.5, "1"])
def test_snapshot_rejects_non_timestamp_clock_values(
    tmp_path: Path, now_us: object
) -> None:
    adapter, candidate, _source_fs = adapter_and_candidate(tmp_path)

    with pytest.raises(QseshError) as caught:
        adapter.snapshot(candidate, now_us=now_us)  # type: ignore[arg-type]

    assert caught.value.code == "QS-E-BOUNDARY"
    assert caught.value.phase == "snapshot-clock"


def test_snapshot_observation_is_frozen_slotted_and_path_free(tmp_path: Path) -> None:
    adapter, candidate, _source_fs = adapter_and_candidate(tmp_path)
    observation = adapter.snapshot(
        candidate,
        now_us=candidate.updated_at_us + LIVE_WINDOW_US,
    )

    assert isinstance(observation, SnapshotObservation)
    assert not hasattr(observation, "__dict__")
    assert not hasattr(observation, "path")
    with pytest.raises((FrozenInstanceError, AttributeError, TypeError)):
        observation.kind = SnapshotKind.SOURCE_RACED  # type: ignore[misc]


@pytest.mark.parametrize("live_window_us", [True, 0, -1, 1.5, "1"])
def test_adapter_rejects_invalid_live_window(
    tmp_path: Path, live_window_us: object
) -> None:
    with pytest.raises(QseshError) as caught:
        JsonlSourceAdapter(
            host_id="host-test-001",
            harness=Harness.CLAUDE,
            root=tmp_path.resolve(),
            source_fs=FakeSourceFS(tmp_path.resolve()),
            live_window_us=live_window_us,  # type: ignore[arg-type]
        )

    assert caught.value.code == "QS-E-BOUNDARY"
    assert caught.value.phase == "snapshot-live-window"


def test_snapshot_observation_rejects_wrong_types() -> None:
    accepted_candidate = SourceCandidate(
        host_id="host-test-001",
        harness=Harness.CLAUDE,
        native_id=NATIVE_ID,
        source_key="sk-" + "a" * 64,
        updated_at_us=OLD_UPDATED_US,
        file_stamp=stamp(),
    )
    with pytest.raises(TypeError):
        SnapshotObservation(  # type: ignore[arg-type]
            candidate="candidate",
            kind=SnapshotKind.SOURCE_RACED,
        )
    with pytest.raises(TypeError):
        SnapshotObservation(  # type: ignore[arg-type]
            candidate=accepted_candidate,
            kind="source_raced",
        )
