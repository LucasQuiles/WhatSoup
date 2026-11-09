import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

import pytest
from hypothesis import given, strategies as st


spec = importlib.util.spec_from_file_location(
    "delivery_receipts",
    Path(__file__).resolve().parents[1] / "bot_errors_delivery_receipts.py",
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_final_dispatcher_receipt_is_redacted_and_not_confused_with_queue(tmp_path):
    identifier = "00000000-0000-4000-8000-000000000001"
    (tmp_path / "outbox").mkdir()
    (tmp_path / "outbox" / f"{identifier}.json").write_text(
        json.dumps(
            {"id": identifier, "summary": "private", "delivery": {"status": "queued"}}
        )
    )
    assert (
        module.delivery_receipts(tmp_path, [identifier])[identifier]["status"]
        == "pending"
    )
    (tmp_path / "sent").mkdir()
    (tmp_path / "sent" / f"{identifier}.sent").write_text(
        json.dumps(
            {
                "id": identifier,
                "summary": "private",
                "delivery": {
                    "status": "sent",
                    "auditReceipt": "receipt",
                    "sentAt": "2026-09-18T15:00:00Z",
                },
            }
        )
    )
    result = module.delivery_receipts(tmp_path, [identifier])
    assert result[identifier]["status"] == "sent"
    assert "private" not in json.dumps(result)


def test_delivery_query_rejects_arbitrary_path_and_glob_input(tmp_path):
    with pytest.raises(ValueError):
        module.delivery_receipts(tmp_path, ["../../*"])


def _place(root, stage, identifier, name_suffix, status="queued"):
    (root / stage).mkdir(exist_ok=True)
    (root / stage / f"{identifier}.json{name_suffix}").write_text(
        json.dumps({"id": identifier, "delivery": {"status": status}})
    )


@pytest.mark.parametrize(
    ("stage", "expected"),
    [
        ("storm-collapsed", "storm_collapsed"),
        ("quarantine", "quarantined"),
        ("writefail-quarantine", "quarantined"),
        ("testleak", "test_leak_dropped"),
    ],
)
@given(identifier=st.uuids(), stamp=st.integers(min_value=1, max_value=2**31))
def test_dispatcher_disposition_stages_are_reported(stage, expected, identifier, stamp):
    identifier = str(identifier)
    with TemporaryDirectory() as directory:
        root = Path(directory)
        _place(root, stage, identifier, f".{stamp}.x")
        assert module.delivery_receipts(root, [identifier])[identifier] == {
            "status": expected
        }


def test_a_final_disposition_outranks_a_stale_queue_copy(tmp_path):
    identifier = "00000000-0000-4000-8000-000000000003"
    _place(tmp_path, "outbox", identifier, "")
    _place(tmp_path, "storm-collapsed", identifier, ".1790000000.x", "storm-collapsed")
    assert (
        module.delivery_receipts(tmp_path, [identifier])[identifier]["status"]
        == "storm_collapsed"
    )


def test_an_event_found_in_no_stage_stays_unobserved(tmp_path):
    identifier = "00000000-0000-4000-8000-000000000004"
    for stage in ("sent", "storm-collapsed", "quarantine", "testleak"):
        (tmp_path / stage).mkdir()
    assert module.delivery_receipts(tmp_path, [identifier])[identifier] == {
        "status": "unobserved"
    }


def test_dead_letter_is_reported_as_dead_lettered_not_pending(tmp_path):
    identifier = "00000000-0000-4000-8000-000000000005"
    _place(tmp_path, "dead-letter", identifier, ".1790000000.x")
    assert module.delivery_receipts(tmp_path, [identifier])[identifier] == {
        "status": "dead_lettered"
    }
    # A copy still queued does not hide that it was dead-lettered.
    _place(tmp_path, "outbox", identifier, "")
    assert (
        module.delivery_receipts(tmp_path, [identifier])[identifier]["status"]
        == "dead_lettered"
    )


def _sent_receipt(path, identifier):
    path.write_text(json.dumps({
        "id": identifier,
        "delivery": {"status": "sent", "auditReceipt": "outside-receipt"},
    }))


def test_symlinked_stage_cannot_supply_a_delivery_receipt(tmp_path):
    identifier = "00000000-0000-4000-8000-000000000006"
    root = tmp_path / "queue"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    _sent_receipt(outside / f"{identifier}.json", identifier)
    (root / "sent").symlink_to(outside, target_is_directory=True)

    assert module.delivery_receipts(root, [identifier])[identifier] == {
        "status": "unobserved"
    }


def test_symlinked_root_cannot_supply_a_delivery_receipt(tmp_path):
    identifier = "00000000-0000-4000-8000-000000000007"
    outside = tmp_path / "outside"
    (outside / "sent").mkdir(parents=True)
    _sent_receipt(outside / "sent" / f"{identifier}.json", identifier)
    root = tmp_path / "queue"
    root.symlink_to(outside, target_is_directory=True)

    assert module.delivery_receipts(root, [identifier])[identifier] == {
        "status": "unobserved"
    }


def test_leaf_replaced_with_symlink_before_open_is_not_a_receipt(tmp_path, monkeypatch):
    identifier = "00000000-0000-4000-8000-000000000008"
    root = tmp_path / "queue"
    root.mkdir()
    _place(root, "sent", identifier, "")
    leaf = root / "sent" / f"{identifier}.json"
    outside = tmp_path / "outside.json"
    _sent_receipt(outside, identifier)
    original_open = os.open
    original_io_open = io.open
    replaced = False

    def replace(path):
        nonlocal replaced
        if not replaced and not isinstance(path, int) and Path(path).name == leaf.name:
            leaf.rename(root / "saved-leaf.json")
            leaf.symlink_to(outside)
            replaced = True

    def open_descriptor(path, *args, **kwargs):
        replace(path)
        return original_open(path, *args, **kwargs)

    def open_stream(path, *args, **kwargs):
        replace(path)
        return original_io_open(path, *args, **kwargs)

    monkeypatch.setattr(os, "open", open_descriptor)
    monkeypatch.setattr(io, "open", open_stream)
    result = module.delivery_receipts(root, [identifier])
    assert replaced, "the replacement must occur at the file-open boundary"
    assert result[identifier] == {"status": "unobserved"}


def test_stage_replacement_after_enumeration_cannot_redirect_leaf_reads(tmp_path, monkeypatch):
    identifier = "00000000-0000-4000-8000-000000000009"
    root = tmp_path / "queue"
    root.mkdir()
    _place(root, "sent", identifier, "")
    stage = root / "sent"
    stage_identity = stage.stat()
    outside = tmp_path / "outside"
    outside.mkdir()
    _sent_receipt(outside / f"{identifier}.json", identifier)
    original_scandir = os.scandir
    replaced = False

    def scandir(path):
        nonlocal replaced
        entries = original_scandir(path)
        info = os.fstat(path) if isinstance(path, int) else os.stat(path)
        if not replaced and (info.st_dev, info.st_ino) == (
            stage_identity.st_dev, stage_identity.st_ino
        ):
            stage.rename(root / "saved-stage")
            stage.symlink_to(outside, target_is_directory=True)
            replaced = True
        return entries

    monkeypatch.setattr(os, "scandir", scandir)
    result = module.delivery_receipts(root, [identifier])
    assert replaced, "the replacement must occur after opening the directory iterator"
    assert result[identifier] == {"status": "pending"}


def test_leaf_replacement_after_validation_keeps_the_opened_bytes(tmp_path, monkeypatch):
    identifier = "00000000-0000-4000-8000-000000000010"
    root = tmp_path / "queue"
    root.mkdir()
    _place(root, "sent", identifier, "")
    leaf = root / "sent" / f"{identifier}.json"
    leaf_identity = leaf.stat()
    outside = tmp_path / "outside.json"
    _sent_receipt(outside, identifier)
    original_fstat = os.fstat
    original_stat = Path.stat
    replaced = False

    def replace(info):
        nonlocal replaced
        if not replaced and (info.st_dev, info.st_ino) == (
            leaf_identity.st_dev, leaf_identity.st_ino
        ):
            leaf.rename(root / "saved-leaf.json")
            leaf.symlink_to(outside)
            replaced = True
        return info

    def stat_path(path, *args, **kwargs):
        return replace(original_stat(path, *args, **kwargs))

    monkeypatch.setattr(os, "fstat", lambda fd: replace(original_fstat(fd)))
    monkeypatch.setattr(Path, "stat", stat_path)
    result = module.delivery_receipts(root, [identifier])
    assert replaced, "the replacement must occur after inspecting the original file"
    assert result[identifier] == {"status": "pending"}


@given(value=st.one_of(st.none(), st.booleans(), st.integers(), st.lists(st.integers())))
def test_non_object_json_is_not_a_delivery_receipt(value):
    identifier = "00000000-0000-4000-8000-000000000011"
    with TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "sent").mkdir()
        (root / "sent" / f"{identifier}.json").write_text(json.dumps(value))
        assert module.delivery_receipts(root, [identifier])[identifier] == {
            "status": "unobserved"
        }


@given(value=st.one_of(st.none(), st.booleans(), st.integers(), st.lists(st.integers())))
def test_non_object_delivery_is_not_a_delivery_receipt(value):
    identifier = "00000000-0000-4000-8000-000000000012"
    with TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "sent").mkdir()
        (root / "sent" / f"{identifier}.json").write_text(
            json.dumps({"id": identifier, "delivery": value})
        )
        assert module.delivery_receipts(root, [identifier])[identifier] == {
            "status": "unobserved"
        }


@given(status=st.one_of(st.lists(st.integers()), st.dictionaries(st.text(), st.integers())))
def test_non_string_status_cannot_claim_delivery_or_abort_observation(status):
    identifier = "00000000-0000-4000-8000-000000000013"
    with TemporaryDirectory() as directory:
        root = Path(directory)
        _place(root, "sent", identifier, "", status=status)
        assert module.delivery_receipts(root, [identifier])[identifier] == {
            "status": "pending"
        }


def test_receipt_that_grows_after_size_check_is_rejected(tmp_path, monkeypatch):
    identifier = "00000000-0000-4000-8000-000000000014"
    (tmp_path / "sent").mkdir()
    leaf = tmp_path / "sent" / f"{identifier}.json"
    _sent_receipt(leaf, identifier)
    before = leaf.stat()
    original_fstat = os.fstat
    enlarged = False

    def fstat(descriptor):
        nonlocal enlarged
        observed = original_fstat(descriptor)
        if not enlarged and (observed.st_dev, observed.st_ino) == (
            before.st_dev, before.st_ino
        ):
            with leaf.open("ab") as stream:
                stream.write(b" " * (1024 * 1024))
            enlarged = True
        return observed

    monkeypatch.setattr(os, "fstat", fstat)
    result = module.delivery_receipts(tmp_path, [identifier])
    assert enlarged, "the fixture must grow after the descriptor size check"
    assert result[identifier] == {"status": "unobserved"}


def test_fifo_receipt_does_not_wait_for_a_writer(tmp_path):
    identifier = "00000000-0000-4000-8000-000000000015"
    (tmp_path / "sent").mkdir()
    os.mkfifo(tmp_path / "sent" / f"{identifier}.json")
    program = """
import json, runpy, sys
reader = runpy.run_path(sys.argv[1])["delivery_receipts"]
print(json.dumps(reader(sys.argv[2], [sys.argv[3]])))
"""
    result = subprocess.run(
        [sys.executable, "-B", "-c", program, module.__file__, str(tmp_path), identifier],
        capture_output=True, text=True, timeout=5, check=True,
    )
    assert json.loads(result.stdout)[identifier] == {"status": "unobserved"}


def test_deep_json_receipt_does_not_abort_other_stage_observations(tmp_path):
    identifier = "00000000-0000-4000-8000-000000000016"
    _place(tmp_path, "outbox", identifier, "")
    (tmp_path / "sent").mkdir()
    depth = 10000
    payload = "[" * depth + "0" + "]" * depth
    assert len(payload) < 1024 * 1024
    (tmp_path / "sent" / f"{identifier}.json").write_text(payload)
    assert module.delivery_receipts(tmp_path, [identifier])[identifier] == {
        "status": "pending"
    }


@given(suffix=st.sampled_from(["/", "/."]))
def test_root_path_alias_cannot_hide_a_symlink(suffix):
    identifier = "00000000-0000-4000-8000-000000000017"
    with TemporaryDirectory() as directory:
        parent = Path(directory)
        outside = parent / "outside"
        (outside / "sent").mkdir(parents=True)
        _sent_receipt(outside / "sent" / f"{identifier}.json", identifier)
        root = parent / "queue"
        root.symlink_to(outside, target_is_directory=True)
        assert module.delivery_receipts(str(root) + suffix, [identifier])[identifier] == {
            "status": "unobserved"
        }
