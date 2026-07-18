"""XDG path derivation and private, symlink-refusing filesystem helpers."""

from __future__ import annotations

import errno
import os
import re
import stat
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from .errors import QseshError

PATH_ERROR_CODE = "QS-E-PATH-CONFINEMENT"
_SAFE_COMPONENT = re.compile(r"[a-z0-9][a-z0-9._-]{0,254}").fullmatch


class PathConfinementError(QseshError):
    """Safe path-boundary failure retaining its field alias."""

    def __init__(self, field: str) -> None:
        self.field = field
        super().__init__(PATH_ERROR_CODE, phase=field)


def _reject(field: str) -> None:
    raise PathConfinementError(field)


def _absolute_lexical(path: Path, field: str = "path") -> Path:
    candidate = Path(path)
    if not candidate.is_absolute() or ".." in candidate.parts:
        _reject(field)
    return Path(os.path.abspath(candidate))


def _resolved_root(value: Path | str, field: str) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute() or ".." in candidate.parts:
        _reject(field)
    try:
        return candidate.resolve(strict=False)
    except (OSError, RuntimeError):
        _reject(field)


def _xdg_root(
    env: Mapping[str, str],
    key: str,
    default: Path,
) -> Path:
    value = env.get(key)
    if value is None or value == "":
        return default.resolve(strict=False)
    return _resolved_root(value, key)


def _paths_overlap(left: Path, right: Path) -> bool:
    return left == right or left.is_relative_to(right) or right.is_relative_to(left)


@dataclass(frozen=True)
class QseshPaths:
    config_dir: Path
    config_file: Path
    data_dir: Path
    archive_dir: Path
    temp_dir: Path
    lock_file: Path
    log_file: Path

    @classmethod
    def from_env(cls, env: Mapping[str, str], home: Path) -> QseshPaths:
        home_root = _resolved_root(home, "home")
        config_root = _xdg_root(env, "XDG_CONFIG_HOME", home_root / ".config")
        data_root = _xdg_root(env, "XDG_DATA_HOME", home_root / ".local/share")
        cache_root = _xdg_root(env, "XDG_CACHE_HOME", home_root / ".cache")

        config_dir = (config_root / "qsesh").resolve(strict=False)
        data_dir = (data_root / "qsesh").resolve(strict=False)
        temp_dir = (cache_root / "qsesh/tmp").resolve(strict=False)
        primary_roots = (config_dir, data_dir, temp_dir)
        if any(
            _paths_overlap(left, right)
            for index, left in enumerate(primary_roots)
            for right in primary_roots[index + 1 :]
        ):
            _reject("root_overlap")

        return cls(
            config_dir=config_dir,
            config_file=(config_dir / "config.json").resolve(strict=False),
            data_dir=data_dir,
            archive_dir=(data_dir / "archive").resolve(strict=False),
            temp_dir=temp_dir,
            lock_file=(data_dir / "qsesh.lock").resolve(strict=False),
            log_file=(data_dir / "qsesh-index.jsonl").resolve(strict=False),
        )


def _validate_directory(stat_result: os.stat_result) -> None:
    if stat.S_ISLNK(stat_result.st_mode):
        _reject("symlink")
    if not stat.S_ISDIR(stat_result.st_mode):
        _reject("non_directory")


def _force_private_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        if error.errno in {errno.ELOOP, errno.ENOTDIR}:
            _reject("symlink" if error.errno == errno.ELOOP else "non_directory")
        raise
    try:
        _validate_directory(os.fstat(descriptor))
        os.fchmod(descriptor, 0o700)
    finally:
        os.close(descriptor)


def ensure_private_dir(path: Path) -> Path:
    target = _absolute_lexical(path)
    if target == Path(target.anchor):
        _reject("path")

    current = Path(target.anchor)
    for component in target.parts[1:]:
        current /= component
        created = False
        try:
            current_stat = current.lstat()
        except FileNotFoundError:
            try:
                os.mkdir(current, 0o700)
                created = True
            except FileExistsError:
                pass
            current_stat = current.lstat()
        _validate_directory(current_stat)
        if created or current == target:
            _force_private_directory(current)

    return target.resolve(strict=True)


def _validate_component(component: str) -> None:
    if not isinstance(component, str) or _SAFE_COMPONENT(component) is None:
        _reject("component")


def _assert_directory_chain(path: Path) -> None:
    target = _absolute_lexical(path)
    current = Path(target.anchor)
    for component in target.parts[1:]:
        current /= component
        try:
            current_stat = current.lstat()
        except FileNotFoundError:
            return
        _validate_directory(current_stat)


def _assert_not_symlink(path: Path) -> None:
    try:
        path_stat = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(path_stat.st_mode):
        _reject("symlink")


def confined_child(root: Path, *components: str) -> Path:
    root_path = _absolute_lexical(root, "root")
    _assert_directory_chain(root_path)
    candidate = root_path
    for index, component in enumerate(components):
        _validate_component(component)
        candidate /= component
        _assert_not_symlink(candidate)
        if index < len(components) - 1:
            try:
                candidate_stat = candidate.lstat()
            except FileNotFoundError:
                continue
            _validate_directory(candidate_stat)

    resolved = candidate.resolve(strict=False)
    if not resolved.is_relative_to(root_path.resolve(strict=False)):
        _reject("component")
    return resolved


def open_private_new(path: Path) -> BinaryIO:
    target = _absolute_lexical(path)
    ensure_private_dir(target.parent)
    try:
        target_stat = target.lstat()
    except FileNotFoundError:
        pass
    else:
        if stat.S_ISLNK(target_stat.st_mode):
            _reject("symlink")
        if not stat.S_ISREG(target_stat.st_mode):
            _reject("non_regular")
        raise FileExistsError(errno.EEXIST, "private file already exists")

    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        descriptor = os.open(target, flags, 0o600)
    except FileExistsError:
        _assert_not_symlink(target)
        raise FileExistsError(errno.EEXIST, "private file already exists") from None
    except OSError as error:
        if error.errno == errno.ELOOP:
            _reject("symlink")
        raise

    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            _reject("non_regular")
        os.fchmod(descriptor, 0o600)
        return os.fdopen(descriptor, "wb")
    except BaseException:
        os.close(descriptor)
        raise


def atomic_temp_path(target: Path, *, token: str) -> Path:
    target_path = _absolute_lexical(target)
    _validate_component(target_path.name)
    _validate_component(token)
    _assert_directory_chain(target_path.parent)
    _assert_not_symlink(target_path)
    temporary = target_path.parent / f".{target_path.name}.{token}.tmp"
    _assert_not_symlink(temporary)
    return temporary.resolve(strict=False)
