"""Resource limits for untrusted runtime manifests and failed member reads."""
from __future__ import annotations

import hashlib
import os

import pytest
from hypothesis import given, strategies as st

from bot_errors_property_support import private_case, properties
from test_bot_errors_runtime_manifest_package import (
    _SOURCE_SHA, _declared_package, _entries, _inventory,
    _write_manifest, _write_package_pin,
)


@properties
@given(count=st.integers(min_value=1025, max_value=1040))
def test_manifest_entry_limit_precedes_member_observation(count):
    with private_case() as (tmp_path, monkeypatch):
        module, root, checker, pin = _declared_package(tmp_path, monkeypatch)
        manifest = _write_manifest(root, _entries(checker) * count)
        _write_package_pin(pin, root, manifest)
        observed = []
        original = module.runtime_manifest_entry_path

        def observe(raw_path):
            observed.append(raw_path)
            return original(raw_path)

        monkeypatch.setattr(module, "runtime_manifest_entry_path", observe)
        lines = _inventory(module)

        assert lines == ["FAIL runtime_manifest: member_count_limit"]
        assert observed == []


@pytest.mark.parametrize("invalidate_after_read", [False, True])
def test_aggregate_member_bytes_include_reads_that_fail_identity_validation(
    tmp_path, monkeypatch, invalidate_after_read,
):
    module, root, checker, pin = _declared_package(tmp_path, monkeypatch)
    size = 12 * 1024 * 1024
    digest = hashlib.sha256(bytes(size)).hexdigest()
    entries = _entries(checker)
    identities = {}
    for index in range(6):
        path = root / "deploy" / f"payload-{index}.bin"
        with path.open("wb") as handle:
            handle.truncate(size)
        metadata = path.stat()
        identities[(metadata.st_dev, metadata.st_ino)] = path
        entries.append({"path": f"deploy/payload-{index}.bin", "sha256": digest})
    manifest = _write_manifest(root, entries)
    _write_package_pin(pin, root, manifest)
    original_read = os.read
    bytes_read = 0
    invalidated = set()

    def observe_read(descriptor, count):
        nonlocal bytes_read
        metadata = os.fstat(descriptor)
        identity = (metadata.st_dev, metadata.st_ino)
        chunk = original_read(descriptor, count)
        if identity in identities:
            bytes_read += len(chunk)
            if invalidate_after_read and not chunk and identity not in invalidated:
                os.utime(identities[identity], ns=(metadata.st_atime_ns, metadata.st_mtime_ns + 1))
                invalidated.add(identity)
        return chunk

    monkeypatch.setattr(module.os, "read", observe_read)
    lines = _inventory(module)

    assert lines == ["FAIL runtime_manifest: aggregate_read_limit"]
    assert 0 < bytes_read <= 64 * 1024 * 1024
    if invalidate_after_read:
        assert invalidated


def test_evidence_output_limit_stops_member_traversal(tmp_path, monkeypatch):
    module, root, _checker, pin = _declared_package(tmp_path, monkeypatch)
    entries = [{"path": f"deploy/missing-{index:04d}-" + "x" * 96 + ".txt", "sha256": "0" * 64}
               for index in range(1024)]
    manifest = _write_manifest(root, entries)
    _write_package_pin(pin, root, manifest)
    observed = []
    original = module.runtime_manifest_entry_path

    def observe(raw_path):
        observed.append(raw_path)
        return original(raw_path)

    monkeypatch.setattr(module, "runtime_manifest_entry_path", observe)
    lines = _inventory(module)

    assert lines == ["FAIL runtime_manifest: evidence_output_limit"]
    assert 0 < len(observed) < len(entries)
    assert len(("\n".join(lines) + "\n").encode()) <= 64 * 1024


def test_valid_package_has_a_fresh_resource_budget_for_each_inventory(tmp_path, monkeypatch):
    module, root, checker, pin = _declared_package(tmp_path, monkeypatch)
    manifest = _write_manifest(root, _entries(checker))
    _write_package_pin(pin, root, manifest)

    first = _inventory(module)
    second = _inventory(module)

    assert first == second
    assert f"git_head_sha: {_SOURCE_SHA} expected={_SOURCE_SHA} source=package match" in second
    assert not any(line.startswith("FAIL ") for line in second)
