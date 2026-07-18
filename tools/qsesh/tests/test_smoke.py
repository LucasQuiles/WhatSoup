"""T01 smoke: the qsesh package imports and its module entry answers --help."""

import os
import subprocess
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def test_version_literal():
    sys.path.insert(0, str(PACKAGE_ROOT))
    try:
        import qsesh
    finally:
        sys.path.remove(str(PACKAGE_ROOT))
    assert qsesh.__version__ == "0.1.0"


def test_module_help_exits_zero_with_parseable_stdout():
    env = dict(os.environ, PYTHONPATH=str(PACKAGE_ROOT), PYTHONDONTWRITEBYTECODE="1")
    proc = subprocess.run(
        [sys.executable, "-m", "qsesh", "--help"],
        capture_output=True,
        timeout=30,
        env=env,
    )
    assert proc.returncode == 0
    text = proc.stdout.decode("utf-8")
    assert text.strip(), "help stdout must be non-empty"
    assert "qsesh" in text
