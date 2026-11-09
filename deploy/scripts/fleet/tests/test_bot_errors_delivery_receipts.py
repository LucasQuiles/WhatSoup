import importlib.util
from contextlib import contextmanager
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace

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


def _observe_scans(monkeypatch):
    original = os.scandir
    observations = []

    @contextmanager
    def scandir(path):
        row = {"entries": 0, "closed": False}
        observations.append(row)
        with original(path) as entries:
            def counted():
                for entry in entries:
                    row["entries"] += 1
                    yield entry
            try:
                yield counted()
            finally:
                row["closed"] = True

    monkeypatch.setattr(os, "scandir", scandir)
    return observations


def test_batch_scans_each_existing_stage_once(tmp_path, monkeypatch):
    identifiers = [f"00000000-0000-4000-8000-{index:012d}" for index in range(128)]
    for identifier in identifiers:
        _place(tmp_path, "outbox", identifier, "")
    scans = _observe_scans(monkeypatch)
    result = module.delivery_receipts(tmp_path, identifiers)
    assert result == {identifier: {"status": "pending"} for identifier in identifiers}
    assert len(scans) == 1
    assert scans[0] == {"entries": 128, "closed": True}


def test_unrelated_entries_exhaust_the_shared_scan_budget(tmp_path, monkeypatch):
    identifier = "00000000-0000-4000-8000-000000000020"
    _place(tmp_path, "sent", identifier, "")
    _sent_receipt(tmp_path / "sent" / f"{identifier}.json", identifier)
    (tmp_path / "outbox").mkdir()
    for index in range(12):
        (tmp_path / "outbox" / f"unrelated-{index}").touch()
    monkeypatch.setattr(module, "MAX_LOOKUP_ENTRIES", 8, raising=False)
    scans = _observe_scans(monkeypatch)
    with pytest.raises(RuntimeError, match="delivery_lookup_limit"):
        module.delivery_receipts(tmp_path, [identifier])
    assert sum(scan["entries"] for scan in scans) <= 9
    assert all(scan["closed"] for scan in scans)


@given(count=st.integers(min_value=1, max_value=12))
def test_exact_scan_budget_accepts_complete_lookup(count):
    identifier = "00000000-0000-4000-8000-000000000021"
    with TemporaryDirectory() as directory, pytest.MonkeyPatch.context() as patch:
        root = Path(directory)
        for index in range(count):
            _place(root, "outbox", identifier, f".{index}")
        patch.setattr(module, "MAX_LOOKUP_ENTRIES", count, raising=False)
        assert module.delivery_receipts(root, [identifier])[identifier] == {"status": "pending"}


def test_matching_name_overflow_cannot_return_a_partial_disposition(tmp_path):
    identifier = "00000000-0000-4000-8000-000000000022"
    for index in range(33):
        _place(tmp_path, "outbox", identifier, f".{index}")
    with pytest.raises(RuntimeError, match="delivery_lookup_limit"):
        module.delivery_receipts(tmp_path, [identifier])


def test_aggregate_read_budget_limits_bytes_before_returning_any_receipt(tmp_path, monkeypatch):
    identifiers = [f"00000000-0000-4000-8000-{index:012d}" for index in range(3)]
    for identifier in identifiers:
        _place(tmp_path, "outbox", identifier, "")
    size = (tmp_path / "outbox" / f"{identifiers[0]}.json").stat().st_size
    limit = size * 2
    monkeypatch.setattr(module, "MAX_LOOKUP_BYTES", limit, raising=False)
    original = os.fdopen
    reads = []

    @contextmanager
    def fdopen(*args, **kwargs):
        with original(*args, **kwargs) as stream:
            def read(amount):
                data = stream.read(amount)
                reads.append(len(data))
                return data
            yield SimpleNamespace(read=read)

    monkeypatch.setattr(os, "fdopen", fdopen)
    with pytest.raises(RuntimeError, match="delivery_lookup_limit"):
        module.delivery_receipts(tmp_path, identifiers)
    assert sum(reads) <= limit + 1


def test_exact_read_budget_keeps_a_valid_receipt(tmp_path, monkeypatch):
    identifier = "00000000-0000-4000-8000-000000000023"
    _place(tmp_path, "sent", identifier, "")
    path = tmp_path / "sent" / f"{identifier}.json"
    _sent_receipt(path, identifier)
    monkeypatch.setattr(module, "MAX_LOOKUP_BYTES", path.stat().st_size, raising=False)
    assert module.delivery_receipts(tmp_path, [identifier])[identifier]["status"] == "sent"


def test_short_reads_reconstruct_the_complete_receipt(tmp_path, monkeypatch):
    identifier = "00000000-0000-4000-8000-000000000029"
    _place(tmp_path, "sent", identifier, "")
    _sent_receipt(tmp_path / "sent" / f"{identifier}.json", identifier)
    original = os.fdopen

    @contextmanager
    def fdopen(*args, **kwargs):
        with original(*args, **kwargs) as stream:
            yield SimpleNamespace(read=lambda amount: stream.read(min(amount, 7)))

    monkeypatch.setattr(os, "fdopen", fdopen)
    assert module.delivery_receipts(tmp_path, [identifier])[identifier]["status"] == "sent"


def test_elapsed_budget_does_not_return_an_earlier_sent_receipt(tmp_path, monkeypatch):
    identifier = "00000000-0000-4000-8000-000000000024"
    _place(tmp_path, "sent", identifier, "")
    _sent_receipt(tmp_path / "sent" / f"{identifier}.json", identifier)
    _place(tmp_path, "outbox", identifier, "")
    clock = [0.0]
    monkeypatch.setattr(module, "time", SimpleNamespace(monotonic=lambda: clock[0]), raising=False)
    original = os.scandir
    outbox = (tmp_path / "outbox").stat()

    @contextmanager
    def scandir(path):
        with original(path) as entries:
            if os.fstat(path).st_ino == outbox.st_ino:
                clock[0] = 6.0
            yield entries

    monkeypatch.setattr(os, "scandir", scandir)
    with pytest.raises(RuntimeError, match="delivery_lookup_limit"):
        module.delivery_receipts(tmp_path, [identifier])


def test_delayed_unavailable_root_does_not_bypass_elapsed_budget(tmp_path, monkeypatch):
    identifier = "00000000-0000-4000-8000-000000000031"
    clock = [0.0]
    monkeypatch.setattr(module, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    original = os.open

    def open_root(path, *args, **kwargs):
        if path == tmp_path:
            clock[0] = 6.0
            raise FileNotFoundError(2, "root disappeared")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(os, "open", open_root)
    with pytest.raises(RuntimeError, match="delivery_lookup_limit"):
        module.delivery_receipts(tmp_path, [identifier])


@given(audit=st.text(alphabet=st.sampled_from(["x", "é", "😀", "\"", "\\"]), min_size=20, max_size=80))
def test_response_budget_counts_json_escaping_and_newline(audit):
    identifier = "00000000-0000-4000-8000-000000000025"
    expected = {identifier: {"status": "sent", "sent_at": None, "audit_receipt": audit}}
    encoded = (json.dumps(expected, sort_keys=True) + "\n").encode()
    with TemporaryDirectory() as directory, pytest.MonkeyPatch.context() as patch:
        root = Path(directory)
        (root / "sent").mkdir()
        (root / "sent" / f"{identifier}.json").write_text(json.dumps({
            "id": identifier, "delivery": {"status": "sent", "auditReceipt": audit},
        }))
        patch.setattr(module, "MAX_RESPONSE_BYTES", len(encoded), raising=False)
        assert module.delivery_receipts(root, [identifier]) == expected
        patch.setattr(module, "MAX_RESPONSE_BYTES", len(encoded) - 1)
        with pytest.raises(RuntimeError, match="delivery_lookup_limit"):
            module.delivery_receipts(root, [identifier])


def test_cli_oversized_receipt_is_a_small_failure_without_private_output(tmp_path):
    identifier = "00000000-0000-4000-8000-000000000026"
    sent = tmp_path / ".local/state/bot-errors/sent"
    sent.mkdir(parents=True)
    (sent / f"{identifier}.json").write_text(json.dumps({
        "id": identifier,
        "delivery": {"status": "sent", "auditReceipt": "private-" + "x" * 70000},
    }))
    result = subprocess.run(
        [sys.executable, "-B", module.__file__, identifier],
        env={**os.environ, "HOME": str(tmp_path)}, capture_output=True, timeout=5,
    )
    assert result.returncode == 1
    assert json.loads(result.stdout) == {"code": "delivery_observation_failed"}
    assert len(result.stdout) < 65536
    assert b"private" not in result.stdout and identifier.encode() not in result.stdout
    assert result.stderr == b""


def test_scan_error_cannot_return_an_earlier_sent_receipt(tmp_path, monkeypatch):
    identifier = "00000000-0000-4000-8000-000000000027"
    _place(tmp_path, "sent", identifier, "")
    _sent_receipt(tmp_path / "sent" / f"{identifier}.json", identifier)
    _place(tmp_path, "outbox", identifier, "")
    original = os.scandir
    outbox = (tmp_path / "outbox").stat()

    @contextmanager
    def scandir(path):
        with original(path) as entries:
            if os.fstat(path).st_ino == outbox.st_ino:
                raise OSError("private path must not escape")
            yield entries

    monkeypatch.setattr(os, "scandir", scandir)
    with pytest.raises(RuntimeError, match="^delivery_observation_failed$"):
        module.delivery_receipts(tmp_path, [identifier])


def test_unreadable_stage_cannot_return_an_earlier_sent_receipt(tmp_path, monkeypatch):
    identifier = "00000000-0000-4000-8000-000000000030"
    _place(tmp_path, "sent", identifier, "")
    _sent_receipt(tmp_path / "sent" / f"{identifier}.json", identifier)
    _place(tmp_path, "outbox", identifier, "")
    original = os.open

    def open_directory(path, *args, **kwargs):
        if path == "outbox":
            raise PermissionError("private path must not escape")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(os, "open", open_directory)
    with pytest.raises(RuntimeError, match="^delivery_observation_failed$"):
        module.delivery_receipts(tmp_path, [identifier])


def test_combined_response_budget_rejects_individually_small_receipts(tmp_path, monkeypatch):
    identifiers = [f"00000000-0000-4000-8000-{index:012d}" for index in range(2)]
    for identifier in identifiers:
        _place(tmp_path, "sent", identifier, "")
        (tmp_path / "sent" / f"{identifier}.json").write_text(json.dumps({
            "id": identifier, "delivery": {"status": "sent", "auditReceipt": "x" * 40000},
        }))
        assert module.delivery_receipts(tmp_path, [identifier])[identifier]["status"] == "sent"
    with pytest.raises(RuntimeError, match="delivery_lookup_limit"):
        module.delivery_receipts(tmp_path, identifiers)


def test_supervisor_keeps_batch_and_event_ids_after_receipt_budget_failure(tmp_path, monkeypatch):
    supervisor_spec = importlib.util.spec_from_file_location(
        "reliability_supervisor_receipt_budget", Path(module.__file__).with_name("reliability_supervisor.py")
    )
    supervisor = importlib.util.module_from_spec(supervisor_spec)
    monkeypatch.setitem(sys.modules, supervisor_spec.name, supervisor)
    supervisor_spec.loader.exec_module(supervisor)
    identifier = "00000000-0000-4000-8000-000000000028"
    sent = tmp_path / ".local/state/bot-errors/sent"
    sent.mkdir(parents=True)
    leaf = sent / f"{identifier}.json"
    leaf.write_text(json.dumps({
        "id": identifier, "delivery": {"status": "sent", "auditReceipt": "x" * 70000},
    }))
    monkeypatch.setenv("HOME", str(tmp_path))
    alert = {"event_id": identifier, "delivery": "published", "published_at": 10}
    config = {"delivery_command": [sys.executable, "-B", module.__file__]}
    assert supervisor.resolve_alert_delivery(config, [alert]) == [{"code": "nonzero_exit", "returncode": 1}]
    assert alert == {"event_id": identifier, "delivery": "published", "published_at": 10}
    _sent_receipt(leaf, identifier)
    assert supervisor.resolve_alert_delivery(config, [alert]) == []
    assert alert["event_id"] == identifier and alert["delivery"] == "channel_delivered"
    assert alert["delivery_receipt"]["audit_receipt"] == "outside-receipt"
