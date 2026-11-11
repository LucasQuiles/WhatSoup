from __future__ import annotations

import base64
import hashlib
import os
import signal
import subprocess
import tempfile
import unittest
from pathlib import Path, PurePosixPath
from unittest.mock import patch

import private_scanner_candidate as scanner_candidate
from private_scanner_candidate import (
    BoundaryError,
    CandidateBlob,
    PullRequestBinding,
    TrustedBaseline,
    TrustedScannerBundle,
    WorkflowRunBinding,
    build_runner_plan,
    materialize_candidate_tests,
    prepare_candidate_tests,
    run_scanner_privately,
    verify_scanner_bundle,
    verify_trusted_baseline,
    verify_workflow_run_binding,
)


BASE = "a" * 40
HEAD = "b" * 40


def blob(path: str, content: bytes = b"it('works', () => expect(true).toBe(true));\n", mode: str = "100644") -> CandidateBlob:
    return CandidateBlob(path=path, mode=mode, object_type="blob", content=content)


def trusted_selector(path: PurePosixPath) -> bool:
    return path.as_posix().endswith(".test.ts")


def git_blob_sha(content: bytes) -> str:
    header = f"blob {len(content)}\0".encode("ascii")
    return hashlib.sha1(header + content).hexdigest()


def github_tree_blob(
    path: str,
    content: bytes,
    *,
    mode: str = "100644",
    object_type: str = "blob",
    sha: str | None = None,
    size: int | None = None,
) -> dict[str, object]:
    return {
        "path": path,
        "mode": mode,
        "type": object_type,
        "sha": sha if sha is not None else git_blob_sha(content),
        "size": len(content) if size is None else size,
    }


def github_tree_directory(
    path: str,
    *,
    mode: str = "040000",
    object_type: str = "tree",
    sha: str | None = None,
) -> dict[str, object]:
    return {
        "path": path,
        "mode": mode,
        "type": object_type,
        "sha": sha if sha is not None else BASE,
    }


def github_tree(entries: list[dict[str, object]], *, sha: str = HEAD, truncated: bool | None = False) -> dict[str, object]:
    response: dict[str, object] = {"sha": sha, "tree": entries}
    if truncated is not None:
        response["truncated"] = truncated
    return response


def github_blob(content: bytes, *, sha: str | None = None, size: int | None = None) -> dict[str, object]:
    return {
        "sha": sha if sha is not None else git_blob_sha(content),
        "size": len(content) if size is None else size,
        "encoding": "base64",
        "content": base64.b64encode(content).decode("ascii"),
    }


def fetch_candidate_blobs(
    *,
    expected_tree_sha: str,
    tree_response: dict[str, object],
    blob_fetch,
    selector,
    max_tree_entries: int,
    max_blob_bytes: int,
    max_files: int,
    max_total_bytes: int,
):
    return scanner_candidate.fetch_candidate_blobs_from_github_tree(
        expected_tree_sha=expected_tree_sha,
        tree_response=tree_response,
        blob_fetch=blob_fetch,
        selector=selector,
        max_tree_entries=max_tree_entries,
        max_blob_bytes=max_blob_bytes,
        max_files=max_files,
        max_total_bytes=max_total_bytes,
    )


def verified_scanner(root: Path):
    root.mkdir()
    (root / "scripts").mkdir()
    entrypoint = root / "scripts/test-integrity"
    entrypoint.write_text("#!/bin/sh\n", encoding="utf-8")
    file_digest = hashlib.sha256(entrypoint.read_bytes()).hexdigest()
    manifest = {"scripts/test-integrity": file_digest}
    manifest_digest = hashlib.sha256(
        f"scripts/test-integrity\0{file_digest}\n".encode("utf-8"),
    ).hexdigest()
    return verify_scanner_bundle(
        TrustedScannerBundle(root=root, entrypoint=entrypoint, manifest_digest=manifest_digest),
        manifest,
    )


class FakeScannerChild:
    def __init__(self, *, pid: int = 4815, returncode: int = 0, outcomes: tuple[object, ...] = ()) -> None:
        self.pid = pid
        self.returncode = returncode
        self._outcomes = list(outcomes)
        self.wait_timeouts: list[float | None] = []

    def wait(self, timeout: float | None = None) -> int:
        self.wait_timeouts.append(timeout)
        if self._outcomes:
            outcome = self._outcomes.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
            self.returncode = outcome
        return self.returncode


class FakeScannerPopen:
    def __init__(self, child: FakeScannerChild | None = None, error: BaseException | None = None) -> None:
        self.child = child
        self.error = error
        self.calls: list[tuple[tuple[str, ...], dict[str, object]]] = []

    def __call__(self, argv, **kwargs):
        self.calls.append((tuple(argv), kwargs))
        if self.error is not None:
            raise self.error
        if self.child is None:
            raise AssertionError("fake scanner process is missing")
        return self.child


class FakeProcessGroup:
    def __init__(self, *, alive: bool = False, kill_error: BaseException | None = None) -> None:
        self.alive = alive
        self.kill_error = kill_error
        self.calls: list[tuple[int, int]] = []

    def __call__(self, pid: int, operation: int) -> None:
        self.calls.append((pid, operation))
        if operation == 0:
            if not self.alive:
                raise ProcessLookupError
            return
        if operation not in {signal.SIGTERM, signal.SIGKILL}:
            raise AssertionError("scanner supervision used an unexpected signal")
        if self.kill_error is not None:
            raise self.kill_error
        self.alive = False


class FakeClock:
    def __init__(self, *values: float) -> None:
        self.values = list(values)
        self.last = values[-1] if values else 0.0

    def __call__(self) -> float:
        if self.values:
            self.last = self.values.pop(0)
        return self.last


class FakeSleep:
    def __init__(self) -> None:
        self.calls: list[float] = []

    def __call__(self, duration: float) -> None:
        self.calls.append(duration)


class CandidateMaterializationTests(unittest.TestCase):
    def test_bounds_tree_entries_before_selector_can_drop_non_tests(self) -> None:
        with self.assertRaises(BoundaryError):
            prepare_candidate_tests(
                (
                    blob("src/one.ts"),
                    blob("src/two.ts"),
                    blob("src/three.ts"),
                ),
                selector=lambda _path: False,
                max_tree_entries=2,
                max_files=10,
                max_file_bytes=1024,
                max_total_bytes=4096,
            )

    def test_rejects_unsafe_git_entries_before_any_materialization(self) -> None:
        cases = {
            "escape": (blob("../escape.test.ts"),),
            "symlink": (blob("tests/link.test.ts", mode="120000"),),
            "submodule": (CandidateBlob(path="tests/module.test.ts", mode="160000", object_type="commit", content=b""),),
            "duplicate": (blob("tests/duplicate.test.ts"), blob("tests/duplicate.test.ts")),
        }

        for name, entries in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(BoundaryError):
                    prepare_candidate_tests(
                        entries,
                        selector=trusted_selector,
                        max_tree_entries=10,
                        max_files=10,
                        max_file_bytes=1024,
                        max_total_bytes=4096,
                    )

    def test_rejects_untrusted_scanner_bundle_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "scanner"
            root.mkdir()
            (root / "scripts").mkdir()
            entrypoint = root / "scripts/test-integrity"
            entrypoint.write_text("#!/bin/sh\n", encoding="utf-8")
            bundle = TrustedScannerBundle(
                root=root,
                entrypoint=entrypoint,
                manifest_digest="0" * 64,
            )

            with self.assertRaises(BoundaryError):
                verify_scanner_bundle(bundle, {"scripts/test-integrity": "0" * 64})

    def test_excludes_candidate_policy_and_baseline_controls_from_scan_root(self) -> None:
        plan = prepare_candidate_tests(
            (
                blob("tests/kept.test.ts"),
                blob(".claude/test-integrity/baseline.json", b'{"candidate": "override"}'),
                blob(".claude/test-integrity/rules/block/typescript.yaml", b"- id: bypass\n"),
                blob(".claude/test-integrity/config.yaml", b"quarantine: {}\n"),
            ),
            selector=trusted_selector,
            max_tree_entries=10,
            max_files=10,
            max_file_bytes=1024,
            max_total_bytes=4096,
        )

        self.assertEqual([item.path for item in plan.files], ["tests/kept.test.ts"])
        self.assertEqual(
            plan.denied_control_paths,
            (
                ".claude/test-integrity/baseline.json",
                ".claude/test-integrity/config.yaml",
                ".claude/test-integrity/rules/block/typescript.yaml",
            ),
        )

    def test_rejects_non_utf8_oversized_and_empty_test_inputs(self) -> None:
        with self.assertRaises(BoundaryError):
            prepare_candidate_tests((blob("tests/bad.test.ts", b"\xff"),), selector=trusted_selector, max_tree_entries=10, max_files=10, max_file_bytes=1024, max_total_bytes=4096)
        with self.assertRaises(BoundaryError):
            prepare_candidate_tests((blob("tests/large.test.ts", b"x" * 33),), selector=trusted_selector, max_tree_entries=10, max_files=10, max_file_bytes=32, max_total_bytes=4096)
        with self.assertRaises(BoundaryError):
            prepare_candidate_tests((blob("src/main.ts"),), selector=trusted_selector, max_tree_entries=10, max_files=10, max_file_bytes=1024, max_total_bytes=4096)

    def test_verified_bundle_retains_an_immutable_copy_of_its_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            scanner = verified_scanner(Path(temporary) / "scanner")
            digest = hashlib.sha256(scanner.bundle.entrypoint.read_bytes()).hexdigest()
            supplied = {"scripts/test-integrity": digest}
            verified = verify_scanner_bundle(scanner.bundle, supplied)
            supplied["scripts/test-integrity"] = "0" * 64
            self.assertEqual(getattr(verified, "manifest", None), {"scripts/test-integrity": digest})
            with self.assertRaises(TypeError):
                verified.manifest["scripts/test-integrity"] = "0" * 64

    def test_materializes_only_validated_test_bytes_under_new_root(self) -> None:
        plan = prepare_candidate_tests((blob("tests/nested/valid.test.ts"),), selector=trusted_selector, max_tree_entries=10, max_files=10, max_file_bytes=1024, max_total_bytes=4096)

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "candidate"
            materialize_candidate_tests(plan, root)
            self.assertEqual((root / "tests/nested/valid.test.ts").read_bytes(), b"it('works', () => expect(true).toBe(true));\n")
            self.assertEqual((root / ".private-scanner-root").read_text(encoding="utf-8"), "trusted-root\n")
            self.assertTrue((root / ".claude").is_dir(), "scanner project discovery must stop at the owned scan root")


class GitHubTreeBlobAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.unexpected_fetches: list[str] = []

    def tearDown(self) -> None:
        self.assertEqual(self.unexpected_fetches, [], 'invalid tree triggered a blob fetch')

    def _must_not_fetch(self, _blob_sha: str) -> dict[str, object]:
        # The adapter wraps callback errors, so retain an independently checked observation.
        self.unexpected_fetches.append(_blob_sha)
        self.fail("tree validation must fail before any blob fetch")

    def test_rejects_truncated_missing_or_mismatched_tree_identity_before_fetch(self) -> None:
        valid_entry = github_tree_blob("tests/valid.test.ts", b"test('valid', () => {});\n")
        cases = {
            "truncated": github_tree([valid_entry], truncated=True),
            "missing-truncation": github_tree([valid_entry], truncated=None),
            "wrong-tree-sha": github_tree([valid_entry], sha=BASE),
        }

        for name, response in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(BoundaryError):
                    fetch_candidate_blobs(
                        expected_tree_sha=HEAD,
                        tree_response=response,
                        blob_fetch=self._must_not_fetch,
                        selector=trusted_selector,
                        max_tree_entries=10,
                        max_blob_bytes=1024,
                        max_files=10,
                        max_total_bytes=4096,
                    )

    def test_rejects_malformed_unsafe_duplicate_or_overbound_entries_before_fetch(self) -> None:
        valid_content = b"test('valid', () => {});\n"
        cases = {
            "missing-blob-sha": [
                {
                    "path": "tests/missing-id.test.ts",
                    "mode": "100644",
                    "type": "blob",
                    "size": len(valid_content),
                },
            ],
            "escape": [github_tree_blob("../escape.test.ts", valid_content)],
            "duplicate": [
                github_tree_blob("tests/duplicate.test.ts", valid_content),
                github_tree_blob("tests/duplicate.test.ts", valid_content),
            ],
            "symlink": [github_tree_blob("tests/link.test.ts", valid_content, mode="120000")],
            "submodule": [
                github_tree_blob(
                    "tests/module.test.ts",
                    b"",
                    mode="160000",
                    object_type="commit",
                    sha=BASE,
                ),
            ],
            "entry-bound": [
                github_tree_blob("tests/one.test.ts", valid_content),
                github_tree_blob("tests/two.test.ts", valid_content),
                github_tree_blob("tests/three.test.ts", valid_content),
            ],
        }

        for name, entries in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(BoundaryError):
                    fetch_candidate_blobs(
                        expected_tree_sha=HEAD,
                        tree_response=github_tree(entries),
                        blob_fetch=self._must_not_fetch,
                        selector=trusted_selector,
                        max_tree_entries=2 if name == "entry-bound" else 10,
                        max_blob_bytes=1024,
                        max_files=10,
                        max_total_bytes=4096,
                    )

    def test_rejects_selected_tree_blob_over_bound_before_fetch(self) -> None:
        response = github_tree(
            [
                github_tree_blob(
                    "tests/large.test.ts",
                    b"",
                    sha=BASE,
                    size=1025,
                ),
            ],
        )

        with self.assertRaises(BoundaryError):
            fetch_candidate_blobs(
                expected_tree_sha=HEAD,
                tree_response=response,
                blob_fetch=self._must_not_fetch,
                selector=trusted_selector,
                max_tree_entries=10,
                max_blob_bytes=1024,
                max_files=10,
                max_total_bytes=4096,
            )

    def test_allows_regular_directory_ancestors_without_fetching_them(self) -> None:
        selected_content = b"test('selected', () => {});\n"
        selected = github_tree_blob("tests/nested/selected.test.ts", selected_content)
        fetched: list[str] = []

        def fetch(blob_sha: str) -> dict[str, object]:
            fetched.append(blob_sha)
            self.assertEqual(blob_sha, selected["sha"])
            return github_blob(selected_content)

        result = fetch_candidate_blobs(
            expected_tree_sha=HEAD,
            tree_response=github_tree(
                [
                    github_tree_directory("tests"),
                    github_tree_directory("tests/nested"),
                    selected,
                ],
            ),
            blob_fetch=fetch,
            selector=trusted_selector,
            max_tree_entries=10,
            max_blob_bytes=1024,
            max_files=10,
            max_total_bytes=4096,
        )

        self.assertEqual(fetched, [selected["sha"]])
        self.assertEqual(
            list(result),
            [
                CandidateBlob(
                    path="tests/nested/selected.test.ts",
                    mode="100644",
                    object_type="blob",
                    content=selected_content,
                ),
            ],
        )

    def test_rejects_malformed_directory_metadata_before_fetch(self) -> None:
        cases = {
            "wrong-mode": [github_tree_directory("tests", mode="100644")],
            "missing-sha": [{"path": "tests", "mode": "040000", "type": "tree"}],
            "invalid-sha": [github_tree_directory("tests", sha="not-a-git-object")],
        }

        for name, entries in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(BoundaryError):
                    fetch_candidate_blobs(
                        expected_tree_sha=HEAD,
                        tree_response=github_tree(entries),
                        blob_fetch=self._must_not_fetch,
                        selector=trusted_selector,
                        max_tree_entries=10,
                        max_blob_bytes=1024,
                        max_files=10,
                        max_total_bytes=4096,
                    )

    def test_rejects_blob_path_ancestor_collision_before_fetch(self) -> None:
        response = github_tree(
            [
                github_tree_blob("tests", b"ordinary blob\n"),
                github_tree_blob("tests/selected.test.ts", b"test('selected', () => {});\n"),
            ],
        )

        with self.assertRaises(BoundaryError):
            fetch_candidate_blobs(
                expected_tree_sha=HEAD,
                tree_response=response,
                blob_fetch=self._must_not_fetch,
                selector=trusted_selector,
                max_tree_entries=10,
                max_blob_bytes=1024,
                max_files=10,
                max_total_bytes=4096,
            )

    def test_fetches_only_selected_verified_test_blob(self) -> None:
        selected_content = b"test('selected', () => {});\n"
        unselected_content = b"export const application = 'not scanned';\n"
        selected = github_tree_blob("tests/selected.test.ts", selected_content)
        unselected = github_tree_blob("src/main.ts", unselected_content)
        unselected_large = github_tree_blob("src/large.ts", b"", sha=BASE, size=10_000_000)
        responses = {
            selected["sha"]: github_blob(selected_content),
            unselected["sha"]: github_blob(unselected_content),
        }
        fetched: list[str] = []

        def fetch(blob_sha: str) -> dict[str, object]:
            fetched.append(blob_sha)
            return responses[blob_sha]

        result = fetch_candidate_blobs(
            expected_tree_sha=HEAD,
            tree_response=github_tree([selected, unselected, unselected_large]),
            blob_fetch=fetch,
            selector=trusted_selector,
            max_tree_entries=10,
            max_blob_bytes=1024,
            max_files=10,
            max_total_bytes=4096,
        )

        self.assertEqual(fetched, [selected["sha"]])
        self.assertEqual(
            list(result),
            [
                CandidateBlob(
                    path="tests/selected.test.ts",
                    mode="100644",
                    object_type="blob",
                    content=selected_content,
                ),
            ],
        )

    def test_rejects_selected_count_or_total_overflow_before_fetch(self) -> None:
        first_content = b"test('first', () => {});\n"
        second_content = b"test('second', () => {});\n"
        entries = [
            github_tree_blob("tests/first.test.ts", first_content),
            github_tree_blob("tests/second.test.ts", second_content),
        ]
        cases = {
            "selected-count": {"max_files": 1, "max_total_bytes": len(first_content) + len(second_content)},
            "selected-total": {"max_files": 2, "max_total_bytes": len(first_content) + len(second_content) - 1},
        }

        for name, limits in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(BoundaryError):
                    fetch_candidate_blobs(
                        expected_tree_sha=HEAD,
                        tree_response=github_tree(entries),
                        blob_fetch=self._must_not_fetch,
                        selector=trusted_selector,
                        max_tree_entries=10,
                        max_blob_bytes=1024,
                        **limits,
                    )

    def test_fetches_exact_selected_aggregate_boundary_without_unselected_debt(self) -> None:
        first_content = b"test('first', () => {});\n"
        second_content = b"test('second', () => {});\n"
        first = github_tree_blob("tests/first.test.ts", first_content)
        second = github_tree_blob("tests/second.test.ts", second_content)
        unselected_large = github_tree_blob("src/large.ts", b"", sha=BASE, size=10_000_000)
        responses = {
            first["sha"]: github_blob(first_content),
            second["sha"]: github_blob(second_content),
        }
        fetched: list[str] = []

        def fetch(blob_sha: str) -> dict[str, object]:
            fetched.append(blob_sha)
            return responses[blob_sha]

        result = fetch_candidate_blobs(
            expected_tree_sha=HEAD,
            tree_response=github_tree([first, second, unselected_large]),
            blob_fetch=fetch,
            selector=trusted_selector,
            max_tree_entries=10,
            max_blob_bytes=1024,
            max_files=2,
            max_total_bytes=len(first_content) + len(second_content),
        )

        self.assertEqual(fetched, [first["sha"], second["sha"]])
        self.assertEqual([item.content for item in result], [first_content, second_content])

    def test_rejects_fetched_blob_identity_size_or_content_boundary_mismatch(self) -> None:
        expected_content = b"test('expected', () => {});\n"
        entry = github_tree_blob("tests/expected.test.ts", expected_content)
        too_large = b"x" * 1025
        cases = {
            "response-sha": github_blob(expected_content, sha=BASE),
            "response-size": github_blob(expected_content, size=len(expected_content) + 1),
            "content-git-sha": github_blob(b"test('altered!', () => {});\n", sha=entry["sha"]),
            "content-bound": github_blob(too_large, sha=entry["sha"], size=len(too_large)),
        }

        for name, blob_response in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(BoundaryError):
                    fetch_candidate_blobs(
                        expected_tree_sha=HEAD,
                        tree_response=github_tree([entry]),
                        blob_fetch=lambda _blob_sha: blob_response,
                        selector=trusted_selector,
                        max_tree_entries=10,
                        max_blob_bytes=1024,
                        max_files=10,
                        max_total_bytes=4096,
                    )

    def test_accepts_newline_wrapped_github_base64_content(self) -> None:
        content = b"test('newline', () => {});\n"
        entry = github_tree_blob("tests/newline.test.ts", content)
        response = github_blob(content)
        response["content"] = f"{response['content']}\n"

        result = fetch_candidate_blobs(
            expected_tree_sha=HEAD,
            tree_response=github_tree([entry]),
            blob_fetch=lambda _blob_sha: response,
            selector=trusted_selector,
            max_tree_entries=10,
            max_blob_bytes=1024,
            max_files=10,
            max_total_bytes=4096,
        )

        self.assertEqual(list(result), [CandidateBlob("tests/newline.test.ts", "100644", "blob", content)])

    def test_rejects_garbage_or_nonascii_blob_content(self) -> None:
        content = b"test('invalid', () => {});\n"
        entry = github_tree_blob("tests/invalid.test.ts", content)
        cases = {
            "garbage": "not-valid-base64!",
            "nonascii": "snowman-\u2603",
        }

        for name, encoded in cases.items():
            with self.subTest(name=name):
                response = github_blob(content)
                response["content"] = encoded
                with self.assertRaises(BoundaryError):
                    fetch_candidate_blobs(
                        expected_tree_sha=HEAD,
                        tree_response=github_tree([entry]),
                        blob_fetch=lambda _blob_sha: response,
                        selector=trusted_selector,
                        max_tree_entries=10,
                        max_blob_bytes=1024,
                        max_files=10,
                        max_total_bytes=4096,
                    )


class WorkflowRunBindingTests(unittest.TestCase):
    def test_refuses_fork_and_stale_head_before_scanner_planning(self) -> None:
        common = dict(base_repository="LucasQuiles/WhatSoup", base_sha=BASE, current_head_sha=HEAD, head_sha=HEAD)

        with self.assertRaises(BoundaryError):
            verify_workflow_run_binding(
                WorkflowRunBinding(repository="LucasQuiles/WhatSoup", head_sha=HEAD, trusted_workflow_ref="refs/heads/main"),
                PullRequestBinding(head_repository="outside/WhatSoup", **common),
            )
        with self.assertRaises(BoundaryError):
            verify_workflow_run_binding(
                WorkflowRunBinding(repository="LucasQuiles/WhatSoup", head_sha=BASE, trusted_workflow_ref="refs/heads/main"),
                PullRequestBinding(head_repository="LucasQuiles/WhatSoup", **common),
            )

    def test_builds_a_pinned_sanitized_runner_plan_for_current_same_repo_head(self) -> None:
        binding = verify_workflow_run_binding(
            WorkflowRunBinding(repository="LucasQuiles/WhatSoup", head_sha=HEAD, trusted_workflow_ref="refs/heads/main"),
            PullRequestBinding(
                base_repository="LucasQuiles/WhatSoup",
                head_repository="LucasQuiles/WhatSoup",
                base_sha=BASE,
                head_sha=HEAD,
                current_head_sha=HEAD,
            ),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            root = temp_root / "scanner"
            scanner = verified_scanner(root)
            baseline_path = temp_root / "base-baseline.json"
            baseline_path.write_text('{"schema_version":"1","findings":[]}', encoding="utf-8")
            baseline = verify_trusted_baseline(
                TrustedBaseline(
                    path=baseline_path,
                    base_sha=BASE,
                    sha256=hashlib.sha256(baseline_path.read_bytes()).hexdigest(),
                ),
                BASE,
            )
            plan = build_runner_plan(
                binding=binding,
                scanner=scanner,
                scan_root=Path("/private/tmp/scan-root"),
                trusted_home=Path("/private/tmp/scanner-home"),
                trusted_baseline=baseline,
                trusted_path="/usr/bin:/bin",
                candidate_paths=("tests/one.test.ts",),
                check_name="private-test-integrity",
            )

        self.assertEqual(plan.command[:6], (
            str(root / "scripts/test-integrity"),
            "baseline",
            "--check",
            "--ci",
            "--baseline-file",
            str(baseline_path),
        ))
        self.assertIn(".private-scanner-root", plan.command)
        self.assertEqual(plan.environment, {
            "CLAUDE_PLUGIN_ROOT": str(root),
            "HOME": "/private/tmp/scanner-home",
            "PATH": "/usr/bin:/bin",
            "WHATSOUP_REQUIRE_TEST_INTEGRITY": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
        })
        self.assertEqual(plan.cwd, Path("/private/tmp/scan-root"))
        self.assertEqual(plan.public_result("pass"), {
            "check_name": "private-test-integrity",
            "conclusion": "pass",
            "head_sha": HEAD,
        })
        self.assertNotIn("stdout", repr(plan.public_result("fail")))
        self.assertNotIn("stderr", repr(plan.public_result("fail")))

    def test_runner_separates_candidate_paths_from_scanner_flags(self) -> None:
        binding = verify_workflow_run_binding(
            WorkflowRunBinding(repository="LucasQuiles/WhatSoup", head_sha=HEAD, trusted_workflow_ref="refs/heads/main"),
            PullRequestBinding(
                base_repository="LucasQuiles/WhatSoup",
                head_repository="LucasQuiles/WhatSoup",
                base_sha=BASE,
                head_sha=HEAD,
                current_head_sha=HEAD,
            ),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            scanner = verified_scanner(temp_root / "scanner")
            baseline_path = temp_root / "base-baseline.json"
            baseline_path.write_text('{"schema_version":"1","findings":[]}', encoding="utf-8")
            baseline = verify_trusted_baseline(
                TrustedBaseline(
                    path=baseline_path,
                    base_sha=BASE,
                    sha256=hashlib.sha256(baseline_path.read_bytes()).hexdigest(),
                ),
                BASE,
            )
            plan = build_runner_plan(
                binding=binding,
                scanner=scanner,
                scan_root=Path("/private/tmp/scan-root"),
                trusted_home=Path("/private/tmp/scanner-home"),
                trusted_baseline=baseline,
                trusted_path="/usr/bin:/bin",
                candidate_paths=("--candidate.test.ts",),
                check_name="private-test-integrity",
            )

        separator = plan.command.index("--")
        self.assertEqual(plan.command[separator + 1:], (".private-scanner-root", "--candidate.test.ts"))

class ScannerExecutionSupervisionTests(unittest.TestCase):
    def _plan(self):
        return scanner_candidate.RunnerPlan(
            command=("/private/scanner/scripts/test-integrity", "baseline", "--check"),
            environment={
                "CLAUDE_PLUGIN_ROOT": "/private/scanner",
                "HOME": "/private/home",
                "PATH": "/usr/bin:/bin",
                "WHATSOUP_REQUIRE_TEST_INTEGRITY": "1",
            },
            cwd=Path("/private/candidate"),
            check_name="private-test-integrity",
            head_sha=HEAD,
        )

    def _run_with_owned_tmpdir(self, plan, popen, group, child_timeout=4, clock=None, sleep=None):
        with tempfile.TemporaryDirectory(prefix="private-scanner-run-") as scratch:
            with patch.dict(os.environ, {
                "TMPDIR": scratch,
                "SECRET": "must-not-reach-scanner",
                "SSH_AUTH_SOCK": "/private/agent.sock",
                "GIT_CONFIG_COUNT": "7",
            }, clear=True):
                return run_scanner_privately(
                    plan,
                    timeout_seconds=child_timeout,
                    popen=popen,
                    monotonic=clock or FakeClock(0),
                    killpg=group,
                    sleep=sleep or FakeSleep(),
                )

    def test_discards_output_and_passes_only_after_a_dead_process_group(self) -> None:
        plan = self._plan()
        child = FakeScannerChild(returncode=0)
        popen = FakeScannerPopen(child)
        group = FakeProcessGroup(alive=False)

        self.assertEqual(self._run_with_owned_tmpdir(plan, popen, group), plan.public_result("pass"))

        self.assertEqual(len(popen.calls), 1)
        argv, kwargs = popen.calls[0]
        self.assertEqual(argv, plan.command)
        self.assertEqual(kwargs["cwd"], plan.cwd)
        self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(kwargs["stdout"], subprocess.DEVNULL)
        self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
        self.assertFalse(kwargs["shell"])
        self.assertTrue(kwargs["close_fds"])
        self.assertTrue(kwargs["start_new_session"])
        environment = kwargs["env"]
        self.assertEqual(set(environment), {*plan.environment, "TMPDIR"})
        self.assertEqual({key: environment[key] for key in plan.environment}, dict(plan.environment))
        self.assertNotIn("SECRET", environment)
        self.assertNotIn("SSH_AUTH_SOCK", environment)
        self.assertNotIn("GIT_CONFIG_COUNT", environment)
        self.assertIn((child.pid, 0), group.calls)
        self.assertTrue(all(timeout is not None and 0 <= timeout <= 4 for timeout in child.wait_timeouts))

    def test_distinguishes_policy_findings_from_scanner_errors(self) -> None:
        plan = self._plan()
        cases = {
            "policy-findings": (1, "fail"),
            "malformed-baseline": (2, "inconclusive"),
            "missing-baseline": (3, "inconclusive"),
            "scanner-input-error": (4, "inconclusive"),
            "unknown-exit": (7, "inconclusive"),
            "missing-interpreter": (127, "inconclusive"),
            "signal-death": (-signal.SIGKILL, "inconclusive"),
        }
        for name, (returncode, conclusion) in cases.items():
            with self.subTest(name=name):
                child = FakeScannerChild(returncode=returncode)
                self.assertEqual(
                    self._run_with_owned_tmpdir(plan, FakeScannerPopen(child), FakeProcessGroup()),
                    plan.public_result(conclusion),
                )

    def test_timeout_kills_reaps_and_proves_group_absence(self) -> None:
        plan = self._plan()
        child = FakeScannerChild(outcomes=(subprocess.TimeoutExpired(plan.command, 4), 0))
        group = FakeProcessGroup(alive=True)
        sleeper = FakeSleep()

        self.assertEqual(
            self._run_with_owned_tmpdir(plan, FakeScannerPopen(child), group, sleep=sleeper),
            plan.public_result("inconclusive"),
        )

        self.assertTrue(any(pid == child.pid and operation != 0 for pid, operation in group.calls))
        self.assertIn((child.pid, 0), group.calls)
        self.assertTrue(all(timeout is not None and 0 <= timeout <= 4 for timeout in child.wait_timeouts))
        self.assertTrue(all(0 < duration <= 4 for duration in sleeper.calls))

    def test_surviving_group_after_zero_exit_is_inconclusive_and_reaped(self) -> None:
        plan = self._plan()
        child = FakeScannerChild(returncode=0)
        group = FakeProcessGroup(alive=True)

        self.assertEqual(
            self._run_with_owned_tmpdir(plan, FakeScannerPopen(child), group),
            plan.public_result("inconclusive"),
        )

        self.assertIn((child.pid, 0), group.calls)
        self.assertTrue(any(pid == child.pid and operation != 0 for pid, operation in group.calls))

    def test_spawn_or_cleanup_failure_is_sanitized_inconclusive(self) -> None:
        plan = self._plan()
        cases = {
            "spawn": (FakeScannerPopen(error=OSError("private spawn detail")), FakeProcessGroup()),
            "cleanup": (
                FakeScannerPopen(FakeScannerChild(outcomes=(subprocess.TimeoutExpired(plan.command, 4),))),
                FakeProcessGroup(alive=True, kill_error=OSError("private cleanup detail")),
            ),
        }
        for name, (popen, group) in cases.items():
            with self.subTest(name=name):
                self.assertEqual(
                    self._run_with_owned_tmpdir(plan, popen, group),
                    plan.public_result("inconclusive"),
                )

    def test_invalid_budget_refuses_before_spawn(self) -> None:
        plan = self._plan()
        for timeout_seconds in (True, False, 0, -1, 601, float("inf"), float("nan")):
            with self.subTest(timeout_seconds=timeout_seconds):
                popen = FakeScannerPopen(FakeScannerChild())
                with tempfile.TemporaryDirectory(prefix="private-scanner-run-") as scratch:
                    with patch.dict(os.environ, {"TMPDIR": scratch}, clear=True):
                        with self.assertRaises(BoundaryError):
                            run_scanner_privately(
                                plan,
                                timeout_seconds=timeout_seconds,
                                popen=popen,
                                monotonic=FakeClock(0),
                                killpg=FakeProcessGroup(),
                                sleep=FakeSleep(),
                            )
                self.assertEqual(popen.calls, [])

    def test_unavailable_tmpdir_is_inconclusive_without_spawn(self) -> None:
        plan = self._plan()
        for tmpdir in ("", "relative/tmp"):
            with self.subTest(tmpdir=tmpdir):
                popen = FakeScannerPopen(FakeScannerChild())
                with patch.dict(os.environ, {"TMPDIR": tmpdir}, clear=True):
                    self.assertEqual(
                        run_scanner_privately(
                            plan,
                            timeout_seconds=4,
                            popen=popen,
                            monotonic=FakeClock(0),
                            killpg=FakeProcessGroup(),
                            sleep=FakeSleep(),
                        ),
                        plan.public_result("inconclusive"),
                    )
                self.assertEqual(popen.calls, [])

    def test_symlink_tmpdir_is_inconclusive_without_spawn(self) -> None:
        plan = self._plan()
        popen = FakeScannerPopen(FakeScannerChild())
        with tempfile.TemporaryDirectory(prefix="private-scanner-run-") as temporary:
            root = Path(temporary) / "root"
            root.mkdir()
            linked = Path(temporary) / "linked"
            linked.symlink_to(root, target_is_directory=True)
            with patch.dict(os.environ, {"TMPDIR": str(linked)}, clear=True):
                self.assertEqual(
                    run_scanner_privately(
                        plan,
                        timeout_seconds=4,
                        popen=popen,
                        monotonic=FakeClock(0),
                        killpg=FakeProcessGroup(),
                        sleep=FakeSleep(),
                    ),
                    plan.public_result("inconclusive"),
                )
        self.assertEqual(popen.calls, [])

    def test_interrupt_reaps_then_reraises(self) -> None:
        plan = self._plan()
        for interrupt in (KeyboardInterrupt(), SystemExit()):
            with self.subTest(interrupt=type(interrupt).__name__):
                child = FakeScannerChild(outcomes=(interrupt, 0))
                group = FakeProcessGroup(alive=True)
                with self.assertRaises(type(interrupt)):
                    self._run_with_owned_tmpdir(plan, FakeScannerPopen(child), group)
                self.assertTrue(any(pid == child.pid and operation != 0 for pid, operation in group.calls))


    def test_cleanup_uses_remaining_total_budget_when_group_survives_kill(self) -> None:
        plan = self._plan()
        elapsed = [0.0]

        class DelayedChild(FakeScannerChild):
            def wait(self, timeout=None):
                self.wait_timeouts.append(timeout)
                if len(self.wait_timeouts) == 1:
                    elapsed[0] += timeout
                    raise subprocess.TimeoutExpired(plan.command, timeout)
                elapsed[0] += timeout / 2
                return 0

        class SurvivingGroup(FakeProcessGroup):
            def __call__(self, pid, operation):
                self.calls.append((pid, operation))

        child = DelayedChild()
        group = SurvivingGroup(alive=True)
        sleeps = []
        def advance(duration):
            sleeps.append(duration)
            elapsed[0] += duration

        self.assertEqual(
            self._run_with_owned_tmpdir(plan, FakeScannerPopen(child), group,
                child_timeout=1, clock=lambda: elapsed[0], sleep=advance),
            plan.public_result("inconclusive"),
        )
        self.assertEqual(len(child.wait_timeouts), 2)
        self.assertLess(child.wait_timeouts[0], 1)
        self.assertLessEqual(max(child.wait_timeouts), 1)
        self.assertLessEqual(elapsed[0], 1.000001)
        self.assertIn((child.pid, signal.SIGKILL), group.calls)
        self.assertTrue(sleeps)

    def test_expired_deadline_cannot_be_reported_as_pass(self) -> None:
        plan = self._plan()
        elapsed = [0.0]
        class LateChild(FakeScannerChild):
            def wait(self, timeout=None):
                self.wait_timeouts.append(timeout)
                elapsed[0] = 5.0
                return 0
        self.assertEqual(
            self._run_with_owned_tmpdir(plan, FakeScannerPopen(LateChild()),
                FakeProcessGroup(), child_timeout=1, clock=lambda: elapsed[0]),
            plan.public_result("inconclusive"),
        )
