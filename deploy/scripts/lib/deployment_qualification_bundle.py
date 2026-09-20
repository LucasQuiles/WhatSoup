"""Verify one immutable deployment-qualification execution bundle."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import hashlib
import hmac
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
from typing import Any

from . import durable_json


_BUNDLE_SCHEMA_VERSION = "whatsoup.qualification-bundle.v1"
_MAX_FILE_BYTES = 1024 * 1024
_MAX_CLOSURE_ENTRIES = 64
_MAX_CLOSURE_FILES = 32
_MAX_CLOSURE_DIRECTORIES = 16
_MAX_CLOSURE_DEPTH = 4
_MAX_CLOSURE_BYTES = 2 * 1024 * 1024
_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
_COMMIT_RE = re.compile(r"[0-9a-f]{40}\Z")


class QualificationBundleRefusal(RuntimeError):
    """Content-free refusal for an unavailable or changed bundle."""


@dataclass(frozen=True)
class BundleFile:
    relative_path: str
    sha256: str
    executable: bool
    identity: durable_json.JsonFileIdentity


@dataclass(frozen=True)
class BundleDirectory:
    relative_path: str
    identity: durable_json.JsonFileIdentity


@dataclass(frozen=True)
class QualificationBundle:
    source_root: Path
    source_root_identity: durable_json.JsonFileIdentity
    bundle_path: Path
    bundle_sha256: str
    bundle_identity: durable_json.JsonFileIdentity
    source_commit: str
    arc_commit: str
    qfleet_commit: str
    policy_version: str
    execution_root: Path
    qualifier_path: Path
    declared_file_paths: tuple[Path, ...]
    files: tuple[BundleFile, ...]
    directories: tuple[BundleDirectory, ...]


def _refuse() -> None:
    raise QualificationBundleRefusal()


def _identity(file_stat: os.stat_result) -> durable_json.JsonFileIdentity:
    return durable_json.JsonFileIdentity(
        device=file_stat.st_dev,
        inode=file_stat.st_ino,
        mode=file_stat.st_mode,
        uid=file_stat.st_uid,
        nlink=file_stat.st_nlink,
        size=file_stat.st_size,
        mtime_ns=file_stat.st_mtime_ns,
        ctime_ns=file_stat.st_ctime_ns,
    )


def _absolute_path(value: os.PathLike[str] | str) -> Path:
    path = Path(os.fspath(value))
    if not path.is_absolute() or ".." in path.parts:
        _refuse()
    return path


def _relative_text(value: Any) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        _refuse()
    candidate = PurePosixPath(value)
    if (
        value.startswith("/")
        or candidate.as_posix() != value
        or any(part in {"", ".", ".."} for part in candidate.parts)
    ):
        _refuse()
    return candidate.as_posix()


def _relative_to(root: Path, path: Path) -> str:
    try:
        relative = path.relative_to(root)
    except ValueError:
        _refuse()
    return _relative_text(relative.as_posix())


def _require_sha256(value: Any) -> str:
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
        _refuse()
    return value


def _require_commit(value: Any) -> str:
    if not isinstance(value, str) or _COMMIT_RE.fullmatch(value) is None:
        _refuse()
    return value


def _require_policy_version(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 160
        or any(ord(character) < 0x21 or ord(character) > 0x7E for character in value)
    ):
        _refuse()
    return value


def _open_directory(path: Path) -> tuple[int, durable_json.JsonFileIdentity]:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    if not getattr(os, "O_NOFOLLOW", 0):
        _refuse()
    before = os.lstat(path)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        _refuse()
    descriptor = os.open(path, flags)
    identity = _identity(os.fstat(descriptor))
    if identity != _identity(before):
        os.close(descriptor)
        _refuse()
    return descriptor, identity


def _open_child_directory(
    parent_fd: int,
    name: str,
) -> tuple[int, durable_json.JsonFileIdentity]:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        _refuse()
    descriptor = os.open(name, flags, dir_fd=parent_fd)
    identity = _identity(os.fstat(descriptor))
    if identity != _identity(before):
        os.close(descriptor)
        _refuse()
    return descriptor, identity


def _read_regular_file(root: Path, relative_path: str) -> tuple[bytes, durable_json.JsonFileIdentity]:
    root_fd, root_identity = _open_directory(root)
    descriptors = [(root_fd, root_identity)]
    descriptor = -1
    try:
        parts = PurePosixPath(relative_path).parts
        parent_fd = root_fd
        for part in parts[:-1]:
            child_fd, child_identity = _open_child_directory(parent_fd, part)
            descriptors.append((child_fd, child_identity))
            parent_fd = child_fd
        leaf = parts[-1]
        before = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
        if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            _refuse()
        if before.st_size > _MAX_FILE_BYTES:
            _refuse()
        flags = (
            os.O_RDONLY
            | os.O_CLOEXEC
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_NONBLOCK", 0)
        )
        descriptor = os.open(leaf, flags, dir_fd=parent_fd)
        opened_identity = _identity(os.fstat(descriptor))
        if opened_identity != _identity(before):
            _refuse()
        raw = bytearray()
        while len(raw) <= _MAX_FILE_BYTES:
            chunk = os.read(descriptor, min(64 * 1024, _MAX_FILE_BYTES + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        if len(raw) > _MAX_FILE_BYTES:
            _refuse()
        after = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
        if _identity(after) != opened_identity or _identity(os.fstat(descriptor)) != opened_identity:
            _refuse()
        for directory_fd, directory_identity in descriptors:
            if _identity(os.fstat(directory_fd)) != directory_identity:
                _refuse()
        return bytes(raw), opened_identity
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        for directory_fd, _directory_identity in reversed(descriptors):
            os.close(directory_fd)


def _strict_json(raw: bytes) -> Mapping[str, Any]:
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                _refuse()
            result[key] = value
        return result

    def reject_nonfinite(_literal: str) -> Any:
        _refuse()

    try:
        payload = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=reject_duplicates,
            parse_constant=reject_nonfinite,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError, RecursionError):
        _refuse()
    if not isinstance(payload, Mapping):
        _refuse()
    return payload


def _parse_bundle(payload: Mapping[str, Any]) -> tuple[str, str, str, str, str, str, dict[str, tuple[str, bool]]]:
    if set(payload) != {
        "schema_version",
        "source_commit",
        "compatibility",
        "policy_version",
        "execution_root",
        "qualifier",
        "files",
    }:
        _refuse()
    if payload["schema_version"] != _BUNDLE_SCHEMA_VERSION:
        _refuse()
    source_commit = _require_commit(payload["source_commit"])
    compatibility = payload["compatibility"]
    if not isinstance(compatibility, Mapping) or set(compatibility) != {"arc_commit", "qfleet_commit"}:
        _refuse()
    arc_commit = _require_commit(compatibility["arc_commit"])
    qfleet_commit = _require_commit(compatibility["qfleet_commit"])
    policy_version = _require_policy_version(payload["policy_version"])
    execution_root = _relative_text(payload["execution_root"])
    qualifier_path = _relative_text(payload["qualifier"])
    raw_files = payload["files"]
    if not isinstance(raw_files, list) or not raw_files or len(raw_files) > _MAX_CLOSURE_FILES:
        _refuse()
    files: dict[str, tuple[str, bool]] = {}
    for entry in raw_files:
        if not isinstance(entry, Mapping) or set(entry) != {"path", "sha256", "executable"}:
            _refuse()
        path = _relative_text(entry["path"])
        digest = _require_sha256(entry["sha256"])
        executable = entry["executable"]
        if (
            not isinstance(executable, bool)
            or len(PurePosixPath(path).parts) > _MAX_CLOSURE_DEPTH
            or path in files
        ):
            _refuse()
        files[path] = (digest, executable)
    qualifier = files.get(qualifier_path)
    if qualifier is None or not qualifier[1]:
        _refuse()
    return (
        source_commit,
        arc_commit,
        qfleet_commit,
        policy_version,
        execution_root,
        qualifier_path,
        files,
    )


def _inventory_execution_root(
    source_root: Path,
    execution_root: str,
) -> tuple[dict[str, durable_json.JsonFileIdentity], tuple[BundleDirectory, ...]]:
    source_fd, _source_identity = _open_directory(source_root)
    opened = [(source_fd, _source_identity)]
    try:
        execution_fd = source_fd
        execution_identity = _identity(os.fstat(source_fd))
        for part in PurePosixPath(execution_root).parts:
            child_fd, child_identity = _open_child_directory(execution_fd, part)
            opened.append((child_fd, child_identity))
            execution_fd, execution_identity = child_fd, child_identity
        files: dict[str, durable_json.JsonFileIdentity] = {}
        directories: list[BundleDirectory] = []
        entry_count = 0
        file_count = 0
        directory_count = 1
        aggregate_bytes = 0
        if directory_count > _MAX_CLOSURE_DIRECTORIES:
            _refuse()

        def walk(
            directory_fd: int,
            relative: PurePosixPath,
            identity: durable_json.JsonFileIdentity,
            depth: int,
        ) -> None:
            nonlocal aggregate_bytes, directory_count, entry_count, file_count
            directories.append(BundleDirectory(relative.as_posix(), identity))
            for entry in os.scandir(directory_fd):
                entry_count += 1
                if entry_count > _MAX_CLOSURE_ENTRIES or depth + 1 > _MAX_CLOSURE_DEPTH:
                    _refuse()
                entry_stat = entry.stat(follow_symlinks=False)
                child_relative = relative / entry.name
                if stat.S_ISLNK(entry_stat.st_mode):
                    _refuse()
                if stat.S_ISREG(entry_stat.st_mode):
                    if entry_stat.st_nlink != 1:
                        _refuse()
                    file_count += 1
                    aggregate_bytes += entry_stat.st_size
                    if file_count > _MAX_CLOSURE_FILES or aggregate_bytes > _MAX_CLOSURE_BYTES:
                        _refuse()
                    files[child_relative.as_posix()] = _identity(entry_stat)
                    continue
                if not stat.S_ISDIR(entry_stat.st_mode):
                    _refuse()
                directory_count += 1
                if directory_count > _MAX_CLOSURE_DIRECTORIES:
                    _refuse()
                child_fd, child_identity = _open_child_directory(directory_fd, entry.name)
                try:
                    walk(child_fd, child_relative, child_identity, depth + 1)
                finally:
                    os.close(child_fd)

        walk(execution_fd, PurePosixPath("."), execution_identity, 0)
        for descriptor, identity in opened:
            if _identity(os.fstat(descriptor)) != identity:
                _refuse()
        return files, tuple(sorted(directories, key=lambda item: item.relative_path))
    finally:
        for descriptor, _identity_before in reversed(opened):
            os.close(descriptor)


def _collect_bundle(
    source_root: Path,
    bundle_path: Path,
    *,
    expected_sha256: str,
    expected_source_commit: str,
    expected_arc_commit: str,
    expected_qfleet_commit: str,
    expected_policy_version: str,
) -> QualificationBundle:
    bundle_relative = _relative_to(source_root, bundle_path)
    bundle_raw, bundle_identity = _read_regular_file(source_root, bundle_relative)
    bundle_sha256 = hashlib.sha256(bundle_raw).hexdigest()
    if not hmac.compare_digest(bundle_sha256, expected_sha256):
        _refuse()
    (
        source_commit,
        arc_commit,
        qfleet_commit,
        policy_version,
        execution_root,
        qualifier_path,
        declared_files,
    ) = _parse_bundle(_strict_json(bundle_raw))
    if (
        source_commit != expected_source_commit
        or arc_commit != expected_arc_commit
        or qfleet_commit != expected_qfleet_commit
        or policy_version != expected_policy_version
    ):
        _refuse()
    if bundle_relative == execution_root or bundle_relative.startswith(f"{execution_root}/"):
        _refuse()
    inventory, directories = _inventory_execution_root(source_root, execution_root)
    if set(inventory) != set(declared_files):
        _refuse()
    files: list[BundleFile] = []
    for path in sorted(declared_files):
        raw, identity = _read_regular_file(source_root, f"{execution_root}/{path}")
        expected_file_sha256, executable = declared_files[path]
        if (
            identity != inventory[path]
            or not hmac.compare_digest(hashlib.sha256(raw).hexdigest(), expected_file_sha256)
            or bool(stat.S_IMODE(identity.mode) & 0o111) != executable
        ):
            _refuse()
        files.append(BundleFile(path, expected_file_sha256, executable, identity))
    after_inventory, after_directories = _inventory_execution_root(source_root, execution_root)
    if inventory != after_inventory or directories != after_directories:
        _refuse()
    source_fd, source_root_identity = _open_directory(source_root)
    os.close(source_fd)
    bundle_raw_after, bundle_identity_after = _read_regular_file(source_root, bundle_relative)
    if bundle_identity != bundle_identity_after or bundle_raw != bundle_raw_after:
        _refuse()
    execution_root_path = source_root.joinpath(*PurePosixPath(execution_root).parts)
    declared_file_paths = tuple(
        execution_root_path.joinpath(*PurePosixPath(path).parts)
        for path in sorted(declared_files)
    )
    return QualificationBundle(
        source_root=source_root,
        source_root_identity=source_root_identity,
        bundle_path=bundle_path,
        bundle_sha256=bundle_sha256,
        bundle_identity=bundle_identity,
        source_commit=source_commit,
        arc_commit=arc_commit,
        qfleet_commit=qfleet_commit,
        policy_version=policy_version,
        execution_root=execution_root_path,
        qualifier_path=execution_root_path.joinpath(*PurePosixPath(qualifier_path).parts),
        declared_file_paths=declared_file_paths,
        files=tuple(files),
        directories=directories,
    )


def load_qualification_bundle(
    source_root: os.PathLike[str] | str,
    bundle_path: os.PathLike[str] | str,
    *,
    expected_sha256: str,
    expected_source_commit: str,
    expected_arc_commit: str,
    expected_qfleet_commit: str,
    expected_policy_version: str,
) -> QualificationBundle:
    """Read an exact immutable qualification bundle without executing it."""
    try:
        checked_source_root = _absolute_path(source_root)
        checked_bundle_path = _absolute_path(bundle_path)
        checked_sha256 = _require_sha256(expected_sha256)
        checked_source_commit = _require_commit(expected_source_commit)
        checked_arc_commit = _require_commit(expected_arc_commit)
        checked_qfleet_commit = _require_commit(expected_qfleet_commit)
        checked_policy_version = _require_policy_version(expected_policy_version)
        first = _collect_bundle(
            checked_source_root,
            checked_bundle_path,
            expected_sha256=checked_sha256,
            expected_source_commit=checked_source_commit,
            expected_arc_commit=checked_arc_commit,
            expected_qfleet_commit=checked_qfleet_commit,
            expected_policy_version=checked_policy_version,
        )
        second = _collect_bundle(
            checked_source_root,
            checked_bundle_path,
            expected_sha256=checked_sha256,
            expected_source_commit=checked_source_commit,
            expected_arc_commit=checked_arc_commit,
            expected_qfleet_commit=checked_qfleet_commit,
            expected_policy_version=checked_policy_version,
        )
    except QualificationBundleRefusal:
        raise
    except (OSError, TypeError, ValueError, UnicodeError, json.JSONDecodeError):
        raise QualificationBundleRefusal() from None
    if first != second:
        _refuse()
    return first


def recheck_qualification_bundle(bundle: QualificationBundle) -> None:
    """Refuse if the already-bound manifest or execution closure has changed."""
    if not isinstance(bundle, QualificationBundle):
        _refuse()
    observed = load_qualification_bundle(
        bundle.source_root,
        bundle.bundle_path,
        expected_sha256=bundle.bundle_sha256,
        expected_source_commit=bundle.source_commit,
        expected_arc_commit=bundle.arc_commit,
        expected_qfleet_commit=bundle.qfleet_commit,
        expected_policy_version=bundle.policy_version,
    )
    if observed != bundle:
        _refuse()
