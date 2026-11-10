"""Run the public adapter's pure tests without private scanner access."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys


ROOT = Path(__file__).resolve().parent


def main(pattern: str = "test_*.py") -> int:
    temporary = Path(os.environ.get("TMPDIR", ""))
    if not temporary.is_absolute() or temporary.resolve(strict=True) != temporary or not temporary.is_dir():
        raise SystemExit("tests require an existing canonical caller-owned TMPDIR")
    sys.dont_write_bytecode = True
    denied = []

    def prohibit_process(event, _args):
        if event in {
            "subprocess.Popen", "os.fork", "os.forkpty", "os.exec", "os.posix_spawn",
            "os.system", "pty.spawn", "socket.connect", "socket.connect_ex", "socket.getaddrinfo",
        }:
            denied.append(event)
            raise RuntimeError("native children and network access are prohibited in pure tests")

    sys.addaudithook(prohibit_process)
    signal.signal(signal.SIGALRM, lambda *_: os._exit(124))
    signal.alarm(45)
    try:
        subprocess.Popen([sys.executable, "-c", "raise SystemExit(99)"])
    except RuntimeError:
        pass
    if denied != ["subprocess.Popen"]:
        raise SystemExit("no-child test guard failed")
    denied.clear()

    # Import test dependencies only after the no-child guard is active.
    sys.path.insert(0, str(ROOT))
    import unittest

    suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"), pattern=pattern)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    summary = {
        "no_child_guard_canary": "passed",
        "unexpected_process_attempts": denied,
        "tests_run": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "skipped": len(result.skipped),
    }
    print(json.dumps(summary), flush=True)
    signal.alarm(0)
    return 0 if result.wasSuccessful() and result.testsRun and not result.skipped and not denied else 1


if __name__ == "__main__":
    raise SystemExit(main())
