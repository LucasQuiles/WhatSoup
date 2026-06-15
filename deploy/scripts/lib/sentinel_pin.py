"""Trustworthy runtime pin: load, verify authenticity, check bundle integrity.
Pure logic — all git/process access is injected so this is fully unit-testable.
The pin IS the bot-errors runtime manifest; there is no separate pin file."""
from __future__ import annotations
import hashlib
import json
import os
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


def load_approved_f10(ledger_path) -> set:
    data = _load_json_object(ledger_path, "approved-F10 ledger")
    approved = data.get("approved_f10")
    if not isinstance(approved, list):
        raise PinLoadError("approved-F10 ledger approved_f10 must be a list")
    return {_checked_sha256(value, "approved-F10 ledger entry") for value in approved}


def verify_pin_trust(pin: Pin, approved_f10: set, commit_exists) -> tuple[bool, str]:
    """A pin is trusted only if stamped, its commit is real, and its F10 is owner-approved.
    commit_exists(sha)->bool is injected (e.g. git cat-file -e <sha>^{commit} on origin/main)."""
    if not pin.head_sha:
        return False, "unstamped: expected_head_sha absent"
    if not _is_lower_hex(pin.head_sha, 40):
        return False, "invalid expected_head_sha"
    try:
        exists = bool(commit_exists(pin.head_sha))
    except Exception as e:
        return False, f"commit check failed: {type(e).__name__}"
    if not exists:
        return False, f"commit {pin.head_sha[:12]} not on origin/main"
    if pin.f10_sha is not None and not _is_lower_hex(pin.f10_sha, 64):
        return False, "invalid f10 sha"
    if pin.f10_sha not in approved_f10:
        return False, f"f10 {(pin.f10_sha or 'none')[:12]} not in approved ledger"
    return True, "ok"


def _sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_bundle(bundle_dir, pin: Pin) -> tuple[bool, list]:
    """Every pinned file must be safe, regular, present in the bundle, and match its sha."""
    mismatches = []
    for path, want in pin.files.items():
        try:
            _checked_manifest_path(path, "pin path")
            _checked_sha256(want, "pin sha256")
        except PinLoadError:
            mismatches.append((path, "unsafe_path"))
            continue
        fp = os.path.join(bundle_dir, path)
        if os.path.islink(fp):
            mismatches.append((path, "symlink"))
            continue
        if not os.path.isfile(fp):
            mismatches.append((path, "missing"))
            continue
        if _sha256_file(fp) != want:
            mismatches.append((path, "sha"))
    return (not mismatches), mismatches
