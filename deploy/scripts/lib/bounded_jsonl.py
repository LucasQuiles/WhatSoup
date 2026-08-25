"""Fenced bounded JSONL publication for private controller diagnostics."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import threading
import time
from typing import Any, Literal, Mapping


Status = Literal["committed", "not_mutated", "unproven"]
Method = Literal["append", "compact_replace", "none"]
Stage = Literal[
    "validation",
    "parent",
    "lock",
    "reconcile",
    "inspect",
    "append",
    "file_sync",
    "temp_create",
    "temp_write",
    "temp_sync",
    "replace",
    "parent_sync",
    "complete",
]
FailureClass = Literal[
    "invalid_input",
    "unsupported",
    "unsafe_parent",
    "unsafe_target",
    "unsafe_lock",
    "unsafe_temp",
    "lock_timeout",
    "incomplete_jsonl",
    "invalid_jsonl",
    "short_write",
    "io_error",
    "internal_error",
]

__all__ = [
    "BoundedJsonlResult",
    "append_bounded_jsonl",
    "require_bounded_jsonl_commit",
]


@dataclass(frozen=True)
class BoundedJsonlResult:
    component: str
    status: Status
    method: Method
    stage: Stage
    record_sha256: str | None
    bytes_before: int | None
    bytes_after: int | None
    compacted: bool
    oversized_record: bool
    failure_class: FailureClass | None


class BoundedJsonlCommitError(RuntimeError):
    def __init__(
        self,
        *,
        component: str,
        status: Status,
        stage: Stage,
        failure_class: FailureClass | None,
    ) -> None:
        self.component = component
        self.status = status
        self.stage = stage
        self.failure_class = failure_class
        super().__init__(
            "bounded JSONL publication did not commit: "
            f"component={component} status={status} stage={stage} "
            f"failure_class={failure_class or 'none'}"
        )


class _ValidationFailure(Exception):
    def __init__(self, failure_class: FailureClass) -> None:
        self.failure_class = failure_class
        super().__init__(failure_class)


class _TransactionFailure(Exception):
    def __init__(
        self,
        status: Status,
        stage: Stage,
        failure_class: FailureClass,
    ) -> None:
        self.status = status
        self.stage = stage
        self.failure_class = failure_class
        super().__init__(status, stage, failure_class)


_COMPONENT_RE = re.compile(r"[a-z][a-z0-9_.-]{0,127}\Z")
_MUTEX_REGISTRY_LOCK = threading.Lock()
_MUTEXES: dict[tuple[int, int, str], threading.Lock] = {}


def _safe_component(component: object) -> str:
    if isinstance(component, str) and _COMPONENT_RE.fullmatch(component) is not None:
        return component
    return "invalid"


def _result(
    *,
    component: str,
    status: Status,
    method: Method,
    stage: Stage,
    record_sha256: str | None,
    bytes_before: int | None,
    bytes_after: int | None,
    compacted: bool,
    oversized_record: bool,
    failure_class: FailureClass | None,
) -> BoundedJsonlResult:
    return BoundedJsonlResult(
        component=component,
        status=status,
        method=method,
        stage=stage,
        record_sha256=record_sha256,
        bytes_before=bytes_before,
        bytes_after=bytes_after,
        compacted=compacted,
        oversized_record=oversized_record,
        failure_class=failure_class,
    )


def _validate_path(path: Path) -> None:
    if not isinstance(path, Path):
        raise _ValidationFailure("invalid_input")
    if path.name in {"", ".", ".."}:
        raise _ValidationFailure("invalid_input")
    if "\x00" in os.fspath(path):
        raise _ValidationFailure("invalid_input")


def _serialize_record(
    record: Mapping[str, Any],
    component: str,
    max_bytes: int,
    lock_timeout_seconds: float,
) -> tuple[bytes, str]:
    if not isinstance(component, str) or _COMPONENT_RE.fullmatch(component) is None:
        raise _ValidationFailure("invalid_input")
    if not isinstance(record, Mapping):
        raise _ValidationFailure("invalid_input")
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes <= 0:
        raise _ValidationFailure("invalid_input")
    if (
        isinstance(lock_timeout_seconds, bool)
        or not isinstance(lock_timeout_seconds, (int, float))
        or not math.isfinite(float(lock_timeout_seconds))
        or lock_timeout_seconds <= 0
    ):
        raise _ValidationFailure("invalid_input")
    try:
        line = (
            json.dumps(record, sort_keys=True, allow_nan=False) + "\n"
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise _ValidationFailure("invalid_input") from exc
    return line, hashlib.sha256(line).hexdigest()


def _capabilities_available() -> bool:
    required_flags = all(
        hasattr(os, name) for name in ("O_DIRECTORY", "O_NOFOLLOW")
    )
    required_dir_fd = all(
        function in os.supports_dir_fd
        for function in (os.open, os.stat, os.unlink, os.rename)
    )
    required_no_follow_stat = os.stat in os.supports_follow_symlinks
    return (
        required_flags
        and required_dir_fd
        and required_no_follow_stat
        and hasattr(fcntl, "flock")
    )


def _effective_uid() -> int:
    return os.geteuid()


def _target_mutex(parent_fd: int, target_name: str) -> threading.Lock:
    parent_stat = os.fstat(parent_fd)
    key = (parent_stat.st_dev, parent_stat.st_ino, target_name)
    with _MUTEX_REGISTRY_LOCK:
        return _MUTEXES.setdefault(key, threading.Lock())


def _acquire_flock(lock_fd: int, deadline: float) -> bool:
    while True:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(0.01, remaining))


def _replace_relative(parent_fd: int, temp_name: str, target_name: str) -> None:
    os.rename(
        temp_name,
        target_name,
        src_dir_fd=parent_fd,
        dst_dir_fd=parent_fd,
    )


def _sync_parent(parent_fd: int) -> None:
    os.fsync(parent_fd)


def _sync_grandparent(parent: Path) -> None:
    """Persist a newly created parent directory's own name.

    fsync on the parent fd durably records what is INSIDE the parent. The parent's
    directory entry lives in the grandparent, so when mkdir() has just created the
    parent, a crash before the grandparent is synced can leave the fsynced record
    inside a directory that no longer exists. Only called on the create path; a
    pre-existing parent is already durable.
    """
    grandparent_fd = os.open(
        parent.parent,
        os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW,
    )
    try:
        os.fsync(grandparent_fd)
    finally:
        os.close(grandparent_fd)


def _sync_file(fd: int) -> None:
    os.fsync(fd)


def _reject_nonstandard_json_constant(_value: str) -> None:
    raise ValueError("nonstandard JSON constant")


def _retained_candidate(
    target_fd: int | None,
    incoming: bytes,
    max_bytes: int,
) -> tuple[deque[bytes], int, bool]:
    retained: deque[bytes] = deque()
    retained_bytes = 0
    if target_fd is None:
        retained.append(incoming)
        return retained, len(incoming), len(incoming) > max_bytes
    os.lseek(target_fd, 0, os.SEEK_SET)
    with os.fdopen(os.dup(target_fd), "rb", closefd=True) as stream:
        for line in stream:
            if not line.endswith(b"\n"):
                raise _TransactionFailure(
                    "not_mutated", "inspect", "incomplete_jsonl"
                )
            try:
                decoded = line.decode("utf-8")
                parsed = json.loads(
                    decoded,
                    parse_constant=_reject_nonstandard_json_constant,
                )
            except (UnicodeError, ValueError) as exc:
                raise _TransactionFailure(
                    "not_mutated", "inspect", "invalid_jsonl"
                ) from exc
            if not isinstance(parsed, dict):
                raise _TransactionFailure(
                    "not_mutated", "inspect", "invalid_jsonl"
                )
            retained.append(line)
            retained_bytes += len(line)
            while retained and retained_bytes + len(incoming) > max_bytes:
                retained_bytes -= len(retained.popleft())
    retained.append(incoming)
    retained_bytes += len(incoming)
    return retained, retained_bytes, len(incoming) > max_bytes


def _compact_replace(
    *,
    parent_fd: int,
    target_name: str,
    target_exists: bool,
    component: str,
    incoming: bytes,
    record_sha256: str,
    max_bytes: int,
    bytes_before: int,
) -> BoundedJsonlResult:
    method: Method = "compact_replace"
    oversized_record = len(incoming) > max_bytes
    target_fd: int | None = None
    temp_fd: int | None = None
    replace_started = False
    temp_name = f".{target_name}.bounded-jsonl.compact.tmp"
    try:
        if target_exists:
            try:
                target_fd = os.open(
                    target_name,
                    os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW,
                    dir_fd=parent_fd,
                )
                if not _is_safe_regular(os.fstat(target_fd)):
                    raise OSError("unsafe target")
            except OSError:
                return _result(
                    component=component,
                    status="not_mutated",
                    method=method,
                    stage="inspect",
                    record_sha256=record_sha256,
                    bytes_before=bytes_before,
                    bytes_after=bytes_before,
                    compacted=True,
                    oversized_record=oversized_record,
                    failure_class="unsafe_target",
                )
        try:
            retained, retained_bytes, oversized_record = _retained_candidate(
                target_fd,
                incoming,
                max_bytes,
            )
        except _TransactionFailure as exc:
            return _result(
                component=component,
                status=exc.status,
                method=method,
                stage=exc.stage,
                record_sha256=record_sha256,
                bytes_before=bytes_before,
                bytes_after=bytes_before,
                compacted=True,
                oversized_record=oversized_record,
                failure_class=exc.failure_class,
            )
        except OSError:
            return _result(
                component=component,
                status="not_mutated",
                method=method,
                stage="inspect",
                record_sha256=record_sha256,
                bytes_before=bytes_before,
                bytes_after=bytes_before,
                compacted=True,
                oversized_record=oversized_record,
                failure_class="io_error",
            )

        try:
            temp_fd = os.open(
                temp_name,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
                0o600,
                dir_fd=parent_fd,
            )
            opened_temp = os.fstat(temp_fd)
            if not _is_safe_regular(opened_temp):
                raise OSError("unsafe temp")
            os.fchmod(temp_fd, 0o600)
        except OSError:
            return _result(
                component=component,
                status="not_mutated",
                method=method,
                stage="temp_create",
                record_sha256=record_sha256,
                bytes_before=bytes_before,
                bytes_after=bytes_before,
                compacted=True,
                oversized_record=oversized_record,
                failure_class="io_error",
            )

        for retained_line in retained:
            try:
                written = os.write(temp_fd, retained_line)
            except OSError:
                return _result(
                    component=component,
                    status="not_mutated",
                    method=method,
                    stage="temp_write",
                    record_sha256=record_sha256,
                    bytes_before=bytes_before,
                    bytes_after=bytes_before,
                    compacted=True,
                    oversized_record=oversized_record,
                    failure_class="io_error",
                )
            if written != len(retained_line):
                return _result(
                    component=component,
                    status="not_mutated",
                    method=method,
                    stage="temp_write",
                    record_sha256=record_sha256,
                    bytes_before=bytes_before,
                    bytes_after=bytes_before,
                    compacted=True,
                    oversized_record=oversized_record,
                    failure_class="short_write",
                )
        try:
            _sync_file(temp_fd)
            os.fchmod(temp_fd, 0o600)
            verified_temp = os.fstat(temp_fd)
            if (
                stat.S_IMODE(verified_temp.st_mode) != 0o600
                or not _is_safe_regular(verified_temp)
            ):
                raise OSError("temp privacy verification failed")
        except OSError:
            return _result(
                component=component,
                status="not_mutated",
                method=method,
                stage="temp_sync",
                record_sha256=record_sha256,
                bytes_before=bytes_before,
                bytes_after=bytes_before,
                compacted=True,
                oversized_record=oversized_record,
                failure_class="io_error",
            )
        os.close(temp_fd)
        temp_fd = None

        replace_started = True
        try:
            _replace_relative(parent_fd, temp_name, target_name)
        except OSError:
            return _result(
                component=component,
                status="unproven",
                method=method,
                stage="replace",
                record_sha256=record_sha256,
                bytes_before=bytes_before,
                bytes_after=None,
                compacted=True,
                oversized_record=oversized_record,
                failure_class="io_error",
            )
        try:
            _sync_parent(parent_fd)
        except OSError:
            return _result(
                component=component,
                status="unproven",
                method=method,
                stage="parent_sync",
                record_sha256=record_sha256,
                bytes_before=bytes_before,
                bytes_after=None,
                compacted=True,
                oversized_record=oversized_record,
                failure_class="io_error",
            )
        return _result(
            component=component,
            status="committed",
            method=method,
            stage="complete",
            record_sha256=record_sha256,
            bytes_before=bytes_before,
            bytes_after=retained_bytes,
            compacted=True,
            oversized_record=oversized_record,
            failure_class=None,
        )
    except Exception:
        return _result(
            component=component,
            status="unproven" if replace_started else "not_mutated",
            method=method,
            stage="replace" if replace_started else "temp_write",
            record_sha256=record_sha256,
            bytes_before=bytes_before,
            bytes_after=None if replace_started else bytes_before,
            compacted=True,
            oversized_record=oversized_record,
            failure_class="internal_error",
        )
    finally:
        for fd in (temp_fd, target_fd):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass


def _entry_stat(parent_fd: int, name: str) -> os.stat_result | None:
    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def _is_safe_regular(entry: os.stat_result) -> bool:
    return stat.S_ISREG(entry.st_mode) and entry.st_uid == _effective_uid()


def _is_private_regular(entry: os.stat_result) -> bool:
    return _is_safe_regular(entry) and stat.S_IMODE(entry.st_mode) == 0o600


def _open_parent(path: Path) -> tuple[int | None, BoundedJsonlResult | None]:
    parent = path.parent
    parent_created = False
    try:
        try:
            parent.mkdir(mode=0o700)
            parent_created = True
        except FileExistsError:
            pass
        parent_fd = os.open(
            parent,
            os.O_DIRECTORY | os.O_RDONLY | os.O_NOFOLLOW,
        )
    except OSError:
        return None, _result(
            component="invalid",
            status="not_mutated",
            method="none",
            stage="parent",
            record_sha256=None,
            bytes_before=None,
            bytes_after=None,
            compacted=False,
            oversized_record=False,
            failure_class="unsafe_parent",
        )
    try:
        observed = os.fstat(parent_fd)
        if not stat.S_ISDIR(observed.st_mode) or observed.st_uid != _effective_uid():
            raise OSError("unsafe parent")
        os.fchmod(parent_fd, 0o700)
        verified = os.fstat(parent_fd)
        if stat.S_IMODE(verified.st_mode) != 0o700 or verified.st_uid != _effective_uid():
            raise OSError("parent privacy verification failed")
    except OSError:
        os.close(parent_fd)
        return None, _result(
            component="invalid",
            status="not_mutated",
            method="none",
            stage="parent",
            record_sha256=None,
            bytes_before=None,
            bytes_after=None,
            compacted=False,
            oversized_record=False,
            failure_class="unsafe_parent",
        )
    if parent_created:
        # A failed grandparent sync means the newly created parent's own directory
        # entry is not durable. Reporting ordinary success here would be a fail-open:
        # the caller would treat an unproven directory as committed. Both the open
        # and the fsync propagate (matching _sync_parent/_sync_file, which never
        # swallow), and the decision is made here at the caller.
        try:
            _sync_grandparent(parent)
        except OSError:
            os.close(parent_fd)
            return None, _result(
                component="invalid",
                status="not_mutated",
                method="none",
                stage="parent_sync",
                record_sha256=None,
                bytes_before=None,
                bytes_after=None,
                compacted=False,
                oversized_record=False,
                failure_class="io_error",
            )
    return parent_fd, None


def _failure_with_context(
    base: BoundedJsonlResult,
    *,
    component: str,
    record_sha256: str,
) -> BoundedJsonlResult:
    return _result(
        component=component,
        status=base.status,
        method=base.method,
        stage=base.stage,
        record_sha256=record_sha256,
        bytes_before=base.bytes_before,
        bytes_after=base.bytes_after,
        compacted=base.compacted,
        oversized_record=base.oversized_record,
        failure_class=base.failure_class,
    )


def _append_under_fence(
    *,
    parent_fd: int,
    target_name: str,
    component: str,
    line: bytes,
    record_sha256: str,
    max_bytes: int,
) -> BoundedJsonlResult:
    temp_name = f".{target_name}.bounded-jsonl.compact.tmp"
    try:
        temp_stat = _entry_stat(parent_fd, temp_name)
    except OSError:
        return _result(
            component=component,
            status="not_mutated",
            method="none",
            stage="reconcile",
            record_sha256=record_sha256,
            bytes_before=None,
            bytes_after=None,
            compacted=False,
            oversized_record=len(line) > max_bytes,
            failure_class="io_error",
        )
    if temp_stat is not None:
        if not _is_private_regular(temp_stat):
            return _result(
                component=component,
                status="not_mutated",
                method="none",
                stage="reconcile",
                record_sha256=record_sha256,
                bytes_before=None,
                bytes_after=None,
                compacted=False,
                oversized_record=len(line) > max_bytes,
                failure_class="unsafe_temp",
            )
        try:
            os.unlink(temp_name, dir_fd=parent_fd)
            _sync_parent(parent_fd)
        except OSError:
            return _result(
                component=component,
                status="not_mutated",
                method="none",
                stage="reconcile",
                record_sha256=record_sha256,
                bytes_before=None,
                bytes_after=None,
                compacted=False,
                oversized_record=len(line) > max_bytes,
                failure_class="io_error",
            )

    try:
        target_stat = _entry_stat(parent_fd, target_name)
    except OSError:
        target_stat = None
        return _result(
            component=component,
            status="not_mutated",
            method="none",
            stage="inspect",
            record_sha256=record_sha256,
            bytes_before=None,
            bytes_after=None,
            compacted=False,
            oversized_record=len(line) > max_bytes,
            failure_class="unsafe_target",
        )
    if target_stat is not None and not _is_safe_regular(target_stat):
        return _result(
            component=component,
            status="not_mutated",
            method="none",
            stage="inspect",
            record_sha256=record_sha256,
            bytes_before=None,
            bytes_after=None,
            compacted=False,
            oversized_record=len(line) > max_bytes,
            failure_class="unsafe_target",
        )
    bytes_before = 0 if target_stat is None else target_stat.st_size
    if target_stat is not None and bytes_before > 0:
        try:
            inspect_fd = os.open(
                target_name,
                os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW,
                dir_fd=parent_fd,
            )
            try:
                os.lseek(inspect_fd, -1, os.SEEK_END)
                terminal = os.read(inspect_fd, 1)
            finally:
                os.close(inspect_fd)
        except OSError:
            return _result(
                component=component,
                status="not_mutated",
                method="none",
                stage="inspect",
                record_sha256=record_sha256,
                bytes_before=bytes_before,
                bytes_after=bytes_before,
                compacted=False,
                oversized_record=len(line) > max_bytes,
                failure_class="unsafe_target",
            )
        if terminal != b"\n":
            return _result(
                component=component,
                status="not_mutated",
                method="none",
                stage="inspect",
                record_sha256=record_sha256,
                bytes_before=bytes_before,
                bytes_after=bytes_before,
                compacted=False,
                oversized_record=len(line) > max_bytes,
                failure_class="incomplete_jsonl",
            )

    if bytes_before + len(line) > max_bytes:
        return _compact_replace(
            parent_fd=parent_fd,
            target_name=target_name,
            target_exists=target_stat is not None,
            component=component,
            incoming=line,
            record_sha256=record_sha256,
            max_bytes=max_bytes,
            bytes_before=bytes_before,
        )

    try:
        target_fd = os.open(
            target_name,
            os.O_CREAT | os.O_APPEND | os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW,
            0o600,
            dir_fd=parent_fd,
        )
    except OSError:
        return _result(
            component=component,
            status="not_mutated",
            method="none",
            stage="inspect",
            record_sha256=record_sha256,
            bytes_before=bytes_before,
            bytes_after=bytes_before,
            compacted=False,
            oversized_record=False,
            failure_class="unsafe_target",
        )
    try:
        opened = os.fstat(target_fd)
        if not _is_safe_regular(opened):
            return _result(
                component=component,
                status="unproven",
                method="append",
                stage="append",
                record_sha256=record_sha256,
                bytes_before=bytes_before,
                bytes_after=None,
                compacted=False,
                oversized_record=False,
                failure_class="unsafe_target",
            )
        os.fchmod(target_fd, 0o600)
        written = os.write(target_fd, line)
        if written != len(line):
            return _result(
                component=component,
                status="unproven",
                method="append",
                stage="append",
                record_sha256=record_sha256,
                bytes_before=bytes_before,
                bytes_after=None,
                compacted=False,
                oversized_record=False,
                failure_class="short_write",
            )
        try:
            _sync_file(target_fd)
            os.fchmod(target_fd, 0o600)
            verified = os.fstat(target_fd)
            if stat.S_IMODE(verified.st_mode) != 0o600:
                raise OSError("target privacy verification failed")
        except OSError:
            return _result(
                component=component,
                status="unproven",
                method="append",
                stage="file_sync",
                record_sha256=record_sha256,
                bytes_before=bytes_before,
                bytes_after=None,
                compacted=False,
                oversized_record=False,
                failure_class="io_error",
            )
        try:
            _sync_parent(parent_fd)
        except OSError:
            return _result(
                component=component,
                status="unproven",
                method="append",
                stage="parent_sync",
                record_sha256=record_sha256,
                bytes_before=bytes_before,
                bytes_after=None,
                compacted=False,
                oversized_record=False,
                failure_class="io_error",
            )
        return _result(
            component=component,
            status="committed",
            method="append",
            stage="complete",
            record_sha256=record_sha256,
            bytes_before=bytes_before,
            bytes_after=bytes_before + len(line),
            compacted=False,
            oversized_record=False,
            failure_class=None,
        )
    except OSError:
        return _result(
            component=component,
            status="unproven",
            method="append",
            stage="append",
            record_sha256=record_sha256,
            bytes_before=bytes_before,
            bytes_after=None,
            compacted=False,
            oversized_record=False,
            failure_class="io_error",
        )
    except Exception:
        return _result(
            component=component,
            status="unproven",
            method="append",
            stage="append",
            record_sha256=record_sha256,
            bytes_before=bytes_before,
            bytes_after=None,
            compacted=False,
            oversized_record=False,
            failure_class="internal_error",
        )
    finally:
        try:
            os.close(target_fd)
        except OSError:
            pass


def append_bounded_jsonl(
    path: Path,
    record: Mapping[str, Any],
    *,
    component: str,
    max_bytes: int,
    lock_timeout_seconds: float = 5.0,
) -> BoundedJsonlResult:
    safe_component = _safe_component(component)
    try:
        _validate_path(path)
        line, record_sha256 = _serialize_record(
            record,
            component,
            max_bytes,
            lock_timeout_seconds,
        )
    except _ValidationFailure as exc:
        return _result(
            component=safe_component,
            status="not_mutated",
            method="none",
            stage="validation",
            record_sha256=None,
            bytes_before=None,
            bytes_after=None,
            compacted=False,
            oversized_record=False,
            failure_class=exc.failure_class,
        )
    except Exception:
        return _result(
            component=safe_component,
            status="not_mutated",
            method="none",
            stage="validation",
            record_sha256=None,
            bytes_before=None,
            bytes_after=None,
            compacted=False,
            oversized_record=False,
            failure_class="internal_error",
        )
    if not _capabilities_available():
        return _result(
            component=component,
            status="not_mutated",
            method="none",
            stage="validation",
            record_sha256=record_sha256,
            bytes_before=None,
            bytes_after=None,
            compacted=False,
            oversized_record=len(line) > max_bytes,
            failure_class="unsupported",
        )

    parent_fd, parent_failure = _open_parent(path)
    if parent_failure is not None:
        return _failure_with_context(
            parent_failure,
            component=component,
            record_sha256=record_sha256,
        )
    assert parent_fd is not None
    lock_fd: int | None = None
    process_mutex: threading.Lock | None = None
    mutex_acquired = False
    flock_acquired = False
    lock_name = f".{path.name}.bounded-jsonl.lock"
    deadline = time.monotonic() + float(lock_timeout_seconds)
    try:
        lock_stat = _entry_stat(parent_fd, lock_name)
        if lock_stat is not None and not _is_safe_regular(lock_stat):
            return _result(
                component=component,
                status="not_mutated",
                method="none",
                stage="lock",
                record_sha256=record_sha256,
                bytes_before=None,
                bytes_after=None,
                compacted=False,
                oversized_record=len(line) > max_bytes,
                failure_class="unsafe_lock",
            )
        lock_created = lock_stat is None
        try:
            if lock_created:
                try:
                    lock_fd = os.open(
                        lock_name,
                        os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW,
                        0o600,
                        dir_fd=parent_fd,
                    )
                except FileExistsError:
                    lock_created = False
                    lock_fd = os.open(
                        lock_name,
                        os.O_RDWR | os.O_NOFOLLOW,
                        dir_fd=parent_fd,
                    )
            else:
                lock_fd = os.open(
                    lock_name,
                    os.O_RDWR | os.O_NOFOLLOW,
                    dir_fd=parent_fd,
                )
            opened_lock = os.fstat(lock_fd)
            if not _is_safe_regular(opened_lock):
                raise OSError("unsafe lock")
            os.fchmod(lock_fd, 0o600)
            if stat.S_IMODE(os.fstat(lock_fd).st_mode) != 0o600:
                raise OSError("lock privacy verification failed")
            if lock_created:
                _sync_parent(parent_fd)
        except OSError:
            return _result(
                component=component,
                status="not_mutated",
                method="none",
                stage="lock",
                record_sha256=record_sha256,
                bytes_before=None,
                bytes_after=None,
                compacted=False,
                oversized_record=len(line) > max_bytes,
                failure_class="unsafe_lock",
            )
        process_mutex = _target_mutex(parent_fd, path.name)
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not process_mutex.acquire(timeout=remaining):
            return _result(
                component=component,
                status="not_mutated",
                method="none",
                stage="lock",
                record_sha256=record_sha256,
                bytes_before=None,
                bytes_after=None,
                compacted=False,
                oversized_record=len(line) > max_bytes,
                failure_class="lock_timeout",
            )
        mutex_acquired = True
        if not _acquire_flock(lock_fd, deadline):
            return _result(
                component=component,
                status="not_mutated",
                method="none",
                stage="lock",
                record_sha256=record_sha256,
                bytes_before=None,
                bytes_after=None,
                compacted=False,
                oversized_record=len(line) > max_bytes,
                failure_class="lock_timeout",
            )
        flock_acquired = True
        return _append_under_fence(
            parent_fd=parent_fd,
            target_name=path.name,
            component=component,
            line=line,
            record_sha256=record_sha256,
            max_bytes=max_bytes,
        )
    except OSError:
        return _result(
            component=component,
            status="not_mutated",
            method="none",
            stage="lock",
            record_sha256=record_sha256,
            bytes_before=None,
            bytes_after=None,
            compacted=False,
            oversized_record=len(line) > max_bytes,
            failure_class="io_error",
        )
    except Exception:
        return _result(
            component=component,
            status="not_mutated",
            method="none",
            stage="lock",
            record_sha256=record_sha256,
            bytes_before=None,
            bytes_after=None,
            compacted=False,
            oversized_record=len(line) > max_bytes,
            failure_class="internal_error",
        )
    finally:
        if flock_acquired and lock_fd is not None:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            except OSError:
                pass
        if lock_fd is not None:
            try:
                os.close(lock_fd)
            except OSError:
                pass
        if mutex_acquired and process_mutex is not None:
            process_mutex.release()
        try:
            os.close(parent_fd)
        except OSError:
            pass


def require_bounded_jsonl_commit(result: BoundedJsonlResult) -> None:
    if result.status == "committed":
        return
    raise BoundedJsonlCommitError(
        component=result.component,
        status=result.status,
        stage=result.stage,
        failure_class=result.failure_class,
    ) from None
