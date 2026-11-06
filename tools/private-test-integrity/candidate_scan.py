"""Git-addressed private candidate-scan input preparation contract."""

from __future__ import annotations

from collections.abc import Mapping as MappingABC
import hashlib
from pathlib import Path, PurePosixPath
from typing import Callable

from bounded_github import GitHubClient, MAX_BLOB_BATCH_OBJECTS, MAX_BLOB_BATCH_BYTES, MAX_BLOB_BYTES
from github_binding import CHECK_NAME, EXPECTED_REPOSITORY, VerifiedGitHubBinding
from private_scanner_candidate import (
    BoundaryError,
    CandidateBlob,
    CandidateBlobReference,
    RunnerPlan,
    TrustedBaseline,
    VerifiedBinding,
    VerifiedScannerBundle,
    _REGULAR_GIT_MODES,
    _require_sha,
    _safe_relative_path,
    _git_blob_sha,
    build_runner_plan,
    decode_github_blob,
    select_candidate_blobs_from_github_tree,
    materialize_candidate_tests,
    prepare_candidate_tests,
    verify_trusted_baseline,
)


Selector = Callable[[PurePosixPath], bool]
_BASELINE_PATH = ".claude/test-integrity/baseline.json"
_MAX_TREE_ENTRIES = 100_000
_MAX_TEST_FILES = 5_000
_MAX_BLOB_BYTES = MAX_BLOB_BYTES
_MAX_TEST_BYTES = 50_000_000


def prepare_scan_inputs(
    client: GitHubClient,
    binding: VerifiedGitHubBinding,
    scanner: VerifiedScannerBundle,
    selector: Selector,
    scratch: Path,
    trusted_path: str,
) -> RunnerPlan:
    """Build one scanner plan from exact Git objects without executing it."""
    if binding.repository != EXPECTED_REPOSITORY or binding.check_name != CHECK_NAME:
        raise BoundaryError("candidate binding does not match the fixed repository and check")
    _require_sha(binding.head_sha, "verified PR head")
    _require_sha(binding.base_sha, "verified PR base")
    _require_fresh_scratch(scratch)

    head_tree = _fetch_commit_tree(client, binding.head_sha)
    head_tree_response = client.get_json(f"git/trees/{head_tree}?recursive=1")
    selected = select_candidate_blobs_from_github_tree(
        head_tree,
        head_tree_response,
        selector=selector,
        max_tree_entries=_MAX_TREE_ENTRIES,
        max_blob_bytes=_MAX_BLOB_BYTES,
        max_files=_MAX_TEST_FILES,
        max_total_bytes=_MAX_TEST_BYTES,
    )
    candidate_blobs = _fetch_selected_batches(client, selected)
    candidate_plan = prepare_candidate_tests(
        candidate_blobs,
        selector=selector,
        max_tree_entries=_MAX_TREE_ENTRIES,
        max_files=_MAX_TEST_FILES,
        max_file_bytes=_MAX_BLOB_BYTES,
        max_total_bytes=_MAX_TEST_BYTES,
    )

    base_tree = _fetch_commit_tree(client, binding.base_sha)
    baseline_bytes = _fetch_base_baseline(client, base_tree)

    home = scratch / "home"
    candidate_root = scratch / "candidate"
    baseline_path = scratch / "baseline.json"
    try:
        home.mkdir(mode=0o700)
        baseline_path.write_bytes(baseline_bytes)
        baseline_path.chmod(0o600)
        materialize_candidate_tests(candidate_plan, candidate_root)
        trusted_baseline = verify_trusted_baseline(
            TrustedBaseline(
                path=baseline_path,
                base_sha=binding.base_sha,
                sha256=hashlib.sha256(baseline_bytes).hexdigest(),
            ),
            binding.base_sha,
        )
        return build_runner_plan(
            binding=VerifiedBinding(
                repository=binding.repository,
                base_sha=binding.base_sha,
                head_sha=binding.head_sha,
            ),
            scanner=scanner,
            scan_root=candidate_root,
            trusted_home=home,
            trusted_baseline=trusted_baseline,
            trusted_path=trusted_path,
            candidate_paths=tuple(entry.path for entry in candidate_plan.files),
            check_name=binding.check_name,
        )
    except Exception:
        _clear_owned_scratch(home, candidate_root, baseline_path)
        raise


def _fetch_selected_batches(client: GitHubClient, selected: tuple[CandidateBlobReference, ...]) -> tuple[CandidateBlob, ...]:
    sizes: dict[str, int] = {}
    for entry in selected:
        if entry.sha in sizes and sizes[entry.sha] != entry.size:
            raise BoundaryError("GitHub tree has inconsistent sizes for one blob")
        sizes[entry.sha] = entry.size
    batches: list[tuple[tuple[str, int], ...]] = []
    pending: list[tuple[str, int]] = []
    batch_bytes = 0
    for oid, size in sizes.items():
        if pending and (len(pending) == MAX_BLOB_BATCH_OBJECTS or batch_bytes + size > MAX_BLOB_BATCH_BYTES):
            batches.append(tuple(pending))
            pending = []
            batch_bytes = 0
        pending.append((oid, size))
        batch_bytes += size
    if pending:
        batches.append(tuple(pending))
    content_by_oid: dict[str, bytes] = {}
    for batch in batches:
        try:
            response = client.fetch_blob_batch(batch)
        except Exception:
            raise BoundaryError("GitHub candidate blob batch failed") from None
        if not isinstance(response, MappingABC) or set(response) != {oid for oid, _ in batch}:
            raise BoundaryError("GitHub candidate blob batch coverage differs")
        for oid, size in batch:
            content = response[oid]
            if not isinstance(content, bytes) or len(content) != size or _git_blob_sha(content) != oid:
                raise BoundaryError("GitHub candidate blob batch content differs")
            content_by_oid[oid] = content
    return tuple(CandidateBlob(entry.path, entry.mode, "blob", content_by_oid[entry.sha]) for entry in selected)


def _fetch_commit_tree(client: GitHubClient, expected_commit: str) -> str:
    response = client.get_json(f"git/commits/{expected_commit}")
    if not isinstance(response, MappingABC) or response.get("sha") != expected_commit:
        raise BoundaryError("GitHub commit identity does not match verified binding")
    tree = response.get("tree")
    if not isinstance(tree, MappingABC) or not isinstance(tree.get("sha"), str):
        raise BoundaryError("GitHub commit tree is malformed")
    tree_sha = tree["sha"]
    _require_sha(tree_sha, "GitHub commit tree")
    return tree_sha


def _fetch_base_baseline(client: GitHubClient, expected_tree: str) -> bytes:
    response = client.get_json(f"git/trees/{expected_tree}?recursive=1")
    if not isinstance(response, MappingABC) or response.get("sha") != expected_tree or response.get("truncated") is not False:
        raise BoundaryError("GitHub base tree is incomplete or mismatched")
    entries = response.get("tree")
    if not isinstance(entries, list) or len(entries) > _MAX_TREE_ENTRIES:
        raise BoundaryError("GitHub base tree entries are malformed or exceed the limit")

    baseline: MappingABC[str, object] | None = None
    for raw_entry in entries:
        if not isinstance(raw_entry, MappingABC):
            raise BoundaryError("GitHub base tree entry is malformed")
        path = _safe_relative_path(raw_entry.get("path"))
        if path.as_posix() != _BASELINE_PATH:
            continue
        if baseline is not None:
            raise BoundaryError("GitHub base tree has duplicate baseline paths")
        baseline = raw_entry
    if baseline is None:
        raise BoundaryError("GitHub base tree does not contain the trusted baseline")

    mode = baseline.get("mode")
    object_type = baseline.get("type")
    object_id = baseline.get("sha")
    size = baseline.get("size")
    if object_type != "blob" or mode not in _REGULAR_GIT_MODES:
        raise BoundaryError("GitHub base baseline is not a regular file")
    if not isinstance(object_id, str):
        raise BoundaryError("GitHub base baseline identity is malformed")
    _require_sha(object_id, "GitHub base baseline")
    if type(size) is not int or size < 0 or size > _MAX_BLOB_BYTES:
        raise BoundaryError("GitHub base baseline size exceeds the limit")
    raw_blob = client.get_json(f"git/blobs/{object_id}")
    return decode_github_blob(object_id, size, raw_blob, max_blob_bytes=_MAX_BLOB_BYTES)


def _require_fresh_scratch(scratch: Path) -> None:
    if not scratch.is_absolute() or scratch.is_symlink() or not scratch.is_dir():
        raise BoundaryError("candidate scan scratch must be an absolute caller-owned directory")
    if any(scratch.iterdir()):
        raise BoundaryError("candidate scan scratch must be fresh")


def _clear_owned_scratch(home: Path, candidate_root: Path, baseline_path: Path) -> None:
    if baseline_path.exists():
        baseline_path.unlink()
    if candidate_root.exists():
        for path in sorted(candidate_root.rglob("*"), reverse=True):
            if path.is_file():
                path.unlink()
            elif path.is_dir():
                path.rmdir()
        candidate_root.rmdir()
    if home.exists():
        home.rmdir()
