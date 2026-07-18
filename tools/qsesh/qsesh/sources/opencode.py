"""Verified opaque-copy source adapter for the pinned OpenCode CLI."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat as stat_module
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Protocol, Self

from qsesh.errors import QseshError
from qsesh.jsonio import dump_jsonl
from qsesh.model import (
    FileStamp,
    Harness,
    JsonValue,
    SourceCandidate,
    SourceSnapshot,
    validate_json_value,
)
from qsesh.sources.base import CommandResult, CommandRunner, OpenCodeCommandRunner

DB_MAX_BYTES = 8 * 1024**3
WAL_MAX_BYTES = 2 * 1024**3
COPY_CHUNK_BYTES = 65_536
CHECKPOINT_HEADROOM_BYTES = 67_108_864
LIST_TIMEOUT_S = 30
EXPORT_TIMEOUT_S = 60
OUTPUT_LIMIT_BYTES = 256 * 1024**2
OPEN_CODE_VERSION = "1.17.15"
LIVE_WINDOW_US = 600_000_000

_DB_NAME = "opencode.db"
_WAL_NAME = _DB_NAME + "-wal"
_SHM_NAME = _DB_NAME + "-shm"
_RUNTIME_DIRECTORIES = ("home", "xdg-data", "xdg-config", "xdg-cache", "tmp")
_LIST_REQUIRED_KEYS = frozenset({"created", "id", "updated"})
_LIST_OPTIONAL_KEYS = frozenset({"directory", "project", "title"})
_LIST_KEYS = _LIST_REQUIRED_KEYS | _LIST_OPTIONAL_KEYS
_SESSION_ID = re.compile(r"ses_[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
_MAX_EPOCH_MS = 253_402_300_799_999

type PhaseHook = Callable[[str], None]
type FreeSpaceProbe = Callable[[Path], int]
type CleanupTree = Callable[[Path], None]


class RunnerFactory(Protocol):
    def __call__(
        self,
        executable: Path,
        *,
        private_workspace: Path,
        copied_db: Path,
        protected_roots: tuple[Path, ...],
    ) -> CommandRunner: ...


@dataclass(frozen=True, slots=True)
class CopyMemberProof:
    name: str
    byte_count: int
    copy_digest: str
    live_digest: str
    before: FileStamp
    copy_post: FileStamp
    final: FileStamp


@dataclass(frozen=True, slots=True)
class CopyProof:
    members: tuple[CopyMemberProof, ...]
    admission_bytes: int
    shm_present: bool

    @property
    def member_names(self) -> tuple[str, ...]:
        return tuple(member.name for member in self.members)


@dataclass(frozen=True, slots=True)
class ResidueInventory:
    files: tuple[dict[str, JsonValue], ...]
    owner_prune_only: bool = True

    def as_safe_dict(self) -> dict[str, JsonValue]:
        return {
            "files": [dict(item) for item in self.files],
            "owner_prune_only": self.owner_prune_only,
            "workspace_alias": "opencode-attempt-residue",
        }


@dataclass(frozen=True, slots=True)
class OpenCodeDiscovery:
    candidates: tuple[SourceCandidate, ...]
    metadata: tuple["OpenCodeListMetadata", ...]


@dataclass(frozen=True, slots=True)
class OpenCodeListMetadata:
    created_at_us: int
    directory: str | None
    project: str | None
    title: str | None


class OpenCodeSnapshotKind(StrEnum):
    SKIPPED_LIVE = "skipped_live"
    SOURCE_RACED = "source_raced"


@dataclass(frozen=True, slots=True)
class OpenCodeSnapshotObservation:
    candidate: SourceCandidate
    kind: OpenCodeSnapshotKind


@dataclass(frozen=True, slots=True)
class _SourceSet:
    members: tuple[tuple[str, FileStamp], ...]
    shm_stamp: FileStamp | None


def _stamp(metadata: os.stat_result) -> FileStamp:
    return FileStamp(
        device=metadata.st_dev,
        inode=metadata.st_ino,
        size=metadata.st_size,
        mtime_ns=metadata.st_mtime_ns,
        ctime_ns=metadata.st_ctime_ns,
    )


def _identity(metadata: os.stat_result) -> tuple[int, int]:
    return metadata.st_dev, metadata.st_ino


def _beneath(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _default_free_space(path: Path) -> int:
    return shutil.disk_usage(path).free


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_nonfinite(value: str) -> None:
    raise ValueError(f"non-finite JSON number: {value}")


def _load_json(raw: bytes, *, code: str, phase: str) -> object:
    try:
        value = json.loads(
            raw,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_nonfinite,
        )
        validate_json_value(value)
    except (UnicodeError, json.JSONDecodeError, TypeError, ValueError) as error:
        raise QseshError(code, phase=phase) from error
    return value


class OpenCodeAttempt:
    """Own one verified live-byte copy and its confined command runner."""

    def __init__(
        self,
        *,
        live_db: Path,
        temporary_root: Path,
        executable: Path,
        runner_factory: RunnerFactory = OpenCodeCommandRunner,
        phase_hook: PhaseHook | None = None,
        free_space: FreeSpaceProbe = _default_free_space,
        cleanup_tree: CleanupTree | None = None,
    ) -> None:
        self.live_db = Path(live_db)
        self.temporary_root = Path(temporary_root)
        self.executable = Path(executable)
        self._runner_factory = runner_factory
        self._phase_hook = phase_hook or (lambda _phase: None)
        self._free_space = free_space
        self._cleanup_tree = shutil.rmtree if cleanup_tree is None else cleanup_tree
        self._workspace: Path | None = None
        self._workspace_identity: tuple[int, int] | None = None
        self._source_directory: int | None = None
        self._source_directory_identity: tuple[int, int] | None = None
        self._descriptors: dict[str, int] = {}
        self._copy_proof: CopyProof | None = None
        self._runner: CommandRunner | None = None
        self.residue: ResidueInventory | None = None
        self._entered = False

    @property
    def workspace(self) -> Path:
        if self._workspace is None:
            return self.temporary_root / ".opencode-attempt-not-created"
        return self._workspace

    @property
    def copy_proof(self) -> CopyProof:
        if self._copy_proof is None:
            raise QseshError("QS-E-BOUNDARY", phase="opencode-attempt-state")
        return self._copy_proof

    @property
    def runner(self) -> CommandRunner:
        if self._runner is None:
            raise QseshError("QS-E-BOUNDARY", phase="opencode-attempt-state")
        return self._runner

    def __enter__(self) -> Self:
        if self._entered:
            raise QseshError("QS-E-BOUNDARY", phase="opencode-attempt-state")
        self._entered = True
        try:
            self._admit()
        except BaseException:
            self._close_source_descriptors()
            self._cleanup_after_failure()
            raise
        return self

    def __exit__(self, error_type: object, error: object, traceback: object) -> bool:
        self._close_source_descriptors()
        cleanup_error = self._cleanup_workspace()
        if cleanup_error is not None:
            raise QseshError(
                "QS-E-ROLLBACK", phase="opencode-cleanup"
            ) from cleanup_error
        return False

    def _admit(self) -> None:
        self._validate_inputs()
        directory_flags = (
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            self._source_directory = os.open(self.live_db.parent, directory_flags)
            directory_metadata = os.fstat(self._source_directory)
        except OSError as error:
            raise QseshError("QS-E-SOURCE-READ", phase="opencode-source-set") from error
        if not stat_module.S_ISDIR(directory_metadata.st_mode):
            raise QseshError("QS-E-BOUNDARY", phase="opencode-source-member")
        self._source_directory_identity = _identity(directory_metadata)

        observed = self._observe_source_set()
        self._phase_hook("source-set-observed")
        if self._observe_source_set() != observed:
            self._raced()
        self._phase_hook("before-source-open")
        self._open_members(observed)
        self._phase_hook("source-descriptors-opened")
        self._validate_caps(observed)

        db_size = dict(observed.members)[_DB_NAME].size
        wal_size = dict(observed.members).get(_WAL_NAME, FileStamp(0, 0, 0, 0, 0)).size
        admission_bytes = db_size + wal_size + max(wal_size, CHECKPOINT_HEADROOM_BYTES)
        try:
            free_bytes = self._free_space(self.temporary_root)
        except OSError as error:
            raise QseshError("QS-E-BOUNDARY", phase="opencode-free-space") from error
        if (
            isinstance(free_bytes, bool)
            or not isinstance(free_bytes, int)
            or free_bytes < admission_bytes
        ):
            raise QseshError("QS-E-BOUNDARY", phase="opencode-free-space")

        self._create_workspace()
        copied: dict[str, tuple[int, str, FileStamp, FileStamp]] = {}
        for name, _before in observed.members:
            self._phase_hook(f"before-{self._member_label(name)}-copy")
            copied[name] = self._copy_member(name)
            self._phase_hook(f"{self._member_label(name)}-copy-complete")
        self._fsync_directory(self.workspace / "store")
        self._fsync_directory(self.workspace)

        self._verify_source_state(observed)
        live_digests: dict[str, str] = {}
        rehash_stamps: dict[str, FileStamp] = {}
        for name, before in observed.members:
            live_digest, byte_count, after = self._rehash_descriptor(name)
            if (
                byte_count != before.size
                or after != before
                or live_digest != copied[name][1]
            ):
                self._raced()
            live_digests[name] = live_digest
            rehash_stamps[name] = after
        self._verify_source_state(observed)
        self._phase_hook("before-cli-admission")
        self._verify_source_state(observed)
        self._verify_copies(observed, copied)

        proofs: list[CopyMemberProof] = []
        for name, before in observed.members:
            byte_count, copied_digest, copy_post, _destination_stamp = copied[name]
            proofs.append(
                CopyMemberProof(
                    name=name,
                    byte_count=byte_count,
                    copy_digest=copied_digest,
                    live_digest=live_digests[name],
                    before=before,
                    copy_post=copy_post,
                    final=rehash_stamps[name],
                )
            )
        self._copy_proof = CopyProof(
            members=tuple(proofs),
            admission_bytes=admission_bytes,
            shm_present=observed.shm_stamp is not None,
        )
        self._runner = self._runner_factory(
            self.executable,
            private_workspace=self.workspace,
            copied_db=self.workspace / "store" / _DB_NAME,
            protected_roots=(self.live_db.parent,),
        )

    def _validate_inputs(self) -> None:
        for path, phase in (
            (self.live_db, "opencode-source-set"),
            (self.temporary_root, "opencode-private-workspace"),
            (self.executable, "opencode-executable"),
        ):
            if not path.is_absolute() or ".." in path.parts:
                raise QseshError("QS-E-BOUNDARY", phase=phase)
        if self.live_db.name != _DB_NAME:
            raise QseshError("QS-E-BOUNDARY", phase="opencode-source-set")
        try:
            temp_metadata = self.temporary_root.lstat()
            temp_resolved = self.temporary_root.resolve(strict=True)
        except OSError as error:
            raise QseshError(
                "QS-E-BOUNDARY", phase="opencode-private-workspace"
            ) from error
        if (
            temp_resolved != self.temporary_root
            or not stat_module.S_ISDIR(temp_metadata.st_mode)
            or stat_module.S_IMODE(temp_metadata.st_mode) != 0o700
        ):
            raise QseshError("QS-E-BOUNDARY", phase="opencode-private-workspace")

    def _observe_source_set(self) -> _SourceSet:
        if self._source_directory is None:
            raise QseshError("QS-E-BOUNDARY", phase="opencode-attempt-state")
        members: list[tuple[str, FileStamp]] = []
        for name, required in ((_DB_NAME, True), (_WAL_NAME, False)):
            try:
                metadata = os.stat(
                    name,
                    dir_fd=self._source_directory,
                    follow_symlinks=False,
                )
            except FileNotFoundError:
                if required:
                    raise QseshError("QS-E-SOURCE-READ", phase="opencode-source-set")
                continue
            except OSError as error:
                raise QseshError(
                    "QS-E-SOURCE-READ", phase="opencode-source-set"
                ) from error
            if not stat_module.S_ISREG(metadata.st_mode):
                raise QseshError("QS-E-BOUNDARY", phase="opencode-source-member")
            members.append((name, _stamp(metadata)))
        try:
            shm_metadata = os.stat(
                _SHM_NAME,
                dir_fd=self._source_directory,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            shm_stamp = None
        except OSError as error:
            raise QseshError("QS-E-SOURCE-READ", phase="opencode-source-set") from error
        else:
            if not stat_module.S_ISREG(shm_metadata.st_mode):
                raise QseshError("QS-E-BOUNDARY", phase="opencode-source-member")
            shm_stamp = _stamp(shm_metadata)
        return _SourceSet(tuple(members), shm_stamp)

    def _open_members(self, observed: _SourceSet) -> None:
        if self._source_directory is None:
            raise QseshError("QS-E-BOUNDARY", phase="opencode-attempt-state")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        for name, expected in observed.members:
            try:
                descriptor = os.open(name, flags, dir_fd=self._source_directory)
                metadata = os.fstat(descriptor)
            except OSError as error:
                self._raced(error)
            if (
                not stat_module.S_ISREG(metadata.st_mode)
                or _stamp(metadata) != expected
            ):
                os.close(descriptor)
                self._raced()
            self._descriptors[name] = descriptor

    @staticmethod
    def _validate_caps(observed: _SourceSet) -> None:
        sizes = dict(observed.members)
        if sizes[_DB_NAME].size > DB_MAX_BYTES:
            raise QseshError("QS-E-BOUNDARY", phase="opencode-source-cap")
        if _WAL_NAME in sizes and sizes[_WAL_NAME].size > WAL_MAX_BYTES:
            raise QseshError("QS-E-BOUNDARY", phase="opencode-source-cap")

    def _create_workspace(self) -> None:
        try:
            workspace = Path(
                tempfile.mkdtemp(prefix="opencode-attempt-", dir=self.temporary_root)
            )
            os.chmod(workspace, 0o700)
            for name in (*_RUNTIME_DIRECTORIES, "store"):
                directory = workspace / name
                directory.mkdir(mode=0o700)
                directory.chmod(0o700)
            metadata = workspace.lstat()
        except OSError as error:
            raise QseshError(
                "QS-E-BOUNDARY", phase="opencode-private-workspace"
            ) from error
        self._workspace = workspace
        self._workspace_identity = _identity(metadata)

    def _copy_member(self, name: str) -> tuple[int, str, FileStamp, FileStamp]:
        source = self._descriptors[name]
        destination = self.workspace / "store" / name
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            output = os.open(destination, flags, 0o600)
            os.fchmod(output, 0o600)
            os.lseek(source, 0, os.SEEK_SET)
            digest = hashlib.blake2b(digest_size=32)
            byte_count = 0
            while True:
                chunk = os.read(source, COPY_CHUNK_BYTES)
                if not chunk:
                    break
                self._phase_hook(f"{self._member_label(name)}-copy-chunk")
                view = memoryview(chunk)
                while view:
                    view = view[os.write(output, view) :]
                digest.update(chunk)
                byte_count += len(chunk)
            os.fsync(output)
            destination_metadata = os.fstat(output)
            source_post = _stamp(os.fstat(source))
        except OSError as error:
            raise QseshError("QS-E-SOURCE-READ", phase="opencode-copy") from error
        finally:
            if "output" in locals():
                os.close(output)
        if (
            not stat_module.S_ISREG(destination_metadata.st_mode)
            or stat_module.S_IMODE(destination_metadata.st_mode) != 0o600
            or destination_metadata.st_size != byte_count
        ):
            raise QseshError("QS-E-BOUNDARY", phase="opencode-copy")
        return byte_count, digest.hexdigest(), source_post, _stamp(destination_metadata)

    def _rehash_descriptor(self, name: str) -> tuple[str, int, FileStamp]:
        descriptor = self._descriptors[name]
        try:
            os.lseek(descriptor, 0, os.SEEK_SET)
            digest = hashlib.blake2b(digest_size=32)
            byte_count = 0
            while True:
                chunk = os.read(descriptor, COPY_CHUNK_BYTES)
                if not chunk:
                    break
                self._phase_hook(f"{self._member_label(name)}-rehash-chunk")
                digest.update(chunk)
                byte_count += len(chunk)
            after = _stamp(os.fstat(descriptor))
        except OSError as error:
            self._raced(error)
        return digest.hexdigest(), byte_count, after

    def _verify_source_state(self, observed: _SourceSet) -> None:
        if self._source_directory is None or self._source_directory_identity is None:
            raise QseshError("QS-E-BOUNDARY", phase="opencode-attempt-state")
        if (
            _identity(os.fstat(self._source_directory))
            != self._source_directory_identity
        ):
            self._raced()
        try:
            parent_metadata = self.live_db.parent.lstat()
        except OSError as error:
            self._raced(error)
        if _identity(parent_metadata) != self._source_directory_identity:
            self._raced()
        if self._observe_source_set() != observed:
            self._raced()
        expected = dict(observed.members)
        for name, descriptor in self._descriptors.items():
            if _stamp(os.fstat(descriptor)) != expected[name]:
                self._raced()

    def _verify_copies(
        self,
        observed: _SourceSet,
        copied: dict[str, tuple[int, str, FileStamp, FileStamp]],
    ) -> None:
        for name, before in observed.members:
            path = self.workspace / "store" / name
            flags = (
                os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
            )
            try:
                descriptor = os.open(path, flags)
                metadata = os.fstat(descriptor)
                digest = hashlib.blake2b(digest_size=32)
                count = 0
                while True:
                    chunk = os.read(descriptor, COPY_CHUNK_BYTES)
                    if not chunk:
                        break
                    digest.update(chunk)
                    count += len(chunk)
            except OSError as error:
                raise QseshError(
                    "QS-E-BOUNDARY", phase="opencode-copy-verify"
                ) from error
            finally:
                if "descriptor" in locals():
                    os.close(descriptor)
                    del descriptor
            if (
                not stat_module.S_ISREG(metadata.st_mode)
                or stat_module.S_IMODE(metadata.st_mode) != 0o600
                or _stamp(metadata) != copied[name][3]
                or count != before.size
                or count != copied[name][0]
                or digest.hexdigest() != copied[name][1]
            ):
                raise QseshError("QS-E-BOUNDARY", phase="opencode-copy-verify")

    def _close_source_descriptors(self) -> None:
        for descriptor in self._descriptors.values():
            try:
                os.close(descriptor)
            except OSError:
                pass
        self._descriptors.clear()
        if self._source_directory is not None:
            try:
                os.close(self._source_directory)
            except OSError:
                pass
            self._source_directory = None

    def _cleanup_after_failure(self) -> None:
        cleanup_error = self._cleanup_workspace()
        if cleanup_error is not None:
            raise QseshError(
                "QS-E-ROLLBACK", phase="opencode-cleanup"
            ) from cleanup_error

    def _cleanup_workspace(self) -> OSError | None:
        if self._workspace is None or not self._workspace.exists():
            return None
        try:
            metadata = self._workspace.lstat()
            resolved = self._workspace.resolve(strict=True)
            if (
                self._workspace_identity is None
                or _identity(metadata) != self._workspace_identity
                or resolved != self._workspace
                or not _beneath(self._workspace, self.temporary_root)
            ):
                raise OSError("workspace ownership changed")
        except OSError as error:
            self.residue = ResidueInventory(files=())
            return error
        try:
            self._cleanup_tree(self._workspace)
            return None
        except OSError as error:
            self.residue = self._inventory_residue()
            return error

    def _inventory_residue(self) -> ResidueInventory:
        files: list[dict[str, JsonValue]] = []
        now_ns = time.time_ns()
        file_index = 0
        for directory, directory_names, file_names in os.walk(
            self.workspace, followlinks=False
        ):
            directory_names.sort()
            file_names.sort()
            directory_path = Path(directory)
            try:
                os.chmod(directory_path, 0o700, follow_symlinks=False)
            except OSError:
                pass
            for file_name in file_names:
                file_index += 1
                path = directory_path / file_name
                path_alias = f"residue-file-{file_index:04d}"
                try:
                    metadata = path.lstat()
                    if not stat_module.S_ISREG(metadata.st_mode):
                        files.append({"path_alias": path_alias, "type": "nonregular"})
                        continue
                    os.chmod(path, 0o600, follow_symlinks=False)
                    digest = hashlib.sha256()
                    byte_count = 0
                    with path.open("rb") as handle:
                        while True:
                            chunk = handle.read(COPY_CHUNK_BYTES)
                            if not chunk:
                                break
                            digest.update(chunk)
                            byte_count += len(chunk)
                    files.append(
                        {
                            "age_seconds": max(
                                0, (now_ns - metadata.st_mtime_ns) // 1_000_000_000
                            ),
                            "bytes": byte_count,
                            "path_alias": path_alias,
                            "sha256": digest.hexdigest(),
                            "type": "file",
                        }
                    )
                except OSError:
                    files.append({"path_alias": path_alias, "type": "unreadable"})
        return ResidueInventory(files=tuple(files))

    @staticmethod
    def _member_label(name: str) -> str:
        return "db" if name == _DB_NAME else "wal"

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        flags = (
            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0)
        )
        try:
            descriptor = os.open(path, flags)
            os.fsync(descriptor)
        except OSError as error:
            raise QseshError("QS-E-SOURCE-READ", phase="opencode-copy-fsync") from error
        finally:
            if "descriptor" in locals():
                os.close(descriptor)

    @staticmethod
    def _raced(cause: BaseException | None = None) -> None:
        error = QseshError("QS-E-SOURCE-READ", phase="opencode-source-raced")
        if cause is None:
            raise error
        raise error from cause


class OpenCodeSourceAdapter:
    """Discover and export OpenCode sessions only through one admitted copy."""

    def __init__(
        self,
        *,
        host_id: str,
        live_db: Path,
        temporary_root: Path,
        executable: Path,
        runner_factory: RunnerFactory = OpenCodeCommandRunner,
        phase_hook: PhaseHook | None = None,
        free_space: FreeSpaceProbe = _default_free_space,
        cleanup_tree: CleanupTree | None = None,
        live_window_us: int = LIVE_WINDOW_US,
    ) -> None:
        if not isinstance(host_id, str) or not host_id:
            raise QseshError("QS-E-BOUNDARY", phase="opencode-host")
        if (
            isinstance(live_window_us, bool)
            or not isinstance(live_window_us, int)
            or live_window_us <= 0
        ):
            raise QseshError("QS-E-BOUNDARY", phase="opencode-live-window")
        self.host_id = host_id
        self.live_window_us = live_window_us
        self.attempt = OpenCodeAttempt(
            live_db=live_db,
            temporary_root=temporary_root,
            executable=executable,
            runner_factory=runner_factory,
            phase_hook=phase_hook,
            free_space=free_space,
            cleanup_tree=cleanup_tree,
        )
        self._entered = False
        self._accepted: dict[str, SourceCandidate] = {}

    def __enter__(self) -> Self:
        self.attempt.__enter__()
        try:
            result = self.attempt.runner.run(
                (str(self.attempt.executable.resolve()), "--pure", "--version"),
                timeout_s=LIST_TIMEOUT_S,
                stdout_limit=OUTPUT_LIMIT_BYTES,
            )
            if (
                result.exit_code != 0
                or result.stderr != b""
                or result.stdout != (OPEN_CODE_VERSION + "\n").encode()
            ):
                raise QseshError("QS-E-SOURCE-VERSION", phase="opencode-version")
        except BaseException:
            import sys

            self.attempt.__exit__(*sys.exc_info())
            raise
        self._entered = True
        return self

    def __exit__(self, error_type: object, error: object, traceback: object) -> bool:
        self._entered = False
        return self.attempt.__exit__(error_type, error, traceback)

    @property
    def copy_proof(self) -> CopyProof:
        return self.attempt.copy_proof

    def discover(self) -> OpenCodeDiscovery:
        self._require_entered()
        rows = sorted(self._run_list(), key=lambda row: (row["updated"], row["id"]))
        candidates: list[SourceCandidate] = []
        metadata: list[OpenCodeListMetadata] = []
        accepted: dict[str, SourceCandidate] = {}
        for row in rows:
            candidate = SourceCandidate(
                host_id=self.host_id,
                harness=Harness.OPENCODE,
                native_id=row["id"],
                source_key="opencode-cli-v1",
                updated_at_us=row["updated"] * 1_000,
                file_stamp=None,
            )
            candidates.append(candidate)
            metadata.append(
                OpenCodeListMetadata(
                    created_at_us=row["created"] * 1_000,
                    directory=row.get("directory"),
                    project=row.get("project"),
                    title=row.get("title"),
                )
            )
            accepted[candidate.native_id] = candidate
        self._accepted = accepted
        return OpenCodeDiscovery(tuple(candidates), tuple(metadata))

    def snapshot(
        self, candidate: SourceCandidate, *, now_us: int
    ) -> SourceSnapshot | OpenCodeSnapshotObservation:
        self._require_entered()
        if (
            not isinstance(candidate, SourceCandidate)
            or self._accepted.get(candidate.native_id) is not candidate
        ):
            raise QseshError("QS-E-BOUNDARY", phase="opencode-candidate")
        if isinstance(now_us, bool) or not isinstance(now_us, int) or now_us < 0:
            raise QseshError("QS-E-BOUNDARY", phase="opencode-now")
        if now_us <= candidate.updated_at_us + self.live_window_us:
            return OpenCodeSnapshotObservation(
                candidate=candidate,
                kind=OpenCodeSnapshotKind.SKIPPED_LIVE,
            )

        executable = str(self.attempt.executable.resolve())
        export_result = self.attempt.runner.run(
            (executable, "--pure", "export", candidate.native_id),
            timeout_s=EXPORT_TIMEOUT_S,
            stdout_limit=OUTPUT_LIMIT_BYTES,
        )
        self._require_command_success(
            export_result,
            code="QS-E-OPENCODE-EXPORT",
            phase="opencode-export-command",
        )
        raw_bytes = self._canonicalize_export(export_result.stdout, candidate)
        after_rows = self._run_list()
        after = next(
            (row for row in after_rows if row["id"] == candidate.native_id),
            None,
        )
        if after is None or after["updated"] * 1_000 != candidate.updated_at_us:
            return OpenCodeSnapshotObservation(
                candidate=candidate,
                kind=OpenCodeSnapshotKind.SOURCE_RACED,
            )
        return SourceSnapshot(
            candidate=candidate,
            raw_bytes=raw_bytes,
            source_digest=hashlib.blake2b(raw_bytes, digest_size=32).hexdigest(),
            schema_fingerprint="opencode-export-jsonl-v1",
            harness_version=OPEN_CODE_VERSION,
        )

    def _run_list(self) -> list[dict[str, object]]:
        executable = str(self.attempt.executable.resolve())
        result = self.attempt.runner.run(
            (executable, "--pure", "session", "list", "--format", "json"),
            timeout_s=LIST_TIMEOUT_S,
            stdout_limit=OUTPUT_LIMIT_BYTES,
        )
        self._require_command_success(
            result,
            code="QS-E-OPENCODE-LIST",
            phase="opencode-list-command",
        )
        value = _load_json(
            result.stdout,
            code="QS-E-OPENCODE-LIST",
            phase="opencode-list-schema",
        )
        if not isinstance(value, list):
            raise QseshError("QS-E-OPENCODE-LIST", phase="opencode-list-schema")
        rows: list[dict[str, object]] = []
        seen: set[str] = set()
        for item in value:
            if (
                not isinstance(item, dict)
                or not _LIST_REQUIRED_KEYS <= set(item) <= _LIST_KEYS
            ):
                raise QseshError("QS-E-OPENCODE-LIST", phase="opencode-list-schema")
            if not isinstance(item["id"], str) or any(
                not isinstance(item[key], str)
                for key in _LIST_OPTIONAL_KEYS & set(item)
            ):
                raise QseshError("QS-E-OPENCODE-LIST", phase="opencode-list-schema")
            for key in ("created", "updated"):
                field = item[key]
                if (
                    isinstance(field, bool)
                    or not isinstance(field, int)
                    or not 0 <= field <= _MAX_EPOCH_MS
                ):
                    raise QseshError("QS-E-OPENCODE-LIST", phase="opencode-list-schema")
            native_id = item["id"]
            if _SESSION_ID.fullmatch(native_id) is None:
                raise QseshError("QS-E-OPENCODE-LIST", phase="opencode-list-schema")
            if native_id in seen:
                raise QseshError("QS-E-OPENCODE-LIST", phase="opencode-list-duplicate")
            seen.add(native_id)
            rows.append(item)
        return rows

    @staticmethod
    def _canonicalize_export(raw: bytes, candidate: SourceCandidate) -> bytes:
        value = _load_json(
            raw,
            code="QS-E-OPENCODE-EXPORT",
            phase="opencode-export-schema",
        )
        if not isinstance(value, dict) or set(value) != {"info", "messages"}:
            raise QseshError("QS-E-OPENCODE-EXPORT", phase="opencode-export-schema")
        info = value["info"]
        messages = value["messages"]
        if not isinstance(info, dict) or not isinstance(messages, list):
            raise QseshError("QS-E-OPENCODE-EXPORT", phase="opencode-export-schema")
        time_value = info.get("time")
        if (
            info.get("id") != candidate.native_id
            or info.get("version") != OPEN_CODE_VERSION
            or not isinstance(time_value, dict)
            or time_value.get("updated") != candidate.updated_at_us // 1_000
        ):
            raise QseshError("QS-E-OPENCODE-EXPORT", phase="opencode-export-schema")
        rows: list[dict[str, JsonValue]] = [
            {"kind": "session", "schema_version": 1, "value": info}
        ]
        for message_index, message in enumerate(messages):
            if not isinstance(message, dict) or set(message) != {"info", "parts"}:
                raise QseshError("QS-E-OPENCODE-EXPORT", phase="opencode-export-schema")
            message_info = message["info"]
            parts = message["parts"]
            if not isinstance(message_info, dict) or not isinstance(parts, list):
                raise QseshError("QS-E-OPENCODE-EXPORT", phase="opencode-export-schema")
            rows.append(
                {
                    "kind": "message",
                    "message_index": message_index,
                    "schema_version": 1,
                    "value": message_info,
                }
            )
            for part_index, part in enumerate(parts):
                if not isinstance(part, dict):
                    raise QseshError(
                        "QS-E-OPENCODE-EXPORT", phase="opencode-export-schema"
                    )
                rows.append(
                    {
                        "kind": "part",
                        "message_index": message_index,
                        "part_index": part_index,
                        "schema_version": 1,
                        "value": part,
                    }
                )
        return dump_jsonl(rows)

    @staticmethod
    def _require_command_success(
        result: CommandResult, *, code: str, phase: str
    ) -> None:
        if result.exit_code != 0 or result.stderr != b"":
            raise QseshError(code, phase=phase)

    def _require_entered(self) -> None:
        if not self._entered:
            raise QseshError("QS-E-BOUNDARY", phase="opencode-attempt-state")
