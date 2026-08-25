from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import fcntl
import inspect
import multiprocessing as mp
import os
from pathlib import Path
import re
import sys
import threading
import uuid


TEST_ROOT = Path(__file__).resolve().parent
if str(TEST_ROOT) not in sys.path:
    sys.path.insert(0, str(TEST_ROOT))

import bounded_jsonl_test_support as support
from bounded_jsonl_test_support import (
    OPTION1_MAX_BYTES,
    SYNC_TIMEOUT_SECONDS,
    fenced_worker_a,
    fenced_worker_b,
    join_process,
    line_bytes,
    load_bounded_jsonl,
    read_records,
    run_option1_negative_control,
)


def _module(label: str):
    return load_bounded_jsonl(f"bounded_jsonl_concurrency_{label}_{uuid.uuid4().hex}")


def _hold_lock(lock_path: str, acquired, release) -> None:
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        acquired.set()
        assert release.wait(SYNC_TIMEOUT_SECONDS)
    finally:
        os.close(fd)


def test_option1_negative_control_loses_interleaved_sentinel(tmp_path: Path) -> None:
    outcome = run_option1_negative_control(tmp_path)

    assert outcome == {
        "worker_b_completed_while_a_paused": True,
        "sentinel_visible_before_stale_replace": True,
        "sentinel_visible_after_stale_replace": False,
        "stale_replace_lost_interleaved_append": True,
        "raw_sleep_calls": 0,
    }
    source = inspect.getsource(support)
    assert "time.sleep(" not in source
    assert re.search(r"(?<![\w.])sleep\(", source) is None


def test_shared_fence_preserves_interleaved_sentinel(tmp_path: Path) -> None:
    _module("parent_probe")
    context = mp.get_context("spawn")
    target = tmp_path / "diagnostic.jsonl"
    seed = [
        {"id": f"seed-{index:02d}", "payload": "x" * 96}
        for index in range(12)
    ]
    target.write_bytes(b"".join(line_bytes(record) for record in seed))
    a_after_temp = context.Event()
    release_a = context.Event()
    a_done = context.Event()
    b_entered_lock = context.Event()
    b_observed_block = context.Event()
    b_done = context.Event()
    a_queue = context.Queue()
    b_queue = context.Queue()
    worker_a = context.Process(
        target=fenced_worker_a,
        args=(
            str(target),
            {"id": "writer-a", "payload": "a" * 96},
            OPTION1_MAX_BYTES,
            a_after_temp,
            release_a,
            a_queue,
            a_done,
        ),
    )
    worker_b = context.Process(
        target=fenced_worker_b,
        args=(
            str(target),
            {"id": "writer-b-sentinel", "payload": "b" * 96},
            OPTION1_MAX_BYTES,
            b_entered_lock,
            b_observed_block,
            b_queue,
            b_done,
        ),
    )
    worker_a.start()
    try:
        assert a_after_temp.wait(SYNC_TIMEOUT_SECONDS)
        worker_b.start()
        assert b_entered_lock.wait(SYNC_TIMEOUT_SECONDS)
        assert b_observed_block.wait(SYNC_TIMEOUT_SECONDS)
        assert not b_done.is_set(), "writer B crossed the shared fence"
    finally:
        release_a.set()
    join_process(worker_a, "worker A")
    join_process(worker_b, "worker B")
    a_message = a_queue.get(timeout=SYNC_TIMEOUT_SECONDS)
    b_message = b_queue.get(timeout=SYNC_TIMEOUT_SECONDS)
    assert a_message["result"]["status"] == "committed"
    assert b_message["result"]["status"] == "committed"
    ids = [record["id"] for record in read_records(target)]
    assert ids.count("writer-a") == 1
    assert ids.count("writer-b-sentinel") == 1
    assert ids.index("writer-a") < ids.index("writer-b-sentinel")


def test_threads_serialize_on_one_target(tmp_path: Path) -> None:
    module = _module("threads")
    target = tmp_path / "diagnostic.jsonl"
    barrier = threading.Barrier(8)

    def publish(index: int):
        barrier.wait(timeout=SYNC_TIMEOUT_SECONDS)
        return module.append_bounded_jsonl(
            target,
            {"id": index},
            component="fixture.jsonl",
            max_bytes=4096,
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(publish, range(8)))

    assert all(result.status == "committed" for result in results)
    records = read_records(target)
    assert len(records) == 8
    assert {record["id"] for record in records} == set(range(8))


def test_process_mutex_serializes_compaction_when_flock_is_disabled(
    tmp_path: Path,
) -> None:
    module = _module("process_mutex")
    target = tmp_path / "diagnostic.jsonl"
    seed = [
        {"id": f"seed-{index:02d}", "payload": "x" * 96}
        for index in range(12)
    ]
    target.write_bytes(b"".join(line_bytes(record) for record in seed))
    roles = threading.local()
    a_after_temp = threading.Event()
    release_a = threading.Event()
    b_waiting_on_mutex = threading.Event()
    b_crossed_mutex = threading.Event()
    real_target_mutex = module._target_mutex
    real_replace = module._replace_relative

    class ObservedMutex:
        def __init__(self, delegate) -> None:
            self._delegate = delegate

        def acquire(self, *, timeout: float) -> bool:
            if getattr(roles, "name", None) == "b":
                b_waiting_on_mutex.set()
            return self._delegate.acquire(timeout=timeout)

        def release(self) -> None:
            self._delegate.release()

    def observed_target_mutex(parent_fd: int, target_name: str):
        return ObservedMutex(real_target_mutex(parent_fd, target_name))

    def disabled_flock(_lock_fd: int, _deadline: float) -> bool:
        if getattr(roles, "name", None) == "b":
            b_crossed_mutex.set()
        return True

    def paused_replace(parent_fd: int, temp_name: str, target_name: str) -> None:
        if getattr(roles, "name", None) == "a":
            a_after_temp.set()
            assert release_a.wait(SYNC_TIMEOUT_SECONDS)
        real_replace(parent_fd, temp_name, target_name)

    module._target_mutex = observed_target_mutex
    module._acquire_flock = disabled_flock
    module._replace_relative = paused_replace

    def publish(role: str, record: dict):
        roles.name = role
        return module.append_bounded_jsonl(
            target,
            record,
            component=f"fixture.{role}",
            max_bytes=OPTION1_MAX_BYTES,
        )

    record_a = {"id": "writer-a", "payload": "a" * 96}
    record_b = {"id": "writer-b", "payload": "b" * 96}
    with ThreadPoolExecutor(max_workers=2) as pool:
        a_future = pool.submit(publish, "a", record_a)
        assert a_after_temp.wait(SYNC_TIMEOUT_SECONDS)
        b_future = pool.submit(publish, "b", record_b)
        try:
            assert b_waiting_on_mutex.wait(SYNC_TIMEOUT_SECONDS)
            assert not b_crossed_mutex.wait(0.5), "writer B crossed the process mutex"
        finally:
            release_a.set()
        a_result = a_future.result(timeout=SYNC_TIMEOUT_SECONDS)
        b_result = b_future.result(timeout=SYNC_TIMEOUT_SECONDS)

    assert a_result.status == b_result.status == "committed"
    ids = [record["id"] for record in read_records(target)]
    assert ids.count("writer-a") == 1
    assert ids.count("writer-b") == 1
    assert ids.index("writer-a") < ids.index("writer-b")


def test_different_targets_do_not_share_one_global_fence(tmp_path: Path) -> None:
    module = _module("different_targets")
    target_a = tmp_path / "a.jsonl"
    target_b = tmp_path / "b.jsonl"
    seed = [{"id": index, "payload": "x" * 96} for index in range(12)]
    target_a.write_bytes(b"".join(line_bytes(record) for record in seed))
    reached_replace = threading.Event()
    release_replace = threading.Event()
    real_replace = module._replace_relative

    def paused_replace(parent_fd: int, temp_name: str, target_name: str) -> None:
        reached_replace.set()
        assert release_replace.wait(SYNC_TIMEOUT_SECONDS)
        real_replace(parent_fd, temp_name, target_name)

    module._replace_relative = paused_replace
    with ThreadPoolExecutor(max_workers=2) as pool:
        a_future = pool.submit(
            module.append_bounded_jsonl,
            target_a,
            {"id": "a", "payload": "a" * 96},
            component="fixture.a",
            max_bytes=OPTION1_MAX_BYTES,
        )
        assert reached_replace.wait(SYNC_TIMEOUT_SECONDS)
        b_future = pool.submit(
            module.append_bounded_jsonl,
            target_b,
            {"id": "b"},
            component="fixture.b",
            max_bytes=4096,
        )
        b_result = b_future.result(timeout=SYNC_TIMEOUT_SECONDS)
        assert b_result.status == "committed"
        release_replace.set()
        a_result = a_future.result(timeout=SYNC_TIMEOUT_SECONDS)
    assert a_result.status == "committed"


def test_lock_timeout_returns_not_mutated(tmp_path: Path) -> None:
    module = _module("lock_timeout")
    context = mp.get_context("spawn")
    target = tmp_path / "diagnostic.jsonl"
    lock_path = tmp_path / ".diagnostic.jsonl.bounded-jsonl.lock"
    acquired = context.Event()
    release = context.Event()
    holder = context.Process(target=_hold_lock, args=(str(lock_path), acquired, release))
    holder.start()
    try:
        assert acquired.wait(SYNC_TIMEOUT_SECONDS)
        result = module.append_bounded_jsonl(
            target,
            {"id": "blocked"},
            component="fixture.jsonl",
            max_bytes=4096,
            lock_timeout_seconds=0.05,
        )
    finally:
        release.set()
    join_process(holder, "lock holder")
    assert (result.status, result.stage, result.failure_class) == (
        "not_mutated", "lock", "lock_timeout"
    )
    assert not target.exists()


def test_equal_concurrent_records_are_both_retained(tmp_path: Path) -> None:
    module = _module("equal")
    target = tmp_path / "diagnostic.jsonl"
    barrier = threading.Barrier(2)
    record = {"id": "same"}

    def publish():
        barrier.wait(timeout=SYNC_TIMEOUT_SECONDS)
        return module.append_bounded_jsonl(
            target,
            record,
            component="fixture.jsonl",
            max_bytes=4096,
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [pool.submit(publish), pool.submit(publish)]
        committed = [future.result(timeout=SYNC_TIMEOUT_SECONDS) for future in results]

    assert all(result.status == "committed" for result in committed)
    assert read_records(target) == [record, record]
