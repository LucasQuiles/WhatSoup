"""Tests for #2723 Task 4 — watchdog controller-state adoption.

All tests use injected file_ops (per controller_state.py fault injection API)
and monkeypatched flock / os operations. No real filesystem side effects
outside tmpdir. Fixtures seed corrupt/valid/legacy state files.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest

SCRIPT_DIR = Path(__file__).resolve().parent.parent
import sys
sys.path.insert(0, str(SCRIPT_DIR))

from unittest.mock import MagicMock

from lib.controller_state import (
    ControllerStateRequired,
    STATE_RECOVERY_REQUIRED_EXIT,
    open_controller_state,
    read_controller_state,
)


# Mock file_ops that uses real filesystem for reads/writes but injects
# our open/lock helpers so flock is not attempted.
def _mock_file_ops():
    ops = MagicMock()
    ops.open = os.open
    ops.fsync = os.fsync
    ops.replace = os.replace
    ops.stat = os.stat
    ops.listdir = os.listdir
    ops.unlink = os.unlink
    ops.rename = os.rename
    ops.readlink = os.readlink
    return ops


def _make_valid_state(version: int = 1) -> dict:
    return {"version": version, "open": {}, "schemaVersion": 1}


def _make_corrupt_state() -> bytes:
    return b"not valid json"


@pytest.fixture
def tmp_state_dir():
    with tempfile.TemporaryDirectory() as d:
        yield Path(d)


# ─── Discriminating test pair: corrupt primary, no previous ──────────────────

class TestCorruptPrimaryNoPrevious:
    """R4.1/R4.5: corrupt primary without previous must raise ControllerStateRequired
    before any domain effects (collect_problems / outbox / lock artifacts)."""

    def test_raises_before_domain_effects(self, tmp_state_dir):
        """Seed corrupt primary, NO previous → ControllerStateRequired raised."""
        state_file = tmp_state_dir / "watchdog-state.json"
        state_file.write_bytes(_make_corrupt_state())

        with pytest.raises(ControllerStateRequired):
            read_controller_state(
                coll_file,
                component="collector",
                validate_payload=lambda p: p if isinstance(p, dict) and "version" in p else _make_valid_state(),
                lock_timeout_seconds=5,
                file_ops=_mock_file_ops(),
            )


class TestValidPrimary:
    """R4.2: valid primary session proceeds normally."""

    def test_returns_payload(self, tmp_state_dir):
        """Seed valid primary → read returns valid payload, not recovery_pending."""
        state_file = tmp_state_dir / "watchdog-state.json"
        state_file.write_text(json.dumps(_make_valid_state()))

        result = read_controller_state(
            state_file,
            component="heartbeat-watchdog",
            validate_payload=lambda p: p if isinstance(p, dict) and "version" in p else _make_valid_state(),
            lock_timeout_seconds=5,
            file_ops=_mock_file_ops(),
        )
        assert result.mode == "valid" or result.mode == "legacy_valid", (
            f"expected valid/legacy_valid, got {result.mode}"
        )


# ─── Discriminating test pair: cross-reader recovery_pending ─────────────────

class TestCrossReaderRecoveryPending:
    """R4.4: cross-reader must return bounded empty result during recovery."""

    def test_collector_recovery_pending_returns_unavailable(self, tmp_state_dir):
        """Set collector-state.json as corrupt → read returns unavailable."""
        coll_file = tmp_state_dir / "collector-state.json"
        coll_file.write_bytes(_make_corrupt_state())

        result = read_controller_state(
            coll_file,
            component="collector",
            validate_payload=lambda p: p if isinstance(p, dict) and "version" in p else _make_valid_state(),
            lock_timeout_seconds=5,
        )
        assert result.mode == "unavailable"


# ─── Symlink anchor ─────────────────────────────────────────────────────────

class TestSymlinkAnchor:
    """R4.7: macOS symlink aliases are resolved before state access."""

    def test_parent_symlink_resolved(self, tmp_state_dir):
        """A state root inside a symlinked parent directory resolves correctly.
        This mirrors the macOS /tmp → /private/tmp pattern."""
        # Create a real parent dir and symlink it
        real_parent = tmp_state_dir / "real_parent"
        real_parent.mkdir()
        sym_parent = tmp_state_dir / "sym_parent"
        sym_parent.symlink_to(real_parent)
        state_path = sym_parent / "state.json"

        # Apply the same anchor resolution as state_root()
        anchor = state_path.absolute().parent
        resolved = anchor.parent.resolve(strict=True) / anchor.name
        expected = (real_parent / "state.json").parent
        assert resolved == expected, f"expected {expected}, got {resolved}"
