#!/usr/bin/env python3
"""Bind an already staged health export to its independently trusted descriptor."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tarfile

from lib.durable_json import (
    DurableWriteError, durable_json_target, observe_json, operation_id,
    publish_state_json, require_advance,
)


MAX_JSON_BYTES = 1024 * 1024
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_MEMBER_BYTES = 16 * 1024 * 1024
MAX_MEMBERS = 1024
MANIFEST = "deploy/bot-errors-runtime-manifest.json"
CHECKER = "deploy/scripts/bot-errors-health-check.py"


class Refused(ValueError):
    pass


@contextmanager
def regular_file(path: Path, limit: int, *, private: bool = False):
    absolute = path.absolute()
    if ".." in absolute.parts:
        raise Refused("parent traversal in input path")
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in absolute.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=directory)
            os.close(directory)
            directory = child
        parent = os.fstat(directory)
        if private and (parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) & 0o077):
            raise Refused("profile parent must be owner-private")
        descriptor = os.open(absolute.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                             dir_fd=directory)
        with os.fdopen(descriptor, "rb") as handle:
            before = os.fstat(handle.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
                raise Refused("input must be a bounded regular file")
            if private and (before.st_uid != os.getuid() or stat.S_IMODE(before.st_mode) & 0o077):
                raise Refused("profile must be owner-private")
            yield handle
            after = os.fstat(handle.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_size, after.st_mtime_ns, after.st_ctime_ns,
            ):
                raise Refused("input changed during verification")
    finally:
        os.close(directory)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Refused("duplicate JSON key")
        result[key] = value
    return result


def read_record(path: Path, *, private: bool = False):
    with regular_file(path, MAX_JSON_BYTES, private=private) as handle:
        raw = handle.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        raise Refused("JSON exceeds size bound")
    value = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(value, dict):
        raise Refused("JSON root must be an object")
    return value


def hex_value(value, length):
    return isinstance(value, str) and re.fullmatch(rf"[0-9a-f]{{{length}}}", value) is not None


def member_name(value):
    if (not isinstance(value, str) or not value or "\\" in value or "\x00" in value
            or any(part in {"", ".", ".."} for part in value.split("/"))):
        raise Refused("unsafe package member name")
    return value


def stream_digest(handle, limit):
    digest = hashlib.sha256()
    count = 0
    while chunk := handle.read(64 * 1024):
        count += len(chunk)
        if count > limit:
            raise Refused("package content exceeds size bound")
        digest.update(chunk)
    return digest.hexdigest()


class BoundedArchive:
    """Bound expanded tar headers as well as members before tarfile parses them."""

    def __init__(self, source):
        self.source = source
        self.remaining = MAX_ARCHIVE_BYTES

    def read(self, size):
        raw = self.source.read(min(size, self.remaining + 1))
        self.remaining -= len(raw)
        if self.remaining < 0:
            raise Refused("archive expansion exceeds size bound")
        return raw


def verify_archive(path, expected_hash, files):
    with regular_file(path, MAX_ARCHIVE_BYTES) as handle:
        if stream_digest(handle, MAX_ARCHIVE_BYTES) != expected_hash:
            raise Refused("archive digest differs")
        handle.seek(0)
        compressed = handle.read(2) == b"\x1f\x8b"
        handle.seek(0)
        source = gzip.GzipFile(fileobj=handle) if compressed else handle
        seen = set()
        try:
            with tarfile.open(fileobj=BoundedArchive(source), mode="r|") as archive:
                for entry in archive:
                    name = member_name(entry.name)
                    if (name in seen or name not in files or not entry.isfile()
                            or len(seen) >= MAX_MEMBERS or entry.size > MAX_MEMBER_BYTES):
                        raise Refused("archive membership or member type/size differs")
                    seen.add(name)
                    with archive.extractfile(entry) as member:
                        if stream_digest(member, MAX_MEMBER_BYTES) != files[name]:
                            raise Refused("archive member digest differs")
        finally:
            if compressed:
                source.close()
        if seen != set(files):
            raise Refused("archive membership differs")


def verify_staged(root, files):
    metadata = root.lstat()
    if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) & 0o077):
        raise Refused("staged root must be an owner-private directory")
    seen = set()
    allowed_directories = {parent.as_posix() for name in files for parent in Path(name).parents}

    def walk_error(error):
        raise error

    for parent, directories, names in os.walk(root, followlinks=False, onerror=walk_error):
        if Path(parent).is_symlink() or any((Path(parent) / name).is_symlink() for name in directories):
            raise Refused("symlinked staged directory")
        if any((Path(parent) / name).relative_to(root).as_posix() not in allowed_directories
               for name in directories):
            raise Refused("staged directory membership differs")
        for name in names:
            path = Path(parent) / name
            relative = path.relative_to(root).as_posix()
            if relative not in files or len(seen) >= MAX_MEMBERS:
                raise Refused("staged membership differs")
            with regular_file(path, MAX_MEMBER_BYTES) as handle:
                if stream_digest(handle, MAX_MEMBER_BYTES) != files[relative]:
                    raise Refused("staged member digest differs")
            seen.add(relative)
    if seen != set(files):
        raise Refused("staged membership differs")


def pin_payload(args):
    descriptor = read_record(args.package_manifest)
    source = descriptor.get("source_commit")
    archive_hash = descriptor.get("sha256")
    files = descriptor.get("files")
    if not hex_value(source, 40) or not hex_value(archive_hash, 64):
        raise Refused("invalid descriptor source or archive digest")
    if not isinstance(files, dict) or not 1 <= len(files) <= MAX_MEMBERS:
        raise Refused("invalid descriptor membership")
    for name, digest in files.items():
        member_name(name)
        if not hex_value(digest, 64):
            raise Refused("invalid member digest")
    if MANIFEST not in files or CHECKER not in files:
        raise Refused("descriptor must include runtime manifest and checker")
    if args.runtime_root.name != f"WhatSoup-health-{source[:12]}":
        raise Refused("staged root does not bind source commit")
    profile = read_record(args.profile, private=True)
    role = profile.get("role")
    if (not isinstance(role, str) or role not in {"no-bot", "bot-host"}
            or profile.get("expectRuntimeManifest") is not True):
        raise Refused("profile role must require the supported runtime manifest")
    if args.pin_output.absolute().is_relative_to(args.runtime_root.absolute()):
        raise Refused("pin must be outside the staged package")
    verify_archive(args.archive, archive_hash, files)
    verify_staged(args.runtime_root, files)
    manifest = read_record(args.runtime_root / MANIFEST)
    if type(manifest.get("schemaVersion")) is not int or manifest["schemaVersion"] != 1:
        raise Refused("runtime manifest schema differs")
    if manifest.get("expected_head_sha") != source or not isinstance(manifest.get("files"), list):
        raise Refused("runtime manifest source or entries differ")
    seen = set()
    for entry in manifest["files"]:
        if not isinstance(entry, dict):
            raise Refused("invalid runtime manifest entry")
        name = member_name(entry.get("path"))
        if name in seen or name not in files or entry.get("sha256") != files[name]:
            raise Refused("runtime manifest member digest differs")
        seen.add(name)
    if CHECKER not in seen:
        raise Refused("running checker not manifested")
    return {
        "schemaVersion": 1, "owner": "health_reporter", "mode": profile["role"],
        "sourceCommit": source, "archiveSha256": archive_hash,
        "runtimeManifestSha256": files[MANIFEST], "runtimeRootName": args.runtime_root.name,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["package-manifest", "archive", "runtime-root", "profile", "pin-output"]:
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    try:
        payload = pin_payload(args)
        target = durable_json_target(trusted_root=args.pin_output.absolute().parent,
                                     relative_path=args.pin_output.name)
        observed = observe_json(target, strict=True)
        if observed.version.exists:
            if observed.payload != payload:
                raise Refused("existing pin differs; select a separate staged pin for transition")
        elif args.verify_only:
            raise Refused("pin is missing")
        else:
            component = "health_package.write_pin"
            result = publish_state_json(
                target, payload, component=component,
                operation_id=operation_id(target, payload, component=component, predecessor=observed.version),
                expected=observed.version, generation=1,
            )
            require_advance(result)
        print(json.dumps({"status": "verified", "sourceCommit": payload["sourceCommit"], "mode": payload["mode"]}))
        return 0
    except (OSError, ValueError, tarfile.TarError, DurableWriteError) as exc:
        print(f"FATAL health package pin: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
