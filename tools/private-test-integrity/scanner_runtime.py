"""Private validation of the unchanged scanner's interpreter and parser probes."""

import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import sys
import tempfile

from bounded_github import _reject_constant, _unique_object
from github_binding import VerifiedScannerBinding
from private_scanner_candidate import (
    BoundaryError, RunnerPlan, VerifiedScannerBundle,
    build_scanner_environment, run_scanner_privately, verify_scanner_bundle,
)
from runtime_capture import MAX_OUTPUT_BYTES, PROBE_FILENAMES


PARSER_NAMES = frozenset({"python", "javascript", "typescript", "tsx", "bash", "go", "rust"})
PARSER_UNAVAILABLE = "test-file-tree-sitter-parser-unavailable"
PARSER_ERROR = "test-file-tree-sitter-parse-error"
PARSER_FAILURES = frozenset({PARSER_UNAVAILABLE, PARSER_ERROR, "test-file-syntax-error"})


def _fields(value: object, names: set[str]) -> bool:
    return type(value) is dict and set(value) == names


def _findings(value: object, paths: set[str]) -> list[dict]:
    if type(value) is not list:
        raise BoundaryError("private runtime findings are malformed")
    for row in value:
        if (
            type(row) is not dict
            or any(type(row.get(key)) is not str or not row[key] for key in ("rule_id", "file_path", "severity"))
            or row["file_path"] not in paths
        ):
            raise BoundaryError("private runtime findings are malformed")
    return value


def _validate_doctor(doctor: object, scanner_root: Path, python: Path) -> None:
    if (
        not _fields(doctor, {"schema_version", "subcommand", "status", "exit_code", "data"})
        or doctor["schema_version"] != "1"
        or doctor["subcommand"] != "parsers"
        or doctor["status"] != "ok"
        or type(doctor["exit_code"]) is not int
        or doctor["exit_code"] != 0
    ):
        raise BoundaryError("private runtime doctor is invalid")
    data = doctor["data"]
    if not _fields(data, {"plugin_root", "engines", "parsers"}):
        raise BoundaryError("private runtime doctor is invalid")
    engines = data["engines"]
    if (
        data["plugin_root"] != str(scanner_root)
        or not _fields(engines, {"python_executable", "python_version"})
        or engines["python_executable"] != str(python)
        or type(engines["python_version"]) is not str
        or re.fullmatch(r"3\.12\.[0-9]+", engines["python_version"]) is None
        or not _fields(data["parsers"], PARSER_NAMES)
        or any(status != "ok" for status in data["parsers"].values())
    ):
        raise BoundaryError("private runtime identity or parser capability differs")


def validate_probe_outputs(
    doctor: object,
    valid_findings: object,
    invalid_findings: object,
    *,
    scanner_root: Path,
    python: Path,
) -> None:
    """Validate bounded parsed JSON; expected paths are verified by the caller."""
    _validate_doctor(doctor, scanner_root, python)
    valid_paths = {f"runtime-valid/{name}" for name in PROBE_FILENAMES}
    invalid_paths = {f"runtime-invalid/{name}" for name in PROBE_FILENAMES}
    valid = _findings(valid_findings, valid_paths)
    invalid = _findings(invalid_findings, invalid_paths)
    if any(row["rule_id"] in PARSER_FAILURES for row in valid):
        raise BoundaryError("private runtime rejected a valid parser probe")
    if any(row["rule_id"] == PARSER_UNAVAILABLE for row in invalid):
        raise BoundaryError("private runtime parser is unavailable")
    observed = {
        row["file_path"] for row in invalid
        if row["rule_id"] == PARSER_ERROR and row["severity"] in {"block", "advisory"}
    }
    if observed != invalid_paths:
        raise BoundaryError("private runtime negative parser coverage is incomplete")


def _verify_executable(path: Path, expected: str, name: str, trusted_path: str) -> None:
    if (
        not isinstance(path, Path) or not path.is_absolute()
        or path.parent.resolve(strict=True) != path.parent
        or not path.is_file() or not os.access(path, os.X_OK)
        or type(expected) is not str or re.fullmatch(r"[0-9a-f]{64}", expected) is None
        or shutil.which(name, path=trusted_path) != str(path)
    ):
        raise BoundaryError("private runtime executable identity differs")
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != expected:
        raise BoundaryError("private runtime executable bytes differ")


def _read_capture(path: Path) -> object:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or not 0 < metadata.st_size < MAX_OUTPUT_BYTES:
            raise BoundaryError("private runtime capture size or type is invalid")
        content = source.read(MAX_OUTPUT_BYTES + 1)
    if len(content) >= MAX_OUTPUT_BYTES:
        raise BoundaryError("private runtime capture exceeds its limit")
    return json.loads(content.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_reject_constant)


def require_supported_driver() -> None:
    if (
        platform.system() != "Linux" or platform.machine() not in {"x86_64", "AMD64"}
        or platform.python_implementation() != "CPython" or sys.version_info[:2] != (3, 12)
        or not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode
    ):
        raise BoundaryError("private runtime platform or isolation differs")


def qualify_runtime(
    scanner: VerifiedScannerBundle,
    binding: VerifiedScannerBinding,
    *,
    python: Path,
    bash: Path,
    expected_python_sha256: str,
    expected_bash_sha256: str,
    trusted_path: str,
    probe_timeout_seconds: float = 30,
) -> None:
    """Qualify fixed parser probes under the same environment as the final scan.

    The caller owns immutable trusted files and an outer total deadline. The
    existing supervisor discards stderr and owns each probe's process group.
    """
    try:
        require_supported_driver()
        if (
            type(probe_timeout_seconds) not in (int, float)
            or not math.isfinite(probe_timeout_seconds) or not 0 < probe_timeout_seconds <= 60
        ):
            raise BoundaryError("private runtime timeout is invalid")
        parent = Path(os.environ.get("TMPDIR", ""))
        if not parent.is_absolute() or parent.resolve(strict=True) != parent or not parent.is_dir():
            raise BoundaryError("private runtime temporary directory is invalid")

        def verify_inputs() -> None:
            verify_scanner_bundle(scanner.bundle, scanner.manifest)
            _verify_executable(python, expected_python_sha256, "python3.12", trusted_path)
            _verify_executable(bash, expected_bash_sha256, "bash", trusted_path)
            if Path(sys.executable).resolve(strict=True) != python.resolve(strict=True):
                raise BoundaryError("private runtime driver interpreter differs")

        verify_inputs()
        with tempfile.TemporaryDirectory(prefix="private-runtime-", dir=parent) as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            (home / ".claude").mkdir(mode=0o700)
            (root / ".claude").mkdir(mode=0o700)
            valid = (
                b"def test_probe():\n    assert sum([1, 2]) == 3\n",
                b"const actual = 1;\n", b"const actual: number = 1;\n",
                b"const element = <div />;\n", b"#!/bin/bash\nprintf 'fixture\\n'\n",
            )
            invalid = (
                b"def test_probe(:\n", b"const = ;\n", b"const actual: = 1;\n",
                b"const element = <div>\n", b"if then\n",
            )
            for directory, contents in (("runtime-valid", valid), ("runtime-invalid", invalid)):
                (root / directory).mkdir(mode=0o700)
                for name, content in zip(PROBE_FILENAMES, contents, strict=True):
                    (root / directory / name).write_bytes(content)
            environment = build_scanner_environment(scanner, home, trusted_path)

            def probe(name: str, tail: tuple[str, ...], conclusions: set[str]) -> object:
                output = root / f"{name}.json"
                plan = RunnerPlan(
                    command=(str(python), "-I", "-S", "-B", str(Path(__file__).resolve().with_name("runtime_capture.py")),
                             str(output), str(scanner.bundle.entrypoint), *tail),
                    environment=environment, cwd=root,
                    check_name=binding.check_name, head_sha=binding.head_sha,
                )
                result = run_scanner_privately(plan, timeout_seconds=probe_timeout_seconds)
                if (
                    type(result) is not dict or set(result) != {"check_name", "head_sha", "conclusion"}
                    or result["check_name"] != binding.check_name or result["head_sha"] != binding.head_sha
                    or type(result["conclusion"]) is not str or result["conclusion"] not in conclusions
                ):
                    raise BoundaryError("private runtime probe is inconclusive")
                return _read_capture(output)

            doctor = probe("doctor", ("doctor", "parsers", "--json"), {"pass"})
            _validate_doctor(doctor, scanner.bundle.root, python)
            valid_findings = probe("valid", ("scan", "--format", "json", "--ci", "--",
                                            *(f"runtime-valid/{name}" for name in PROBE_FILENAMES)), {"pass", "fail"})
            invalid_findings = probe("invalid", ("scan", "--format", "json", "--ci", "--",
                                                *(f"runtime-invalid/{name}" for name in PROBE_FILENAMES)), {"fail"})
            validate_probe_outputs(doctor, valid_findings, invalid_findings, scanner_root=scanner.bundle.root, python=python)
            verify_inputs()
    except (Exception, SystemExit):
        raise BoundaryError("private runtime qualification failed") from None
