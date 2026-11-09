"""Trusted workflow entrypoint; candidate source is never imported or executed.

Run from the trusted default-branch checkout with Python -I -S -B and an outer
watchdog. The caller supplies immutable runtime pins and an owned private checkout
at TMPDIR/private-checkout. An admitted scan consumes that checkout before publication.
"""

import argparse
from contextlib import contextmanager
from functools import partial
import json
import os
from pathlib import Path
import re
import signal
from shutil import rmtree
import sys
import tempfile


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from bounded_github import GitHubClient
from github_binding import CHECK_NAME
from private_check import evaluate_private_non_pr_run, evaluate_private_run
from private_git import PrivateGitSource, acquire_verified_private_bundle, make_bounded_git_runner
from private_scanner_candidate import BoundaryError
import scanner_runtime
from scanner_runtime import qualify_runtime


class _Parser(argparse.ArgumentParser):
    def error(self, _message: str) -> None:
        # Argument errors must not echo an accidentally supplied credential.
        self.exit(2, "Invalid private scanner arguments.\n")


def _run_id(value: str) -> int:
    if not value.isascii() or not value.isdecimal() or not 0 < int(value) < 2**63:
        raise argparse.ArgumentTypeError("invalid workflow run ID")
    return int(value)


def _digest(value: str) -> str:
    if re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise argparse.ArgumentTypeError("invalid executable digest")
    return value


def _workflow_run_identity(name: str) -> int:
    value = os.environ.get(name)
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal() or not 0 < int(value) < 2**63:
        raise BoundaryError("trusted workflow run identity is invalid")
    return int(value)


def _receipt_path(value: Path, parent: Path) -> Path:
    if (
        not isinstance(value, Path)
        or value.name != "receipt.json"
        or not value.is_absolute()
        or value.parent != parent
        or value.exists()
        or value.is_symlink()
    ):
        raise BoundaryError("private receipt path is invalid")
    return value


def _terminate(signum: int, _frame) -> None:
    # Let the existing bundle and process owners unwind before the watchdog kills.
    raise SystemExit(128 + signum)


def main(argv: list[str] | None = None) -> int:
    parser = _Parser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--run-id", required=True, type=_run_id)
    parser.add_argument("--private-checkout", required=True, type=Path)
    for name in ("git", "python", "bash"):
        parser.add_argument(f"--{name}", required=True, type=Path)
        parser.add_argument(f"--{name}-sha256", required=True, type=_digest)
    parser.add_argument("--trusted-path", required=True)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args(argv)
    conclusion = "inconclusive"
    previous_handler = signal.signal(signal.SIGTERM, _terminate)
    try:
        scanner_runtime.require_supported_driver()
        parent = Path(os.environ.get("TMPDIR", ""))
        if not parent.is_absolute() or parent.resolve(strict=True) != parent or not parent.is_dir():
            raise BoundaryError("private workflow temporary directory is invalid")
        if (
            args.private_checkout != parent / "private-checkout"
            or not args.private_checkout.is_absolute()
            or args.private_checkout.resolve(strict=True) != args.private_checkout
            or not args.private_checkout.is_dir()
        ):
            raise BoundaryError("private workflow checkout is invalid")
        client = GitHubClient(os.environ.get("GITHUB_TOKEN"))
        source = PrivateGitSource(args.private_checkout)
        runtime_check = partial(
            qualify_runtime, python=args.python, bash=args.bash,
            expected_python_sha256=args.python_sha256, expected_bash_sha256=args.bash_sha256,
        )

        @contextmanager
        def scanner_bundle():
            try:
                runner = make_bounded_git_runner(source, git_binary=args.git, expected_git_sha256=args.git_sha256)
                with tempfile.TemporaryDirectory(prefix="private-workflow-", dir=parent) as temporary:
                    yield acquire_verified_private_bundle(source, Path(temporary) / "scanner", runner)
            finally:
                rmtree(source.checkout)

        if args.receipt is None:
            result = evaluate_private_run(
                client, args.run_id, "refs/heads/main", scanner_bundle,
                trusted_path=args.trusted_path, timeout_seconds=300, runtime_check=runtime_check,
            )
        else:
            result = evaluate_private_non_pr_run(
                client,
                args.run_id,
                scanner_bundle,
                trusted_path=args.trusted_path,
                timeout_seconds=300,
                runtime_check=runtime_check,
                receipt_path=_receipt_path(args.receipt, parent),
                scanner_run_id=_workflow_run_identity("GITHUB_RUN_ID"),
                scanner_run_attempt=_workflow_run_identity("GITHUB_RUN_ATTEMPT"),
            )
        if type(result.conclusion) is not str or result.conclusion not in {"pass", "fail", "inconclusive"}:
            raise BoundaryError("private workflow result is invalid")
        conclusion = result.conclusion
    except (Exception, KeyboardInterrupt, SystemExit):
        conclusion = "inconclusive"
    finally:
        signal.signal(signal.SIGTERM, previous_handler)
    print(json.dumps({"check_name": CHECK_NAME, "conclusion": conclusion}, separators=(",", ":")))
    return {"pass": 0, "fail": 1, "inconclusive": 2}[conclusion]


if __name__ == "__main__":
    raise SystemExit(main())
