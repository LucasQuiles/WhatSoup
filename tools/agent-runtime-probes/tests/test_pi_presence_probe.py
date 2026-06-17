#!/usr/bin/env python3
"""Tests for pi_presence_probe: du() branches, main() verdict branches, and CLI e2e.

No-install: mocks PATH lookup and the subprocess helper; the CLI entrypoint test
runs the probe as a real subprocess to cover the `__main__` path without installing pi.
"""
import io
import json
import os
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pi_presence_probe as probe  # noqa: E402

PROBE_PATH = Path(__file__).resolve().parent.parent / "pi_presence_probe.py"
KNOWN_PATH_KEYS = {
    "~/.pi", "~/.pi/agent", "~/.pi/agent/settings.json",
    "~/.pi/agent/auth.json", "~/.config/pi",
}


def test_du_returns_none_for_missing_path():
    assert probe.du(Path("/nonexistent-xyz/.pi")) is None


def test_du_returns_size_for_existing_path():
    orig = probe.run
    probe.run = lambda cmd, timeout=10: {"rc": 0, "stdout": "12K\t/tmp"}
    try:
        assert probe.du(Path.home()) == "12K"
    finally:
        probe.run = orig


def test_du_returns_none_when_command_fails():
    orig = probe.run
    probe.run = lambda cmd, timeout=10: {"rc": 1, "stdout": ""}
    try:
        assert probe.du(Path.home()) is None
    finally:
        probe.run = orig


def test_main_pi_absent_reports_not_callable():
    orig_which = probe.shutil.which
    probe.shutil.which = lambda name: None
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        probe.shutil.which = orig_which
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["schema"] == "agent-runtime-pi-presence"
    assert report["pi_on_path"] is None
    assert report["version"] is None
    assert report["verdict"] == "not locally callable"
    assert set(report["known_paths"]) == KNOWN_PATH_KEYS


def test_main_pi_present_reports_callable():
    orig_which, orig_run = probe.shutil.which, probe.run
    probe.shutil.which = lambda name: "/usr/local/bin/pi"
    probe.run = lambda cmd, timeout=10: {"rc": 0, "stdout": "pi 1.2.3", "stderr": ""}
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = probe.main()
    finally:
        probe.shutil.which, probe.run = orig_which, orig_run
    assert rc == 0
    report = json.loads(buf.getvalue())
    assert report["pi_on_path"] == "/usr/local/bin/pi"
    assert report["version"]["stdout"] == "pi 1.2.3"
    assert report["verdict"] == "callable on PATH"


def test_cli_entrypoint_emits_valid_json():
    # e2e: covers the `if __name__ == "__main__"` entrypoint + the real json.dump path.
    proc = subprocess.run(
        [sys.executable, str(PROBE_PATH)],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0
    report = json.loads(proc.stdout)
    assert report["schema"] == "agent-runtime-pi-presence"
    assert "verdict" in report and "known_paths" in report


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} pi_presence_probe tests passed")
