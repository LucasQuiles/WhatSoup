"""RED contract for bounded private scanner acquisition from an existing checkout."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import ANY, patch


import private_git  # noqa: E402
from private_scanner_candidate import BoundaryError  # noqa: E402
from private_bundle import GitLsTreeBlob  # noqa: E402
from private_git import (  # noqa: E402
    MAX_FILES,
    MAX_IDENTITY_BYTES,
    MAX_METADATA_BYTES,
    MAX_TOTAL_BYTES,
    PINNED_COMMIT,
    PINNED_MANIFEST_DIGEST,
    PINNED_TREE,
    PRIVATE_ORIGIN,
    PrivateGitSource,
    acquire_verified_private_bundle,
)


CHECKOUT = Path("/private/test-integrity")
DESTINATION = Path("/private/scanner-bundle")
ENTRYPOINT = "scripts/test-integrity"
FILES = {
    b"scripts/test-integrity": b"#!/usr/bin/env python3\nraise SystemExit(0)\n",
    b"rules/space name\nnext.json": b'{"rules": []}\n',
}


def git_blob_oid(content: bytes) -> str:
    return hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()


def tree_record(
    path: bytes,
    content: bytes,
    *,
    mode: bytes = b"100644",
    object_type: bytes = b"blob",
    object_id: str | None = None,
    size: int | None = None,
) -> bytes:
    actual_size = len(content) if size is None else size
    actual_object_id = git_blob_oid(content) if object_id is None else object_id
    return b" ".join((mode, object_type, actual_object_id.encode(), str(actual_size).encode())) + b"\t" + path + b"\0"


def tree_output(files: dict[bytes, bytes]) -> bytes:
    return b"".join(tree_record(path, content) for path, content in files.items())


def command(*args: str) -> tuple[str, ...]:
    return ("git", "-C", str(CHECKOUT), *args)


class FakeGit:
    def __init__(self, responses: dict[tuple[str, ...], bytes]) -> None:
        self.responses = dict(responses)
        self.calls: list[tuple[tuple[str, ...], int]] = []

    def __call__(self, argv: tuple[str, ...], maximum_bytes: int) -> bytes:
        self.calls.append((argv, maximum_bytes))
        if argv not in self.responses:
            raise AssertionError(f"unexpected Git argv: {argv!r}")
        return self.responses[argv]


class FakeStream:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.offset = 0
        self.read_sizes: list[int] = []
        self.closed = False

    @property
    def exhausted(self) -> bool:
        return self.offset == len(self.data)

    def read(self, size: int) -> bytes:
        self.read_sizes.append(size)
        if size < 0:
            raise AssertionError("bounded runner requested an unbounded stream read")
        result = self.data[self.offset:self.offset + size]
        self.offset += len(result)
        return result

    def close(self) -> None:
        self.closed = True


class FakeChild:
    def __init__(self, *, stdout: bytes = b"", stderr: bytes = b"", returncode: int = 0) -> None:
        self.pid = 4172
        self.returncode = returncode
        self.stdout = FakeStream(stdout)
        self.stderr = FakeStream(stderr)
        self.waited = False
        self.wait_timeouts = []

    def poll(self) -> int | None:
        if self.stdout.exhausted and self.stderr.exhausted:
            return self.returncode
        return None

    def wait(self, timeout: float | None = None) -> int:
        self.waited = True
        self.wait_timeouts.append(timeout)
        return self.returncode


class FakeGroup:
    def __init__(self, *, alive: bool = False) -> None:
        self.alive = alive
        self.calls = []

    def __call__(self, pid, sig):
        self.calls.append((pid, sig))
        if sig == signal.SIGKILL:
            self.alive = False
        elif sig == 0 and not self.alive:
            raise ProcessLookupError()


class FakePopen:
    def __init__(self, child: FakeChild) -> None:
        self.child = child
        self.calls: list[tuple[tuple[str, ...], dict[str, object]]] = []

    def __call__(self, argv, **kwargs):
        self.calls.append((tuple(argv), kwargs))
        return self.child


class FakeClock:
    def __init__(self, *values: float) -> None:
        self.values = list(values)
        self.last = values[-1]

    def __call__(self) -> float:
        return self.values.pop(0) if self.values else self.last


class FakeSelect:
    def __init__(self, *, readable: bool = True) -> None:
        self.readable = readable
        self.calls: list[tuple[tuple[FakeStream, ...], float]] = []

    def __call__(self, streams, _writable, _errors, timeout):
        self.calls.append((tuple(streams), timeout))
        if not self.readable:
            return [], [], []
        return [stream for stream in streams if not stream.closed], [], []


def valid_responses(files: dict[bytes, bytes] = FILES) -> dict[tuple[str, ...], bytes]:
    responses = {
        command("remote", "get-url", "origin"): PRIVATE_ORIGIN.encode() + b"\n",
        command("rev-parse", "--verify", "--quiet", f"{PINNED_COMMIT}^{{commit}}"): PINNED_COMMIT.encode() + b"\n",
        command("rev-parse", "--verify", "--quiet", f"{PINNED_COMMIT}^{{tree}}"): PINNED_TREE.encode() + b"\n",
        command("ls-tree", "-r", "-z", "-l", PINNED_TREE): tree_output(files),
    }
    for content in files.values():
        responses[command("cat-file", "blob", git_blob_oid(content))] = content
    return responses


class PrivateGitTests(unittest.TestCase):
    def _source(self) -> PrivateGitSource:
        return PrivateGitSource(checkout=CHECKOUT)

    def test_exact_identity_tree_and_blob_argvs_feed_the_existing_exporter(self) -> None:
        files = {
            **FILES,
            b"rules/copy.json": FILES[b"rules/space name\nnext.json"],
        }
        fake = FakeGit(valid_responses(files))
        expected = object()

        def read_all_blobs(_commit, _tree, entries, read_blob, *_args, **_kwargs):
            for entry in entries:
                self.assertEqual(read_blob(entry.object_id), files[entry.path.encode("utf-8")])
            return expected

        with patch("private_git.export_verified_bundle", side_effect=read_all_blobs) as export:
            actual = acquire_verified_private_bundle(self._source(), DESTINATION, fake)

        self.assertIs(actual, expected)
        expected_entries = [
            GitLsTreeBlob(
                path=path.decode("utf-8"),
                mode="100644",
                object_type="blob",
                object_id=git_blob_oid(content),
                size=len(content),
            )
            for path, content in files.items()
        ]
        export.assert_called_once_with(
            PINNED_COMMIT,
            PINNED_TREE,
            expected_entries,
            ANY,
            DESTINATION,
            expected_commit=PINNED_COMMIT,
            expected_tree=PINNED_TREE,
            expected_manifest_digest=PINNED_MANIFEST_DIGEST,
            entrypoint=ENTRYPOINT,
            max_files=MAX_FILES,
            max_total_bytes=MAX_TOTAL_BYTES,
        )
        self.assertEqual(
            fake.calls,
            [
                (command("remote", "get-url", "origin"), MAX_IDENTITY_BYTES),
                (command("rev-parse", "--verify", "--quiet", f"{PINNED_COMMIT}^{{commit}}"), MAX_IDENTITY_BYTES),
                (command("rev-parse", "--verify", "--quiet", f"{PINNED_COMMIT}^{{tree}}"), MAX_IDENTITY_BYTES),
                (command("ls-tree", "-r", "-z", "-l", PINNED_TREE), MAX_METADATA_BYTES),
                *[
                    (command("cat-file", "blob", git_blob_oid(content)), len(content))
                    for content in dict.fromkeys(files.values())
                ],
            ],
        )

    def test_wrong_origin_or_commit_or_tree_refuses_before_tree_or_blob_read(self) -> None:
        cases = {
            "wrong-origin": (command("remote", "get-url", "origin"), b"git@github.com:LucasQuiles/other.git\n"),
            "wrong-commit": (command("rev-parse", "--verify", "--quiet", f"{PINNED_COMMIT}^{{commit}}"), b"c" * 40 + b"\n"),
            "wrong-tree": (command("rev-parse", "--verify", "--quiet", f"{PINNED_COMMIT}^{{tree}}"), b"d" * 40 + b"\n"),
        }
        for label, (changed_argv, changed_response) in cases.items():
            with self.subTest(label=label):
                responses = valid_responses()
                responses[changed_argv] = changed_response
                fake = FakeGit(responses)
                with patch("private_git.export_verified_bundle") as export, self.assertRaises(BoundaryError):
                    acquire_verified_private_bundle(self._source(), DESTINATION, fake)
                export.assert_not_called()
                self.assertNotIn((command("ls-tree", "-r", "-z", "-l", PINNED_TREE), MAX_METADATA_BYTES), fake.calls)
                self.assertFalse(any("cat-file" in argv for argv, _ in fake.calls))

    def test_real_exporter_materializes_verified_blobs_and_reads_duplicates_once(self) -> None:
        files = {
            b"scripts/test-integrity": FILES[b"scripts/test-integrity"],
            b"rules/default.json": b'{"rules": []}\n',
            b"rules/copy.json": b'{"rules": []}\n',
        }
        manifest = b"".join(
            path + b"\0" + hashlib.sha256(content).hexdigest().encode() + b"\n"
            for path, content in sorted(files.items())
        )
        fake = FakeGit(valid_responses(files))
        with tempfile.TemporaryDirectory(prefix="private-git-real-export-") as temporary:
            destination = Path(temporary) / "scanner"
            with patch("private_git.PINNED_MANIFEST_DIGEST", hashlib.sha256(manifest).hexdigest()):
                bundle = acquire_verified_private_bundle(self._source(), destination, fake)
            self.assertEqual(bundle.bundle.root, destination)
            for path, content in files.items():
                self.assertEqual((destination / path.decode()).read_bytes(), content)
            self.assertFalse((destination / ".git").exists())
        self.assertFalse(destination.exists())
        self.assertEqual(
            [argv for argv, _ in fake.calls if "cat-file" in argv],
            [command("cat-file", "blob", git_blob_oid(content)) for content in dict.fromkeys(files.values())],
        )

    def test_truncated_invalid_mode_or_nonblob_tree_records_refuse_before_blob_or_export(self) -> None:
        content = FILES[b"scripts/test-integrity"]
        cases = {
            "truncated": tree_record(b"scripts/test-integrity", content)[:-1],
            "invalid-mode": tree_record(b"scripts/test-integrity", content, mode=b"120000"),
            "nonblob": tree_record(b"scripts/test-integrity", content, object_type=b"tree"),
        }
        for label, listing in cases.items():
            with self.subTest(label=label):
                responses = valid_responses({b"scripts/test-integrity": content})
                responses[command("ls-tree", "-r", "-z", "-l", PINNED_TREE)] = listing
                fake = FakeGit(responses)
                with patch("private_git.export_verified_bundle") as export, self.assertRaises(BoundaryError):
                    acquire_verified_private_bundle(self._source(), DESTINATION, fake)
                export.assert_not_called()
                self.assertFalse(any("cat-file" in argv for argv, _ in fake.calls))

    def test_declared_or_returned_oversize_blob_refuses_before_export(self) -> None:
        content = FILES[b"scripts/test-integrity"]
        cases = {
            "declared-total": tree_record(b"scripts/test-integrity", content, size=MAX_TOTAL_BYTES + 1),
            "returned-over-declared": tree_record(b"scripts/test-integrity", content),
        }
        for label, listing in cases.items():
            with self.subTest(label=label):
                responses = valid_responses({b"scripts/test-integrity": content})
                responses[command("ls-tree", "-r", "-z", "-l", PINNED_TREE)] = listing
                if label == "returned-over-declared":
                    responses[command("cat-file", "blob", git_blob_oid(content))] = content + b"x"
                fake = FakeGit(responses)
                with patch(
                    "private_git.export_verified_bundle",
                    side_effect=lambda _commit, _tree, entries, read_blob, *_args, **_kwargs: read_blob(entries[0].object_id),
                ) as export, self.assertRaises(BoundaryError):
                    acquire_verified_private_bundle(self._source(), DESTINATION, fake)
                if label == "declared-total":
                    export.assert_not_called()
                    self.assertFalse(any("cat-file" in argv for argv, _ in fake.calls))
                else:
                    export.assert_called_once()
                    self.assertIn((command("cat-file", "blob", git_blob_oid(content)), len(content)), fake.calls)

    def test_file_limit_refuses_before_blob_or_export(self) -> None:
        listing = b"".join(
            tree_record(f"rules/{index}.json".encode(), b"x")
            for index in range(MAX_FILES + 1)
        )
        responses = valid_responses()
        responses[command("ls-tree", "-r", "-z", "-l", PINNED_TREE)] = listing
        fake = FakeGit(responses)
        with patch("private_git.export_verified_bundle") as export, self.assertRaises(BoundaryError):
            acquire_verified_private_bundle(self._source(), DESTINATION, fake)
        export.assert_not_called()
        self.assertFalse(any("cat-file" in argv for argv, _ in fake.calls))

    def test_traversal_or_git_metadata_refuses_before_blob_read_without_creating_destination(self) -> None:
        content = FILES[b"scripts/test-integrity"]
        cases = {
            "parent-traversal": b"../outside.py",
            "git-metadata": b".git/config",
        }
        for label, path in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory(prefix="private-git-test-") as temporary:
                responses = valid_responses({b"scripts/test-integrity": content})
                responses[command("ls-tree", "-r", "-z", "-l", PINNED_TREE)] = tree_record(path, content)
                fake = FakeGit(responses)
                destination = Path(temporary) / "scanner-bundle"

                with self.assertRaises(BoundaryError):
                    acquire_verified_private_bundle(self._source(), destination, fake)

                self.assertFalse(destination.exists())
                self.assertFalse(any("cat-file" in argv for argv, _ in fake.calls))

    def test_bounded_runner_allows_only_fixed_read_argv_with_pinned_binary_and_sanitized_environment(self) -> None:
        self.assertTrue(callable(getattr(private_git, "make_bounded_git_runner", None)), "bounded Git runner is not implemented")
        with tempfile.TemporaryDirectory(prefix="private-git-runner-") as temporary:
            checkout = Path(temporary) / "checkout"
            checkout.mkdir()
            source = PrivateGitSource(checkout=checkout)
            git_binary = Path(temporary) / "git"
            git_binary.write_bytes(b"pinned fake git")
            git_binary.chmod(0o700)
            child = FakeChild(stdout=PRIVATE_ORIGIN.encode() + b"\n")
            popen = FakePopen(child)
            selector = FakeSelect()
            runner = private_git.make_bounded_git_runner(
                source,
                git_binary=git_binary,
                expected_git_sha256=hashlib.sha256(git_binary.read_bytes()).hexdigest(),
                deadline_seconds=5,
                max_stderr_bytes=64,
                popen=popen,
                select_ready=selector,
                monotonic=FakeClock(0, 0, 0),
                killpg=FakeGroup(),
            )
            argv = ("git", "-C", str(checkout), "remote", "get-url", "origin")

            with patch.dict(os.environ, {
                "GIT_CONFIG_COUNT": "9", "GIT_SSH_COMMAND": "private command",
                "SSH_AUTH_SOCK": "/private/socket", "SECRET": "private", "TMPDIR": temporary,
            }):
                self.assertEqual(runner(argv, MAX_IDENTITY_BYTES), PRIVATE_ORIGIN.encode() + b"\n")

        self.assertEqual(len(popen.calls), 1)
        argv, kwargs = popen.calls[0]
        self.assertEqual(argv, (str(git_binary), "-C", str(checkout), "remote", "get-url", "origin"))
        self.assertIs(kwargs["stdin"], subprocess.DEVNULL)
        self.assertIs(kwargs["stdout"], subprocess.PIPE)
        self.assertIs(kwargs["stderr"], subprocess.PIPE)
        self.assertTrue(kwargs["start_new_session"])
        self.assertFalse(kwargs.get("shell", False))
        self.assertEqual(kwargs["bufsize"], 0)
        environment = kwargs["env"]
        self.assertIsInstance(environment, dict)
        self.assertIn("PATH", environment)
        self.assertEqual(environment["GIT_CONFIG_GLOBAL"], "/dev/null")
        self.assertEqual(environment["GIT_CONFIG_NOSYSTEM"], "1")
        self.assertEqual(environment["GIT_NO_REPLACE_OBJECTS"], "1")
        self.assertEqual(environment["GIT_NO_LAZY_FETCH"], "1")
        self.assertEqual(environment["GIT_TERMINAL_PROMPT"], "0")
        self.assertEqual(environment["GIT_ASKPASS"], "/usr/bin/false")
        self.assertEqual(environment["GIT_ALLOW_PROTOCOL"], "")
        self.assertEqual(environment["GIT_OPTIONAL_LOCKS"], "0")
        self.assertNotIn("GIT_CONFIG_COUNT", environment)
        self.assertEqual(environment.get("TMPDIR"), temporary)
        self.assertFalse(any(key.startswith("SSH_") or key == "SECRET" for key in environment))
        self.assertTrue(selector.calls)

    def test_bounded_runner_refuses_unpinned_binary_or_nonallowlisted_command_before_spawn(self) -> None:
        self.assertTrue(callable(getattr(private_git, "make_bounded_git_runner", None)), "bounded Git runner is not implemented")
        with tempfile.TemporaryDirectory(prefix="private-git-runner-") as temporary:
            checkout = Path(temporary) / "checkout"
            checkout.mkdir()
            source = PrivateGitSource(checkout=checkout)
            git_binary = Path(temporary) / "git"
            git_binary.write_bytes(b"pinned fake git")
            git_binary.chmod(0o700)
            popen = FakePopen(FakeChild())
            good_argv = ("git", "-C", str(checkout), "remote", "get-url", "origin")
            cases = {
                "digest": dict(expected_git_sha256="0" * 64, argv=good_argv, maximum=MAX_IDENTITY_BYTES),
                "command": dict(
                    expected_git_sha256=hashlib.sha256(git_binary.read_bytes()).hexdigest(),
                    argv=("git", "-C", str(checkout), "fetch", "origin"), maximum=MAX_IDENTITY_BYTES,
                ),
                "checkout": dict(
                    expected_git_sha256=hashlib.sha256(git_binary.read_bytes()).hexdigest(),
                    argv=("git", "-C", "/private/other", "remote", "get-url", "origin"), maximum=MAX_IDENTITY_BYTES,
                ),
                "bool-bound": dict(expected_git_sha256=hashlib.sha256(git_binary.read_bytes()).hexdigest(), argv=good_argv, maximum=True),
                "negative-bound": dict(expected_git_sha256=hashlib.sha256(git_binary.read_bytes()).hexdigest(), argv=good_argv, maximum=-1),
            }
            for label, case in cases.items():
                with self.subTest(label=label):
                    with self.assertRaises(BoundaryError):
                        private_git.make_bounded_git_runner(
                            source,
                            git_binary=git_binary,
                            expected_git_sha256=case["expected_git_sha256"],
                            deadline_seconds=1,
                            max_stderr_bytes=64,
                            popen=popen,
                            select_ready=FakeSelect(),
                            monotonic=FakeClock(0, 0),
                            killpg=lambda _pid, _signal: None,
                        )(case["argv"], case["maximum"])
        self.assertEqual(popen.calls, [])

    def test_bounded_runner_reaps_timeout_and_redacts_nonzero_or_overlimit_output(self) -> None:
        self.assertTrue(callable(getattr(private_git, "make_bounded_git_runner", None)), "bounded Git runner is not implemented")
        with tempfile.TemporaryDirectory(prefix="private-git-runner-") as temporary:
            checkout = Path(temporary) / "checkout"
            checkout.mkdir()
            source = PrivateGitSource(checkout=checkout)
            git_binary = Path(temporary) / "git"
            git_binary.write_bytes(b"pinned fake git")
            git_binary.chmod(0o700)
            digest = hashlib.sha256(git_binary.read_bytes()).hexdigest()
            cases = {
                "nonzero": (FakeChild(stderr=b"secret", returncode=1), FakeSelect(), FakeClock(0, 0, 0), MAX_IDENTITY_BYTES),
                "stdout-limit": (FakeChild(stdout=b"x" * (MAX_IDENTITY_BYTES + 2)), FakeSelect(), FakeClock(0, 0, 0), MAX_IDENTITY_BYTES),
                "stderr-limit": (FakeChild(stderr=b"y" * 9), FakeSelect(), FakeClock(0, 0, 0), MAX_IDENTITY_BYTES),
                "deadline": (FakeChild(stdout=b"still-open"), FakeSelect(readable=False), FakeClock(0, 2), MAX_IDENTITY_BYTES),
            }
            for label, (child, selector, clock, maximum) in cases.items():
                with self.subTest(label=label):
                    popen = FakePopen(child)
                    group = FakeGroup(alive=True)
                    runner = private_git.make_bounded_git_runner(
                        source,
                        git_binary=git_binary,
                        expected_git_sha256=digest,
                        deadline_seconds=1,
                        max_stderr_bytes=8,
                        popen=popen,
                        select_ready=selector,
                        monotonic=clock,
                        killpg=group,
                    )
                    with self.assertRaises(BoundaryError) as raised:
                        runner(("git", "-C", str(checkout), "remote", "get-url", "origin"), maximum)
                    self.assertNotIn("secret", str(raised.exception))
                    self.assertIn((child.pid, signal.SIGKILL), group.calls)
                    self.assertTrue(all(pid == child.pid for pid, _signal in group.calls))
                    self.assertTrue(child.waited)
                    self.assertTrue(all(value <= 1 for value in child.wait_timeouts))
                    self.assertTrue(child.stdout.closed)
                    self.assertTrue(child.stderr.closed)
                    if label == "stdout-limit":
                        self.assertLessEqual(max(child.stdout.read_sizes), maximum + 1)
                    if label == "stderr-limit":
                        self.assertLessEqual(max(child.stderr.read_sizes), 9)

    def test_bounded_runner_refuses_success_with_a_surviving_descendant_group(self) -> None:
        with tempfile.TemporaryDirectory(prefix="private-git-runner-") as temporary:
            checkout = Path(temporary) / "checkout"
            checkout.mkdir()
            git_binary = Path(temporary) / "git"
            git_binary.write_bytes(b"pinned fake git")
            git_binary.chmod(0o700)
            child = FakeChild(stdout=b"valid result\n")
            group = FakeGroup(alive=True)
            runner = private_git.make_bounded_git_runner(
                PrivateGitSource(checkout), git_binary=git_binary,
                expected_git_sha256=hashlib.sha256(git_binary.read_bytes()).hexdigest(),
                deadline_seconds=1, max_stderr_bytes=8, popen=FakePopen(child),
                select_ready=FakeSelect(), monotonic=FakeClock(0), killpg=group,
            )
            with self.assertRaises(BoundaryError):
                runner(("git", "-C", str(checkout), "remote", "get-url", "origin"), 64)
            self.assertFalse(group.alive)
            self.assertIn((child.pid, signal.SIGKILL), group.calls)
            self.assertIn((child.pid, 0), group.calls)


if __name__ == "__main__":
    unittest.main()
