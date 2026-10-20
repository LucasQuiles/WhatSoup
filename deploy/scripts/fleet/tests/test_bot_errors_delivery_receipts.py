import importlib.util
import json
from pathlib import Path
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
