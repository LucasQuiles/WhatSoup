"""Bind trusted workflow metadata to one current pull request."""

from __future__ import annotations

from collections.abc import Mapping as MappingABC, Sequence as SequenceABC
from dataclasses import dataclass
from typing import Mapping, Sequence

from private_scanner_candidate import (
    BoundaryError,
    PullRequestBinding,
    WorkflowRunBinding,
    verify_workflow_run_binding,
)


EXPECTED_REPOSITORY = "LucasQuiles/WhatSoup"
EXPECTED_WORKFLOW_NAME = "Quality"
EXPECTED_WORKFLOW_ID = 272306769
CHECK_NAME = "test-integrity (private)"


@dataclass(frozen=True)
class GitHubPublicationTarget:
    """The only public identity the later publisher may receive."""

    repository: str
    head_sha: str
    check_name: str


@dataclass(frozen=True)
class VerifiedGitHubBinding:
    """Private binding retained through the publication-time identity recheck."""

    repository: str
    base_sha: str
    head_sha: str
    pull_request_number: int
    workflow_run_id: int
    check_name: str

    def publication_target(self) -> GitHubPublicationTarget:
        return GitHubPublicationTarget(
            repository=self.repository,
            head_sha=self.head_sha,
            check_name=self.check_name,
        )


@dataclass(frozen=True)
class _PullRequestMetadata:
    number: int
    state: str
    base_repository: str
    base_sha: str
    base_ref: str
    head_repository: str
    head_sha: str


def _required_value(metadata: Mapping[str, object], key: str, label: str) -> object:
    if key not in metadata:
        raise BoundaryError(f"{label} is missing")
    return metadata[key]


def _required_mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, MappingABC):
        raise BoundaryError(f"{label} is malformed")
    return value


def _required_string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise BoundaryError(f"{label} is malformed")
    return value


def _required_positive_int(value: object, label: str) -> int:
    if type(value) is not int or value <= 0:
        raise BoundaryError(f"{label} is malformed")
    return value


def _repository_name(metadata: Mapping[str, object], label: str) -> str:
    return _required_string(_required_value(metadata, "full_name", label), label)


def _nested_repository_name(metadata: Mapping[str, object], label: str) -> str:
    repository = _required_mapping(_required_value(metadata, "repo", label), label)
    return _repository_name(repository, label)


def _parse_pull_request(metadata: Mapping[str, object]) -> _PullRequestMetadata:
    base = _required_mapping(_required_value(metadata, "base", "PR base"), "PR base")
    head = _required_mapping(_required_value(metadata, "head", "PR head"), "PR head")
    return _PullRequestMetadata(
        number=_required_positive_int(_required_value(metadata, "number", "PR number"), "PR number"),
        state=_required_string(_required_value(metadata, "state", "PR state"), "PR state"),
        base_repository=_nested_repository_name(base, "PR base repository"),
        base_sha=_required_string(_required_value(base, "sha", "PR base SHA"), "PR base SHA"),
        base_ref=_required_string(_required_value(base, "ref", "PR base ref"), "PR base ref"),
        head_repository=_nested_repository_name(head, "PR head repository"),
        head_sha=_required_string(_required_value(head, "sha", "PR head SHA"), "PR head SHA"),
    )


def _require_expected_repository(repository: str, label: str) -> None:
    if repository != EXPECTED_REPOSITORY:
        raise BoundaryError(f"{label} is not the expected repository")


def _require_equal_recheck(selected: _PullRequestMetadata, rechecked: _PullRequestMetadata) -> None:
    if selected.number != rechecked.number:
        raise BoundaryError("PR number changed before publication")
    if selected.state != rechecked.state:
        raise BoundaryError("PR state changed before publication")
    if selected.base_repository != rechecked.base_repository:
        raise BoundaryError("PR base repository changed before publication")
    if selected.base_sha != rechecked.base_sha:
        raise BoundaryError("PR base changed before publication")
    if selected.base_ref != rechecked.base_ref:
        raise BoundaryError("PR base ref changed before publication")
    if selected.head_repository != rechecked.head_repository:
        raise BoundaryError("PR head repository changed before publication")
    if selected.head_sha != rechecked.head_sha:
        raise BoundaryError("PR head changed before publication")


def bind_authenticated_quality_run(
    workflow_run: Mapping[str, object],
    current_pull_requests: Sequence[Mapping[str, object]],
    publication_recheck: Mapping[str, object],
    *,
    trusted_workflow_ref: str,
) -> VerifiedGitHubBinding:
    """Bind one current Quality PR run before private scanning or publication."""
    run = _required_mapping(workflow_run, "workflow run")
    if not isinstance(current_pull_requests, SequenceABC) or isinstance(current_pull_requests, (str, bytes)):
        raise BoundaryError("current PR response is malformed")
    if len(current_pull_requests) != 1:
        raise BoundaryError("workflow run does not identify exactly one current PR")

    selected = _parse_pull_request(_required_mapping(current_pull_requests[0], "current PR"))
    rechecked = _parse_pull_request(_required_mapping(publication_recheck, "publication PR recheck"))

    run_id = _required_positive_int(_required_value(run, "id", "workflow run id"), "workflow run id")
    workflow_id = _required_positive_int(
        _required_value(run, "workflow_id", "workflow run workflow id"),
        "workflow run workflow id",
    )
    run_name = _required_string(_required_value(run, "name", "workflow run name"), "workflow run name")
    run_event = _required_string(_required_value(run, "event", "workflow run event"), "workflow run event")
    run_status = _required_string(_required_value(run, "status", "workflow run status"), "workflow run status")
    run_head_sha = _required_string(_required_value(run, "head_sha", "workflow run head SHA"), "workflow run head SHA")
    run_repository = _repository_name(
        _required_mapping(_required_value(run, "repository", "workflow run repository"), "workflow run repository"),
        "workflow run repository",
    )
    run_head_repository = _repository_name(
        _required_mapping(_required_value(run, "head_repository", "workflow run head repository"), "workflow run head repository"),
        "workflow run head repository",
    )
    trusted_ref = _required_string(trusted_workflow_ref, "trusted workflow ref")

    if workflow_id != EXPECTED_WORKFLOW_ID or run_name != EXPECTED_WORKFLOW_NAME:
        raise BoundaryError("workflow run is not the trusted Quality workflow")
    # Quality supplies the trigger; its result does not substitute for this scan.
    if run_event != "pull_request" or run_status != "completed":
        raise BoundaryError("workflow run has an unsupported event or state")
    _require_expected_repository(run_repository, "workflow run repository")
    _require_expected_repository(run_head_repository, "workflow run head repository")
    _require_expected_repository(selected.base_repository, "PR base repository")
    _require_expected_repository(selected.head_repository, "PR head repository")
    _require_expected_repository(rechecked.base_repository, "publication PR base repository")
    _require_expected_repository(rechecked.head_repository, "publication PR head repository")
    if selected.state != "open" or rechecked.state != "open":
        raise BoundaryError("PR is not open")
    if selected.base_ref != "main" or rechecked.base_ref != "main":
        raise BoundaryError("PR base is not trusted main")
    if trusted_ref != "refs/heads/main":
        raise BoundaryError("workflow did not run from trusted main")
    _require_equal_recheck(selected, rechecked)

    verified = verify_workflow_run_binding(
        WorkflowRunBinding(
            repository=run_repository,
            head_sha=run_head_sha,
            trusted_workflow_ref=trusted_ref,
        ),
        PullRequestBinding(
            base_repository=selected.base_repository,
            head_repository=selected.head_repository,
            base_sha=selected.base_sha,
            head_sha=selected.head_sha,
            current_head_sha=rechecked.head_sha,
            default_branch=selected.base_ref,
        ),
    )
    return VerifiedGitHubBinding(
        repository=verified.repository,
        base_sha=verified.base_sha,
        head_sha=verified.head_sha,
        pull_request_number=selected.number,
        workflow_run_id=run_id,
        check_name=CHECK_NAME,
    )
