"""T02 executable runtime capability and fail-closed requirement contracts."""

from __future__ import annotations

import sqlite3
import sys
from dataclasses import FrozenInstanceError, replace

import pytest
from qsesh.capabilities import (
    QseshError,
    RuntimeCapabilities,
    _probe_foreign_keys,
    _probe_fts5,
    probe_capabilities,
    require_capabilities,
)

SUPPORTED_CAPABILITIES = RuntimeCapabilities(
    python_version=(3, 12, 0),
    sqlite_version=(3, 1, 0),
    fts5=True,
    foreign_keys=True,
    fcntl_lock=True,
    platform="darwin",
)


def test_sqlite_probes_execute_fts5_match_and_foreign_key_violation() -> None:
    fts_statements: list[str] = []
    with sqlite3.connect(":memory:") as connection:
        connection.set_trace_callback(fts_statements.append)
        assert _probe_fts5(connection) is True

    normalized_fts = "\n".join(fts_statements).upper()
    assert "CREATE VIRTUAL TABLE" in normalized_fts
    assert "INSERT INTO" in normalized_fts
    assert "MATCH" in normalized_fts

    foreign_key_statements: list[str] = []
    with sqlite3.connect(":memory:") as connection:
        connection.set_trace_callback(foreign_key_statements.append)
        assert _probe_foreign_keys(connection, sqlite3.IntegrityError) is True

    normalized_foreign_keys = "\n".join(foreign_key_statements).upper()
    assert "PRAGMA FOREIGN_KEYS = ON" in normalized_foreign_keys
    assert "REFERENCES" in normalized_foreign_keys
    assert "INSERT INTO" in normalized_foreign_keys


def test_probe_reports_observed_runtime_and_real_lock_support() -> None:
    capabilities = probe_capabilities()

    assert capabilities.python_version == tuple(sys.version_info[:3])
    assert capabilities.sqlite_version == tuple(
        int(part) for part in sqlite3.sqlite_version.split(".")
    )
    assert capabilities.fts5 is True
    assert capabilities.foreign_keys is True
    assert capabilities.fcntl_lock is True
    assert capabilities.platform == sys.platform

    if sys.platform in ("darwin", "linux"):
        assert require_capabilities(capabilities) is None
    else:
        with pytest.raises(QseshError) as caught:
            require_capabilities(capabilities)
        assert caught.value.missing == ("platform",)


def _missing_capability_result(
    field: str,
    unsupported_value: object,
) -> tuple[str, tuple[str, ...], str]:
    capabilities = replace(SUPPORTED_CAPABILITIES, **{field: unsupported_value})
    with pytest.raises(QseshError) as caught:
        require_capabilities(capabilities)
    return caught.value.code, caught.value.missing, str(caught.value)


def test_unsupported_python_version_fails_closed() -> None:
    assert _missing_capability_result("python_version", (3, 11, 9)) == (
        "QS-E-CAPABILITY",
        ("python_version",),
        "required runtime capability unavailable at preflight: python_version",
    )


def test_missing_sqlite_version_fails_closed() -> None:
    assert _missing_capability_result("sqlite_version", (0, 0, 0)) == (
        "QS-E-CAPABILITY",
        ("sqlite_version",),
        "required runtime capability unavailable at preflight: sqlite_version",
    )


def test_missing_fts5_fails_closed() -> None:
    assert _missing_capability_result("fts5", False) == (
        "QS-E-CAPABILITY",
        ("fts5",),
        "required runtime capability unavailable at preflight: fts5",
    )


def test_missing_foreign_keys_fails_closed() -> None:
    assert _missing_capability_result("foreign_keys", False) == (
        "QS-E-CAPABILITY",
        ("foreign_keys",),
        "required runtime capability unavailable at preflight: foreign_keys",
    )


def test_missing_fcntl_lock_fails_closed() -> None:
    assert _missing_capability_result("fcntl_lock", False) == (
        "QS-E-CAPABILITY",
        ("fcntl_lock",),
        "required runtime capability unavailable at preflight: fcntl_lock",
    )


def test_unsupported_platform_fails_closed() -> None:
    assert _missing_capability_result("platform", "win32") == (
        "QS-E-CAPABILITY",
        ("platform",),
        "required runtime capability unavailable at preflight: platform",
    )


def test_linux_platform_is_supported() -> None:
    capabilities = replace(SUPPORTED_CAPABILITIES, platform="linux")
    assert require_capabilities(capabilities) is None


def test_multiple_missing_capabilities_are_sorted_and_nonempty() -> None:
    capabilities = RuntimeCapabilities(
        python_version=(3, 11, 9),
        sqlite_version=(0, 0, 0),
        fts5=False,
        foreign_keys=False,
        fcntl_lock=False,
        platform="win32",
    )

    with pytest.raises(QseshError) as caught:
        require_capabilities(capabilities)

    expected = (
        "fcntl_lock",
        "foreign_keys",
        "fts5",
        "platform",
        "python_version",
        "sqlite_version",
    )
    assert caught.value.code == "QS-E-CAPABILITY"
    assert caught.value.missing == expected
    assert str(caught.value).endswith(", ".join(expected))


def test_runtime_capabilities_are_frozen() -> None:
    with pytest.raises(FrozenInstanceError):
        SUPPORTED_CAPABILITIES.fts5 = False  # type: ignore[misc]
