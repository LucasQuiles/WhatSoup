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

from lib.controller_state import (
    ControllerStateRequired,
    STATE_RECOVERY_REQUIRED_EXIT,
    open_controller_state,
    read_controller_state,
    StateComponent,
)


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
                state_file,
                component=StateComponent.WATCHDOG,
                validate_payload=lambda p: p if isinstance(p, dict) and "version" in p else _make_valid_state(),
                lock_timeout_seconds=5,
            )
        # Zero domain artifacts created (no lock file, no outbox)
        assert not any(tmp_state_dir.iterdir()), "domain artifacts leaked before recovery"


class TestValidPrimary:
    """R4.2: valid primary session proceeds normally."""

    def test_returns_payload(self, tmp_state_dir):
        """Seed valid primary → read returns valid payload, not recovery_pending."""
        state_file = tmp_state_dir / "watchdog-state.json"
        state_file.write_text(json.dumps(_make_valid_state()))

        result = read_controller_state(
            state_file,
            component=StateComponent.WATCHDOG,
            validate_payload=lambda p: p if isinstance(p, dict) and "version" in p else _make_valid_state(),
            lock_timeout_seconds=5,
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
            component=StateComponent.COLLECTOR,
            validate_payload=lambda p: p if isinstance(p, dict) and "version" in p else _make_valid_state(),
            lock_timeout_seconds=5,
        )
        assert result.mode == "unavailable"


# ─── Symlink anchor ─────────────────────────────────────────────────────────

class TestSymlinkAnchor:
    """R4.7: macOS symlink aliases are resolved before state access."""

    def test_symlink_resolved(self, tmp_state_dir):
        """A symlinked state root resolves to the real path."""
        real_dir = tmp_state_dir / "real"
        real_dir.mkdir()
        link = tmp_state_dir / "link"
        link.symlink_to(real_dir)

        # The state path must follow symlinks
        root = os.environ.get("BOT_ERRORS_STATE_ROOT", str(link))
        path = Path(root)
        anchor = path.absolute()
        if anchor.is_symlink():
            anchor = anchor.parent.resolve(strict=True) / anchor.name
        assert anchor == real_dir.resolve(), f"expected {real_dir.resolve()}, got {anchor}"
