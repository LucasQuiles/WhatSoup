"""One-shot, fail-closed orchestration for a trusted private scanner check."""

from __future__ import annotations

from collections.abc import Mapping as MappingABC
from dataclasses import dataclass
import os
from pathlib import Path
import re
import tempfile
from typing import Callable, ContextManager

from bounded_github import GitHubClient
from candidate_scan import prepare_scan_inputs
from github_binding import CHECK_NAME, VerifiedGitHubBinding, bind_authenticated_quality_run
from private_bundle import load_verified_selector
from private_scanner_candidate import BoundaryError, VerifiedScannerBundle, run_scanner_privately


CHECK_APP_ID = 15368
_FULL_SHA = re.compile(r"[0-9a-f]{40}")


@dataclass(frozen=True)
class PrivateCheckResult:
    conclusion: str


def _inconclusive() -> PrivateCheckResult:
    return PrivateCheckResult(conclusion="inconclusive")


def _positive_int(value: object) -> int | None:
    if type(value) is int and value > 0:
        return value
    return None


def _full_sha(value: object) -> str | None:
    if isinstance(value, str) and _FULL_SHA.fullmatch(value):
        return value
    return None


def _mapping(value: object) -> MappingABC[str, object] | None:
    if isinstance(value, MappingABC):
        return value
    return None


def _check_readback_matches(
    readback: object,
    *,
    check_id: int,
    head_sha: str,
    conclusion: str,
) -> bool:
    response = _mapping(readback)
    if response is None:
        return False
    app = _mapping(response.get("app"))
    return (
        _positive_int(response.get("id")) == check_id
        and response.get("name") == CHECK_NAME
        and response.get("head_sha") == head_sha
        and response.get("status") == "completed"
        and response.get("conclusion") == conclusion
        and app is not None
        and type(app.get("id")) is int
        and app["id"] == CHECK_APP_ID
    )


def evaluate_run(
    client: GitHubClient,
    run_id: int,
    trusted_workflow_ref: str,
    scan: Callable[[VerifiedGitHubBinding], str],
) -> PrivateCheckResult:
    """Bind, scan, rebind, publish once, and require an exact readback."""
    verified_run_id = _positive_int(run_id)
    if verified_run_id is None:
        return _inconclusive()

    try:
        workflow_run = _mapping(client.get_json(f"actions/runs/{verified_run_id}"))
    except Exception:
        return _inconclusive()
    if workflow_run is None:
        return _inconclusive()

    # Do not put unvalidated API data into a repository-relative request path.
    run_head_sha = _full_sha(workflow_run.get("head_sha"))
    if run_head_sha is None:
        return _inconclusive()
    try:
        associations = client.get_json(f"commits/{run_head_sha}/pulls?per_page=100")
    except Exception:
        return _inconclusive()
    if not isinstance(associations, list) or len(associations) != 1:
        return _inconclusive()
    associated = _mapping(associations[0])
    if associated is None:
        return _inconclusive()
    pull_number = _positive_int(associated.get("number"))
    if pull_number is None:
        return _inconclusive()

    try:
        initial_pull_request = _mapping(client.get_json(f"pulls/{pull_number}"))
    except Exception:
        return _inconclusive()
    if initial_pull_request is None:
        return _inconclusive()
    try:
        initial_binding = bind_authenticated_quality_run(
            workflow_run,
            [initial_pull_request],
            initial_pull_request,
            trusted_workflow_ref=trusted_workflow_ref,
        )
    except Exception:
        return _inconclusive()
    if (
        initial_binding.pull_request_number != pull_number
        or initial_binding.workflow_run_id != verified_run_id
    ):
        return _inconclusive()

    try:
        scan_result = scan(initial_binding)
    except Exception:
        scan_result = "inconclusive"
    conclusions = {
        "pass": "success",
        "fail": "failure",
        "inconclusive": "action_required",
    }
    if type(scan_result) is not str:
        scan_result = "inconclusive"
    public_conclusion = conclusions.get(scan_result, "action_required")
    result_conclusion = scan_result if scan_result in conclusions else "inconclusive"

    try:
        rechecked_pull_request = _mapping(client.get_json(f"pulls/{pull_number}"))
    except Exception:
        return _inconclusive()
    if rechecked_pull_request is None:
        return _inconclusive()
    try:
        binding = bind_authenticated_quality_run(
            workflow_run,
            [initial_pull_request],
            rechecked_pull_request,
            trusted_workflow_ref=trusted_workflow_ref,
        )
    except Exception:
        return _inconclusive()
    if (
        binding.pull_request_number != pull_number
        or binding.workflow_run_id != verified_run_id
        or binding.head_sha != initial_binding.head_sha
        or binding.base_sha != initial_binding.base_sha
    ):
        return _inconclusive()

    payload = {
        "name": CHECK_NAME,
        "head_sha": binding.head_sha,
        "status": "completed",
        "conclusion": public_conclusion,
    }
    try:
        created = _mapping(client.create_check(payload))
    except Exception:
        return _inconclusive()
    if created is None:
        return _inconclusive()
    check_id = _positive_int(created.get("id"))
    if check_id is None:
        return _inconclusive()

    try:
        readback = client.get_json(f"check-runs/{check_id}")
    except Exception:
        return _inconclusive()
    if not _check_readback_matches(
        readback,
        check_id=check_id,
        head_sha=binding.head_sha,
        conclusion=public_conclusion,
    ):
        return _inconclusive()
    return PrivateCheckResult(conclusion=result_conclusion)


def evaluate_private_run(
    client: GitHubClient,
    run_id: int,
    trusted_workflow_ref: str,
    scanner_bundle: Callable[[], ContextManager[VerifiedScannerBundle]],
    *,
    trusted_path: str,
    timeout_seconds: float,
    runtime_check: Callable[..., None],
) -> PrivateCheckResult:
    """Qualify and scan only after current admission in an isolated driver.

    The trusted factory owns the immutable bundle lifetime. Its cleanup completes
    before publication. The caller supplies canonical TMPDIR and an outer watchdog.
    """
    def scan(binding: VerifiedGitHubBinding) -> str:
        parent = Path(os.environ.get("TMPDIR", ""))
        if not parent.is_absolute() or parent.resolve(strict=True) != parent or not parent.is_dir():
            raise BoundaryError("private scan temporary directory is invalid")
        with scanner_bundle() as scanner:
            if runtime_check(scanner, binding, trusted_path=trusted_path) is not None:
                raise BoundaryError("private runtime qualification is inconclusive")
            selector = load_verified_selector(scanner)
            with tempfile.TemporaryDirectory(prefix="private-scan-", dir=parent) as temporary:
                plan = prepare_scan_inputs(
                    client, binding, scanner, selector, Path(temporary), trusted_path,
                )
                result = run_scanner_privately(plan, timeout_seconds=timeout_seconds)
                if (
                    type(result) is not dict
                    or set(result) != {"check_name", "head_sha", "conclusion"}
                    or result["check_name"] != binding.check_name
                    or result["head_sha"] != binding.head_sha
                    or type(result["conclusion"]) is not str
                    or result["conclusion"] not in {"pass", "fail", "inconclusive"}
                ):
                    raise BoundaryError("private scan result binding differs")
                conclusion = result["conclusion"]
        # Cleanup must succeed before the publication path receives a conclusion.
        return conclusion

    return evaluate_run(client, run_id, trusted_workflow_ref, scan)
