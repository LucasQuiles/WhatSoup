"""Regression coverage for declared export-only health runtimes.

The production change that makes these tests fail is accepting a no-Git runtime
without both the installer's source identity convention and a clean hash-bound
manifest that covers the running health checker.
"""
from __future__ import annotations

from contextlib import redirect_stdout
from io import StringIO
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from hypothesis import example, given, strategies as st

from bot_errors_property_support import private_case, properties


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-health-check.py"
_SOURCE_SHA = "a" * 40
_ARCHIVE_SHA = "b" * 64
_PIN_OWNER = "health_reporter"
_PIN_MODE = "no-bot"


def _load_module():
    spec = importlib.util.spec_from_file_location("bot_errors_health_package", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_manifest(root: Path, files: list[dict[str, object]], expected: str = _SOURCE_SHA) -> Path:
    manifest_path = root / "deploy" / "bot-errors-runtime-manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "expected_head_sha": expected,
                "files": files,
            }
        ),
        encoding="utf-8",
    )
    return manifest_path


def _write_package_pin(pin_path: Path, root: Path, manifest_path: Path) -> None:
    pin_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "owner": _PIN_OWNER,
                "mode": _PIN_MODE,
                "sourceCommit": _SOURCE_SHA,
                "archiveSha256": _ARCHIVE_SHA,
                "runtimeManifestSha256": _sha256(manifest_path),
                "runtimeRootName": root.name,
            }
        ),
        encoding="utf-8",
    )
    pin_path.chmod(0o600)


def _declared_package(tmp_path: Path, monkeypatch, root_name: str | None = None):
    root = tmp_path / (root_name or f"WhatSoup-health-{_SOURCE_SHA[:12]}")
    checker = root / "deploy" / "scripts" / "bot-errors-health-check.py"
    checker.parent.mkdir(parents=True)
    checker.write_bytes(_SCRIPT.read_bytes())
    pin_path = tmp_path / "health-package-pin.json"
    module = _load_module()
    monkeypatch.setattr(module, "REPO_ROOT", root)
    monkeypatch.setattr(module, "__file__", str(checker))
    monkeypatch.setattr(module, "RUNTIME_PACKAGE_PIN_PATH", pin_path, raising=False)
    return module, root, checker, pin_path


def _entries(checker: Path) -> list[dict[str, object]]:
    return [{"path": "deploy/scripts/bot-errors-health-check.py", "sha256": _sha256(checker)}]


def _inventory(module) -> list[str]:
    return module.runtime_manifest_inventory({"expectRuntimeManifest": True, "role": _PIN_MODE})


def test_declared_package_reports_source_sha_without_a_git_checkout(tmp_path, monkeypatch):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    manifest_path = _write_manifest(root, _entries(checker))
    _write_package_pin(pin_path, root, manifest_path)

    lines = _inventory(module)

    assert f"git_head_sha: {_SOURCE_SHA} expected={_SOURCE_SHA} source=package match" in lines
    assert "WARN git_head_sha: not_a_git_repository" not in lines
    assert not [line for line in lines if line.startswith("FAIL runtime_manifest")]


@properties
@given(flag=st.sampled_from([False, None, 0, "false", "off", ""]), pin_present=st.booleans())
@example(flag=False, pin_present=False)
@example(flag=None, pin_present=True)
def test_package_cannot_disable_manifest_validation_in_profile(flag, pin_present):
    with private_case() as (tmp_path, monkeypatch):
        module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
        manifest_path = _write_manifest(root, _entries(checker))
        if pin_present:
            _write_package_pin(pin_path, root, manifest_path)
        profile = {"role": _PIN_MODE}
        if flag is not None:
            profile["expectRuntimeManifest"] = flag
        monkeypatch.setattr(module, "load_health_profile", lambda: profile)
        monkeypatch.setattr(module.sys, "argv", [str(_SCRIPT), "--runtime-manifest"])
        output = StringIO()

        with redirect_stdout(output):
            exit_code = module.main()

        assert exit_code == 2
        assert "FAIL runtime_manifest package_source: profile_manifest_required" in output.getvalue()
        assert "skipped by health profile" not in output.getvalue()


def test_nonpackage_profile_can_still_disable_manifest_validation(tmp_path, monkeypatch):
    module = _load_module()
    monkeypatch.setattr(module, "REPO_ROOT", tmp_path / "ordinary-checkout")

    assert module.runtime_manifest_inventory({"expectRuntimeManifest": False}) == [
        "runtime_manifest: skipped by health profile",
    ]


@properties
@given(parent=st.booleans(), during_hash=st.booleans())
@example(parent=False, during_hash=False)
@example(parent=True, during_hash=False)
@example(parent=False, during_hash=True)
@example(parent=True, during_hash=True)
def test_package_rejects_file_or_parent_replacement_during_verification(parent, during_hash):
    with private_case() as (tmp_path, monkeypatch):
        module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
        payload = root / "assets" / "payload.txt"
        payload.parent.mkdir()
        content = b"package race regression payload\n"
        payload.write_bytes(content)
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / payload.name).write_bytes(content)
        manifest_path = _write_manifest(root, [*_entries(checker), {
            "path": "assets/payload.txt", "sha256": _sha256(payload),
            "mustContain": ["race regression"],
        }])
        _write_package_pin(pin_path, root, manifest_path)
        changed = False

        def replace_path():
            nonlocal changed
            if changed:
                return
            changed = True
            target = payload.parent if parent else payload
            target.rename(target.with_name(target.name + ".retained"))
            target.symlink_to(outside if parent else outside / payload.name)

        original_path = module.runtime_manifest_entry_path

        def entry_path(raw_path):
            result = original_path(raw_path)
            if raw_path == "assets/payload.txt" and not during_hash:
                replace_path()
            return result

        monkeypatch.setattr(module, "runtime_manifest_entry_path", entry_path)
        original_sha256 = module.hashlib.sha256

        class ReplacingDigest:
            def __init__(self, data=b""):
                self.digest = original_sha256(data)

            def update(self, data):
                self.digest.update(data)
                if during_hash and data == content:
                    replace_path()

            def hexdigest(self):
                return self.digest.hexdigest()

        monkeypatch.setattr(module.hashlib, "sha256", ReplacingDigest)
        lines = _inventory(module)

        assert changed
        assert any(line.startswith("FAIL runtime_manifest") for line in lines)
        assert not any("source=package match" in line for line in lines)
        assert (outside / payload.name).read_bytes() == content


def test_package_pin_binds_the_manifest_bytes_used_for_inventory(tmp_path, monkeypatch):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    payload = root / "deploy" / "payload.txt"
    payload.write_bytes(b"original package content\n")
    manifest_path = _write_manifest(root, [*_entries(checker), {
        "path": "deploy/payload.txt", "sha256": _sha256(payload),
    }])
    pinned_manifest = manifest_path.read_bytes()
    _write_package_pin(pin_path, root, manifest_path)
    payload.write_bytes(b"changed package content\n")
    _write_manifest(root, [*_entries(checker), {
        "path": "deploy/payload.txt", "sha256": _sha256(payload),
    }])
    original_path = module.runtime_manifest_entry_path

    def restore_pinned_manifest(raw_path):
        result = original_path(raw_path)
        if raw_path == "deploy/bot-errors-runtime-manifest.json":
            manifest_path.write_bytes(pinned_manifest)
        return result

    monkeypatch.setattr(module, "runtime_manifest_entry_path", restore_pinned_manifest)
    lines = _inventory(module)

    assert any(line.startswith("FAIL runtime_manifest") for line in lines)
    assert not any("source=package match" in line for line in lines)
    assert payload.read_bytes() == b"changed package content\n"


@properties
@given(explicit=st.booleans(), nested=st.booleans())
@example(explicit=True, nested=False)
@example(explicit=True, nested=True)
@example(explicit=False, nested=False)
@example(explicit=False, nested=True)
def test_package_consumer_rejects_a_pin_inside_the_runtime(explicit, nested):
    with private_case() as (tmp_path, monkeypatch):
        module, root, checker, external_pin = _declared_package(tmp_path, monkeypatch)
        manifest_path = _write_manifest(root, _entries(checker))
        _write_package_pin(external_pin, root, manifest_path)
        assert f"git_head_sha: {_SOURCE_SHA} expected={_SOURCE_SHA} source=package match" in _inventory(module)
        pin = root / "private" / "pin.json" if nested else root / "pin.json"
        pin.parent.mkdir(exist_ok=True, mode=0o700)
        pin.parent.chmod(0o700)
        _write_package_pin(pin, root, manifest_path)
        if not explicit:
            monkeypatch.setattr(module, "RUNTIME_PACKAGE_PIN_PATH", pin)
        lines = module.runtime_manifest_inventory(
            {"expectRuntimeManifest": True, "role": _PIN_MODE},
            package_pin_path=pin if explicit else None,
        )
        assert "FAIL runtime_manifest package_source: pin_inside_runtime_root" in lines
        assert not [line for line in lines if "source=package match" in line]


@properties
@given(pin_state=st.sampled_from(["missing", "wrong_digest", "valid"]))
@example(pin_state="missing")
@example(pin_state="wrong_digest")
@example(pin_state="valid")
def test_package_under_matching_parent_repository_still_requires_external_pin(pin_state):
    with private_case() as (tmp_path, monkeypatch):
        def git(*args: str, input_text: str | None = None) -> str:
            return subprocess.run(
                ["git", "-C", str(tmp_path), *args], input=input_text,
                text=True, capture_output=True, check=True, timeout=10,
            ).stdout.strip()

        git("init", "--quiet")
        tree = git("mktree", input_text="")
        head = git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
                   "commit-tree", tree, input_text="fixture\n")
        git("update-ref", "HEAD", head)
        monkeypatch.setattr(sys.modules[__name__], "_SOURCE_SHA", head)
        module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
        manifest_path = _write_manifest(root, _entries(checker), expected=head)
        if pin_state != "missing":
            _write_package_pin(pin_path, root, manifest_path)
            if pin_state == "wrong_digest":
                pin = json.loads(pin_path.read_text())
                pin["runtimeManifestSha256"] = "0" * 64
                pin_path.write_text(json.dumps(pin))
        assert module._run_git_rev_parse(root)[0].strip() == head

        lines = _inventory(module)
        if pin_state == "valid":
            assert f"git_head_sha: {head} expected={head} source=package match" in lines
            assert not [line for line in lines if line.startswith("FAIL ")]
        else:
            reason = "pin_missing" if pin_state == "missing" else "manifest_digest_mismatch"
            assert f"FAIL runtime_manifest package_source: {reason}" in lines


def test_declared_package_without_running_checker_binding_fails(tmp_path, monkeypatch):
    module, root, _checker, pin_path = _declared_package(tmp_path, monkeypatch)
    payload = root / "deploy" / "payload.txt"
    payload.write_text("package payload\n", encoding="utf-8")
    manifest_path = _write_manifest(root, [{"path": "deploy/payload.txt", "sha256": _sha256(payload)}])
    _write_package_pin(pin_path, root, manifest_path)

    lines = _inventory(module)

    assert "FAIL runtime_manifest package_source: running_checker_not_manifested" in lines


def test_declared_package_with_corrupt_required_file_fails(tmp_path, monkeypatch):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    payload = root / "deploy" / "payload.txt"
    payload.write_text("corrupt payload\n", encoding="utf-8")
    _write_manifest(
        root,
        [
            *_entries(checker),
            {"path": "deploy/payload.txt", "sha256": "0" * 64},
        ],
    )

    manifest_path = root / "deploy" / "bot-errors-runtime-manifest.json"
    _write_package_pin(pin_path, root, manifest_path)
    lines = _inventory(module)

    assert any(line.startswith("FAIL runtime_manifest deploy/payload.txt: sha256=") for line in lines)
    assert "FAIL runtime_manifest package_source: required_file_hash_failure" in lines


def test_declared_package_rejects_manifest_path_that_escapes_runtime_root(tmp_path, monkeypatch):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    outside = tmp_path / "outside.txt"
    outside.write_text("outside root\n", encoding="utf-8")
    _write_manifest(
        root,
        [
            *_entries(checker),
            {"path": "../outside.txt", "sha256": _sha256(outside)},
        ],
    )

    manifest_path = root / "deploy" / "bot-errors-runtime-manifest.json"
    _write_package_pin(pin_path, root, manifest_path)
    lines = _inventory(module)

    assert "FAIL runtime_manifest ../outside.txt: path_escapes_runtime_root" in lines
    assert "FAIL runtime_manifest package_source: required_file_hash_failure" in lines


def test_declared_package_rejects_manifest_path_reached_through_symlink(tmp_path, monkeypatch):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    outside = tmp_path / "outside.txt"
    outside.write_text("outside root\n", encoding="utf-8")
    escaped = root / "deploy" / "escaped.txt"
    escaped.symlink_to(outside)
    _write_manifest(
        root,
        [
            *_entries(checker),
            {"path": "deploy/escaped.txt", "sha256": _sha256(outside)},
        ],
    )

    manifest_path = root / "deploy" / "bot-errors-runtime-manifest.json"
    _write_package_pin(pin_path, root, manifest_path)
    lines = _inventory(module)

    assert "FAIL runtime_manifest deploy/escaped.txt: symlinked_path" in lines
    assert "FAIL runtime_manifest package_source: required_file_hash_failure" in lines


def test_pin_for_another_runtime_does_not_reclassify_a_legacy_export(tmp_path, monkeypatch):
    root = tmp_path / "unrelated-runtime"
    checker = root / "deploy" / "scripts" / "bot-errors-health-check.py"
    checker.parent.mkdir(parents=True)
    checker.write_bytes(_SCRIPT.read_bytes())
    pin_path = tmp_path / "health-package-pin.json"
    module = _load_module()
    monkeypatch.setattr(module, "REPO_ROOT", root)
    monkeypatch.setattr(module, "__file__", str(checker))
    monkeypatch.setattr(module, "RUNTIME_PACKAGE_PIN_PATH", pin_path, raising=False)
    manifest_path = _write_manifest(root, _entries(checker))
    _write_package_pin(pin_path, root, manifest_path)

    lines = _inventory(module)

    assert "WARN git_head_sha: not_a_git_repository" in lines
    assert not [line for line in lines if "package_source:" in line]


def test_health_prefix_without_an_exact_source_root_remains_a_legacy_export(tmp_path, monkeypatch):
    root = tmp_path / "WhatSoup-health-not-a-source-identity"
    checker = root / "deploy" / "scripts" / "bot-errors-health-check.py"
    checker.parent.mkdir(parents=True)
    checker.write_bytes(_SCRIPT.read_bytes())
    pin_path = tmp_path / "health-package-pin.json"
    module = _load_module()
    monkeypatch.setattr(module, "REPO_ROOT", root)
    monkeypatch.setattr(module, "__file__", str(checker))
    monkeypatch.setattr(module, "RUNTIME_PACKAGE_PIN_PATH", pin_path, raising=False)
    manifest_path = _write_manifest(root, _entries(checker))
    _write_package_pin(pin_path, root, manifest_path)

    lines = _inventory(module)

    assert "WARN git_head_sha: not_a_git_repository" in lines
    assert not [line for line in lines if "package_source:" in line]


def test_recognized_package_rejects_pin_with_wrong_root_binding(tmp_path, monkeypatch):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    manifest_path = _write_manifest(root, _entries(checker))
    _write_package_pin(pin_path, root, manifest_path)
    pin = json.loads(pin_path.read_text(encoding="utf-8"))
    pin["runtimeRootName"] = "WhatSoup-health-cccccccccccc"
    pin_path.write_text(json.dumps(pin), encoding="utf-8")

    lines = _inventory(module)

    assert "FAIL runtime_manifest package_source: root_does_not_bind_expected_head" in lines


def test_declared_package_without_external_pin_fails(tmp_path, monkeypatch):
    module, root, checker, _pin_path = _declared_package(tmp_path, monkeypatch)
    _write_manifest(root, _entries(checker))

    lines = _inventory(module)

    assert "FAIL runtime_manifest package_source: pin_missing" in lines


def test_declared_package_rejects_manifest_changed_after_external_pin(tmp_path, monkeypatch):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    manifest_path = _write_manifest(root, _entries(checker))
    _write_package_pin(pin_path, root, manifest_path)
    _write_manifest(root, _entries(checker), expected="c" * 40)

    lines = _inventory(module)

    assert "FAIL runtime_manifest package_source: manifest_digest_mismatch" in lines


def test_declared_package_rejects_duplicate_manifest_entries(tmp_path, monkeypatch):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    manifest_path = _write_manifest(root, [*_entries(checker), *_entries(checker)])
    _write_package_pin(pin_path, root, manifest_path)

    lines = _inventory(module)

    assert "FAIL runtime_manifest deploy/scripts/bot-errors-health-check.py: duplicate path" in lines
    assert "FAIL runtime_manifest package_source: required_file_hash_failure" in lines


def test_declared_package_rejects_source_commit_that_disagrees_with_manifest(tmp_path, monkeypatch):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    manifest_path = _write_manifest(root, _entries(checker), expected="c" * 40)
    _write_package_pin(pin_path, root, manifest_path)

    lines = _inventory(module)

    assert "FAIL runtime_manifest package_source: manifest_expected_head_mismatch" in lines


def test_declared_package_rejects_malformed_external_pin_identity(tmp_path, monkeypatch):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    manifest_path = _write_manifest(root, _entries(checker))
    _write_package_pin(pin_path, root, manifest_path)
    pin = json.loads(pin_path.read_text(encoding="utf-8"))
    pin["archiveSha256"] = "not-a-sha"
    pin_path.write_text(json.dumps(pin), encoding="utf-8")

    lines = _inventory(module)

    assert "FAIL runtime_manifest package_source: pin_identity_invalid" in lines


def test_checkout_mode_keeps_git_head_semantics_even_when_a_package_pin_exists(tmp_path, monkeypatch):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch, root_name="checkout")
    manifest_path = _write_manifest(root, _entries(checker))
    _write_package_pin(pin_path, root, manifest_path)

    monkeypatch.setattr(module, "_run_git_rev_parse", lambda _root: (_SOURCE_SHA + "\n", "", 0))
    lines = _inventory(module)

    assert f"git_head_sha: {_SOURCE_SHA} expected={_SOURCE_SHA} match" in lines
    assert not [line for line in lines if "source=package" in line]


def test_runtime_manifest_cli_prints_the_read_only_package_inventory(tmp_path, monkeypatch, capsys):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    manifest_path = _write_manifest(root, _entries(checker))
    _write_package_pin(pin_path, root, manifest_path)
    monkeypatch.setattr(module, "load_health_profile", lambda: {"expectRuntimeManifest": True, "role": _PIN_MODE})
    monkeypatch.setattr(module.sys, "argv", [str(_SCRIPT), "--runtime-manifest"])

    exit_code = module.main()

    captured = capsys.readouterr()
    assert exit_code == 0
    assert f"git_head_sha: {_SOURCE_SHA} expected={_SOURCE_SHA} source=package match" in captured.out


def test_runtime_manifest_cli_fails_for_a_checkout_head_mismatch(tmp_path, monkeypatch, capsys):
    module, root, checker, _pin_path = _declared_package(tmp_path, monkeypatch, root_name="checkout")
    _write_manifest(root, _entries(checker))
    monkeypatch.setattr(module, "load_health_profile", lambda: {"expectRuntimeManifest": True, "role": _PIN_MODE})
    monkeypatch.setattr(module, "_run_git_rev_parse", lambda _root: ("c" * 40 + "\n", "", 0))
    monkeypatch.setattr(module.sys, "argv", [str(_SCRIPT), "--runtime-manifest"])

    exit_code = module.main()

    captured = capsys.readouterr()
    assert exit_code == 2
    assert f"FAIL git_head_sha: {'c' * 40} expected={_SOURCE_SHA} git_head_sha_mismatch" in captured.out


@properties
@given(git_failure=st.sampled_from(['malformed_head', 'git_unavailable', 'git_timeout', 'git_failed']))
@example(git_failure='malformed_head')
@example(git_failure='git_unavailable')
@example(git_failure='git_timeout')
@example(git_failure='git_failed')
def test_runtime_manifest_cli_rejects_package_when_git_provenance_is_malformed_or_unavailable(git_failure):
    with private_case() as (tmp_path, monkeypatch):
        module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
        manifest_path = _write_manifest(root, _entries(checker))
        _write_package_pin(pin_path, root, manifest_path)
        monkeypatch.setattr(module, "load_health_profile", lambda: {"expectRuntimeManifest": True, "role": _PIN_MODE})
        if git_failure == "malformed_head":
            _write_manifest(root, _entries(checker), expected="not-a-sha!")
        elif git_failure == "git_unavailable":
            monkeypatch.setattr(module, "_run_git_rev_parse", lambda _root: (_ for _ in ()).throw(FileNotFoundError()))
        elif git_failure == "git_timeout":
            monkeypatch.setattr(
                module,
                "_run_git_rev_parse",
                lambda _root: (_ for _ in ()).throw(subprocess.TimeoutExpired(["git"], 10)),
            )
        else:
            monkeypatch.setattr(module, "_run_git_rev_parse", lambda _root: ("", "transport failed", 3))
        monkeypatch.setattr(module.sys, "argv", [str(_SCRIPT), "--runtime-manifest"])

        output = StringIO()
        with redirect_stdout(output):
            exit_code = module.main()
        assert exit_code == 2
        assert "FAIL runtime_manifest package_source:" in output.getvalue()


@properties
@given(fault=st.sampled_from(['missing_pin', 'malformed_pin', 'corrupt_file', 'changed_manifest']))
@example(fault='missing_pin')
@example(fault='malformed_pin')
@example(fault='corrupt_file')
@example(fault='changed_manifest')
def test_runtime_manifest_cli_rejects_package_binding_faults(fault):
    with private_case() as (tmp_path, monkeypatch):
        module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
        manifest_path = _write_manifest(root, _entries(checker))
        _write_package_pin(pin_path, root, manifest_path)
        if fault == "missing_pin":
            pin_path.unlink()
        elif fault == "malformed_pin":
            pin_path.write_text("[]", encoding="utf-8")
        elif fault == "corrupt_file":
            checker.write_text("corrupt\n", encoding="utf-8")
        else:
            _write_manifest(root, _entries(checker), expected="c" * 40)
        monkeypatch.setattr(module, "load_health_profile", lambda: {"expectRuntimeManifest": True, "role": _PIN_MODE})
        monkeypatch.setattr(module.sys, "argv", [str(_SCRIPT), "--runtime-manifest"])

        output = StringIO()
        with redirect_stdout(output):
            exit_code = module.main()
        assert exit_code == 2
        assert "FAIL runtime_manifest" in output.getvalue()

def test_runtime_manifest_cli_ignores_environment_pin_override(tmp_path, monkeypatch, capsys):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    manifest_path = _write_manifest(root, _entries(checker))
    _write_package_pin(pin_path, root, manifest_path)
    fixed_pin = tmp_path / "fixed-health-package-pin.json"
    monkeypatch.setattr(module, "RUNTIME_PACKAGE_PIN_PATH", fixed_pin)
    monkeypatch.setenv("BOT_ERRORS_RUNTIME_PACKAGE_PIN", str(pin_path))
    monkeypatch.setattr(module, "load_health_profile", lambda: {"expectRuntimeManifest": True, "role": _PIN_MODE})
    monkeypatch.setattr(module.sys, "argv", [str(_SCRIPT), "--runtime-manifest"])

    exit_code = module.main()

    captured = capsys.readouterr()
    assert exit_code == 2
    assert "FAIL runtime_manifest package_source: pin_missing" in captured.out


def test_runtime_manifest_cli_allows_an_explicit_staged_pin_only_for_the_read_only_check(tmp_path, monkeypatch, capsys):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    manifest_path = _write_manifest(root, _entries(checker))
    _write_package_pin(pin_path, root, manifest_path)
    monkeypatch.setattr(module, "RUNTIME_PACKAGE_PIN_PATH", tmp_path / "fixed-health-package-pin.json")
    monkeypatch.setattr(module, "load_health_profile", lambda: {"expectRuntimeManifest": True, "role": _PIN_MODE})
    monkeypatch.setattr(
        module.sys,
        "argv",
        [str(_SCRIPT), "--runtime-manifest", "--runtime-package-pin", str(pin_path)],
    )

    exit_code = module.main()

    captured = capsys.readouterr()
    assert exit_code == 0
    assert "source=package match" in captured.out


@pytest.mark.parametrize(
    ("pin_role", "profile_role", "accepted"),
    [
        ("no-bot", "no-bot", True),
        ("bot-host", "bot-host", True),
        ("no-bot", "bot-host", False),
        ("bot-host", "no-bot", False),
        ("unknown", "unknown", False),
        (None, "bot-host", False),
        ("bot-host", None, False),
        (["bot-host"], "bot-host", False),
        ("bot-host", {"role": "bot-host"}, False),
    ],
)
def test_runtime_package_role_contract(tmp_path, monkeypatch, capsys, pin_role, profile_role, accepted):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    manifest_path = _write_manifest(root, _entries(checker))
    _write_package_pin(pin_path, root, manifest_path)
    pin = json.loads(pin_path.read_text(encoding="utf-8"))
    pin["mode"] = pin_role
    pin_path.write_text(json.dumps(pin), encoding="utf-8")
    profile = {"expectRuntimeManifest": True, "role": profile_role}

    lines = module.runtime_manifest_inventory(profile)

    if accepted:
        assert f"git_head_sha: {_SOURCE_SHA} expected={_SOURCE_SHA} source=package match" in lines
        assert not [line for line in lines if line.startswith(("FAIL ", "WARN "))]
    else:
        assert "FAIL runtime_manifest package_source: pin_mode_mismatch" in lines
        assert not [line for line in lines if "source=package match" in line]
    monkeypatch.setattr(module, "load_health_profile", lambda: profile)
    monkeypatch.setattr(module.sys, "argv", [str(_SCRIPT), "--runtime-manifest"])
    assert module.main() == (0 if accepted else 2)
    output = capsys.readouterr().out
    assert ("source=package match" in output) is accepted


@properties
@given(
    pin_role=st.sampled_from(["no-bot", "bot-host"]),
    profile_role=st.sampled_from(["no-bot", "bot-host"]),
    corrupt=st.booleans(),
)
@example(pin_role='no-bot', profile_role='no-bot', corrupt=False)
@example(pin_role='bot-host', profile_role='bot-host', corrupt=False)
@example(pin_role='no-bot', profile_role='bot-host', corrupt=False)
@example(pin_role='bot-host', profile_role='bot-host', corrupt=True)
@example(pin_role='no-bot', profile_role='bot-host', corrupt=True)
def test_exported_checker_cli_preserves_role_and_hash_binding(pin_role, profile_role, corrupt):
    expected_exit = 0 if pin_role == profile_role and not corrupt else 2
    with private_case() as (tmp_path, monkeypatch):
        _module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
        shutil.copytree(_SCRIPT.parent / "lib", checker.parent / "lib", ignore=shutil.ignore_patterns("__pycache__"))
        manifest_path = _write_manifest(root, _entries(checker))
        _write_package_pin(pin_path, root, manifest_path)
        pin = json.loads(pin_path.read_text(encoding="utf-8"))
        pin["mode"] = pin_role
        pin_path.write_text(json.dumps(pin), encoding="utf-8")
        if corrupt:
            checker.write_text(checker.read_text(encoding="utf-8") + "\n", encoding="utf-8")
        state = tmp_path / "state"
        env = {key: value for key, value in os.environ.items() if not key.startswith("BOT_ERRORS_")}
        env.update(
            HOME=str(tmp_path),
            PYTHONDONTWRITEBYTECODE="1",
            BOT_ERRORS_STATE_DIR=str(state),
            BOT_ERRORS_OUTBOX_DIR=str(state / "outbox"),
            BOT_ERRORS_HEALTH_PROFILE_JSON=json.dumps({"role": profile_role, "expectRuntimeManifest": True}),
        )

        result = subprocess.run(
            [sys.executable, "-B", str(checker), "--runtime-manifest", "--runtime-package-pin", str(pin_path)],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )

        assert result.returncode == expected_exit, result.stderr + result.stdout
        assert ("source=package match" in result.stdout) is (expected_exit == 0)
        if pin_role != profile_role:
            assert "FAIL runtime_manifest package_source: pin_mode_mismatch" in result.stdout
        elif corrupt:
            assert "FAIL runtime_manifest package_source: required_file_hash_failure" in result.stdout
        assert not state.exists()


def test_declared_package_rejects_oversized_private_pin(tmp_path, monkeypatch):
    module, root, checker, pin_path = _declared_package(tmp_path, monkeypatch)
    manifest_path = _write_manifest(root, _entries(checker))
    _write_package_pin(pin_path, root, manifest_path)
    with pin_path.open("a", encoding="utf-8") as stream:
        stream.write(" " * (64 * 1024))
    assert "FAIL runtime_manifest package_source: pin_missing" in _inventory(module)


@properties
@given(hardlink=st.booleans())
@example(hardlink=False)
@example(hardlink=True)
def test_package_pin_rejects_hardlinks_and_symlinked_ancestors(hardlink):
    with private_case() as (tmp_path, monkeypatch):
        module, root, checker, _ = _declared_package(tmp_path, monkeypatch)
        manifest_path = _write_manifest(root, _entries(checker))
        store = tmp_path / "pin-store"
        store.mkdir(mode=0o700)
        records = store / "records"
        records.mkdir(mode=0o700)
        pin_path = records / "pin.json"
        _write_package_pin(pin_path, root, manifest_path)
        if hardlink:
            os.link(pin_path, tmp_path / "linked-pin.json")
            selected = pin_path
        else:
            alias = tmp_path / "pin-alias"
            alias.symlink_to(store, target_is_directory=True)
            selected = alias / "records" / "pin.json"
        monkeypatch.setattr(module, "RUNTIME_PACKAGE_PIN_PATH", selected)

        lines = _inventory(module)

        assert "FAIL runtime_manifest package_source: pin_missing" in lines
        assert not any("source=package match" in line for line in lines)


@properties
@given(target=st.sampled_from(["leaf", "ancestor", "hardlink"]))
@example(target="leaf")
@example(target="ancestor")
@example(target="hardlink")
def test_package_pin_rejects_identity_changes_during_read(target):
    with private_case() as (tmp_path, monkeypatch):
        module, root, checker, _ = _declared_package(tmp_path, monkeypatch)
        manifest_path = _write_manifest(root, _entries(checker))
        store = tmp_path / "pin-store"
        store.mkdir(mode=0o700)
        records = store / "records"
        records.mkdir(mode=0o700)
        pin_path = records / "pin.json"
        _write_package_pin(pin_path, root, manifest_path)
        monkeypatch.setattr(module, "RUNTIME_PACKAGE_PIN_PATH", pin_path)
        original_bytes = pin_path.read_bytes()
        initial = pin_path.stat()
        original_read = os.read
        changed = False

        def replace_during_read(fd, count):
            nonlocal changed
            opened = os.fstat(fd)
            if not changed and (opened.st_dev, opened.st_ino) == (initial.st_dev, initial.st_ino):
                changed = True
                if target == "hardlink":
                    os.link(pin_path, tmp_path / "linked-pin.json")
                else:
                    if target == "ancestor":
                        store.rename(tmp_path / "retained-pin-store")
                        store.mkdir(mode=0o700)
                        records.mkdir(mode=0o700)
                    else:
                        pin_path.rename(records / "retained-pin.json")
                    pin_path.write_bytes(original_bytes)
                    pin_path.chmod(0o600)
            return original_read(fd, count)

        monkeypatch.setattr(module.os, "read", replace_during_read)

        lines = _inventory(module)

        assert changed
        assert "FAIL runtime_manifest package_source: pin_missing" in lines
        assert not any("source=package match" in line for line in lines)


@properties
@given(parent_public=st.booleans(), leaf_public=st.booleans())
@example(parent_public=False, leaf_public=False)
@example(parent_public=True, leaf_public=False)
@example(parent_public=False, leaf_public=True)
@example(parent_public=True, leaf_public=True)
def test_package_pin_requires_private_parent_and_leaf(parent_public, leaf_public):
    with private_case() as (tmp_path, monkeypatch):
        module, root, checker, _ = _declared_package(tmp_path, monkeypatch)
        manifest_path = _write_manifest(root, _entries(checker))
        store = tmp_path / "pin-store"
        store.mkdir(mode=0o700)
        pin_path = store / "pin.json"
        _write_package_pin(pin_path, root, manifest_path)
        store.chmod(0o755 if parent_public else 0o700)
        pin_path.chmod(0o644 if leaf_public else 0o600)
        monkeypatch.setattr(module, "RUNTIME_PACKAGE_PIN_PATH", pin_path)

        lines = _inventory(module)

        if parent_public or leaf_public:
            assert "FAIL runtime_manifest package_source: pin_missing" in lines
            assert not any("source=package match" in line for line in lines)
        else:
            assert f"git_head_sha: {_SOURCE_SHA} expected={_SOURCE_SHA} source=package match" in lines
            assert not any(line.startswith("FAIL ") for line in lines)
