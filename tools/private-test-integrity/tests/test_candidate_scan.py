"""RED contract for Git-addressed candidate scan input preparation."""

from __future__ import annotations

import base64
from dataclasses import replace
import hashlib
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch


from candidate_scan import prepare_scan_inputs  # noqa: E402
from github_binding import CHECK_NAME, EXPECTED_REPOSITORY, VerifiedGitHubBinding  # noqa: E402
from private_scanner_candidate import BoundaryError, TrustedScannerBundle, VerifiedScannerBundle, decode_github_blob  # noqa: E402


BASE_SHA = "a" * 40
HEAD_SHA = "b" * 40
BASE_TREE = "c" * 40
HEAD_TREE = "d" * 40
BASELINE_PATH = ".claude/test-integrity/baseline.json"
CANDIDATE_PATH = "tests/core/candidate.test.ts"
HEAD_CONTROL = b'{"head": true}\n'
BASELINE = b'{"base": true}\n'
CANDIDATE = b"import { test } from 'vitest';\ntest('candidate', () => {});\n"


def git_blob_oid(content: bytes) -> str:
    return hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()


def tree_entry(path: str, content: bytes, *, mode: str = "100644", object_type: str = "blob") -> dict[str, object]:
    return {
        "path": path,
        "mode": mode,
        "type": object_type,
        "sha": git_blob_oid(content),
        "size": len(content),
    }


def blob_response(content: bytes, *, object_id: str | None = None, size: int | None = None) -> dict[str, object]:
    return {
        "sha": git_blob_oid(content) if object_id is None else object_id,
        "size": len(content) if size is None else size,
        "encoding": "base64",
        "content": base64.b64encode(content).decode("ascii"),
    }


def commit_response(commit: str, tree: str) -> dict[str, object]:
    return {"sha": commit, "tree": {"sha": tree}}


def tree_response(tree: str, entries: list[dict[str, object]], *, truncated: bool = False) -> dict[str, object]:
    return {"sha": tree, "truncated": truncated, "tree": entries}


def binding() -> VerifiedGitHubBinding:
    return VerifiedGitHubBinding(
        repository=EXPECTED_REPOSITORY,
        base_sha=BASE_SHA,
        head_sha=HEAD_SHA,
        pull_request_number=3874,
        workflow_run_id=41752012595,
        check_name=CHECK_NAME,
    )


class FakeGitHubClient:
    def __init__(self, responses: dict[str, object]) -> None:
        self.responses = dict(responses)
        self.requests: list[str] = []
        self.batches: list[tuple[tuple[str, int], ...]] = []

    def fetch_blob_batch(self, objects):
        self.batches.append(objects)
        return {oid: decode_github_blob(oid, size, self.responses[f"git/blobs/{oid}"], max_blob_bytes=1_000_000)
                for oid, size in objects}

    def get_json(self, path: str) -> object:
        self.requests.append(path)
        if path not in self.responses:
            raise AssertionError(f"unexpected Git request {path}")
        response = self.responses[path]
        if isinstance(response, Exception):
            raise response
        return response


def fixture_client(
    *,
    head_commit: object | None = None,
    base_commit: object | None = None,
    head_tree: object | None = None,
    base_tree: object | None = None,
    blobs: dict[str, object] | None = None,
) -> FakeGitHubClient:
    candidate_entry = tree_entry(CANDIDATE_PATH, CANDIDATE)
    head_control_entry = tree_entry(BASELINE_PATH, HEAD_CONTROL)
    base_entry = tree_entry(BASELINE_PATH, BASELINE)
    responses: dict[str, object] = {
        f"git/commits/{HEAD_SHA}": commit_response(HEAD_SHA, HEAD_TREE) if head_commit is None else head_commit,
        f"git/commits/{BASE_SHA}": commit_response(BASE_SHA, BASE_TREE) if base_commit is None else base_commit,
        f"git/trees/{HEAD_TREE}?recursive=1": tree_response(HEAD_TREE, [candidate_entry, head_control_entry]) if head_tree is None else head_tree,
        f"git/trees/{BASE_TREE}?recursive=1": tree_response(BASE_TREE, [base_entry]) if base_tree is None else base_tree,
        f"git/blobs/{candidate_entry['sha']}": blob_response(CANDIDATE),
        f"git/blobs/{base_entry['sha']}": blob_response(BASELINE),
    }
    if blobs:
        responses.update(blobs)
    return FakeGitHubClient(responses)


def scanner(root: Path) -> VerifiedScannerBundle:
    scanner_root = root / "verified-scanner"
    return VerifiedScannerBundle(
        bundle=TrustedScannerBundle(
            root=scanner_root,
            entrypoint=scanner_root / "scripts/test-integrity",
            manifest_digest="e" * 64,
        ),
        manifest={},
    )


def select_tests(path) -> bool:
    return path.as_posix().startswith("tests/") and path.suffix == ".ts"


class CandidateScanTests(unittest.TestCase):
    def _prepare(self, scratch: Path, client: FakeGitHubClient):
        return prepare_scan_inputs(client, binding(), scanner(scratch), select_tests, scratch, "/usr/bin:/bin")

    def test_builds_plan_from_exact_head_tests_and_base_baseline_with_private_paths(self) -> None:
        client = fixture_client()
        with tempfile.TemporaryDirectory(prefix="candidate-scan-test-") as temporary:
            scratch = Path(temporary)
            plan = self._prepare(scratch, client)

            candidate_root = scratch / "candidate"
            baseline = scratch / "baseline.json"
            home = scratch / "home"
            self.assertEqual(plan.cwd, candidate_root)
            self.assertEqual(plan.head_sha, HEAD_SHA)
            self.assertEqual(plan.check_name, CHECK_NAME)
            self.assertEqual(plan.environment["HOME"], str(home))
            self.assertEqual(plan.environment["PATH"], "/usr/bin:/bin")
            self.assertEqual(plan.command[-2:], (".private-scanner-root", CANDIDATE_PATH))
            self.assertIn(str(baseline), plan.command)
            self.assertEqual((candidate_root / CANDIDATE_PATH).read_bytes(), CANDIDATE)
            self.assertFalse((candidate_root / BASELINE_PATH).exists())
            self.assertEqual(baseline.read_bytes(), BASELINE)
            self.assertEqual(stat.S_IMODE(candidate_root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(home.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((candidate_root / CANDIDATE_PATH).stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(baseline.stat().st_mode), 0o600)
            self.assertEqual(client.batches, [((git_blob_oid(CANDIDATE), len(CANDIDATE)),)])
            self.assertNotIn(f"git/blobs/{git_blob_oid(CANDIDATE)}", client.requests)
            self.assertIn(f"git/blobs/{git_blob_oid(BASELINE)}", client.requests)
            self.assertNotIn(f"git/blobs/{git_blob_oid(HEAD_CONTROL)}", client.requests)
            self.assertIn(f"git/commits/{HEAD_SHA}", client.requests)
            self.assertIn(f"git/commits/{BASE_SHA}", client.requests)
            self.assertIn(f"git/trees/{HEAD_TREE}?recursive=1", client.requests)
            self.assertIn(f"git/trees/{BASE_TREE}?recursive=1", client.requests)

    def test_rejects_unbound_commit_tree_and_truncation_before_plan(self) -> None:
        cases = {
            "wrong-head-commit": fixture_client(head_commit=commit_response("e" * 40, HEAD_TREE)),
            "wrong-base-commit": fixture_client(base_commit=commit_response("e" * 40, BASE_TREE)),
            "wrong-head-tree": fixture_client(head_tree=tree_response("e" * 40, [tree_entry(CANDIDATE_PATH, CANDIDATE)])),
            "wrong-base-tree": fixture_client(base_tree=tree_response("e" * 40, [tree_entry(BASELINE_PATH, BASELINE)])),
            "truncated-head-tree": fixture_client(head_tree=tree_response(HEAD_TREE, [], truncated=True)),
            "truncated-base-tree": fixture_client(base_tree=tree_response(BASE_TREE, [], truncated=True)),
        }
        for label, client in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory(prefix="candidate-scan-test-") as temporary:
                scratch = Path(temporary)
                with self.assertRaises(BoundaryError):
                    self._prepare(scratch, client)
                self.assertEqual(list(scratch.iterdir()), [])

    def test_rejects_head_control_as_a_base_baseline_substitute(self) -> None:
        client = fixture_client(base_tree=tree_response(BASE_TREE, []))
        with tempfile.TemporaryDirectory(prefix="candidate-scan-test-") as temporary:
            scratch = Path(temporary)
            with self.assertRaises(BoundaryError):
                self._prepare(scratch, client)
            self.assertEqual(list(scratch.iterdir()), [])
            self.assertNotIn(f"git/blobs/{git_blob_oid(HEAD_CONTROL)}", client.requests)

    def test_rejects_nonregular_oversized_or_malformed_git_data_before_plan(self) -> None:
        oversized = tree_entry(CANDIDATE_PATH, CANDIDATE)
        oversized["size"] = 1_000_001
        symlink = tree_entry("tests/core/link.test.ts", b"target", mode="120000")
        base_symlink = tree_entry(BASELINE_PATH, b"target", mode="120000")
        oversized_baseline = tree_entry(BASELINE_PATH, BASELINE)
        oversized_baseline["size"] = 1_000_001
        baseline_entry = tree_entry(BASELINE_PATH, BASELINE)
        cases = {
            "head-symlink": fixture_client(head_tree=tree_response(HEAD_TREE, [symlink])),
            "head-oversized": fixture_client(head_tree=tree_response(HEAD_TREE, [oversized])),
            "base-symlink": fixture_client(base_tree=tree_response(BASE_TREE, [base_symlink])),
            "base-oversized": fixture_client(base_tree=tree_response(BASE_TREE, [oversized_baseline])),
            "malformed-base-blob": fixture_client(
                blobs={f"git/blobs/{baseline_entry['sha']}": blob_response(BASELINE, object_id="f" * 40)}
            ),
        }
        for label, client in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory(prefix="candidate-scan-test-") as temporary:
                scratch = Path(temporary)
                with self.assertRaises(BoundaryError):
                    self._prepare(scratch, client)
                self.assertEqual(list(scratch.iterdir()), [])

    def test_rejects_nonfresh_scratch_before_any_git_request(self) -> None:
        client = fixture_client()
        with tempfile.TemporaryDirectory(prefix="candidate-scan-test-") as temporary:
            scratch = Path(temporary)
            (scratch / "prior").write_text("retain", encoding="utf-8")
            with self.assertRaises(BoundaryError):
                self._prepare(scratch, client)
            self.assertEqual(client.requests, [])
            self.assertEqual((scratch / "prior").read_text(encoding="utf-8"), "retain")

    def test_batches_selected_tests_by_object_count_and_deduplicates_identical_content(self):
        entries = [tree_entry(f"tests/{i}.ts", f"test data {i}".encode()) for i in range(161)]
        entries.append(tree_entry("tests/duplicate.ts", b"test data 0"))
        client = fixture_client(head_tree=tree_response(HEAD_TREE, entries))
        for i in range(161):
            content = f"test data {i}".encode()
            client.responses[f"git/blobs/{git_blob_oid(content)}"] = blob_response(content)
        with tempfile.TemporaryDirectory(prefix="candidate-scan-test-") as temporary:
            scratch = Path(temporary)
            self._prepare(scratch, client)
            self.assertEqual([len(batch) for batch in client.batches], [80, 80, 1])
            self.assertEqual((scratch / "candidate/tests/duplicate.ts").read_bytes(), b"test data 0")
            self.assertEqual([path for path in client.requests if path.startswith("git/blobs/")],
                             [f"git/blobs/{git_blob_oid(BASELINE)}"])

    def test_batches_by_expected_bytes_and_rejects_extra_or_missing_results(self):
        contents = [bytes([65 + i]) * 800_000 for i in range(3)]
        entries = [tree_entry(f"tests/{i}.ts", content) for i, content in enumerate(contents)]
        client = fixture_client(head_tree=tree_response(HEAD_TREE, entries))
        for content in contents:
            client.responses[f"git/blobs/{git_blob_oid(content)}"] = blob_response(content)
        with tempfile.TemporaryDirectory(prefix="candidate-scan-test-") as temporary:
            self._prepare(Path(temporary), client)
            self.assertEqual([sum(size for _, size in batch) for batch in client.batches], [1_600_000, 800_000])
        for result in [{}, {git_blob_oid(CANDIDATE): CANDIDATE, "f" * 40: b"extra"},
                       {git_blob_oid(CANDIDATE): b"wrong bytes"}]:
            with self.subTest(result_keys=list(result)), tempfile.TemporaryDirectory(prefix="candidate-scan-test-") as temporary:
                client = fixture_client()
                client.fetch_blob_batch = lambda _objects: result
                with self.assertRaises(BoundaryError):
                    self._prepare(Path(temporary), client)
                self.assertEqual(list(Path(temporary).iterdir()), [])

    def test_late_invalid_tree_entry_prevents_any_batch(self):
        entries = [tree_entry(CANDIDATE_PATH, CANDIDATE), tree_entry("bad/link", b"target", mode="120000")]
        client = fixture_client(head_tree=tree_response(HEAD_TREE, entries))
        with tempfile.TemporaryDirectory(prefix="candidate-scan-test-") as temporary:
            with self.assertRaises(BoundaryError):
                self._prepare(Path(temporary), client)
            self.assertEqual(client.batches, [])

    def test_rejects_wrong_repository_or_check_binding_before_requests(self):
        for changed in [replace(binding(), repository="other/repository"), replace(binding(), check_name="other check")]:
            with self.subTest(binding=changed), tempfile.TemporaryDirectory(prefix="candidate-scan-test-") as temporary:
                scratch = Path(temporary)
                client = fixture_client()
                with self.assertRaises(BoundaryError):
                    prepare_scan_inputs(client, changed, scanner(scratch), select_tests, scratch, "/usr/bin:/bin")
                self.assertEqual(client.requests, [])
                self.assertEqual(client.batches, [])

    def test_post_materialization_plan_failure_removes_owned_outputs(self):
        with tempfile.TemporaryDirectory(prefix="candidate-scan-test-") as temporary:
            scratch = Path(temporary)
            def reject_plan(**_kwargs):
                self.assertTrue((scratch / "candidate" / CANDIDATE_PATH).exists())
                self.assertTrue((scratch / "baseline.json").exists())
                raise BoundaryError("injected plan refusal")
            with patch("candidate_scan.build_runner_plan", side_effect=reject_plan), self.assertRaises(BoundaryError):
                self._prepare(scratch, fixture_client())
            self.assertEqual(list(scratch.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
