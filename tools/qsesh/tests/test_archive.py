"""T16 deterministic immutable archive publication contracts."""

from __future__ import annotations

import gzip
import hashlib
import io
import os
import stat
from pathlib import Path

import pytest
from qsesh.archive import publish_archive, read_archive, verify_archive
from qsesh.errors import QseshError
from qsesh.model import ArchiveRef, Harness, SourceCandidate, SourceSnapshot

RAW = b'{"z":1}\n{"raw":"bytes-without-rewrite"}'
QID = "qs-abcdefghij"


def _snapshot(raw: bytes = RAW) -> SourceSnapshot:
    return SourceSnapshot(
        candidate=SourceCandidate(
            host_id="host-test-001",
            harness=Harness.CLAUDE,
            native_id="session-archive-001",
            source_key="archive-test",
            updated_at_us=1,
            file_stamp=None,
        ),
        raw_bytes=raw,
        source_digest=hashlib.blake2b(raw, digest_size=32).hexdigest(),
        schema_fingerprint="fixture-v1",
        harness_version=None,
    )


def _final(root: Path, snapshot: SourceSnapshot | None = None) -> Path:
    value = _snapshot() if snapshot is None else snapshot
    return root / "claude" / QID / f"{value.source_digest}.jsonl.gz"


def test_publish_has_exact_path_header_bytes_mode_digest_and_content(
    tmp_path: Path,
) -> None:
    root = tmp_path / "archive"
    snapshot = _snapshot()
    ref = publish_archive(root, snapshot, qid=QID)
    final = _final(root, snapshot)
    compressed = final.read_bytes()

    assert ref == ArchiveRef(
        relpath=f"archive/claude/{QID}/{snapshot.source_digest}.jsonl.gz",
        sha256=hashlib.sha256(compressed).hexdigest(),
        source_digest=snapshot.source_digest,
        byte_count=len(RAW),
    )
    assert compressed[:3] == b"\x1f\x8b\x08"
    assert compressed[3] & 0x08 == 0
    assert compressed[4:8] == b"\0\0\0\0"
    assert compressed[8] == 2
    assert gzip.decompress(compressed) == RAW
    assert stat.S_IMODE(final.stat().st_mode) == 0o600
    assert stat.S_IMODE(final.parent.stat().st_mode) == 0o700
    assert read_archive(root, ref) == RAW
    assert verify_archive(root, ref) is None


def test_publication_is_repeatable_across_roots_and_existing_good_file_is_reused(
    tmp_path: Path,
) -> None:
    snapshot = _snapshot()
    left = tmp_path / "left/archive"
    right = tmp_path / "right/archive"
    first = publish_archive(left, snapshot, qid=QID)
    final = _final(left, snapshot)
    inode = final.stat().st_ino
    first_bytes = final.read_bytes()
    reused = publish_archive(left, snapshot, qid=QID)
    independent = publish_archive(right, snapshot, qid=QID)

    assert reused == first == independent
    assert final.stat().st_ino == inode
    assert final.read_bytes() == first_bytes == _final(right, snapshot).read_bytes()


@pytest.mark.parametrize(
    "qid", ["", "../escape", "qs-ABC", "qs-abcdefghijk", "x-abcdefghij"]
)
def test_malicious_or_noncanonical_qid_is_rejected_without_write(
    tmp_path: Path, qid: str
) -> None:
    root = tmp_path / "archive"
    with pytest.raises(QseshError) as caught:
        publish_archive(root, _snapshot(), qid=qid)
    assert caught.value.code == "QS-E-ARCHIVE"
    assert caught.value.phase == "archive-identity"
    assert not root.exists()


def test_snapshot_digest_must_match_exact_raw_bytes(tmp_path: Path) -> None:
    snapshot = replace_snapshot_digest(_snapshot(), "0" * 64)
    with pytest.raises(QseshError) as caught:
        publish_archive(tmp_path / "archive", snapshot, qid=QID)
    assert caught.value.code == "QS-E-ARCHIVE"
    assert caught.value.phase == "archive-source-digest"


def replace_snapshot_digest(snapshot: SourceSnapshot, digest: str) -> SourceSnapshot:
    return SourceSnapshot(
        candidate=snapshot.candidate,
        raw_bytes=snapshot.raw_bytes,
        source_digest=digest,
        schema_fingerprint=snapshot.schema_fingerprint,
        harness_version=snapshot.harness_version,
    )


def test_existing_corrupt_or_different_archive_fails_loud_without_overwrite(
    tmp_path: Path,
) -> None:
    root = tmp_path / "archive"
    snapshot = _snapshot()
    ref = publish_archive(root, snapshot, qid=QID)
    final = _final(root, snapshot)
    final.write_bytes(b"not-gzip")

    with pytest.raises(QseshError) as caught:
        publish_archive(root, snapshot, qid=QID)
    assert caught.value.code == "QS-E-ARCHIVE-COLLISION"
    assert caught.value.phase == "archive-existing"
    assert final.read_bytes() == b"not-gzip"
    with pytest.raises(QseshError) as verify_error:
        verify_archive(root, ref)
    assert verify_error.value.code == "QS-E-ARCHIVE"
    assert verify_error.value.phase == "archive-compressed-digest"


def test_existing_noncanonical_gzip_of_same_raw_is_a_collision(tmp_path: Path) -> None:
    root = tmp_path / "archive"
    snapshot = _snapshot()
    final = _final(root, snapshot)
    final.parent.mkdir(parents=True)
    output = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=1) as archive:
        archive.write(RAW)
    noncanonical = output.getvalue()
    final.write_bytes(noncanonical)

    with pytest.raises(QseshError) as caught:
        publish_archive(root, snapshot, qid=QID)
    assert caught.value.code == "QS-E-ARCHIVE-COLLISION"
    assert final.read_bytes() == noncanonical


def test_file_and_final_directory_are_fsynced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    observed_modes: list[int] = []
    real_fsync = os.fsync

    def recording_fsync(descriptor: int) -> None:
        observed_modes.append(os.fstat(descriptor).st_mode)
        real_fsync(descriptor)

    monkeypatch.setattr(os, "fsync", recording_fsync)
    publish_archive(tmp_path / "archive", _snapshot(), qid=QID)
    assert any(stat.S_ISREG(mode) for mode in observed_modes)
    assert any(stat.S_ISDIR(mode) for mode in observed_modes)


def test_competing_invalid_publication_is_never_overwritten(tmp_path: Path) -> None:
    root = tmp_path / "archive"
    snapshot = _snapshot()
    final = _final(root, snapshot)

    def competing_writer(stage: str) -> None:
        if stage == "after-file-fsync":
            final.write_bytes(b"competing-invalid")

    with pytest.raises(QseshError) as caught:
        publish_archive(root, snapshot, qid=QID, fault=competing_writer)
    assert caught.value.code == "QS-E-ARCHIVE-COLLISION"
    assert caught.value.phase == "archive-existing"
    assert final.read_bytes() == b"competing-invalid"


@pytest.mark.parametrize(
    ("stage", "final_exists", "residue_exists"),
    [
        ("after-open", False, True),
        ("after-write", False, True),
        ("after-gzip-close", False, True),
        ("after-file-fsync", False, True),
        ("after-publish", True, True),
        ("after-dir-fsync", True, False),
    ],
)
def test_injected_faults_never_accept_a_corrupt_final_and_report_residue_truthfully(
    tmp_path: Path, stage: str, final_exists: bool, residue_exists: bool
) -> None:
    root = tmp_path / stage / "archive"
    snapshot = _snapshot()

    def fault(observed: str) -> None:
        if observed == stage:
            raise OSError("injected")

    with pytest.raises(QseshError) as caught:
        publish_archive(root, snapshot, qid=QID, fault=fault)
    assert caught.value.code == "QS-E-ARCHIVE"
    assert caught.value.phase == f"archive-{stage}"
    final = _final(root, snapshot)
    assert final.exists() is final_exists
    residues = (
        list(final.parent.glob(f".{final.name}.*.tmp")) if final.parent.exists() else []
    )
    assert bool(residues) is residue_exists
    if final_exists:
        compressed = final.read_bytes()
        assert gzip.decompress(compressed) == RAW
        assert stat.S_IMODE(final.stat().st_mode) == 0o600


def test_read_rejects_ref_escape_wrong_shape_and_digest_mismatch(
    tmp_path: Path,
) -> None:
    root = tmp_path / "archive"
    ref = publish_archive(root, _snapshot(), qid=QID)
    escaped = ArchiveRef(
        relpath="archive/../outside.jsonl.gz",
        sha256=ref.sha256,
        source_digest=ref.source_digest,
        byte_count=ref.byte_count,
    )
    with pytest.raises(QseshError) as caught:
        read_archive(root, escaped)
    assert caught.value.code == "QS-E-ARCHIVE"
    assert caught.value.phase == "archive-ref"

    wrong_count = ArchiveRef(
        relpath=ref.relpath,
        sha256=ref.sha256,
        source_digest=ref.source_digest,
        byte_count=ref.byte_count + 1,
    )
    with pytest.raises(QseshError) as count_error:
        verify_archive(root, wrong_count)
    assert count_error.value.code == "QS-E-ARCHIVE"
    assert count_error.value.phase == "archive-byte-count"


def test_read_rejects_forged_source_digest_even_with_matching_compressed_sha(
    tmp_path: Path,
) -> None:
    root = tmp_path / "archive"
    ref = publish_archive(root, _snapshot(), qid=QID)
    compressed = _final(root).read_bytes()
    forged_digest = "0" * 64
    forged_path = root / "claude" / QID / f"{forged_digest}.jsonl.gz"
    forged_path.write_bytes(compressed)
    forged = ArchiveRef(
        relpath=f"archive/claude/{QID}/{forged_digest}.jsonl.gz",
        sha256=hashlib.sha256(compressed).hexdigest(),
        source_digest=forged_digest,
        byte_count=ref.byte_count,
    )
    with pytest.raises(QseshError) as caught:
        read_archive(root, forged)
    assert caught.value.code == "QS-E-ARCHIVE"
    assert caught.value.phase == "archive-source-digest"


def test_read_rejects_noncanonical_gzip_even_when_all_content_digests_match(
    tmp_path: Path,
) -> None:
    root = tmp_path / "archive"
    snapshot = _snapshot()
    final = _final(root, snapshot)
    final.parent.mkdir(parents=True)
    output = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=1) as archive:
        archive.write(RAW)
    compressed = output.getvalue()
    final.write_bytes(compressed)
    ref = ArchiveRef(
        relpath=f"archive/claude/{QID}/{snapshot.source_digest}.jsonl.gz",
        sha256=hashlib.sha256(compressed).hexdigest(),
        source_digest=snapshot.source_digest,
        byte_count=len(RAW),
    )
    with pytest.raises(QseshError) as caught:
        read_archive(root, ref)
    assert caught.value.code == "QS-E-ARCHIVE"
    assert caught.value.phase == "archive-canonical-gzip"


def test_symlinked_archive_root_is_rejected_without_outside_write(
    tmp_path: Path,
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "archive"
    root.symlink_to(outside, target_is_directory=True)
    with pytest.raises(QseshError) as caught:
        publish_archive(root, _snapshot(), qid=QID)
    assert caught.value.code == "QS-E-PATH-CONFINEMENT"
    assert list(outside.iterdir()) == []


def test_archive_module_does_not_import_extractors_distiller_or_store() -> None:
    source = (Path(__file__).parents[1] / "qsesh/archive.py").read_text()
    assert "qsesh.extractors" not in source
    assert "qsesh.distill" not in source
    assert "qsesh.store" not in source
