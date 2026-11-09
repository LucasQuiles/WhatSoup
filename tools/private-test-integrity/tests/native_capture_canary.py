#!/usr/bin/env python3
"""Native fixture canary for the bounded private runtime-capture helper.

This needs an external router/watchdog. It qualifies only the synthetic helper
fixtures below, not the private scanner, its Linux ABI, or escaped descendants.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import sys
import tempfile
import time


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CORE = ROOT / "private_scanner_candidate.py"
CAPTURE = ROOT / "runtime_capture.py"
SOURCES = (CORE, CAPTURE, ROOT / "scanner_runtime.py", ROOT / "scanner_grammars.py", ROOT / "bounded_github.py", ROOT / "github_binding.py", Path(__file__))
INTERNAL_DEADLINE_SECONDS = 50.0
CHECK_NAME = "runtime capture native fixture"
HEAD_SHA = "a" * 40


class CanaryError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise CanaryError(reason)


def require_new_result(path: Path) -> None:
    require(path.is_absolute() and not path.exists() and not path.is_symlink(), "result path is not new")
    require(path.parent.resolve(strict=True) == path.parent and path.parent.is_dir(), "result parent is not canonical")


def write_result(path: Path, value: dict[str, object]) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=".native-capture-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def assert_group_absent(pid: int) -> None:
    try:
        os.killpg(pid, 0)
    except ProcessLookupError:
        return
    raise CanaryError("owned helper process group remains")


def canonical_tmpdir() -> Path:
    value = os.environ.get("TMPDIR", "")
    parent = Path(value)
    try:
        canonical = parent.resolve(strict=True)
    except OSError as exc:
        raise CanaryError("caller TMPDIR is unavailable") from exc
    require(parent.is_absolute() and canonical == parent and parent.is_dir(), "caller TMPDIR is not canonical")
    return parent


def make_entrypoint(root: Path, name: str, body: str) -> Path:
    entrypoint = root / name / "scripts" / "test-integrity"
    entrypoint.parent.mkdir(mode=0o700, parents=True)
    entrypoint.write_text("#!/bin/sh\n" + body + "\n", encoding="utf-8")
    entrypoint.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    return entrypoint


def expected(conclusion: str) -> dict[str, str]:
    return {"check_name": CHECK_NAME, "head_sha": HEAD_SHA, "conclusion": conclusion}


def main(result_path: Path) -> int:
    require_new_result(result_path)
    require(CORE.is_file() and not CORE.is_symlink(), "runner source is unavailable")
    require(CAPTURE.is_file() and not CAPTURE.is_symlink(), "capture helper is unavailable")
    source_before = {path.name: sha256(path) for path in SOURCES}
    parent = canonical_tmpdir()
    sys.path.insert(0, str(ROOT))
    from private_scanner_candidate import RunnerPlan, run_scanner_privately
    from runtime_capture import MAX_OUTPUT_BYTES
    from private_scanner_candidate import BoundaryError
    from scanner_runtime import _read_capture

    previous_tmpdir = os.environ.get("TMPDIR")
    previous_handlers = {item: signal.getsignal(item) for item in (signal.SIGALRM, signal.SIGINT, signal.SIGTERM)}
    previous_timer = signal.setitimer(signal.ITIMER_REAL, INTERNAL_DEADLINE_SECONDS)
    started = time.monotonic()
    scratch: Path | None = None
    cases: list[dict[str, object]] = []
    failure: str | None = None
    children = []

    def deadline_handler(_signum: int, _frame: object) -> None:
        raise CanaryError("internal deadline exceeded")

    def tracked_popen(*args: object, **kwargs: object):
        import subprocess

        child = subprocess.Popen(*args, **kwargs)
        children.append(child)
        return child

    for item in previous_handlers:
        signal.signal(item, deadline_handler)
    try:
        with tempfile.TemporaryDirectory(prefix="runtime-capture-native-", dir=parent) as temporary:
            scratch = Path(temporary)
            os.environ["TMPDIR"] = str(scratch)
            good = make_entrypoint(scratch, "small", "[ \"$1\" = doctor ] && [ \"$2\" = parsers ] && [ \"$3\" = --json ] || exit 2\nprintf '%s\\n' '{\"status\":\"ok\"}'")
            dependency = make_entrypoint(scratch, "dependency", "head -c 524288 /dev/zero > \"$HOME/parser.so\" || exit 2\nprintf '%s\\n' '{\"status\":\"ok\"}'")
            overflow = make_entrypoint(scratch, "overflow", "printf '{}'\ni=0\nwhile [ \"$i\" -lt 270000 ]; do printf ' '; i=$((i + 1)); done")
            marker = scratch / "malformed-executed"
            malformed = make_entrypoint(scratch, "malformed", "printf executed > \"$HOME/malformed-executed\"\nexit 0")

            def run_case(name: str, entrypoint: Path, tail: tuple[str, ...], conclusion: str | tuple[str, ...], output: Path) -> dict[str, object]:
                before = len(children)
                plan = RunnerPlan(
                    command=(str(sys.executable), "-I", "-S", "-B", str(CAPTURE), str(output), str(entrypoint), *tail),
                    environment={"PATH": "/usr/bin:/bin", "HOME": str(scratch)},
                    cwd=scratch,
                    check_name=CHECK_NAME,
                    head_sha=HEAD_SHA,
                )
                observed = run_scanner_privately(
                    plan,
                    timeout_seconds=10,
                    popen=tracked_popen,
                    monotonic=time.monotonic,
                    killpg=os.killpg,
                    sleep=time.sleep,
                )
                allowed = (conclusion,) if isinstance(conclusion, str) else conclusion
                require(any(observed == expected(item) for item in allowed), "public result binding differs")
                require(len(children) == before + 1, "runner did not own exactly one helper process")
                child = children.pop()
                assert_group_absent(child.pid)
                require(child.poll() is not None, "owned helper leader was not reaped")
                return {
                    "case": name,
                    "capture_bytes": output.stat().st_size if output.exists() else 0,
                    "conclusion": observed["conclusion"],
                    "status": "passed",
                }

            success_output = scratch / "small.json"
            success = run_case("small-json", good, ("doctor", "parsers", "--json"), "pass", success_output)
            require(_read_capture(success_output) == {"status": "ok"}, "small JSON differs")
            success["validator"] = "accepted"
            cases.append(success)

            dependency_output = scratch / "dependency.json"
            dependency_case = run_case("dependency-write", dependency, ("doctor", "parsers", "--json"), "pass", dependency_output)
            require(_read_capture(dependency_output) == {"status": "ok"}, "dependency probe JSON differs")
            require((scratch / "parser.so").read_bytes() == bytes(524288), "dependency bytes were truncated")
            dependency_case["dependency_bytes"] = 524288
            cases.append(dependency_case)

            overflow_output = scratch / "overflow.json"
            overflow_case = run_case("bounded-overflow", overflow, ("doctor", "parsers", "--json"), "inconclusive", overflow_output)
            overflow_case["status"] = "inconclusive"
            cases.append(overflow_case)
            require(overflow_case["capture_bytes"] == MAX_OUTPUT_BYTES, "overflow did not reach the exact capture limit")
            try:
                _read_capture(overflow_output)
            except BoundaryError:
                overflow_case["validator"] = "refused"
                overflow_case["status"] = "passed"
            else:
                raise CanaryError("overflow capture was accepted")

            existing_output = scratch / "preserve.json"
            existing_output.write_bytes(b"preserve-existing")
            existing_case = run_case("existing-output", good, ("doctor", "parsers", "--json"), "inconclusive", existing_output)
            require(existing_output.read_bytes() == b"preserve-existing", "existing output changed")
            cases.append(existing_case)

            target = scratch / "preserve-target"
            target.write_bytes(b"preserve-target")
            symlink_output = scratch / "preserve-link.json"
            symlink_output.symlink_to(target)
            symlink_case = run_case("symlink-output", good, ("doctor", "parsers", "--json"), "inconclusive", symlink_output)
            require(target.read_bytes() == b"preserve-target", "symlink target changed")
            cases.append(symlink_case)

            malformed_output = scratch / "malformed.json"
            malformed_case = run_case("malformed-command", malformed, ("not-doctor",), "inconclusive", malformed_output)
            require(not marker.exists() and not malformed_output.exists(), "malformed command executed or created output")
            cases.append(malformed_case)
            require(time.monotonic() - started < INTERNAL_DEADLINE_SECONDS, "internal deadline exceeded")
    except Exception as error:
        failure = type(error).__name__
    finally:
        if previous_tmpdir is None:
            os.environ.pop("TMPDIR", None)
        else:
            os.environ["TMPDIR"] = previous_tmpdir
        signal.setitimer(signal.ITIMER_REAL, previous_timer[0], previous_timer[1])
        for item, handler in previous_handlers.items():
            signal.signal(item, handler)

    scratch_removed = scratch is not None and not scratch.exists()
    source_after = {path.name: sha256(path) for path in SOURCES}
    passed = failure is None and scratch_removed and not children and source_before == source_after
    write_result(result_path, {
        "cases": cases,
        "caller_tmpdir": str(parent),
        "error": failure,
        "input_sha256": source_after,
        "limits": ["outer watchdog required", "escaped descendant containment is not claimed"],
        "scratch_removed": scratch_removed,
        "status": "passed" if passed else "inconclusive",
    })
    return 0 if passed else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--result", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        raise SystemExit(main(arguments.result))
    except CanaryError:
        raise SystemExit(1) from None
