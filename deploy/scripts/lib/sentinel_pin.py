"""Trustworthy runtime pin: load, verify authenticity, check bundle integrity.
Pure logic — all git/process access is injected so this is fully unit-testable.
The pin IS the bot-errors runtime manifest; there is no separate pin file."""
from __future__ import annotations
import hashlib
import json
import os
import stat
from dataclasses import dataclass
from typing import Optional

F10_PATH = "deploy/scripts/lib/bot_errors_redaction.py"
_HEX = set("0123456789abcdef")


class PinLoadError(Exception):
    """Raised when a pin manifest is missing or corrupt. Fail closed on the trust-critical
    path: the caller must treat a pin that cannot be loaded as untrusted, not crash."""
    pass


@dataclass(frozen=True)
class Pin:
    head_sha: Optional[str]
    files: dict[str, str]
    f10_sha: Optional[str]


def _is_lower_hex(value, length: int) -> bool:
    return isinstance(value, str) and len(value) == length and all(c in _HEX for c in value)


def _load_json_object(path, label: str) -> dict:
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        raise PinLoadError(f"cannot load {label} {path}: {e}") from e
    if not isinstance(data, dict):
        raise PinLoadError(f"{label} {path} must be a JSON object")
    return data


def _checked_manifest_path(value, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise PinLoadError(f"{field} must be a non-empty relative path")
    if os.path.isabs(value) or os.path.normpath(value) != value or ".." in value.split("/"):
        raise PinLoadError(f"{field} is not a safe manifest path: {value!r}")
    return value


def _checked_sha256(value, field: str) -> str:
    if not _is_lower_hex(value, 64):
        raise PinLoadError(f"{field} must be a lowercase sha256")
    return value


def load_pin(manifest_path) -> Pin:
    data = _load_json_object(manifest_path, "pin manifest")
    if data.get("schemaVersion") != 1:
        raise PinLoadError("pin manifest schemaVersion must be 1")
    head_sha = data.get("expected_head_sha")
    if head_sha is not None and not _is_lower_hex(head_sha, 40):
        raise PinLoadError("expected_head_sha must be a lowercase 40-char git sha when present")
    raw_files = data.get("files")
    if not isinstance(raw_files, list):
        raise PinLoadError("pin manifest files must be a list")
    files = {}
    for i, entry in enumerate(raw_files):
        if not isinstance(entry, dict):
            raise PinLoadError(f"pin manifest files[{i}] must be an object")
        path = _checked_manifest_path(entry.get("path"), f"pin manifest files[{i}].path")
        if path in files:
            raise PinLoadError(f"pin manifest duplicate path: {path}")
        files[path] = _checked_sha256(entry.get("sha256"), f"pin manifest files[{i}].sha256")
    return Pin(head_sha=head_sha, files=files, f10_sha=files.get(F10_PATH))


def _checked_head_sha(value, field: str) -> str:
    if not _is_lower_hex(value, 40):
        raise PinLoadError(f"{field} must be a lowercase 40-char git sha")
    return value


def _load_approval_ledger(ledger_path) -> dict:
    data = _load_json_object(ledger_path, "approved-F10 ledger")
    return data


def load_approved_f10(ledger_path) -> set:
    data = _load_approval_ledger(ledger_path)
    approved = data.get("approved_f10")
    if not isinstance(approved, list):
        raise PinLoadError("approved-F10 ledger approved_f10 must be a list")
    return {_checked_sha256(value, "approved-F10 ledger entry") for value in approved}


def load_approved_heads(ledger_path) -> set:
    data = _load_approval_ledger(ledger_path)
    approved = data.get("approved_heads", [])
    if not isinstance(approved, list):
        raise PinLoadError("approved-F10 ledger approved_heads must be a list")
    return {_checked_head_sha(value, "approved-F10 ledger approved_heads entry") for value in approved}


def verify_pin_trust(pin: Pin, approved_f10: set, commit_exists, approved_heads: Optional[set] = None) -> tuple[bool, str]:
    """A pin is trusted only if stamped, its commit is real, and its F10 is owner-approved.
    commit_exists(sha)->bool is injected (e.g. git cat-file -e <sha>^{commit} on origin/main).
    Non-git runtime trees may use deployer-stamped approved_heads as a fail-closed fallback."""
    if not pin.head_sha:
        return False, "unstamped: expected_head_sha absent"
    if not _is_lower_hex(pin.head_sha, 40):
        return False, "invalid expected_head_sha"
    head_approved = approved_heads is not None and pin.head_sha in approved_heads
    try:
        exists = bool(commit_exists(pin.head_sha))
    except Exception as e:
        if not head_approved:
            return False, f"commit check failed: {type(e).__name__}"
        exists = False
    if not exists and not head_approved:
        return False, f"commit {pin.head_sha[:12]} not on origin/main"
    if pin.f10_sha is not None and not _is_lower_hex(pin.f10_sha, 64):
        return False, "invalid f10 sha"
    if pin.f10_sha not in approved_f10:
        return False, f"f10 {(pin.f10_sha or 'none')[:12]} not in approved ledger"
    if exists:
        return True, "ok"
    return True, "ok: approved head ledger"


def _sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_fd(fd: int) -> str:
    """Hash bytes from an already-open file descriptor. The caller transfers
    ownership of the fd; it is closed when the hash completes."""
    h = hashlib.sha256()
    with os.fdopen(fd, "rb", closefd=True) as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _classify_open_failure(name: str, dir_fd: int, symlink_taxonomy: str, default_taxonomy: str) -> str:
    """Classify an ``O_NOFOLLOW`` open failure by checking if the target is a
    symlink.  Returns ``symlink_taxonomy`` when the leaf/intermediate is a
    symlink, otherwise ``default_taxonomy`` (typically ``"missing"``)."""
    try:
        st = os.lstat(name, dir_fd=dir_fd)
        if stat.S_ISLNK(st.st_mode):
            return symlink_taxonomy
    except OSError:
        pass
    return default_taxonomy


def _open_confined_leaf(bundle_dir: str, rel_path: str):
    """Open a manifest-tracked file under *bundle_dir*, rejecting symlinks at
    **every** path component — the root, every intermediate directory, and the
    final leaf — and verifying the leaf is a regular file.

    Uses descriptor-relative traversal (``openat``) so each component is opened
    relative to its already-verified parent descriptor.  This eliminates root
    escapes via parent symlinks and pathname TOCTOU races: once a directory fd
    is opened, swapping the filesystem name does not redirect the descriptor.

    Returns ``(fd, None)`` on success — the caller owns and must close/hashing
    the fd — or ``(None, taxonomy)`` where *taxonomy* is one of:

    ``root_symlink``   — *bundle_dir* itself is a symlink.
    ``parent_symlink`` — an intermediate directory component is a symlink.
    ``symlink``        — the final leaf component is a symlink.
    ``missing``        — the leaf or an intermediate component does not exist.
    ``file_kind``      — an intermediate is not a directory, or the leaf is not
                         a regular file (e.g. FIFO, socket, device).
    ``read_failed``    — ``lstat``/``open``/``fstat`` raised an unexpected error.
    """
    parts = rel_path.split("/")

    # --- Verify bundle root is a real directory, not a symlink ---
    try:
        root_st = os.lstat(bundle_dir)
    except OSError:
        return None, "read_failed"
    if stat.S_ISLNK(root_st.st_mode):
        return None, "root_symlink"
    if not stat.S_ISDIR(root_st.st_mode):
        return None, "read_failed"

    # --- Open root directory descriptor ---
    dir_fds: list[int] = []
    leaf_fd: int | None = None
    try:
        root_fd = os.open(bundle_dir, os.O_RDONLY)
        dir_fds.append(root_fd)
        parent_fd = root_fd

        # --- Walk intermediate directory components ---
        for component in parts[:-1]:
            try:
                fd = os.open(component, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
            except OSError:
                return None, _classify_open_failure(component, parent_fd, "parent_symlink", "missing")
            dir_fds.append(fd)
            parent_fd = fd
            try:
                st = os.fstat(fd)
            except OSError:
                return None, "read_failed"
            if not stat.S_ISDIR(st.st_mode):
                return None, "file_kind"

        # --- Open the final leaf with O_NOFOLLOW ---
        # O_NONBLOCK prevents blocking on FIFOs/socket files so the verifier
        # cannot hang on a non-regular leaf planted as a denial-of-service.
        try:
            leaf_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
        except OSError:
            return None, _classify_open_failure(parts[-1], parent_fd, "symlink", "missing")

        # --- Verify the leaf is a regular file ---
        try:
            st = os.fstat(leaf_fd)
        except OSError:
            os.close(leaf_fd)
            return None, "read_failed"
        if not stat.S_ISREG(st.st_mode):
            os.close(leaf_fd)
            return None, "file_kind"

        fd_out = leaf_fd  # ownership transfers to caller
        return fd_out, None
    except OSError:
        if leaf_fd is not None:
            try:
                os.close(leaf_fd)
            except OSError:
                pass
        return None, "read_failed"
    finally:
        for fd in reversed(dir_fds):
            try:
                os.close(fd)
            except OSError:
                pass


def verify_bundle(bundle_dir, pin: Pin) -> tuple[bool, list]:
    """Every pinned file must be safe, regular, present in the bundle,
    **confined** to the bundle root (no symlinks at any path component — root,
    intermediate, or leaf), and match its sha256.

    File bytes are hashed from an already-validated descriptor opened via
    ``O_NOFOLLOW`` at every component, so a parent symlink cannot redirect
    verification to bytes outside the claimed root."""
    mismatches = []
    for path, want in pin.files.items():
        try:
            _checked_manifest_path(path, "pin path")
            _checked_sha256(want, "pin sha256")
        except PinLoadError:
            mismatches.append((path, "unsafe_path"))
            continue
        fd, err = _open_confined_leaf(bundle_dir, path)
        if err is not None:
            mismatches.append((path, err))
            continue
        if _sha256_fd(fd) != want:
            mismatches.append((path, "sha"))
    return (not mismatches), mismatches
