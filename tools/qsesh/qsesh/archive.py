"""Deterministic immutable publication of accepted raw session bytes."""

from __future__ import annotations

import errno
import gzip
import hashlib
import io
import os
import re
import secrets
import stat
from collections.abc import Callable
from pathlib import Path

from .errors import QseshError
from .model import ArchiveRef, Harness, SourceSnapshot
from .paths import (
    atomic_temp_path,
    confined_child,
    ensure_private_dir,
    open_private_new,
)

_QID = re.compile(r"qs-[a-z2-7]{10}").fullmatch
_DIGEST = re.compile(r"[0-9a-f]{64}").fullmatch
_Fault = Callable[[str], None]


def _fail(code: str, phase: str, error: BaseException | None = None) -> QseshError:
    failure = QseshError(code, phase=phase)
    if error is not None:
        failure.__cause__ = error
    return failure


def _gzip_bytes(raw: bytes) -> bytes:
    output = io.BytesIO()
    with gzip.GzipFile(
        filename="", mode="wb", fileobj=output, compresslevel=9, mtime=0
    ) as archive:
        archive.write(raw)
    return output.getvalue()


def _validate_input(snapshot: SourceSnapshot, qid: str) -> None:
    if not isinstance(snapshot, SourceSnapshot):
        raise _fail("QS-E-ARCHIVE", "archive-input")
    if not isinstance(qid, str) or _QID(qid) is None:
        raise _fail("QS-E-ARCHIVE", "archive-identity")
    if _DIGEST(snapshot.source_digest) is None:
        raise _fail("QS-E-ARCHIVE", "archive-source-digest")
    actual = hashlib.blake2b(snapshot.raw_bytes, digest_size=32).hexdigest()
    if actual != snapshot.source_digest:
        raise _fail("QS-E-ARCHIVE", "archive-source-digest")


def _archive_ref(snapshot: SourceSnapshot, qid: str, compressed: bytes) -> ArchiveRef:
    return ArchiveRef(
        relpath=(
            f"archive/{snapshot.candidate.harness.value}/{qid}/"
            f"{snapshot.source_digest}.jsonl.gz"
        ),
        sha256=hashlib.sha256(compressed).hexdigest(),
        source_digest=snapshot.source_digest,
        byte_count=len(snapshot.raw_bytes),
    )


def _read_regular(path: Path, *, code: str, phase: str) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise _fail(code, phase, error) from error
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise _fail(code, phase)
        chunks: list[bytes] = []
        while chunk := os.read(descriptor, 1024 * 1024):
            chunks.append(chunk)
        return b"".join(chunks)
    except OSError as error:
        raise _fail(code, phase, error) from error
    finally:
        os.close(descriptor)


def _verify_existing(final: Path, snapshot: SourceSnapshot, qid: str) -> ArchiveRef:
    compressed = _read_regular(
        final, code="QS-E-ARCHIVE-COLLISION", phase="archive-existing"
    )
    try:
        raw = gzip.decompress(compressed)
    except (EOFError, OSError) as error:
        raise _fail("QS-E-ARCHIVE-COLLISION", "archive-existing", error) from error
    if (
        raw != snapshot.raw_bytes
        or hashlib.blake2b(raw, digest_size=32).hexdigest() != snapshot.source_digest
        or compressed != _gzip_bytes(raw)
    ):
        raise _fail("QS-E-ARCHIVE-COLLISION", "archive-existing")
    return _archive_ref(snapshot, qid, compressed)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(
        path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
    )
    try:
        try:
            os.fsync(descriptor)
        except OSError as error:
            unsupported = {errno.EINVAL, getattr(errno, "ENOTSUP", errno.EINVAL)}
            unsupported.add(getattr(errno, "EOPNOTSUPP", errno.EINVAL))
            if error.errno not in unsupported:
                raise
    finally:
        os.close(descriptor)


def publish_archive(
    archive_root: Path,
    snapshot: SourceSnapshot,
    *,
    qid: str,
    fault: _Fault | None = None,
) -> ArchiveRef:
    """Publish one canonical gzip without overwriting an existing archive."""

    _validate_input(snapshot, qid)
    root = ensure_private_dir(Path(archive_root))
    parent = ensure_private_dir(
        confined_child(root, snapshot.candidate.harness.value, qid)
    )
    final = confined_child(parent, f"{snapshot.source_digest}.jsonl.gz")
    if final.exists():
        return _verify_existing(final, snapshot, qid)

    token = f"publish-{secrets.token_hex(8)}"
    temporary = atomic_temp_path(final, token=token)
    stage = "after-open"
    try:
        with open_private_new(temporary) as output:
            if fault is not None:
                fault(stage)
            stage = "after-write"
            archive = gzip.GzipFile(
                filename="", mode="wb", fileobj=output, compresslevel=9, mtime=0
            )
            try:
                archive.write(snapshot.raw_bytes)
                if fault is not None:
                    fault(stage)
            finally:
                archive.close()
            stage = "after-gzip-close"
            if fault is not None:
                fault(stage)
            output.flush()
            os.fsync(output.fileno())
            stage = "after-file-fsync"
            if fault is not None:
                fault(stage)

        try:
            os.link(temporary, final, follow_symlinks=False)
        except FileExistsError:
            temporary.unlink()
            return _verify_existing(final, snapshot, qid)
        stage = "after-publish"
        if fault is not None:
            fault(stage)
        temporary.unlink()
        _fsync_directory(parent)
        stage = "after-dir-fsync"
        if fault is not None:
            fault(stage)
    except QseshError:
        raise
    except OSError as error:
        raise _fail("QS-E-ARCHIVE", f"archive-{stage}", error) from error

    compressed = _read_regular(final, code="QS-E-ARCHIVE", phase="archive-read")
    if compressed != _gzip_bytes(snapshot.raw_bytes):
        raise _fail("QS-E-ARCHIVE", "archive-published-verification")
    return _archive_ref(snapshot, qid, compressed)


def _resolve_ref(archive_root: Path, ref: ArchiveRef) -> Path:
    if not isinstance(ref, ArchiveRef):
        raise _fail("QS-E-ARCHIVE", "archive-ref")
    parts = Path(ref.relpath).parts
    if (
        len(parts) != 4
        or parts[0] != "archive"
        or parts[1] not in {value.value for value in Harness}
        or _QID(parts[2]) is None
        or parts[3] != f"{ref.source_digest}.jsonl.gz"
    ):
        raise _fail("QS-E-ARCHIVE", "archive-ref")
    if _DIGEST(ref.sha256) is None or _DIGEST(ref.source_digest) is None:
        raise _fail("QS-E-ARCHIVE", "archive-ref")
    try:
        return confined_child(Path(archive_root), *parts[1:])
    except QseshError as error:
        raise _fail("QS-E-ARCHIVE", "archive-ref", error) from error


def read_archive(archive_root: Path, ref: ArchiveRef) -> bytes:
    final = _resolve_ref(archive_root, ref)
    compressed = _read_regular(
        final, code="QS-E-ARCHIVE", phase="archive-compressed-read"
    )
    if hashlib.sha256(compressed).hexdigest() != ref.sha256:
        raise _fail("QS-E-ARCHIVE", "archive-compressed-digest")
    try:
        raw = gzip.decompress(compressed)
    except (EOFError, OSError) as error:
        raise _fail("QS-E-ARCHIVE", "archive-gzip", error) from error
    if hashlib.blake2b(raw, digest_size=32).hexdigest() != ref.source_digest:
        raise _fail("QS-E-ARCHIVE", "archive-source-digest")
    if len(raw) != ref.byte_count:
        raise _fail("QS-E-ARCHIVE", "archive-byte-count")
    if compressed != _gzip_bytes(raw):
        raise _fail("QS-E-ARCHIVE", "archive-canonical-gzip")
    return raw


def verify_archive(archive_root: Path, ref: ArchiveRef) -> None:
    read_archive(archive_root, ref)
