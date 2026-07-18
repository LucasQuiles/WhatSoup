"""T10 accepted-source cursor classification contracts."""

from __future__ import annotations

import hashlib
from dataclasses import FrozenInstanceError, replace

import pytest
from qsesh.model import FileStamp, Harness, SourceCandidate, SourceSnapshot
from qsesh.scanner import (
    CursorDecision,
    SourceCursor,
    classify_cursor,
    cursor_from_snapshot,
)


def candidate(
    *,
    host_id: str = "host-test-001",
    harness: Harness = Harness.CLAUDE,
    native_id: str = "11111111-1111-4111-8111-111111111111",
    source_key: str = "sk-" + "a" * 64,
    updated_at_us: int = 1_000_000,
    file_stamp: FileStamp | None = None,
) -> SourceCandidate:
    return SourceCandidate(
        host_id=host_id,
        harness=harness,
        native_id=native_id,
        source_key=source_key,
        updated_at_us=updated_at_us,
        file_stamp=file_stamp
        or FileStamp(device=1, inode=2, size=3, mtime_ns=4, ctime_ns=5),
    )


def snapshot(
    *,
    source_candidate: SourceCandidate | None = None,
    raw_bytes: bytes = b"{}\n",
) -> SourceSnapshot:
    return SourceSnapshot(
        candidate=source_candidate or candidate(),
        raw_bytes=raw_bytes,
        source_digest=hashlib.blake2b(raw_bytes, digest_size=32).hexdigest(),
        schema_fingerprint="unclassified-jsonl-v1",
        harness_version=None,
    )


def cursor(
    *,
    source_candidate: SourceCandidate | None = None,
    raw_bytes: bytes = b"{}\n",
    extractor_version: str = "claude-extractor-v1",
) -> SourceCursor:
    return cursor_from_snapshot(
        snapshot(source_candidate=source_candidate, raw_bytes=raw_bytes),
        extractor_version=extractor_version,
    )


def test_cursor_from_snapshot_binds_every_accepted_field() -> None:
    accepted = snapshot()

    result = cursor_from_snapshot(
        accepted,
        extractor_version="claude-extractor-v1",
    )

    assert result.candidate == accepted.candidate
    assert result.source_digest == accepted.source_digest
    assert result.extractor_version == "claude-extractor-v1"
    assert result.file_identity == (1, 2, 3, 4, 5)


def test_missing_prior_cursor_is_new() -> None:
    assert classify_cursor(cursor(), None) is CursorDecision.NEW


def test_all_binding_fields_equal_is_unchanged() -> None:
    prior = cursor()
    accepted = cursor()

    assert classify_cursor(accepted, prior) is CursorDecision.UNCHANGED


@pytest.mark.parametrize(
    "field,value",
    [
        ("device", 9),
        ("inode", 9),
        ("size", 9),
        ("mtime_ns", 9),
        ("ctime_ns", 9),
    ],
)
def test_each_descriptor_identity_field_change_is_changed(
    field: str, value: int
) -> None:
    prior = cursor()
    changed_stamp = replace(prior.candidate.file_stamp, **{field: value})
    changed_candidate = replace(prior.candidate, file_stamp=changed_stamp)

    assert classify_cursor(cursor(source_candidate=changed_candidate), prior) is (
        CursorDecision.CHANGED
    )


def test_same_size_and_preserved_mtime_edit_is_changed_by_ctime_and_digest() -> None:
    prior = cursor(raw_bytes=b"{}\n")
    changed_stamp = replace(prior.candidate.file_stamp, ctime_ns=6)
    changed_candidate = replace(prior.candidate, file_stamp=changed_stamp)
    changed = cursor(source_candidate=changed_candidate, raw_bytes=b"[]\n")

    assert changed.candidate.file_stamp.size == prior.candidate.file_stamp.size
    assert changed.candidate.file_stamp.mtime_ns == prior.candidate.file_stamp.mtime_ns
    assert changed.source_digest != prior.source_digest
    assert classify_cursor(changed, prior) is CursorDecision.CHANGED


def test_digest_change_alone_is_changed() -> None:
    prior = cursor(raw_bytes=b"{}\n")
    changed = cursor(raw_bytes=b"[]\n")

    assert changed.file_identity == prior.file_identity
    assert classify_cursor(changed, prior) is CursorDecision.CHANGED


def test_extractor_version_change_alone_is_changed() -> None:
    prior = cursor(extractor_version="claude-extractor-v1")
    changed = cursor(extractor_version="claude-extractor-v2")

    assert classify_cursor(changed, prior) is CursorDecision.CHANGED


@pytest.mark.parametrize(
    "changed_candidate",
    [
        candidate(host_id="host-test-002"),
        candidate(harness=Harness.CODEX),
        candidate(native_id="22222222-2222-4222-8222-222222222222"),
        candidate(source_key="sk-" + "b" * 64),
        candidate(updated_at_us=1_000_001),
    ],
)
def test_source_identity_or_binding_time_change_is_changed(
    changed_candidate: SourceCandidate,
) -> None:
    assert classify_cursor(cursor(source_candidate=changed_candidate), cursor()) is (
        CursorDecision.CHANGED
    )


class BombDigest(str):
    def __eq__(self, other: object) -> bool:
        raise AssertionError("digest compared before descriptor identity")

    def __ne__(self, other: object) -> bool:
        raise AssertionError("digest compared before descriptor identity")


def test_descriptor_identity_is_compared_before_digest() -> None:
    prior = cursor()
    changed_stamp = replace(prior.candidate.file_stamp, ctime_ns=6)
    changed = replace(
        prior,
        candidate=replace(prior.candidate, file_stamp=changed_stamp),
        source_digest=BombDigest(prior.source_digest),
    )

    assert classify_cursor(changed, prior) is CursorDecision.CHANGED


def test_cursor_is_frozen_slotted_and_rejects_unaccepted_values() -> None:
    accepted = cursor()
    assert not hasattr(accepted, "__dict__")
    with pytest.raises((FrozenInstanceError, AttributeError, TypeError)):
        accepted.extractor_version = "changed"  # type: ignore[misc]

    invalid_builders = (
        lambda: SourceCursor(
            candidate=replace(candidate(), file_stamp=None),
            source_digest="a" * 64,
            extractor_version="v1",
        ),
        lambda: SourceCursor(
            candidate=candidate(),
            source_digest="A" * 64,
            extractor_version="v1",
        ),
        lambda: SourceCursor(
            candidate=candidate(),
            source_digest="a" * 63,
            extractor_version="v1",
        ),
        lambda: SourceCursor(
            candidate=candidate(),
            source_digest="a" * 64,
            extractor_version="",
        ),
    )
    for build in invalid_builders:
        with pytest.raises((TypeError, ValueError)):
            build()


def test_classify_cursor_rejects_wrong_types() -> None:
    with pytest.raises(TypeError):
        classify_cursor(candidate(), None)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        classify_cursor(cursor(), candidate())  # type: ignore[arg-type]
