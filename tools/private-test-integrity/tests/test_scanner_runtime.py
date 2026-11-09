"""RED contract for private scanner parser-runtime probe outputs."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import importlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from private_scanner_candidate import BoundaryError
from test_candidate_scan import binding
from test_private_check import scanner_files, verified_scanner


SCANNER_ROOT = Path("/trusted/private-scanner")
PYTHON = Path("/trusted/python3.12")
PARSER_NAMES = (
    "python",
    "javascript",
    "typescript",
    "tsx",
    "bash",
    "go",
    "rust",
)
PROBE_FILENAMES = (
    "python_test.py",
    "javascript.test.js",
    "typescript.test.ts",
    "tsx.test.tsx",
    "bash_test.sh",
)
VALID_PATHS = tuple(f"runtime-valid/{name}" for name in PROBE_FILENAMES)
INVALID_PATHS = tuple(f"runtime-invalid/{name}" for name in PROBE_FILENAMES)
PARSER_UNAVAILABLE = "test-file-tree-sitter-parser-unavailable"
PARSER_ERROR = "test-file-tree-sitter-parse-error"
SYNTAX_ERROR = "test-file-syntax-error"
MAX_CAPTURE_BYTES = 262_144


def valid_doctor(
    *,
    scanner_root: Path = SCANNER_ROOT,
    python: Path = PYTHON,
) -> dict[str, object]:
    return {
        "schema_version": "1",
        "subcommand": "parsers",
        "status": "ok",
        "exit_code": 0,
        "data": {
            "plugin_root": str(scanner_root),
            "engines": {
                "python_executable": str(python),
                "python_version": "3.12.7",
            },
            "parsers": {name: "ok" for name in PARSER_NAMES},
        },
    }


def parser_errors_for_invalid_probes() -> list[dict[str, str]]:
    return [
        {
            "rule_id": PARSER_ERROR,
            "file_path": path,
            "severity": "block",
        }
        for path in INVALID_PATHS
    ] + [{"rule_id": SYNTAX_ERROR, "file_path": INVALID_PATHS[0], "severity": "block"}]


class ScannerRuntimeOutputContractTests(unittest.TestCase):
    def validator(self):
        try:
            module = importlib.import_module("scanner_runtime")
        except ModuleNotFoundError as error:
            if error.name == "scanner_runtime":
                self.fail("RED: scanner_runtime.validate_probe_outputs is not implemented")
            raise
        validator = getattr(module, "validate_probe_outputs", None)
        self.assertTrue(
            callable(validator),
            "RED: scanner_runtime.validate_probe_outputs must be callable",
        )
        return validator

    def assert_rejected(
        self,
        doctor: object,
        valid_findings: object,
        invalid_findings: object,
    ) -> BoundaryError:
        with self.assertRaises(BoundaryError) as caught:
            self.validator()(doctor, valid_findings, invalid_findings, scanner_root=SCANNER_ROOT, python=PYTHON)
        return caught.exception

    def test_accepts_exact_probe_contract_and_non_parser_policy_findings(self) -> None:
        valid_findings = [
            {
                "rule_id": "test-policy-block",
                "file_path": VALID_PATHS[0],
                "severity": "block",
            },
            {
                "rule_id": "test-policy-advisory",
                "file_path": VALID_PATHS[1],
                "severity": "advisory",
                "message": "private scanner policy detail",
                "title": "private scanner policy title",
            },
        ]

        result = self.validator()(
            valid_doctor(),
            valid_findings,
            parser_errors_for_invalid_probes(),
            scanner_root=SCANNER_ROOT,
            python=PYTHON,
        )
        self.assertIsNone(result)

    def test_rejects_doctor_schema_identity_or_parser_drift(self) -> None:
        cases: dict[str, dict[str, object]] = {}

        wrong_schema = valid_doctor()
        wrong_schema["schema_version"] = 1
        cases["schema-version"] = wrong_schema

        wrong_exit = valid_doctor()
        wrong_exit["exit_code"] = True
        cases["boolean-exit-code"] = wrong_exit

        wrong_status = valid_doctor()
        wrong_status["status"] = "failed"
        cases["status"] = wrong_status

        wrong_subcommand = valid_doctor()
        wrong_subcommand["subcommand"] = "rules"
        cases["subcommand"] = wrong_subcommand

        wrong_root = valid_doctor()
        wrong_root["data"]["plugin_root"] = "/private/other-scanner"  # type: ignore[index]
        cases["plugin-root"] = wrong_root

        wrong_python = valid_doctor()
        wrong_python["data"]["engines"]["python_executable"] = "/private/other-python"  # type: ignore[index]
        cases["python-executable"] = wrong_python

        wrong_version = valid_doctor()
        wrong_version["data"]["engines"]["python_version"] = "3.13.0"  # type: ignore[index]
        cases["python-version"] = wrong_version

        non_patch_version = valid_doctor()
        non_patch_version["data"]["engines"]["python_version"] = "3.12.beta"  # type: ignore[index]
        cases["non-patch-python-version"] = non_patch_version

        missing_parser = valid_doctor()
        del missing_parser["data"]["parsers"]["go"]  # type: ignore[index]
        cases["missing-parser"] = missing_parser

        extra_parser = valid_doctor()
        extra_parser["data"]["parsers"]["c"] = "ok"  # type: ignore[index]
        cases["extra-parser"] = extra_parser

        unavailable_parser = valid_doctor()
        unavailable_parser["data"]["parsers"]["tsx"] = "unavailable"  # type: ignore[index]
        cases["non-ok-parser"] = unavailable_parser

        for label, doctor in cases.items():
            with self.subTest(label=label):
                self.assert_rejected(doctor, [], parser_errors_for_invalid_probes())

    def test_rejects_malformed_doctor_containers_without_private_diagnostics(self) -> None:
        for doctor in (None, [], {}, {"data": "private diagnostic"}):
            with self.subTest(doctor=doctor):
                error = self.assert_rejected(doctor, [], parser_errors_for_invalid_probes())
                self.assertNotIn("private diagnostic", str(error))

    def test_rejects_parser_findings_or_unknown_paths_in_valid_probe_results(self) -> None:
        for rule_id in (PARSER_UNAVAILABLE, PARSER_ERROR, SYNTAX_ERROR):
            with self.subTest(rule_id=rule_id):
                self.assert_rejected(
                    valid_doctor(),
                    [{"rule_id": rule_id, "file_path": VALID_PATHS[0], "severity": "block"}],
                    parser_errors_for_invalid_probes(),
                )

        self.assert_rejected(
            valid_doctor(),
            [{"rule_id": "test-policy-block", "file_path": "runtime-valid/unknown.test.ts", "severity": "block"}],
            parser_errors_for_invalid_probes(),
        )

    def test_rejects_malformed_finding_containers_rows_and_private_error_text(self) -> None:
        private_marker = "private scanner message must not escape"
        malformed_rows = (
            "not-a-list",
            [{"rule_id": 9, "file_path": VALID_PATHS[0], "severity": "block"}],
            [{"rule_id": "test-policy", "file_path": [VALID_PATHS[0]], "severity": "block"}],
            [{"rule_id": "test-policy", "file_path": VALID_PATHS[0], "severity": 7}],
            [{"rule_id": "", "file_path": VALID_PATHS[0], "severity": "block"}],
            [{"rule_id": "test-policy", "file_path": "", "severity": "block"}],
            [{"rule_id": "test-policy", "file_path": VALID_PATHS[0], "severity": ""}],
            [{"rule_id": 9, "file_path": VALID_PATHS[0], "severity": "block", "message": private_marker, "title": private_marker}],
        )
        for value in malformed_rows:
            with self.subTest(value=value):
                error = self.assert_rejected(valid_doctor(), value, parser_errors_for_invalid_probes())
                self.assertNotIn(private_marker, str(error))

        self.assert_rejected(valid_doctor(), [], {"not": "a-list"})

    def test_accepts_detected_parser_errors_with_the_pinned_advisory_policy(self) -> None:
        invalid = parser_errors_for_invalid_probes()
        for finding in invalid:
            if finding["rule_id"] == PARSER_ERROR:
                finding["severity"] = "advisory"
        self.assertIsNone(self.validator()(valid_doctor(), [], invalid, scanner_root=SCANNER_ROOT, python=PYTHON))

    def test_requires_the_python_syntax_error_to_remain_blocking(self) -> None:
        for severity in (None, "advisory"):
            with self.subTest(severity=severity):
                invalid = parser_errors_for_invalid_probes()[:-1]
                if severity is not None:
                    invalid.append({"rule_id": SYNTAX_ERROR, "file_path": INVALID_PATHS[0], "severity": severity})
                self.assert_rejected(valid_doctor(), [], invalid)

    def test_requires_complete_parser_errors_for_only_invalid_probes(self) -> None:
        complete = parser_errors_for_invalid_probes()
        self.assert_rejected(valid_doctor(), [], [])
        self.assert_rejected(valid_doctor(), [], complete[:-1])
        self.assert_rejected(valid_doctor(), [], complete[1:])

        unknown_severity = parser_errors_for_invalid_probes()
        unknown_severity[0]["severity"] = "unknown"
        self.assert_rejected(valid_doctor(), [], unknown_severity)

        wrong_rule = parser_errors_for_invalid_probes()
        wrong_rule[0]["rule_id"] = SYNTAX_ERROR
        self.assert_rejected(valid_doctor(), [], wrong_rule)

        unavailable = parser_errors_for_invalid_probes()
        unavailable.append(
            {
                "rule_id": PARSER_UNAVAILABLE,
                "file_path": INVALID_PATHS[0],
                "severity": "block",
            }
        )
        self.assert_rejected(valid_doctor(), [], unavailable)

        malformed = parser_errors_for_invalid_probes()
        malformed[0]["file_path"] = ""
        self.assert_rejected(valid_doctor(), [], malformed)

        unknown_path = parser_errors_for_invalid_probes()
        unknown_path.append(
            {
                "rule_id": PARSER_ERROR,
                "file_path": VALID_PATHS[0],
                "severity": "block",
            }
        )
        self.assert_rejected(valid_doctor(), [], unknown_path)

    def test_sanitizes_private_title_and_message_when_invalid_output_is_rejected(self) -> None:
        private_marker = "private parser diagnostic"
        invalid = parser_errors_for_invalid_probes()
        invalid[0]["message"] = private_marker
        invalid[0]["title"] = private_marker
        invalid[0]["rule_id"] = "test-policy"

        error = self.assert_rejected(valid_doctor(), [], invalid)
        self.assertNotIn(private_marker, str(error))


class ScannerRuntimeQualificationTests(unittest.TestCase):
    def test_capture_at_limit_cannot_hide_truncated_whitespace_after_valid_json(self) -> None:
        module, _qualifier = self.qualifier()
        with tempfile.TemporaryDirectory(prefix="capture-limit-") as temporary:
            capture = Path(temporary) / "capture.json"
            capture.write_bytes(b"{}".ljust(MAX_CAPTURE_BYTES - 1, b" "))
            self.assertEqual(module._read_capture(capture), {})
            capture.write_bytes(b"{}".ljust(MAX_CAPTURE_BYTES, b" "))
            with self.assertRaises(BoundaryError):
                module._read_capture(capture)

    def qualifier(self):
        try:
            module = importlib.import_module("scanner_runtime")
        except ModuleNotFoundError as error:
            if error.name == "scanner_runtime":
                self.fail("RED: scanner_runtime.qualify_runtime is not implemented")
            raise
        qualifier = getattr(module, "qualify_runtime", None)
        self.assertTrue(
            callable(qualifier),
            "RED: scanner_runtime.qualify_runtime must be callable",
        )
        self.assertTrue(
            callable(getattr(module, "run_scanner_privately", None)),
            "RED: scanner_runtime must expose the native scanner seam for qualification",
        )
        return module, qualifier

    @contextmanager
    def runtime_fixture(self):
        temporary_parent = Path(os.environ["TMPDIR"])
        with tempfile.TemporaryDirectory(prefix="scanner-runtime-", dir=temporary_parent) as temporary:
            root = Path(temporary)
            scanner, _manifest = verified_scanner(root / "scanner", scanner_files())
            binary_directory = root / "bin"
            binary_directory.mkdir(mode=0o700)
            python = binary_directory / "python3.12"
            bash = binary_directory / "bash"
            python.write_bytes(b"#!/bin/sh\nexit 0\n")
            bash.write_bytes(b"#!/bin/sh\nexit 0\n")
            python.chmod(0o700)
            bash.chmod(0o700)
            self.assertEqual(shutil.which("python3.12", path=str(binary_directory)), str(python))
            self.assertEqual(shutil.which("bash", path=str(binary_directory)), str(bash))
            yield {
                "root": root,
                "scanner": scanner,
                "python": python,
                "bash": bash,
                "python_sha256": hashlib.sha256(python.read_bytes()).hexdigest(),
                "bash_sha256": hashlib.sha256(bash.read_bytes()).hexdigest(),
                "trusted_path": str(binary_directory),
            }

    @contextmanager
    def observed_runtime_identity(
        self,
        module,
        python: Path,
        *,
        version=(3, 12, 7, "final", 0),
        system="Linux",
        machine="x86_64",
        implementation="CPython",
        isolated=1,
        no_site=1,
    ):
        flags = SimpleNamespace(isolated=isolated, no_site=no_site)
        with (
            mock.patch.object(module.sys, "version_info", version),
            mock.patch.object(module.sys, "executable", str(python)),
            mock.patch.object(module.sys, "flags", flags),
            mock.patch.object(module.sys, "dont_write_bytecode", True),
            mock.patch.object(module.platform, "system", return_value=system),
            mock.patch.object(module.platform, "machine", return_value=machine),
            mock.patch.object(module.platform, "python_implementation", return_value=implementation),
        ):
            yield

    @contextmanager
    def isolated_environment(self, module, fixture: dict[str, object]):
        marker = "poisoned-runtime-secret"
        root = fixture["root"]
        trusted_path = fixture["trusted_path"]
        with mock.patch.dict(
            module.os.environ,
            {
                "PATH": trusted_path,
                "TMPDIR": str(root),
                "HOME": marker,
                "PYTHONPATH": marker,
                "GITHUB_TOKEN": marker,
                "TEST_INTEGRITY_DEPLOY_KEY": marker,
            },
            clear=True,
        ):
            yield marker

    def invoke(self, qualifier, fixture: dict[str, object], **overrides):
        arguments = {
            "python": fixture["python"],
            "bash": fixture["bash"],
            "expected_python_sha256": fixture["python_sha256"],
            "expected_bash_sha256": fixture["bash_sha256"],
            "trusted_path": fixture["trusted_path"],
            "probe_timeout_seconds": 11,
        }
        arguments.update(overrides)
        return qualifier(fixture["scanner"], binding(), **arguments)

    def test_qualifies_bound_runtime_with_captured_parser_probes_and_cleans_up(self) -> None:
        module, qualifier = self.qualifier()
        with self.runtime_fixture() as fixture:
            scanner = fixture["scanner"]
            python = fixture["python"]
            trusted_path = fixture["trusted_path"]
            calls = []
            owned_paths = []

            def capture(plan, *, timeout_seconds):
                self.assertEqual(timeout_seconds, 11)
                self.assertEqual(plan.command[:4], (str(python), "-I", "-S", "-B"))
                capture_program = Path(plan.command[4])
                capture_path = Path(plan.command[5])
                self.assertTrue(capture_program.is_absolute())
                self.assertEqual(capture_program.name, "runtime_capture.py")
                self.assertTrue(capture_path.is_absolute())
                self.assertEqual(plan.command[6], str(scanner.bundle.entrypoint))
                self.assertEqual(plan.environment["PATH"], trusted_path)
                self.assertNotIn("PYTHONPATH", plan.environment)
                self.assertNotIn("poisoned-runtime-secret", plan.environment.values())

                home = Path(plan.environment["HOME"])
                self.assertTrue(home.is_dir())
                self.assertTrue((home / ".claude").is_dir())
                self.assertEqual(list((home / ".claude").iterdir()), [])
                for path in (*VALID_PATHS, *INVALID_PATHS):
                    fixture_path = plan.cwd / path
                    self.assertTrue(fixture_path.is_file(), fixture_path)
                    self.assertGreater(len(fixture_path.read_bytes()), 0, fixture_path)
                self.assertTrue((plan.cwd / ".claude").is_dir())
                self.assertEqual(list((plan.cwd / ".claude").iterdir()), [])

                tail = plan.command[7:]
                if tail == ("doctor", "parsers", "--json"):
                    report = valid_doctor(scanner_root=scanner.bundle.root, python=python)
                    conclusion = "pass"
                elif tail == ("scan", "--format", "json", "--ci", "--", *VALID_PATHS):
                    report = [
                        {
                            "rule_id": "test-policy-block",
                            "file_path": VALID_PATHS[0],
                            "severity": "block",
                        },
                    ]
                    conclusion = "fail"
                elif tail == ("scan", "--format", "json", "--ci", "--", *INVALID_PATHS):
                    report = parser_errors_for_invalid_probes()
                    conclusion = "fail"
                else:
                    self.fail(f"unexpected runtime probe command: {tail!r}")
                self.assertTrue(capture_path.parent.is_dir())
                capture_path.write_text(json.dumps(report), encoding="utf-8")
                calls.append(plan)
                owned_paths.extend((plan.cwd, home, capture_path))
                return plan.public_result(conclusion)

            with (
                self.observed_runtime_identity(module, python),
                self.isolated_environment(module, fixture),
                mock.patch.object(module, "run_scanner_privately", side_effect=capture),
            ):
                self.assertIsNone(self.invoke(qualifier, fixture))

            self.assertEqual(len(calls), 3)
            self.assertEqual(
                [plan.command[7:] for plan in calls],
                [
                    ("doctor", "parsers", "--json"),
                    ("scan", "--format", "json", "--ci", "--", *VALID_PATHS),
                    ("scan", "--format", "json", "--ci", "--", *INVALID_PATHS),
                ],
            )
            self.assertTrue(scanner.bundle.entrypoint.is_file())
            for path in owned_paths:
                self.assertFalse(path.exists(), path)

    def test_rejects_tampered_executables_or_bundle_before_a_probe_runs(self) -> None:
        module, qualifier = self.qualifier()
        for kind in ("python", "bash", "bundle"):
            with self.subTest(kind=kind), self.runtime_fixture() as fixture:
                if kind == "bundle":
                    fixture["scanner"].bundle.entrypoint.write_bytes(b"tampered\n")
                else:
                    fixture[kind].write_bytes(b"#!/bin/sh\necho tampered\n")
                calls = []

                def unexpected_probe(*_args, **_kwargs):
                    calls.append(True)
                    self.fail("tampered trusted input must fail before a probe runs")

                with (
                    self.observed_runtime_identity(module, fixture["python"]),
                    self.isolated_environment(module, fixture),
                    mock.patch.object(module, "run_scanner_privately", side_effect=unexpected_probe),
                ):
                    with self.assertRaises(BoundaryError):
                        self.invoke(qualifier, fixture)
                self.assertEqual(calls, [])

    def test_rejects_wrong_observed_runtime_or_timeout_before_a_probe_runs(self) -> None:
        module, qualifier = self.qualifier()
        cases = {
            "platform": {"system": "Darwin"},
            "python-version": {"version": (3, 13, 0, "final", 0)},
            "not-isolated": {"isolated": 0},
            "site-enabled": {"no_site": 0},
            "nonpositive-timeout": {"probe_timeout_seconds": 0},
        }
        for kind, override in cases.items():
            with self.subTest(kind=kind), self.runtime_fixture() as fixture:
                calls = []
                identity_override = {
                    key: value
                    for key, value in override.items()
                    if key in {"system", "version", "isolated", "no_site"}
                }
                qualifier_override = {
                    key: value
                    for key, value in override.items()
                    if key == "probe_timeout_seconds"
                }

                def unexpected_probe(*_args, **_kwargs):
                    calls.append(True)
                    self.fail("invalid runtime identity must fail before a probe runs")

                with (
                    self.observed_runtime_identity(module, fixture["python"], **identity_override),
                    self.isolated_environment(module, fixture),
                    mock.patch.object(module, "run_scanner_privately", side_effect=unexpected_probe),
                ):
                    with self.assertRaises(BoundaryError):
                        self.invoke(qualifier, fixture, **qualifier_override)
                self.assertEqual(calls, [])

    def test_rejects_inconclusive_or_unsafe_capture_before_qualification(self) -> None:
        module, qualifier = self.qualifier()
        for kind in ("inconclusive", "malformed", "duplicate-keys", "nonfinite", "overlimit"):
            with self.subTest(kind=kind), self.runtime_fixture() as fixture:
                python = fixture["python"]
                captured_paths = []

                def capture(plan, *, timeout_seconds):
                    self.assertEqual(timeout_seconds, 11)
                    output = Path(plan.command[5])
                    captured_paths.extend((plan.cwd, Path(plan.environment["HOME"]), output))
                    if kind == "malformed":
                        output.write_text("[]", encoding="utf-8")
                        return plan.public_result("pass")
                    if kind == "duplicate-keys":
                        output.write_text(
                            '{"schema_version":"1","schema_version":"1"}',
                            encoding="utf-8",
                        )
                        return plan.public_result("pass")
                    if kind == "nonfinite":
                        output.write_text('{"schema_version":NaN}', encoding="utf-8")
                        return plan.public_result("pass")
                    if kind == "overlimit":
                        output.write_bytes(b"x" * (MAX_CAPTURE_BYTES + 1))
                        return plan.public_result("pass")
                    return plan.public_result("inconclusive")

                with (
                    self.observed_runtime_identity(module, python),
                    self.isolated_environment(module, fixture),
                    mock.patch.object(module, "run_scanner_privately", side_effect=capture),
                ):
                    with self.assertRaises(BoundaryError):
                        self.invoke(qualifier, fixture)
                self.assertEqual(len(captured_paths), 3)
                for path in captured_paths:
                    self.assertFalse(path.exists(), path)

    def test_rejects_stale_capture_result_binding_before_later_probes(self) -> None:
        module, qualifier = self.qualifier()
        with self.runtime_fixture() as fixture:
            python = fixture["python"]
            calls = []

            def capture(plan, *, timeout_seconds):
                self.assertEqual(timeout_seconds, 11)
                output = Path(plan.command[5])
                output.write_text(
                    json.dumps(valid_doctor(scanner_root=fixture["scanner"].bundle.root, python=python)),
                    encoding="utf-8",
                )
                stale = plan.public_result("pass")
                stale["head_sha"] = "f" * 40
                calls.append(plan)
                return stale

            with (
                self.observed_runtime_identity(module, python),
                self.isolated_environment(module, fixture),
                mock.patch.object(module, "run_scanner_privately", side_effect=capture),
            ):
                with self.assertRaises(BoundaryError):
                    self.invoke(qualifier, fixture)
            self.assertEqual(len(calls), 1)
            self.assertFalse(calls[0].cwd.exists())

    def test_rejects_incomplete_invalid_probe_coverage_and_cleans_up(self) -> None:
        module, qualifier = self.qualifier()
        with self.runtime_fixture() as fixture:
            scanner = fixture["scanner"]
            python = fixture["python"]
            calls = []

            def capture(plan, *, timeout_seconds):
                self.assertEqual(timeout_seconds, 11)
                output = Path(plan.command[5])
                tail = plan.command[7:]
                if tail == ("doctor", "parsers", "--json"):
                    report = valid_doctor(scanner_root=scanner.bundle.root, python=python)
                    conclusion = "pass"
                elif tail == ("scan", "--format", "json", "--ci", "--", *VALID_PATHS):
                    report = []
                    conclusion = "pass"
                elif tail == ("scan", "--format", "json", "--ci", "--", *INVALID_PATHS):
                    report = parser_errors_for_invalid_probes()[:-1]
                    conclusion = "fail"
                else:
                    self.fail(f"unexpected runtime probe command: {tail!r}")
                output.write_text(json.dumps(report), encoding="utf-8")
                calls.append(plan)
                return plan.public_result(conclusion)

            with (
                self.observed_runtime_identity(module, python),
                self.isolated_environment(module, fixture),
                mock.patch.object(module, "run_scanner_privately", side_effect=capture),
            ):
                with self.assertRaises(BoundaryError):
                    self.invoke(qualifier, fixture)
            self.assertEqual(len(calls), 3)
            for plan in calls:
                self.assertFalse(plan.cwd.exists(), plan.cwd)

    def test_rejects_executable_mutation_after_all_parser_probes(self) -> None:
        module, qualifier = self.qualifier()
        with self.runtime_fixture() as fixture:
            scanner = fixture["scanner"]
            python = fixture["python"]
            calls = []

            def capture(plan, *, timeout_seconds):
                self.assertEqual(timeout_seconds, 11)
                output = Path(plan.command[5])
                tail = plan.command[7:]
                if tail == ("doctor", "parsers", "--json"):
                    report = valid_doctor(scanner_root=scanner.bundle.root, python=python)
                    conclusion = "pass"
                elif tail == ("scan", "--format", "json", "--ci", "--", *VALID_PATHS):
                    report = []
                    conclusion = "pass"
                elif tail == ("scan", "--format", "json", "--ci", "--", *INVALID_PATHS):
                    report = parser_errors_for_invalid_probes()
                    conclusion = "fail"
                    python.write_bytes(b"#!/bin/sh\necho changed-after-probes\n")
                else:
                    self.fail(f"unexpected runtime probe command: {tail!r}")
                output.write_text(json.dumps(report), encoding="utf-8")
                calls.append(plan)
                return plan.public_result(conclusion)

            with (
                self.observed_runtime_identity(module, python),
                self.isolated_environment(module, fixture),
                mock.patch.object(module, "run_scanner_privately", side_effect=capture),
            ):
                with self.assertRaises(BoundaryError):
                    self.invoke(qualifier, fixture)
            self.assertEqual(len(calls), 3)
            for plan in calls:
                self.assertFalse(plan.cwd.exists(), plan.cwd)


if __name__ == "__main__":
    unittest.main()
