from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib
import json
from pathlib import Path
import stat

import pytest


_SOURCE_COMMIT = "a" * 40
_ARC_COMMIT = "b" * 40
_QFLEET_COMMIT = "c" * 40
_POLICY_VERSION = "whatsoup.deployment-policy.v1"


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _write_regular(path: Path, raw: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    path.chmod(mode)


@dataclass
class BundleFixture:
    source_root: Path
    execution_root: Path
    bundle_path: Path
    paths: dict[str, Path]
    payload: dict[str, object]
    expected_sha256: str

    def write_bundle(self, payload: dict[str, object] | None = None) -> str:
        if payload is not None:
            self.payload = payload
        raw = json.dumps(self.payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        _write_regular(self.bundle_path, raw)
        self.expected_sha256 = _sha256(raw)
        return self.expected_sha256


def _fixture(tmp_path: Path) -> BundleFixture:
    source_root = tmp_path / "source-export"
    source_root.mkdir(mode=0o700)
    execution_root = source_root / "qualification"
    execution_root.mkdir(mode=0o700)
    paths = {
        "qualifier": execution_root / "qualify.py",
        "helper": execution_root / "lib" / "health_reader.py",
        "profile": execution_root / "profiles" / "deployment.json",
    }
    _write_regular(paths["qualifier"], b"#!/usr/bin/env python3\nprint('synthetic')\n", 0o700)
    _write_regular(paths["helper"], b"def classify():\n    return 'synthetic'\n")
    _write_regular(paths["profile"], b'{"schema_version":"synthetic.profile.v1"}\n')
    files = []
    for name, path in paths.items():
        relative = path.relative_to(execution_root).as_posix()
        files.append(
            {
                "path": relative,
                "sha256": _sha256(path.read_bytes()),
                "executable": name == "qualifier",
            }
        )
    payload: dict[str, object] = {
        "schema_version": "whatsoup.qualification-bundle.v1",
        "source_commit": _SOURCE_COMMIT,
        "compatibility": {"arc_commit": _ARC_COMMIT, "qfleet_commit": _QFLEET_COMMIT},
        "policy_version": _POLICY_VERSION,
        "execution_root": "qualification",
        "qualifier": "qualify.py",
        "files": files,
    }
    fixture = BundleFixture(
        source_root=source_root,
        execution_root=execution_root,
        bundle_path=source_root / "qualification-bundle.json",
        paths=paths,
        payload=payload,
        expected_sha256="",
    )
    fixture.write_bundle()
    return fixture


def _load(module: object, fixture: BundleFixture, **overrides: object) -> object:
    return module.load_qualification_bundle(
        fixture.source_root,
        fixture.bundle_path,
        expected_sha256=overrides.get("expected_sha256", fixture.expected_sha256),
        expected_source_commit=overrides.get("expected_source_commit", _SOURCE_COMMIT),
        expected_arc_commit=overrides.get("expected_arc_commit", _ARC_COMMIT),
        expected_qfleet_commit=overrides.get("expected_qfleet_commit", _QFLEET_COMMIT),
        expected_policy_version=overrides.get("expected_policy_version", _POLICY_VERSION),
    )


def _inventory_limits(execution_root: Path) -> dict[str, int]:
    entries = 0
    files = 0
    directories = 1
    depth = 0
    aggregate_bytes = 0
    for path in sorted(execution_root.rglob("*")):
        entries += 1
        relative = path.relative_to(execution_root)
        depth = max(depth, len(relative.parts))
        file_stat = path.stat(follow_symlinks=False)
        if stat.S_ISDIR(file_stat.st_mode):
            directories += 1
        elif stat.S_ISREG(file_stat.st_mode):
            files += 1
            aggregate_bytes += file_stat.st_size
    return {
        "entries": entries,
        "files": files,
        "directories": directories,
        "depth": depth,
        "aggregate_bytes": aggregate_bytes,
    }


def _refresh_declared_closure(fixture: BundleFixture) -> None:
    files = []
    for path in sorted(fixture.execution_root.rglob("*")):
        file_stat = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(file_stat.st_mode):
            continue
        files.append(
            {
                "path": path.relative_to(fixture.execution_root).as_posix(),
                "sha256": _sha256(path.read_bytes()),
                "executable": bool(stat.S_IMODE(file_stat.st_mode) & 0o111),
            }
        )
    fixture.write_bundle({**fixture.payload, "files": files})


def _set_inventory_limits(
    module: object,
    monkeypatch: pytest.MonkeyPatch,
    limits: dict[str, int],
) -> None:
    monkeypatch.setattr(module, "_MAX_CLOSURE_ENTRIES", limits["entries"], raising=False)
    monkeypatch.setattr(module, "_MAX_CLOSURE_FILES", limits["files"], raising=False)
    monkeypatch.setattr(module, "_MAX_CLOSURE_DIRECTORIES", limits["directories"], raising=False)
    monkeypatch.setattr(module, "_MAX_CLOSURE_DEPTH", limits["depth"], raising=False)
    monkeypatch.setattr(module, "_MAX_CLOSURE_BYTES", limits["aggregate_bytes"], raising=False)


def _refusal_text(callable_: object, module: object) -> str:
    with pytest.raises(module.QualificationBundleRefusal) as raised:
        callable_()
    return str(raised.value)


def test_loads_exact_bound_bundle_and_rechecks_unchanged_closure(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)

    bundle = _load(module, fixture)

    assert bundle.source_commit == _SOURCE_COMMIT
    assert bundle.qualifier_path == fixture.paths["qualifier"]
    assert bundle.bundle_sha256 == fixture.expected_sha256
    module.recheck_qualification_bundle(bundle)


def test_recheck_refuses_changed_helper(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    bundle = _load(module, fixture)
    _write_regular(fixture.paths["helper"], b"def classify():\n    return 'changed'\n")

    assert _refusal_text(lambda: module.recheck_qualification_bundle(bundle), module) == ""


def test_recheck_refuses_changed_profile(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    bundle = _load(module, fixture)
    _write_regular(fixture.paths["profile"], b'{"schema_version":"changed.profile.v1"}\n')

    assert _refusal_text(lambda: module.recheck_qualification_bundle(bundle), module) == ""


def test_recheck_refuses_changed_qualifier(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    bundle = _load(module, fixture)
    _write_regular(fixture.paths["qualifier"], b"#!/usr/bin/env python3\nprint('changed')\n", 0o700)

    assert _refusal_text(lambda: module.recheck_qualification_bundle(bundle), module) == ""


def test_refuses_closure_mutated_during_initial_observation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    original_read = module._read_regular_file
    changed = False

    def mutate_after_read(root: Path, relative_path: str) -> tuple[bytes, object]:
        nonlocal changed
        raw, identity = original_read(root, relative_path)
        if relative_path == "qualification/lib/health_reader.py" and not changed:
            _write_regular(fixture.paths["helper"], b"def classify():\n    return 'raced'\n")
            changed = True
        return raw, identity

    monkeypatch.setattr(module, "_read_regular_file", mutate_after_read)

    assert _refusal_text(lambda: _load(module, fixture), module) == ""
    assert changed


def test_refuses_bundle_with_a_different_source_commit_even_when_its_digest_is_expected(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    changed = dict(fixture.payload)
    changed["source_commit"] = "d" * 40
    fixture.write_bundle(changed)

    assert _refusal_text(lambda: _load(module, fixture), module) == ""


def test_recheck_refuses_bundle_path_replaced_with_identical_bytes(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    bundle = _load(module, fixture)
    original = fixture.bundle_path.read_bytes()
    fixture.bundle_path.unlink()
    _write_regular(fixture.bundle_path, original)

    assert _refusal_text(lambda: module.recheck_qualification_bundle(bundle), module) == ""


def test_refuses_linked_closure_member(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    target = fixture.source_root / "outside.py"
    _write_regular(target, fixture.paths["helper"].read_bytes())
    fixture.paths["helper"].unlink()
    fixture.paths["helper"].symlink_to(target)

    assert _refusal_text(lambda: _load(module, fixture), module) == ""


def test_refuses_unlisted_executable_in_execution_root(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    _write_regular(fixture.execution_root / "unexpected.py", b"print('synthetic')\n", 0o700)

    assert _refusal_text(lambda: _load(module, fixture), module) == ""


def test_refuses_closure_path_that_escapes_execution_root(tmp_path: Path) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    changed = dict(fixture.payload)
    files = list(changed["files"])
    files[0] = {**files[0], "path": "../escape.py"}
    changed["files"] = files
    fixture.write_bundle(changed)

    assert _refusal_text(lambda: _load(module, fixture), module) == ""


def test_accepts_an_execution_closure_at_each_inclusive_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    limits = _inventory_limits(fixture.execution_root)
    _set_inventory_limits(module, monkeypatch, limits)

    bundle = _load(module, fixture)

    assert len(bundle.declared_file_paths) == limits["files"]


def test_refuses_one_undeclared_entry_over_the_entry_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    limits = _inventory_limits(fixture.execution_root)
    _write_regular(fixture.execution_root / "undeclared.py", b"synthetic\n")
    _set_inventory_limits(module, monkeypatch, {
        "entries": limits["entries"], "files": 32, "directories": 16,
        "depth": 4, "aggregate_bytes": 2 * 1024 * 1024,
    })

    assert _refusal_text(lambda: _load(module, fixture), module) == ""


def test_refuses_one_declared_file_over_the_file_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    limits = _inventory_limits(fixture.execution_root)
    _write_regular(fixture.execution_root / "one-more.py", b"synthetic\n")
    _refresh_declared_closure(fixture)
    _set_inventory_limits(module, monkeypatch, {
        "entries": 64, "files": limits["files"], "directories": 16,
        "depth": 4, "aggregate_bytes": 2 * 1024 * 1024,
    })

    assert _refusal_text(lambda: _load(module, fixture), module) == ""


def test_refuses_one_directory_over_the_directory_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    limits = _inventory_limits(fixture.execution_root)
    _write_regular(fixture.execution_root / "additional" / "member.py", b"synthetic\n")
    _refresh_declared_closure(fixture)
    _set_inventory_limits(module, monkeypatch, {
        "entries": 64, "files": 32, "directories": limits["directories"],
        "depth": 4, "aggregate_bytes": 2 * 1024 * 1024,
    })

    assert _refusal_text(lambda: _load(module, fixture), module) == ""


def test_refuses_one_nesting_level_over_the_depth_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    limits = _inventory_limits(fixture.execution_root)
    _write_regular(fixture.execution_root / "nested" / "inside" / "member.py", b"synthetic\n")
    _refresh_declared_closure(fixture)
    _set_inventory_limits(module, monkeypatch, {
        "entries": 64, "files": 32, "directories": 16,
        "depth": limits["depth"], "aggregate_bytes": 2 * 1024 * 1024,
    })

    assert _refusal_text(lambda: _load(module, fixture), module) == ""


def test_refuses_one_byte_over_the_aggregate_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("deploy.scripts.lib.deployment_qualification_bundle")
    fixture = _fixture(tmp_path)
    limits = _inventory_limits(fixture.execution_root)
    _write_regular(fixture.execution_root / "one-byte.py", b"x")
    _refresh_declared_closure(fixture)
    _set_inventory_limits(module, monkeypatch, {
        "entries": 64, "files": 32, "directories": 16,
        "depth": 4, "aggregate_bytes": limits["aggregate_bytes"],
    })

    assert _refusal_text(lambda: _load(module, fixture), module) == ""
