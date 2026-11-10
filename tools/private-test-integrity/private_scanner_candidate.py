"""Data-only contract primitives for a private test-integrity oracle.

This module does not call GitHub or publish a check. A
trusted workflow must fetch commit-addressed tree/blob data, validate it here,
verify the private scanner bundle separately, and execute the returned plan
with owned process-group supervision and no public scanner output.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
import hashlib
import math
import os
from pathlib import Path, PurePosixPath
from types import MappingProxyType
import re
import signal
import subprocess
import time
from typing import Callable, Iterable, Mapping


class BoundaryError(ValueError):
    """An untrusted candidate or trusted-input binding is not admissible."""


_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_REGULAR_GIT_MODES = frozenset({"100644", "100755"})


@dataclass(frozen=True)
class CandidateBlob:
    """One Git-tree blob already fetched as untrusted bytes."""

    path: str
    mode: str
    object_type: str
    content: bytes


@dataclass(frozen=True)
class CandidateBlobReference:
    """A selected blob from a completely validated Git tree."""

    path: str
    mode: str
    sha: str
    size: int


@dataclass(frozen=True)
class MaterializationPlan:
    files: tuple[CandidateBlob, ...]
    denied_control_paths: tuple[str, ...]
    total_bytes: int


@dataclass(frozen=True)
class WorkflowRunBinding:
    repository: str
    head_sha: str
    trusted_workflow_ref: str


@dataclass(frozen=True)
class PullRequestBinding:
    base_repository: str
    head_repository: str
    base_sha: str
    head_sha: str
    current_head_sha: str
    default_branch: str = "main"


@dataclass(frozen=True)
class VerifiedBinding:
    repository: str
    base_sha: str
    head_sha: str


@dataclass(frozen=True)
class TrustedScannerBundle:
    root: Path
    entrypoint: Path
    manifest_digest: str


@dataclass(frozen=True)
class VerifiedScannerBundle:
    bundle: TrustedScannerBundle
    manifest: Mapping[str, str]


@dataclass(frozen=True)
class TrustedBaseline:
    path: Path
    base_sha: str
    sha256: str


@dataclass(frozen=True)
class VerifiedTrustedBaseline:
    baseline: TrustedBaseline


@dataclass(frozen=True)
class RunnerPlan:
    command: tuple[str, ...]
    environment: Mapping[str, str]
    cwd: Path
    check_name: str
    head_sha: str
    capture_output: bool = False
    publish_raw_output: bool = False

    def public_result(self, conclusion: str) -> dict[str, str]:
        if conclusion not in {"pass", "fail", "inconclusive"}:
            raise BoundaryError("invalid sanitized check conclusion")
        return {
            "check_name": self.check_name,
            "conclusion": conclusion,
            "head_sha": self.head_sha,
        }


def _safe_relative_path(path: str) -> PurePosixPath:
    if not isinstance(path, str) or not path or "\x00" in path or "\\" in path:
        raise BoundaryError("candidate path is malformed")
    try:
        encoded = path.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise BoundaryError("candidate path is not UTF-8") from exc
    if len(encoded) > 512 or path.startswith("/"):
        raise BoundaryError("candidate path exceeds boundary")
    parts = path.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise BoundaryError("candidate path escapes scan root")
    return PurePosixPath(*parts)


def _is_denied_control_path(path: PurePosixPath) -> bool:
    parts = path.parts
    if len(parts) < 3 or parts[:2] != (".claude", "test-integrity"):
        return False
    if parts[2] in {"baseline.json", "config.yaml", "suppress.yaml"}:
        return True
    return parts[2] == "rules"


def _git_blob_sha(content: bytes) -> str:
    return hashlib.sha1(f"blob {len(content)}\0".encode("ascii") + content).hexdigest()


def decode_github_blob(
    expected_blob_sha: str,
    expected_size: int,
    raw_blob: object,
    *,
    max_blob_bytes: int,
) -> bytes:
    """Validate and decode one bounded GitHub blob response."""
    if not isinstance(raw_blob, Mapping):
        raise BoundaryError("GitHub blob response is malformed")
    if raw_blob.get("sha") != expected_blob_sha:
        raise BoundaryError("GitHub blob identity does not match tree")
    reported_size = raw_blob.get("size")
    if type(reported_size) is not int or reported_size != expected_size:
        raise BoundaryError("GitHub blob size does not match tree")
    if reported_size > max_blob_bytes:
        raise BoundaryError("GitHub blob exceeds byte limit")
    if raw_blob.get("encoding") != "base64" or not isinstance(raw_blob.get("content"), str):
        raise BoundaryError("GitHub blob content is malformed")
    encoded_content = raw_blob["content"]
    try:
        encoded_bytes = encoded_content.encode("ascii")
    except UnicodeEncodeError as exc:
        raise BoundaryError("GitHub blob content is not ASCII base64") from exc
    if len(encoded_bytes) > max_blob_bytes * 2 + 16:
        raise BoundaryError("GitHub blob encoded content exceeds byte limit")
    try:
        normalized_base64 = encoded_content.replace("\r", "").replace("\n", "")
        content = base64.b64decode(normalized_base64.encode("ascii"), validate=True)
    except (binascii.Error, ValueError, UnicodeEncodeError) as exc:
        raise BoundaryError("GitHub blob content is not valid base64") from exc
    if len(content) != reported_size or len(content) > max_blob_bytes:
        raise BoundaryError("GitHub blob content size does not match metadata")
    if _git_blob_sha(content) != expected_blob_sha:
        raise BoundaryError("GitHub blob content does not match identity")
    return content


def select_candidate_blobs_from_github_tree(
    expected_tree_sha: str,
    tree_response: Mapping[str, object],
    *,
    selector: Callable[[PurePosixPath], bool],
    max_tree_entries: int,
    max_blob_bytes: int,
    max_files: int,
    max_total_bytes: int,
) -> tuple[CandidateBlobReference, ...]:
    """Validate the complete tree before returning bounded selected references."""
    _require_sha(expected_tree_sha, "expected tree")
    if (
        type(max_tree_entries) is not int
        or type(max_blob_bytes) is not int
        or type(max_files) is not int
        or type(max_total_bytes) is not int
    ):
        raise BoundaryError("GitHub tree limits must be integers")
    if max_tree_entries <= 0 or max_blob_bytes <= 0 or max_files <= 0 or max_total_bytes <= 0:
        raise BoundaryError("GitHub tree limits must be positive")
    if not isinstance(tree_response, Mapping):
        raise BoundaryError("GitHub tree response is malformed")
    if tree_response.get("sha") != expected_tree_sha:
        raise BoundaryError("GitHub tree identity does not match expected tree")
    if tree_response.get("truncated") is not False:
        raise BoundaryError("GitHub tree is incomplete")
    raw_entries = tree_response.get("tree")
    if not isinstance(raw_entries, list):
        raise BoundaryError("GitHub tree entries are malformed")
    if len(raw_entries) > max_tree_entries:
        raise BoundaryError("GitHub tree entry count exceeds limit")

    selected: list[CandidateBlobReference] = []
    selected_total_bytes = 0
    seen_paths: set[str] = set()
    blob_paths: set[str] = set()
    paths_with_seen_descendant: set[str] = set()
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, Mapping):
            raise BoundaryError("GitHub tree entry is malformed")
        path = _safe_relative_path(raw_entry.get("path"))
        normalized_path = path.as_posix()
        if normalized_path in seen_paths:
            raise BoundaryError("GitHub tree has a duplicate path")
        seen_paths.add(normalized_path)
        mode = raw_entry.get("mode")
        object_type = raw_entry.get("type")
        blob_sha = raw_entry.get("sha")
        blob_size = raw_entry.get("size")
        if not isinstance(blob_sha, str):
            raise BoundaryError("GitHub tree entry identity is malformed")
        _require_sha(blob_sha, "GitHub tree entry")
        if object_type == "tree":
            if mode != "040000" or blob_size is not None:
                raise BoundaryError("GitHub tree directory metadata is malformed")
            for depth in range(1, len(path.parts)):
                if "/".join(path.parts[:depth]) in blob_paths:
                    raise BoundaryError("GitHub tree has a blob path ancestor")
            for depth in range(1, len(path.parts)):
                paths_with_seen_descendant.add("/".join(path.parts[:depth]))
            continue
        if object_type != "blob" or mode not in _REGULAR_GIT_MODES:
            raise BoundaryError("GitHub tree contains a non-regular entry")
        if type(blob_size) is not int or blob_size < 0:
            raise BoundaryError("GitHub tree blob size is malformed")
        for depth in range(1, len(path.parts)):
            if "/".join(path.parts[:depth]) in blob_paths:
                raise BoundaryError("GitHub tree has a blob path ancestor")
        if normalized_path in paths_with_seen_descendant:
            raise BoundaryError("GitHub tree blob has a path descendant")
        blob_paths.add(normalized_path)
        for depth in range(1, len(path.parts)):
            paths_with_seen_descendant.add("/".join(path.parts[:depth]))
        if _is_denied_control_path(path) or not selector(path):
            continue
        if blob_size > max_blob_bytes:
            raise BoundaryError("GitHub tree selected blob exceeds byte limit")
        if len(selected) >= max_files:
            raise BoundaryError("GitHub tree selected file count exceeds limit")
        selected_total_bytes += blob_size
        if selected_total_bytes > max_total_bytes:
            raise BoundaryError("GitHub tree selected bytes exceed limit")
        selected.append(CandidateBlobReference(normalized_path, mode, blob_sha, blob_size))

    return tuple(selected)


def fetch_candidate_blobs_from_github_tree(
    expected_tree_sha: str,
    tree_response: Mapping[str, object],
    blob_fetch: Callable[[str], Mapping[str, object]],
    *,
    selector: Callable[[PurePosixPath], bool],
    max_tree_entries: int,
    max_blob_bytes: int,
    max_files: int,
    max_total_bytes: int,
) -> tuple[CandidateBlob, ...]:
    """Fetch bounded blobs selected by the shared complete-tree validator."""
    selected = select_candidate_blobs_from_github_tree(
        expected_tree_sha, tree_response, selector=selector,
        max_tree_entries=max_tree_entries, max_blob_bytes=max_blob_bytes,
        max_files=max_files, max_total_bytes=max_total_bytes,
    )
    result: list[CandidateBlob] = []
    for entry in selected:
        try:
            raw_blob = blob_fetch(entry.sha)
        except Exception as exc:
            raise BoundaryError("GitHub blob fetch failed") from exc
        content = decode_github_blob(
            entry.sha,
            entry.size,
            raw_blob,
            max_blob_bytes=max_blob_bytes,
        )
        result.append(CandidateBlob(path=entry.path, mode=entry.mode, object_type="blob", content=content))
    return tuple(result)


def prepare_candidate_tests(
    entries: Iterable[CandidateBlob],
    *,
    selector: Callable[[PurePosixPath], bool],
    max_tree_entries: int,
    max_files: int,
    max_file_bytes: int,
    max_total_bytes: int,
) -> MaterializationPlan:
    """Admit only bounded, regular, UTF-8 test bytes from an exact candidate tree."""
    if min(max_tree_entries, max_files, max_file_bytes, max_total_bytes) <= 0:
        raise BoundaryError("materialization limits must be positive")
    selected: list[CandidateBlob] = []
    denied: list[str] = []
    seen: set[str] = set()
    total_bytes = 0
    for tree_entry_count, entry in enumerate(entries, start=1):
        if tree_entry_count > max_tree_entries:
            raise BoundaryError("candidate tree entry count exceeds limit")
        path = _safe_relative_path(entry.path)
        normalized = path.as_posix()
        if normalized in seen:
            raise BoundaryError("candidate tree has a duplicate path")
        seen.add(normalized)
        if entry.object_type != "blob" or entry.mode not in _REGULAR_GIT_MODES:
            raise BoundaryError("candidate tree contains a non-regular entry")
        if _is_denied_control_path(path):
            denied.append(normalized)
            continue
        if not selector(path):
            continue
        if not isinstance(entry.content, bytes):
            raise BoundaryError("candidate blob is not bytes")
        if len(entry.content) > max_file_bytes:
            raise BoundaryError("candidate test file exceeds byte limit")
        try:
            entry.content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise BoundaryError("candidate test file is not UTF-8") from exc
        if len(selected) >= max_files:
            raise BoundaryError("candidate test file count exceeds limit")
        total_bytes += len(entry.content)
        if total_bytes > max_total_bytes:
            raise BoundaryError("candidate test bytes exceed limit")
        selected.append(entry)
    if not selected:
        raise BoundaryError("candidate tree contains no admissible test files")
    return MaterializationPlan(
        files=tuple(sorted(selected, key=lambda item: item.path)),
        denied_control_paths=tuple(sorted(denied)),
        total_bytes=total_bytes,
    )


def materialize_candidate_tests(plan: MaterializationPlan, root: Path) -> None:
    """Write an already-admitted plan below a fresh, caller-owned scan root."""
    if root.exists():
        raise BoundaryError("scan root must not already exist")
    root.mkdir(mode=0o700)
    try:
        for entry in plan.files:
            relative = _safe_relative_path(entry.path)
            destination = root.joinpath(*relative.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.parent.resolve().is_relative_to(root.resolve()):
                raise BoundaryError("scan destination escaped root")
            destination.write_bytes(entry.content)
            destination.chmod(0o600)
        (root / ".private-scanner-root").write_text("trusted-root\n", encoding="utf-8")
        # The scanner recognizes this directory and must not load ancestor configuration.
        (root / ".claude").mkdir(mode=0o700, exist_ok=True)
    except Exception:
        # The root was newly created by this function and contains only this invocation's data.
        for candidate in sorted(root.rglob("*"), reverse=True):
            if candidate.is_file():
                candidate.unlink()
            elif candidate.is_dir():
                candidate.rmdir()
        root.rmdir()
        raise


def _manifest_digest(manifest: Mapping[str, str]) -> str:
    lines = []
    for relative, digest in sorted(manifest.items()):
        _safe_relative_path(relative)
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise BoundaryError("scanner manifest has an invalid digest")
        lines.append(f"{relative}\0{digest}\n")
    if not lines:
        raise BoundaryError("scanner manifest is empty")
    return hashlib.sha256("".join(lines).encode("utf-8")).hexdigest()


def verify_scanner_bundle(bundle: TrustedScannerBundle, manifest: Mapping[str, str]) -> VerifiedScannerBundle:
    """Require a whole-bundle manifest match before an oracle may invoke it."""
    if not bundle.root.is_absolute() or not bundle.entrypoint.is_absolute():
        raise BoundaryError("trusted scanner paths must be absolute")
    try:
        entrypoint_relative = bundle.entrypoint.relative_to(bundle.root).as_posix()
    except ValueError as exc:
        raise BoundaryError("scanner entrypoint is outside scanner root") from exc
    if _manifest_digest(manifest) != bundle.manifest_digest:
        raise BoundaryError("scanner manifest digest does not match trusted pin")
    observed: dict[str, str] = {}
    for path in bundle.root.rglob("*"):
        if path.is_symlink():
            raise BoundaryError("scanner bundle contains a symlink")
        if path.is_file():
            relative = path.relative_to(bundle.root).as_posix()
            observed[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    if observed != dict(manifest):
        raise BoundaryError("scanner bundle does not match its whole-bundle manifest")
    if entrypoint_relative not in observed or not bundle.entrypoint.is_file():
        raise BoundaryError("scanner entrypoint is not pinned by the whole-bundle manifest")
    return VerifiedScannerBundle(bundle=bundle, manifest=MappingProxyType(dict(manifest)))


def verify_trusted_baseline(baseline: TrustedBaseline, expected_base_sha: str) -> VerifiedTrustedBaseline:
    """Bind a byte-pinned baseline to the trusted PR base, never candidate data."""
    _require_sha(expected_base_sha, "expected PR base")
    _require_sha(baseline.base_sha, "baseline base")
    if baseline.base_sha != expected_base_sha:
        raise BoundaryError("trusted baseline is not bound to the PR base")
    if not baseline.path.is_absolute() or not re.fullmatch(r"[0-9a-f]{64}", baseline.sha256):
        raise BoundaryError("trusted baseline pin is malformed")
    try:
        observed = hashlib.sha256(baseline.path.read_bytes()).hexdigest()
    except OSError as exc:
        raise BoundaryError("trusted baseline is unavailable") from exc
    if observed != baseline.sha256:
        raise BoundaryError("trusted baseline bytes do not match their pin")
    return VerifiedTrustedBaseline(baseline=baseline)


def _require_sha(value: str, label: str) -> None:
    if not _SHA_RE.fullmatch(value):
        raise BoundaryError(f"{label} is not a full Git object ID")


def verify_workflow_run_binding(run: WorkflowRunBinding, pull_request: PullRequestBinding) -> VerifiedBinding:
    """Accept only a current same-repository PR head from the trusted default ref."""
    _require_sha(run.head_sha, "workflow-run head")
    _require_sha(pull_request.base_sha, "PR base")
    _require_sha(pull_request.head_sha, "PR head")
    _require_sha(pull_request.current_head_sha, "current PR head")
    if run.repository != pull_request.base_repository:
        raise BoundaryError("workflow-run repository does not own the PR base")
    if pull_request.head_repository != pull_request.base_repository:
        raise BoundaryError("fork PR heads are unsupported by this private-oracle prototype")
    if run.trusted_workflow_ref != f"refs/heads/{pull_request.default_branch}":
        raise BoundaryError("workflow-run did not use the trusted default-branch workflow")
    if run.head_sha != pull_request.head_sha or run.head_sha != pull_request.current_head_sha:
        raise BoundaryError("workflow-run head is stale or not the current PR head")
    return VerifiedBinding(
        repository=pull_request.base_repository,
        base_sha=pull_request.base_sha,
        head_sha=pull_request.current_head_sha,
    )


def build_scanner_environment(
    scanner: VerifiedScannerBundle, trusted_home: Path, trusted_path: str,
) -> Mapping[str, str]:
    """Use one environment contract for runtime probes and candidate scans."""
    if (
        not trusted_home.is_absolute() or not scanner.bundle.root.is_absolute()
        or type(trusted_path) is not str or not trusted_path
        or any(not component.startswith("/") or "\0" in component for component in trusted_path.split(":"))
    ):
        raise BoundaryError("scanner environment requires absolute trusted paths")
    return MappingProxyType({
        "CLAUDE_PLUGIN_ROOT": str(scanner.bundle.root),
        "HOME": str(trusted_home),
        "PATH": trusted_path,
        "WHATSOUP_REQUIRE_TEST_INTEGRITY": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
    })


def build_runner_plan(
    *,
    binding: VerifiedBinding,
    scanner: VerifiedScannerBundle,
    scan_root: Path,
    trusted_home: Path,
    trusted_baseline: VerifiedTrustedBaseline,
    trusted_path: str,
    candidate_paths: tuple[str, ...],
    check_name: str,
) -> RunnerPlan:
    """Build, but do not execute, the scanner command and sanitized publication shape."""
    baseline = trusted_baseline.baseline
    if (
        not check_name
        or not scan_root.is_absolute()
        or not trusted_home.is_absolute()
        or not baseline.path.is_absolute()
    ):
        raise BoundaryError("runner plan requires absolute trusted paths and a check name")
    if baseline.base_sha != binding.base_sha:
        raise BoundaryError("runner plan baseline is not bound to the verified PR base")
    if not trusted_path or any(not component.startswith("/") for component in trusted_path.split(":")):
        raise BoundaryError("runner plan requires an absolute trusted PATH")
    bundle = scanner.bundle
    if not bundle.root.is_absolute() or not bundle.entrypoint.is_absolute():
        raise BoundaryError("runner plan requires an absolute pinned scanner")
    if not candidate_paths:
        raise BoundaryError("runner plan refuses an empty candidate test set")
    normalized_paths = tuple(_safe_relative_path(path).as_posix() for path in candidate_paths)
    if len(normalized_paths) != len(set(normalized_paths)):
        raise BoundaryError("runner plan has duplicate candidate paths")
    sentinel = ".private-scanner-root"
    command = (
        str(bundle.entrypoint),
        "baseline",
        "--check",
        "--ci",
        "--baseline-file",
        str(baseline.path),
        "--",
        sentinel,
        *normalized_paths,
    )
    return RunnerPlan(
        command=command,
        environment=build_scanner_environment(scanner, trusted_home, trusted_path),
        cwd=scan_root,
        check_name=check_name,
        head_sha=binding.head_sha,
    )


def run_scanner_privately(
    plan: RunnerPlan,
    *,
    timeout_seconds: float,
    popen=subprocess.Popen,
    monotonic=time.monotonic,
    killpg=os.killpg,
    sleep=time.sleep,
) -> dict[str, str]:
    """Run a preverified plan inside an owned group; discard unused output.

    The caller owns TMPDIR, excludes concurrent trusted-input writers, and
    supplies an outer watchdog. Group absence does not prove no escaped child.
    """
    if (
        type(timeout_seconds) not in (int, float)
        or not math.isfinite(timeout_seconds)
        or not 0 < timeout_seconds <= 600
    ):
        raise BoundaryError("scanner timeout must be finite and within ten minutes")
    try:
        scratch = Path(os.environ.get("TMPDIR", ""))
        if not scratch.is_absolute() or scratch.resolve(strict=True) != scratch or not scratch.is_dir():
            return plan.public_result("inconclusive")
    except (OSError, ValueError):
        return plan.public_result("inconclusive")

    environment = {**plan.environment, "TMPDIR": str(scratch)}
    deadline = monotonic() + timeout_seconds
    execution_deadline = deadline - min(3.0, timeout_seconds / 4)
    child = None

    def group_exists() -> bool:
        try:
            killpg(child.pid, 0)
        except ProcessLookupError:
            return False
        return True

    try:
        child = popen(
            plan.command,
            cwd=plan.cwd,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=False,
            close_fds=True,
            start_new_session=True,
        )
        remaining = execution_deadline - monotonic()
        if remaining <= 0:
            raise TimeoutError("scanner deadline exceeded")
        returncode = child.wait(timeout=remaining)
        if group_exists() or monotonic() > deadline or type(returncode) is not int:
            raise RuntimeError("scanner completion is unverified")
        # The pinned baseline command reserves exit 1 for new policy findings.
        conclusion = "pass" if returncode == 0 else "fail" if returncode == 1 else "inconclusive"
        return plan.public_result(conclusion)
    except BaseException as error:
        if child is not None:
            try:
                try:
                    killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                finally:
                    child.wait(timeout=max(0, deadline - monotonic()))
                while group_exists():
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        raise TimeoutError("scanner cleanup deadline exceeded")
                    sleep(min(0.01, remaining))
            except Exception:
                pass
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        return plan.public_result("inconclusive")
