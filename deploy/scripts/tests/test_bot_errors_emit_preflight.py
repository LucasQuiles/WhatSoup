"""Tests for emit.py atomic_write_json ensure_private_dir preflight.

Mirrors the collector/runner H1 pattern: writing to a path whose parent
does not yet exist should succeed (the preflight creates it) rather than
crashing with a raw OS error.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

_SCRIPT = Path(__file__).parent.parent / "bot-errors-emit.py"


def _load_emit():
    spec = importlib.util.spec_from_file_location("bot_errors_emit", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_mod = _load_emit()


class TestAtomicWriteJsonPreflight:
    """atomic_write_json creates the parent directory when it is absent."""

    def test_creates_parent_dir_and_writes_file(self, tmp_path: Path) -> None:
        not_yet_created = tmp_path / "subdir" / "state.json"
        assert not not_yet_created.parent.exists(), "precondition: parent must not exist yet"

        _mod.atomic_write_json(not_yet_created, {"ok": True})

        assert not_yet_created.exists(), "file should have been written"
        import json
        data = json.loads(not_yet_created.read_text())
        assert data == {"ok": True}

    def test_parent_dir_has_restricted_permissions(self, tmp_path: Path) -> None:
        not_yet_created = tmp_path / "subdir" / "state.json"
        _mod.atomic_write_json(not_yet_created, {"x": 1})
        mode = not_yet_created.parent.stat().st_mode & 0o777
        assert mode == 0o700, f"expected 0o700 perms on parent, got {oct(mode)}"
