"""T03 real-filesystem contracts for confined qSesh-owned paths."""

from __future__ import annotations

import os
import stat
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest
from qsesh.paths import (
    PathConfinementError,
    QseshPaths,
    atomic_temp_path,
    confined_child,
    ensure_private_dir,
    open_private_new,
)


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.lstat().st_mode)


def _all_paths(paths: QseshPaths) -> tuple[Path, ...]:
    return (
        paths.config_dir,
        paths.config_file,
        paths.data_dir,
        paths.archive_dir,
        paths.temp_dir,
        paths.lock_file,
        paths.log_file,
    )


def test_default_xdg_paths_are_absolute_resolved_and_nonoverlapping(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    paths = QseshPaths.from_env({}, home)
    expected_home = home.resolve()

    assert paths == QseshPaths(
        config_dir=expected_home / ".config/qsesh",
        config_file=expected_home / ".config/qsesh/config.json",
        data_dir=expected_home / ".local/share/qsesh",
        archive_dir=expected_home / ".local/share/qsesh/archive",
        temp_dir=expected_home / ".cache/qsesh/tmp",
        lock_file=expected_home / ".local/share/qsesh/qsesh.lock",
        log_file=expected_home / ".local/share/qsesh/qsesh-index.jsonl",
    )
    assert all(
        path.is_absolute() and path == path.resolve() for path in _all_paths(paths)
    )
    assert not paths.temp_dir.is_relative_to(paths.data_dir)
    assert not paths.data_dir.is_relative_to(paths.temp_dir)
    assert not paths.config_dir.is_relative_to(paths.data_dir)
    assert not paths.data_dir.is_relative_to(paths.config_dir)


def test_injected_xdg_roots_ignore_the_process_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    poison = tmp_path / "process-environment-must-not-win"
    monkeypatch.setenv("XDG_DATA_HOME", str(poison))
    env = {
        "XDG_CONFIG_HOME": str(tmp_path / "config-root"),
        "XDG_DATA_HOME": str(tmp_path / "data-root"),
        "XDG_CACHE_HOME": str(tmp_path / "cache-root"),
    }

    paths = QseshPaths.from_env(env, tmp_path / "home")

    assert paths.config_dir == (tmp_path / "config-root/qsesh").resolve()
    assert paths.data_dir == (tmp_path / "data-root/qsesh").resolve()
    assert paths.archive_dir == (tmp_path / "data-root/qsesh/archive").resolve()
    assert paths.temp_dir == (tmp_path / "cache-root/qsesh/tmp").resolve()
    assert poison.resolve() not in _all_paths(paths)


def test_qsesh_paths_are_frozen(tmp_path: Path) -> None:
    paths = QseshPaths.from_env({}, tmp_path / "home")

    with pytest.raises(FrozenInstanceError):
        paths.data_dir = tmp_path  # type: ignore[misc]


def test_relative_xdg_root_fails_closed_without_path_disclosure(tmp_path: Path) -> None:
    with pytest.raises(PathConfinementError) as caught:
        QseshPaths.from_env({"XDG_DATA_HOME": "relative/data"}, tmp_path / "home")

    assert caught.value.code == "QS-E-PATH-CONFINEMENT"
    assert caught.value.field == "XDG_DATA_HOME"
    assert str(caught.value) == (
        "qSesh-owned path escaped or crossed a protected root at XDG_DATA_HOME"
    )
    assert str(tmp_path) not in str(caught.value)


def test_overlapping_durable_and_temp_roots_fail_closed(tmp_path: Path) -> None:
    shared = tmp_path / "shared"
    env = {
        "XDG_DATA_HOME": str(shared),
        "XDG_CACHE_HOME": str(shared),
    }

    with pytest.raises(PathConfinementError) as caught:
        QseshPaths.from_env(env, tmp_path / "home")

    assert (caught.value.code, caught.value.field) == (
        "QS-E-PATH-CONFINEMENT",
        "root_overlap",
    )


def test_private_layout_uses_exact_modes_even_under_umask_zero(tmp_path: Path) -> None:
    paths = QseshPaths.from_env({}, tmp_path / "home")
    previous_umask = os.umask(0)
    try:
        for directory in (
            paths.config_dir,
            paths.data_dir,
            paths.archive_dir,
            paths.temp_dir,
        ):
            ensure_private_dir(directory)
        for file_path in (paths.lock_file, paths.log_file):
            with open_private_new(file_path) as handle:
                handle.write(b"{}\n")
    finally:
        os.umask(previous_umask)

    assert [
        _mode(path)
        for path in (
            paths.config_dir,
            paths.data_dir,
            paths.archive_dir,
            paths.temp_dir,
        )
    ] == [
        0o700,
        0o700,
        0o700,
        0o700,
    ]
    assert [_mode(path) for path in (paths.lock_file, paths.log_file)] == [
        0o600,
        0o600,
    ]


def test_ensure_private_dir_corrects_an_existing_permissive_mode(
    tmp_path: Path,
) -> None:
    directory = tmp_path / "existing"
    directory.mkdir(mode=0o777)
    directory.chmod(0o777)

    result = ensure_private_dir(directory)

    assert result == directory.resolve()
    assert _mode(directory) == 0o700


def test_open_private_new_is_exclusive(tmp_path: Path) -> None:
    target = tmp_path / "private/record.json"
    with open_private_new(target) as handle:
        handle.write(b"first")

    with pytest.raises(FileExistsError):
        open_private_new(target)

    assert target.read_bytes() == b"first"
    assert _mode(target) == 0o600


def test_confined_child_accepts_only_safe_relative_components(tmp_path: Path) -> None:
    root = ensure_private_dir(tmp_path / "archive")

    child = confined_child(root, "claude", "qs-ab3k7m9x2p")

    assert child == (root / "claude/qs-ab3k7m9x2p").resolve()
    assert child.is_relative_to(root)
    assert not child.exists()


def test_confined_child_rejects_traversal_and_separators_without_writes(
    tmp_path: Path,
) -> None:
    root = ensure_private_dir(tmp_path / "archive")
    before = tuple(root.iterdir())

    for component in (
        "",
        ".",
        "..",
        "../outside",
        "a/b",
        "a\\b",
        "/absolute",
        "nul\0byte",
        "unicodé",
        "a" * 256,
    ):
        with pytest.raises(PathConfinementError) as caught:
            confined_child(root, component)
        assert caught.value.code == "QS-E-PATH-CONFINEMENT"
        assert caught.value.field == "component"
        assert str(tmp_path) not in str(caught.value)

    assert tuple(root.iterdir()) == before


def test_symlinked_archive_component_is_rejected_without_outside_write(
    tmp_path: Path,
) -> None:
    paths = QseshPaths.from_env({}, tmp_path / "home")
    ensure_private_dir(paths.data_dir)
    outside = ensure_private_dir(tmp_path / "outside")
    paths.archive_dir.symlink_to(outside, target_is_directory=True)

    with pytest.raises(PathConfinementError) as caught:
        ensure_private_dir(paths.archive_dir / "claude")

    assert caught.value.code == "QS-E-PATH-CONFINEMENT"
    assert caught.value.field == "symlink"
    assert tuple(outside.iterdir()) == ()


def test_open_private_new_rejects_symlink_target_without_modifying_referent(
    tmp_path: Path,
) -> None:
    parent = ensure_private_dir(tmp_path / "private")
    referent = tmp_path / "outside.txt"
    referent.write_bytes(b"sentinel")
    target = parent / "target"
    target.symlink_to(referent)

    with pytest.raises(PathConfinementError) as caught:
        open_private_new(target)

    assert caught.value.code == "QS-E-PATH-CONFINEMENT"
    assert caught.value.field == "symlink"
    assert referent.read_bytes() == b"sentinel"


def test_atomic_temp_path_is_a_validated_sibling_on_the_same_filesystem(
    tmp_path: Path,
) -> None:
    parent = ensure_private_dir(tmp_path / "archive/claude")
    target = parent / "session.jsonl.gz"

    temporary = atomic_temp_path(target, token="attempt-0001")

    assert temporary == parent / ".session.jsonl.gz.attempt-0001.tmp"
    assert temporary.parent == target.parent
    assert temporary.parent.stat().st_dev == target.parent.stat().st_dev


def test_atomic_temp_path_rejects_unsafe_token(tmp_path: Path) -> None:
    parent = ensure_private_dir(tmp_path / "archive")

    with pytest.raises(PathConfinementError) as caught:
        atomic_temp_path(parent / "session.jsonl.gz", token="../escape")

    assert (caught.value.code, caught.value.field) == (
        "QS-E-PATH-CONFINEMENT",
        "component",
    )
    assert tuple(parent.iterdir()) == ()
