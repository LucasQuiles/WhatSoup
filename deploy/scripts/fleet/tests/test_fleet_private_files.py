"""Private inventory and shared state reads use bounded, verified file descriptors."""

import importlib.util
import json
import os
from pathlib import Path
import stat
from string import ascii_lowercase, digits
import subprocess
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from hypothesis import given, settings, strategies as st
import pytest


FLEET = Path(__file__).resolve().parents[1]


def load_module(filename):
    spec = importlib.util.spec_from_file_location("private_file_test_" + filename, FLEET / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def private_file(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")
    path.chmod(0o600)
    return path


@pytest.mark.parametrize("kind", ["public", "group", "symlink", "hardlink", "directory", "oversized", "owner", "parent_symlink", "writable_parent"])
@settings(max_examples=8)
@given(host=st.text(alphabet=ascii_lowercase + digits, min_size=1, max_size=24))
def test_inventory_rejects_unsafe_file_before_accepting_a_target(kind, host):
    probe = load_module("fleet_probe.py")
    with TemporaryDirectory() as directory:
        root = Path(directory)
        inventory = private_file(root / "targets.json", {host: {"local": True}})
        path = inventory
        if kind == "public":
            path.chmod(0o644)
        elif kind == "group":
            path.chmod(0o640)
        elif kind == "symlink":
            path = root / "linked.json"
            path.symlink_to(inventory)
        elif kind == "hardlink":
            path = root / "linked.json"
            os.link(inventory, path)
        elif kind == "directory":
            path = root
        elif kind == "oversized":
            with path.open("a") as stream:
                stream.write(" " * (1024 * 1024))
        elif kind == "parent_symlink":
            alias = root / "alias"
            alias.symlink_to(root, target_is_directory=True)
            path = alias / inventory.name
        elif kind == "writable_parent":
            root.chmod(0o777)
        if kind == "owner":
            identity = inventory.stat()
            original_fstat = os.fstat
            checked_leaf = False

            def different_owner(fd):
                nonlocal checked_leaf
                info = original_fstat(fd)
                if (info.st_dev, info.st_ino) == (identity.st_dev, identity.st_ino):
                    # A real ownership change would require elevated permissions.
                    fields = list(info)
                    fields[4] = info.st_uid + 1
                    checked_leaf = True
                    return os.stat_result(fields)
                return info

            with patch("os.fstat", side_effect=different_owner):
                with pytest.raises((OSError, ValueError)):
                    probe.load_target(path, host)
            assert checked_leaf
        else:
            with pytest.raises((OSError, ValueError)):
                probe.load_target(path, host)


@pytest.mark.parametrize("extra_bytes", [0, 1])
def test_private_reader_applies_size_limit_to_utf8_bytes(tmp_path, extra_bytes):
    supervisor = load_module("reliability_supervisor.py")
    value = {"label": "é"}
    raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
    path = tmp_path / "boundary.json"
    path.write_bytes(raw + b" " * (1024 * 1024 - len(raw) + extra_bytes))
    path.chmod(0o600)
    if extra_bytes:
        with pytest.raises(supervisor.StateError, match="state_file_unsafe"):
            supervisor.read_private(path)
    else:
        assert supervisor.read_private(path) == value


def test_private_reader_accepts_root_owned_sticky_temporary_directory():
    supervisor = load_module("reliability_supervisor.py")
    shared = Path("/tmp").stat()
    assert shared.st_uid == 0 and shared.st_mode & stat.S_ISVTX
    with TemporaryDirectory(dir="/tmp") as directory:
        value = {"source": "private-child-of-shared-temporary-directory"}
        path = private_file(Path(directory) / "state.json", value)
        assert supervisor.read_private(path) == value


@pytest.mark.skipif(sys.platform != "darwin", reason="Darwin root aliases are specific to macOS")
@pytest.mark.parametrize("alias", ["tmp", "var", "etc"])
@settings(max_examples=8)
@given(name=st.text(alphabet=ascii_lowercase + digits, min_size=1, max_size=24))
def test_private_reader_accepts_only_the_verified_darwin_root_alias(alias, name):
    supervisor = load_module("reliability_supervisor.py")
    expected = (Path("/private") / alias).stat()
    filename = name + ".json"
    with supervisor.private_parent(Path("/") / alias / filename) as (fd, leaf):
        actual = os.fstat(fd)
        assert (actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino)
        assert leaf == filename


def test_private_reader_classifies_malformed_utf8_as_invalid(tmp_path):
    supervisor = load_module("reliability_supervisor.py")
    path = tmp_path / "invalid.json"
    path.write_bytes(b'{"label":"\xff"}')
    path.chmod(0o600)
    with pytest.raises(supervisor.StateError, match="state_invalid"):
        supervisor.read_private(path)


def test_private_reader_rejects_growth_after_metadata_check(tmp_path, monkeypatch):
    supervisor = load_module("reliability_supervisor.py")
    path = private_file(tmp_path / "state.json", {"schema_version": 1})
    identity = path.stat()
    original_fstat = os.fstat
    expanded = False

    def fstat(fd):
        nonlocal expanded
        info = original_fstat(fd)
        if not expanded and (info.st_dev, info.st_ino) == (identity.st_dev, identity.st_ino):
            with path.open("a") as stream:
                stream.write(" " * (1024 * 1024))
            expanded = True
        return info

    monkeypatch.setattr(os, "fstat", fstat)
    with pytest.raises(supervisor.StateError, match="state_file_unsafe"):
        supervisor.read_private(path)
    assert expanded


def test_private_reader_keeps_the_validated_descriptor_after_path_replacement(tmp_path, monkeypatch):
    supervisor = load_module("reliability_supervisor.py")
    original = {"schema_version": 1, "source": "original"}
    path = private_file(tmp_path / "state.json", original)
    identity = path.stat()
    original_fstat = os.fstat
    replaced = False

    def fstat(fd):
        nonlocal replaced
        info = original_fstat(fd)
        if not replaced and (info.st_dev, info.st_ino) == (identity.st_dev, identity.st_ino):
            path.rename(tmp_path / "saved.json")
            private_file(path, {"schema_version": 1, "source": "replacement"})
            replaced = True
        return info

    monkeypatch.setattr(os, "fstat", fstat)
    assert supervisor.read_private(path) == original
    assert replaced


def test_private_reader_keeps_parent_descriptor_after_directory_replacement(tmp_path, monkeypatch):
    supervisor = load_module("reliability_supervisor.py")
    parent = tmp_path / "parent"
    parent.mkdir(mode=0o700)
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    original = {"source": "original"}
    path = private_file(parent / "state.json", original)
    private_file(outside / "state.json", {"source": "replacement"})
    identity = parent.stat()
    original_fstat = os.fstat
    replaced = False

    def fstat(fd):
        nonlocal replaced
        info = original_fstat(fd)
        if not replaced and (info.st_dev, info.st_ino) == (identity.st_dev, identity.st_ino):
            parent.rename(tmp_path / "saved-parent")
            parent.symlink_to(outside, target_is_directory=True)
            replaced = True
        return info

    monkeypatch.setattr(os, "fstat", fstat)
    assert supervisor.read_private(path) == original
    assert replaced, "the read must hold and validate the parent directory"


def test_private_reader_refuses_fifo_without_waiting_for_a_writer(tmp_path):
    path = tmp_path / "pipe"
    os.mkfifo(path, 0o600)
    code = """
import pathlib, runpy, sys
module = runpy.run_path(sys.argv[1])
try:
    module['read_private'](pathlib.Path(sys.argv[2]))
except module['StateError'] as exc:
    print(str(exc))
else:
    raise AssertionError('FIFO was accepted')
"""
    result = subprocess.run(
        [sys.executable, "-B", "-c", code, str(FLEET / "reliability_supervisor.py"), str(path)],
        capture_output=True, text=True, timeout=5, check=True,
    )
    assert result.stdout.strip() == "state_file_unsafe"


def test_private_reader_classifies_deep_json_as_invalid(tmp_path):
    supervisor = load_module("reliability_supervisor.py")
    path = tmp_path / "deep.json"
    path.write_text("[" * 10000 + "0" + "]" * 10000)
    path.chmod(0o600)
    with pytest.raises(supervisor.StateError, match="state_invalid"):
        supervisor.read_private(path)


def test_unsafe_inventory_returns_failure_without_starting_transport(tmp_path, capsys):
    probe = load_module("fleet_probe.py")
    inventory = private_file(tmp_path / "targets.json", {"local": {"local": True}})
    inventory.chmod(0o644)
    with patch.object(probe, "run_target", side_effect=AssertionError("transport started")):
        assert probe.main(["--targets", str(inventory), "--target", "local"]) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["checks"] == {"ssh_reachable": False}
    assert result["codes"] == ["probe_transport_or_execution_failed"]


@pytest.mark.parametrize("operation", ["create", "preflight", "write"])
@pytest.mark.parametrize("unsafe", ["symlink", "writable", "other_owner"])
@settings(max_examples=4)
@given(name=st.text(alphabet=ascii_lowercase, min_size=1, max_size=20))
def test_state_operations_reject_unsafe_ancestors(operation, unsafe, name):
    supervisor = load_module("reliability_supervisor.py")
    with TemporaryDirectory() as directory:
        root = Path(directory)
        parent = root / "parent"
        parent.mkdir(mode=0o700)
        state = parent / name
        if operation != "create":
            state.mkdir(mode=0o700)
        configured = state
        if unsafe == "symlink":
            alias = root / "alias"
            alias.symlink_to(parent, target_is_directory=True)
            configured = alias / name
        elif unsafe == "writable":
            parent.chmod(0o777)
        identity = parent.stat()
        original_fstat = os.fstat
        checked_parent = False

        def fstat(fd):
            nonlocal checked_parent
            info = original_fstat(fd)
            if unsafe == "other_owner" and (info.st_dev, info.st_ino) == (identity.st_dev, identity.st_ino):
                # Simulate foreign ownership without changing real host ownership.
                fields = list(info)
                fields[4] = info.st_uid + 1
                checked_parent = True
                return os.stat_result(fields)
            return info

        with patch("os.fstat", side_effect=fstat):
            with pytest.raises((OSError, supervisor.StateError)):
                if operation == "write":
                    supervisor.write_private(configured / "state.json", {"synthetic": name})
                else:
                    supervisor.private_directory(configured, create=operation == "create")
        if unsafe == "other_owner":
            assert checked_parent
        if operation == "create":
            assert not state.exists()
        assert not (state / "state.json").exists()


def test_private_directory_creates_nested_private_directories(tmp_path):
    supervisor = load_module("reliability_supervisor.py")
    path = tmp_path / "new-parent" / "state"
    supervisor.private_directory(path)
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(path.stat().st_mode) == 0o700
    assert path.stat().st_uid == os.getuid()


def test_private_directory_preflight_does_not_create_missing_parents(tmp_path):
    supervisor = load_module("reliability_supervisor.py")
    path = tmp_path / "new-parent" / "state"
    supervisor.private_directory(path, create=False)
    assert not path.parent.exists()


def test_private_directory_creation_stays_in_opened_parent(tmp_path, monkeypatch):
    supervisor = load_module("reliability_supervisor.py")
    parent = tmp_path / "parent"
    parent.mkdir(mode=0o700)
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    saved = tmp_path / "saved-parent"
    original_mkdir = os.mkdir
    replaced = False

    def mkdir(path, mode=0o777, *, dir_fd=None):
        nonlocal replaced
        if not replaced and Path(path).name == "state":
            parent.rename(saved)
            parent.symlink_to(outside, target_is_directory=True)
            replaced = True
        return original_mkdir(path, mode, dir_fd=dir_fd)

    monkeypatch.setattr(os, "mkdir", mkdir)
    supervisor.private_directory(parent / "state")
    assert replaced
    assert (saved / "state").is_dir()
    assert not (outside / "state").exists()


def test_private_write_stays_in_opened_parent_after_file_sync(tmp_path, monkeypatch):
    supervisor = load_module("reliability_supervisor.py")
    parent = tmp_path / "parent"
    parent.mkdir(mode=0o700)
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o700)
    saved = tmp_path / "saved-parent"
    value = {"source": "new-state"}
    private_file(parent / "state.json", {"source": "old-state"})
    original_fsync = os.fsync
    replaced = False

    def fsync(fd):
        nonlocal replaced
        original_fsync(fd)
        if not replaced and stat.S_ISREG(os.fstat(fd).st_mode):
            parent.rename(saved)
            parent.symlink_to(outside, target_is_directory=True)
            replaced = True

    monkeypatch.setattr(os, "fsync", fsync)
    supervisor.write_private(parent / "state.json", value)
    assert replaced
    assert json.loads((saved / "state.json").read_text()) == value
    assert {p.name for p in saved.iterdir()} == {"state.json"}
    assert not list(outside.iterdir())


@pytest.mark.parametrize("failure", ["serialization", "replacement"])
def test_private_write_failure_preserves_state_and_removes_owned_temporary(tmp_path, monkeypatch, failure):
    supervisor = load_module("reliability_supervisor.py")
    path = private_file(tmp_path / "state.json", {"source": "old-state"})
    before = path.read_bytes()
    if failure == "serialization":
        value = {"invalid": float("nan")}
        expected = ValueError
    else:
        value = {"source": "new-state"}
        expected = PermissionError

        def refuse_replace(*args, **kwargs):
            raise PermissionError("synthetic replace failure")

        monkeypatch.setattr(os, "replace", refuse_replace)
    with pytest.raises(expected):
        supervisor.write_private(path, value)
    assert path.read_bytes() == before
    assert {p.name for p in tmp_path.iterdir()} == {"state.json"}


def test_private_write_does_not_remove_a_preexisting_temporary_name(tmp_path, monkeypatch):
    supervisor = load_module("reliability_supervisor.py")
    path = private_file(tmp_path / "state.json", {"source": "old-state"})
    temporary = private_file(tmp_path / ".state.json.collision.tmp", {"source": "another-writer"})
    before = {p.name: p.read_bytes() for p in (path, temporary)}
    monkeypatch.setattr(supervisor, "uuid4", lambda: SimpleNamespace(hex="collision"))
    with pytest.raises(FileExistsError):
        supervisor.write_private(path, {"source": "new-state"})
    assert {p.name: p.read_bytes() for p in tmp_path.iterdir()} == before


def test_private_write_reports_directory_sync_failure_after_replacement(tmp_path, monkeypatch):
    supervisor = load_module("reliability_supervisor.py")
    path = private_file(tmp_path / "state.json", {"source": "old-state"})
    value = {"source": "new-state"}
    original_fsync = os.fsync

    def fsync(fd):
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            raise OSError("synthetic directory sync failure")
        original_fsync(fd)

    monkeypatch.setattr(os, "fsync", fsync)
    with pytest.raises(OSError, match="synthetic directory sync failure"):
        supervisor.write_private(path, value)
    assert json.loads(path.read_text()) == value
    assert {p.name for p in tmp_path.iterdir()} == {"state.json"}


@pytest.mark.parametrize("temporary_root", ["/tmp", "/var/tmp"])
def test_private_creation_and_write_support_shared_temporary_roots(temporary_root):
    supervisor = load_module("reliability_supervisor.py")
    with TemporaryDirectory(dir=temporary_root) as directory:
        state = Path(directory) / "new-parent" / "state"
        supervisor.private_directory(state, create=False)
        assert not state.parent.exists()
        supervisor.private_directory(state)
        value = {"source": "private-state"}
        supervisor.write_private(state / "state.json", value)
        assert supervisor.read_private(state / "state.json") == value
        assert stat.S_IMODE(state.stat().st_mode) == 0o700
        assert stat.S_IMODE((state / "state.json").stat().st_mode) == 0o600
