"""Tests for subprocess timeout guards in bot-errors-health-check.py (DP4).

Verifies that systemctl_is_active, launchctl_print, process_uptime_seconds,
and systemctl_show_properties all have timeout=3 and handle TimeoutExpired
rather than hanging indefinitely.  The sibling service_enabled function is
the model: it already has timeout=3 + TimeoutExpired handling.
"""
from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path
from unittest.mock import patch

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


# ---------------------------------------------------------------------------
# systemctl_is_active
# ---------------------------------------------------------------------------

class TestSystemctlIsActive:
    def test_timeout_returns_sentinel(self):
        """TimeoutExpired must return a 'timeout:' string, not propagate."""
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="systemctl", timeout=3)):
            result = _mod.systemctl_is_active("whatsoup@remote-1")
        assert result.startswith("timeout:"), f"Expected timeout sentinel, got {result!r}"

    def test_file_not_found_returns_unavailable(self):
        with patch("subprocess.run", side_effect=FileNotFoundError):
            result = _mod.systemctl_is_active("whatsoup@remote-1")
        assert result == "unavailable:systemctl"

    def test_dry_status_env_bypasses_subprocess(self, monkeypatch):
        monkeypatch.setenv("BOT_ERRORS_DRY_SERVICE_STATUS", "active")
        # subprocess.run should never be called
        with patch("subprocess.run", side_effect=AssertionError("should not call subprocess")):
            result = _mod.systemctl_is_active("whatsoup@remote-1")
        assert result == "active"


# ---------------------------------------------------------------------------
# launchctl_print
# ---------------------------------------------------------------------------

class TestLaunchctlPrint:
    def test_timeout_returns_empty_string(self):
        """TimeoutExpired must return '', not propagate."""
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="launchctl", timeout=3)):
            result = _mod.launchctl_print("com.whatsoup.test-bot")
        assert result == "", f"Expected empty string on timeout, got {result!r}"

    def test_file_not_found_returns_empty_string(self):
        with patch("subprocess.run", side_effect=FileNotFoundError):
            result = _mod.launchctl_print("com.whatsoup.test-bot")
        assert result == ""


# ---------------------------------------------------------------------------
# process_uptime_seconds
# ---------------------------------------------------------------------------

class TestProcessUptimeSeconds:
    def test_timeout_returns_none(self):
        """TimeoutExpired must return None, not propagate."""
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="ps", timeout=3)):
            result = _mod.process_uptime_seconds(1234)
        assert result is None, f"Expected None on timeout, got {result!r}"

    def test_file_not_found_returns_none(self):
        with patch("subprocess.run", side_effect=FileNotFoundError):
            result = _mod.process_uptime_seconds(1234)
        assert result is None


# ---------------------------------------------------------------------------
# systemctl_show_properties
# ---------------------------------------------------------------------------

class TestSystemctlShowProperties:
    def test_timeout_returns_empty_dict(self):
        """TimeoutExpired must return {}, not propagate."""
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="systemctl", timeout=3)):
            result = _mod.systemctl_show_properties("whatsoup@remote-1", ["ActiveEnterTimestampMonotonic"])
        assert result == {}, f"Expected empty dict on timeout, got {result!r}"

    def test_file_not_found_returns_empty_dict(self):
        with patch("subprocess.run", side_effect=FileNotFoundError):
            result = _mod.systemctl_show_properties("whatsoup@remote-1", ["ActiveEnterTimestampMonotonic"])
        assert result == {}
