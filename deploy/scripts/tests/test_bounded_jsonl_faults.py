from __future__ import annotations

import hashlib
import multiprocessing as mp
import os
from pathlib import Path
from queue import Empty
import signal
import stat
import sys
import uuid

import pytest


TEST_ROOT = Path(__file__).resolve().parent
if str(TEST_ROOT) not in sys.path:
    sys.path.insert(0, str(TEST_ROOT))

from bounded_jsonl_test_support import (
    OPTION1_MAX_BYTES,
    SYNC_TIMEOUT_SECONDS,
    join_process,
    kill_window_worker,
    line_bytes,
    load_bounded_jsonl,
    read_records,
)


def _module(label: str):
    return load_bounded_jsonl(f"bounded_jsonl_faults_{label}_{uuid.uuid4().hex}")


def _precreate_lock(target: Path) -> None:
    lock = target.with_name(f".{target.name}.bounded-jsonl.lock")
    lock.touch(mode=0o600)


def _compaction_target(tmp_path: Path) -> tuple[Path, bytes]:
    target = tmp_path / "diagnostic.jsonl"
    records = [{"id": index, "payload": "x" * 96} for index in range(8)]
    original = b"".join(line_bytes(record) for record in records)
    target.write_bytes(original)
    _precreate_lock(target)
    return target, original


@pytest.mark.parametrize(
    ("case", "expected"),
    [
        pytest.param("append-short", ("unproven", "append", "short_write"), id="append-short"),
        pytest.param("append-sync", ("unproven", "file_sync", "io_error"), id="append-sync"),
        pytest.param("append-parent-sync", ("unproven", "parent_sync", "io_error"), id="append-parent-sync"),
        pytest.param("temp-create", ("not_mutated", "temp_create", "io_error"), id="temp-create"),
        pytest.param("temp-write", ("not_mutated", "temp_write", "short_write"), id="temp-write"),
        pytest.param("temp-sync", ("not_mutated", "temp_sync", "io_error"), id="temp-sync"),
        pytest.param("replace", ("unproven", "replace", "io_error"), id="replace"),
        pytest.param("replace-parent-sync", ("unproven", "parent_sync", "io_error"), id="replace-parent-sync"),
    ],
)
def test_fault_matrix(tmp_path: Path, monkeypatch, case: str, expected: tuple[str, str, str]) -> None:
    module = _module(case)
    if case.startswith("append"):
        target = tmp_path / "diagnostic.jsonl"
        _precreate_lock(target)
        max_bytes = 4096
    else:
        target, _original = _compaction_target(tmp_path)
        max_bytes = OPTION1_MAX_BYTES

    if case in {"append-short", "temp-write"}:
        monkeypatch.setattr(module.os, "write", lambda _fd, _payload: 0)
    elif case in {"append-sync", "temp-sync"}:
        monkeypatch.setattr(
            module,
            "_sync_file",
            lambda _fd: (_ for _ in ()).throw(OSError("injected file sync failure")),
        )
    elif case in {"append-parent-sync", "replace-parent-sync"}:
        monkeypatch.setattr(
            module,
            "_sync_parent",
            lambda _fd: (_ for _ in ()).throw(OSError("injected parent sync failure")),
        )
    elif case == "temp-create":
        real_open = module.os.open
        temp_name = f".{target.name}.bounded-jsonl.compact.tmp"

        def fail_temp_open(path, flags, mode=0o777, *, dir_fd=None):
            if path == temp_name:
                raise OSError("injected temp create failure")
            if dir_fd is None:
                return real_open(path, flags, mode)
            return real_open(path, flags, mode, dir_fd=dir_fd)

        monkeypatch.setattr(module, "_capabilities_available", lambda: True)
        monkeypatch.setattr(module.os, "open", fail_temp_open)
    elif case == "replace":
        monkeypatch.setattr(
            module,
            "_replace_relative",
            lambda _parent_fd, _temp_name, _target_name: (
                _ for _ in ()
            ).throw(OSError("injected replace failure")),
        )

    result = module.append_bounded_jsonl(
        target,
        {"id": f"incoming-{case}", "payload": "y" * 96},
        component="fixture.jsonl",
        max_bytes=max_bytes,
    )

    assert (result.status, result.stage, result.failure_class) == expected


@pytest.mark.parametrize("entry_kind", ["symlink", "fifo"])
def test_target_symlink_and_fifo_fail_closed(tmp_path: Path, entry_kind: str) -> None:
    module = _module(f"target_{entry_kind}")
    target = tmp_path / "diagnostic.jsonl"
    if entry_kind == "symlink":
        backing = tmp_path / "backing.jsonl"
        backing.write_bytes(b"")
        target.symlink_to(backing)
    else:
        os.mkfifo(target, 0o600)

    result = module.append_bounded_jsonl(
        target,
        {"id": "incoming"},
        component="fixture.jsonl",
        max_bytes=4096,
    )

    assert (result.status, result.stage, result.failure_class) == (
        "not_mutated", "inspect", "unsafe_target"
    )
    assert target.exists() or target.is_symlink()


@pytest.mark.parametrize("entry_kind", ["symlink", "fifo"])
def test_lock_symlink_and_fifo_fail_closed(tmp_path: Path, entry_kind: str) -> None:
    module = _module(f"lock_{entry_kind}")
    target = tmp_path / "diagnostic.jsonl"
    lock = tmp_path / ".diagnostic.jsonl.bounded-jsonl.lock"
    if entry_kind == "symlink":
        backing = tmp_path / "backing.lock"
        backing.write_bytes(b"")
        lock.symlink_to(backing)
    else:
        os.mkfifo(lock, 0o600)

    result = module.append_bounded_jsonl(
        target,
        {"id": "incoming"},
        component="fixture.jsonl",
        max_bytes=4096,
    )

    assert (result.status, result.stage, result.failure_class) == (
        "not_mutated", "lock", "unsafe_lock"
    )
    assert not target.exists()


def _exercise_unsafe_temp(tmp_path: Path, entry_kind: str) -> tuple[str, str, str | None]:
    module = _module(f"temp_{entry_kind}")
    target, original = _compaction_target(tmp_path)
    temp = tmp_path / ".diagnostic.jsonl.bounded-jsonl.compact.tmp"
    if entry_kind == "symlink":
        backing = tmp_path / "backing.tmp"
        backing.write_bytes(b"")
        temp.symlink_to(backing)
    elif entry_kind == "fifo":
        os.mkfifo(temp, 0o600)
    else:
        temp.write_bytes(b"residue")
        os.chmod(temp, 0o644)

    result = module.append_bounded_jsonl(
        target,
        {"id": "incoming", "payload": "y" * 96},
        component="fixture.jsonl",
        max_bytes=OPTION1_MAX_BYTES,
    )

    assert target.read_bytes() == original
    assert temp.exists() or temp.is_symlink()
    return result.status, result.stage, result.failure_class


def test_temp_symlink_fails_closed(tmp_path: Path) -> None:
    assert _exercise_unsafe_temp(tmp_path, "symlink") == (
        "not_mutated", "reconcile", "unsafe_temp"
    )


def test_temp_fifo_fails_closed(tmp_path: Path) -> None:
    assert _exercise_unsafe_temp(tmp_path, "fifo") == (
        "not_mutated", "reconcile", "unsafe_temp"
    )


def test_temp_nonprivate_residue_fails_closed(tmp_path: Path) -> None:
    assert _exercise_unsafe_temp(tmp_path, "nonprivate") == (
        "not_mutated", "reconcile", "unsafe_temp"
    )


def test_foreign_owner_observation_fails_closed(tmp_path: Path, monkeypatch) -> None:
    module = _module("foreign_owner")
    target = tmp_path / "diagnostic.jsonl"
    monkeypatch.setattr(module, "_effective_uid", lambda: os.geteuid() + 1)

    result = module.append_bounded_jsonl(
        target,
        {"id": "incoming"},
        component="fixture.jsonl",
        max_bytes=4096,
    )

    assert (result.status, result.stage, result.failure_class) == (
        "not_mutated", "parent", "unsafe_parent"
    )
    assert not target.exists()


def test_unprivate_parent_is_corrected_or_fails_before_target_mutation(tmp_path: Path) -> None:
    module = _module("private_parent")
    parent = tmp_path / "diagnostics"
    parent.mkdir(mode=0o755)
    os.chmod(parent, 0o755)
    target = parent / "diagnostic.jsonl"

    result = module.append_bounded_jsonl(
        target,
        {"id": "incoming"},
        component="fixture.jsonl",
        max_bytes=4096,
    )

    if result.status == "committed":
        assert stat.S_IMODE(parent.stat().st_mode) == 0o700
    else:
        assert (result.status, result.stage, result.failure_class) == (
            "not_mutated", "parent", "unsafe_parent"
        )
        assert not target.exists()


def test_missing_required_capability_has_no_path_fallback(tmp_path: Path, monkeypatch) -> None:
    module = _module("capabilities")
    target = tmp_path / "missing-parent" / "diagnostic.jsonl"
    calls = {"write_text": 0, "write_bytes": 0, "replace": 0, "path_open": 0}
    real_open = module.os.open

    def observed_open(path, flags, mode=0o777, *, dir_fd=None):
        if dir_fd is None:
            calls["path_open"] += 1
            return real_open(path, flags, mode)
        return real_open(path, flags, mode, dir_fd=dir_fd)

    def forbidden_write_text(*_args, **_kwargs):
        calls["write_text"] += 1
        raise AssertionError("path write fallback used")

    def forbidden_write_bytes(*_args, **_kwargs):
        calls["write_bytes"] += 1
        raise AssertionError("path write fallback used")

    def forbidden_replace(*_args, **_kwargs):
        calls["replace"] += 1
        raise AssertionError("path replace fallback used")

    monkeypatch.setattr(module, "_capabilities_available", lambda: False)
    monkeypatch.setattr(module.os, "open", observed_open)
    monkeypatch.setattr(Path, "write_text", forbidden_write_text)
    monkeypatch.setattr(Path, "write_bytes", forbidden_write_bytes)
    monkeypatch.setattr(module.os, "replace", forbidden_replace)

    result = module.append_bounded_jsonl(
        target,
        {"id": "incoming"},
        component="fixture.jsonl",
        max_bytes=4096,
    )

    assert (result.status, result.stage, result.failure_class) == (
        "not_mutated", "validation", "unsupported"
    )
    assert calls == {"write_text": 0, "write_bytes": 0, "replace": 0, "path_open": 0}
    assert not target.parent.exists()


def test_kill_before_replace_leaves_old_target_and_reconcilable_temp(tmp_path: Path) -> None:
    module = _module("kill_before_parent_probe")
    context = mp.get_context("spawn")
    target, old_bytes = _compaction_target(tmp_path)
    reached = context.Event()
    release = context.Event()
    result_queue = context.Queue()
    worker = context.Process(
        target=kill_window_worker,
        args=(
            str(target),
            {"id": "killed-before", "payload": "k" * 96},
            OPTION1_MAX_BYTES,
            "before_replace",
            reached,
            release,
            result_queue,
        ),
    )
    worker.start()
    assert reached.wait(SYNC_TIMEOUT_SECONDS)
    os.kill(worker.pid, signal.SIGKILL)
    worker.join(SYNC_TIMEOUT_SECONDS)
    assert not worker.is_alive()
    assert worker.exitcode is not None and worker.exitcode < 0
    with pytest.raises(Empty):
        result_queue.get_nowait()
    temp = tmp_path / ".diagnostic.jsonl.bounded-jsonl.compact.tmp"
    assert target.read_bytes() == old_bytes
    assert temp.is_file()

    next_record = {"id": "next", "payload": "n" * 96}
    result = module.append_bounded_jsonl(
        target,
        next_record,
        component="fixture.jsonl",
        max_bytes=OPTION1_MAX_BYTES,
    )
    assert result.status == "committed"
    assert not temp.exists()
    assert read_records(target)[-1] == next_record


def test_injected_post_replace_parent_sync_failure_stays_unproven_when_readable(
    tmp_path: Path,
    monkeypatch,
) -> None:
    module = _module("post_replace_failure")
    target, _old_bytes = _compaction_target(tmp_path)
    real_replace = module._replace_relative
    real_sync_parent = module._sync_parent
    replaced = False

    def observed_replace(parent_fd: int, temp_name: str, target_name: str) -> None:
        nonlocal replaced
        real_replace(parent_fd, temp_name, target_name)
        replaced = True

    def fail_after_replace(parent_fd: int) -> None:
        if replaced:
            raise OSError("injected post-replace parent sync failure")
        real_sync_parent(parent_fd)

    monkeypatch.setattr(module, "_replace_relative", observed_replace)
    monkeypatch.setattr(module, "_sync_parent", fail_after_replace)
    incoming = {"id": "readable-unproven", "payload": "u" * 96}

    result = module.append_bounded_jsonl(
        target,
        incoming,
        component="fixture.jsonl",
        max_bytes=OPTION1_MAX_BYTES,
    )

    assert (result.status, result.method, result.stage, result.failure_class, result.compacted) == (
        "unproven", "compact_replace", "parent_sync", "io_error", True
    )
    assert incoming in read_records(target)


def test_kill_after_replace_returns_no_result_and_next_append_does_not_retroactively_attest_it(
    tmp_path: Path,
) -> None:
    module = _module("kill_after_parent_probe")
    context = mp.get_context("spawn")
    target, _old_bytes = _compaction_target(tmp_path)
    reached = context.Event()
    release = context.Event()
    result_queue = context.Queue()
    killed_record = {"id": "killed-after", "payload": "k" * 96}
    worker = context.Process(
        target=kill_window_worker,
        args=(
            str(target),
            killed_record,
            OPTION1_MAX_BYTES,
            "after_replace",
            reached,
            release,
            result_queue,
        ),
    )
    worker.start()
    assert reached.wait(SYNC_TIMEOUT_SECONDS)
    readable_after_replace = target.read_bytes()
    os.kill(worker.pid, signal.SIGKILL)
    worker.join(SYNC_TIMEOUT_SECONDS)
    assert not worker.is_alive()
    assert worker.exitcode is not None and worker.exitcode < 0
    with pytest.raises(Empty):
        result_queue.get_nowait()
    assert readable_after_replace == target.read_bytes()

    next_record = {"id": "next", "payload": "n" * 96}
    result = module.append_bounded_jsonl(
        target,
        next_record,
        component="fixture.jsonl",
        max_bytes=OPTION1_MAX_BYTES,
    )
    assert result.status == "committed"
    assert result.record_sha256 == hashlib.sha256(line_bytes(next_record)).hexdigest()
    assert read_records(target)[-1] == next_record
    with pytest.raises(Empty):
        result_queue.get_nowait()
