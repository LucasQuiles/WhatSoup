"""Acquire one immutable private scanner tree through a bounded Git seam.

The runner may only inspect an existing trusted checkout.  It
must verify the SSH origin, commit and tree pins, parse ``ls-tree -r -z -l``,
read only declared regular blobs through the injected bounded runner, and pass
the resulting metadata and bytes to ``export_verified_bundle``.  It must not
fetch, checkout, export ``.git``, execute scanner code, or create a candidate
checkout.  Process-group supervision remains the caller's responsibility.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import math
import os
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import time

from private_scanner_candidate import BoundaryError, _REGULAR_GIT_MODES, _require_sha
from private_bundle import GitLsTreeBlob, VerifiedScannerBundle, export_verified_bundle


PRIVATE_ORIGIN = "git@github.com:LucasQuiles/test-integrity.git"
PINNED_COMMIT = "ea0b01a4e3d99dc58a9a475c57e22ee204b04a7c"
PINNED_TREE = "ef65cbaee8bc20f572a14c30bee85a80dbe8da32"
PINNED_MANIFEST_DIGEST = "0ddb32bde7ea02530e5e3c5bcb92515a299548c8c06f25414e4be7b64b6839f5"
MAX_FILES = 512
MAX_TOTAL_BYTES = 20_000_000
MAX_METADATA_BYTES = 1_000_000
MAX_IDENTITY_BYTES = 256


GitCommandRunner = Callable[[tuple[str, ...], int], bytes]


@dataclass(frozen=True)
class PrivateGitSource:
    """Immutable identity and local checkout supplied by the trusted driver."""

    checkout: Path


def make_bounded_git_runner(
    source: PrivateGitSource,
    *,
    git_binary: Path,
    expected_git_sha256: str,
    deadline_seconds: float = 15,
    max_stderr_bytes: int = 65_536,
    popen=subprocess.Popen,
    select_ready=select.select,
    monotonic=time.monotonic,
    killpg=os.killpg,
) -> GitCommandRunner:
    """Build a fixed read-only Git runner with an outer-watchdog requirement.

    The caller owns TMPDIR and excludes concurrent writers to the trusted
    checkout/executable. Digest checks detect drift; they are not exec isolation.
    """
    if (
        type(deadline_seconds) not in (int, float)
        or not math.isfinite(deadline_seconds)
        or not 0 < deadline_seconds <= 60
        or type(max_stderr_bytes) is not int
        or not 0 <= max_stderr_bytes <= MAX_METADATA_BYTES
        or not isinstance(expected_git_sha256, str)
        or re.fullmatch(r"[0-9a-f]{64}", expected_git_sha256) is None
    ):
        raise BoundaryError("private Git runner limits or executable identity are invalid")

    def verify_inputs() -> None:
        try:
            if (
                not source.checkout.is_absolute()
                or source.checkout.resolve(strict=True) != source.checkout
                or not source.checkout.is_dir()
                or not git_binary.is_absolute()
                or git_binary.resolve(strict=True) != git_binary
            ):
                raise ValueError("noncanonical input")
            with git_binary.open("rb") as binary:
                before = os.fstat(binary.fileno())
                if not stat.S_ISREG(before.st_mode) or not before.st_mode & 0o111 or before.st_size > 67_108_864:
                    raise ValueError("invalid executable")
                digest = hashlib.file_digest(binary, "sha256").hexdigest()
                after = os.fstat(binary.fileno())
            current = git_binary.stat()
            identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
            if digest != expected_git_sha256 or identity(before) != identity(after) or identity(after) != identity(current):
                raise ValueError("executable changed")
        except (OSError, ValueError):
            raise BoundaryError("private Git input identity differs") from None

    verify_inputs()
    prefix = ("git", "-C", str(source.checkout))
    fixed_commands = {
        ("remote", "get-url", "origin"),
        ("rev-parse", "--verify", "--quiet", f"{PINNED_COMMIT}^{{commit}}"),
        ("rev-parse", "--verify", "--quiet", f"{PINNED_COMMIT}^{{tree}}"),
        ("ls-tree", "-r", "-z", "-l", PINNED_TREE),
    }

    def run(argv: tuple[str, ...], maximum_bytes: int) -> bytes:
        if type(maximum_bytes) is not int or not 0 <= maximum_bytes <= MAX_TOTAL_BYTES:
            raise BoundaryError("private Git output limit is invalid")
        if not isinstance(argv, tuple) or not all(isinstance(item, str) for item in argv) or argv[:3] != prefix:
            raise BoundaryError("private Git command is not allowed")
        tail = argv[3:]
        blob_read = len(tail) == 3 and tail[:2] == ("cat-file", "blob") and re.fullmatch(r"[0-9a-f]{40}", tail[2])
        if tail not in fixed_commands and not blob_read:
            raise BoundaryError("private Git command is not allowed")
        verify_inputs()
        try:
            scratch = Path(os.environ.get("TMPDIR", ""))
            if not scratch.is_absolute() or scratch.resolve(strict=True) != scratch or not scratch.is_dir():
                raise ValueError("invalid scratch directory")
        except (OSError, ValueError):
            raise BoundaryError("private Git requires an existing canonical TMPDIR") from None
        environment = {
            "PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C",
            "TMPDIR": str(scratch),
            "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_NO_REPLACE_OBJECTS": "1", "GIT_NO_LAZY_FETCH": "1",
            "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "/usr/bin/false",
            "GIT_ALLOW_PROTOCOL": "", "GIT_OPTIONAL_LOCKS": "0",
        }
        deadline = monotonic() + deadline_seconds
        execution_deadline = deadline - min(3.0, deadline_seconds / 4)
        child = None
        streams = []

        def group_exists() -> bool:
            try:
                killpg(child.pid, 0)
            except ProcessLookupError:
                return False
            return True

        try:
            child = popen(
                (str(git_binary), *argv[1:]), cwd=source.checkout, env=environment,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                shell=False, bufsize=0, close_fds=True, start_new_session=True,
            )
            streams = [child.stdout, child.stderr]
            if any(stream is None for stream in streams):
                raise BoundaryError("private Git output pipes are unavailable")
            pending = list(streams)
            captured = {child.stdout: bytearray(), child.stderr: bytearray()}
            limits = {child.stdout: maximum_bytes, child.stderr: max_stderr_bytes}
            while pending:
                remaining = execution_deadline - monotonic()
                if remaining <= 0:
                    raise BoundaryError("private Git deadline exceeded")
                readable, _, _ = select_ready(pending, [], [], remaining)
                for stream in readable:
                    content = stream.read(min(65_536, limits[stream] - len(captured[stream]) + 1))
                    if not isinstance(content, bytes):
                        raise BoundaryError("private Git output read is invalid")
                    if not content:
                        pending.remove(stream)
                        stream.close()
                        continue
                    captured[stream].extend(content)
                    if len(captured[stream]) > limits[stream]:
                        raise BoundaryError("private Git output limit exceeded")
            remaining = execution_deadline - monotonic()
            if remaining <= 0 or child.wait(timeout=remaining) != 0:
                raise BoundaryError("private Git command did not complete successfully")
            if group_exists():
                raise BoundaryError("private Git process group remains")
            verify_inputs()
            if monotonic() > deadline:
                raise BoundaryError("private Git deadline exceeded")
            return bytes(captured[child.stdout])
        except BaseException as error:
            if child is not None:
                try:
                    try:
                        killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    child.wait(timeout=max(0, deadline - monotonic()))
                    while group_exists():
                        remaining = deadline - monotonic()
                        if remaining <= 0:
                            raise TimeoutError("private Git cleanup deadline exceeded")
                        select_ready([], [], [], min(0.01, remaining))
                except Exception:
                    raise BoundaryError("private Git child cleanup is inconclusive") from None
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            raise BoundaryError("private Git command failed or exceeded its bounds") from None
        finally:
            for stream in streams:
                if stream is not None:
                    stream.close()

    return run


def acquire_verified_private_bundle(
    source: PrivateGitSource,
    destination: Path,
    run_git: GitCommandRunner,
) -> VerifiedScannerBundle:
    """Return a bundle only after exact Git identity and bounded blob checks.

    ``run_git`` accepts a complete fixed-scope argv tuple and a maximum number
    of response bytes.  It must fail rather than truncate or exceed that bound.
    """
    if not source.checkout.is_absolute():
        raise BoundaryError("private Git checkout path is not absolute")
    _require_sha(PINNED_COMMIT, "pinned scanner commit")
    _require_sha(PINNED_TREE, "pinned scanner tree")
    prefix = ("git", "-C", str(source.checkout))

    _require_exact_line(
        _run_git(run_git, (*prefix, "remote", "get-url", "origin"), MAX_IDENTITY_BYTES),
        PRIVATE_ORIGIN,
        "private Git origin",
    )
    verified_commit = _require_exact_line(
        _run_git(
            run_git,
            (*prefix, "rev-parse", "--verify", "--quiet", f"{PINNED_COMMIT}^{{commit}}"),
            MAX_IDENTITY_BYTES,
        ),
        PINNED_COMMIT,
        "private Git commit",
    )
    verified_tree = _require_exact_line(
        _run_git(
            run_git,
            (*prefix, "rev-parse", "--verify", "--quiet", f"{PINNED_COMMIT}^{{tree}}"),
            MAX_IDENTITY_BYTES,
        ),
        PINNED_TREE,
        "private Git tree",
    )
    entries = _parse_tree(
        _run_git(run_git, (*prefix, "ls-tree", "-r", "-z", "-l", verified_tree), MAX_METADATA_BYTES)
    )
    blobs: dict[str, bytes] = {}
    blob_limits: dict[str, int] = {}
    for entry in entries:
        blob_limits[entry.object_id] = max(blob_limits.get(entry.object_id, 0), entry.size)

    def read_blob(object_id: str) -> bytes:
        try:
            maximum_bytes = blob_limits[object_id]
        except KeyError as exc:
            raise BoundaryError("private Git exporter requested an unlisted blob") from exc
        try:
            return blobs[object_id]
        except KeyError:
            content = _run_git(
                run_git,
                (*prefix, "cat-file", "blob", object_id),
                maximum_bytes,
            )
            blobs[object_id] = content
            return content

    return export_verified_bundle(
        verified_commit,
        verified_tree,
        entries,
        read_blob,
        destination,
        expected_commit=PINNED_COMMIT,
        expected_tree=PINNED_TREE,
        expected_manifest_digest=PINNED_MANIFEST_DIGEST,
        entrypoint="scripts/test-integrity",
        max_files=MAX_FILES,
        max_total_bytes=MAX_TOTAL_BYTES,
    )


def _run_git(run_git: GitCommandRunner, argv: tuple[str, ...], maximum_bytes: int) -> bytes:
    try:
        output = run_git(argv, maximum_bytes)
    except Exception as exc:
        raise BoundaryError("private Git read failed") from exc
    if type(output) is not bytes or len(output) > maximum_bytes:
        raise BoundaryError("private Git read violated its output bound")
    return output


def _require_exact_line(raw: bytes, expected: str, label: str) -> str:
    expected_bytes = expected.encode("ascii") + b"\n"
    if raw != expected_bytes:
        raise BoundaryError(f"{label} does not match its trusted pin")
    return expected


def _parse_tree(raw: bytes) -> list[GitLsTreeBlob]:
    if not raw or not raw.endswith(b"\0"):
        raise BoundaryError("private Git tree listing is truncated or empty")
    entries: list[GitLsTreeBlob] = []
    total_bytes = 0
    for record in raw[:-1].split(b"\0"):
        if len(entries) >= MAX_FILES:
            raise BoundaryError("private Git tree exceeds the file limit")
        try:
            metadata, encoded_path = record.split(b"\t", 1)
            mode, object_type, object_id, encoded_size = metadata.split()
            path = encoded_path.decode("utf-8", "strict")
            decoded_mode = mode.decode("ascii", "strict")
            decoded_type = object_type.decode("ascii", "strict")
            decoded_object_id = object_id.decode("ascii", "strict")
            decoded_size = encoded_size.decode("ascii", "strict")
        except (UnicodeDecodeError, ValueError) as exc:
            raise BoundaryError("private Git tree record is malformed") from exc
        if not path or not decoded_size.isdecimal():
            raise BoundaryError("private Git tree record is malformed")
        if decoded_type != "blob" or decoded_mode not in _REGULAR_GIT_MODES:
            raise BoundaryError("private Git tree contains a non-regular entry")
        _require_sha(decoded_object_id, "private Git blob")
        size = int(decoded_size)
        total_bytes += size
        if total_bytes > MAX_TOTAL_BYTES:
            raise BoundaryError("private Git tree exceeds the byte limit")
        entries.append(
            GitLsTreeBlob(
                path=path,
                mode=decoded_mode,
                object_type=decoded_type,
                object_id=decoded_object_id,
                size=size,
            )
        )
    return entries
