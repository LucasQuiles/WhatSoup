"""T08 read-only filesystem and bounded OpenCode command boundary contracts."""

from __future__ import annotations

import os
import re
import stat
import subprocess
import time
from dataclasses import FrozenInstanceError
from pathlib import Path
from types import SimpleNamespace

import pytest
import qsesh.sources.base as source_base
from qsesh.capabilities import QseshError as CapabilityError
from qsesh.config import ConfigError
from qsesh.errors import ERROR_REGISTRY, QseshError
from qsesh.model import FileStamp
from qsesh.paths import PathConfinementError
from qsesh.qid import QidCollisionError, QidError
from qsesh.sources.base import (
    CommandResult,
    CommandRunner,
    OpenCodeCommandRunner,
    ReadOnlySourceFS,
    SourceFS,
    SourceRead,
)

EXPECTED_ERROR_CODES = {
    "QS-E-ALREADY-RUNNING",
    "QS-E-ARCHIVE",
    "QS-E-ARCHIVE-COLLISION",
    "QS-E-BOUNDARY",
    "QS-E-CAPABILITY",
    "QS-E-CONFIG",
    "QS-E-COUNT-MISMATCH",
    "QS-E-DISTILL",
    "QS-E-INSTALL-CONFLICT",
    "QS-E-INTERNAL",
    "QS-E-MIGRATION",
    "QS-E-OPENCODE-EXPORT",
    "QS-E-OPENCODE-LIST",
    "QS-E-PATH-CONFINEMENT",
    "QS-E-QID-COLLISION",
    "QS-E-RESOLVE-AMBIGUOUS",
    "QS-E-ROLLBACK",
    "QS-E-SOURCE-READ",
    "QS-E-SOURCE-SCHEMA",
    "QS-E-SOURCE-VERSION",
    "QS-E-SQLITE",
    "QS-E-TELEMETRY",
    "QS-E-TIMEOUT",
    "QS-E-USAGE",
}


def _make_executable(path: Path, body: str) -> Path:
    path.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def _private_workspace(tmp_path: Path) -> tuple[Path, Path]:
    workspace = tmp_path / "private-workspace"
    workspace.mkdir(mode=0o700)
    workspace.chmod(0o700)
    for name in ("home", "xdg-data", "xdg-config", "xdg-cache", "tmp", "store"):
        child = workspace / name
        child.mkdir(mode=0o700)
        child.chmod(0o700)
    copied_db = workspace / "store/opencode.db"
    copied_db.write_bytes(b"x" * 4096)
    copied_db.chmod(0o600)
    return workspace, copied_db


def _runner(tmp_path: Path, body: str = "printf ok") -> OpenCodeCommandRunner:
    workspace, copied_db = _private_workspace(tmp_path)
    return OpenCodeCommandRunner(
        _make_executable(tmp_path / "opencode", body),
        private_workspace=workspace,
        copied_db=copied_db,
    )


def _assert_error(error: QseshError, *, code: str, phase: str) -> None:
    assert error.code == code
    assert error.phase == phase
    assert error.scope in {"candidate", "run", "command", "installation"}
    assert str(error) == ERROR_REGISTRY[code].message_template.format(phase=phase)


def test_error_registry_is_the_exact_data_backed_twenty_four_code_catalog() -> None:
    assert set(ERROR_REGISTRY) == EXPECTED_ERROR_CODES
    assert len(ERROR_REGISTRY) == 24
    assert all(spec.code == code for code, spec in ERROR_REGISTRY.items())
    assert all(spec.runbook_anchor.startswith("#") for spec in ERROR_REGISTRY.values())


def test_all_operational_error_types_share_the_registry_backed_base() -> None:
    for error_type in (
        CapabilityError,
        ConfigError,
        PathConfinementError,
        QidCollisionError,
        QidError,
    ):
        assert issubclass(error_type, QseshError)


def test_every_error_code_literal_in_the_runtime_package_is_registered() -> None:
    package = Path(source_base.__file__).resolve().parents[1]
    observed = {
        token
        for path in package.rglob("*.py")
        for token in re.findall(r"QS-E-[A-Z-]+", path.read_text())
    }
    assert observed <= set(ERROR_REGISTRY)


def test_source_protocol_exposes_only_iterate_stat_and_read() -> None:
    public = {
        name
        for name in SourceFS.__dict__
        if not name.startswith("_") and name not in {"__module__", "__doc__"}
    }
    assert public == {"iter_files", "read_bytes", "stat"}
    assert not any(
        hasattr(ReadOnlySourceFS, name)
        for name in ("delete", "mkdir", "rename", "replace", "touch", "write_bytes")
    )


def test_command_protocol_has_one_bounded_argv_method() -> None:
    public = {
        name
        for name in CommandRunner.__dict__
        if not name.startswith("_") and name not in {"__module__", "__doc__"}
    }
    assert public == {"run"}


def test_private_workspace_and_copied_db_are_exactly_confined_and_private(
    tmp_path: Path,
) -> None:
    executable = _make_executable(tmp_path / "opencode", "printf ok")
    workspace, copied_db = _private_workspace(tmp_path)

    runner = OpenCodeCommandRunner(
        executable,
        private_workspace=workspace,
        copied_db=copied_db,
    )
    result = runner.run(
        (str(runner.executable), "--pure", "--version"),
        timeout_s=1.0,
        stdout_limit=64,
    )

    assert result.stdout == b"ok"
    assert runner.private_workspace == workspace
    assert runner.copied_db == copied_db
    assert stat.S_IMODE(workspace.stat().st_mode) == 0o700
    assert stat.S_IMODE(copied_db.stat().st_mode) == 0o600


def test_missing_or_unsafe_private_workspace_fails_before_spawn(
    tmp_path: Path,
) -> None:
    executable = _make_executable(tmp_path / "opencode", "printf ok")
    workspace, copied_db = _private_workspace(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    linked = tmp_path / "linked-workspace"
    linked.symlink_to(workspace, target_is_directory=True)

    cases = [
        (tmp_path / "missing", copied_db, "opencode-private-workspace"),
        (Path("relative-workspace"), copied_db, "opencode-private-workspace"),
        (linked, copied_db, "opencode-private-workspace"),
    ]
    workspace.chmod(0o755)
    cases.append((workspace, copied_db, "opencode-private-workspace"))

    for private_workspace, database, phase in cases:
        with pytest.raises(QseshError) as caught:
            OpenCodeCommandRunner(
                executable,
                private_workspace=private_workspace,
                copied_db=database,
            )
        _assert_error(caught.value, code="QS-E-BOUNDARY", phase=phase)


def test_copied_db_must_be_regular_mode_0600_and_beneath_workspace(
    tmp_path: Path,
) -> None:
    executable = _make_executable(tmp_path / "opencode", "printf ok")

    for kind in ("outside", "relative", "traversal", "symlink", "directory", "mode"):
        case_root = tmp_path / kind
        case_root.mkdir()
        workspace, copied_db = _private_workspace(case_root)
        invalid = copied_db
        if kind == "outside":
            invalid = case_root / "outside.db"
            invalid.write_bytes(b"db")
            invalid.chmod(0o600)
        elif kind == "relative":
            invalid = Path("relative/opencode.db")
        elif kind == "traversal":
            invalid = workspace / "store/../opencode.db"
        elif kind == "symlink":
            referent = case_root / "referent.db"
            referent.write_bytes(b"db")
            referent.chmod(0o600)
            invalid = workspace / "store/linked.db"
            invalid.symlink_to(referent)
        elif kind == "directory":
            invalid = workspace / "store/db-directory"
            invalid.mkdir()
        else:
            copied_db.chmod(0o640)

        with pytest.raises(QseshError) as caught:
            OpenCodeCommandRunner(
                executable,
                private_workspace=workspace,
                copied_db=invalid,
            )
        _assert_error(caught.value, code="QS-E-BOUNDARY", phase="opencode-copied-db")


def test_live_or_protected_db_path_is_rejected_before_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = _make_executable(tmp_path / "opencode", "printf ok")
    protected = tmp_path / "live-opencode"
    protected.mkdir()
    live_db = protected / "opencode.db"
    live_db.write_bytes(b"live")
    live_db.chmod(0o600)
    workspace, _ = _private_workspace(tmp_path)
    real_open = source_base.os.open

    def guarded_open(path: object, *args: object, **kwargs: object) -> int:
        if Path(path) == live_db:
            raise AssertionError("protected live database reached os.open")
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(source_base.os, "open", guarded_open)
    with pytest.raises(QseshError) as caught:
        OpenCodeCommandRunner(
            executable,
            private_workspace=workspace,
            copied_db=live_db,
            protected_roots=(protected,),
        )
    _assert_error(caught.value, code="QS-E-BOUNDARY", phase="opencode-copied-db")


def test_copied_db_parent_symlink_escape_is_rejected_before_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = _make_executable(tmp_path / "opencode", "printf ok")
    workspace, copied_db = _private_workspace(tmp_path)
    copied_db.unlink()
    copied_db.parent.rmdir()
    escaped_store = tmp_path / "escaped-store"
    escaped_store.mkdir(mode=0o700)
    escaped_store.chmod(0o700)
    escaped_db = escaped_store / "opencode.db"
    escaped_db.write_bytes(b"escaped")
    escaped_db.chmod(0o600)
    (workspace / "store").symlink_to(escaped_store, target_is_directory=True)
    real_open = source_base.os.open

    def guarded_open(path: object, *args: object, **kwargs: object) -> int:
        if isinstance(path, (str, os.PathLike)) and Path(path) == copied_db:
            raise AssertionError("escaped database reached os.open")
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(source_base.os, "open", guarded_open)
    with pytest.raises(QseshError) as caught:
        OpenCodeCommandRunner(
            executable,
            private_workspace=workspace,
            copied_db=copied_db,
        )
    _assert_error(caught.value, code="QS-E-BOUNDARY", phase="opencode-copied-db")


@pytest.mark.parametrize(
    "runtime_name", ["home", "xdg-data", "xdg-config", "xdg-cache", "tmp"]
)
def test_missing_or_escaped_runtime_directory_fails_before_spawn(
    tmp_path: Path, runtime_name: str
) -> None:
    executable = _make_executable(tmp_path / "opencode", "printf ok")
    workspace, copied_db = _private_workspace(tmp_path)
    runtime = workspace / runtime_name
    runtime.rmdir()

    with pytest.raises(QseshError) as caught:
        OpenCodeCommandRunner(
            executable,
            private_workspace=workspace,
            copied_db=copied_db,
        )
    _assert_error(caught.value, code="QS-E-BOUNDARY", phase="opencode-runtime-dir")


def test_read_only_tree_iter_stat_and_read_succeed_without_mode_changes(
    tmp_path: Path,
) -> None:
    root = tmp_path / "source"
    nested = root / "nested"
    nested.mkdir(parents=True)
    first = root / "b.jsonl"
    second = nested / "a.jsonl"
    first.write_bytes(b"first\n")
    second.write_bytes(b"second\n")
    first.chmod(0o444)
    second.chmod(0o444)
    nested.chmod(0o555)
    root.chmod(0o555)
    boundary = ReadOnlySourceFS()
    try:
        assert boundary.iter_files(root) == (first, second)
        assert boundary.stat(first).size == 6
        read = boundary.read_bytes(first, max_bytes=6)
        assert read.raw_bytes == b"first\n"
        assert read.before == read.after == boundary.stat(first)
        assert stat.S_IMODE(first.stat().st_mode) == 0o444
        assert stat.S_IMODE(root.stat().st_mode) == 0o555
    finally:
        root.chmod(0o755)
        nested.chmod(0o755)
        first.chmod(0o644)
        second.chmod(0o644)


def test_read_uses_only_read_only_no_follow_descriptor_flags(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.jsonl"
    source.write_bytes(b"{}\n")
    calls: list[tuple[Path, int]] = []
    real_open = source_base.os.open

    def spy(path: os.PathLike[str] | str, flags: int, *args: object) -> int:
        calls.append((Path(path), flags))
        return real_open(path, flags, *args)

    monkeypatch.setattr(source_base.os, "open", spy)
    read = ReadOnlySourceFS().read_bytes(source, max_bytes=3)

    assert read.raw_bytes == b"{}\n"
    assert len(calls) == 1
    _, flags = calls[0]
    prohibited = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
    assert flags & prohibited == 0
    assert flags & os.O_RDONLY == os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        assert flags & os.O_NOFOLLOW


def test_source_read_returns_frozen_descriptor_stamps(tmp_path: Path) -> None:
    source = tmp_path / "source.jsonl"
    source.write_bytes(b"{}\n")

    result = ReadOnlySourceFS().read_bytes(source, max_bytes=3)

    assert isinstance(result, SourceRead)
    assert isinstance(result.before, FileStamp)
    assert isinstance(result.after, FileStamp)
    with pytest.raises(FrozenInstanceError):
        result.raw_bytes = b"changed"  # type: ignore[misc]


def test_read_takes_distinct_pre_and_post_fstat_snapshots(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.jsonl"
    source.write_bytes(b"{}\n")
    real_fstat = source_base.os.fstat
    calls = 0

    def changing_fstat(descriptor: int) -> object:
        nonlocal calls
        calls += 1
        observed = real_fstat(descriptor)
        if calls != 3:
            return observed
        return SimpleNamespace(
            st_ctime_ns=observed.st_ctime_ns + 1,
            st_dev=observed.st_dev,
            st_ino=observed.st_ino,
            st_mode=observed.st_mode,
            st_mtime_ns=observed.st_mtime_ns,
            st_size=observed.st_size,
        )

    monkeypatch.setattr(source_base.os, "fstat", changing_fstat)
    result = ReadOnlySourceFS().read_bytes(source, max_bytes=3)

    assert calls == 3
    assert result.before.ctime_ns != result.after.ctime_ns


def test_iter_files_is_sorted_recursive_and_never_follows_symlinks(
    tmp_path: Path,
) -> None:
    root = tmp_path / "root"
    external = tmp_path / "external"
    (root / "z").mkdir(parents=True)
    external.mkdir()
    (root / "z/b.jsonl").write_bytes(b"b")
    (root / "a.jsonl").write_bytes(b"a")
    (external / "secret.jsonl").write_bytes(b"secret")
    (root / "linked-dir").symlink_to(external, target_is_directory=True)
    (root / "linked-file.jsonl").symlink_to(external / "secret.jsonl")

    files = ReadOnlySourceFS().iter_files(root)

    assert files == (root / "a.jsonl", root / "z/b.jsonl")
    assert all("secret" not in path.name for path in files)


@pytest.mark.parametrize("method", ["iter_files", "stat", "read_bytes"])
def test_protected_roots_fail_before_any_open_or_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, method: str
) -> None:
    protected = tmp_path / "episodic-memory"
    protected.mkdir()
    target = protected / "memory.db"
    target.write_bytes(b"do-not-open")
    boundary = ReadOnlySourceFS(protected_roots=(protected,))

    def forbidden(*_args: object, **_kwargs: object) -> object:
        raise AssertionError(
            "protected path reached an operating-system read primitive"
        )

    monkeypatch.setattr(source_base.os, "open", forbidden)
    monkeypatch.setattr(source_base.os, "scandir", forbidden)
    with pytest.raises(QseshError) as caught:
        if method == "iter_files":
            boundary.iter_files(protected)
        elif method == "stat":
            boundary.stat(target)
        else:
            boundary.read_bytes(target, max_bytes=64)
    _assert_error(caught.value, code="QS-E-BOUNDARY", phase="source-path")


def test_symlink_into_protected_root_fails_before_descriptor_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    protected = tmp_path / "whatsoup-store"
    source = tmp_path / "source"
    protected.mkdir()
    source.mkdir()
    database = protected / "state.db"
    database.write_bytes(b"private")
    link = source / "linked.jsonl"
    link.symlink_to(database)
    boundary = ReadOnlySourceFS(protected_roots=(protected,))

    def forbidden(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("symlink target was opened")

    monkeypatch.setattr(source_base.os, "open", forbidden)
    with pytest.raises(QseshError) as caught:
        boundary.read_bytes(link, max_bytes=64)
    _assert_error(caught.value, code="QS-E-BOUNDARY", phase="source-path")


def test_read_cap_is_positive_integer_and_fails_without_partial_bytes(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.jsonl"
    source.write_bytes(b"12345")
    boundary = ReadOnlySourceFS()

    for invalid in (True, 0, -1):
        with pytest.raises(QseshError) as caught:
            boundary.read_bytes(source, max_bytes=invalid)  # type: ignore[arg-type]
        _assert_error(caught.value, code="QS-E-BOUNDARY", phase="source-read-limit")
    with pytest.raises(QseshError) as caught:
        boundary.read_bytes(source, max_bytes=4)
    _assert_error(caught.value, code="QS-E-SOURCE-READ", phase="source-read-cap")


def test_missing_source_is_a_safe_typed_read_error(tmp_path: Path) -> None:
    with pytest.raises(QseshError) as caught:
        ReadOnlySourceFS().stat(tmp_path / "absent.jsonl")
    _assert_error(caught.value, code="QS-E-SOURCE-READ", phase="source-stat")
    assert str(tmp_path) not in str(caught.value)


def test_exact_version_list_bounded_list_and_export_argv_are_allowed(
    tmp_path: Path,
) -> None:
    runner = _runner(tmp_path)
    executable = str(runner.executable)
    commands = (
        (executable, "--pure", "--version"),
        (executable, "--pure", "session", "list", "--format", "json"),
        (
            executable,
            "--pure",
            "session",
            "list",
            "--format",
            "json",
            "-n",
            "1000",
        ),
        (executable, "--pure", "export", "ses_opencode_001"),
    )

    results = [runner.run(argv, timeout_s=1.0, stdout_limit=64) for argv in commands]

    assert [result.stdout for result in results] == [b"ok"] * len(commands)
    assert all(
        result == CommandResult(b"ok", b"", 0, result.duration_ns, False)
        for result in results
    )
    assert all(result.duration_ns >= 0 for result in results)


@pytest.mark.parametrize(
    "suffix",
    [
        ("--version",),
        ("--pure", "session", "list"),
        ("--pure", "session", "list", "--format", "json", "-n", "0"),
        ("--pure", "session", "list", "--format", "json", "-n", "1001"),
        ("--pure", "export", "../memory.db"),
        ("--pure", "export", "ses_bad/value"),
        ("--pure", "export", "ses_"),
        ("--pure", "serve"),
        ("--plugin", "anything"),
    ],
)
def test_every_non_allowlisted_argv_is_rejected_before_spawn(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    suffix: tuple[str, ...],
) -> None:
    runner = _runner(tmp_path)

    def forbidden(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("forbidden argv reached subprocess.Popen")

    monkeypatch.setattr(source_base.subprocess, "Popen", forbidden)
    with pytest.raises(QseshError) as caught:
        runner.run((str(runner.executable), *suffix), timeout_s=1.0, stdout_limit=64)
    _assert_error(caught.value, code="QS-E-BOUNDARY", phase="opencode-argv")


def test_shell_string_is_rejected_before_spawn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner = _runner(tmp_path)

    def forbidden(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("shell string reached subprocess.Popen")

    monkeypatch.setattr(source_base.subprocess, "Popen", forbidden)
    with pytest.raises(QseshError) as caught:
        runner.run("opencode --pure --version", timeout_s=1.0, stdout_limit=64)  # type: ignore[arg-type]
    _assert_error(caught.value, code="QS-E-BOUNDARY", phase="opencode-argv")


def test_spawn_uses_shell_false_closed_stdin_new_group_and_exact_fresh_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner = _runner(tmp_path, "printf stdout; printf stderr >&2; exit 7")
    observed: dict[str, object] = {}
    real_popen = source_base.subprocess.Popen
    monkeypatch.setenv("HOME", str(tmp_path / "inherited-home"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "inherited-data"))
    monkeypatch.setenv("TMPDIR", str(tmp_path / "inherited-tmp"))
    monkeypatch.setenv("OPENCODE_DB", str(tmp_path / "live.db"))
    monkeypatch.setenv("OPENCODE_CONFIG", str(tmp_path / "plugin-enabled-config"))

    def spy_popen(argv: tuple[str, ...], **kwargs: object) -> subprocess.Popen[bytes]:
        observed["argv"] = argv
        observed.update(kwargs)
        return real_popen(argv, **kwargs)  # type: ignore[arg-type,return-value]

    monkeypatch.setattr(source_base.subprocess, "Popen", spy_popen)
    result = runner.run(
        (str(runner.executable), "--pure", "--version"),
        timeout_s=3.0,
        stdout_limit=64,
    )

    assert result.stdout == b"stdout"
    assert result.stderr == b"stderr"
    assert result.exit_code == 7
    assert result.truncated is False
    assert observed["shell"] is False
    assert observed["stdin"] is subprocess.DEVNULL
    assert observed["start_new_session"] is True
    assert observed["close_fds"] is True
    assert observed["stdout"] is subprocess.PIPE
    assert observed["stderr"] is subprocess.PIPE
    environment = observed["env"]
    assert isinstance(environment, dict)
    assert environment == {
        "HOME": str(runner.private_workspace / "home"),
        "LANG": "C",
        "LC_ALL": "C",
        "NO_COLOR": "1",
        "OPENCODE_DB": str(runner.copied_db),
        "PATH": os.defpath,
        "TMPDIR": str(runner.private_workspace / "tmp"),
        "XDG_CACHE_HOME": str(runner.private_workspace / "xdg-cache"),
        "XDG_CONFIG_HOME": str(runner.private_workspace / "xdg-config"),
        "XDG_DATA_HOME": str(runner.private_workspace / "xdg-data"),
    }


def test_every_allowed_command_receives_the_private_database_environment(
    tmp_path: Path,
) -> None:
    runner = _runner(tmp_path, 'printf "%s" "$OPENCODE_DB"')
    executable = str(runner.executable)
    commands = (
        (executable, "--pure", "--version"),
        (executable, "--pure", "session", "list", "--format", "json"),
        (executable, "--pure", "session", "list", "--format", "json", "-n", "7"),
        (executable, "--pure", "export", "ses_opencode_001"),
    )

    results = [runner.run(argv, timeout_s=1.0, stdout_limit=1024) for argv in commands]

    assert [result.stdout.decode() for result in results] == [str(runner.copied_db)] * 4


def test_private_db_and_runtime_paths_are_revalidated_immediately_before_spawn(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for substitution in ("database", "runtime", "workspace"):
        case_root = tmp_path / substitution
        case_root.mkdir()
        runner = _runner(case_root)
        if substitution == "database":
            replacement = runner.copied_db.with_suffix(".replacement")
            replacement.write_bytes(b"replacement")
            replacement.chmod(0o600)
            replacement.replace(runner.copied_db)
            phase = "opencode-copied-db"
        elif substitution == "runtime":
            runtime = runner.private_workspace / "tmp"
            runtime.rmdir()
            outside = case_root / "outside-runtime"
            outside.mkdir()
            runtime.symlink_to(outside, target_is_directory=True)
            phase = "opencode-runtime-dir"
        else:
            workspace = runner.private_workspace
            moved = case_root / "moved-workspace"
            workspace.rename(moved)
            workspace.mkdir(mode=0o700)
            phase = "opencode-private-workspace"

        def forbidden(*_args: object, **_kwargs: object) -> object:
            raise AssertionError("path substitution reached subprocess.Popen")

        with monkeypatch.context() as context:
            context.setattr(source_base.subprocess, "Popen", forbidden)
            with pytest.raises(QseshError) as caught:
                runner.run(
                    (str(runner.executable), "--pure", "--version"),
                    timeout_s=1.0,
                    stdout_limit=64,
                )
        _assert_error(caught.value, code="QS-E-BOUNDARY", phase=phase)


def test_private_db_writes_are_not_coupled_to_the_output_limit(tmp_path: Path) -> None:
    runner = _runner(tmp_path, 'printf y >> "$OPENCODE_DB"; printf ok')
    before = runner.copied_db.stat().st_size

    result = runner.run(
        (str(runner.executable), "--pure", "--version"),
        timeout_s=1.0,
        stdout_limit=2,
    )

    assert result.stdout == b"ok"
    assert runner.copied_db.stat().st_size == before + 1


def test_runner_has_one_popen_selector_path_and_no_output_file_rlimit() -> None:
    source = Path(source_base.__file__).read_text()

    assert "subprocess.Popen" in source
    assert "selectors.DefaultSelector" in source
    assert "subprocess.run" not in source
    assert "RLIMIT_FSIZE" not in source
    assert "TemporaryFile" not in source
    assert "os.killpg(process.pid, signal.SIGKILL)" in source
    assert not re.search(
        r"^import (socket|urllib|http|requests)\b", source, re.MULTILINE
    )


def test_timeout_is_distinct_typed_failure_without_output_detail(
    tmp_path: Path,
) -> None:
    runner = _runner(tmp_path, "printf private; sleep 10")
    with pytest.raises(QseshError) as caught:
        runner.run(
            (str(runner.executable), "--pure", "--version"),
            timeout_s=0.25,
            stdout_limit=64,
        )
    _assert_error(caught.value, code="QS-E-TIMEOUT", phase="opencode-command")
    assert "private" not in str(caught.value)


def test_real_blocked_process_hits_timeout_without_a_success_result(
    tmp_path: Path,
) -> None:
    fifo = tmp_path / "never-opened.fifo"
    os.mkfifo(fifo)
    runner = _runner(tmp_path, f'exec cat < "{fifo}"')

    with pytest.raises(QseshError) as caught:
        runner.run(
            (str(runner.executable), "--pure", "--version"),
            timeout_s=0.1,
            stdout_limit=64,
        )
    _assert_error(caught.value, code="QS-E-TIMEOUT", phase="opencode-command")


def test_stdout_and_stderr_are_each_hard_capped_without_truncated_success(
    tmp_path: Path,
) -> None:
    runner = _runner(
        tmp_path,
        "head -c 65 /dev/zero; head -c 65 /dev/zero >&2",
    )

    with pytest.raises(QseshError) as caught:
        runner.run(
            (str(runner.executable), "--pure", "--version"),
            timeout_s=1.0,
            stdout_limit=64,
        )
    _assert_error(caught.value, code="QS-E-BOUNDARY", phase="opencode-output-cap")


def test_simultaneous_stdout_stderr_pressure_is_drained_without_deadlock(
    tmp_path: Path,
) -> None:
    runner = _runner(
        tmp_path,
        "(head -c 65536 /dev/zero) & (head -c 65536 /dev/zero >&2) & wait",
    )

    result = runner.run(
        (str(runner.executable), "--pure", "--version"),
        timeout_s=3.0,
        stdout_limit=65_536,
    )

    assert len(result.stdout) == len(result.stderr) == 65_536
    assert result.exit_code == 0


@pytest.mark.parametrize(
    "body",
    [
        "head -c 65 /dev/zero",
        "head -c 65 /dev/zero >&2",
        "(head -c 65 /dev/zero) & (head -c 65 /dev/zero >&2) & wait",
    ],
)
def test_first_cap_crossing_byte_kills_the_group_and_discards_output(
    tmp_path: Path, body: str
) -> None:
    runner = _runner(tmp_path, body)

    with pytest.raises(QseshError) as caught:
        runner.run(
            (str(runner.executable), "--pure", "--version"),
            timeout_s=1.0,
            stdout_limit=64,
        )
    _assert_error(caught.value, code="QS-E-BOUNDARY", phase="opencode-output-cap")


def test_descendant_held_pipe_times_out_and_the_process_group_is_reaped(
    tmp_path: Path,
) -> None:
    runner = _runner(
        tmp_path,
        'sleep 10 & child=$!; printf "%s" "$child" > "$HOME/descendant.pid"; exit 0',
    )
    started = time.monotonic()

    with pytest.raises(QseshError) as caught:
        runner.run(
            (str(runner.executable), "--pure", "--version"),
            timeout_s=1.0,
            stdout_limit=64,
        )
    elapsed = time.monotonic() - started
    _assert_error(caught.value, code="QS-E-TIMEOUT", phase="opencode-command")
    child_pid = int((runner.private_workspace / "home/descendant.pid").read_text())
    assert elapsed < 2.0
    with pytest.raises(ProcessLookupError):
        os.kill(child_pid, 0)


def test_signal_termination_is_a_typed_failure_without_partial_output(
    tmp_path: Path,
) -> None:
    runner = _runner(tmp_path, "printf private; kill -TERM $$")

    with pytest.raises(QseshError) as caught:
        runner.run(
            (str(runner.executable), "--pure", "--version"),
            timeout_s=1.0,
            stdout_limit=64,
        )
    _assert_error(
        caught.value,
        code="QS-E-SOURCE-READ",
        phase="opencode-command-signal",
    )
    assert "private" not in str(caught.value)


def test_selector_setup_read_failure_kills_and_reaps_the_process_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner = _runner(
        tmp_path,
        'printf "%s" "$$" > "$HOME/runner.pid"; sleep 10',
    )

    def fail_nonblocking(_descriptor: int, _blocking: bool) -> None:
        raise OSError("injected selector setup failure")

    spawned: list[subprocess.Popen[bytes]] = []
    real_popen = source_base.subprocess.Popen

    def spy_popen(*args: object, **kwargs: object) -> subprocess.Popen[bytes]:
        process = real_popen(*args, **kwargs)  # type: ignore[arg-type]
        spawned.append(process)
        return process

    monkeypatch.setattr(source_base.subprocess, "Popen", spy_popen)
    monkeypatch.setattr(source_base.os, "set_blocking", fail_nonblocking)
    with pytest.raises(QseshError) as caught:
        runner.run(
            (str(runner.executable), "--pure", "--version"),
            timeout_s=1.0,
            stdout_limit=64,
        )
    _assert_error(caught.value, code="QS-E-SOURCE-READ", phase="opencode-command")
    assert len(spawned) == 1
    assert spawned[0].poll() is not None
    with pytest.raises(ProcessLookupError):
        os.kill(spawned[0].pid, 0)
    pid_file = runner.private_workspace / "home/runner.pid"
    if pid_file.exists():
        with pytest.raises(ProcessLookupError):
            os.kill(int(pid_file.read_text()), 0)


def test_exact_cap_is_accepted_and_never_marked_truncated(tmp_path: Path) -> None:
    runner = _runner(tmp_path, "head -c 64 /dev/zero")

    result = runner.run(
        (str(runner.executable), "--pure", "--version"),
        timeout_s=1.0,
        stdout_limit=64,
    )

    assert len(result.stdout) == 64
    assert result.stderr == b""
    assert result.exit_code == 0
    assert result.truncated is False


def test_nonzero_and_stderr_are_preserved_as_distinct_bounded_results(
    tmp_path: Path,
) -> None:
    runner = _runner(tmp_path, "printf diagnostic >&2; exit 7")

    result = runner.run(
        (str(runner.executable), "--pure", "--version"),
        timeout_s=1.0,
        stdout_limit=64,
    )

    assert result == CommandResult(b"", b"diagnostic", 7, result.duration_ns, False)


@pytest.mark.parametrize(
    ("timeout_s", "stdout_limit", "phase"),
    [
        (True, 64, "opencode-timeout"),
        (0.0, 64, "opencode-timeout"),
        (1.0, True, "opencode-output-limit"),
        (1.0, 0, "opencode-output-limit"),
    ],
)
def test_invalid_bounds_fail_before_spawn(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    timeout_s: object,
    stdout_limit: object,
    phase: str,
) -> None:
    runner = _runner(tmp_path)

    def forbidden(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("invalid bounds reached subprocess.Popen")

    monkeypatch.setattr(source_base.subprocess, "Popen", forbidden)
    with pytest.raises(QseshError) as caught:
        runner.run(
            (str(runner.executable), "--pure", "--version"),
            timeout_s=timeout_s,  # type: ignore[arg-type]
            stdout_limit=stdout_limit,  # type: ignore[arg-type]
        )
    _assert_error(caught.value, code="QS-E-BOUNDARY", phase=phase)
