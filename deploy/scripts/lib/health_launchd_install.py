"""Preserving re-pin mode for install-bot-errors-health-launchd.sh.

Release and effective-configuration verification remain operator prerequisites.
This transaction changes only the health job; it does not restart bot instances.
"""

from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import stat
import subprocess
import sys
import tempfile


class Refused(RuntimeError):
    pass


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def command(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=20, check=False)


def read_current(path: Path) -> tuple[bytes, os.stat_result]:
    # O_NONBLOCK prevents a substituted FIFO from hanging before fstat rejects it.
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise Refused("plist must be a regular, singly linked file owned by the current user")
        raw = handle.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise Refused("plist exceeds 1 MiB")
    return raw, info


def read_original(path: Path, expected: str) -> tuple[bytes, os.stat_result]:
    raw, info = read_current(path)
    if sha(raw) != expected:
        raise Refused("plist changed since review")
    return raw, info


def same_permissions(observed: os.stat_result, expected: os.stat_result) -> None:
    if (observed.st_mode, observed.st_uid, observed.st_gid) != (expected.st_mode, expected.st_uid, expected.st_gid):
        raise Refused("plist permissions changed during re-pin")


def supported_metadata(path: Path, info: os.stat_result) -> None:
    if getattr(info, "st_flags", 0):
        raise Refused("plist flags require a preservation-aware operator path")
    if sys.platform == "darwin":
        attrs = command("/usr/bin/xattr", str(path))
        if attrs.returncode or attrs.stdout.strip():
            raise Refused("plist extended attributes cannot be preserved by this installer")
        for target in (path, path.parent):
            acl = command("/bin/ls", "-lde", str(target))
            if acl.returncode or re.search(r"(?m)^\s*[0-9]+:", acl.stdout):
                raise Refused("plist or parent ACL cannot be preserved by this installer")
    elif os.listxattr(path, follow_symlinks=False):
        raise Refused("plist extended attributes cannot be preserved by this installer")


def candidate(raw: bytes, root: Path, label: str, manifest: str | None) -> tuple[bytes, list[str]]:
    before = plistlib.loads(raw)
    # Exit 1 means a verified rollback, so malformed input must be a refusal, not an AttributeError.
    if not isinstance(before, dict):
        raise Refused("expected a plist whose top level is a dict")
    if before.get("Label") != label or before.get("RunAtLoad") is not False or before.get("KeepAlive", False):
        raise Refused("expected an existing health job with RunAtLoad=false and no KeepAlive")
    if "Program" in before or not isinstance(before.get("StartCalendarInterval"), (dict, list)):
        raise Refused("expected a scheduled ProgramArguments job")
    old = before.get("WorkingDirectory")
    args = before.get("ProgramArguments")
    if not isinstance(old, str) or not Path(old).is_absolute() or not isinstance(args, list):
        raise Refused("cannot identify existing health code paths")
    if not root.is_absolute() or not root.is_dir() or root == Path(old):
        raise Refused("target must be a different existing absolute release directory")
    after = copy.deepcopy(before)
    changes = ["WorkingDirectory"]
    for name in ("bot-errors-runner.py", "bot-errors-health-check.py"):
        previous = str(Path(old) / "deploy/scripts" / name)
        target = root / "deploy/scripts" / name
        if args.count(previous) != 1 or not target.is_file() or not os.access(target, os.R_OK):
            raise Refused("expected exactly one runner and checker argument with readable replacements")
        index = args.index(previous)
        after["ProgramArguments"][index] = str(target)
        changes.append(f"ProgramArguments[{index}]")
    after["WorkingDirectory"] = str(root)
    if manifest:
        path = Path(manifest)
        if not path.is_absolute() or not path.is_file() or not os.access(path, os.R_OK):
            raise Refused("runtime manifest must be an existing readable absolute path")
        env = after.setdefault("EnvironmentVariables", {})
        if not isinstance(env, dict):
            raise Refused("EnvironmentVariables must be a dict")
        env["BOT_ERRORS_RUNTIME_MANIFEST"] = str(path)
        changes.append("EnvironmentVariables.BOT_ERRORS_RUNTIME_MANIFEST")
    return plistlib.dumps(after, sort_keys=False), changes


def idle_job(domain: str, label: str) -> None:
    disabled = command("launchctl", "print-disabled", domain)
    if disabled.returncode or "disabled services" not in disabled.stdout:
        raise Refused("cannot verify whether the job is disabled")
    states = re.findall(r'"' + re.escape(label) + r'"\s*=>\s*([^\s,;}]+)', disabled.stdout)
    if states not in (["enabled"], ["false"]):
        raise Refused("job is disabled or its enabled state is unknown")
    current = command("launchctl", "list", label)
    if current.returncode or not re.search(r'"Label"\s*=\s*"' + re.escape(label) + '"', current.stdout):
        raise Refused("cannot verify a loaded health job")
    if re.search(r'"PID"\s*=\s*[1-9][0-9]*', current.stdout):
        raise Refused("health job is running")


def stage(path: Path, raw: bytes, info: os.stat_result, prefix: str) -> Path:
    fd, name = tempfile.mkstemp(prefix=prefix, dir=path.parent)
    staged = Path(name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fchown(handle.fileno(), info.st_uid, info.st_gid)
            os.fchmod(handle.fileno(), stat.S_IMODE(info.st_mode))
            os.fsync(handle.fileno())
        if command("plutil", "-lint", str(staged)).returncode:
            raise Refused("staged plist validation failed")
    except BaseException:
        staged.unlink(missing_ok=True)
        raise
    return staged


def replace(staged: Path, target: Path) -> None:
    os.replace(staged, target)
    fd = os.open(target.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def apply(path: Path, raw: bytes, data: bytes, info: os.stat_result, domain: str, label: str) -> tuple[int, dict]:
    # A separate inode keeps the lock valid across atomic plist replacement.
    lock_fd = os.open(str(path) + ".repin.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "rb") as lock:
        lock_info = os.fstat(lock.fileno())
        if lock_info.st_uid != os.getuid() or not stat.S_ISREG(lock_info.st_mode) or lock_info.st_nlink != 1:
            raise Refused("invalid installer lock")
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("another health re-pin is active") from None
        current, current_info = read_original(path, sha(raw))
        same_permissions(current_info, info)
        supported_metadata(path, current_info)
        staged = stage(path, data, info, ".health-candidate-")
        backup = None
        try:
            idle_job(domain, label)
            backup = stage(path, current, info, path.name + ".backup-")
            try:
                _, current_info = read_original(path, sha(raw))
                same_permissions(current_info, info)
                supported_metadata(path, current_info)
            except BaseException:
                # Nothing has changed yet, and the refusal receipt names no backup.
                backup.unlink(missing_ok=True)
                raise
            try:
                result = command("launchctl", "bootout", domain, str(path))
                if result.returncode:
                    # A failed command may already have unloaded the job.
                    # Only the verified unchanged case can skip restoration.
                    loaded = command("launchctl", "list", label)
                    if loaded.returncode == 0:
                        idle_job(domain, label)
                        _, current_info = read_original(path, sha(raw))
                        same_permissions(current_info, info)
                        return 2, {"status": "unchanged", "backup": str(backup), "reason": "bootout failed"}
                    raise Refused("bootout failed after unloading or losing job visibility")
                # Do not overwrite an unrelated writer even after the old job is unloaded.
                _, current_info = read_original(path, sha(raw))
                same_permissions(current_info, info)
                replace(staged, path)
                result = command("launchctl", "bootstrap", domain, str(path))
                if result.returncode:
                    raise Refused("candidate bootstrap failed")
                idle_job(domain, label)
                _, current_info = read_original(path, sha(data))
                same_permissions(current_info, info)
                return 0, {"status": "applied", "backup": str(backup)}
            except (Exception, KeyboardInterrupt):
                try:
                    found, current_info = read_current(path)
                    same_permissions(current_info, info)
                    if found not in (raw, data):
                        raise Refused("concurrent plist update; rollback would overwrite it")
                    loaded = command("launchctl", "list", label)
                    if loaded.returncode == 0:
                        if command("launchctl", "bootout", domain, str(path)).returncode:
                            raise Refused("cannot unload candidate during rollback")
                    elif loaded.returncode != 113:
                        raise Refused("job visibility is unknown during rollback")
                    restored = stage(path, raw, info, ".health-rollback-")
                    replace(restored, path)
                    if command("launchctl", "bootstrap", domain, str(path)).returncode:
                        raise Refused("original job reload failed")
                    idle_job(domain, label)
                    _, current_info = read_original(path, sha(raw))
                    same_permissions(current_info, info)
                    return 1, {"status": "rolled_back", "backup": str(backup)}
                except (Exception, KeyboardInterrupt):
                    return 3, {"status": "rollback_unverified", "backup": str(backup)}
        finally:
            staged.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-plist-sha256", required=True)
    parser.add_argument("--runtime-manifest", help="change only this job's manifest path; verify it before applying")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-candidate-sha256", help="required with --apply; use the reviewed plan hash")
    args = parser.parse_args()
    label = os.environ.get("BOT_ERRORS_HEALTH_LABEL", "com.bot-errors.health")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]", label):
        raise Refused("invalid health job label")
    if not re.fullmatch(r"[a-f0-9]{64}", args.expected_plist_sha256):
        raise Refused("expected plist checksum must be SHA-256")
    path = Path.home() / "Library/LaunchAgents" / (label + ".plist")
    root = Path(os.environ.get("BOT_ERRORS_REPO_ROOT", str(Path.home() / "LAB/WhatSoup")))
    raw, info = read_original(path, args.expected_plist_sha256)
    supported_metadata(path, info)
    data, changes = candidate(raw, root, label, args.runtime_manifest)
    domain = f"gui/{os.getuid()}"
    idle_job(domain, label)
    record = {"status": "planned", "plist_sha256": sha(raw), "candidate_sha256": sha(data),
              "changed_fields": changes, "release_root": str(root), "mode": oct(stat.S_IMODE(info.st_mode)),
              "verification_scope": "job configuration only; release, manifest and runtime health require separate verification"}
    rc = 0
    if args.apply:
        if args.expected_candidate_sha256 != sha(data):
            raise Refused("candidate differs from the reviewed plan or no candidate checksum supplied")
        rc, outcome = apply(path, raw, data, info, domain, label)
        record.update(outcome)
    print(json.dumps(record, sort_keys=True))
    return rc


if __name__ == "__main__":
    def interrupted(signum, frame):
        # selectors may swallow InterruptedError while waiting for launchctl.
        raise Refused("installer interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    try:
        raise SystemExit(main())
    except (Refused, OSError, ValueError, subprocess.SubprocessError) as exc:
        # Subprocess output and plist contents can contain private environment values.
        print(json.dumps({"status": "refused", "reason": str(exc) if isinstance(exc, Refused) else type(exc).__name__}))
        raise SystemExit(2)
