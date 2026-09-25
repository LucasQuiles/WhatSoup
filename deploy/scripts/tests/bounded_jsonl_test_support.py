from __future__ import annotations

from collections import deque
from dataclasses import asdict
import importlib.util
import json
import multiprocessing as mp
import os
from pathlib import Path
import sys
from types import ModuleType
from typing import Any


SCRIPT_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = SCRIPT_ROOT / "lib" / "bounded_jsonl.py"
SYNC_TIMEOUT_SECONDS = 10.0
OPTION1_MAX_BYTES = 512


def load_bounded_jsonl(module_name: str) -> ModuleType:
    if not MODULE_PATH.is_file():
        raise AssertionError(
            "RED: deploy/scripts/lib/bounded_jsonl.py does not exist"
        )
    spec = importlib.util.spec_from_file_location(module_name, MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def line_bytes(record: dict[str, Any]) -> bytes:
    return (
        json.dumps(record, sort_keys=True, allow_nan=False) + "\n"
    ).encode("utf-8")


def read_records(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def join_process(process: mp.Process, label: str) -> None:
    process.join(SYNC_TIMEOUT_SECONDS)
    if process.is_alive():
        process.terminate()
        process.join(SYNC_TIMEOUT_SECONDS)
        raise AssertionError(f"{label} exceeded the bounded join")
    assert process.exitcode == 0, f"{label} exited {process.exitcode}"


def _option1_write_all(fd: int, payload: bytes) -> None:
    offset = 0
    while offset < len(payload):
        written = os.write(fd, payload[offset:])
        if written <= 0:
            raise OSError("write made no progress")
        offset += written


def _option1_sync_parent(path: Path) -> None:
    parent_fd = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def _option1_append(path: Path, record: dict[str, Any]) -> None:
    payload = line_bytes(record)
    fd = os.open(
        path,
        os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        _option1_write_all(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    _option1_sync_parent(path)


def _option1_retained_snapshot(snapshot: bytes, max_bytes: int) -> bytes:
    retained: deque[bytes] = deque()
    retained_bytes = 0
    for line in snapshot.splitlines(keepends=True):
        retained.append(line)
        retained_bytes += len(line)
        while retained_bytes > max_bytes and len(retained) > 1:
            retained_bytes -= len(retained.popleft())
    return b"".join(retained)


def _option1_replace_snapshot(
    path: Path,
    max_bytes: int,
    *,
    after_temp: Any | None,
    release_replace: Any | None,
) -> None:
    snapshot = path.read_bytes()
    if len(snapshot) <= max_bytes:
        return
    retained = _option1_retained_snapshot(snapshot, max_bytes)
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.option1.tmp")
    fd = os.open(
        temp_path,
        os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        _option1_write_all(fd, retained)
        os.fsync(fd)
    finally:
        os.close(fd)
    if after_temp is not None:
        after_temp.set()
    if release_replace is not None:
        assert release_replace.wait(SYNC_TIMEOUT_SECONDS), "option-1 worker was not released"
    os.replace(temp_path, path)
    _option1_sync_parent(path)


def _option1_worker(
    path_text: str,
    record: dict[str, Any],
    max_bytes: int,
    after_temp: Any | None,
    release_replace: Any | None,
) -> None:
    path = Path(path_text)
    _option1_append(path, record)
    _option1_replace_snapshot(
        path,
        max_bytes,
        after_temp=after_temp,
        release_replace=release_replace,
    )


def run_option1_negative_control(root: Path) -> dict[str, bool | int]:
    context = mp.get_context("spawn")
    target = root / "option1.jsonl"
    seed_records = [
        {"id": f"seed-{index:02d}", "payload": "x" * 96}
        for index in range(12)
    ]
    target.write_bytes(b"".join(line_bytes(record) for record in seed_records))
    a_after_temp = context.Event()
    release_a = context.Event()
    worker_a = context.Process(
        target=_option1_worker,
        args=(
            str(target),
            {"id": "writer-a", "payload": "a" * 96},
            OPTION1_MAX_BYTES,
            a_after_temp,
            release_a,
        ),
    )
    worker_a.start()
    assert a_after_temp.wait(SYNC_TIMEOUT_SECONDS), "option-1 worker A missed its barrier"

    worker_b = context.Process(
        target=_option1_worker,
        args=(
            str(target),
            {"id": "writer-b-sentinel", "payload": "b" * 96},
            OPTION1_MAX_BYTES,
            None,
            None,
        ),
    )
    worker_b.start()
    join_process(worker_b, "option-1 worker B")
    worker_b_completed_while_a_paused = not release_a.is_set()
    before_ids = [record["id"] for record in read_records(target)]
    release_a.set()
    join_process(worker_a, "option-1 worker A")
    after_ids = [record["id"] for record in read_records(target)]
    return {
        "worker_b_completed_while_a_paused": worker_b_completed_while_a_paused,
        "sentinel_visible_before_stale_replace": "writer-b-sentinel" in before_ids,
        "sentinel_visible_after_stale_replace": "writer-b-sentinel" in after_ids,
        "stale_replace_lost_interleaved_append": (
            "writer-b-sentinel" in before_ids
            and "writer-b-sentinel" not in after_ids
        ),
        "raw_sleep_calls": 0,
    }


def fenced_worker_a(
    path_text: str,
    record: dict[str, Any],
    max_bytes: int,
    a_after_temp: Any,
    release_a: Any,
    result_queue: Any,
    done: Any,
) -> None:
    try:
        module = load_bounded_jsonl(f"bounded_jsonl_worker_a_{os.getpid()}")
        real_replace = module._replace_relative

        def paused_replace(parent_fd: int, temp_name: str, target_name: str) -> None:
            a_after_temp.set()
            if not release_a.wait(SYNC_TIMEOUT_SECONDS):
                raise TimeoutError("writer A was not released")
            real_replace(parent_fd, temp_name, target_name)

        module._replace_relative = paused_replace
        result = module.append_bounded_jsonl(
            Path(path_text),
            record,
            component="fixture.jsonl",
            max_bytes=max_bytes,
        )
        result_queue.put({"result": asdict(result)})
    except BaseException as exc:
        result_queue.put({"error_type": type(exc).__name__})
        raise
    finally:
        done.set()


def fenced_worker_b(
    path_text: str,
    record: dict[str, Any],
    max_bytes: int,
    b_entered_lock: Any,
    b_observed_block: Any,
    result_queue: Any,
    done: Any,
) -> None:
    try:
        module = load_bounded_jsonl(f"bounded_jsonl_worker_b_{os.getpid()}")
        real_acquire = module._acquire_flock
        real_flock = module.fcntl.flock

        def observed_flock(lock_fd: int, operation: int) -> Any:
            try:
                return real_flock(lock_fd, operation)
            except BlockingIOError:
                b_observed_block.set()
                raise

        def entered_acquire(lock_fd: int, deadline: float) -> bool:
            b_entered_lock.set()
            return real_acquire(lock_fd, deadline)

        module.fcntl.flock = observed_flock
        module._acquire_flock = entered_acquire
        result = module.append_bounded_jsonl(
            Path(path_text),
            record,
            component="fixture.jsonl",
            max_bytes=max_bytes,
        )
        result_queue.put({"result": asdict(result)})
    except BaseException as exc:
        result_queue.put({"error_type": type(exc).__name__})
        raise
    finally:
        done.set()


def kill_window_worker(
    path_text: str,
    record: dict[str, Any],
    max_bytes: int,
    window: str,
    reached_window: Any,
    release_worker: Any,
    result_queue: Any,
) -> None:
    module = load_bounded_jsonl(f"bounded_jsonl_kill_worker_{os.getpid()}")
    real_replace = module._replace_relative

    def paused_replace(parent_fd: int, temp_name: str, target_name: str) -> None:
        if window == "before_replace":
            reached_window.set()
            if not release_worker.wait(SYNC_TIMEOUT_SECONDS):
                raise TimeoutError("kill-before-replace worker was not released")
            real_replace(parent_fd, temp_name, target_name)
            return
        real_replace(parent_fd, temp_name, target_name)
        reached_window.set()
        if not release_worker.wait(SYNC_TIMEOUT_SECONDS):
            raise TimeoutError("kill-after-replace worker was not released")

    module._replace_relative = paused_replace
    result = module.append_bounded_jsonl(
        Path(path_text),
        record,
        component="fixture.jsonl",
        max_bytes=max_bytes,
    )
    result_queue.put({"result": asdict(result)})
