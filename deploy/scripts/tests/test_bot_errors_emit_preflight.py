"""Tests for emit.py durable event-writer private-directory preflight.

Mirrors the collector/runner H1 pattern: writing to an outbox whose directory
does not yet exist should succeed (the preflight creates it) rather than
crashing with a raw OS error.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).parent.parent / "bot-errors-emit.py"


def _load_emit():
    spec = importlib.util.spec_from_file_location("bot_errors_emit", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_mod = _load_emit()


class TestDurableEventPreflight:
    """write_event creates and validates its private publication root."""

    @staticmethod
    def _event() -> dict[str, object]:
        return {
            "id": "event-1",
            "createdAt": "2026-07-28T00:00:00Z",
            "instance": "fixture",
            "source": "preflight",
        }

    def test_creates_parent_dir_and_writes_file(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        outbox = tmp_path / "subdir"
        assert not outbox.exists(), "precondition: parent must not exist yet"
        monkeypatch.setattr(_mod, "outbox_dir", lambda: outbox)

        written = _mod.write_event(self._event())

        assert written.exists()
        assert json.loads(written.read_text(encoding="utf-8")) == self._event()

    def test_parent_dir_has_restricted_permissions(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        outbox = tmp_path / "subdir"
        monkeypatch.setattr(_mod, "outbox_dir", lambda: outbox)
        _mod.write_event(self._event())
        mode = outbox.stat().st_mode & 0o777
        assert mode == 0o700, f"expected 0o700 perms on parent, got {oct(mode)}"
