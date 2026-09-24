"""The explicit durability option of append_bounded_jsonl.

The default ("durable") must keep every fsync barrier: the record file, the
parent directory and the grandparent entry. ``durability="best_effort"`` is an
opt-in for diagnostic logs that skips those append-path fsyncs while keeping the
same lock, bound and result contract. Compaction stays fully synced in both
modes. The fsync spy records the inode behind every fd passed to os.fsync, so
these tests observe the syscalls themselves.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import uuid


TEST_ROOT = Path(__file__).resolve().parent
if str(TEST_ROOT) not in sys.path:
    sys.path.insert(0, str(TEST_ROOT))

from bounded_jsonl_test_support import load_bounded_jsonl


def _module():
    return load_bounded_jsonl(f"bounded_jsonl_durability_{uuid.uuid4().hex}")


def _record_fsynced_inodes(monkeypatch) -> list[int]:
    seen: list[int] = []
    real_fsync = os.fsync

    def spy(fd: int) -> None:
        seen.append(os.fstat(fd).st_ino)
        real_fsync(fd)

    monkeypatch.setattr(os, "fsync", spy)
    return seen


def _target(tmp_path: Path) -> Path:
    parent = tmp_path / "gp" / "logs"
    parent.mkdir(mode=0o700, parents=True)
    return parent / "events.jsonl"


def test_default_durability_fsyncs_file_parent_and_grandparent(tmp_path, monkeypatch):
    target = _target(tmp_path)
    seen = _record_fsynced_inodes(monkeypatch)

    result = _module().append_bounded_jsonl(
        target, {"k": "v"}, component="test", max_bytes=4096
    )

    assert result.status == "committed", result
    assert result.method == "append"
    assert os.stat(target).st_ino in seen, "the record file was not fsynced"
    assert os.stat(target.parent).st_ino in seen, "the parent was not fsynced"
    assert os.stat(target.parent.parent).st_ino in seen, "the grandparent was not fsynced"


def test_explicit_durable_matches_the_default(tmp_path, monkeypatch):
    target = _target(tmp_path)
    seen = _record_fsynced_inodes(monkeypatch)

    result = _module().append_bounded_jsonl(
        target, {"k": "v"}, component="test", max_bytes=4096, durability="durable"
    )

    assert result.status == "committed", result
    assert os.stat(target).st_ino in seen
    assert os.stat(target.parent).st_ino in seen
    assert os.stat(target.parent.parent).st_ino in seen


def test_best_effort_append_commits_without_any_fsync(tmp_path, monkeypatch):
    target = _target(tmp_path)
    seen = _record_fsynced_inodes(monkeypatch)
    module = _module()

    first = module.append_bounded_jsonl(
        target, {"n": 1}, component="test", max_bytes=4096, durability="best_effort"
    )
    second = module.append_bounded_jsonl(
        target, {"n": 2}, component="test", max_bytes=4096, durability="best_effort"
    )

    assert first.status == "committed", first
    assert second.status == "committed", second
    assert second.method == "append"
    assert seen == [], f"best_effort append issued fsyncs on inodes {seen}"
    lines = target.read_text(encoding="utf-8").splitlines()
    assert [json.loads(line) for line in lines] == [{"n": 1}, {"n": 2}]
    assert oct(target.stat().st_mode & 0o777) == "0o600"


def test_best_effort_keeps_the_bound_and_compaction_stays_synced(tmp_path, monkeypatch):
    target = _target(tmp_path)
    module = _module()
    for index in range(3):
        assert module.append_bounded_jsonl(
            target,
            {"i": index, "pad": "x" * 60},
            component="test",
            max_bytes=256,
            durability="best_effort",
        ).status == "committed"

    seen = _record_fsynced_inodes(monkeypatch)
    result = module.append_bounded_jsonl(
        target,
        {"i": 3, "pad": "x" * 60},
        component="test",
        max_bytes=256,
        durability="best_effort",
    )

    assert result.status == "committed", result
    assert result.method == "compact_replace"
    assert target.stat().st_size <= 256
    assert os.stat(target.parent).st_ino in seen, "compaction must stay fully synced"


def test_best_effort_keeps_the_rejection_policy(tmp_path):
    target = _target(tmp_path)
    target.write_bytes(b'{"partial": true}')
    target.chmod(0o600)

    result = _module().append_bounded_jsonl(
        target, {"k": "v"}, component="test", max_bytes=4096, durability="best_effort"
    )

    assert result.status == "not_mutated"
    assert result.failure_class == "incomplete_jsonl"
    assert target.read_bytes() == b'{"partial": true}'


def test_unknown_durability_is_invalid_input(tmp_path, monkeypatch):
    target = _target(tmp_path)
    seen = _record_fsynced_inodes(monkeypatch)
    module = _module()

    for value in ("fast", "", None, True, 1):
        result = module.append_bounded_jsonl(
            target, {"k": "v"}, component="test", max_bytes=4096, durability=value
        )
        assert result.status == "not_mutated", value
        assert result.stage == "validation", value
        assert result.failure_class == "invalid_input", value

    assert not target.exists()
    assert seen == []
