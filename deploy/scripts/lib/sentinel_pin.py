"""Trustworthy runtime pin: load, verify authenticity, check bundle integrity.
Pure logic — all git/process access is injected so this is fully unit-testable.
The pin IS the bot-errors runtime manifest; there is no separate pin file."""
from __future__ import annotations
import json
import hashlib
import os
from dataclasses import dataclass

F10_PATH = "deploy/scripts/lib/bot_errors_redaction.py"


@dataclass(frozen=True)
class Pin:
    head_sha: str | None
    files: dict
    f10_sha: str | None


def load_pin(manifest_path) -> Pin:
    data = json.loads(open(manifest_path).read())
    files = {f["path"]: f["sha256"] for f in data.get("files", [])}
    return Pin(head_sha=data.get("expected_head_sha"), files=files, f10_sha=files.get(F10_PATH))


def load_approved_f10(ledger_path) -> set:
    return set(json.loads(open(ledger_path).read()).get("approved_f10", []))


def verify_pin_trust(pin: Pin, approved_f10: set, commit_exists) -> tuple[bool, str]:
    """A pin is trusted only if stamped, its commit is real, and its F10 is owner-approved.
    commit_exists(sha)->bool is injected (e.g. git cat-file -e <sha>^{commit} on origin/main)."""
    if not pin.head_sha:
        return False, "unstamped: expected_head_sha absent"
    if not commit_exists(pin.head_sha):
        return False, f"commit {pin.head_sha[:12]} not on origin/main"
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
    """Every pinned file must exist in the bundle and match its sha. Returns (ok, [(path, kind)])
    where kind is 'missing' or 'sha'."""
    mismatches = []
    for path, want in pin.files.items():
        fp = os.path.join(bundle_dir, path)
        if not os.path.isfile(fp):
            mismatches.append((path, "missing")); continue
        if _sha256_file(fp) != want:
            mismatches.append((path, "sha"))
    return (not mismatches), mismatches
