"""A verified staged export produces a consumer-compatible private pin."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile

from hypothesis import example, given, strategies as st
import pytest

from bot_errors_property_support import private_case, properties


SCRIPTS = Path(__file__).resolve().parents[1]
PRODUCER = SCRIPTS / "write-health-package-pin.py"
CHECKER = SCRIPTS / "bot-errors-health-check.py"
SOURCE = "a" * 40
MANIFEST = "deploy/bot-errors-runtime-manifest.json"
CHECKER_MEMBER = "deploy/scripts/bot-errors-health-check.py"


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def package(tmp_path, role="no-bot"):
    directory = tmp_path.resolve()
    directory.chmod(0o700)
    root = directory / f"WhatSoup-health-{SOURCE[:12]}"
    contents = {CHECKER_MEMBER: CHECKER.read_bytes()}
    for path in (SCRIPTS / "lib").rglob("*.py"):
        contents["deploy/scripts/" + path.relative_to(SCRIPTS).as_posix()] = path.read_bytes()
    contents[MANIFEST] = json.dumps({
        "schemaVersion": 1, "expected_head_sha": SOURCE,
        "files": [{"path": name, "sha256": digest(raw)} for name, raw in contents.items()],
    }).encode()
    for name, raw in contents.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    root.chmod(0o700)
    archive = directory / "package.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        for name, raw in contents.items():
            member = tarfile.TarInfo(name)
            member.size = len(raw)
            tar.addfile(member, io.BytesIO(raw))
    descriptor = directory / "package.json"
    descriptor.write_text(json.dumps({
        "source_commit": SOURCE, "sha256": digest(archive.read_bytes()),
        "files": {name: digest(raw) for name, raw in contents.items()},
    }))
    profile = directory / "profile.json"
    profile.write_text(json.dumps({"role": role, "expectRuntimeManifest": True}))
    profile.chmod(0o600)
    return {
        "package-manifest": descriptor, "archive": archive, "runtime-root": root,
        "profile": profile, "pin-output": directory / "pin.json",
    }


def run(arguments, *, verify_only=False):
    command = [sys.executable, "-B", str(PRODUCER)]
    for name, value in arguments.items():
        command.extend(["--" + name, str(value)])
    if verify_only:
        command.append("--verify-only")
    result = subprocess.run(command, capture_output=True, text=True, timeout=15,
                            env={"PATH": os.defpath, "HOME": str(arguments["profile"].parent)})
    if result.returncode != 0:
        assert result.stderr.startswith("FATAL health package pin:"), result.stderr
    return result


def assert_consumer_accepts(args):
    directory = args["profile"].parent
    state = directory / "state"
    result = subprocess.run(
        [sys.executable, "-B", str(args["runtime-root"] / CHECKER_MEMBER),
         "--runtime-manifest", "--runtime-package-pin", str(args["pin-output"])],
        capture_output=True, text=True, timeout=15,
        env={"PATH": os.defpath, "HOME": str(directory),
             "BOT_ERRORS_HEALTH_PROFILE": str(args["profile"]),
             "BOT_ERRORS_STATE_DIR": str(state), "BOT_ERRORS_OUTBOX_DIR": str(state / "outbox")},
    )
    assert result.returncode == 0, result.stderr + result.stdout
    lines = result.stdout.splitlines()
    assert f"git_head_sha: {SOURCE} expected={SOURCE} source=package match" in lines
    assert not [line for line in lines if line.startswith(("FAIL ", "WARN "))]
    assert not state.exists()
    assert not (directory / ".local" / "state" / "bot-errors").exists()


@pytest.mark.parametrize("role", ["no-bot", "bot-host"])
def test_produced_pin_is_private_and_accepted_by_consumer(tmp_path, role):
    args = package(tmp_path, role)
    result = run(args)
    assert result.returncode == 0, result.stderr
    pin = args["pin-output"]
    descriptor = json.loads(args["package-manifest"].read_text())
    assert json.loads(pin.read_text()) == {
        "schemaVersion": 1, "owner": "health_reporter", "mode": role,
        "sourceCommit": SOURCE, "archiveSha256": descriptor["sha256"],
        "runtimeManifestSha256": descriptor["files"][MANIFEST],
        "runtimeRootName": args["runtime-root"].name,
    }
    assert pin.stat().st_mode & 0o777 == 0o600
    assert_consumer_accepts(args)


def test_failed_candidate_preserves_current_package_and_accepts_restored_tree(tmp_path):
    current_directory = tmp_path / "current"
    candidate_directory = tmp_path / "candidate"
    current_directory.mkdir(mode=0o700)
    candidate_directory.mkdir(mode=0o700)
    current = package(current_directory)
    candidate = package(candidate_directory, "bot-host")
    result = run(current)
    assert result.returncode == 0, result.stderr
    assert_consumer_accepts(current)
    retained = [current["profile"], current["pin-output"],
                *(path for path in current["runtime-root"].rglob("*") if path.is_file())]
    before = {path: (path.read_bytes(), path.stat().st_mode) for path in retained}
    checker = candidate["runtime-root"] / CHECKER_MEMBER
    original_checker = checker.read_bytes()
    original_profile = candidate["profile"].read_bytes()
    checker.write_bytes(b"corrupt staged checker\n")

    result = run(candidate)

    assert result.returncode == 2
    assert "staged member digest differs" in result.stderr
    assert not candidate["pin-output"].exists()
    assert candidate["profile"].read_bytes() == original_profile
    assert {path: (path.read_bytes(), path.stat().st_mode) for path in retained} == before
    assert_consumer_accepts(current)

    checker.write_bytes(original_checker)
    result = run(candidate)
    assert result.returncode == 0, result.stderr
    assert_consumer_accepts(candidate)
    assert {path: (path.read_bytes(), path.stat().st_mode) for path in retained} == before


def test_repeat_and_verify_only_preserve_existing_pin(tmp_path):
    args = package(tmp_path)
    first = run(args)
    assert first.returncode == 0, first.stderr
    pin = args["pin-output"]
    before = (pin.read_bytes(), pin.stat().st_ino, pin.stat().st_mtime_ns)
    for verify_only in [False, True]:
        result = run(args, verify_only=verify_only)
        assert result.returncode == 0, result.stderr
        assert (pin.read_bytes(), pin.stat().st_ino, pin.stat().st_mtime_ns) == before


def test_verify_only_refuses_missing_pin_without_writing(tmp_path):
    args = package(tmp_path)
    result = run(args, verify_only=True)
    assert result.returncode == 2
    assert "pin" in result.stderr.lower()
    assert not args["pin-output"].exists()


def test_archive_digest_drift_never_publishes_pin(tmp_path):
    args = package(tmp_path)
    with args["archive"].open("ab") as handle:
        handle.write(b"changed archive")
    result = run(args)
    assert result.returncode == 2
    assert "archive" in result.stderr.lower()
    assert not args["pin-output"].exists()


def test_staged_member_digest_drift_never_publishes_pin(tmp_path):
    args = package(tmp_path)
    (args["runtime-root"] / CHECKER_MEMBER).write_text("changed checker")
    result = run(args)
    assert result.returncode == 2
    assert "staged" in result.stderr.lower()
    assert not args["pin-output"].exists()


def test_extra_staged_member_never_publishes_pin(tmp_path):
    args = package(tmp_path)
    (args["runtime-root"] / "unexpected.py").write_text("unexpected code")
    result = run(args)
    assert result.returncode == 2
    assert "membership" in result.stderr.lower()
    assert not args["pin-output"].exists()


@pytest.mark.parametrize("field", ["archive", "runtime-root"])
def test_symlinked_input_is_refused(tmp_path, field):
    args = package(tmp_path)
    directory = tmp_path / "linked-input"
    directory.mkdir(mode=0o700)
    link = directory / args[field].name
    link.symlink_to(args[field])
    args[field] = link
    result = run(args)
    assert result.returncode == 2
    assert not args["pin-output"].exists()


@pytest.mark.parametrize("role", ["simulation", "unknown"])
def test_unsupported_role_is_not_relabelled(tmp_path, role):
    args = package(tmp_path, role)
    before = args["profile"].read_bytes()
    result = run(args)
    assert result.returncode == 2
    assert "role" in result.stderr.lower()
    assert args["profile"].read_bytes() == before
    assert not args["pin-output"].exists()


def test_nonprivate_profile_is_refused(tmp_path):
    args = package(tmp_path)
    args["profile"].chmod(0o644)
    result = run(args)
    assert result.returncode == 2
    assert "private" in result.stderr.lower()
    assert not args["pin-output"].exists()


def test_conflicting_pin_is_preserved(tmp_path):
    args = package(tmp_path)
    pin = args["pin-output"]
    pin.write_text('{"sourceCommit":"different"}\n')
    pin.chmod(0o600)
    before = pin.read_bytes()
    result = run(args)
    assert result.returncode == 2
    assert "pin" in result.stderr.lower()
    assert pin.read_bytes() == before


def test_duplicate_descriptor_key_is_refused(tmp_path):
    args = package(tmp_path)
    path = args["package-manifest"]
    path.write_text('{"source_commit":"' + SOURCE + '",' + path.read_text()[1:])
    result = run(args)
    assert result.returncode == 2
    assert "duplicate" in result.stderr.lower()
    assert not args["pin-output"].exists()


def replace_archive(args, entries):
    with tarfile.open(args["archive"], "w:gz") as archive:
        for member, raw in entries:
            archive.addfile(member, io.BytesIO(raw) if raw is not None else None)
    descriptor = json.loads(args["package-manifest"].read_text())
    descriptor["sha256"] = digest(args["archive"].read_bytes())
    args["package-manifest"].write_text(json.dumps(descriptor))


@properties
@given(kind=st.sampled_from(("duplicate", "traversal", "symlink", "fifo", "oversized")),
       member_index=st.integers(min_value=0, max_value=1023),
       excess_bytes=st.integers(min_value=1, max_value=2048))
@example(kind="duplicate", member_index=0, excess_bytes=1)
@example(kind="traversal", member_index=0, excess_bytes=1)
@example(kind="symlink", member_index=0, excess_bytes=1)
@example(kind="fifo", member_index=0, excess_bytes=1)
@example(kind="oversized", member_index=0, excess_bytes=1)
def test_invalid_archive_members_never_publish_pin(kind, member_index, excess_bytes):
    with private_case() as (directory, _):
        args = package(directory)
        entries = []
        descriptor = json.loads(args["package-manifest"].read_text())
        for name in descriptor["files"]:
            raw = (args["runtime-root"] / name).read_bytes()
            member = tarfile.TarInfo(name)
            member.size = len(raw)
            entries.append((member, raw))
        index = member_index % len(entries)
        if kind == "duplicate":
            entries.append(entries[index])
        else:
            member = tarfile.TarInfo("../outside" if kind == "traversal" else entries[index][0].name)
            raw = None
            if kind == "symlink":
                member.type = tarfile.SYMTYPE
                member.linkname = "/etc/passwd"
            elif kind == "fifo":
                member.type = tarfile.FIFOTYPE
            elif kind == "oversized":
                raw = b"x" * (16 * 1024 * 1024 + excess_bytes)
                member.size = len(raw)
            entries[index] = (member, raw)
        replace_archive(args, entries)
        result = run(args)
        assert result.returncode == 2
        expected_error = ("unsafe package member name" if kind == "traversal"
                          else "archive membership or member type/size differs")
        assert expected_error in result.stderr
        assert not args["pin-output"].exists()
        assert not (directory / "outside").exists()


def test_consistently_packaged_wrong_manifest_source_is_refused(tmp_path):
    args = package(tmp_path)
    manifest = args["runtime-root"] / MANIFEST
    payload = json.loads(manifest.read_text())
    payload["expected_head_sha"] = "b" * 40
    manifest.write_text(json.dumps(payload))
    descriptor = json.loads(args["package-manifest"].read_text())
    descriptor["files"][MANIFEST] = digest(manifest.read_bytes())
    args["package-manifest"].write_text(json.dumps(descriptor))
    entries = []
    for name in descriptor["files"]:
        raw = (args["runtime-root"] / name).read_bytes()
        member = tarfile.TarInfo(name)
        member.size = len(raw)
        entries.append((member, raw))
    replace_archive(args, entries)
    result = run(args)
    assert result.returncode == 2
    assert "source" in result.stderr
    assert not args["pin-output"].exists()


@pytest.mark.parametrize("role", [{"role": "no-bot"}, ["no-bot"]])
def test_malformed_role_has_controlled_refusal(tmp_path, role):
    args = package(tmp_path, role)
    result = run(args)
    assert result.returncode == 2
    assert not args["pin-output"].exists()


def test_pin_inside_package_is_refused_even_with_private_parent(tmp_path):
    args = package(tmp_path)
    args["runtime-root"].chmod(0o700)
    args["pin-output"] = args["runtime-root"] / "pin.json"
    result = run(args)
    assert result.returncode == 2
    assert not args["pin-output"].exists()


def test_unlisted_staged_directory_is_refused(tmp_path):
    args = package(tmp_path)
    (args["runtime-root"] / "unlisted").mkdir()
    result = run(args)
    assert result.returncode == 2
    assert not args["pin-output"].exists()


@pytest.mark.parametrize("mode", [0o755, 0o777])
def test_nonprivate_staged_root_is_refused(tmp_path, mode):
    args = package(tmp_path)
    args["runtime-root"].chmod(mode)
    result = run(args)
    assert result.returncode == 2
    assert "private" in result.stderr
    assert not args["pin-output"].exists()


@pytest.mark.parametrize("kind", ["symlink", "readable-parent"])
def test_unsafe_pin_destination_is_refused(tmp_path, kind):
    args = package(tmp_path)
    outside = tmp_path / "outside.json"
    outside.write_text("preserve me")
    if kind == "symlink":
        args["pin-output"].symlink_to(outside)
    else:
        parent = tmp_path / "public"
        parent.mkdir(mode=0o755)
        args["pin-output"] = parent / "pin.json"
    result = run(args)
    assert result.returncode == 2
    assert outside.read_text() == "preserve me"
    if kind == "symlink":
        assert args["pin-output"].is_symlink()
        assert args["pin-output"].readlink() == outside
    else:
        assert not args["pin-output"].exists()
