"""Deterministic RED contract for the trusted private-scanner GitHub binding.

The fixtures are API-shaped metadata only.  They perform no GitHub call and
contain no credential, scanner, or candidate source material.
"""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
import unittest


from private_scanner_candidate import BoundaryError  # noqa: E402
from github_binding import (  # noqa: E402
    CHECK_NAME,
    EXPECTED_REPOSITORY,
    EXPECTED_WORKFLOW_ID,
    EXPECTED_WORKFLOW_NAME,
    GitHubPublicationTarget,
    VerifiedGitHubBinding,
    bind_authenticated_quality_run,
)


BASE_SHA = "a" * 40
HEAD_SHA = "b" * 40
QUALITY_RUN_ID = 41752012595


def workflow_run() -> dict[str, object]:
    return {
        "id": QUALITY_RUN_ID,
        "workflow_id": EXPECTED_WORKFLOW_ID,
        "name": EXPECTED_WORKFLOW_NAME,
        "event": "pull_request",
        "status": "completed",
        "head_sha": HEAD_SHA,
        "repository": {"full_name": EXPECTED_REPOSITORY},
        "head_repository": {"full_name": EXPECTED_REPOSITORY},
    }


def current_pull_request() -> dict[str, object]:
    return {
        "number": 3874,
        "state": "open",
        "base": {
            "sha": BASE_SHA,
            "ref": "main",
            "repo": {"full_name": EXPECTED_REPOSITORY},
        },
        "head": {
            "sha": HEAD_SHA,
            "repo": {"full_name": EXPECTED_REPOSITORY},
        },
    }


class GitHubBindingTests(unittest.TestCase):
    def _bind(
        self,
        run: dict[str, object] | None = None,
        pull_requests: list[dict[str, object]] | None = None,
        *,
        publication_recheck: dict[str, object] | None = None,
        trusted_workflow_ref: str = "refs/heads/main",
    ) -> VerifiedGitHubBinding:
        return bind_authenticated_quality_run(
            workflow_run() if run is None else run,
            [current_pull_request()] if pull_requests is None else pull_requests,
            current_pull_request() if publication_recheck is None else publication_recheck,
            trusted_workflow_ref=trusted_workflow_ref,
        )

    def test_returns_complete_binding_and_derives_only_safe_publication_identity(self) -> None:
        self.assertEqual(
            self._bind(),
            VerifiedGitHubBinding(
                repository="LucasQuiles/WhatSoup",
                base_sha=BASE_SHA,
                head_sha=HEAD_SHA,
                pull_request_number=3874,
                workflow_run_id=QUALITY_RUN_ID,
                check_name=CHECK_NAME,
            ),
        )
        self.assertEqual(
            self._bind().publication_target(),
            GitHubPublicationTarget(
                repository="LucasQuiles/WhatSoup",
                head_sha=HEAD_SHA,
                check_name=CHECK_NAME,
            ),
        )

    def test_parent_quality_result_does_not_replace_the_independent_scan(self) -> None:
        for conclusion in ["success", "failure", "cancelled", "skipped"]:
            with self.subTest(conclusion=conclusion):
                run = workflow_run()
                run["conclusion"] = conclusion
                self.assertEqual(self._bind(run).head_sha, HEAD_SHA)

    def test_rejects_missing_malformed_and_boolean_ids(self) -> None:
        cases: dict[str, tuple[dict[str, object], list[dict[str, object]]]] = {}

        missing_run_id = workflow_run()
        del missing_run_id["id"]
        cases["missing-run-id"] = (missing_run_id, [current_pull_request()])

        boolean_run_id = workflow_run()
        boolean_run_id["id"] = True
        cases["boolean-run-id"] = (boolean_run_id, [current_pull_request()])

        string_workflow_id = workflow_run()
        string_workflow_id["workflow_id"] = str(EXPECTED_WORKFLOW_ID)
        cases["string-workflow-id"] = (string_workflow_id, [current_pull_request()])

        missing_head_sha = workflow_run()
        del missing_head_sha["head_sha"]
        cases["missing-run-head"] = (missing_head_sha, [current_pull_request()])

        non_string_run_head = workflow_run()
        non_string_run_head["head_sha"] = 42
        cases["non-string-run-head"] = (non_string_run_head, [current_pull_request()])

        boolean_pr_number = current_pull_request()
        boolean_pr_number["number"] = False
        cases["boolean-pr-number"] = (workflow_run(), [boolean_pr_number])

        missing_base_repository = current_pull_request()
        del missing_base_repository["base"]["repo"]  # type: ignore[index]
        cases["missing-base-repository"] = (workflow_run(), [missing_base_repository])

        missing_base_ref = current_pull_request()
        del missing_base_ref["base"]["ref"]  # type: ignore[index]
        cases["missing-base-ref"] = (workflow_run(), [missing_base_ref])

        boolean_base_sha = current_pull_request()
        boolean_base_sha["base"] = {
            "sha": True,
            "ref": "main",
            "repo": {"full_name": EXPECTED_REPOSITORY},
        }
        cases["boolean-base-sha"] = (workflow_run(), [boolean_base_sha])

        for name, (run, pull_requests) in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(BoundaryError):
                    self._bind(run, pull_requests)

    def test_rejects_wrong_run_identity_or_untrusted_ref(self) -> None:
        cases: dict[str, tuple[dict[str, object], str]] = {}

        wrong_name = workflow_run()
        wrong_name["name"] = "Candidate Quality"
        cases["wrong-name"] = (wrong_name, "refs/heads/main")

        wrong_workflow = workflow_run()
        wrong_workflow["workflow_id"] = EXPECTED_WORKFLOW_ID + 1
        cases["wrong-workflow-id"] = (wrong_workflow, "refs/heads/main")

        wrong_event = workflow_run()
        wrong_event["event"] = "push"
        cases["wrong-event"] = (wrong_event, "refs/heads/main")

        wrong_state = workflow_run()
        wrong_state["status"] = "in_progress"
        cases["wrong-state"] = (wrong_state, "refs/heads/main")

        wrong_repository = workflow_run()
        wrong_repository["repository"] = {"full_name": "LucasQuiles/other"}
        cases["wrong-repository"] = (wrong_repository, "refs/heads/main")

        wrong_head_repository = workflow_run()
        wrong_head_repository["head_repository"] = {"full_name": "LucasQuiles/other"}
        cases["wrong-head-repository"] = (wrong_head_repository, "refs/heads/main")

        cases["untrusted-workflow-ref"] = (workflow_run(), "refs/heads/candidate")

        non_main_base = current_pull_request()
        non_main_base["base"] = {
            "sha": BASE_SHA,
            "ref": "candidate-base",
            "repo": {"full_name": EXPECTED_REPOSITORY},
        }
        cases["non-main-base-ref"] = (workflow_run(), "refs/heads/main")

        for name, (run, trusted_ref) in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(BoundaryError):
                    self._bind(
                        run,
                        [non_main_base] if name == "non-main-base-ref" else None,
                        trusted_workflow_ref=trusted_ref,
                    )

    def test_rejects_empty_ambiguous_closed_and_fork_pr_candidates(self) -> None:
        closed = current_pull_request()
        closed["state"] = "closed"

        fork = current_pull_request()
        fork["head"] = {"sha": HEAD_SHA, "repo": {"full_name": "fork/WhatSoup"}}

        cases = {
            "no-current-pr": [],
            "ambiguous-current-prs": [current_pull_request(), deepcopy(current_pull_request())],
            "closed-pr": [closed],
            "fork-pr": [fork],
        }

        for name, pull_requests in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(BoundaryError):
                    self._bind(pull_requests=pull_requests)

    def test_rejects_stale_recheck_and_nonmatching_base_or_head(self) -> None:
        stale_current = current_pull_request()
        stale_current["head"] = {"sha": "c" * 40, "repo": {"full_name": EXPECTED_REPOSITORY}}

        changed_initial_base = current_pull_request()
        changed_initial_base["base"] = {
            "sha": "d" * 40,
            "ref": "main",
            "repo": {"full_name": "LucasQuiles/other"},
        }

        run_with_other_head = workflow_run()
        run_with_other_head["head_sha"] = "e" * 40

        recheck_changed_base_sha = current_pull_request()
        recheck_changed_base_sha["base"] = {
            "sha": "f" * 40,
            "ref": "main",
            "repo": {"full_name": EXPECTED_REPOSITORY},
        }

        recheck_changed_base_ref = current_pull_request()
        recheck_changed_base_ref["base"] = {
            "sha": BASE_SHA,
            "ref": "release",
            "repo": {"full_name": EXPECTED_REPOSITORY},
        }

        recheck_changed_pr_number = current_pull_request()
        recheck_changed_pr_number["number"] = 3875

        recheck_boolean_head = current_pull_request()
        recheck_boolean_head["head"] = {"sha": True, "repo": {"full_name": EXPECTED_REPOSITORY}}

        cases = {
            "stale-current-head": (workflow_run(), [stale_current], current_pull_request()),
            "wrong-base-repository": (workflow_run(), [changed_initial_base], current_pull_request()),
            "nonmatching-run-head": (run_with_other_head, [current_pull_request()], current_pull_request()),
            "recheck-changed-base-sha": (workflow_run(), [current_pull_request()], recheck_changed_base_sha),
            "recheck-changed-base-ref": (workflow_run(), [current_pull_request()], recheck_changed_base_ref),
            "recheck-changed-pr-number": (workflow_run(), [current_pull_request()], recheck_changed_pr_number),
            "recheck-boolean-head": (workflow_run(), [current_pull_request()], recheck_boolean_head),
        }

        for name, (run, pull_requests, publication_recheck) in cases.items():
            with self.subTest(name=name):
                with self.assertRaises(BoundaryError):
                    self._bind(run, pull_requests, publication_recheck=publication_recheck)


if __name__ == "__main__":
    unittest.main()
