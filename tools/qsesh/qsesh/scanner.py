"""Stable accepted-source cursor construction and classification."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

from qsesh.model import FileStamp, Harness, SourceCandidate, SourceSnapshot

_DIGEST = re.compile(r"[0-9a-f]{64}").fullmatch
_EXTRACTOR_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}").fullmatch


class CursorDecision(StrEnum):
    NEW = "new"
    CHANGED = "changed"
    UNCHANGED = "unchanged"


@dataclass(frozen=True, slots=True)
class SourceCursor:
    candidate: SourceCandidate
    source_digest: str
    extractor_version: str

    def __post_init__(self) -> None:
        if not isinstance(self.candidate, SourceCandidate):
            raise TypeError("candidate must be a SourceCandidate")
        if not isinstance(self.candidate.file_stamp, FileStamp):
            raise ValueError("an accepted JSONL cursor requires a file stamp")
        if (
            not isinstance(self.source_digest, str)
            or _DIGEST(self.source_digest) is None
        ):
            raise ValueError("source_digest must be lowercase BLAKE2b-256 hex")
        if (
            not isinstance(self.extractor_version, str)
            or _EXTRACTOR_VERSION(self.extractor_version) is None
        ):
            raise ValueError("extractor_version must be a safe version identifier")

    @property
    def file_identity(self) -> tuple[int, int, int, int, int]:
        stamp = self.candidate.file_stamp
        assert stamp is not None
        return (
            stamp.device,
            stamp.inode,
            stamp.size,
            stamp.mtime_ns,
            stamp.ctime_ns,
        )

    @property
    def source_identity(self) -> tuple[str, Harness, str, str, int]:
        candidate = self.candidate
        return (
            candidate.host_id,
            candidate.harness,
            candidate.native_id,
            candidate.source_key,
            candidate.updated_at_us,
        )


def cursor_from_snapshot(
    snapshot: SourceSnapshot,
    *,
    extractor_version: str,
) -> SourceCursor:
    if not isinstance(snapshot, SourceSnapshot):
        raise TypeError("snapshot must be a SourceSnapshot")
    return SourceCursor(
        candidate=snapshot.candidate,
        source_digest=snapshot.source_digest,
        extractor_version=extractor_version,
    )


def classify_cursor(
    candidate: SourceCursor,
    prior_cursor: SourceCursor | None,
) -> CursorDecision:
    if not isinstance(candidate, SourceCursor):
        raise TypeError("candidate must be a SourceCursor")
    if prior_cursor is None:
        return CursorDecision.NEW
    if not isinstance(prior_cursor, SourceCursor):
        raise TypeError("prior_cursor must be a SourceCursor or None")
    if candidate.file_identity != prior_cursor.file_identity:
        return CursorDecision.CHANGED
    if candidate.source_identity != prior_cursor.source_identity:
        return CursorDecision.CHANGED
    if candidate.extractor_version != prior_cursor.extractor_version:
        return CursorDecision.CHANGED
    if candidate.source_digest != prior_cursor.source_digest:
        return CursorDecision.CHANGED
    return CursorDecision.UNCHANGED
