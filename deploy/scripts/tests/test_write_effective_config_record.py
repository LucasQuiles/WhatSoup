from __future__ import annotations

import hashlib
import io
import importlib
import json
from pathlib import Path
import subprocess
import sys

import pytest


_MAX_INPUT_BYTES = 8 * 1024 * 1024
_SCRIPT = Path(__file__).parents[1] / "write_effective_config_record.py"
_RELATIVE = "records/effective.json"
_RECORD = {
    "schema_version": "whatsoup.effective-config.v1",
    "target": {"instance": "fixture", "host": "test-host"},
    "configured": {"deployment": {"principal": "fixture-user"}},
}


def _root_with_records(tmp_path: Path) -> Path:
    root = tmp_path / "output-root"
    root.mkdir(mode=0o700)
    (root / "records").mkdir(mode=0o700)
    return root


def _run_cli(root: Path, relative: str, raw: bytes) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [
            sys.executable,
            str(_SCRIPT),
            "--output-root",
            str(root),
            "--output-relative",
            relative,
        ],
        input=raw,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def test_cli_writes_a_private_canonical_record_and_returns_only_its_digest(
    tmp_path: Path,
) -> None:
    root = _root_with_records(tmp_path)
    raw = json.dumps(_RECORD, separators=(",", ":")).encode("utf-8")

    completed = _run_cli(root, _RELATIVE, raw)

    record = root / _RELATIVE
    published = record.read_bytes()
    receipt = json.loads(completed.stdout)
    assert completed.returncode == 0
    assert completed.stderr == b""
    assert receipt == {
        "schema_version": "whatsoup.effective-config-write.v1",
        "record_sha256": hashlib.sha256(published).hexdigest(),
    }
    assert set(receipt) == {"schema_version", "record_sha256"}
    assert _RECORD["configured"]["deployment"]["principal"].encode() not in completed.stdout
    assert record.stat().st_mode & 0o777 == 0o600
    assert json.loads(published) == _RECORD


def test_cli_preserves_an_existing_output_without_success_or_content_leak(
    tmp_path: Path,
) -> None:
    root = _root_with_records(tmp_path)
    record = root / _RELATIVE
    existing = b'{"schema_version":"whatsoup.effective-config.v1","value":"existing"}\n'
    record.write_bytes(existing)
    record.chmod(0o600)

    completed = _run_cli(root, _RELATIVE, json.dumps(_RECORD).encode("utf-8"))

    assert completed.returncode == 2
    assert completed.stdout == b""
    assert completed.stderr == b"INPUT_INVALID\n"
    assert record.read_bytes() == existing


def test_cli_rejects_malformed_duplicate_nonfinite_and_invalid_utf8_stdin(
    tmp_path: Path,
) -> None:
    root = _root_with_records(tmp_path)
    invalid_inputs = (
        b"{",
        b'{"schema_version":"whatsoup.effective-config.v1","nested":{"key":1,"key":2}}',
        b'{"schema_version":"whatsoup.effective-config.v1","key":NaN}',
        b'{"schema_version":"whatsoup.effective-config.v1","key":"\xff"}',
    )

    for raw in invalid_inputs:
        completed = _run_cli(root, _RELATIVE, raw)

        assert completed.returncode == 2
        assert completed.stdout == b""
        assert completed.stderr == b"INPUT_INVALID\n"
        assert not (root / _RELATIVE).exists()


def test_cli_rejects_oversize_stdin_without_creating_an_output(tmp_path: Path) -> None:
    root = _root_with_records(tmp_path)

    completed = _run_cli(root, _RELATIVE, b"x" * (_MAX_INPUT_BYTES + 1))

    assert completed.returncode == 2
    assert completed.stdout == b""
    assert completed.stderr == b"INPUT_INVALID\n"
    assert not (root / _RELATIVE).exists()


def test_cli_rejects_unsafe_or_missing_output_paths_without_creating_directories(
    tmp_path: Path,
) -> None:
    root = _root_with_records(tmp_path)
    raw = json.dumps(_RECORD).encode("utf-8")
    unsafe_paths = (
        (Path("relative-root"), _RELATIVE),
        (root, "../outside.json"),
        (root, "missing/effective.json"),
    )

    for output_root, relative in unsafe_paths:
        completed = _run_cli(output_root, relative, raw)

        assert completed.returncode == 2
        assert completed.stdout == b""
        assert completed.stderr == b"INPUT_INVALID\n"
    assert not (root / "missing").exists()
    assert not (tmp_path / "outside.json").exists()


def test_main_hides_stdin_failures_without_output_content(tmp_path: Path) -> None:
    writer = importlib.import_module("deploy.scripts.write_effective_config_record")
    root = _root_with_records(tmp_path)

    class FailingStdin:
        def read(self, _size: int) -> bytes:
            raise OSError("private input read failed")

    stdout = io.StringIO()
    stderr = io.StringIO()
    exit_code = writer.main(
        ["--output-root", str(root), "--output-relative", _RELATIVE],
        stdin=FailingStdin(),
        stdout=stdout,
        stderr=stderr,
    )

    assert exit_code == 2
    assert stdout.getvalue() == ""
    assert stderr.getvalue() == "INPUT_INVALID\n"
    assert not (root / _RELATIVE).exists()


def test_writer_rejects_a_nested_ancestor_swap_without_writing_to_redirected_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    writer = importlib.import_module("deploy.scripts.write_effective_config_record")
    root = tmp_path / "output-root"
    root.mkdir(mode=0o700)
    nested = root / "nested"
    records = nested / "records"
    nested.mkdir(mode=0o700)
    records.mkdir(mode=0o700)
    redirected = tmp_path / "redirected"
    redirected.mkdir(mode=0o700)
    (redirected / "records").mkdir(mode=0o700)
    relative = "nested/records/effective.json"
    raw = json.dumps(_RECORD).encode("utf-8")
    original_publish = writer.durable_json.publish_event_json
    swapped = False

    def swap_nested_ancestor(stage: object) -> None:
        nonlocal swapped
        if stage is writer.durable_json.WriteStage.PARENT_OPEN:
            nested.rename(root / "retired-nested")
            nested.symlink_to(redirected, target_is_directory=True)
            swapped = True

    def publish_with_swap(*args: object, **kwargs: object) -> object:
        return original_publish(*args, _fault_hook=swap_nested_ancestor, **kwargs)

    monkeypatch.setattr(writer.durable_json, "publish_event_json", publish_with_swap)

    with pytest.raises(writer.EffectiveConfigWriteError):
        writer.write_effective_config_record(
            raw=raw,
            output_root=root,
            output_relative=relative,
        )

    assert swapped
    assert not (redirected / "records" / "effective.json").exists()
    assert (root / "retired-nested" / "records" / "effective.json").exists()
