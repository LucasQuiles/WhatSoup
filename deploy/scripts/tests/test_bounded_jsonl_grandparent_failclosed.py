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
