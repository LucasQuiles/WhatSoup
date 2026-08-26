"""The grandparent OPEN leg, tested where it actually lives.

An end-to-end injection on os.open trips path validation before reaching
_sync_grandparent, so an end-to-end assertion would pass for the wrong reason.
These test the two halves directly: the helper must PROPAGATE, and the caller
must convert that into a non-committed result.
"""
from __future__ import annotations
import os, sys, uuid, errno
from pathlib import Path
import pytest
TEST_ROOT = Path(__file__).resolve().parent
if str(TEST_ROOT) not in sys.path: sys.path.insert(0, str(TEST_ROOT))
from bounded_jsonl_test_support import load_bounded_jsonl
def _m(): return load_bounded_jsonl(f"bj_{uuid.uuid4().hex}")

def test_helper_propagates_open_failure(tmp_path, monkeypatch):
    mod=_m(); gp=tmp_path/"gp"; gp.mkdir(mode=0o700); parent=gp/"np"; parent.mkdir(mode=0o700)
    real=os.open
    def spy(path, flags, *a, **k):
        if flags & os.O_DIRECTORY: raise OSError(errno.EACCES,"injected grandparent open")
        return real(path, flags, *a, **k)
    monkeypatch.setattr(os,"open",spy)
    with pytest.raises(OSError):
        mod._sync_grandparent(parent)

def test_helper_propagates_fsync_failure(tmp_path, monkeypatch):
    mod=_m(); gp=tmp_path/"gp"; gp.mkdir(mode=0o700); parent=gp/"np"; parent.mkdir(mode=0o700)
    monkeypatch.setattr(os,"fsync",lambda fd:(_ for _ in ()).throw(OSError(errno.EIO,"injected")))
    with pytest.raises(OSError):
        mod._sync_grandparent(parent)

def test_caller_converts_a_raised_sync_into_a_non_committed_result(tmp_path, monkeypatch):
    mod=_m(); gp=tmp_path/"gp"; gp.mkdir(mode=0o700)
    def boom(_parent): raise OSError(errno.EIO,"injected grandparent sync")
    monkeypatch.setattr(mod,"_sync_grandparent",boom)
    t=gp/"np"/"log.jsonl"
    r=mod.append_bounded_jsonl(t,{"x":1},component="probe",max_bytes=65536)
    print(f"\nCALLER  status={r.status} stage={r.stage} fc={r.failure_class} exists={t.exists()}")
    assert r.status=="not_mutated" and r.stage=="parent_sync" and r.failure_class=="io_error"
    assert not t.exists()

def test_retry_after_failed_sync_reruns_the_barrier(tmp_path, monkeypatch):
    # Escape 1 of the gated barrier: the first append mkdirs the parent, the
    # grandparent sync fails, and the RETRY sees a pre-existing parent. Gating
    # on parent_created skipped the barrier on that retry and committed into an
    # unproven directory. The barrier must re-run and the retry must not commit.
    mod=_m(); gp=tmp_path/"gp"; gp.mkdir(mode=0o700); ino=os.stat(gp).st_ino
    calls={"n":0}; real=os.fsync
    def spy(fd):
        if os.fstat(fd).st_ino==ino:
            calls["n"]+=1; raise OSError(errno.EIO,"injected grandparent fsync")
        return real(fd)
    monkeypatch.setattr(os,"fsync",spy)
    t=gp/"np"/"log.jsonl"
    r1=mod.append_bounded_jsonl(t,{"x":1},component="probe",max_bytes=65536)
    r2=mod.append_bounded_jsonl(t,{"x":2},component="probe",max_bytes=65536)
    print(f"\nRETRY  first={r1.status}/{r1.stage} second={r2.status}/{r2.stage} barrier_calls={calls['n']}")
    assert r1.status=="not_mutated" and r1.stage=="parent_sync"
    assert r2.status!="committed", "fail-open: retry skipped the unproven-parent barrier"
    assert calls["n"]>=2, "barrier was not re-run on the retry"
    assert not t.exists()

def test_observer_of_a_preexisting_unproven_parent_still_runs_the_barrier(tmp_path, monkeypatch):
    # Escape 2 of the gated barrier: a concurrent caller observes a parent made
    # VISIBLE by someone else's mkdir() whose grandparent entry was never proven
    # durable. Deterministic stand-in: the parent exists before this module
    # instance ever touches it, so parent_created is False for this caller.
    mod=_m(); gp=tmp_path/"gp"; gp.mkdir(mode=0o700); ino=os.stat(gp).st_ino
    parent=gp/"np"; parent.mkdir(mode=0o700)   # out-of-band creator; never synced
    calls={"n":0}; real=os.fsync
    def spy(fd):
        if os.fstat(fd).st_ino==ino:
            calls["n"]+=1; raise OSError(errno.EIO,"injected grandparent fsync")
        return real(fd)
    monkeypatch.setattr(os,"fsync",spy)
    t=parent/"log.jsonl"
    r=mod.append_bounded_jsonl(t,{"x":1},component="probe",max_bytes=65536)
    print(f"\nOBSERVER  status={r.status}/{r.stage} barrier_calls={calls['n']}")
    assert calls["n"]>=1, "barrier was skipped for a pre-existing parent"
    assert r.status=="not_mutated" and r.stage=="parent_sync" and r.failure_class=="io_error"
    assert not t.exists()
