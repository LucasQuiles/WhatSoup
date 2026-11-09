"""RED contract for one-shot private scanner check orchestration."""

from __future__ import annotations

from contextlib import contextmanager, nullcontext
import hashlib
import inspect
from pathlib import Path
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock


from github_binding import CHECK_NAME, EXPECTED_REPOSITORY, EXPECTED_WORKFLOW_ID  # noqa: E402
from private_check import CHECK_APP_ID, PrivateCheckResult, evaluate_non_pr_run, evaluate_run  # noqa: E402
from bounded_github import GitHubClient  # noqa: E402
import private_check  # noqa: E402
from private_bundle import GitLsTreeBlob, export_verified_bundle  # noqa: E402
from private_scanner_candidate import VerifiedScannerBundle  # noqa: E402
from test_candidate_scan import BASELINE, CANDIDATE, CANDIDATE_PATH, fixture_client  # noqa: E402


BASE_SHA = "a" * 40
HEAD_SHA = "b" * 40
RUN_ID = 41752012595
PR_NUMBER = 3874
CHECK_ID = 998877
RUN_ATTEMPT = 3
NON_PR_BASE_SHA = "c" * 40
TRUSTED_MAIN_SHA = "d" * 40
TAG_OBJECT_SHA = "e" * 40
SCANNER_RUN_ID = 51827462910
SCANNER_RUN_ATTEMPT = 2
SCANNER_ENTRYPOINT = "scripts/test-integrity"
SCANNER_SELECTOR = "scripts/test_integrity_core.py"
_SELECTOR_BYTES = b'''\
from pathlib import Path

def is_test_surface(path):
    if not isinstance(path, Path):
        raise RuntimeError("selector requires a concrete pathlib.Path")
    return path.as_posix().startswith("tests/") and path.suffix == ".ts"
'''
_SELECTOR_EXECUTION_MARKER = b'''\
from pathlib import Path
Path(__file__).with_name("unexpected-selector-execution").write_text("executed", encoding="utf-8")

def is_test_surface(path):
    return True
'''


def workflow_run(*, head_sha: object = HEAD_SHA, event: str = "pull_request") -> dict[str, object]:
    return {
        "id": RUN_ID,
        "workflow_id": EXPECTED_WORKFLOW_ID,
        "name": "Quality",
        "event": event,
        "status": "completed",
        "head_sha": head_sha,
        "repository": {"full_name": EXPECTED_REPOSITORY},
        "head_repository": {"full_name": EXPECTED_REPOSITORY},
    }


def non_pr_workflow_run(
    *,
    run_attempt: object = RUN_ATTEMPT,
    event: str = "push",
    head_branch: str = "v1.2.3",
) -> dict[str, object]:
    return {
        "id": RUN_ID,
        "run_attempt": run_attempt,
        "workflow_id": EXPECTED_WORKFLOW_ID,
        "name": "Quality",
        "path": ".github/workflows/quality.yml",
        "event": event,
        "status": "completed",
        "head_sha": HEAD_SHA,
        "head_branch": head_branch,
        "repository": {"full_name": EXPECTED_REPOSITORY},
        "head_repository": {"full_name": EXPECTED_REPOSITORY},
    }


def pull_request(
    *,
    number: int = PR_NUMBER,
    base_sha: object = BASE_SHA,
    base_ref: str = "main",
    head_sha: object = HEAD_SHA,
) -> dict[str, object]:
    return {
        "number": number,
        "state": "open",
        "base": {
            "sha": base_sha,
            "ref": base_ref,
            "repo": {"full_name": EXPECTED_REPOSITORY},
        },
        "head": {
            "sha": head_sha,
            "repo": {"full_name": EXPECTED_REPOSITORY},
        },
    }


def check_readback(
    *,
    check_id: int = CHECK_ID,
    head_sha: str = HEAD_SHA,
    name: str = CHECK_NAME,
    status: str = "completed",
    conclusion: str = "success",
    app_id: object = CHECK_APP_ID,
) -> dict[str, object]:
    return {
        "id": check_id,
        "name": name,
        "head_sha": head_sha,
        "status": status,
        "conclusion": conclusion,
        "app": {"id": app_id},
    }


class FakeClient:
    def __init__(self, responses: dict[str, list[object]], create_results: list[object] | None = None) -> None:
        self.responses = {path: list(values) for path, values in responses.items()}
        self.create_results = list(create_results or [{"id": CHECK_ID}])
        self.reads: list[str] = []
        self.created: list[dict[str, object]] = []

    def get_json(self, path: str) -> object:
        self.reads.append(path)
        values = self.responses.get(path)
        if not values:
            raise AssertionError(f"unexpected read {path}")
        result = values.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    def create_check(self, body: dict[str, object]) -> object:
        self.created.append(body)
        if not self.create_results:
            raise AssertionError("unexpected check creation")
        result = self.create_results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class CompositePrivateClient(FakeClient):
    """Use one fake for public admission and real candidate-input preparation."""

    def __init__(
        self,
        *,
        run: object | None = None,
        rechecked_pr: object | None = None,
        readback: object | None = None,
    ) -> None:
        admission = client_for(run=run, rechecked_pr=rechecked_pr, readback=readback)
        super().__init__(admission.responses, admission.create_results)
        self.git = fixture_client()
        self._pull_reads = 0
        self.before_recheck = None
        self.before_create = None

    def get_json(self, path: str) -> object:
        if path.startswith("git/"):
            return self.git.get_json(path)
        if path == current_pr_path():
            if self._pull_reads == 1 and self.before_recheck is not None:
                self.before_recheck()
            self._pull_reads += 1
        return super().get_json(path)

    def fetch_blob_batch(self, objects):
        return self.git.fetch_blob_batch(objects)

    def create_check(self, body: dict[str, object]) -> object:
        if self.before_create is not None:
            self.before_create()
        return super().create_check(body)


def run_path(run_id: int = RUN_ID) -> str:
    return f"actions/runs/{run_id}"


def associated_prs_path(head_sha: str = HEAD_SHA) -> str:
    return f"commits/{head_sha}/pulls?per_page=100"


def current_pr_path(number: int = PR_NUMBER) -> str:
    return f"pulls/{number}"


def check_path(check_id: int = CHECK_ID) -> str:
    return f"check-runs/{check_id}"


def git_blob_oid(content: bytes) -> str:
    return hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()


def scanner_files(selector_bytes: bytes = _SELECTOR_BYTES) -> dict[str, bytes]:
    return {
        SCANNER_ENTRYPOINT: b"#!/usr/bin/env python3\nraise SystemExit(0)\n",
        SCANNER_SELECTOR: selector_bytes,
        "rules/default.json": b'{"rules": []}\n',
    }


def verified_scanner(destination: Path, files: dict[str, bytes]) -> tuple[VerifiedScannerBundle, dict[str, str]]:
    manifest = {path: hashlib.sha256(content).hexdigest() for path, content in files.items()}
    entries = tuple(
        GitLsTreeBlob(
            path=path,
            mode="100644",
            object_type="blob",
            object_id=git_blob_oid(content),
            size=len(content),
        )
        for path, content in files.items()
    )
    blobs = {entry.object_id: files[entry.path] for entry in entries}
    scanner = export_verified_bundle(
        "c" * 40,
        "d" * 40,
        entries,
        blobs.__getitem__,
        destination,
        expected_commit="c" * 40,
        expected_tree="d" * 40,
        expected_manifest_digest=hashlib.sha256(
            "".join(f"{path}\0{digest}\n" for path, digest in sorted(manifest.items())).encode()
        ).hexdigest(),
        entrypoint=SCANNER_ENTRYPOINT,
        max_files=16,
        max_total_bytes=8192,
    )
    return scanner, manifest


def client_for(
    *,
    run: object | None = None,
    associated_prs: object | None = None,
    initial_pr: object | None = None,
    rechecked_pr: object | None = None,
    readback: object | None = None,
    create_results: list[object] | None = None,
) -> FakeClient:
    return FakeClient(
        {
            run_path(): [workflow_run() if run is None else run],
            associated_prs_path(): [[{"number": PR_NUMBER}] if associated_prs is None else associated_prs],
            current_pr_path(): [pull_request() if initial_pr is None else initial_pr, pull_request() if rechecked_pr is None else rechecked_pr],
            check_path(): [check_readback() if readback is None else readback],
        },
        create_results=create_results,
    )


def _git_ref(ref: str, object_type: str, sha: str) -> dict[str, object]:
    return {"ref": ref, "object": {"type": object_type, "sha": sha}}


def _tag_object(sha: str = HEAD_SHA) -> dict[str, object]:
    return {"sha": TAG_OBJECT_SHA, "object": {"type": "commit", "sha": sha}}


def _commit_with_parent(parent: str = NON_PR_BASE_SHA) -> dict[str, object]:
    return {"sha": HEAD_SHA, "parents": [{"sha": parent}]}


def _compare(merge_base: str = HEAD_SHA) -> dict[str, object]:
    return {"merge_base_commit": {"sha": merge_base}}


def non_pr_client(
    *,
    run: object | None = None,
    rechecked_run: object | None = None,
    tag_tip: str = HEAD_SHA,
    rechecked_tag_tip: str = HEAD_SHA,
    trusted_main: str = TRUSTED_MAIN_SHA,
    rechecked_main: str = TRUSTED_MAIN_SHA,
    merge_base: str = HEAD_SHA,
    rechecked_merge_base: str = HEAD_SHA,
    parent: str = NON_PR_BASE_SHA,
) -> FakeClient:
    client = FakeClient(
        {
            run_path(): [non_pr_workflow_run() if run is None else run,
                         non_pr_workflow_run() if rechecked_run is None else rechecked_run],
            "git/ref/heads/main": [
                _git_ref("refs/heads/main", "commit", trusted_main),
                _git_ref("refs/heads/main", "commit", rechecked_main),
            ],
            "git/ref/tags/v1.2.3": [
                _git_ref("refs/tags/v1.2.3", "tag", TAG_OBJECT_SHA),
                _git_ref("refs/tags/v1.2.3", "tag", TAG_OBJECT_SHA),
            ],
            f"git/tags/{TAG_OBJECT_SHA}": [_tag_object(tag_tip), _tag_object(rechecked_tag_tip)],
            f"git/commits/{HEAD_SHA}": [_commit_with_parent(parent), _commit_with_parent(parent)],
            f"compare/{HEAD_SHA}...{trusted_main}": [_compare(merge_base), _compare(rechecked_merge_base)],
        }
    )
    if rechecked_main != trusted_main:
        client.responses[f"compare/{HEAD_SHA}...{rechecked_main}"] = [_compare(rechecked_merge_base)]
    return client


class PrivateCheckTests(unittest.TestCase):
    def test_malformed_scanner_results_require_operator_action(self) -> None:
        for malformed in ([], {}, None, True, 0, "unexpected"):
            with self.subTest(result=repr(malformed)):
                client = client_for(readback=check_readback(conclusion="action_required"))
                result = evaluate_run(client, RUN_ID, "refs/heads/main", lambda _: malformed)
                self.assertEqual(result, PrivateCheckResult("inconclusive"))
                self.assertEqual(len(client.created), 1)
                self.assertEqual(client.created[0]["conclusion"], "action_required")

    def test_real_transport_publishes_only_the_scanner_result(self) -> None:
        for parent_conclusion in ("success", "failure", "cancelled", "skipped"):
            with self.subTest(parent_conclusion=parent_conclusion):
                parent = workflow_run()
                parent["conclusion"] = parent_conclusion
                responses = iter((parent, [{"number": PR_NUMBER}], pull_request(),
                                  pull_request(), {"id": CHECK_ID}, check_readback()))
                requests = []

                class Response(io.BytesIO):
                    headers = {"Content-Type": "application/json"}

                class Opener:
                    def open(self, request, *, timeout):
                        requests.append(request)
                        response = Response(json.dumps(next(responses)).encode())
                        response.status = 201 if request.method == "POST" else 200
                        return response

                client = GitHubClient("fixture-token", opener=Opener())
                result = evaluate_run(client, RUN_ID, "refs/heads/main", lambda _: "pass")
                self.assertEqual(result, PrivateCheckResult("pass"))
                self.assertEqual([request.method for request in requests],
                                 ["GET", "GET", "GET", "GET", "POST", "GET"])
                self.assertEqual([request.full_url for request in requests], [
                    "https://api.github.com/repos/LucasQuiles/WhatSoup/" + suffix
                    for suffix in (run_path(), associated_prs_path(), current_pr_path(),
                                   current_pr_path(), "check-runs", check_path())
                ])
                self.assertEqual(json.loads(requests[4].data), {
                    "name": CHECK_NAME, "head_sha": HEAD_SHA,
                    "status": "completed", "conclusion": "success",
                })

    def test_scan_conclusions_publish_once_and_return_only_after_matching_readback(self) -> None:
        cases = {
            "pass": ("success", "pass"),
            "fail": ("failure", "fail"),
            "inconclusive": ("action_required", "inconclusive"),
        }

        for scan_result, (api_conclusion, expected_result) in cases.items():
            with self.subTest(scan_result=scan_result):
                client = client_for(readback=check_readback(conclusion=api_conclusion))
                received = []

                result = evaluate_run(
                    client,
                    RUN_ID,
                    "refs/heads/main",
                    lambda binding: received.append(binding) or scan_result,
                )

                self.assertEqual(result, PrivateCheckResult(expected_result))
                self.assertEqual(len(received), 1)
                self.assertEqual(
                    client.created,
                    [
                        {
                            "name": CHECK_NAME,
                            "head_sha": HEAD_SHA,
                            "status": "completed",
                            "conclusion": api_conclusion,
                        },
                    ],
                )
                if scan_result == "inconclusive":
                    self.assertNotIn("success", client.created[0].values())
                    self.assertNotIn("neutral", client.created[0].values())
                    self.assertNotIn("skipped", client.created[0].values())

    def test_invalid_run_id_or_admission_metadata_prevents_scan_and_write(self) -> None:
        malformed_head = workflow_run(head_sha="../not-a-sha")
        wrong_event = workflow_run(event="push")
        cases = {
            "zero-run-id": (0, client_for()),
            "boolean-run-id": (True, client_for()),
            "malformed-head-before-path": (RUN_ID, client_for(run=malformed_head)),
            "wrong-event": (RUN_ID, client_for(run=wrong_event)),
            "ambiguous-associated-prs": (RUN_ID, client_for(associated_prs=[{"number": PR_NUMBER}, {"number": PR_NUMBER + 1}])),
        }

        for name, (run_id, client) in cases.items():
            with self.subTest(name=name):
                scans = []
                self.assertEqual(
                    evaluate_run(client, run_id, "refs/heads/main", lambda binding: scans.append(binding) or "pass"),
                    PrivateCheckResult("inconclusive"),
                )
                self.assertEqual(scans, [])
                self.assertEqual(client.created, [])
                if name in {"zero-run-id", "boolean-run-id"}:
                    self.assertEqual(client.reads, [])
                if name == "malformed-head-before-path":
                    self.assertEqual(client.reads, [run_path()])

    def test_recheck_base_or_head_drift_prevents_write_after_scan(self) -> None:
        changed_base = pull_request(base_sha="c" * 40)
        changed_head = pull_request(head_sha="d" * 40)

        for name, rechecked_pr in {"base": changed_base, "head": changed_head}.items():
            with self.subTest(name=name):
                client = client_for(rechecked_pr=rechecked_pr)
                scans = []
                result = evaluate_run(client, RUN_ID, "refs/heads/main", lambda binding: scans.append(binding) or "pass")
                self.assertEqual(result, PrivateCheckResult("inconclusive"))
                self.assertEqual(len(scans), 1)
                self.assertEqual(client.created, [])

    def test_scan_exception_is_sanitized_to_inconclusive_without_raw_message(self) -> None:
        client = client_for(readback=check_readback(conclusion="action_required"))

        def raising_scan(_binding):
            raise RuntimeError("private scanner rule and candidate path must not escape")

        result = evaluate_run(client, RUN_ID, "refs/heads/main", raising_scan)

        self.assertEqual(result, PrivateCheckResult("inconclusive"))
        self.assertNotIn("private scanner", repr(result))
        self.assertEqual(
            client.created,
            [
                {
                    "name": CHECK_NAME,
                    "head_sha": HEAD_SHA,
                    "status": "completed",
                    "conclusion": "action_required",
                },
            ],
        )

    def test_post_uncertainty_never_retries_or_falls_back_to_a_second_write(self) -> None:
        client = client_for(create_results=[RuntimeError("network uncertain after write")])

        result = evaluate_run(client, RUN_ID, "refs/heads/main", lambda _binding: "pass")

        self.assertEqual(result, PrivateCheckResult("inconclusive"))
        self.assertEqual(
            client.created,
            [
                {
                    "name": CHECK_NAME,
                    "head_sha": HEAD_SHA,
                    "status": "completed",
                    "conclusion": "success",
                },
            ],
        )
        self.assertNotIn(check_path(), client.reads)

    def test_mismatched_readback_never_reports_success(self) -> None:
        cases = {
            "wrong-app": check_readback(app_id=999),
            "wrong-head": check_readback(head_sha="e" * 40),
            "wrong-name": check_readback(name="other"),
            "wrong-id": check_readback(check_id=CHECK_ID + 1),
            "nonterminal": check_readback(status="queued"),
            "wrong-conclusion": check_readback(conclusion="failure"),
            "boolean-app-id": check_readback(app_id=True),
        }

        for name, readback in cases.items():
            with self.subTest(name=name):
                client = client_for(readback=readback)
                result = evaluate_run(client, RUN_ID, "refs/heads/main", lambda _binding: "pass")
                self.assertEqual(result, PrivateCheckResult("inconclusive"))
                self.assertEqual(len(client.created), 1)


class NonPRPrivateCheckTests(unittest.TestCase):
    def test_tag_remains_valid_when_main_advances_and_ancestry_is_reverified(self) -> None:
        with tempfile.TemporaryDirectory(prefix="non-pr-private-check-") as temporary:
            receipt = Path(temporary) / "receipt.json"
            advanced_main = "f" * 40
            client = non_pr_client(rechecked_main=advanced_main)
            result = evaluate_non_pr_run(
                client, RUN_ID, lambda _binding: "pass", receipt_path=receipt,
                scanner_run_id=SCANNER_RUN_ID, scanner_run_attempt=SCANNER_RUN_ATTEMPT,
            )
            self.assertEqual(result, PrivateCheckResult("pass"))
            self.assertEqual(json.loads(receipt.read_text(encoding="utf-8"))["head_sha"], HEAD_SHA)
            self.assertIn(f"compare/{HEAD_SHA}...{advanced_main}", client.reads)
            self.assertEqual(client.created, [])

    def test_tag_scan_uses_immutable_first_parent_and_writes_only_safe_receipt_after_recheck(self) -> None:
        with tempfile.TemporaryDirectory(prefix="non-pr-private-check-") as temporary:
            receipt = Path(temporary) / "receipt.json"
            client = non_pr_client()
            observed = []

            result = evaluate_non_pr_run(
                client,
                RUN_ID,
                lambda binding: observed.append(binding) or "pass",
                receipt_path=receipt,
                scanner_run_id=SCANNER_RUN_ID,
                scanner_run_attempt=SCANNER_RUN_ATTEMPT,
            )

            self.assertEqual(result, PrivateCheckResult("pass"))
            self.assertEqual(len(observed), 1)
            self.assertEqual(observed[0].base_sha, NON_PR_BASE_SHA)
            self.assertEqual(observed[0].head_sha, HEAD_SHA)
            self.assertEqual(observed[0].trusted_main_sha, TRUSTED_MAIN_SHA)
            self.assertEqual(observed[0].source_run_attempt, RUN_ATTEMPT)
            self.assertEqual(
                json.loads(receipt.read_text(encoding="utf-8")),
                {
                    "schema_version": 1,
                    "source_run_id": RUN_ID,
                    "source_run_attempt": RUN_ATTEMPT,
                    "head_sha": HEAD_SHA,
                    "conclusion": "pass",
                    "scanner_run_id": SCANNER_RUN_ID,
                    "scanner_run_attempt": SCANNER_RUN_ATTEMPT,
                },
            )
            self.assertEqual(client.created, [])

    def test_main_push_and_schedule_produce_the_same_safe_receipt(self) -> None:
        for event in ("push", "schedule"):
            with self.subTest(event=event), tempfile.TemporaryDirectory(prefix="non-pr-private-check-") as temporary:
                run = non_pr_workflow_run(event=event, head_branch="main")
                receipt = Path(temporary) / "receipt.json"
                result = evaluate_non_pr_run(
                    non_pr_client(
                        run=run,
                        rechecked_run=run,
                        trusted_main=HEAD_SHA,
                        rechecked_main=HEAD_SHA,
                    ),
                    RUN_ID,
                    lambda _binding: "pass",
                    receipt_path=receipt,
                    scanner_run_id=SCANNER_RUN_ID,
                    scanner_run_attempt=SCANNER_RUN_ATTEMPT,
                )
                self.assertEqual(result, PrivateCheckResult("pass"))
                self.assertEqual(json.loads(receipt.read_text(encoding="utf-8"))["conclusion"], "pass")

    def test_non_pr_metadata_tag_and_main_ancestry_fail_before_scan_or_receipt(self) -> None:
        wrong_event = non_pr_workflow_run(event="workflow_dispatch")
        wrong_repository = non_pr_workflow_run()
        wrong_repository["repository"] = {"full_name": "LucasQuiles/other"}
        wrong_workflow = non_pr_workflow_run()
        wrong_workflow["workflow_id"] = EXPECTED_WORKFLOW_ID + 1
        cases = {
            "wrong-event": non_pr_client(run=wrong_event),
            "wrong-repository": non_pr_client(run=wrong_repository),
            "wrong-workflow": non_pr_client(run=wrong_workflow),
            "tag-tip-mismatch": non_pr_client(tag_tip="f" * 40),
            "not-an-ancestor-of-main": non_pr_client(merge_base=NON_PR_BASE_SHA),
        }
        for label, client in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory(prefix="non-pr-private-check-") as temporary:
                receipt = Path(temporary) / "receipt.json"
                scans = []
                result = evaluate_non_pr_run(
                    client,
                    RUN_ID,
                    lambda binding: scans.append(binding) or "pass",
                    receipt_path=receipt,
                    scanner_run_id=SCANNER_RUN_ID,
                    scanner_run_attempt=SCANNER_RUN_ATTEMPT,
                )
                self.assertEqual(result, PrivateCheckResult("inconclusive"))
                self.assertEqual(scans, [])
                self.assertFalse(receipt.exists())
                self.assertEqual(client.created, [])

    def test_stale_source_attempt_or_ref_after_scan_prevents_receipt(self) -> None:
        stale_attempt = non_pr_workflow_run(run_attempt=RUN_ATTEMPT + 1)
        cases = {
            "run-attempt": non_pr_client(rechecked_run=stale_attempt),
            "tag-ref": non_pr_client(rechecked_tag_tip="f" * 40),
            "lost-main-ancestry": non_pr_client(rechecked_main="f" * 40, rechecked_merge_base=NON_PR_BASE_SHA),
        }
        for label, client in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory(prefix="non-pr-private-check-") as temporary:
                receipt = Path(temporary) / "receipt.json"
                scans = []
                result = evaluate_non_pr_run(
                    client,
                    RUN_ID,
                    lambda binding: scans.append(binding) or "pass",
                    receipt_path=receipt,
                    scanner_run_id=SCANNER_RUN_ID,
                    scanner_run_attempt=SCANNER_RUN_ATTEMPT,
                )
                self.assertEqual(result, PrivateCheckResult("inconclusive"))
                self.assertEqual(len(scans), 1)
                self.assertFalse(receipt.exists())

    def test_cleanup_exception_prevents_receipt_publication(self) -> None:
        with tempfile.TemporaryDirectory(prefix="non-pr-private-check-") as temporary:
            receipt = Path(temporary) / "receipt.json"

            def scan_with_cleanup_failure(_binding):
                try:
                    return "pass"
                finally:
                    raise OSError("private cleanup detail")

            result = evaluate_non_pr_run(
                non_pr_client(), RUN_ID, scan_with_cleanup_failure, receipt_path=receipt,
                scanner_run_id=SCANNER_RUN_ID,
                scanner_run_attempt=SCANNER_RUN_ATTEMPT,
            )
            self.assertEqual(result, PrivateCheckResult("inconclusive"))
            self.assertFalse(receipt.exists())


class PrivateCheckCompositionTests(unittest.TestCase):
    """RED contract for binding the verified private bundle into evaluate_run."""

    def _evaluate(
        self,
        client: CompositePrivateClient,
        scanner: VerifiedScannerBundle,
        manifest: dict[str, str],
        *,
        timeout_seconds: float = 30,
        runtime_check=None,
        scanner_bundle=None,
    ) -> PrivateCheckResult:
        evaluate_private_run = getattr(private_check, "evaluate_private_run", None)
        self.assertTrue(callable(evaluate_private_run), "private composed check is not implemented")
        self.assertIn("runtime_check", inspect.signature(evaluate_private_run).parameters)
        return evaluate_private_run(
            client,
            RUN_ID,
            "refs/heads/main",
            scanner_bundle or (lambda: nullcontext(scanner)),
            trusted_path="/usr/bin:/bin",
            timeout_seconds=timeout_seconds,
            runtime_check=runtime_check or (lambda _scanner, _binding, **kwargs: None),
        )

    def test_composes_verified_selector_inputs_native_result_and_public_transport(self) -> None:
        cases = {
            "pass": ("pass", "success"),
            "fail": ("fail", "failure"),
            "inconclusive": ("inconclusive", "action_required"),
        }
        for conclusion, (expected_result, expected_public) in cases.items():
            with self.subTest(conclusion=conclusion), tempfile.TemporaryDirectory(prefix="private-check-test-") as temporary:
                root = Path(temporary)
                runtime = root / "runtime"
                runtime.mkdir()
                scanner, manifest = verified_scanner(root / "scanner", scanner_files())
                client = CompositePrivateClient(readback=check_readback(conclusion=expected_public))
                observed = []

                def native(plan, *, timeout_seconds):
                    observed.append((plan, timeout_seconds))
                    self.assertEqual(timeout_seconds, 30)
                    self.assertEqual((plan.cwd / CANDIDATE_PATH).read_bytes(), CANDIDATE)
                    self.assertEqual((plan.cwd.parent / "baseline.json").read_bytes(), BASELINE)
                    self.assertEqual(
                        plan.environment,
                        {
                            "CLAUDE_PLUGIN_ROOT": str(scanner.bundle.root),
                            "HOME": str(plan.cwd.parent / "home"),
                            "PATH": "/usr/bin:/bin",
                            "WHATSOUP_REQUIRE_TEST_INTEGRITY": "1",
                            "PYTHONDONTWRITEBYTECODE": "1",
                            "PYTHONNOUSERSITE": "1",
                        },
                    )
                    return {
                        "check_name": CHECK_NAME,
                        "head_sha": HEAD_SHA,
                        "conclusion": conclusion,
                    }

                client.before_recheck = lambda: self.assertEqual(list(runtime.iterdir()), [])
                client.before_create = lambda: self.assertEqual(list(runtime.iterdir()), [])
                original_environment = dict(os.environ)
                with mock.patch.dict(os.environ, {"TMPDIR": str(runtime)}):
                    with mock.patch.object(private_check, "run_scanner_privately", side_effect=native, create=True):
                        result = self._evaluate(client, scanner, manifest)
                self.assertEqual(dict(os.environ), original_environment)
                self.assertEqual(result, PrivateCheckResult(expected_result))
                self.assertEqual(len(observed), 1)
                self.assertEqual(
                    client.created,
                    [{"name": CHECK_NAME, "head_sha": HEAD_SHA, "status": "completed", "conclusion": expected_public}],
                )
                self.assertEqual((client.git.batches[0][0][1]), len(CANDIDATE))

    def test_never_loads_private_selector_or_runs_scanner_before_current_admission(self) -> None:
        with tempfile.TemporaryDirectory(prefix="private-check-test-") as temporary:
            root = Path(temporary)
            scanner, manifest = verified_scanner(
                root / "scanner", scanner_files(_SELECTOR_EXECUTION_MARKER)
            )
            marker = scanner.bundle.root / "scripts/unexpected-selector-execution"
            client = CompositePrivateClient(run=workflow_run(head_sha="../untrusted"))
            runtime_check = mock.Mock()
            scanner_bundle = mock.Mock(side_effect=AssertionError("bundle acquired before admission"))
            with mock.patch.object(private_check, "run_scanner_privately", create=True) as native:
                result = self._evaluate(client, scanner, manifest, runtime_check=runtime_check, scanner_bundle=scanner_bundle)
            self.assertEqual(result, PrivateCheckResult("inconclusive"))
            self.assertFalse(marker.exists())
            native.assert_not_called()
            runtime_check.assert_not_called()
            scanner_bundle.assert_not_called()
            self.assertEqual(client.created, [])
            self.assertEqual(client.reads, [run_path()])

    def test_operational_bundle_and_native_failures_are_sanitized_inconclusive(self) -> None:
        cases = ("altered-bundle", "native-exception", "wrong-head", "wrong-check", "extra-field", "malformed", "invalid-conclusion")
        for label in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory(prefix="private-check-test-") as temporary:
                root = Path(temporary)
                runtime = root / "runtime"
                runtime.mkdir()
                scanner, manifest = verified_scanner(root / "scanner", scanner_files())
                if label == "altered-bundle":
                    (scanner.bundle.root / SCANNER_SELECTOR).write_bytes(b"raise RuntimeError('private altered bytes')\n")
                client = CompositePrivateClient(readback=check_readback(conclusion="action_required"))

                def native(plan, *, timeout_seconds):
                    if label == "native-exception":
                        raise RuntimeError("private scanner native detail")
                    result = {"check_name": CHECK_NAME, "head_sha": HEAD_SHA, "conclusion": "pass"}
                    if label == "wrong-head":
                        result["head_sha"] = "e" * 40
                    elif label == "wrong-check":
                        result["check_name"] = "private wrong check"
                    elif label == "extra-field":
                        result["private_detail"] = "must not escape"
                    elif label == "malformed":
                        return []
                    elif label == "invalid-conclusion":
                        result["conclusion"] = []
                    return result

                with mock.patch.dict(os.environ, {"TMPDIR": str(runtime)}):
                    with mock.patch.object(private_check, "run_scanner_privately", side_effect=native, create=True) as runner:
                        result = self._evaluate(client, scanner, manifest)
                self.assertEqual(result, PrivateCheckResult("inconclusive"))
                self.assertEqual(list(runtime.iterdir()), [])
                self.assertNotIn("private scanner native detail", repr(result))
                if label == "altered-bundle":
                    runner.assert_not_called()
                else:
                    runner.assert_called_once()
                self.assertEqual(
                    client.created,
                    [{"name": CHECK_NAME, "head_sha": HEAD_SHA, "status": "completed", "conclusion": "action_required"}],
                )

    def test_missing_or_linked_tmpdir_is_inconclusive_without_native_execution(self) -> None:
        for label in ("missing", "symlink"):
            with self.subTest(label=label), tempfile.TemporaryDirectory(prefix="private-check-test-") as temporary:
                root = Path(temporary)
                scanner, manifest = verified_scanner(root / "scanner", scanner_files())
                client = CompositePrivateClient(readback=check_readback(conclusion="action_required"))
                if label == "symlink":
                    target = root / "runtime-target"
                    target.mkdir()
                    tmpdir = root / "runtime-alias"
                    tmpdir.symlink_to(target, target_is_directory=True)
                    environment = {"TMPDIR": str(tmpdir)}
                else:
                    environment = {"TMPDIR": ""}
                with mock.patch.dict(os.environ, environment):
                    with mock.patch.object(private_check, "run_scanner_privately", create=True) as native:
                        result = self._evaluate(client, scanner, manifest)
                self.assertEqual(result, PrivateCheckResult("inconclusive"))
                native.assert_not_called()
                self.assertEqual(
                    client.created,
                    [{"name": CHECK_NAME, "head_sha": HEAD_SHA, "status": "completed", "conclusion": "action_required"}],
                )

    def test_recheck_drift_never_publishes_after_owned_scan_scratch_is_removed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="private-check-test-") as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            runtime.mkdir()
            scanner, manifest = verified_scanner(root / "scanner", scanner_files())
            client = CompositePrivateClient(rechecked_pr=pull_request(head_sha="e" * 40))
            client.before_recheck = lambda: self.assertEqual(list(runtime.iterdir()), [])

            def native(plan, *, timeout_seconds):
                return {"check_name": plan.check_name, "head_sha": plan.head_sha, "conclusion": "pass"}

            with mock.patch.dict(os.environ, {"TMPDIR": str(runtime)}):
                with mock.patch.object(private_check, "run_scanner_privately", side_effect=native, create=True) as runner:
                    result = self._evaluate(client, scanner, manifest)
            self.assertEqual(result, PrivateCheckResult("inconclusive"))
            runner.assert_called_once()
            self.assertEqual(client.created, [])

    def test_runtime_refusal_prevents_selector_import_and_scan(self) -> None:
        with tempfile.TemporaryDirectory(prefix="private-check-test-") as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            runtime.mkdir()
            scanner, manifest = verified_scanner(root / "scanner", scanner_files(_SELECTOR_EXECUTION_MARKER))
            client = CompositePrivateClient(readback=check_readback(conclusion="action_required"))
            runtime_check = mock.Mock(side_effect=RuntimeError("private runtime diagnostic"))
            with mock.patch.dict(os.environ, {"TMPDIR": str(runtime)}):
                with mock.patch.object(private_check, "run_scanner_privately") as native:
                    result = self._evaluate(client, scanner, manifest, runtime_check=runtime_check)
            runtime_check.assert_called_once()
            self.assertIs(runtime_check.call_args.args[0], scanner)
            self.assertEqual(runtime_check.call_args.args[1].head_sha, HEAD_SHA)
            self.assertEqual(runtime_check.call_args.kwargs, {"trusted_path": "/usr/bin:/bin"})
            native.assert_not_called()
            self.assertFalse((scanner.bundle.root / "scripts/unexpected-selector-execution").exists())
            self.assertEqual(result, PrivateCheckResult("inconclusive"))
            self.assertEqual(client.created[0]["conclusion"], "action_required")
            self.assertEqual(list(runtime.iterdir()), [])

    def test_cleanup_failure_cannot_publish_a_successful_scan(self) -> None:
        class CleanupFailure(tempfile.TemporaryDirectory):
            def __exit__(self, *args):
                super().__exit__(*args)
                raise OSError("private cleanup failure")

        with tempfile.TemporaryDirectory(prefix="private-check-test-") as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            runtime.mkdir()
            scanner, manifest = verified_scanner(root / "scanner", scanner_files())
            client = CompositePrivateClient(readback=check_readback(conclusion="action_required"))
            with mock.patch.dict(os.environ, {"TMPDIR": str(runtime)}):
                with mock.patch("tempfile.TemporaryDirectory", CleanupFailure):
                    with mock.patch.object(private_check, "run_scanner_privately", create=True) as runner:
                        runner.return_value = {"check_name": CHECK_NAME, "head_sha": HEAD_SHA, "conclusion": "pass"}
                        result = self._evaluate(client, scanner, manifest)
            runner.assert_called_once()
            self.assertEqual(result, PrivateCheckResult("inconclusive"))
            self.assertEqual(list(runtime.iterdir()), [])
            self.assertEqual(client.created, [{
                "name": CHECK_NAME, "head_sha": HEAD_SHA,
                "status": "completed", "conclusion": "action_required",
            }])

    def test_bundle_cleanup_precedes_recheck_and_failure_cannot_publish_success(self) -> None:
        for fail_cleanup in (False, True):
            with self.subTest(fail_cleanup=fail_cleanup), tempfile.TemporaryDirectory(prefix="bundle-lifetime-") as temporary:
                root = Path(temporary)
                runtime = root / "runtime"
                runtime.mkdir()
                scanner, manifest = verified_scanner(root / "scanner", scanner_files())
                closed = []

                @contextmanager
                def scanner_bundle():
                    yield scanner
                    closed.append(True)
                    if fail_cleanup:
                        raise OSError("private bundle cleanup failed")

                conclusion = "action_required" if fail_cleanup else "success"
                client = CompositePrivateClient(readback=check_readback(conclusion=conclusion))
                client.before_recheck = lambda: self.assertEqual(closed, [True])
                with mock.patch.dict(os.environ, {"TMPDIR": str(runtime)}), mock.patch.object(private_check, "run_scanner_privately") as native:
                    native.return_value = {"check_name": CHECK_NAME, "head_sha": HEAD_SHA, "conclusion": "pass"}
                    result = self._evaluate(client, scanner, manifest, scanner_bundle=scanner_bundle)
                native.assert_called_once()
                self.assertEqual(closed, [True])
                self.assertEqual(result.conclusion, "inconclusive" if fail_cleanup else "pass")
                self.assertEqual([row["conclusion"] for row in client.created], [conclusion])


if __name__ == "__main__":
    unittest.main()
