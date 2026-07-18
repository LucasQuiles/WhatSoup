"""Deterministic metadata-only discovery for Claude and Codex JSONL sessions."""

from __future__ import annotations

import hashlib
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from pathlib import Path

from qsesh.errors import QseshError
from qsesh.model import FileStamp, Harness, SourceCandidate, SourceSnapshot
from qsesh.sources.base import SourceFS

_HOST_ID = re.compile(r"[a-z][a-z0-9._-]{0,63}").fullmatch
_UUID_TEXT = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_CLAUDE_NATIVE_ID = re.compile(_UUID_TEXT, re.IGNORECASE).fullmatch
_CODEX_FILENAME = re.compile(
    rf"rollout-(?P<timestamp>\d{{4}}-\d{{2}}-\d{{2}}T\d{{2}}-\d{{2}}-\d{{2}})-"
    rf"(?P<native_id>{_UUID_TEXT})",
    re.IGNORECASE,
).fullmatch
_SOURCE_KEY_DOMAIN = b"qsesh-source-key-v1\0"
_LIVE_WINDOW_US = 10 * 60 * 1_000_000
_UNCLASSIFIED_SCHEMA_FINGERPRINT = "unclassified-jsonl-v1"


class DiscoveryKind(StrEnum):
    SOURCE_RACED = "source_raced"
    DUPLICATE_INODE = "duplicate_inode"
    EXCLUDED_NON_JSONL = "excluded_non_jsonl"
    EXCLUDED_INVALID_LAYOUT = "excluded_invalid_layout"


class SnapshotKind(StrEnum):
    SKIPPED_LIVE = "skipped_live"
    SOURCE_RACED = "source_raced"


@dataclass(frozen=True, slots=True)
class SnapshotObservation:
    candidate: SourceCandidate
    kind: SnapshotKind

    def __post_init__(self) -> None:
        if not isinstance(self.candidate, SourceCandidate):
            raise TypeError("candidate must be a SourceCandidate")
        if not isinstance(self.kind, SnapshotKind):
            raise TypeError("kind must be a SnapshotKind")


@dataclass(frozen=True, slots=True)
class DiscoveryObservation:
    kind: DiscoveryKind
    source_key: str

    def __post_init__(self) -> None:
        if not isinstance(self.kind, DiscoveryKind):
            raise TypeError("kind must be a DiscoveryKind")
        if re.fullmatch(r"sk-[0-9a-f]{64}", self.source_key) is None:
            raise ValueError("source_key must be a safe source digest")


@dataclass(frozen=True, slots=True)
class DiscoveryResult:
    candidates: tuple[SourceCandidate, ...]
    observations: tuple[DiscoveryObservation, ...]
    scanned_file_count: int

    def __post_init__(self) -> None:
        if not isinstance(self.candidates, tuple) or not all(
            isinstance(candidate, SourceCandidate) for candidate in self.candidates
        ):
            raise TypeError("candidates must be a tuple of SourceCandidate values")
        if not isinstance(self.observations, tuple) or not all(
            isinstance(observation, DiscoveryObservation)
            for observation in self.observations
        ):
            raise TypeError(
                "observations must be a tuple of DiscoveryObservation values"
            )
        if (
            isinstance(self.scanned_file_count, bool)
            or not isinstance(self.scanned_file_count, int)
            or self.scanned_file_count < 0
        ):
            raise ValueError("scanned_file_count must be a nonnegative integer")
        if self.scanned_file_count != len(self.candidates) + len(self.observations):
            raise ValueError("discovery terminal outcomes must reconcile")

    def counts(self) -> dict[str, int]:
        observed = Counter(item.kind.value for item in self.observations)
        return {
            "candidate": len(self.candidates),
            "duplicate_inode": observed[DiscoveryKind.DUPLICATE_INODE.value],
            "excluded_invalid_layout": observed[
                DiscoveryKind.EXCLUDED_INVALID_LAYOUT.value
            ],
            "excluded_non_jsonl": observed[DiscoveryKind.EXCLUDED_NON_JSONL.value],
            "source_raced": observed[DiscoveryKind.SOURCE_RACED.value],
        }


def _source_key(host_id: str, harness: Harness, relative: str) -> str:
    try:
        preimage = _SOURCE_KEY_DOMAIN
        for value in (host_id, harness.value, relative):
            encoded = value.encode("utf-8", errors="strict")
            preimage += len(encoded).to_bytes(4, "big", signed=False) + encoded
    except (UnicodeError, OverflowError) as error:
        raise QseshError("QS-E-SOURCE-READ", phase="source-key") from error
    return "sk-" + hashlib.blake2b(preimage, digest_size=32).hexdigest()


def _disappeared(error: QseshError) -> bool:
    cause = error.__cause__
    return isinstance(cause, (FileNotFoundError, NotADirectoryError))


class JsonlSourceAdapter:
    """Discover stable candidate identities without opening session contents."""

    def __init__(
        self,
        *,
        host_id: str,
        harness: Harness,
        root: Path,
        source_fs: SourceFS,
        live_window_us: int = _LIVE_WINDOW_US,
    ) -> None:
        if not isinstance(host_id, str) or _HOST_ID(host_id) is None:
            raise QseshError("QS-E-BOUNDARY", phase="jsonl-host")
        if harness not in {Harness.CLAUDE, Harness.CODEX}:
            raise QseshError("QS-E-BOUNDARY", phase="jsonl-harness")
        candidate_root = Path(root)
        if not candidate_root.is_absolute() or ".." in candidate_root.parts:
            raise QseshError("QS-E-BOUNDARY", phase="jsonl-root")
        if (
            isinstance(live_window_us, bool)
            or not isinstance(live_window_us, int)
            or live_window_us <= 0
        ):
            raise QseshError("QS-E-BOUNDARY", phase="snapshot-live-window")
        self.host_id = host_id
        self.harness = harness
        self.root = candidate_root.resolve(strict=False)
        self.source_fs = source_fs
        self.live_window_us = live_window_us
        self._accepted_paths: dict[str, tuple[SourceCandidate, Path]] = {}

    def discover(self) -> DiscoveryResult:
        paths = tuple(sorted(self.source_fs.iter_files(self.root), key=self._path_key))
        observations: list[DiscoveryObservation] = []
        candidates: list[SourceCandidate] = []
        seen_inodes: set[tuple[int, int]] = set()
        accepted_paths: dict[str, tuple[SourceCandidate, Path]] = {}

        for path in paths:
            relative = self._relative(path)
            source_key = _source_key(self.host_id, self.harness, relative.as_posix())
            if path.suffix != ".jsonl":
                observations.append(
                    DiscoveryObservation(
                        kind=DiscoveryKind.EXCLUDED_NON_JSONL,
                        source_key=source_key,
                    )
                )
                continue
            native_id = self._native_id(relative)
            if native_id is None:
                observations.append(
                    DiscoveryObservation(
                        kind=DiscoveryKind.EXCLUDED_INVALID_LAYOUT,
                        source_key=source_key,
                    )
                )
                continue
            stamps = self._stable_discovery_stamps(path)
            if stamps is None:
                observations.append(
                    DiscoveryObservation(
                        kind=DiscoveryKind.SOURCE_RACED,
                        source_key=source_key,
                    )
                )
                continue
            before, after = stamps
            if before != after:
                observations.append(
                    DiscoveryObservation(
                        kind=DiscoveryKind.SOURCE_RACED,
                        source_key=source_key,
                    )
                )
                continue
            inode_key = (after.device, after.inode)
            if inode_key in seen_inodes:
                observations.append(
                    DiscoveryObservation(
                        kind=DiscoveryKind.DUPLICATE_INODE,
                        source_key=source_key,
                    )
                )
                continue
            seen_inodes.add(inode_key)
            candidate = SourceCandidate(
                host_id=self.host_id,
                harness=self.harness,
                native_id=native_id,
                source_key=source_key,
                updated_at_us=after.mtime_ns // 1000,
                file_stamp=after,
            )
            candidates.append(candidate)
            accepted_paths[source_key] = (candidate, path)

        candidates.sort(
            key=lambda candidate: (candidate.native_id, candidate.source_key)
        )
        observations.sort(key=lambda item: (item.kind.value, item.source_key))
        self._accepted_paths = accepted_paths
        return DiscoveryResult(
            candidates=tuple(candidates),
            observations=tuple(observations),
            scanned_file_count=len(paths),
        )

    def path_for(self, candidate: SourceCandidate) -> Path:
        accepted = self._accepted_paths.get(candidate.source_key)
        if accepted is None or accepted[0] != candidate:
            raise QseshError("QS-E-BOUNDARY", phase="source-candidate-map")
        return accepted[1]

    def snapshot(
        self,
        candidate: SourceCandidate,
        *,
        now_us: int,
    ) -> SourceSnapshot | SnapshotObservation:
        if isinstance(now_us, bool) or not isinstance(now_us, int) or now_us < 0:
            raise QseshError("QS-E-BOUNDARY", phase="snapshot-clock")
        path = self.path_for(candidate)
        if now_us - candidate.updated_at_us <= self.live_window_us:
            return SnapshotObservation(
                candidate=candidate,
                kind=SnapshotKind.SKIPPED_LIVE,
            )
        expected = candidate.file_stamp
        if expected is None or expected.size == 0:
            return self._raced(candidate)
        try:
            source_read = self.source_fs.read_bytes(path, max_bytes=expected.size)
        except QseshError as error:
            if _disappeared(error) or error.phase == "source-read-cap":
                return self._raced(candidate)
            raise
        if (
            source_read.before != expected
            or source_read.after != expected
            or len(source_read.raw_bytes) != expected.size
            or not source_read.raw_bytes.endswith(b"\n")
        ):
            return self._raced(candidate)
        return SourceSnapshot(
            candidate=candidate,
            raw_bytes=source_read.raw_bytes,
            source_digest=hashlib.blake2b(
                source_read.raw_bytes,
                digest_size=32,
            ).hexdigest(),
            schema_fingerprint=_UNCLASSIFIED_SCHEMA_FINGERPRINT,
            harness_version=None,
        )

    @staticmethod
    def _raced(candidate: SourceCandidate) -> SnapshotObservation:
        return SnapshotObservation(
            candidate=candidate,
            kind=SnapshotKind.SOURCE_RACED,
        )

    def _relative(self, path: Path) -> Path:
        candidate = Path(path)
        try:
            return candidate.relative_to(self.root)
        except ValueError as error:
            raise QseshError("QS-E-BOUNDARY", phase="source-discovery-root") from error

    def _native_id(self, relative: Path) -> str | None:
        if self.harness is Harness.CLAUDE:
            if len(relative.parts) != 2:
                return None
            stem = relative.stem
            return stem if _CLAUDE_NATIVE_ID(stem) is not None else None
        if len(relative.parts) != 4:
            return None
        year, month, day, _filename = relative.parts
        match = _CODEX_FILENAME(relative.stem)
        if match is None:
            return None
        timestamp = match.group("timestamp")
        if (year, month, day) != tuple(timestamp[:10].split("-")):
            return None
        try:
            datetime.strptime(timestamp, "%Y-%m-%dT%H-%M-%S")
        except ValueError:
            return None
        return match.group("native_id")

    def _stable_discovery_stamps(
        self, path: Path
    ) -> tuple[FileStamp, FileStamp] | None:
        try:
            before = self.source_fs.stat(path)
            after = self.source_fs.stat(path)
        except QseshError as error:
            if _disappeared(error):
                return None
            raise
        return before, after

    def _path_key(self, path: Path) -> str:
        return self._relative(path).as_posix()
