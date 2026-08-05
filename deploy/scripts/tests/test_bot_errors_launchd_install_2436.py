"""Tests for #2436: launchd bootstrap failure doesn't abort remaining installs.

fails-before:  launchctl bootstrap fails → set -e aborts whole script → remaining
               services (dispatcher, deadman, health, watchdog) not installed.
passes-after:  bootstrap failure falls back to load + stderr warning → remaining
               services installed. Normal bootstrap success unchanged.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


_SCRIPT = Path(__file__).resolve().parents[1] / "install-bot-errors-launchd.sh"


def test_script_parses():
    """Shell script is syntactically valid."""
    result = subprocess.run(
        ["bash", "-n", str(_SCRIPT)],
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, f"syntax error: {result.stderr}"
    print("PASS: script_parses")


def test_write_plist_has_fallback():
    """write_plist captures the bootstrap rc, falls back to load, and the
    installer propagates the first bootstrap failure (fail-closed contract).

    Behavioral coverage for the rejected-bootstrap path lives in
    tests/scripts/bot-errors-service-templates.test.ts (launchctl shims).
    """
    text = _SCRIPT.read_text()
    assert 'launchctl bootstrap "gui/$UID_VALUE" "$path" 2>/dev/null || rc=$?' in text, (
        "bootstrap rc must be captured without if-! inversion"
    )
    assert "launchctl load" in text, "must fall back to load"
    assert "warning:" in text, "must print warning on stderr"
    assert "BOOTSTRAP_FAILED_RC" in text, "first bootstrap failure must be recorded"
    assert 'exit "$BOOTSTRAP_FAILED_RC"' in text, (
        "installer must propagate the first bootstrap failure code overall"
    )
    print("PASS: write_plist_has_fallback")


def test_bootstrap_success_path_preserved():
    """Normal bootstrap success path is unchanged (bootstrap runs first)."""
    text = _SCRIPT.read_text()
    assert "launchctl bootstrap" in text, "bootstrap must still be attempted"
    assert "bootout" in text, "bootout must still be attempted"
    assert "enable" in text, "enable must still be attempted"
    print("PASS: bootstrap_success_preserved")


if __name__ == "__main__":
    test_script_parses()
    test_write_plist_has_fallback()
    test_bootstrap_success_path_preserved()
    print()
    print("ALL 3 TESTS PASS (TRUE_RC=0)")
