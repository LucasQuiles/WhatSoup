"""Fail-closed filesystem and subprocess adapters for session sources."""

from __future__ import annotations

import math
import os
import re
import selectors
import signal
import stat as stat_module
import subprocess
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from qsesh.errors import QseshError
from qsesh.model import FileStamp

_SESSION_ID = re.compile(r"ses_[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
_MAX_LIST_ROWS = 1000
_RUNTIME_DIRECTORIES = (
    "home",
    "xdg-data",
    "xdg-config",
    "xdg-cache",
    "tmp",
)


@dataclass(frozen=True, slots=True)
class SourceRead:
    raw_bytes: bytes
    before: FileStamp
    after: FileStamp


@dataclass(frozen=True, slots=True)
class CommandResult:
    stdout: bytes
    stderr: bytes
    exit_code: int
    duration_ns: int
    truncated: bool

    def __post_init__(self) -> None:
        if not isinstance(self.stdout, bytes) or not isinstance(self.stderr, bytes):
            raise TypeError("command output must be bytes")
        for name in ("exit_code", "duration_ns"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"{name} must be an integer")
        if self.duration_ns < 0:
            raise ValueError("duration_ns must be nonnegative")
        if self.truncated is not False:
            raise ValueError("successful command results must never be truncated")


class SourceFS(Protocol):
    def iter_files(self, root: Path) -> tuple[Path, ...]: ...

    def stat(self, path: Path) -> FileStamp: ...

    def read_bytes(self, path: Path, *, max_bytes: int) -> SourceRead: ...


class CommandRunner(Protocol):
    def run(
        self,
        argv: Sequence[str],
        *,
        timeout_s: float,
        stdout_limit: int,
    ) -> CommandResult: ...


def _file_stamp(value: os.stat_result) -> FileStamp:
    return FileStamp(
        device=value.st_dev,
        inode=value.st_ino,
        size=value.st_size,
        mtime_ns=value.st_mtime_ns,
        ctime_ns=value.st_ctime_ns,
    )


def _beneath(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


class ReadOnlySourceFS:
    """Filesystem adapter with no source mutation methods or writable opens."""

    def __init__(self, *, protected_roots: Iterable[Path] = ()) -> None:
        normalized: list[tuple[Path, Path]] = []
        for root in protected_roots:
            lexical = Path(os.path.abspath(os.fspath(root)))
            normalized.append((lexical, lexical.resolve(strict=False)))
        self._protected_roots = tuple(normalized)

    def _guard(self, path: Path) -> Path:
        lexical = Path(os.path.abspath(os.fspath(path)))
        try:
            resolved = lexical.resolve(strict=False)
        except OSError as error:
            raise QseshError("QS-E-SOURCE-READ", phase="source-path") from error
        for protected_lexical, protected_resolved in self._protected_roots:
            if _beneath(lexical, protected_lexical) or _beneath(
                resolved, protected_resolved
            ):
                raise QseshError("QS-E-BOUNDARY", phase="source-path")
        return lexical

    def iter_files(self, root: Path) -> tuple[Path, ...]:
        guarded_root = self._guard(root)
        discovered: list[Path] = []
        pending = [guarded_root]
        try:
            while pending:
                directory = pending.pop()
                entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
                child_directories: list[Path] = []
                for entry in entries:
                    path = self._guard(Path(entry.path))
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        child_directories.append(path)
                    elif entry.is_file(follow_symlinks=False):
                        discovered.append(path)
                pending.extend(reversed(child_directories))
        except QseshError:
            raise
        except OSError as error:
            raise QseshError("QS-E-SOURCE-READ", phase="source-iterate") from error
        return tuple(sorted(discovered, key=lambda path: path.as_posix()))

    def stat(self, path: Path) -> FileStamp:
        guarded = self._guard(path)
        descriptor = self._open_readonly(guarded, phase="source-stat")
        try:
            return _file_stamp(os.fstat(descriptor))
        except OSError as error:
            raise QseshError("QS-E-SOURCE-READ", phase="source-stat") from error
        finally:
            os.close(descriptor)

    def read_bytes(self, path: Path, *, max_bytes: int) -> SourceRead:
        if (
            isinstance(max_bytes, bool)
            or not isinstance(max_bytes, int)
            or max_bytes <= 0
        ):
            raise QseshError("QS-E-BOUNDARY", phase="source-read-limit")
        guarded = self._guard(path)
        descriptor = self._open_readonly(guarded, phase="source-read")
        try:
            before = _file_stamp(os.fstat(descriptor))
            if before.size > max_bytes:
                raise QseshError("QS-E-SOURCE-READ", phase="source-read-cap")
            chunks: list[bytes] = []
            byte_count = 0
            while True:
                chunk = os.read(descriptor, min(65_536, max_bytes + 1 - byte_count))
                if not chunk:
                    break
                chunks.append(chunk)
                byte_count += len(chunk)
                if byte_count > max_bytes:
                    raise QseshError("QS-E-SOURCE-READ", phase="source-read-cap")
            after = _file_stamp(os.fstat(descriptor))
        except QseshError:
            raise
        except OSError as error:
            raise QseshError("QS-E-SOURCE-READ", phase="source-read") from error
        finally:
            os.close(descriptor)
        return SourceRead(raw_bytes=b"".join(chunks), before=before, after=after)

    @staticmethod
    def _open_readonly(path: Path, *, phase: str) -> int:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags)
            mode = os.fstat(descriptor).st_mode
            if not stat_module.S_ISREG(mode):
                os.close(descriptor)
                raise QseshError("QS-E-SOURCE-READ", phase=phase)
            return descriptor
        except QseshError:
            raise
        except OSError as error:
            raise QseshError("QS-E-SOURCE-READ", phase=phase) from error


class OpenCodeCommandRunner:
    """Run only the exact pure, read-only OpenCode command allowlist."""

    def __init__(
        self,
        executable: Path,
        *,
        private_workspace: Path,
        copied_db: Path,
        protected_roots: Iterable[Path] = (),
    ) -> None:
        self.executable = Path(executable).resolve(strict=False)
        self._protected_roots = self._normalize_protected_roots(protected_roots)
        self.private_workspace, workspace_metadata = self._validate_directory(
            private_workspace,
            phase="opencode-private-workspace",
        )
        self._workspace_identity = self._identity(workspace_metadata)
        self.copied_db, database_metadata = self._validate_copied_db(copied_db)
        self._copied_db_identity = self._identity(database_metadata)
        self._directory_identities: dict[Path, tuple[int, int]] = {}
        for runtime_name in _RUNTIME_DIRECTORIES:
            runtime_path, runtime_metadata = self._validate_directory(
                self.private_workspace / runtime_name,
                phase="opencode-runtime-dir",
                beneath_workspace=True,
            )
            self._directory_identities[runtime_path] = self._identity(runtime_metadata)
        for parent in self._database_parents():
            parent_path, parent_metadata = self._validate_directory(
                parent,
                phase="opencode-copied-db",
                beneath_workspace=True,
            )
            self._directory_identities[parent_path] = self._identity(parent_metadata)

    def run(
        self,
        argv: Sequence[str],
        *,
        timeout_s: float,
        stdout_limit: int,
    ) -> CommandResult:
        normalized = self._validate_argv(argv)
        self._validate_bounds(timeout_s=timeout_s, stdout_limit=stdout_limit)
        started = time.perf_counter_ns()
        database_descriptor = self._revalidate_paths()
        try:
            try:
                process = subprocess.Popen(
                    normalized,
                    close_fds=True,
                    env=self._fresh_env(),
                    shell=False,
                    start_new_session=True,
                    stdin=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    bufsize=0,
                )
            except OSError as error:
                raise QseshError(
                    "QS-E-SOURCE-READ", phase="opencode-command"
                ) from error
        finally:
            os.close(database_descriptor)
        stdout, stderr, return_code = self._capture_output(
            process,
            timeout_s=timeout_s,
            output_limit=stdout_limit,
        )
        if return_code < 0:
            raise QseshError("QS-E-SOURCE-READ", phase="opencode-command-signal")
        return CommandResult(
            stdout=stdout,
            stderr=stderr,
            exit_code=return_code,
            duration_ns=time.perf_counter_ns() - started,
            truncated=False,
        )

    @staticmethod
    def _identity(metadata: os.stat_result) -> tuple[int, int]:
        return metadata.st_dev, metadata.st_ino

    @staticmethod
    def _normalize_protected_roots(
        protected_roots: Iterable[Path],
    ) -> tuple[tuple[Path, Path], ...]:
        normalized: list[tuple[Path, Path]] = []
        for root in protected_roots:
            lexical = Path(os.path.abspath(os.fspath(root)))
            normalized.append((lexical, lexical.resolve(strict=False)))
        return tuple(normalized)

    def _validate_directory(
        self,
        path: Path,
        *,
        phase: str,
        beneath_workspace: bool = False,
    ) -> tuple[Path, os.stat_result]:
        candidate = Path(path)
        if not candidate.is_absolute() or ".." in candidate.parts:
            raise QseshError("QS-E-BOUNDARY", phase=phase)
        lexical = Path(os.path.abspath(os.fspath(candidate)))
        if beneath_workspace and not _beneath(lexical, self.private_workspace):
            raise QseshError("QS-E-BOUNDARY", phase=phase)
        try:
            metadata = lexical.lstat()
            resolved = lexical.resolve(strict=True)
        except OSError as error:
            raise QseshError("QS-E-BOUNDARY", phase=phase) from error
        if (
            resolved != lexical
            or stat_module.S_ISLNK(metadata.st_mode)
            or not stat_module.S_ISDIR(metadata.st_mode)
            or stat_module.S_IMODE(metadata.st_mode) != 0o700
        ):
            raise QseshError("QS-E-BOUNDARY", phase=phase)
        return lexical, metadata

    def _validate_copied_db(self, path: Path) -> tuple[Path, os.stat_result]:
        phase = "opencode-copied-db"
        candidate = Path(path)
        if not candidate.is_absolute() or ".." in candidate.parts:
            raise QseshError("QS-E-BOUNDARY", phase=phase)
        lexical = Path(os.path.abspath(os.fspath(candidate)))
        if lexical.name != "opencode.db" or not _beneath(
            lexical, self.private_workspace
        ):
            raise QseshError("QS-E-BOUNDARY", phase=phase)
        try:
            resolved = lexical.resolve(strict=True)
        except OSError as error:
            raise QseshError("QS-E-BOUNDARY", phase=phase) from error
        for protected_lexical, protected_resolved in self._protected_roots:
            if _beneath(lexical, protected_lexical) or _beneath(
                resolved, protected_resolved
            ):
                raise QseshError("QS-E-BOUNDARY", phase=phase)
        if resolved != lexical:
            raise QseshError("QS-E-BOUNDARY", phase=phase)
        descriptor = self._open_copied_db(lexical, expected_identity=None)
        try:
            metadata = os.fstat(descriptor)
        finally:
            os.close(descriptor)
        return lexical, metadata

    def _database_parents(self) -> tuple[Path, ...]:
        parents: list[Path] = []
        current = self.copied_db.parent
        while current != self.private_workspace:
            if not _beneath(current, self.private_workspace):
                raise QseshError("QS-E-BOUNDARY", phase="opencode-copied-db")
            parents.append(current)
            current = current.parent
        return tuple(reversed(parents))

    def _open_copied_db(
        self,
        path: Path,
        *,
        expected_identity: tuple[int, int] | None,
    ) -> int:
        phase = "opencode-copied-db"
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor: int | None = None
        try:
            descriptor = os.open(path, flags)
            metadata = os.fstat(descriptor)
        except OSError as error:
            if descriptor is not None:
                os.close(descriptor)
            raise QseshError("QS-E-BOUNDARY", phase=phase) from error
        if (
            not stat_module.S_ISREG(metadata.st_mode)
            or stat_module.S_IMODE(metadata.st_mode) != 0o600
            or (
                expected_identity is not None
                and self._identity(metadata) != expected_identity
            )
        ):
            os.close(descriptor)
            raise QseshError("QS-E-BOUNDARY", phase=phase)
        return descriptor

    def _revalidate_paths(self) -> int:
        workspace, workspace_metadata = self._validate_directory(
            self.private_workspace,
            phase="opencode-private-workspace",
        )
        if (
            workspace != self.private_workspace
            or self._identity(workspace_metadata) != self._workspace_identity
        ):
            raise QseshError("QS-E-BOUNDARY", phase="opencode-private-workspace")
        for path, expected_identity in self._directory_identities.items():
            phase = (
                "opencode-runtime-dir"
                if path.name in _RUNTIME_DIRECTORIES
                else "opencode-copied-db"
            )
            _, metadata = self._validate_directory(
                path,
                phase=phase,
                beneath_workspace=True,
            )
            if self._identity(metadata) != expected_identity:
                raise QseshError("QS-E-BOUNDARY", phase=phase)
        return self._open_copied_db(
            self.copied_db,
            expected_identity=self._copied_db_identity,
        )

    def _fresh_env(self) -> dict[str, str]:
        workspace = self.private_workspace
        return {
            "HOME": str(workspace / "home"),
            "LANG": "C",
            "LC_ALL": "C",
            "NO_COLOR": "1",
            "OPENCODE_DB": str(self.copied_db),
            "PATH": os.defpath,
            "TMPDIR": str(workspace / "tmp"),
            "XDG_CACHE_HOME": str(workspace / "xdg-cache"),
            "XDG_CONFIG_HOME": str(workspace / "xdg-config"),
            "XDG_DATA_HOME": str(workspace / "xdg-data"),
        }

    def _capture_output(
        self,
        process: subprocess.Popen[bytes],
        *,
        timeout_s: float,
        output_limit: int,
    ) -> tuple[bytes, bytes, int]:
        if process.stdout is None or process.stderr is None:
            self._terminate_process_group(process, (), output_limit=output_limit)
            raise QseshError("QS-E-SOURCE-READ", phase="opencode-command")
        streams = {"stdout": process.stdout, "stderr": process.stderr}
        buffers = {name: bytearray() for name in streams}
        selector = selectors.DefaultSelector()
        deadline = time.monotonic() + timeout_s
        try:
            for name, stream in streams.items():
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, name)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise QseshError("QS-E-TIMEOUT", phase="opencode-command")
                events = selector.select(remaining)
                if not events:
                    raise QseshError("QS-E-TIMEOUT", phase="opencode-command")
                for key, _ in events:
                    stream_name = key.data
                    buffer = buffers[stream_name]
                    capacity = output_limit - len(buffer)
                    try:
                        chunk = os.read(key.fileobj.fileno(), min(65_536, capacity + 1))
                    except BlockingIOError:
                        continue
                    except OSError as error:
                        raise QseshError(
                            "QS-E-SOURCE-READ", phase="opencode-command"
                        ) from error
                    if not chunk:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    if len(chunk) > capacity:
                        raise QseshError("QS-E-BOUNDARY", phase="opencode-output-cap")
                    buffer.extend(chunk)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise QseshError("QS-E-TIMEOUT", phase="opencode-command")
            try:
                return_code = process.wait(timeout=remaining)
            except subprocess.TimeoutExpired as error:
                raise QseshError("QS-E-TIMEOUT", phase="opencode-command") from error
        except QseshError:
            self._terminate_process_group(
                process,
                tuple((streams[name], len(buffer)) for name, buffer in buffers.items()),
                output_limit=output_limit,
            )
            raise
        except OSError as error:
            self._terminate_process_group(
                process,
                tuple((streams[name], len(buffer)) for name, buffer in buffers.items()),
                output_limit=output_limit,
            )
            raise QseshError("QS-E-SOURCE-READ", phase="opencode-command") from error
        except BaseException:
            self._terminate_process_group(
                process,
                tuple((streams[name], len(buffer)) for name, buffer in buffers.items()),
                output_limit=output_limit,
            )
            raise
        finally:
            selector.close()
            for stream in streams.values():
                if not stream.closed:
                    stream.close()
        return bytes(buffers["stdout"]), bytes(buffers["stderr"]), return_code

    @staticmethod
    def _terminate_process_group(
        process: subprocess.Popen[bytes],
        streams: tuple[tuple[object, int], ...],
        *,
        output_limit: int,
    ) -> None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError:
            pass
        for stream, captured_size in streams:
            remaining = output_limit - captured_size
            if remaining <= 0 or getattr(stream, "closed", True):
                continue
            descriptor = stream.fileno()
            try:
                os.set_blocking(descriptor, False)
            except OSError:
                continue
            while remaining > 0:
                try:
                    chunk = os.read(descriptor, min(65_536, remaining))
                except (BlockingIOError, OSError):
                    break
                if not chunk:
                    break
                remaining -= len(chunk)
        try:
            process.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except OSError:
                pass
            try:
                process.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                pass

    def _validate_argv(self, argv: Sequence[str]) -> tuple[str, ...]:
        if isinstance(argv, (str, bytes)) or not isinstance(argv, Sequence):
            raise QseshError("QS-E-BOUNDARY", phase="opencode-argv")
        normalized = tuple(argv)
        if not normalized or not all(isinstance(item, str) for item in normalized):
            raise QseshError("QS-E-BOUNDARY", phase="opencode-argv")
        executable = str(self.executable)
        if normalized == (executable, "--pure", "--version"):
            return normalized
        list_prefix = (
            executable,
            "--pure",
            "session",
            "list",
            "--format",
            "json",
        )
        if normalized == list_prefix:
            return normalized
        if (
            len(normalized) == len(list_prefix) + 2
            and normalized[: len(list_prefix)] == list_prefix
        ):
            flag, value = normalized[-2:]
            if flag == "-n" and value.isascii() and value.isdecimal():
                count = int(value)
                if 1 <= count <= _MAX_LIST_ROWS and str(count) == value:
                    return normalized
        if (
            len(normalized) == 4
            and normalized[:3] == (executable, "--pure", "export")
            and _SESSION_ID.fullmatch(normalized[3]) is not None
        ):
            return normalized
        raise QseshError("QS-E-BOUNDARY", phase="opencode-argv")

    @staticmethod
    def _validate_bounds(*, timeout_s: float, stdout_limit: int) -> None:
        if (
            isinstance(timeout_s, bool)
            or not isinstance(timeout_s, (int, float))
            or not math.isfinite(timeout_s)
            or timeout_s <= 0
        ):
            raise QseshError("QS-E-BOUNDARY", phase="opencode-timeout")
        if (
            isinstance(stdout_limit, bool)
            or not isinstance(stdout_limit, int)
            or stdout_limit <= 0
        ):
            raise QseshError("QS-E-BOUNDARY", phase="opencode-output-limit")
