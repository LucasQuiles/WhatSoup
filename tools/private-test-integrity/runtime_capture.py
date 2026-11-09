"""Bound probe output; the existing scanner supervisor owns the process group."""

import os
from pathlib import Path
import resource
import subprocess
import sys


MAX_OUTPUT_BYTES = 262_144
PROBE_FILENAMES = (
    "python_test.py", "javascript.test.js", "typescript.test.ts", "tsx.test.tsx", "bash_test.sh",
)
PROBE_PATHS = frozenset(
    f"{directory}/{name}"
    for directory in ("runtime-valid", "runtime-invalid")
    for name in PROBE_FILENAMES
)


def capture(output: Path, command: tuple[str, ...]) -> int:
    """Capture fixed probes; caller must discard stderr and supervise the group."""
    if (
        not isinstance(output, Path)
        or not output.is_absolute()
        or output.parent.resolve(strict=True) != output.parent
        or not output.parent.is_dir()
        or output.exists()
        or output.is_symlink()
        or not isinstance(command, tuple)
        or not command
        or any(type(part) is not str or not part or "\0" in part for part in command)
    ):
        raise ValueError("private capture input is invalid")
    entrypoint = Path(command[0])
    if (
        not entrypoint.is_absolute()
        or entrypoint.resolve(strict=True) != entrypoint
        or entrypoint.name != "test-integrity"
        or entrypoint.parent.name != "scripts"
        or not entrypoint.is_file()
        or not os.access(entrypoint, os.X_OK)
    ):
        raise ValueError("private capture entrypoint is invalid")
    tail = command[1:]
    doctor = tail == ("doctor", "parsers", "--json")
    scan = (
        tail[:5] == ("scan", "--format", "json", "--ci", "--")
        and bool(tail[5:])
        and len(set(tail[5:])) == len(tail[5:])
        and all(path in PROBE_PATHS for path in tail[5:])
    )
    if not doctor and not scan:
        raise ValueError("private capture command is invalid")

    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    # A process-wide file limit also truncates the scanner's parser libraries.
    # Bound this stream while dependency writes retain the runner's disk policy.
    with os.fdopen(descriptor, "wb") as destination:
        child = subprocess.Popen(
            command, env=dict(os.environ), stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True,
        )
        try:
            content = child.stdout.read(MAX_OUTPUT_BYTES)
            destination.write(content)
            if len(content) >= MAX_OUTPUT_BYTES:
                raise ValueError("private capture output exceeds its limit")
            returncode = child.wait()
            return returncode if returncode in (0, 1) else 2
        finally:
            if child.poll() is None:
                child.kill()
            child.stdout.close()
            child.wait(timeout=5)


if __name__ == "__main__":
    try:
        raise SystemExit(capture(Path(sys.argv[1]), tuple(sys.argv[2:])))
    except Exception:
        raise SystemExit(2) from None
