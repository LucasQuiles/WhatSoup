"""T11 verified-copy OpenCode source contracts."""

from __future__ import annotations

import hashlib
import json
import os
import stat
from collections.abc import Callable, Sequence
from pathlib import Path

import pytest
from qsesh.errors import QseshError
from qsesh.model import Harness, SourceSnapshot
from qsesh.sources.base import CommandResult
from qsesh.sources.opencode import (
    DB_MAX_BYTES,
    LIST_TIMEOUT_S,
    OPEN_CODE_VERSION,
    OUTPUT_LIMIT_BYTES,
    WAL_MAX_BYTES,
    OpenCodeAttempt,
    OpenCodeDiscovery,
    OpenCodeSnapshotKind,
    OpenCodeSnapshotObservation,
    OpenCodeSourceAdapter,
)

OLD_UPDATED_MS = 1_767_341_055_000
NOW_US = OLD_UPDATED_MS * 1_000 + 600_000_001
SESSION_ID = "ses_opencode_001"


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.lstat().st_mode)


def _result(stdout: bytes, *, stderr: bytes = b"", exit_code: int = 0) -> CommandResult:
    return CommandResult(
        stdout=stdout,
        stderr=stderr,
        exit_code=exit_code,
        duration_ns=1,
        truncated=False,
    )


def _list_row(
    *,
    native_id: str = SESSION_ID,
    updated: int = OLD_UPDATED_MS,
    **changes: object,
) -> dict[str, object]:
    row: dict[str, object] = {
        "created": updated - 10,
        "directory": "project-alpha",
        "id": native_id,
        "project": "project-alpha",
        "title": "USER_ALPHA",
        "updated": updated,
    }
    row.update(changes)
    return row


def _fixture_export() -> bytes:
    return (Path(__file__).parent / "fixtures/opencode/session.json").read_bytes()


class FakeRunner:
    def __init__(
        self,
        executable: Path,
        *,
        private_workspace: Path,
        copied_db: Path,
        protected_roots: tuple[Path, ...],
        list_rows: list[list[dict[str, object]]],
        list_payloads: list[bytes] | None,
        export: bytes,
        version: bytes = b"1.17.15\n",
        stderr: bytes = b"",
        exit_code: int = 0,
    ) -> None:
        self.executable = executable
        self.private_workspace = private_workspace
        self.copied_db = copied_db
        self.protected_roots = protected_roots
        self.list_rows = list(list_rows)
        self.list_payloads = None if list_payloads is None else list(list_payloads)
        self.export = export
        self.version = version
        self.stderr = stderr
        self.exit_code = exit_code
        self.calls: list[tuple[tuple[str, ...], float, int]] = []

    def run(
        self,
        argv: Sequence[str],
        *,
        timeout_s: float,
        stdout_limit: int,
    ) -> CommandResult:
        call = (tuple(argv), timeout_s, stdout_limit)
        self.calls.append(call)
        if tuple(argv)[-2:] == ("--pure", "--version"):
            payload = self.version
        elif "export" in argv:
            payload = self.export
        else:
            if self.list_payloads is not None:
                if not self.list_payloads:
                    raise AssertionError("unexpected list call")
                payload = self.list_payloads.pop(0)
            else:
                if not self.list_rows:
                    raise AssertionError("unexpected list call")
                payload = json.dumps(self.list_rows.pop(0)).encode()
        return _result(payload, stderr=self.stderr, exit_code=self.exit_code)


class FakeRunnerFactory:
    def __init__(
        self,
        *,
        list_rows: list[list[dict[str, object]]] | None = None,
        list_payloads: list[bytes] | None = None,
        export: bytes | None = None,
        version: bytes = b"1.17.15\n",
        stderr: bytes = b"",
        exit_code: int = 0,
    ) -> None:
        self.list_rows = list_rows or [[_list_row()], [_list_row()]]
        self.list_payloads = list_payloads
        self.export = _fixture_export() if export is None else export
        self.version = version
        self.stderr = stderr
        self.exit_code = exit_code
        self.instances: list[FakeRunner] = []

    def __call__(
        self,
        executable: Path,
        *,
        private_workspace: Path,
        copied_db: Path,
        protected_roots: tuple[Path, ...],
    ) -> FakeRunner:
        runner = FakeRunner(
            executable,
            private_workspace=private_workspace,
            copied_db=copied_db,
            protected_roots=protected_roots,
            list_rows=self.list_rows,
            list_payloads=self.list_payloads,
            export=self.export,
            version=self.version,
            stderr=self.stderr,
            exit_code=self.exit_code,
        )
        self.instances.append(runner)
        return runner


def _source_tree(
    tmp_path: Path,
    *,
    wal: bytes | None = None,
    shm: bytes | None = None,
) -> tuple[Path, Path, Path]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    source = tmp_path / "source"
    source.mkdir(mode=0o700)
    database = source / "opencode.db"
    database.write_bytes(b"database-bytes")
    database.chmod(0o600)
    if wal is not None:
        (source / "opencode.db-wal").write_bytes(wal)
        (source / "opencode.db-wal").chmod(0o600)
    if shm is not None:
        (source / "opencode.db-shm").write_bytes(shm)
        (source / "opencode.db-shm").chmod(0o600)
    temporary = tmp_path / "qsesh-tmp"
    temporary.mkdir(mode=0o700)
    executable = tmp_path / "bin" / "opencode"
    executable.parent.mkdir(mode=0o700)
    executable.write_text("#!/bin/sh\nexit 0\n")
    executable.chmod(0o700)
    return database, temporary, executable


def _attempt(
    tmp_path: Path,
    *,
    wal: bytes | None = None,
    shm: bytes | None = None,
    phase_hook: Callable[[str], None] | None = None,
    free_bytes: int = 1 << 40,
    cleanup_tree: Callable[[Path], None] | None = None,
) -> tuple[OpenCodeAttempt, Path, FakeRunnerFactory]:
    database, temporary, executable = _source_tree(tmp_path, wal=wal, shm=shm)
    factory = FakeRunnerFactory()
    attempt = OpenCodeAttempt(
        live_db=database,
        temporary_root=temporary,
        executable=executable,
        runner_factory=factory,
        phase_hook=phase_hook,
        free_space=lambda _path: free_bytes,
        cleanup_tree=cleanup_tree,
    )
    return attempt, database, factory


def _adapter(
    tmp_path: Path,
    *,
    factory: FakeRunnerFactory | None = None,
    wal: bytes | None = b"wal-bytes",
    shm: bytes | None = b"shm-sentinel",
    phase_hook: Callable[[str], None] | None = None,
) -> tuple[OpenCodeSourceAdapter, Path, FakeRunnerFactory]:
    database, temporary, executable = _source_tree(tmp_path, wal=wal, shm=shm)
    selected = factory or FakeRunnerFactory()
    adapter = OpenCodeSourceAdapter(
        host_id="host-test-001",
        live_db=database,
        temporary_root=temporary,
        executable=executable,
        runner_factory=selected,
        phase_hook=phase_hook,
        free_space=lambda _path: 1 << 40,
    )
    return adapter, database, selected


def _assert_error(error: QseshError, code: str, phase: str) -> None:
    assert error.code == code
    assert error.phase == phase
    assert SESSION_ID not in str(error)


def test_contract_constants_are_exact() -> None:
    assert DB_MAX_BYTES == 8 * 1024**3
    assert WAL_MAX_BYTES == 2 * 1024**3
    assert OPEN_CODE_VERSION == "1.17.15"
    assert LIST_TIMEOUT_S == 30
    assert OUTPUT_LIMIT_BYTES > 0


def test_attempt_requires_database_and_creates_no_workspace(tmp_path: Path) -> None:
    database, temporary, executable = _source_tree(tmp_path)
    database.unlink()
    attempt = OpenCodeAttempt(
        live_db=database,
        temporary_root=temporary,
        executable=executable,
        runner_factory=FakeRunnerFactory(),
        free_space=lambda _path: 1 << 40,
    )

    with pytest.raises(QseshError) as caught:
        attempt.__enter__()

    _assert_error(caught.value, "QS-E-SOURCE-READ", "opencode-source-set")
    assert not tuple(temporary.iterdir())


@pytest.mark.parametrize("wal", [None, b"wal-bytes"])
@pytest.mark.parametrize("shm", [None, b"shm-sentinel"])
def test_copy_accepts_optional_wal_and_never_copies_shm(
    tmp_path: Path, wal: bytes | None, shm: bytes | None
) -> None:
    attempt, database, factory = _attempt(tmp_path, wal=wal, shm=shm)
    sentinels = {
        path.name: (path.read_bytes(), path.lstat())
        for path in database.parent.iterdir()
        if path.is_file()
    }

    with attempt as admitted:
        runner = factory.instances[0]
        assert runner.copied_db.read_bytes() == b"database-bytes"
        copied_wal = runner.copied_db.with_name("opencode.db-wal")
        assert copied_wal.exists() is (wal is not None)
        if wal is not None:
            assert copied_wal.read_bytes() == wal
        assert not runner.copied_db.with_name("opencode.db-shm").exists()
        assert admitted.copy_proof.member_names == (
            ("opencode.db", "opencode.db-wal") if wal is not None else ("opencode.db",)
        )
        assert admitted.copy_proof.shm_present is (shm is not None)

    assert not attempt.workspace.exists()
    for name, (raw, before) in sentinels.items():
        path = database.parent / name
        after = path.lstat()
        assert path.read_bytes() == raw
        assert (after.st_mode, after.st_size, after.st_mtime_ns, after.st_ctime_ns) == (
            before.st_mode,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )


def test_shm_is_observed_by_metadata_but_never_opened(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    attempt, _database, _factory = _attempt(tmp_path, wal=b"wal", shm=b"shm-sentinel")
    real_open = os.open
    opened_names: list[str] = []

    def recording_open(path: object, *args: object, **kwargs: object) -> int:
        opened_names.append(os.fspath(path))
        return real_open(path, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(os, "open", recording_open)
    with attempt as admitted:
        assert admitted.copy_proof.shm_present is True

    assert "opencode.db-shm" not in opened_names


def test_workspace_and_copy_modes_are_exact_and_confined(tmp_path: Path) -> None:
    attempt, database, factory = _attempt(tmp_path, wal=b"wal")

    with attempt:
        runner = factory.instances[0]
        assert runner.private_workspace.parent == tmp_path / "qsesh-tmp"
        assert _mode(runner.private_workspace) == 0o700
        for directory in (
            "home",
            "xdg-data",
            "xdg-config",
            "xdg-cache",
            "tmp",
            "store",
        ):
            assert _mode(runner.private_workspace / directory) == 0o700
        assert _mode(runner.copied_db) == 0o600
        assert _mode(runner.copied_db.with_name("opencode.db-wal")) == 0o600
        assert runner.protected_roots == (database.parent,)
        assert runner.copied_db != database


def test_copy_proof_has_exact_bytes_digests_and_three_stamps(tmp_path: Path) -> None:
    attempt, _database, _factory = _attempt(tmp_path, wal=b"wal-bytes")

    with attempt as admitted:
        proof = admitted.copy_proof
        assert proof.admission_bytes == (
            len(b"database-bytes") + len(b"wal-bytes") + 67_108_864
        )
        for member, raw in zip(
            proof.members, (b"database-bytes", b"wal-bytes"), strict=True
        ):
            expected = hashlib.blake2b(raw, digest_size=32).hexdigest()
            assert member.byte_count == len(raw)
            assert member.copy_digest == expected
            assert member.live_digest == expected
            assert member.before == member.copy_post == member.final


def test_all_live_members_are_open_before_first_copy(tmp_path: Path) -> None:
    observed: list[tuple[int, int]] = []
    attempt: OpenCodeAttempt

    def hook(phase: str) -> None:
        if phase == "before-db-copy":
            observed.extend(
                (os.fstat(descriptor).st_dev, os.fstat(descriptor).st_ino)
                for descriptor in attempt._descriptors.values()
            )

    attempt, database, _factory = _attempt(tmp_path, wal=b"wal", phase_hook=hook)

    with attempt:
        pass

    assert (database.stat().st_dev, database.stat().st_ino) in observed
    wal = database.with_name("opencode.db-wal")
    assert (wal.stat().st_dev, wal.stat().st_ino) in observed


@pytest.mark.parametrize(
    ("phase", "mutation"),
    [
        ("source-set-observed", "add-wal"),
        ("before-source-open", "replace-db"),
        ("db-copy-chunk", "change-db"),
        ("db-copy-complete", "change-wal"),
        ("wal-copy-chunk", "change-wal"),
        ("db-rehash-chunk", "change-db"),
        ("wal-rehash-chunk", "change-wal"),
        ("before-cli-admission", "change-shm"),
        ("before-cli-admission", "remove-wal"),
    ],
)
def test_membership_identity_and_byte_races_start_no_runner(
    tmp_path: Path, phase: str, mutation: str
) -> None:
    database, temporary, executable = _source_tree(tmp_path, wal=b"wal")
    factory = FakeRunnerFactory()
    fired = False

    def hook(current: str) -> None:
        nonlocal fired
        if fired or current != phase:
            return
        fired = True
        wal = database.with_name("opencode.db-wal")
        if mutation == "add-wal":
            wal.unlink()
            wal.write_bytes(b"replacement-wal")
        elif mutation == "replace-db":
            replacement = database.with_name("replacement")
            replacement.write_bytes(database.read_bytes())
            os.replace(replacement, database)
        elif mutation == "change-db":
            database.write_bytes(b"changed-bytes!")
        elif mutation == "change-wal":
            wal.write_bytes(b"changed")
        elif mutation == "change-shm":
            database.with_name("opencode.db-shm").write_bytes(b"changed-shm")
        elif mutation == "remove-wal":
            wal.unlink()

    attempt = OpenCodeAttempt(
        live_db=database,
        temporary_root=temporary,
        executable=executable,
        runner_factory=factory,
        phase_hook=hook,
        free_space=lambda _path: 1 << 40,
    )

    with pytest.raises(QseshError) as caught:
        with attempt:
            pass

    _assert_error(caught.value, "QS-E-SOURCE-READ", "opencode-source-raced")
    assert not factory.instances
    assert not attempt.workspace.exists()


@pytest.mark.parametrize("tamper", ["bytes", "mode", "replace"])
def test_copy_mismatch_immediately_before_cli_starts_no_runner(
    tmp_path: Path, tamper: str
) -> None:
    factory = FakeRunnerFactory()
    attempt: OpenCodeAttempt

    def hook(phase: str) -> None:
        if phase != "before-cli-admission":
            return
        copied = attempt.workspace / "store/opencode.db"
        if tamper == "bytes":
            copied.write_bytes(b"tampered-copy")
        elif tamper == "mode":
            copied.chmod(0o644)
        else:
            replacement = copied.with_name("replacement")
            replacement.write_bytes(copied.read_bytes())
            replacement.chmod(0o600)
            os.replace(replacement, copied)

    database, temporary, executable = _source_tree(tmp_path, wal=b"wal")
    attempt = OpenCodeAttempt(
        live_db=database,
        temporary_root=temporary,
        executable=executable,
        runner_factory=factory,
        phase_hook=hook,
        free_space=lambda _path: 1 << 40,
    )

    with pytest.raises(QseshError) as caught:
        with attempt:
            pass

    _assert_error(caught.value, "QS-E-BOUNDARY", "opencode-copy-verify")
    assert not factory.instances


def test_unrelated_siblings_are_ignored(tmp_path: Path) -> None:
    attempt, database, factory = _attempt(tmp_path)
    unrelated = database.with_name("notes.txt")
    unrelated.write_bytes(b"unrelated")
    before = unrelated.lstat()

    with attempt:
        assert factory.instances

    after = unrelated.lstat()
    assert unrelated.read_bytes() == b"unrelated"
    assert (after.st_size, after.st_mtime_ns, after.st_ctime_ns) == (
        before.st_size,
        before.st_mtime_ns,
        before.st_ctime_ns,
    )


@pytest.mark.parametrize("member", ["opencode.db", "opencode.db-wal"])
@pytest.mark.parametrize("kind", ["symlink", "directory"])
def test_symlink_and_nonregular_members_are_rejected(
    tmp_path: Path, member: str, kind: str
) -> None:
    attempt, database, factory = _attempt(tmp_path, wal=b"wal")
    target = database.parent / member
    target.unlink()
    if kind == "symlink":
        target.symlink_to(database.parent / "missing")
    else:
        target.mkdir()

    with pytest.raises(QseshError) as caught:
        with attempt:
            pass

    _assert_error(caught.value, "QS-E-BOUNDARY", "opencode-source-member")
    assert not factory.instances


@pytest.mark.parametrize(
    ("member", "size"),
    [("opencode.db", DB_MAX_BYTES + 1), ("opencode.db-wal", WAL_MAX_BYTES + 1)],
)
def test_size_caps_fail_before_copy(tmp_path: Path, member: str, size: int) -> None:
    attempt, database, factory = _attempt(tmp_path, wal=b"wal")
    with (database.parent / member).open("r+b") as handle:
        handle.truncate(size)

    with pytest.raises(QseshError) as caught:
        with attempt:
            pass

    _assert_error(caught.value, "QS-E-BOUNDARY", "opencode-source-cap")
    assert not factory.instances


def test_free_space_formula_fails_before_copy(tmp_path: Path) -> None:
    required = len(b"database-bytes") + len(b"wal") + 67_108_864
    attempt, _database, factory = _attempt(
        tmp_path, wal=b"wal", free_bytes=required - 1
    )

    with pytest.raises(QseshError) as caught:
        with attempt:
            pass

    _assert_error(caught.value, "QS-E-BOUNDARY", "opencode-free-space")
    assert not factory.instances


def test_files_and_parent_directories_are_fsynced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    attempt, _database, _factory = _attempt(tmp_path, wal=b"wal")
    real_fsync = os.fsync
    synced_types: list[str] = []

    def recording_fsync(descriptor: int) -> None:
        mode = os.fstat(descriptor).st_mode
        synced_types.append("dir" if stat.S_ISDIR(mode) else "file")
        real_fsync(descriptor)

    monkeypatch.setattr(os, "fsync", recording_fsync)
    with attempt:
        pass

    assert synced_types.count("file") >= 2
    assert synced_types.count("dir") >= 2


def test_cleanup_failure_retains_mode_restricted_content_minimized_inventory(
    tmp_path: Path,
) -> None:
    def fail_cleanup(_path: Path) -> None:
        raise OSError("injected")

    attempt, database, _factory = _attempt(
        tmp_path, wal=b"wal", cleanup_tree=fail_cleanup
    )

    with pytest.raises(QseshError) as caught:
        with attempt:
            pass

    _assert_error(caught.value, "QS-E-ROLLBACK", "opencode-cleanup")
    assert attempt.workspace.exists()
    assert attempt.residue is not None
    assert attempt.residue.owner_prune_only is True
    encoded = json.dumps(attempt.residue.as_safe_dict(), sort_keys=True)
    assert str(database.parent) not in encoded
    assert SESSION_ID not in encoded
    assert "database-bytes" not in encoded
    assert all("sha256" in item for item in attempt.residue.as_safe_dict()["files"])
    assert _mode(attempt.workspace) == 0o700


def test_adapter_uses_exact_runner_argv_copy_alias_and_canonical_bytes(
    tmp_path: Path,
) -> None:
    adapter, database, factory = _adapter(tmp_path)

    with adapter:
        discovery = adapter.discover()
        assert isinstance(discovery, OpenCodeDiscovery)
        assert len(discovery.candidates) == 1
        candidate = discovery.candidates[0]
        assert candidate.harness is Harness.OPENCODE
        assert candidate.native_id == SESSION_ID
        assert candidate.updated_at_us == OLD_UPDATED_MS * 1_000
        snapshot = adapter.snapshot(candidate, now_us=NOW_US)
        assert isinstance(snapshot, SourceSnapshot)
        expected_export = json.loads(_fixture_export())
        expected_rows = [
            {"kind": "session", "schema_version": 1, "value": expected_export["info"]}
        ]
        for message_index, message in enumerate(expected_export["messages"]):
            expected_rows.append(
                {
                    "kind": "message",
                    "message_index": message_index,
                    "schema_version": 1,
                    "value": message["info"],
                }
            )
            for part_index, part in enumerate(message["parts"]):
                expected_rows.append(
                    {
                        "kind": "part",
                        "message_index": message_index,
                        "part_index": part_index,
                        "schema_version": 1,
                        "value": part,
                    }
                )
        expected = b"".join(
            json.dumps(
                row, ensure_ascii=False, separators=(",", ":"), sort_keys=True
            ).encode()
            + b"\n"
            for row in expected_rows
        )
        assert snapshot.raw_bytes == expected
        assert (
            snapshot.source_digest
            == hashlib.blake2b(expected, digest_size=32).hexdigest()
        )
        assert snapshot.schema_fingerprint == "opencode-export-jsonl-v1"
        assert snapshot.harness_version == "1.17.15"

        runner = factory.instances[0]
        executable = str(runner.executable.resolve())
        assert runner.copied_db != database
        assert runner.calls == [
            ((executable, "--pure", "--version"), 30, OUTPUT_LIMIT_BYTES),
            (
                (executable, "--pure", "session", "list", "--format", "json"),
                30,
                OUTPUT_LIMIT_BYTES,
            ),
            ((executable, "--pure", "export", SESSION_ID), 60, OUTPUT_LIMIT_BYTES),
            (
                (executable, "--pure", "session", "list", "--format", "json"),
                30,
                OUTPUT_LIMIT_BYTES,
            ),
        ]

    assert not adapter.attempt.workspace.exists()


def test_discovery_sorts_by_updated_then_id(tmp_path: Path) -> None:
    rows = [
        _list_row(native_id="ses_z", updated=20),
        _list_row(native_id="ses_b", updated=10),
        _list_row(native_id="ses_a", updated=10),
    ]
    adapter, _database, _factory = _adapter(
        tmp_path, factory=FakeRunnerFactory(list_rows=[rows])
    )

    with adapter:
        discovery = adapter.discover()
        candidates = discovery.candidates

    assert [candidate.native_id for candidate in candidates] == [
        "ses_a",
        "ses_b",
        "ses_z",
    ]
    assert [item.created_at_us for item in discovery.metadata] == [0, 0, 10_000]


def test_optional_safe_list_metadata_is_preserved_and_may_be_absent(
    tmp_path: Path,
) -> None:
    complete = _list_row(native_id="ses_complete")
    minimal = {
        "created": OLD_UPDATED_MS - 20,
        "id": "ses_minimal",
        "updated": OLD_UPDATED_MS - 10,
    }
    adapter, _database, _factory = _adapter(
        tmp_path, factory=FakeRunnerFactory(list_rows=[[complete, minimal]])
    )

    with adapter:
        discovery = adapter.discover()

    assert [candidate.native_id for candidate in discovery.candidates] == [
        "ses_minimal",
        "ses_complete",
    ]
    assert discovery.metadata[0].directory is None
    assert discovery.metadata[0].project is None
    assert discovery.metadata[0].title is None
    assert discovery.metadata[1].directory == "project-alpha"
    assert discovery.metadata[1].project == "project-alpha"
    assert discovery.metadata[1].title == "USER_ALPHA"


@pytest.mark.parametrize(
    ("rows", "phase"),
    [
        ([{"id": SESSION_ID, "updated": OLD_UPDATED_MS}], "opencode-list-schema"),
        ([_list_row(extra="unknown")], "opencode-list-schema"),
        ([_list_row(updated=True)], "opencode-list-schema"),
        ([_list_row(native_id="bad")], "opencode-list-schema"),
        ([_list_row(), _list_row()], "opencode-list-duplicate"),
    ],
)
def test_list_schema_unknown_keys_types_ids_and_duplicates_fail_closed(
    tmp_path: Path, rows: list[dict[str, object]], phase: str
) -> None:
    adapter, _database, _factory = _adapter(
        tmp_path, factory=FakeRunnerFactory(list_rows=[rows])
    )

    with adapter, pytest.raises(QseshError) as caught:
        adapter.discover()

    _assert_error(caught.value, "QS-E-OPENCODE-LIST", phase)


@pytest.mark.parametrize(
    "payload",
    [
        b"not-json",
        b"{}",
        b'[{"created":1,"directory":"x","id":"ses_a","project":"x","title":"x","updated":1,"updated":2}]',
        b"[NaN]",
    ],
)
def test_list_malformed_shape_duplicate_json_key_and_nonfinite_fail_closed(
    tmp_path: Path, payload: bytes
) -> None:
    factory = FakeRunnerFactory(list_payloads=[payload])
    adapter, _database, _factory = _adapter(tmp_path, factory=factory)

    with adapter, pytest.raises(QseshError) as caught:
        adapter.discover()

    _assert_error(caught.value, "QS-E-OPENCODE-LIST", "opencode-list-schema")


@pytest.mark.parametrize(("stderr", "exit_code"), [(b"warning", 0), (b"", 9)])
def test_list_stderr_or_nonzero_is_typed_without_candidates(
    tmp_path: Path, stderr: bytes, exit_code: int
) -> None:
    adapter, _database, factory = _adapter(tmp_path)

    with adapter:
        runner = factory.instances[0]
        runner.stderr = stderr
        runner.exit_code = exit_code
        with pytest.raises(QseshError) as caught:
            adapter.discover()

    _assert_error(caught.value, "QS-E-OPENCODE-LIST", "opencode-list-command")


@pytest.mark.parametrize(
    ("version", "stderr", "exit_code", "code", "phase"),
    [
        (b"1.17.16\n", b"", 0, "QS-E-SOURCE-VERSION", "opencode-version"),
        (b"not-version\n", b"", 0, "QS-E-SOURCE-VERSION", "opencode-version"),
        (b"1.17.15\n", b"warning", 0, "QS-E-SOURCE-VERSION", "opencode-version"),
        (b"1.17.15\n", b"", 1, "QS-E-SOURCE-VERSION", "opencode-version"),
    ],
)
def test_version_contract_is_exact(
    tmp_path: Path,
    version: bytes,
    stderr: bytes,
    exit_code: int,
    code: str,
    phase: str,
) -> None:
    adapter, _database, _factory = _adapter(
        tmp_path,
        factory=FakeRunnerFactory(version=version, stderr=stderr, exit_code=exit_code),
    )

    with pytest.raises(QseshError) as caught:
        with adapter:
            pass

    _assert_error(caught.value, code, phase)


def test_live_or_boundary_candidate_skips_export(tmp_path: Path) -> None:
    row = _list_row()
    adapter, _database, factory = _adapter(
        tmp_path, factory=FakeRunnerFactory(list_rows=[[row]])
    )

    with adapter:
        candidate = adapter.discover().candidates[0]
        result = adapter.snapshot(
            candidate, now_us=candidate.updated_at_us + 600_000_000
        )
        assert result == OpenCodeSnapshotObservation(
            candidate=candidate, kind=OpenCodeSnapshotKind.SKIPPED_LIVE
        )
        assert len(factory.instances[0].calls) == 2


def test_updated_race_or_missing_relist_defers_without_snapshot(tmp_path: Path) -> None:
    for after_rows in ([_list_row(updated=OLD_UPDATED_MS + 1)], []):
        factory = FakeRunnerFactory(list_rows=[[_list_row()], after_rows])
        adapter, _database, _factory = _adapter(
            tmp_path / str(len(after_rows)), factory=factory
        )
        with adapter:
            candidate = adapter.discover().candidates[0]
            result = adapter.snapshot(candidate, now_us=NOW_US)
        assert result == OpenCodeSnapshotObservation(
            candidate=candidate, kind=OpenCodeSnapshotKind.SOURCE_RACED
        )


@pytest.mark.parametrize(("stderr", "exit_code"), [(b"warning", 0), (b"", 9)])
def test_export_stderr_or_nonzero_is_typed_without_snapshot(
    tmp_path: Path, stderr: bytes, exit_code: int
) -> None:
    adapter, _database, factory = _adapter(tmp_path)

    with adapter:
        candidate = adapter.discover().candidates[0]
        runner = factory.instances[0]
        runner.stderr = stderr
        runner.exit_code = exit_code
        with pytest.raises(QseshError) as caught:
            adapter.snapshot(candidate, now_us=NOW_US)

    _assert_error(caught.value, "QS-E-OPENCODE-EXPORT", "opencode-export-command")


@pytest.mark.parametrize(
    ("code", "phase"),
    [
        ("QS-E-TIMEOUT", "opencode-command"),
        ("QS-E-BOUNDARY", "opencode-output-cap"),
    ],
)
def test_runner_timeout_and_output_cap_failures_propagate_exactly(
    tmp_path: Path, code: str, phase: str
) -> None:
    adapter, _database, factory = _adapter(tmp_path)

    with adapter:
        runner = factory.instances[0]

        def fail_run(
            _argv: Sequence[str], *, timeout_s: float, stdout_limit: int
        ) -> CommandResult:
            assert timeout_s == LIST_TIMEOUT_S
            assert stdout_limit == OUTPUT_LIMIT_BYTES
            raise QseshError(code, phase=phase)

        runner.run = fail_run  # type: ignore[method-assign]
        with pytest.raises(QseshError) as caught:
            adapter.discover()

    _assert_error(caught.value, code, phase)


@pytest.mark.parametrize(
    "export",
    [
        b"not-json",
        b"[]",
        b'{"info":{},"messages":[],"extra":1}',
        b'{"info":{},"messages":"bad"}',
        b'{"info":{"id":"wrong"},"messages":[]}',
        b'{"info":{"id":"ses_opencode_001"},"messages":[{}]}',
        b'{"info":{"id":"ses_opencode_001"},"messages":[{"info":{},"parts":"bad"}]}',
    ],
)
def test_malformed_export_fails_without_partial_snapshot(
    tmp_path: Path, export: bytes
) -> None:
    adapter, _database, _factory = _adapter(
        tmp_path, factory=FakeRunnerFactory(export=export)
    )
    with adapter:
        candidate = adapter.discover().candidates[0]
        with pytest.raises(QseshError) as caught:
            adapter.snapshot(candidate, now_us=NOW_US)

    _assert_error(caught.value, "QS-E-OPENCODE-EXPORT", "opencode-export-schema")


def test_fully_shaped_export_with_wrong_session_id_fails_closed(tmp_path: Path) -> None:
    export = json.loads(_fixture_export())
    export["info"]["id"] = "ses_wrong"
    factory = FakeRunnerFactory(
        export=json.dumps(export, separators=(",", ":"), sort_keys=True).encode()
    )
    adapter, _database, _factory = _adapter(tmp_path, factory=factory)

    with adapter:
        candidate = adapter.discover().candidates[0]
        with pytest.raises(QseshError) as caught:
            adapter.snapshot(candidate, now_us=NOW_US)

    _assert_error(caught.value, "QS-E-OPENCODE-EXPORT", "opencode-export-schema")


def test_adapter_rejects_foreign_candidate_and_use_outside_context(
    tmp_path: Path,
) -> None:
    adapter, _database, _factory = _adapter(tmp_path)
    with pytest.raises(QseshError) as caught:
        adapter.discover()
    _assert_error(caught.value, "QS-E-BOUNDARY", "opencode-attempt-state")

    with adapter:
        candidate = adapter.discover().candidates[0]
    other, _database, _factory = _adapter(tmp_path / "other")
    with other, pytest.raises(QseshError) as caught:
        other.snapshot(candidate, now_us=NOW_US)
    _assert_error(caught.value, "QS-E-BOUNDARY", "opencode-candidate")


def test_production_source_has_no_sql_parser_or_shm_open_literal() -> None:
    source = (Path(__file__).parents[1] / "qsesh/sources/opencode.py").read_text()
    lowered = source.lower()
    assert "import sqlite" not in lowered
    assert "select " not in lowered
    assert "pragma " not in lowered
    assert '"opencode.db-shm"' not in source
    assert "_SHM_NAME" in source
