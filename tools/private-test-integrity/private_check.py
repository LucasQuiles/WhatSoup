"""One-shot, fail-closed orchestration for a trusted private scanner check."""

from __future__ import annotations

from collections.abc import Mapping as MappingABC
from dataclasses import dataclass, replace
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Callable, ContextManager

from bounded_github import GitHubClient
from candidate_scan import prepare_scan_inputs
from github_binding import (
    CHECK_NAME,
    AuthenticatedNonPRQualityRun,
    VerifiedGitHubBinding,
    VerifiedNonPRGitHubBinding,
    VerifiedScannerBinding,
    authenticate_non_pr_quality_run,
    bind_authenticated_non_pr_quality_run,
    bind_authenticated_quality_run,
)
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


def _read_exact_ref(client: GitHubClient, suffix: str, expected_ref: str) -> tuple[str, str]:
    response = _mapping(client.get_json(f"git/ref/{suffix}"))
    if response is None or response.get("ref") != expected_ref:
        raise BoundaryError("GitHub ref identity differs")
    target = _mapping(response.get("object"))
    if target is None:
        raise BoundaryError("GitHub ref object is malformed")
    object_type = target.get("type")
    target_sha = _full_sha(target.get("sha"))
    if object_type not in {"commit", "tag"} or target_sha is None:
        raise BoundaryError("GitHub ref object is malformed")
    return object_type, target_sha


def _resolve_candidate_ref(client: GitHubClient, source: AuthenticatedNonPRQualityRun) -> str:
    if source.source_ref == "refs/heads/main":
        object_type, target_sha = _read_exact_ref(client, "heads/main", source.source_ref)
        if object_type != "commit":
            raise BoundaryError("trusted main ref is not a commit")
        return target_sha
    if not source.source_ref.startswith("refs/tags/"):
        raise BoundaryError("candidate source ref is unsupported")
    tag_name = source.source_ref.removeprefix("refs/tags/")
    object_type, target_sha = _read_exact_ref(client, f"tags/{tag_name}", source.source_ref)
    if object_type == "commit":
        return target_sha
    annotated = _mapping(client.get_json(f"git/tags/{target_sha}"))
    if annotated is None or annotated.get("sha") != target_sha:
        raise BoundaryError("annotated tag identity differs")
    target = _mapping(annotated.get("object"))
    commit_sha = None if target is None else _full_sha(target.get("sha"))
    if target is None or target.get("type") != "commit" or commit_sha is None:
        raise BoundaryError("annotated tag does not peel to one commit")
    return commit_sha


def _first_parent(client: GitHubClient, head_sha: str) -> str:
    response = _mapping(client.get_json(f"git/commits/{head_sha}"))
    if response is None or response.get("sha") != head_sha:
        raise BoundaryError("candidate commit identity differs")
    parents = response.get("parents")
    if not isinstance(parents, list) or not 1 <= len(parents) <= 2:
        raise BoundaryError("candidate commit does not have an admitted parent count")
    first_parent = _mapping(parents[0])
    parent_sha = None if first_parent is None else _full_sha(first_parent.get("sha"))
    if parent_sha is None or parent_sha == head_sha:
        raise BoundaryError("candidate first parent is malformed")
    return parent_sha


def _candidate_is_ancestor(client: GitHubClient, candidate_sha: str, trusted_main_sha: str) -> bool:
    response = _mapping(client.get_json(f"compare/{candidate_sha}...{trusted_main_sha}"))
    merge_base = None if response is None else _mapping(response.get("merge_base_commit"))
    return merge_base is not None and _full_sha(merge_base.get("sha")) == candidate_sha


def _bind_non_pr_run(client: GitHubClient, workflow_run: MappingABC[str, object], run_id: int) -> VerifiedNonPRGitHubBinding:
    source = authenticate_non_pr_quality_run(workflow_run, expected_run_id=run_id)
    main_type, trusted_main_sha = _read_exact_ref(client, "heads/main", "refs/heads/main")
    if main_type != "commit":
        raise BoundaryError("trusted main ref is not a commit")
    candidate_ref_sha = (
        trusted_main_sha
        if source.source_ref == "refs/heads/main"
        else _resolve_candidate_ref(client, source)
    )
    baseline_sha = _first_parent(client, source.head_sha)
    return bind_authenticated_non_pr_quality_run(
        workflow_run,
        expected_run_id=run_id,
        trusted_main_sha=trusted_main_sha,
        candidate_ref_sha=candidate_ref_sha,
        baseline_sha=baseline_sha,
        candidate_is_ancestor=_candidate_is_ancestor(client, source.head_sha, trusted_main_sha),
    )


def _write_non_pr_receipt(
    receipt_path: Path,
    binding: VerifiedNonPRGitHubBinding,
    conclusion: str,
    *,
    scanner_run_id: int,
    scanner_run_attempt: int,
) -> None:
    if (
        not isinstance(receipt_path, Path)
        or not receipt_path.is_absolute()
        or receipt_path.name != "receipt.json"
        or receipt_path.exists()
        or receipt_path.is_symlink()
        or not receipt_path.parent.is_dir()
        or receipt_path.parent.resolve(strict=True) != receipt_path.parent
        or conclusion not in {"pass", "fail", "inconclusive"}
        or _positive_int(scanner_run_id) is None
        or _positive_int(scanner_run_attempt) is None
    ):
        raise BoundaryError("private receipt destination or identity is invalid")
    payload = {
        "schema_version": 1,
        "source_run_id": binding.source_run_id,
        "source_run_attempt": binding.source_run_attempt,
        "head_sha": binding.head_sha,
        "conclusion": conclusion,
        "scanner_run_id": scanner_run_id,
        "scanner_run_attempt": scanner_run_attempt,
    }
    descriptor: int | None = None
    try:
        descriptor = os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            descriptor = None
            target.write(json.dumps(payload, separators=(",", ":")))
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
    except Exception:
        if descriptor is not None:
            os.close(descriptor)
        try:
            receipt_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise BoundaryError("private receipt publication failed") from None


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


def evaluate_non_pr_run(
    client: GitHubClient,
    run_id: int,
    scan: Callable[[VerifiedNonPRGitHubBinding], str],
    *,
    receipt_path: Path,
    scanner_run_id: int,
    scanner_run_attempt: int,
) -> PrivateCheckResult:
    """Bind, scan, rebind, then publish only the non-PR receipt artifact."""
    verified_run_id = _positive_int(run_id)
    if (
        verified_run_id is None
        or _positive_int(scanner_run_id) is None
        or _positive_int(scanner_run_attempt) is None
    ):
        return _inconclusive()
    try:
        initial_run = _mapping(client.get_json(f"actions/runs/{verified_run_id}"))
        if initial_run is None:
            return _inconclusive()
        initial_binding = _bind_non_pr_run(client, initial_run, verified_run_id)
    except Exception:
        return _inconclusive()
    try:
        conclusion = scan(initial_binding)
    except Exception:
        return _inconclusive()
    if type(conclusion) is not str or conclusion not in {"pass", "fail", "inconclusive"}:
        return _inconclusive()
    try:
        rechecked_run = _mapping(client.get_json(f"actions/runs/{verified_run_id}"))
        if rechecked_run is None:
            return _inconclusive()
        rechecked_binding = _bind_non_pr_run(client, rechecked_run, verified_run_id)
        # Main is an ancestry witness, not the scan input. Rebinding verifies ancestry
        # again; an advancing main must not invalidate an unchanged tag and baseline.
        if rechecked_binding != replace(initial_binding, trusted_main_sha=rechecked_binding.trusted_main_sha):
            return _inconclusive()
        _write_non_pr_receipt(
            receipt_path,
            rechecked_binding,
            conclusion,
            scanner_run_id=scanner_run_id,
            scanner_run_attempt=scanner_run_attempt,
        )
    except Exception:
        return _inconclusive()
    return PrivateCheckResult(conclusion=conclusion)


def _scan_binding(
    client: GitHubClient,
    binding: VerifiedScannerBinding,
    scanner_bundle: Callable[[], ContextManager[VerifiedScannerBundle]],
    *,
    trusted_path: str,
    timeout_seconds: float,
    runtime_check: Callable[..., None],
) -> str:
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
            return result["conclusion"]


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
    return evaluate_run(
        client,
        run_id,
        trusted_workflow_ref,
        lambda binding: _scan_binding(
            client, binding, scanner_bundle,
            trusted_path=trusted_path, timeout_seconds=timeout_seconds, runtime_check=runtime_check,
        ),
    )


def evaluate_private_non_pr_run(
    client: GitHubClient,
    run_id: int,
    scanner_bundle: Callable[[], ContextManager[VerifiedScannerBundle]],
    *,
    trusted_path: str,
    timeout_seconds: float,
    runtime_check: Callable[..., None],
    receipt_path: Path,
    scanner_run_id: int,
    scanner_run_attempt: int,
) -> PrivateCheckResult:
    """Run the shared private scanner for a trusted main/schedule/tag Quality run."""
    return evaluate_non_pr_run(
        client,
        run_id,
        lambda binding: _scan_binding(
            client, binding, scanner_bundle,
            trusted_path=trusted_path, timeout_seconds=timeout_seconds, runtime_check=runtime_check,
        ),
        receipt_path=receipt_path,
        scanner_run_id=scanner_run_id,
        scanner_run_attempt=scanner_run_attempt,
    )
