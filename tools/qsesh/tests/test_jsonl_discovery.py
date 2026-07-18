"""T09 deterministic Claude/Codex JSONL discovery contracts."""

from __future__ import annotations

import hashlib
import os
from dataclasses import FrozenInstanceError
from itertools import permutations
from pathlib import Path

import pytest
from qsesh.errors import QseshError
from qsesh.model import FileStamp, Harness, SourceCandidate
from qsesh.sources.base import ReadOnlySourceFS, SourceRead
from qsesh.sources.jsonl import (
    DiscoveryKind,
    DiscoveryObservation,
    DiscoveryResult,
    JsonlSourceAdapter,
)

CLAUDE_A = "11111111-1111-4111-8111-111111111111"
CLAUDE_B = "22222222-2222-4222-8222-222222222222"
CODEX_A = "33333333-3333-4333-8333-333333333333"
CODEX_B = "44444444-4444-4444-8444-444444444444"


def _source_key(host_id: str, harness: str, relative: str) -> str:
    preimage = b"qsesh-source-key-v1\0"
    for value in (host_id, harness, relative):
        encoded = value.encode("utf-8")
        preimage += len(encoded).to_bytes(4, "big") + encoded
    return "sk-" + hashlib.blake2b(preimage, digest_size=32).hexdigest()


def _claude_path(root: Path, project: str, native_id: str) -> Path:
    path = root / project / f"{native_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"content-is-not-read\n")
    return path


def _codex_path(
    root: Path,
    native_id: str,
    *,
    timestamp: str = "2026-07-17T12-34-56",
) -> Path:
    date = timestamp[:10]
    year, month, day = date.split("-")
    path = root / year / month / day / f"rollout-{timestamp}-{native_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"content-is-not-read\n")
    return path


def _adapter(root: Path, harness: Harness) -> JsonlSourceAdapter:
    return JsonlSourceAdapter(
        host_id="host-test-001",
        harness=harness,
        root=root,
        source_fs=ReadOnlySourceFS(),
    )


def _candidate_rows(result: DiscoveryResult) -> list[tuple[object, ...]]:
    return [
        (
            candidate.harness.value,
            candidate.native_id,
            candidate.source_key,
            candidate.updated_at_us,
            candidate.file_stamp,
        )
        for candidate in result.candidates
    ]


def test_claude_discovers_exact_project_uuid_jsonl_candidates_without_content_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "claude"
    second = _claude_path(root, "project-z", CLAUDE_B)
    first = _claude_path(root, "project-a", CLAUDE_A)
    boundary = ReadOnlySourceFS()

    def forbidden(*_args: object, **_kwargs: object) -> SourceRead:
        raise AssertionError("discovery read source content")

    monkeypatch.setattr(boundary, "read_bytes", forbidden)
    result = JsonlSourceAdapter(
        host_id="host-test-001",
        harness=Harness.CLAUDE,
        root=root,
        source_fs=boundary,
    ).discover()

    assert [candidate.native_id for candidate in result.candidates] == [
        CLAUDE_A,
        CLAUDE_B,
    ]
    assert result.observations == ()
    assert result.scanned_file_count == 2
    assert result.counts() == {
        "candidate": 2,
        "duplicate_inode": 0,
        "excluded_invalid_layout": 0,
        "excluded_non_jsonl": 0,
        "source_raced": 0,
    }
    assert result.candidates[0].source_key == _source_key(
        "host-test-001", "claude", first.relative_to(root).as_posix()
    )
    assert result.candidates[1].source_key == _source_key(
        "host-test-001", "claude", second.relative_to(root).as_posix()
    )


def test_codex_discovers_dated_rollouts_and_extracts_only_uuid_native_id(
    tmp_path: Path,
) -> None:
    root = tmp_path / "codex"
    later = _codex_path(root, CODEX_B, timestamp="2026-07-18T00-00-01")
    earlier = _codex_path(root, CODEX_A, timestamp="2026-07-17T23-59-59")

    result = _adapter(root, Harness.CODEX).discover()

    assert [candidate.native_id for candidate in result.candidates] == [
        CODEX_A,
        CODEX_B,
    ]
    assert all("rollout" not in candidate.native_id for candidate in result.candidates)
    assert result.candidates[0].source_key == _source_key(
        "host-test-001", "codex", earlier.relative_to(root).as_posix()
    )
    assert result.candidates[1].source_key == _source_key(
        "host-test-001", "codex", later.relative_to(root).as_posix()
    )


def test_candidate_stamps_are_descriptor_derived_and_updated_time_is_microseconds(
    tmp_path: Path,
) -> None:
    root = tmp_path / "claude"
    path = _claude_path(root, "project", CLAUDE_A)
    timestamp_ns = 1_767_341_046_123_456_789
    os.utime(path, ns=(timestamp_ns, timestamp_ns))
    expected_stamp = ReadOnlySourceFS().stat(path)

    candidate = _adapter(root, Harness.CLAUDE).discover().candidates[0]

    assert candidate.file_stamp == expected_stamp
    assert candidate.updated_at_us == expected_stamp.mtime_ns // 1000


def test_source_key_is_scoped_deterministic_and_contains_no_path_text(
    tmp_path: Path,
) -> None:
    root = tmp_path / "claude"
    path = _claude_path(root, "private-project", CLAUDE_A)
    first = _adapter(root, Harness.CLAUDE).discover().candidates[0]
    second = _adapter(root, Harness.CLAUDE).discover().candidates[0]

    assert first.source_key == second.source_key
    assert first.source_key.startswith("sk-")
    assert len(first.source_key) == 67
    assert "private-project" not in first.source_key
    assert path.name not in first.source_key
    assert (
        _source_key("another-host", "claude", "private-project/" + path.name)
        != first.source_key
    )


def test_candidates_are_sorted_by_native_id_not_source_path(tmp_path: Path) -> None:
    root = tmp_path / "claude"
    _claude_path(root, "project-a", CLAUDE_B)
    _claude_path(root, "project-z", CLAUDE_A)

    result = _adapter(root, Harness.CLAUDE).discover()

    assert [candidate.native_id for candidate in result.candidates] == [
        CLAUDE_A,
        CLAUDE_B,
    ]


def test_candidate_output_contains_no_source_path_field(tmp_path: Path) -> None:
    root = tmp_path / "claude"
    _claude_path(root, "project", CLAUDE_A)
    candidate = _adapter(root, Harness.CLAUDE).discover().candidates[0]

    assert isinstance(candidate, SourceCandidate)
    assert not hasattr(candidate, "path")
    assert not hasattr(candidate, "source_path")


@pytest.mark.parametrize(
    "relative",
    [
        "root-session.jsonl",
        "project/not-a-uuid.jsonl",
        f"project/subagents/{CLAUDE_A}.jsonl",
        "project/session.JSONL",
    ],
)
def test_claude_invalid_layouts_are_counted_without_stat_or_quarantine(
    tmp_path: Path, relative: str
) -> None:
    root = tmp_path / "claude"
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"ignored")

    result = _adapter(root, Harness.CLAUDE).discover()

    expected_kind = (
        DiscoveryKind.EXCLUDED_NON_JSONL
        if path.suffix != ".jsonl"
        else DiscoveryKind.EXCLUDED_INVALID_LAYOUT
    )
    assert result.candidates == ()
    assert [observation.kind for observation in result.observations] == [expected_kind]
    assert result.scanned_file_count == 1


@pytest.mark.parametrize(
    "relative",
    [
        f"2026/07/17/not-a-rollout-{CODEX_A}.jsonl",
        f"2026/07/18/rollout-2026-07-17T12-34-56-{CODEX_A}.jsonl",
        f"2026/13/17/rollout-2026-13-17T12-34-56-{CODEX_A}.jsonl",
        "2026/07/17/rollout-2026-07-17T12-34-56-not-a-uuid.jsonl",
        f"extra/2026/07/17/rollout-2026-07-17T12-34-56-{CODEX_A}.jsonl",
    ],
)
def test_codex_invalid_rollout_paths_are_excluded(
    tmp_path: Path, relative: str
) -> None:
    root = tmp_path / "codex"
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"ignored")

    result = _adapter(root, Harness.CODEX).discover()

    assert result.candidates == ()
    assert result.observations[0].kind is DiscoveryKind.EXCLUDED_INVALID_LAYOUT


def test_non_jsonl_regular_files_are_explicit_exclusions(tmp_path: Path) -> None:
    root = tmp_path / "claude"
    ignored = root / "project/notes.txt"
    ignored.parent.mkdir(parents=True)
    ignored.write_bytes(b"not-jsonl")

    result = _adapter(root, Harness.CLAUDE).discover()

    assert result.counts()["excluded_non_jsonl"] == 1
    assert result.scanned_file_count == 1


def test_observations_are_sorted_by_kind_then_safe_source_key(tmp_path: Path) -> None:
    root = tmp_path / "claude"
    non_jsonl = root / "project/a.txt"
    invalid_layout = root / "project/z.jsonl"
    non_jsonl.parent.mkdir(parents=True)
    non_jsonl.write_bytes(b"ignored")
    invalid_layout.write_bytes(b"ignored")

    result = _adapter(root, Harness.CLAUDE).discover()

    assert [item.kind for item in result.observations] == [
        DiscoveryKind.EXCLUDED_INVALID_LAYOUT,
        DiscoveryKind.EXCLUDED_NON_JSONL,
    ]
    assert result.observations == tuple(
        sorted(
            result.observations,
            key=lambda item: (item.kind.value, item.source_key),
        )
    )


def test_symlink_files_and_directories_are_never_followed_or_counted(
    tmp_path: Path,
) -> None:
    root = tmp_path / "claude"
    external = tmp_path / "external"
    target = _claude_path(external, "private", CLAUDE_A)
    root.mkdir()
    (root / "linked-project").symlink_to(target.parent, target_is_directory=True)
    project = root / "project"
    project.mkdir()
    (project / f"{CLAUDE_B}.jsonl").symlink_to(target)

    result = _adapter(root, Harness.CLAUDE).discover()

    assert result.candidates == ()
    assert result.observations == ()
    assert result.scanned_file_count == 0


def test_duplicate_inode_keeps_lexically_first_path_once(tmp_path: Path) -> None:
    root = tmp_path / "claude"
    first = _claude_path(root, "project-a", CLAUDE_A)
    duplicate = root / "project-z" / f"{CLAUDE_B}.jsonl"
    duplicate.parent.mkdir()
    os.link(first, duplicate)

    adapter = _adapter(root, Harness.CLAUDE)
    result = adapter.discover()

    assert len(result.candidates) == 1
    assert result.candidates[0].native_id == CLAUDE_A
    assert result.counts()["duplicate_inode"] == 1
    assert adapter.path_for(result.candidates[0]) == first


def test_randomized_creation_order_produces_identical_candidate_rows(
    tmp_path: Path,
) -> None:
    definitions = (
        ("project-c", CLAUDE_B),
        ("project-a", CLAUDE_A),
        ("project-b", "55555555-5555-4555-8555-555555555555"),
    )
    root = tmp_path / "root"

    class OrderFS:
        def __init__(self, ordering: tuple[tuple[str, str], ...]) -> None:
            self.paths = tuple(
                root / project / f"{native_id}.jsonl" for project, native_id in ordering
            )

        def iter_files(self, observed_root: Path) -> tuple[Path, ...]:
            assert observed_root == root
            return self.paths

        def stat(self, path: Path) -> FileStamp:
            native_id = path.stem
            inode = sorted(item[1] for item in definitions).index(native_id) + 1
            return FileStamp(
                device=1,
                inode=inode,
                size=10,
                mtime_ns=1_700_000_000_000_000_000,
                ctime_ns=1_700_000_000_000_000_000,
            )

        def read_bytes(self, path: Path, *, max_bytes: int) -> SourceRead:
            raise AssertionError((path, max_bytes))

    outputs: list[list[tuple[object, ...]]] = []
    for ordering in permutations(definitions):
        adapter = JsonlSourceAdapter(
            host_id="host-test-001",
            harness=Harness.CLAUDE,
            root=root,
            source_fs=OrderFS(ordering),
        )
        outputs.append(_candidate_rows(adapter.discover()))

    assert all(output == outputs[0] for output in outputs[1:])


def test_randomized_invalid_path_order_produces_identical_observations(
    tmp_path: Path,
) -> None:
    root = tmp_path / "root"
    paths = (
        root / "project/notes.txt",
        root / "project/not-a-uuid.jsonl",
        root / "root-session.jsonl",
    )

    class OrderFS:
        def __init__(self, ordering: tuple[Path, ...]) -> None:
            self.ordering = ordering

        def iter_files(self, observed_root: Path) -> tuple[Path, ...]:
            assert observed_root == root
            return self.ordering

        def stat(self, path: Path) -> FileStamp:
            raise AssertionError(path)

        def read_bytes(self, path: Path, *, max_bytes: int) -> SourceRead:
            raise AssertionError((path, max_bytes))

    outputs: list[tuple[DiscoveryObservation, ...]] = []
    for ordering in permutations(paths):
        adapter = JsonlSourceAdapter(
            host_id="host-test-001",
            harness=Harness.CLAUDE,
            root=root,
            source_fs=OrderFS(ordering),
        )
        outputs.append(adapter.discover().observations)

    assert all(output == outputs[0] for output in outputs[1:])


class _SequencedFS:
    def __init__(
        self,
        path: Path,
        outcomes: list[FileStamp | BaseException],
    ) -> None:
        self.path = path
        self.outcomes = outcomes
        self.stat_calls = 0
        self.read_calls = 0

    def iter_files(self, root: Path) -> tuple[Path, ...]:
        assert root == self.path.parents[1]
        return (self.path,)

    def stat(self, path: Path) -> FileStamp:
        assert path == self.path
        outcome = self.outcomes[self.stat_calls]
        self.stat_calls += 1
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    def read_bytes(self, path: Path, *, max_bytes: int) -> SourceRead:
        self.read_calls += 1
        raise AssertionError((path, max_bytes))


def _stamp(*, inode: int = 1, size: int = 10, mtime_ns: int = 20) -> FileStamp:
    return FileStamp(device=1, inode=inode, size=size, mtime_ns=mtime_ns, ctime_ns=30)


def test_disappearance_during_discovery_is_source_raced_not_quarantine(
    tmp_path: Path,
) -> None:
    root = tmp_path / "claude"
    path = root / "project" / f"{CLAUDE_A}.jsonl"
    missing = QseshError("QS-E-SOURCE-READ", phase="source-stat")
    missing.__cause__ = FileNotFoundError()
    source_fs = _SequencedFS(path, [missing])

    result = JsonlSourceAdapter(
        host_id="host-test-001",
        harness=Harness.CLAUDE,
        root=root,
        source_fs=source_fs,
    ).discover()

    assert result.candidates == ()
    assert result.counts()["source_raced"] == 1
    assert result.observations[0].kind is DiscoveryKind.SOURCE_RACED
    assert source_fs.read_calls == 0


def test_stamp_change_during_discovery_is_source_raced(tmp_path: Path) -> None:
    root = tmp_path / "claude"
    path = root / "project" / f"{CLAUDE_A}.jsonl"
    source_fs = _SequencedFS(path, [_stamp(), _stamp(size=11)])

    result = JsonlSourceAdapter(
        host_id="host-test-001",
        harness=Harness.CLAUDE,
        root=root,
        source_fs=source_fs,
    ).discover()

    assert result.candidates == ()
    assert result.counts()["source_raced"] == 1
    assert source_fs.stat_calls == 2


def test_permission_error_is_source_level_failure_not_session_outcome(
    tmp_path: Path,
) -> None:
    root = tmp_path / "claude"
    path = root / "project" / f"{CLAUDE_A}.jsonl"
    denied = QseshError("QS-E-SOURCE-READ", phase="source-stat")
    denied.__cause__ = PermissionError()
    source_fs = _SequencedFS(path, [denied])
    adapter = JsonlSourceAdapter(
        host_id="host-test-001",
        harness=Harness.CLAUDE,
        root=root,
        source_fs=source_fs,
    )

    with pytest.raises(QseshError) as caught:
        adapter.discover()
    assert caught.value is denied


def test_missing_root_is_source_level_failure(tmp_path: Path) -> None:
    root = tmp_path / "missing"

    with pytest.raises(QseshError) as caught:
        _adapter(root, Harness.CLAUDE).discover()

    assert caught.value.code == "QS-E-SOURCE-READ"
    assert caught.value.phase == "source-iterate"


def test_path_for_rejects_unaccepted_or_tampered_candidates(tmp_path: Path) -> None:
    root = tmp_path / "claude"
    _claude_path(root, "project", CLAUDE_A)
    adapter = _adapter(root, Harness.CLAUDE)
    candidate = adapter.discover().candidates[0]
    tampered = SourceCandidate(
        host_id=candidate.host_id,
        harness=candidate.harness,
        native_id=CLAUDE_B,
        source_key=candidate.source_key,
        updated_at_us=candidate.updated_at_us,
        file_stamp=candidate.file_stamp,
    )

    with pytest.raises(QseshError) as caught:
        adapter.path_for(tampered)
    assert (caught.value.code, caught.value.phase) == (
        "QS-E-BOUNDARY",
        "source-candidate-map",
    )


def test_discovery_records_are_frozen_and_reconcile_all_scanned_files(
    tmp_path: Path,
) -> None:
    root = tmp_path / "claude"
    _claude_path(root, "project", CLAUDE_A)
    ignored = root / "project/notes.txt"
    ignored.write_bytes(b"ignored")
    result = _adapter(root, Harness.CLAUDE).discover()

    assert result.scanned_file_count == len(result.candidates) + len(
        result.observations
    )
    with pytest.raises(FrozenInstanceError):
        result.scanned_file_count = 0  # type: ignore[misc]
    observation = result.observations[0]
    assert isinstance(observation, DiscoveryObservation)
    with pytest.raises(FrozenInstanceError):
        observation.source_key = "changed"  # type: ignore[misc]


def test_discovery_result_rejects_unreconciled_terminal_outcomes() -> None:
    with pytest.raises(ValueError, match="reconcile"):
        DiscoveryResult(candidates=(), observations=(), scanned_file_count=1)


def test_unencodable_source_key_path_fails_with_safe_typed_error(
    tmp_path: Path,
) -> None:
    root = tmp_path / "root"
    path = root / "project" / "bad-\udcff.jsonl"

    class SurrogateFS:
        def iter_files(self, observed_root: Path) -> tuple[Path, ...]:
            assert observed_root == root
            return (path,)

        def stat(self, observed_path: Path) -> FileStamp:
            raise AssertionError(observed_path)

        def read_bytes(self, observed_path: Path, *, max_bytes: int) -> SourceRead:
            raise AssertionError((observed_path, max_bytes))

    adapter = JsonlSourceAdapter(
        host_id="host-test-001",
        harness=Harness.CLAUDE,
        root=root,
        source_fs=SurrogateFS(),
    )

    with pytest.raises(QseshError) as caught:
        adapter.discover()
    assert (caught.value.code, caught.value.phase) == (
        "QS-E-SOURCE-READ",
        "source-key",
    )
    assert "bad" not in str(caught.value)


@pytest.mark.parametrize(
    ("host_id", "root", "phase"),
    [
        ("Mutable-Host", Path("/synthetic/source"), "jsonl-host"),
        ("host-test-001", Path("relative/source"), "jsonl-root"),
    ],
)
def test_invalid_adapter_identity_or_root_fails_before_discovery(
    host_id: str, root: Path, phase: str
) -> None:
    with pytest.raises(QseshError) as caught:
        JsonlSourceAdapter(
            host_id=host_id,
            harness=Harness.CLAUDE,
            root=root,
            source_fs=ReadOnlySourceFS(),
        )
    assert (caught.value.code, caught.value.phase) == ("QS-E-BOUNDARY", phase)


def test_only_claude_and_codex_harnesses_are_valid_for_jsonl_adapter(
    tmp_path: Path,
) -> None:
    root = tmp_path / "source"
    root.mkdir()

    with pytest.raises(QseshError) as caught:
        _adapter(root, Harness.OPENCODE)

    assert (caught.value.code, caught.value.phase) == (
        "QS-E-BOUNDARY",
        "jsonl-harness",
    )
