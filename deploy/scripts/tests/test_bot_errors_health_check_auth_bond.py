"""Tests for auth_bond_inventory TOCTOU fix (Bead B1).

Loads bot-errors-health-check.py via importlib (hyphen in filename prevents normal import).
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_check", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_mod = _load_module()
auth_bond_inventory = _mod.auth_bond_inventory


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_instance_root(tmp_path: Path, creds_content: bytes | None, mode: int = 0o700) -> Path:
    """Create a minimal instance_root with auth/creds.json."""
    instance_root = tmp_path / "instance"
    auth_dir = instance_root / "auth"
    auth_dir.mkdir(parents=True)
    auth_dir.chmod(mode)
    if creds_content is not None:
        creds = auth_dir / "creds.json"
        creds.write_bytes(creds_content)
        creds.chmod(0o600)
    return instance_root


def _patch_delay(monkeypatch, delay: float = 0.0):
    """Monkeypatch retry delay constant to speed up tests."""
    monkeypatch.setattr(_mod, "AUTH_BOND_REINSPECT_DELAY_S", delay)


# ---------------------------------------------------------------------------
# (a) Mid-write recovery: empty then valid JSON after retry
#
# We simulate the writer by patching the retry delay to 0 and then
# pre-installing valid JSON on the second read via a side-effect on
# Path.read_bytes. This avoids any real time.sleep in tests while still
# proving the retry loop works.
# ---------------------------------------------------------------------------

def test_mid_write_recovery(tmp_path, monkeypatch):
    """Empty creds.json at first read, valid JSON available on second read.

    With retry delay patched to 0 the function must retry and succeed,
    returning a healthy 'present' line with creds_hash= and no FAIL prefix.
    """
    _patch_delay(monkeypatch)
    monkeypatch.setattr(_mod, "AUTH_BOND_REINSPECT_ATTEMPTS", 3)

    instance_root = _make_instance_root(tmp_path, b"")  # start empty
    creds_path = instance_root / "auth" / "creds.json"
    valid_payload = json.dumps({"me": {"id": "1@s.whatsapp.net"}}).encode()

    # Track how many times read_bytes is called on creds_path specifically.
    # On the first call return empty; on the second return valid JSON.
    original_read_bytes = Path.read_bytes
    call_count = {"n": 0}

    def patched_read_bytes(self):
        if self == creds_path:
            call_count["n"] += 1
            if call_count["n"] == 1:
                return b""  # simulate writer mid-write
            return valid_payload  # writer finished
        return original_read_bytes(self)

    monkeypatch.setattr(Path, "read_bytes", patched_read_bytes)

    result = auth_bond_inventory("test-bot", instance_root, "always_on")

    assert isinstance(result, list) and len(result) == 1, f"Unexpected result: {result}"
    line = result[0]
    assert "FAIL" not in line, f"Got FAIL on mid-write (should have retried): {line}"
    assert "creds_hash=" in line, f"Missing creds_hash in healthy result: {line}"
    assert "present" in line, f"Missing 'present' in healthy result: {line}"
    assert call_count["n"] >= 2, "Expected at least 2 read_bytes calls (first empty, then valid)"


# ---------------------------------------------------------------------------
# (b) Stuck empty >60s: should FAIL with observed-fact text
# ---------------------------------------------------------------------------

def test_stuck_empty_fails_with_observed_text(tmp_path, monkeypatch):
    """Empty creds.json with mtime 120s ago triggers FAIL after retries.

    The FAIL text must state the observed condition (empty/invalid for >60s)
    and must NOT contain the phrase 'at risk'.
    """
    _patch_delay(monkeypatch)
    monkeypatch.setattr(_mod, "AUTH_BOND_REINSPECT_ATTEMPTS", 3)
    monkeypatch.setattr(_mod, "AUTH_BOND_STUCK_MTIME_S", 60)

    instance_root = _make_instance_root(tmp_path, b"")
    creds_path = instance_root / "auth" / "creds.json"

    # Backdate mtime to 120s ago (well past the 60s stuck threshold)
    stale_time = time.time() - 120
    os.utime(creds_path, (stale_time, stale_time))

    result = auth_bond_inventory("test-bot", instance_root, "always_on")

    assert isinstance(result, list) and len(result) == 1, f"Unexpected result: {result}"
    line = result[0]
    assert line.startswith("FAIL "), f"Expected FAIL for stuck-empty >60s: {line}"
    assert "at risk" not in line, f"Must not infer 'at risk' — only state observed facts: {line}"
    # Must state the observed condition — empty or invalid for > 60s
    assert "empty_or_invalid_for_seconds" in line or "creds_json_empty_or_invalid_for_seconds" in line, (
        f"Must state observed seconds-empty condition: {line}"
    )
    assert "credential_path" in line, f"Must redact credential path: {line}"


# ---------------------------------------------------------------------------
# (c) Transient empty <60s: NON-FAIL, signals write-in-flight
# ---------------------------------------------------------------------------

def test_transient_empty_fresh_mtime_not_fail(tmp_path, monkeypatch):
    """Empty creds.json with fresh mtime (just written) must NOT emit FAIL.

    Must signal write-in-flight with no FAIL prefix.
    """
    _patch_delay(monkeypatch)
    monkeypatch.setattr(_mod, "AUTH_BOND_REINSPECT_ATTEMPTS", 3)
    monkeypatch.setattr(_mod, "AUTH_BOND_STUCK_MTIME_S", 60)

    instance_root = _make_instance_root(tmp_path, b"")
    # mtime is fresh (just created) — well within the 60s window

    result = auth_bond_inventory("test-bot", instance_root, "always_on")

    assert isinstance(result, list) and len(result) == 1, f"Unexpected result: {result}"
    line = result[0]
    assert not line.startswith("FAIL "), f"Must NOT emit FAIL for transient empty (fresh mtime): {line}"
    # Must signal write-in-flight
    assert "creds_write_in_flight=true" in line, f"Must signal write-in-flight: {line}"


# ---------------------------------------------------------------------------
# (d) Regression: valid creds.json — normal healthy line; modes checked
# ---------------------------------------------------------------------------

def test_valid_creds_returns_present_line(tmp_path, monkeypatch):
    """Normal valid creds.json with correct modes returns healthy present line."""
    _patch_delay(monkeypatch)

    valid_payload = json.dumps({"me": {"id": "99@s.whatsapp.net"}}).encode()
    instance_root = _make_instance_root(tmp_path, valid_payload, mode=0o700)
    (instance_root / "auth" / "creds.json").chmod(0o600)

    result = auth_bond_inventory("test-bot", instance_root, "always_on")

    assert isinstance(result, list) and len(result) == 1, f"Unexpected result: {result}"
    line = result[0]
    assert "FAIL" not in line, f"Valid creds should not FAIL: {line}"
    assert "present" in line, f"Should contain 'present': {line}"
    assert "creds_hash=" in line, f"Should contain creds_hash: {line}"
    assert "me_hash=" in line, f"Should contain me_hash: {line}"


def test_mode_violation_returns_fail(tmp_path, monkeypatch):
    """Valid creds.json but wide mode emits FAIL for mode violation (regression)."""
    _patch_delay(monkeypatch)

    valid_payload = json.dumps({"me": {"id": "99@s.whatsapp.net"}}).encode()
    instance_root = _make_instance_root(tmp_path, valid_payload, mode=0o755)
    (instance_root / "auth" / "creds.json").chmod(0o644)

    result = auth_bond_inventory("test-bot", instance_root, "always_on")

    assert isinstance(result, list) and len(result) == 1, f"Unexpected result: {result}"
    line = result[0]
    assert "FAIL" in line, f"Wide mode should produce FAIL: {line}"
    assert "mode_violation" in line, f"Should describe mode_violation: {line}"


# ---------------------------------------------------------------------------
# (e) Wrong-root-type JSON: valid JSON but not a dict -> immediate FAIL,
#     with the consistent (plural) credential_paths_redacted marker.
# ---------------------------------------------------------------------------

def test_wrong_root_type_json_fails(tmp_path, monkeypatch):
    """creds.json that is valid JSON but a non-dict root (e.g. a list) fails fast.

    No retry can fix a structurally wrong root type. The line must FAIL and use
    the same plural credential_paths_redacted=true marker as every other branch.
    """
    _patch_delay(monkeypatch)
    monkeypatch.setattr(_mod, "AUTH_BOND_REINSPECT_ATTEMPTS", 3)

    instance_root = _make_instance_root(tmp_path, b'["not", "a", "dict"]')

    result = auth_bond_inventory("test-bot", instance_root, "always_on")

    assert isinstance(result, list) and len(result) == 1, f"Unexpected result: {result}"
    line = result[0]
    assert line.startswith("FAIL "), f"Wrong root type should FAIL: {line}"
    assert "root_type=list" in line, f"Should report observed root_type: {line}"
    # Field-name consistency: plural marker, matching all other auth_bond branches.
    assert "credential_paths_redacted=true" in line, f"Must use plural marker: {line}"
    assert "credential_path_redacted=true" not in line, f"Singular marker is inconsistent: {line}"


def test_auth_failure_log_inventory_flags_terminal_auth_class(tmp_path, monkeypatch):
    """Log-only terminal auth classes still require physical intervention."""
    monkeypatch.setenv("HOME", str(tmp_path))
    name = "line-gamma"
    log_dir = tmp_path / ".local" / "share" / "whatsoup" / "instances" / name / "logs"
    log_dir.mkdir(parents=True)
    (log_dir / "whatsoup.log").write_text(
        "connection closed auth_failure_class=pairing_required\n",
        encoding="utf-8",
    )

    result = _mod.auth_failure_log_inventory(name, "always_on", "FAIL health line-gamma")

    assert result == [
        (
            f"FAIL auth_bond {name}: physical_intervention_required "
            f"recent_log_pattern=terminal_auth_failure_class log={log_dir / 'whatsoup.log'}"
        )
    ]
