"""TDD tests for sentinel_pin.py — Fleet Runtime Sentinel Plan 1 (Pin Foundation)."""
from __future__ import annotations
import json, pathlib, sys
import pytest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "lib"))
import sentinel_pin as sp


def _manifest(tmp_path, files, head=None):
    m = {"schemaVersion": 1, "files": files}
    if head is not None: m["expected_head_sha"] = head
    p = tmp_path / "manifest.json"; p.write_text(json.dumps(m)); return p


def test_load_pin_extracts_files_head_and_f10(tmp_path):
    files = [
        {"path": "deploy/scripts/lib/bot_errors_redaction.py", "sha256": "1448da21" + "0"*56},
        {"path": "deploy/scripts/bot-errors-emit.py", "sha256": "bb97461a" + "0"*56},
    ]
    pin = sp.load_pin(_manifest(tmp_path, files, head="a"*40))
    assert pin.head_sha == "a"*40
    assert pin.files["deploy/scripts/bot-errors-emit.py"] == "bb97461a" + "0"*56
    assert pin.f10_sha == "1448da21" + "0"*56


def test_load_pin_head_absent_is_none(tmp_path):
    pin = sp.load_pin(_manifest(tmp_path, [{"path": "deploy/scripts/lib/bot_errors_redaction.py", "sha256": "1448da21"+"0"*56}]))
    assert pin.head_sha is None


def test_load_pin_missing_file_raises_pinloaderror(tmp_path):
    with pytest.raises(sp.PinLoadError):
        sp.load_pin(tmp_path / "does-not-exist.json")


def test_load_pin_malformed_json_raises_pinloaderror(tmp_path):
    p = tmp_path / "bad.json"; p.write_text("{not json")
    with pytest.raises(sp.PinLoadError):
        sp.load_pin(p)


# ---------------------------------------------------------------------------
# Increment 2 — trust anchor (commit-exists + F10 ledger floor)
# ---------------------------------------------------------------------------

def _pin(head="a"*40, f10="1448da21"+"0"*56):
    return sp.Pin(head_sha=head, files={sp.F10_PATH: f10}, f10_sha=f10)


def test_trust_ok_when_commit_exists_and_f10_approved():
    ok, reason = sp.verify_pin_trust(_pin(), approved_f10={"1448da21"+"0"*56}, commit_exists=lambda s: True)
    assert ok is True and reason == "ok"


def test_trust_rejects_unknown_commit():
    ok, reason = sp.verify_pin_trust(_pin(), approved_f10={"1448da21"+"0"*56}, commit_exists=lambda s: False)
    assert ok is False and "commit" in reason


def test_trust_rejects_f10_not_in_ledger():
    ok, reason = sp.verify_pin_trust(_pin(f10="d62148b8"+"0"*56), approved_f10={"1448da21"+"0"*56}, commit_exists=lambda s: True)
    assert ok is False and "f10" in reason


def test_trust_rejects_unstamped_pin():
    ok, reason = sp.verify_pin_trust(_pin(head=None), approved_f10={"1448da21"+"0"*56}, commit_exists=lambda s: True)
    assert ok is False and "unstamped" in reason


def test_load_approved_f10_reads_ledger(tmp_path):
    led = tmp_path / "ledger.json"; led.write_text(json.dumps({"approved_f10": ["1448da21"+"0"*56]}))
    assert sp.load_approved_f10(led) == {"1448da21"+"0"*56}


# ---------------------------------------------------------------------------
# Increment 3 — bundle integrity
# ---------------------------------------------------------------------------

import hashlib


def _write(p, content):
    p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(content); return hashlib.sha256(content).hexdigest()


def test_bundle_ok_when_all_files_match(tmp_path):
    b = tmp_path / "bundle"
    s1 = _write(b / "deploy/scripts/bot-errors-emit.py", b"emit\n")
    s2 = _write(b / sp.F10_PATH, b"redact\n")
    pin = sp.Pin(head_sha="a"*40, files={"deploy/scripts/bot-errors-emit.py": s1, sp.F10_PATH: s2}, f10_sha=s2)
    ok, mismatches = sp.verify_bundle(b, pin)
    assert ok is True and mismatches == []


def test_bundle_flags_missing_and_mismatch(tmp_path):
    b = tmp_path / "bundle"; _write(b / sp.F10_PATH, b"WRONG\n")
    pin = sp.Pin(head_sha="a"*40, files={"deploy/scripts/bot-errors-emit.py": "0"*64, sp.F10_PATH: "1"*64}, f10_sha="1"*64)
    ok, mismatches = sp.verify_bundle(b, pin)
    assert ok is False and {m[1] for m in mismatches} == {"missing", "sha"}


# ---------------------------------------------------------------------------
# Increment 4 — edge cases for coverage >= 98%
# ---------------------------------------------------------------------------

def test_sha256_file_large_chunked(tmp_path):
    p = tmp_path / "big.bin"; data = b"x" * (65536 * 2 + 7); p.write_bytes(data)
    assert sp._sha256_file(p) == hashlib.sha256(data).hexdigest()


def test_trust_reason_when_f10_none():
    ok, reason = sp.verify_pin_trust(sp.Pin(head_sha="a"*40, files={}, f10_sha=None), approved_f10={"x"}, commit_exists=lambda s: True)
    assert ok is False and "none" in reason
