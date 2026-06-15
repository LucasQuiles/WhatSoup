"""TDD tests for sentinel_pin.py — Fleet Runtime Sentinel Plan 1 (Pin Foundation)."""
from __future__ import annotations
import json, pathlib, sys
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
