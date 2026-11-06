"""RED contract for the trusted private-scanner workflow CLI."""

from __future__ import annotations

from contextlib import contextmanager, redirect_stdout
import functools
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from github_binding import CHECK_NAME
from private_check import evaluate_run
from test_private_check import CompositePrivateClient, check_readback


RUN_ID = 41752012595
TRUSTED_REF = "refs/heads/main"


def driver_flags(**overrides):
    values = {name: getattr(sys.flags, name) for name in dir(sys.flags)
              if not name.startswith("_") and isinstance(getattr(sys.flags, name), int)}
    values.update(overrides)
    return SimpleNamespace(**values)


class RunWorkflowContractTests(unittest.TestCase):
    def workflow_module(self):
        try:
            module = importlib.import_module("run_workflow")
        except ModuleNotFoundError as error:
            if error.name == "run_workflow":
                self.fail("RED: public run_workflow.main is not implemented")
            raise
        main = getattr(module, "main", None)
        self.assertTrue(callable(main), "RED: run_workflow.main(argv) must be callable")
        return module, main

    @contextmanager
    def cli_fixture(self):
        temporary_parent = Path(os.environ["TMPDIR"])
        with tempfile.TemporaryDirectory(prefix="trusted-cli-", dir=temporary_parent) as temporary:
            root = Path(temporary)
            checkout = root / "private-checkout"
            checkout.mkdir(mode=0o700)
            binary_directory = root / "bin"
            binary_directory.mkdir(mode=0o700)
            binaries = {}
            for name in ("git", "python3.12", "bash"):
                path = binary_directory / name
                path.write_bytes(f"#!/bin/sh\n# {name} fixture\nexit 0\n".encode("utf-8"))
                path.chmod(0o700)
                binaries[name] = path
            yield {
                "root": root,
                "checkout": checkout,
                "git": binaries["git"],
                "python": binaries["python3.12"],
                "bash": binaries["bash"],
                "trusted_path": str(binary_directory),
                "git_sha256": hashlib.sha256(binaries["git"].read_bytes()).hexdigest(),
                "python_sha256": hashlib.sha256(binaries["python3.12"].read_bytes()).hexdigest(),
                "bash_sha256": hashlib.sha256(binaries["bash"].read_bytes()).hexdigest(),
            }

    def argv(self, fixture: dict[str, object], **overrides) -> list[str]:
        values = {
            "run_id": str(RUN_ID),
            "private_checkout": str(fixture["checkout"]),
            "git": str(fixture["git"]),
            "git_sha256": fixture["git_sha256"],
            "python": str(fixture["python"]),
            "python_sha256": fixture["python_sha256"],
            "bash": str(fixture["bash"]),
            "bash_sha256": fixture["bash_sha256"],
            "trusted_path": fixture["trusted_path"],
        }
        values.update(overrides)
        return [
            "--run-id", values["run_id"],
            "--private-checkout", values["private_checkout"],
            "--git", values["git"],
            "--git-sha256", values["git_sha256"],
            "--python", values["python"],
            "--python-sha256", values["python_sha256"],
            "--bash", values["bash"],
            "--bash-sha256", values["bash_sha256"],
            "--trusted-path", values["trusted_path"],
        ]

    @contextmanager
    def supported_driver(self, module):
        flags = driver_flags(isolated=1, no_site=1)
        with (
            mock.patch.object(module.sys, "version_info", (3, 12, 7, "final", 0)),
            mock.patch.object(module.sys, "flags", flags),
            mock.patch.object(module.sys, "dont_write_bytecode", True),
            mock.patch.object(module.scanner_runtime.platform, "system", return_value="Linux"),
            mock.patch.object(module.scanner_runtime.platform, "machine", return_value="x86_64"),
            mock.patch.object(
                module.scanner_runtime.platform,
                "python_implementation",
                return_value="CPython",
            ),
        ):
            yield

    @contextmanager
    def sanitized_environment(self, module, fixture: dict[str, object], token="fixture-token"):
        with mock.patch.dict(
            module.os.environ,
            {"GITHUB_TOKEN": token, "TMPDIR": str(fixture["root"])},
            clear=True,
        ):
            yield

    def invoke(self, main, argv: list[str]) -> tuple[int, list[dict[str, str]], str]:
        output = io.StringIO()
        with redirect_stdout(output):
            code = main(argv)
        lines = output.getvalue().splitlines()
        records = [json.loads(line) for line in lines]
        return code, records, output.getvalue()

    def test_composes_pinned_private_bundle_runtime_gate_and_sanitized_result(self) -> None:
        module, main = self.workflow_module()
        for conclusion, expected_exit in (("pass", 0), ("fail", 1), ("inconclusive", 2)):
            with self.subTest(conclusion=conclusion), self.cli_fixture() as fixture:
                scanner = object()
                observed = {"source": None, "runner": None, "destination": None, "evaluate": None}
                binding = object()
                client_instance = object()
                qualify = mock.Mock()

                def make_runner(source, *, git_binary, expected_git_sha256):
                    observed["source"] = source
                    observed["runner"] = (git_binary, expected_git_sha256)
                    return object()

                def acquire(source, destination, runner):
                    self.assertIs(source, observed["source"])
                    self.assertIsNotNone(runner)
                    self.assertFalse(destination.exists())
                    destination.mkdir(mode=0o700)
                    observed["destination"] = destination
                    return scanner

                def evaluate(client, run_id, workflow_ref, scanner_bundle, *, trusted_path, timeout_seconds, runtime_check):
                    self.assertIsNone(observed["destination"])
                    with scanner_bundle() as supplied_scanner:
                        self.assertIs(client, client_instance)
                        self.assertEqual(run_id, RUN_ID)
                        self.assertEqual(workflow_ref, TRUSTED_REF)
                        self.assertIs(supplied_scanner, scanner)
                        self.assertEqual(trusted_path, fixture["trusted_path"])
                        self.assertEqual(timeout_seconds, 300)
                        self.assertIsInstance(runtime_check, functools.partial)
                        self.assertIs(runtime_check.func, module.qualify_runtime)
                        self.assertEqual(
                            runtime_check.keywords,
                            {
                                "python": fixture["python"],
                                "bash": fixture["bash"],
                                "expected_python_sha256": fixture["python_sha256"],
                                "expected_bash_sha256": fixture["bash_sha256"],
                            },
                        )
                        runtime_check(supplied_scanner, binding, trusted_path=fixture["trusted_path"])
                        qualify.assert_called_once_with(
                            supplied_scanner,
                            binding,
                            trusted_path=fixture["trusted_path"],
                            python=fixture["python"],
                            bash=fixture["bash"],
                            expected_python_sha256=fixture["python_sha256"],
                            expected_bash_sha256=fixture["bash_sha256"],
                        )
                        observed["evaluate"] = runtime_check
                    self.assertFalse(observed["destination"].exists())
                    return SimpleNamespace(conclusion=conclusion)

                with (
                    self.supported_driver(module),
                    self.sanitized_environment(module, fixture),
                    mock.patch.object(module, "make_bounded_git_runner", side_effect=make_runner),
                    mock.patch.object(module, "acquire_verified_private_bundle", side_effect=acquire),
                    mock.patch.object(module, "GitHubClient", return_value=client_instance) as github_client,
                    mock.patch.object(module, "qualify_runtime", qualify),
                    mock.patch.object(module, "evaluate_private_run", side_effect=evaluate),
                ):
                    code, records, raw_output = self.invoke(main, self.argv(fixture))

                self.assertEqual(code, expected_exit)
                self.assertEqual(records, [{"check_name": CHECK_NAME, "conclusion": conclusion}])
                self.assertEqual(raw_output.count("\n"), 1)
                self.assertEqual(observed["source"].checkout, fixture["checkout"])
                self.assertEqual(observed["runner"], (fixture["git"], fixture["git_sha256"]))
                self.assertFalse(observed["destination"].exists())
                self.assertIsNotNone(observed["evaluate"])
                github_client.assert_called_once_with("fixture-token")

    def test_rejects_malformed_or_selectable_cli_arguments_before_any_action(self) -> None:
        module, main = self.workflow_module()
        bad_arguments = (
            ("invalid-run-id", lambda fixture: self.argv(fixture, run_id="0")),
            ("noninteger-run-id", lambda fixture: self.argv(fixture, run_id="not-an-integer")),
            (
                "selectable-repository",
                lambda fixture: self.argv(fixture) + ["--repository", "attacker/repository"],
            ),
            (
                "selectable-workflow",
                lambda fixture: self.argv(fixture) + ["--workflow-ref", "refs/heads/attacker"],
            ),
            ("token-on-argv", lambda fixture: self.argv(fixture) + ["--token", "argv-secret"]),
        )
        for name, make_argv in bad_arguments:
            with self.subTest(case=name), self.cli_fixture() as fixture:
                called = []

                def forbidden(*_args, **_kwargs):
                    called.append(True)
                    self.fail("malformed CLI arguments must fail before action")

                with (
                    self.supported_driver(module),
                    self.sanitized_environment(module, fixture),
                    mock.patch.object(module, "make_bounded_git_runner", side_effect=forbidden),
                    mock.patch.object(module, "acquire_verified_private_bundle", side_effect=forbidden),
                    mock.patch.object(module, "evaluate_private_run", side_effect=forbidden),
                ):
                    with self.assertRaises(SystemExit) as caught:
                        main(make_argv(fixture))
                self.assertEqual(caught.exception.code, 2)
                self.assertEqual(called, [])

    def test_rejects_each_unsupported_driver_state_before_private_bundle_acquisition(self) -> None:
        module, main = self.workflow_module()
        rejected_states = (
            ("platform", mock.patch.object(module.scanner_runtime.platform, "system", return_value="Darwin")),
            ("machine", mock.patch.object(module.scanner_runtime.platform, "machine", return_value="arm64")),
            (
                "implementation",
                mock.patch.object(module.scanner_runtime.platform, "python_implementation", return_value="PyPy"),
            ),
            ("version", mock.patch.object(module.sys, "version_info", (3, 11, 9, "final", 0))),
            ("not-isolated", mock.patch.object(module.sys, "flags", driver_flags(isolated=0, no_site=1))),
            ("site-enabled", mock.patch.object(module.sys, "flags", driver_flags(isolated=1, no_site=0))),
            ("bytecode-enabled", mock.patch.object(module.sys, "dont_write_bytecode", False)),
        )
        for label, rejected_state in rejected_states:
            with self.subTest(state=label), self.cli_fixture() as fixture:
                called = []

                def forbidden(*_args, **_kwargs):
                    called.append(True)
                    self.fail("unsupported workflow driver must fail before acquisition")

                with (
                    self.supported_driver(module),
                    self.sanitized_environment(module, fixture),
                    rejected_state,
                    mock.patch.object(module, "make_bounded_git_runner", side_effect=forbidden),
                    mock.patch.object(module, "acquire_verified_private_bundle", side_effect=forbidden),
                    mock.patch.object(module, "evaluate_private_run", side_effect=forbidden),
                ):
                    code, records, _raw_output = self.invoke(main, self.argv(fixture))

                self.assertEqual(code, 2)
                self.assertEqual(records, [{"check_name": CHECK_NAME, "conclusion": "inconclusive"}])
                self.assertEqual(called, [])

    def test_sanitizes_operational_exceptions_and_keyboard_interrupt(self) -> None:
        module, main = self.workflow_module()
        private_marker = "private checkout diagnostic must not escape"
        for error in (RuntimeError(private_marker), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__), self.cli_fixture() as fixture:
                reached = []
                def fail_acquire(*_args, **_kwargs):
                    reached.append(True)
                    raise error

                def evaluate(_client, _run_id, _workflow_ref, scanner_bundle, **_kwargs):
                    with scanner_bundle():
                        self.fail("acquisition must fail before yielding a scanner")

                with (
                    self.supported_driver(module),
                    self.sanitized_environment(module, fixture, token="fixture-secret-token"),
                    mock.patch.object(module, "make_bounded_git_runner", return_value=object()),
                    mock.patch.object(module, "acquire_verified_private_bundle", side_effect=fail_acquire),
                    mock.patch.object(module, "evaluate_private_run", side_effect=evaluate),
                ):
                    code, records, raw_output = self.invoke(main, self.argv(fixture))

                self.assertEqual(code, 2)
                self.assertEqual(records, [{"check_name": CHECK_NAME, "conclusion": "inconclusive"}])
                self.assertNotIn(private_marker, raw_output)
                self.assertNotIn("fixture-secret-token", raw_output)
                self.assertEqual(reached, [True])

    def test_termination_unwinds_bundle_and_restores_signal_handler(self) -> None:
        module, main = self.workflow_module()
        with self.cli_fixture() as fixture:
            previous_handler = object()
            handlers = []
            destinations = []
            continued = []

            def install(signum, handler):
                self.assertEqual(signum, signal.SIGTERM)
                handlers.append(handler)
                return previous_handler

            def acquire(_source, destination, _runner):
                destination.mkdir(mode=0o700)
                (destination / "private-fixture").write_bytes(b"private fixture")
                destinations.append(destination)
                return object()

            def evaluate(_client, _run_id, _workflow_ref, scanner_bundle, **_kwargs):
                with scanner_bundle():
                    self.assertTrue(handlers and callable(handlers[0]), "termination handler is missing")
                    handlers[0](signal.SIGTERM, None)
                    continued.append("scan continued after termination")
                continued.append("publication continued after termination")
                return SimpleNamespace(conclusion="pass")

            with (
                self.supported_driver(module),
                self.sanitized_environment(module, fixture),
                mock.patch.object(signal, "signal", side_effect=install),
                mock.patch.object(module, "make_bounded_git_runner", return_value=object()),
                mock.patch.object(module, "acquire_verified_private_bundle", side_effect=acquire),
                mock.patch.object(module, "evaluate_private_run", side_effect=evaluate),
            ):
                code, records, _raw_output = self.invoke(main, self.argv(fixture))

            self.assertEqual(code, 2)
            self.assertEqual(records, [{"check_name": CHECK_NAME, "conclusion": "inconclusive"}])
            self.assertEqual(continued, [])
            self.assertEqual(len(destinations), 1)
            self.assertFalse(destinations[0].parent.exists())
            self.assertFalse(fixture["checkout"].exists())
            self.assertEqual(len(handlers), 2)
            self.assertIs(handlers[-1], previous_handler)

    def test_restores_signal_handler_after_success(self) -> None:
        module, main = self.workflow_module()
        with self.cli_fixture() as fixture:
            previous_handler = object()
            with (
                self.supported_driver(module),
                self.sanitized_environment(module, fixture),
                mock.patch.object(signal, "signal", return_value=previous_handler) as install,
                mock.patch.object(module, "evaluate_private_run", return_value=SimpleNamespace(conclusion="pass")),
            ):
                code, records, _raw_output = self.invoke(main, self.argv(fixture))

            self.assertEqual(code, 0)
            self.assertEqual(records, [{"check_name": CHECK_NAME, "conclusion": "pass"}])
            self.assertEqual(install.call_count, 2)
            self.assertEqual(install.call_args_list[0].args[0], signal.SIGTERM)
            self.assertTrue(callable(install.call_args_list[0].args[1]))
            self.assertEqual(install.call_args_list[1].args, (signal.SIGTERM, previous_handler))

    def test_consumes_owned_checkout_before_recheck_and_publication(self) -> None:
        module, main = self.workflow_module()
        for cleanup_fails in (False, True):
            with self.subTest(cleanup_fails=cleanup_fails), self.cli_fixture() as fixture:
                expected = "action_required" if cleanup_fails else "success"
                client = CompositePrivateClient(readback=check_readback(conclusion=expected))
                rechecks = []

                def before_recheck():
                    rechecks.append(True)
                    self.assertEqual(fixture["checkout"].exists(), cleanup_fails)

                client.before_recheck = before_recheck

                def evaluate(client, run_id, workflow_ref, scanner_bundle, **_kwargs):
                    def scan(_binding):
                        with scanner_bundle():
                            return "pass"
                    return evaluate_run(client, run_id, workflow_ref, scan)

                with (
                    self.supported_driver(module),
                    self.sanitized_environment(module, fixture),
                    mock.patch.object(module, "GitHubClient", return_value=client),
                    mock.patch.object(module, "make_bounded_git_runner", return_value=object()),
                    mock.patch.object(module, "acquire_verified_private_bundle", return_value=object()),
                    mock.patch.object(module, "evaluate_private_run", side_effect=evaluate),
                ):
                    if cleanup_fails:
                        with mock.patch.object(module, "rmtree", create=True, side_effect=OSError("private cleanup detail")):
                            code, records, raw_output = self.invoke(main, self.argv(fixture))
                    else:
                        code, records, raw_output = self.invoke(main, self.argv(fixture))

                self.assertEqual(code, 2 if cleanup_fails else 0)
                self.assertEqual(records[0]["conclusion"], "inconclusive" if cleanup_fails else "pass")
                self.assertEqual(rechecks, [True])
                self.assertEqual([check["conclusion"] for check in client.created], [expected])
                self.assertNotIn("private cleanup detail", raw_output)

    def test_refuses_to_consume_any_checkout_except_fixed_owned_child(self) -> None:
        module, main = self.workflow_module()
        with self.cli_fixture() as fixture:
            other = fixture["root"] / "unrelated-checkout"
            other.mkdir()
            marker = other / "retain"
            marker.write_bytes(b"unrelated input")
            with (
                self.supported_driver(module),
                self.sanitized_environment(module, fixture),
                mock.patch.object(module, "evaluate_private_run", return_value=SimpleNamespace(conclusion="pass")) as evaluate,
            ):
                code, records, _raw_output = self.invoke(main, self.argv(fixture, private_checkout=str(other)))

            self.assertEqual(code, 2)
            self.assertEqual(records[0]["conclusion"], "inconclusive")
            evaluate.assert_not_called()
            self.assertEqual(marker.read_bytes(), b"unrelated input")


if __name__ == "__main__":
    unittest.main()
