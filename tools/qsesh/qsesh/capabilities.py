"""Executable runtime capability probes and the fail-closed preflight gate."""

from __future__ import annotations

import importlib
import sys
import tempfile
from dataclasses import dataclass
from types import ModuleType
from typing import Any

from .errors import QseshError as RegistryQseshError

MINIMUM_PYTHON = (3, 12, 0)
CAPABILITY_ERROR_CODE = "QS-E-CAPABILITY"

# Every other qsesh primitive (XDG paths, the fcntl_lock probe, SQLite) is
# already portable across POSIX platforms; fcntl_lock above is what actually
# filters out non-Unix hosts. This list is closed to the platforms qSesh is
# verified on (macOS dev hosts, Linux CI runners) rather than open to
# "anything with fcntl", so an unverified POSIX platform still fails closed.
SUPPORTED_PLATFORMS = ("darwin", "linux")


class QseshError(RegistryQseshError):
    """Capability failure retaining its sorted missing-capability tuple."""

    def __init__(self, *, code: str, missing: tuple[str, ...]) -> None:
        self.missing = missing
        super().__init__(
            code,
            phase="preflight",
            detail=", ".join(missing),
        )


@dataclass(frozen=True)
class RuntimeCapabilities:
    python_version: tuple[int, int, int]
    sqlite_version: tuple[int, int, int]
    fts5: bool
    foreign_keys: bool
    fcntl_lock: bool
    platform: str


def _version_tuple(value: str) -> tuple[int, int, int]:
    try:
        parts = [int(part) for part in value.split(".")[:3]]
    except ValueError:
        return (0, 0, 0)
    padded = [*parts, 0, 0, 0]
    return padded[0], padded[1], padded[2]


def _probe_fts5(connection: Any) -> bool:
    connection.execute("CREATE VIRTUAL TABLE qsesh_fts_probe USING fts5(body)")
    connection.execute(
        "INSERT INTO qsesh_fts_probe(body) VALUES (?)",
        ("qseshcapabilityneedle",),
    )
    row = connection.execute(
        "SELECT count(*) FROM qsesh_fts_probe WHERE body MATCH ?",
        ("qseshcapabilityneedle",),
    ).fetchone()
    return row == (1,)


def _probe_foreign_keys(
    connection: Any,
    integrity_error: type[Exception],
) -> bool:
    connection.execute("PRAGMA foreign_keys = ON")
    if connection.execute("PRAGMA foreign_keys").fetchone() != (1,):
        return False
    connection.execute("CREATE TABLE qsesh_parent(id INTEGER PRIMARY KEY)")
    connection.execute(
        "CREATE TABLE qsesh_child("
        "parent_id INTEGER NOT NULL REFERENCES qsesh_parent(id))"
    )
    try:
        connection.execute("INSERT INTO qsesh_child(parent_id) VALUES (1)")
    except integrity_error:
        return True
    return False


def _sqlite_probe(
    sqlite: ModuleType,
    probe: Any,
    *probe_args: object,
) -> bool:
    try:
        with sqlite.connect(":memory:") as connection:
            return bool(probe(connection, *probe_args))
    except sqlite.Error:
        return False


def _probe_sqlite() -> tuple[tuple[int, int, int], bool, bool]:
    try:
        sqlite = importlib.import_module("sqlite3")
    except ImportError:
        return (0, 0, 0), False, False

    version = _version_tuple(getattr(sqlite, "sqlite_version", ""))
    fts5 = _sqlite_probe(sqlite, _probe_fts5)
    foreign_keys = _sqlite_probe(
        sqlite,
        _probe_foreign_keys,
        sqlite.IntegrityError,
    )
    return version, fts5, foreign_keys


def _probe_fcntl_lock() -> bool:
    try:
        fcntl = importlib.import_module("fcntl")
        with tempfile.TemporaryFile() as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    except (ImportError, AttributeError, OSError):
        return False
    return True


def probe_capabilities() -> RuntimeCapabilities:
    sqlite_version, fts5, foreign_keys = _probe_sqlite()
    return RuntimeCapabilities(
        python_version=tuple(sys.version_info[:3]),
        sqlite_version=sqlite_version,
        fts5=fts5,
        foreign_keys=foreign_keys,
        fcntl_lock=_probe_fcntl_lock(),
        platform=sys.platform,
    )


def require_capabilities(capabilities: RuntimeCapabilities) -> None:
    missing: list[str] = []
    if capabilities.python_version < MINIMUM_PYTHON:
        missing.append("python_version")
    if capabilities.sqlite_version <= (0, 0, 0):
        missing.append("sqlite_version")
    if not capabilities.fts5:
        missing.append("fts5")
    if not capabilities.foreign_keys:
        missing.append("foreign_keys")
    if not capabilities.fcntl_lock:
        missing.append("fcntl_lock")
    if capabilities.platform not in SUPPORTED_PLATFORMS:
        missing.append("platform")

    if missing:
        raise QseshError(
            code=CAPABILITY_ERROR_CODE,
            missing=tuple(sorted(missing)),
        )
