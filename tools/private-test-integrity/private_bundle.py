"""Materialize verified private blobs inside caller-owned canonical scratch.

The caller binds tree metadata to the pinned private Git tree and bounds blob
reads. No candidate code or concurrent untrusted writer may access this root.
"""

from __future__ import annotations

from contextlib import ExitStack, contextmanager, redirect_stderr, redirect_stdout
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path, PurePosixPath
import sys
from types import ModuleType
from typing import Callable, Iterable, Mapping

from private_scanner_candidate import (
    BoundaryError,
    TrustedScannerBundle,
    VerifiedScannerBundle,
    _REGULAR_GIT_MODES,
    _git_blob_sha,
    _manifest_digest,
    _require_sha,
    _safe_relative_path,
    verify_scanner_bundle,
)


@dataclass(frozen=True)
class GitLsTreeBlob:
    """Verified ls-tree metadata for one regular blob."""

    path: str
    mode: str
    object_type: str
    object_id: str
    size: int


BlobReader = Callable[[str], bytes]
_ENTRY_FIELDS = frozenset({"path", "mode", "object_type", "object_id", "size"})


@contextmanager
def _private_output():
    with ExitStack() as cleanup:
        sink = cleanup.enter_context(open(os.devnull, "w", encoding="utf-8"))
        for descriptor in (1, 2):
            saved = os.dup(descriptor)
            cleanup.callback(os.close, saved)
            cleanup.callback(os.dup2, saved, descriptor)
            os.dup2(sink.fileno(), descriptor)
        cleanup.enter_context(redirect_stdout(sink))
        cleanup.enter_context(redirect_stderr(sink))
        yield


def load_verified_selector(scanner: VerifiedScannerBundle) -> Callable[[PurePosixPath], bool]:
    """Load the private predicate in a fresh, isolated, single-threaded driver.

    The caller owns immutable bundle bytes, trusted interpreter dependencies
    and an outer deadline. Descriptor redirection requires a single thread.
    """
    try:
        bundle = scanner.bundle
        manifest = scanner.manifest
        if bundle.root.resolve(strict=True) != bundle.root or bundle.entrypoint != bundle.root / "scripts/test-integrity":
            raise BoundaryError("private selector bundle identity differs")
        verify_scanner_bundle(bundle, manifest)
        relative = "scripts/test_integrity_core.py"
        if relative not in manifest:
            raise BoundaryError("private selector is absent from the verified manifest")
        path = bundle.root / relative
        source = path.read_bytes()
        if hashlib.sha256(source).hexdigest() != manifest[relative]:
            raise BoundaryError("private selector bytes changed")
        name = "_whatsoup_private_selector_" + bundle.manifest_digest
        if name in sys.modules:
            raise BoundaryError("private selector module name is already occupied")
        module = ModuleType(name)
        module.__file__ = str(path)
        module.__package__ = ""
        previous_path = list(sys.path)
        sys.modules[name] = module
        try:
            with _private_output():
                # Exact source bytes avoid bytecode caches outside the manifest.
                exec(compile(source, str(path), "exec", dont_inherit=True), module.__dict__)
            predicate = getattr(module, "is_test_surface", None)
            if not callable(predicate):
                raise BoundaryError("private selector export is unavailable")
        finally:
            sys.path[:] = previous_path
            if sys.modules.get(name) is module:
                del sys.modules[name]
    except (Exception, SystemExit):
        raise BoundaryError("verified private selector could not be loaded") from None

    def select(path: PurePosixPath) -> bool:
        try:
            if not isinstance(path, PurePosixPath):
                raise BoundaryError("candidate selector path is invalid")
            relative_path = _safe_relative_path(path.as_posix())
            with _private_output():
                selected = predicate(Path(relative_path.as_posix()))
            if type(selected) is not bool:
                raise BoundaryError("private selector result is not Boolean")
            return selected
        except (Exception, SystemExit):
            raise BoundaryError("verified private selector could not classify the path") from None

    return select


def export_verified_bundle(
    verified_commit: str,
    verified_tree: str,
    entries: Iterable[GitLsTreeBlob | Mapping[str, object]],
    blob_reader: BlobReader,
    destination: Path,
    *,
    expected_commit: str,
    expected_tree: str,
    expected_manifest_digest: str,
    entrypoint: str = "scripts/test-integrity",
    max_files: int = 512,
    max_total_bytes: int = 20_000_000,
) -> VerifiedScannerBundle:
    """Materialize verified ls-tree entries into a fresh private scanner root.

    Mapping entries must use exactly path, mode, object_type, object_id, and size.
    """
    _require_git_object_id(expected_commit, "expected scanner commit")
    _require_git_object_id(verified_commit, "verified scanner commit")
    _require_git_object_id(expected_tree, "expected scanner tree")
    _require_git_object_id(verified_tree, "verified scanner tree")
    if expected_commit != verified_commit or expected_tree != verified_tree:
        raise BoundaryError("verified scanner identity does not match the trusted pin")
    _require_manifest_digest(expected_manifest_digest)
    if type(max_files) is not int or type(max_total_bytes) is not int or max_files <= 0 or max_total_bytes <= 0:
        raise BoundaryError("scanner bundle limits must be positive integers")
    if not destination.is_absolute() or destination.exists() or destination.is_symlink():
        raise BoundaryError("scanner bundle destination must be an absent absolute path")
    try:
        canonical_parent = destination.parent.resolve(strict=True)
    except OSError as exc:
        raise BoundaryError("scanner bundle parent is unavailable") from exc
    if canonical_parent != destination.parent or not canonical_parent.is_dir():
        raise BoundaryError("scanner bundle parent is not a canonical directory")

    entrypoint_path = _safe_relative_path(entrypoint)
    _reject_git_metadata(entrypoint_path)
    normalized: list[GitLsTreeBlob] = []
    seen_paths: set[str] = set()
    blob_paths: set[str] = set()
    paths_with_seen_descendant: set[str] = set()
    total_bytes = 0
    for raw_entry in entries:
        if len(normalized) >= max_files:
            raise BoundaryError("scanner bundle file count exceeds limit")
        entry = _normalize_tree_entry(raw_entry)
        path = _safe_relative_path(entry.path)
        _reject_git_metadata(path)
        relative = path.as_posix()
        if relative in seen_paths:
            raise BoundaryError("scanner bundle tree has a duplicate path")
        if entry.object_type != "blob" or entry.mode not in _REGULAR_GIT_MODES:
            raise BoundaryError("scanner bundle tree contains a non-regular entry")
        _require_git_object_id(entry.object_id, "scanner tree blob")
        if type(entry.size) is not int or entry.size < 0:
            raise BoundaryError("scanner tree blob size is malformed")
        for depth in range(1, len(path.parts)):
            if "/".join(path.parts[:depth]) in blob_paths:
                raise BoundaryError("scanner bundle tree has a blob path ancestor")
        if relative in paths_with_seen_descendant:
            raise BoundaryError("scanner bundle tree blob has a path descendant")
        total_bytes += entry.size
        if total_bytes > max_total_bytes:
            raise BoundaryError("scanner bundle bytes exceed limit")
        seen_paths.add(relative)
        blob_paths.add(relative)
        for depth in range(1, len(path.parts)):
            paths_with_seen_descendant.add("/".join(path.parts[:depth]))
        normalized.append(entry)
    if entrypoint_path.as_posix() not in seen_paths:
        raise BoundaryError("scanner bundle entrypoint is missing from the tree")

    materialized: list[tuple[GitLsTreeBlob, bytes]] = []
    manifest: dict[str, str] = {}
    for entry in normalized:
        try:
            content = blob_reader(entry.object_id)
        except Exception as exc:
            raise BoundaryError("scanner bundle blob read failed") from exc
        if type(content) is not bytes:
            raise BoundaryError("scanner bundle blob reader returned non-bytes")
        if len(content) != entry.size:
            raise BoundaryError("scanner bundle blob size does not match tree metadata")
        if _git_blob_sha(content) != entry.object_id:
            raise BoundaryError("scanner bundle blob bytes do not match tree identity")
        relative = _safe_relative_path(entry.path).as_posix()
        manifest[relative] = hashlib.sha256(content).hexdigest()
        materialized.append((entry, content))
    if _manifest_digest(manifest) != expected_manifest_digest:
        raise BoundaryError("scanner bundle manifest does not match the trusted pin")

    created = False
    try:
        destination.mkdir(mode=0o700)
        created = True
        for entry, content in materialized:
            relative = _safe_relative_path(entry.path)
            target = destination.joinpath(*relative.parts)
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            target.write_bytes(content)
            target.chmod(0o700 if entry.mode == "100755" or relative == entrypoint_path else 0o600)
        return verify_scanner_bundle(
            TrustedScannerBundle(
                root=destination,
                entrypoint=destination.joinpath(*entrypoint_path.parts),
                manifest_digest=expected_manifest_digest,
            ),
            manifest,
        )
    except Exception:
        if created:
            _remove_owned_bundle(destination)
        raise


def _normalize_tree_entry(raw_entry: GitLsTreeBlob | Mapping[str, object]) -> GitLsTreeBlob:
    if isinstance(raw_entry, GitLsTreeBlob):
        return raw_entry
    if not isinstance(raw_entry, Mapping) or set(raw_entry) != _ENTRY_FIELDS:
        raise BoundaryError("scanner tree entry is malformed")
    return GitLsTreeBlob(
        path=raw_entry["path"],
        mode=raw_entry["mode"],
        object_type=raw_entry["object_type"],
        object_id=raw_entry["object_id"],
        size=raw_entry["size"],
    )


def _require_manifest_digest(digest: str) -> None:
    if not isinstance(digest, str) or len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        raise BoundaryError("trusted scanner manifest digest is malformed")


def _require_git_object_id(value: object, label: str) -> None:
    if not isinstance(value, str):
        raise BoundaryError(f"{label} is not a full Git object ID")
    _require_sha(value, label)


def _reject_git_metadata(path) -> None:
    if ".git" in path.parts:
        raise BoundaryError("scanner bundle refuses Git metadata")


def _remove_owned_bundle(root: Path) -> None:
    if root.is_symlink():
        raise BoundaryError("new scanner bundle root was replaced")
    for child in sorted(root.rglob("*"), key=lambda item: len(item.parts), reverse=True):
        if child.is_symlink() or child.is_file():
            child.unlink()
        elif child.is_dir():
            child.rmdir()
        else:
            raise BoundaryError("new scanner bundle contains an unsupported filesystem entry")
    root.rmdir()
