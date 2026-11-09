"""Capture bounds and command admission; real execution has native canaries."""

from __future__ import annotations

import importlib
import io
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock


MAX_OUTPUT_BYTES = 262_144
PROBE_FILENAMES = (
    "python_test.py",
    "javascript.test.js",
    "typescript.test.ts",
    "tsx.test.tsx",
    "bash_test.sh",
)
PROBE_PATHS = tuple(
    f"{directory}/{filename}"
    for directory in ("runtime-valid", "runtime-invalid")
    for filename in PROBE_FILENAMES
)


def load_runtime_capture():
    try:
        module = importlib.import_module("runtime_capture")
    except ModuleNotFoundError as error:
        if error.name == "runtime_capture":
            raise AssertionError("runtime_capture module is not implemented") from None
        raise
    capture = getattr(module, "capture", None)
    if not callable(capture):
        raise AssertionError("runtime_capture.capture is not implemented")
    if getattr(module, "MAX_OUTPUT_BYTES", None) != MAX_OUTPUT_BYTES:
        raise AssertionError("runtime_capture MAX_OUTPUT_BYTES differs from the capture contract")
    return module, capture


def make_entrypoint(root: Path, *, executable: bool = True) -> Path:
    entrypoint = root / "bundle" / "scripts" / "test-integrity"
    entrypoint.parent.mkdir(parents=True)
    entrypoint.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    entrypoint.chmod(0o700 if executable else 0o600)
    return entrypoint


class RuntimeCaptureTests(unittest.TestCase):
    def _environment(self, root: Path) -> dict[str, str]:
        home = root / "home"
        home.mkdir()
        return {
            "PATH": "/trusted/bin:/usr/bin",
            "HOME": str(home),
            "TMPDIR": str(root),
            "LANG": "C",
        }

    def _expect_exec(self, module, capture, output, command, environment):
        child = mock.Mock()
        child.stdout = io.BytesIO(b'{"status":"ok"}\n')
        child.wait.return_value = 0
        child.poll.return_value = 0
        with mock.patch.dict(module.os.environ, environment, clear=True):
            with mock.patch.object(module.resource, "setrlimit"):
                with mock.patch.object(module.subprocess, "Popen", return_value=child) as launch:
                    result = capture(output, command)
        self.assertEqual(output.read_bytes(), b'{"status":"ok"}\n')
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertTrue(child.stdout.closed)
        self.assertEqual(launch.call_args.args, (command,))
        self.assertEqual(launch.call_args.kwargs["env"], environment)
        self.assertEqual(launch.call_args.kwargs["stdin"], module.subprocess.DEVNULL)
        self.assertEqual(launch.call_args.kwargs["stdout"], module.subprocess.PIPE)
        self.assertEqual(launch.call_args.kwargs["stderr"], module.subprocess.DEVNULL)
        self.assertNotIn("start_new_session", launch.call_args.kwargs)
        return result

    def test_doctor_preserves_arguments_environment_and_private_output(self):
        module, capture = load_runtime_capture()
        with tempfile.TemporaryDirectory(prefix="runtime-capture-test-") as temporary:
            root = Path(temporary).resolve()
            entrypoint = make_entrypoint(root)
            self.assertEqual(self._expect_exec(module, capture, root / "doctor.json",
                             (str(entrypoint), "doctor", "parsers", "--json"), self._environment(root)), 0)

    def test_output_bound_refuses_exact_limit_and_overflow_and_reaps_child(self):
        module, capture = load_runtime_capture()
        with tempfile.TemporaryDirectory(prefix="runtime-capture-test-") as temporary:
            root = Path(temporary).resolve()
            entrypoint = make_entrypoint(root)
            for count in (MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES + 1):
                with self.subTest(count=count):
                    child = mock.Mock()
                    child.stdout = io.BytesIO(b"x" * count)
                    child.poll.return_value = None
                    output = root / f"overflow-{count}.json"
                    with mock.patch.object(module.resource, "setrlimit"):
                        with mock.patch.object(module.subprocess, "Popen", return_value=child):
                            with self.assertRaisesRegex(ValueError, "output exceeds"):
                                capture(output, (str(entrypoint), "doctor", "parsers", "--json"))
                    self.assertEqual(output.read_bytes(), b"x" * MAX_OUTPUT_BYTES)
                    self.assertTrue(child.stdout.closed)
                    child.kill.assert_called_once()
                    child.wait.assert_called_once_with(timeout=5)

    def test_preserves_policy_exit_and_rejects_operational_or_signal_exit(self):
        module, capture = load_runtime_capture()
        with tempfile.TemporaryDirectory(prefix="runtime-capture-test-") as temporary:
            root = Path(temporary).resolve()
            entrypoint = make_entrypoint(root)
            for returned, expected in ((0, 0), (1, 1), (2, 2), (-9, 2), (127, 2)):
                with self.subTest(returned=returned):
                    child = mock.Mock()
                    child.stdout = io.BytesIO(b"[]")
                    child.wait.return_value = returned
                    child.poll.return_value = returned
                    with mock.patch.object(module.resource, "setrlimit"):
                        with mock.patch.object(module.subprocess, "Popen", return_value=child):
                            result = capture(root / f"exit-{returned}.json", (str(entrypoint), "doctor", "parsers", "--json"))
                    self.assertEqual(result, expected)
                    child.kill.assert_not_called()

    def test_all_fixed_probe_paths_are_accepted_by_the_exact_scan_shape(self) -> None:
        module, capture = load_runtime_capture()
        with tempfile.TemporaryDirectory(prefix="runtime-capture-test-") as temporary:
            root = Path(temporary).resolve()
            entrypoint = make_entrypoint(root)
            environment = self._environment(root)
            for index, probe_path in enumerate(PROBE_PATHS):
                with self.subTest(probe_path=probe_path):
                    command = (
                        str(entrypoint),
                        "scan",
                        "--format",
                        "json",
                        "--ci",
                        "--",
                        probe_path,
                    )
                    self.assertEqual(self._expect_exec(
                        module, capture, root / f"probe-{index}.json", command, environment), 0)

    def test_refuses_malformed_or_unsafe_commands_before_exec(self) -> None:
        module, capture = load_runtime_capture()
        with tempfile.TemporaryDirectory(prefix="runtime-capture-test-") as temporary:
            root = Path(temporary).resolve()
            entrypoint = make_entrypoint(root)
            environment = self._environment(root)
            noncanonical_entrypoint = str(entrypoint.parent / ".." / "scripts" / "test-integrity")
            linked_entrypoint = root / "linked" / "scripts" / "test-integrity"
            linked_entrypoint.parent.mkdir(parents=True)
            linked_entrypoint.symlink_to(entrypoint)
            other_entrypoint = make_entrypoint(root / "other", executable=False)
            valid_probe = PROBE_PATHS[0]
            cases: tuple[object, ...] = (
                (),
                [str(entrypoint), "doctor", "parsers", "--json"],
                (noncanonical_entrypoint, "doctor", "parsers", "--json"),
                (str(linked_entrypoint), "doctor", "parsers", "--json"),
                (str(other_entrypoint), "doctor", "parsers", "--json"),
                (str(entrypoint), "doctor", "parsers"),
                (str(entrypoint), "doctor", "parsers", "--json", "extra"),
                (str(entrypoint), "scan", "--format", "json", "--ci", "--"),
                (str(entrypoint), "scan", "--format", "json", "--ci", "--", valid_probe, valid_probe),
                (str(entrypoint), "scan", "--format", "json", "--ci", "--", "runtime-valid/unknown.test.ts"),
                (str(entrypoint), "scan", "--format", "json", "--ci", "--", "runtime-valid/../python_test.py"),
                (str(entrypoint), "scan", "--format", "json", "--ci", "--", "runtime-valid/python_test.py\x00suffix"),
            )
            for index, command in enumerate(cases):
                with self.subTest(command=repr(command)):
                    output = root / f"invalid-{index}.json"
                    with mock.patch.dict(module.os.environ, environment, clear=True):
                        with mock.patch.object(module.resource, "setrlimit"):
                            with mock.patch.object(module.subprocess, "Popen") as execve:
                                with self.assertRaises(Exception):
                                    capture(output, command)
                    execve.assert_not_called()
                    self.assertFalse(output.exists())

    def test_refuses_nonnew_symlinked_or_noncanonical_output_without_overwrite(self) -> None:
        module, capture = load_runtime_capture()
        with tempfile.TemporaryDirectory(prefix="runtime-capture-test-") as temporary:
            root = Path(temporary).resolve()
            entrypoint = make_entrypoint(root)
            environment = self._environment(root)
            existing = root / "existing.json"
            existing.write_bytes(b"preserve-existing")
            target = root / "target.json"
            target.write_bytes(b"preserve-target")
            linked_output = root / "linked.json"
            linked_output.symlink_to(target)
            missing_parent = root / "missing-parent" / "output.json"
            nested = root / "nested"
            nested.mkdir()
            noncanonical_parent = nested / ".." / "noncanonical.json"
            parent_target = root / "parent-target"
            parent_target.mkdir()
            linked_parent = root / "linked-parent"
            linked_parent.symlink_to(parent_target, target_is_directory=True)
            cases = (existing, linked_output, missing_parent, noncanonical_parent, linked_parent / "output.json")
            for output in cases:
                with self.subTest(output=str(output)):
                    with mock.patch.dict(module.os.environ, environment, clear=True):
                        with mock.patch.object(module.resource, "setrlimit"):
                            with mock.patch.object(module.subprocess, "Popen") as execve:
                                with self.assertRaises(Exception):
                                    capture(output, (str(entrypoint), "doctor", "parsers", "--json"))
                    execve.assert_not_called()
            self.assertEqual(existing.read_bytes(), b"preserve-existing")
            self.assertEqual(target.read_bytes(), b"preserve-target")
            self.assertFalse(missing_parent.exists())
            self.assertFalse((parent_target / "output.json").exists())

    def test_refuses_relative_or_nonpath_output_before_opening_or_exec(self) -> None:
        module, capture = load_runtime_capture()
        with tempfile.TemporaryDirectory(prefix="runtime-capture-test-") as temporary:
            root = Path(temporary).resolve()
            entrypoint = make_entrypoint(root)
            environment = self._environment(root)
            cases = (Path("runtime-capture-relative.json"), str(root / "not-a-path.json"))
            for output in cases:
                with self.subTest(output=repr(output)):
                    opened: list[tuple[object, ...]] = []

                    def forbidden_open(*args: object, **kwargs: object) -> int:
                        opened.append((*args, kwargs))
                        raise OSError("output must be rejected before open")

                    with mock.patch.dict(module.os.environ, environment, clear=True):
                        with mock.patch.object(module.resource, "setrlimit"):
                            with mock.patch.object(module.os, "open", side_effect=forbidden_open):
                                with mock.patch.object(module.subprocess, "Popen") as execve:
                                    with self.assertRaises(Exception):
                                        capture(output, (str(entrypoint), "doctor", "parsers", "--json"))
                    self.assertEqual(opened, [])
                    execve.assert_not_called()

    def test_closes_capture_descriptor_when_child_launch_fails(self):
        module, capture = load_runtime_capture()
        with tempfile.TemporaryDirectory(prefix="runtime-capture-test-") as temporary:
            root = Path(temporary).resolve()
            entrypoint = make_entrypoint(root)
            output = root / "launch-error.json"
            real_open = os.open
            opened = []

            def tracked_open(*args):
                descriptor = real_open(*args)
                opened.append(descriptor)
                return descriptor

            with mock.patch.object(module.resource, "setrlimit"):
                with mock.patch.object(module.os, "open", side_effect=tracked_open):
                    with mock.patch.object(module.subprocess, "Popen", side_effect=OSError("launch failed")):
                        with self.assertRaisesRegex(OSError, "launch failed"):
                            capture(output, (str(entrypoint), "doctor", "parsers", "--json"))
            self.assertEqual(len(opened), 1)
            with self.assertRaises(OSError):
                os.fstat(opened[0])
            self.assertEqual(output.read_bytes(), b"")
            self.assertEqual(output.stat().st_mode & stat.S_IRWXU, 0o600)


if __name__ == "__main__":
    unittest.main()
