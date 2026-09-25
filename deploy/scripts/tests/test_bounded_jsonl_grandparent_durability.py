"""A newly created parent directory's own name must be made durable.

fsync on the parent fd persists what is INSIDE the parent. The parent's directory
entry lives in the GRANDPARENT, so when append_bounded_jsonl() has just created the
parent via mkdir(), a crash before the grandparent is synced can leave a fully
fsynced record inside a directory that no longer exists.

Before the fix bounded_jsonl.py issued exactly two fsyncs -- the parent fd and the
file fd -- and never touched the grandparent. These tests observe the syscall
directly by inode, so they cannot pass on a code path that merely looks correct.
"""

from __future__ import annotations

import os
from pathlib import Path
import sys
import uuid

import pytest


TEST_ROOT = Path(__file__).resolve().parent
if str(TEST_ROOT) not in sys.path:
    sys.path.insert(0, str(TEST_ROOT))

from bounded_jsonl_test_support import load_bounded_jsonl


def _module():
    return load_bounded_jsonl(f"bounded_jsonl_grandparent_{uuid.uuid4().hex}")


def _record_fsynced_inodes(monkeypatch) -> set[int]:
    """Capture the inode of every fd passed to os.fsync, then sync for real."""
    seen: set[int] = set()
    real_fsync = os.fsync

    def spy(fd: int) -> None:
        try:
            seen.add(os.fstat(fd).st_ino)
        except OSError:
            pass
        real_fsync(fd)

    monkeypatch.setattr(os, "fsync", spy)
    return seen


def test_grandparent_is_fsynced_when_the_parent_is_created(tmp_path, monkeypatch):
    grandparent = tmp_path / "gp"
    grandparent.mkdir(mode=0o700)
    target = grandparent / "newly-created" / "events.jsonl"
    assert not target.parent.exists(), "precondition: the parent must not exist yet"

    gp_ino = os.stat(grandparent).st_ino
    seen = _record_fsynced_inodes(monkeypatch)

    module = _module()
    result = module.append_bounded_jsonl(
        target, {"k": "v"}, component="test", max_bytes=4096
    )

    assert result.status != "not_mutated", f"append failed: {result}"
    assert target.exists()
    assert gp_ino in seen, (
        "the grandparent was never fsynced, so the newly created parent's own "
        f"directory entry is not durable (fsynced inodes: {sorted(seen)}, "
        f"grandparent inode: {gp_ino})"
    )


def test_grandparent_is_fsynced_even_when_the_parent_already_exists(tmp_path, monkeypatch):
    """The durability barrier is UNCONDITIONAL, not scoped to the mkdir path.

    mkdir() makes a parent VISIBLE before its directory entry is durable, so a
    pre-existing parent proves nothing: a retry after a failed sync and a
    concurrent caller both observe a directory whose grandparent entry may never
    have been synced. The gated barrier skipped exactly those callers and
    committed into an unproven directory (the escapes are pinned red-first in
    test_bounded_jsonl_grandparent_failclosed.py). One directory fsync per append
    is the accepted cost of closing that fail-open.
    """
    grandparent = tmp_path / "gp"
    parent = grandparent / "already-there"
    parent.mkdir(mode=0o700, parents=True)
    target = parent / "events.jsonl"

    gp_ino = os.stat(grandparent).st_ino
    seen = _record_fsynced_inodes(monkeypatch)

    module = _module()
    result = module.append_bounded_jsonl(
        target, {"k": "v"}, component="test", max_bytes=4096
    )

    assert result.status != "not_mutated", f"append failed: {result}"
    assert gp_ino in seen, (
        "the grandparent was not fsynced for a pre-existing parent; visible is "
        "not durable, so the barrier must run on every append "
        f"(fsynced inodes: {sorted(seen)}, grandparent inode: {gp_ino})"
    )


def test_the_parent_and_the_file_are_still_fsynced(tmp_path, monkeypatch):
    """Guards against a fix that swaps one sync for another instead of adding one."""
    grandparent = tmp_path / "gp"
    grandparent.mkdir(mode=0o700)
    target = grandparent / "fresh" / "events.jsonl"

    seen = _record_fsynced_inodes(monkeypatch)
    module = _module()
    result = module.append_bounded_jsonl(
        target, {"k": "v"}, component="test", max_bytes=4096
    )
    assert result.status != "not_mutated", f"append failed: {result}"

    assert os.stat(target.parent).st_ino in seen, "the parent directory was not fsynced"
    assert os.stat(target).st_ino in seen, "the record file was not fsynced"
