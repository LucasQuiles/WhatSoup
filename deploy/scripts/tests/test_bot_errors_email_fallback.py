"""Tests for email_fallback exception safety (DP3).

Verifies that TimeoutExpired and OSError raised inside subprocess.run
are caught and cause email_fallback to return False rather than
propagating a traceback that would interrupt deadman state saves.

Tests cover both bot-errors-health-check.py and bot-errors-dispatcher.py,
which have identical email_fallback implementations.
"""
from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Module loaders
# ---------------------------------------------------------------------------

_SCRIPTS = Path(__file__).resolve().parents[1]


def _load(name: str):
    path = _SCRIPTS / name
    spec = importlib.util.spec_from_file_location(name.replace("-", "_").replace(".py", ""), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_hc = _load("bot-errors-health-check.py")
_dp = _load("bot-errors-dispatcher.py")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_executable_fallback(tmp_path: Path) -> str:
    """Create a dummy executable script that the existence+exec check passes."""
    script = tmp_path / "email-fallback"
    script.write_text("#!/bin/sh\nexit 0\n")
    script.chmod(0o755)
    return str(script)


# ---------------------------------------------------------------------------
# Tests — health-check
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("mod_name,mod", [
    ("bot-errors-health-check.py", _hc),
    ("bot-errors-dispatcher.py", _dp),
])
class TestEmailFallbackExceptionSafety:
    def test_timeout_expired_returns_false(self, tmp_path, mod_name, mod):
        """subprocess.TimeoutExpired must be caught; email_fallback returns False."""
        fallback_bin = _make_executable_fallback(tmp_path)
        with patch.object(mod, "EMAIL_FALLBACK", fallback_bin), \
             patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd=fallback_bin, timeout=20)):
            result = mod.email_fallback("subject", "body")
        assert result is False, f"{mod_name}: TimeoutExpired should return False, got {result!r}"

    def test_oserror_returns_false(self, tmp_path, mod_name, mod):
        """OSError (e.g. ENOMEM, exec failure) must be caught; email_fallback returns False."""
        fallback_bin = _make_executable_fallback(tmp_path)
        with patch.object(mod, "EMAIL_FALLBACK", fallback_bin), \
             patch("subprocess.run", side_effect=OSError("mock exec error")):
            result = mod.email_fallback("subject", "body")
        assert result is False, f"{mod_name}: OSError should return False, got {result!r}"

    def test_success_returns_true(self, tmp_path, mod_name, mod):
        """Sanity: a zero-exit subprocess still returns True."""
        fallback_bin = _make_executable_fallback(tmp_path)
        mock_proc = subprocess.CompletedProcess(args=[], returncode=0)
        with patch.object(mod, "EMAIL_FALLBACK", fallback_bin), \
             patch("subprocess.run", return_value=mock_proc):
            result = mod.email_fallback("subject", "body")
        assert result is True, f"{mod_name}: returncode=0 should return True, got {result!r}"

    def test_nonzero_exit_returns_false(self, tmp_path, mod_name, mod):
        """A non-zero exit code returns False (not an exception case, but covered for completeness)."""
        fallback_bin = _make_executable_fallback(tmp_path)
        mock_proc = subprocess.CompletedProcess(args=[], returncode=1)
        with patch.object(mod, "EMAIL_FALLBACK", fallback_bin), \
             patch("subprocess.run", return_value=mock_proc):
            result = mod.email_fallback("subject", "body")
        assert result is False, f"{mod_name}: returncode=1 should return False, got {result!r}"
