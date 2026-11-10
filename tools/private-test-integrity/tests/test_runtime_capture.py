"""RED contract for the private scanner runtime-capture exec boundary."""

from __future__ import annotations

import importlib
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


class ExecveCalled(BaseException):
    """Sentinel proving the helper reached its no-return exec boundary."""

    def __init__(self, path: object, argv: object, environment: object) -> None:
        self.path = path
        self.argv = argv
        self.environment = environment


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

    def _expect_exec(
        self,
        module: object,
        capture: object,
        output: Path,
        command: tuple[str, ...],
        environment: dict[str, str],
    ) -> ExecveCalled:
        with mock.patch.dict(module.os.environ, environment, clear=True):
            with mock.patch.object(module.resource, "setrlimit"):
                with mock.patch.object(module.os, "dup2"):
                    with mock.patch.object(
                        module.os,
                        "execve",
                        side_effect=lambda path, argv, env: (_ for _ in ()).throw(
                            ExecveCalled(path, argv, env)
                        ),
                    ):
                        with self.assertRaises(ExecveCalled) as raised:
                            capture(output, command)
        return raised.exception

    def test_doctor_exec_is_exact_and_sets_limits_output_and_fd_before_exec(self) -> None:
        module, capture = load_runtime_capture()
        with tempfile.TemporaryDirectory(prefix="runtime-capture-test-") as temporary:
            root = Path(temporary).resolve()
            entrypoint = make_entrypoint(root)
            output = root / "doctor.json"
            environment = self._environment(root)
            events: list[tuple[object, ...]] = []
            opened: list[int] = []
            real_open = os.open
            real_close = os.close

            def tracked_open(path: object, flags: int, mode: int = 0o777) -> int:
                events.append(("open", path, flags, mode))
                descriptor = real_open(path, flags, mode)
                opened.append(descriptor)
                return descriptor

            def tracked_close(descriptor: int) -> None:
                events.append(("close", descriptor))
                real_close(descriptor)

            def tracked_limit(resource_id: int, limits: tuple[int, int]) -> None:
                events.append(("limit", resource_id, limits))

            def tracked_dup2(old: int, new: int, inheritable: bool = True) -> int:
                events.append(("dup2", old, new, inheritable))
                return new

            def intercepted_exec(path: object, argv: object, env: object) -> None:
                events.append(("execve", path, argv, env))
                raise ExecveCalled(path, argv, env)

            with mock.patch.dict(module.os.environ, environment, clear=True):
                with mock.patch.object(module.resource, "setrlimit", side_effect=tracked_limit):
                    with mock.patch.object(module.os, "open", side_effect=tracked_open):
                        with mock.patch.object(module.os, "close", side_effect=tracked_close):
                            with mock.patch.object(module.os, "dup2", side_effect=tracked_dup2):
                                with mock.patch.object(module.os, "execve", side_effect=intercepted_exec):
                                    with self.assertRaises(ExecveCalled) as raised:
                                        capture(output, (str(entrypoint), "doctor", "parsers", "--json"))

            outcome = raised.exception
            self.assertEqual(outcome.path, str(entrypoint))
            self.assertEqual(tuple(outcome.argv), (str(entrypoint), "doctor", "parsers", "--json"))
            self.assertEqual(outcome.environment, environment)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(output.read_bytes(), b"")
            self.assertEqual(len(opened), 1)
            with self.assertRaises(OSError):
                os.fstat(opened[0])

            opened_index = next(index for index, event in enumerate(events) if event[0] == "open")
            duped_index = next(index for index, event in enumerate(events) if event[0] == "dup2")
            closed_index = next(index for index, event in enumerate(events) if event[0] == "close")
            executed_index = next(index for index, event in enumerate(events) if event[0] == "execve")
            self.assertLess(opened_index, duped_index)
            self.assertLess(duped_index, closed_index)
            self.assertLess(closed_index, executed_index)
            open_event = events[opened_index]
            self.assertEqual(open_event[3], 0o600)
            self.assertTrue(open_event[2] & module.os.O_CREAT)
            self.assertTrue(open_event[2] & module.os.O_EXCL)
            self.assertTrue(open_event[2] & module.os.O_WRONLY)
            self.assertTrue(open_event[2] & module.os.O_NOFOLLOW)
            self.assertEqual(events[duped_index][2:], (1, True))
            limits = [event[1:] for event in events if event[0] == "limit"]
            self.assertIn((module.resource.RLIMIT_FSIZE, (MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES)), limits)
            self.assertIn((module.resource.RLIMIT_CORE, (0, 0)), limits)
            self.assertLess(max(index for index, event in enumerate(events) if event[0] == "limit"), opened_index)

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
                    outcome = self._expect_exec(module, capture, root / f"probe-{index}.json", command, environment)
                    self.assertEqual(tuple(outcome.argv), command)

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
                            with mock.patch.object(module.os, "dup2"):
                                with mock.patch.object(module.os, "execve") as execve:
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
                            with mock.patch.object(module.os, "dup2"):
                                with mock.patch.object(module.os, "execve") as execve:
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
                                with mock.patch.object(module.os, "dup2"):
                                    with mock.patch.object(module.os, "execve") as execve:
                                        with self.assertRaises(Exception):
                                            capture(output, (str(entrypoint), "doctor", "parsers", "--json"))
                    self.assertEqual(opened, [])
                    execve.assert_not_called()

    def test_closes_capture_descriptor_when_duplication_fails(self) -> None:
        module, capture = load_runtime_capture()
        with tempfile.TemporaryDirectory(prefix="runtime-capture-test-") as temporary:
            root = Path(temporary).resolve()
            entrypoint = make_entrypoint(root)
            output = root / "dup2-error.json"
            environment = self._environment(root)
            real_open = os.open
            opened: list[int] = []

            def tracked_open(path: object, flags: int, mode: int = 0o777) -> int:
                descriptor = real_open(path, flags, mode)
                opened.append(descriptor)
                return descriptor

            with mock.patch.dict(module.os.environ, environment, clear=True):
                with mock.patch.object(module.resource, "setrlimit"):
                    with mock.patch.object(module.os, "open", side_effect=tracked_open):
                        with mock.patch.object(module.os, "dup2", side_effect=OSError("synthetic dup2 failure")):
                            with mock.patch.object(module.os, "execve") as execve:
                                with self.assertRaises(Exception):
                                    capture(output, (str(entrypoint), "doctor", "parsers", "--json"))
            execve.assert_not_called()
            self.assertEqual(len(opened), 1)
            with self.assertRaises(OSError):
                os.fstat(opened[0])
            self.assertTrue(output.exists())
            self.assertEqual(output.stat().st_mode & stat.S_IRWXU, 0o600)


if __name__ == "__main__":
    unittest.main()
