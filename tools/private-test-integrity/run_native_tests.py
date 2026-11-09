"""Run only public synthetic native fixtures under the existing group supervisor.

This is separate from the pure runner's no-child/no-network audit guard.
An outer test/router deadline is still required; escaped descendants are excluded.
"""

import argparse
import hashlib
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from private_scanner_candidate import RunnerPlan, run_scanner_privately
from scanner_runtime import _read_capture


CANARY = ROOT / "tests" / "native_capture_canary.py"
SOURCES = (
    ROOT / "private_scanner_candidate.py", ROOT / "runtime_capture.py",
    ROOT / "scanner_runtime.py", ROOT / "bounded_github.py",
    ROOT / "github_binding.py", CANARY,
)


def source_pins() -> dict[str, str]:
    if any(not path.is_file() or path.is_symlink() for path in SOURCES):
        raise ValueError("native source is unavailable")
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in SOURCES}


def validate_receipt(value: object, pins: dict[str, str], scratch: Path) -> None:
    if not isinstance(value, dict):
        raise ValueError("native receipt is not an object")
    cases = value.get("cases")
    if not isinstance(cases, list) or len(cases) != 6 or not isinstance(cases[2], dict):
        raise ValueError("native case inventory differs")
    overflow_conclusion = cases[2].get("conclusion")
    if overflow_conclusion != "inconclusive":
        raise ValueError("overflow conclusion differs")
    expected = {
        "status": "passed", "error": None, "scratch_removed": True,
        "caller_tmpdir": str(scratch), "input_sha256": pins,
        "limits": ["outer watchdog required", "escaped descendant containment is not claimed"],
        "cases": [
            {"case": "small-json", "capture_bytes": 16, "conclusion": "pass", "status": "passed", "validator": "accepted"},
            {"case": "dependency-write", "capture_bytes": 16, "conclusion": "pass", "status": "passed", "dependency_bytes": 524288},
            {"case": "bounded-overflow", "capture_bytes": 262144, "conclusion": overflow_conclusion, "status": "passed", "validator": "refused"},
            {"case": "existing-output", "capture_bytes": 17, "conclusion": "inconclusive", "status": "passed"},
            {"case": "symlink-output", "capture_bytes": 15, "conclusion": "inconclusive", "status": "passed"},
            {"case": "malformed-command", "capture_bytes": 0, "conclusion": "inconclusive", "status": "passed"},
        ],
    }
    if value != expected:
        raise ValueError("native receipt does not establish every fixture expectation")


def main(result: Path) -> int:
    scratch = Path(os.environ.get("TMPDIR", ""))
    if os.name != "posix" or not scratch.is_absolute() or scratch.resolve(strict=True) != scratch or not scratch.is_dir():
        raise ValueError("native fixtures require POSIX and canonical caller-owned TMPDIR")
    if not result.is_absolute() or result.exists() or result.is_symlink() or result.parent.resolve(strict=True) != result.parent:
        raise ValueError("native result path must be new and canonical")
    pins = source_pins()
    plan = RunnerPlan(
        command=(sys.executable, "-I", "-S", "-B", str(CANARY), "--result", str(result)),
        environment={"PATH": "/usr/bin:/bin", "HOME": str(scratch), "LANG": "C", "LC_ALL": "C"},
        cwd=ROOT, check_name="public native capture qualification", head_sha="a" * 40,
    )
    # The canary owns a 50-second internal deadline; the supervisor retains cleanup time.
    observed = run_scanner_privately(plan, timeout_seconds=60)
    if observed != plan.public_result("pass") or source_pins() != pins:
        raise ValueError("native execution or source custody is inconclusive")
    validate_receipt(_read_capture(result), pins, scratch)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--result", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        raise SystemExit(main(arguments.result))
    except Exception as error:
        print(f"native qualification failed: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1) from None
