"""#3700: the collector controller log (logs/collector.jsonl) is hard-capped.

The dispatcher's dispatch.jsonl has gone through deploy/scripts/lib/bounded_jsonl.py
since #2135; the collector appended with a plain O_APPEND write, and one host's
collector.jsonl reached 224 MB. The log now uses the same writer: a hard byte cap
from BOT_ERRORS_COLLECTOR_JSONL_MAX_BYTES (default 50 MiB), trimming that keeps
the newest records, private mode, no-follow.

Failing-first: with a 4 KiB cap and 200 records, the size assertion fails on the
plain append because the file holds all 200 records. Guard-removal mutant:
restoring the plain append inside append_collector_log_record fails the same
assertion.
"""
from __future__ import annotations

import importlib.util
import json
import stat
from pathlib import Path

import pytest

_CONFTEST_PATH = Path(__file__).resolve().parent / "conftest.py"
_conftest_spec = importlib.util.spec_from_file_location("bot_errors_collector_test_conftest", _CONFTEST_PATH)
_conftest = importlib.util.module_from_spec(_conftest_spec)  # type: ignore[arg-type]
_conftest_spec.loader.exec_module(_conftest)  # type: ignore[union-attr]

_env = _conftest._env
_load_mod_with_dirs = _conftest._load_mod_with_dirs

CAP_BYTES = 4096
RECORDS = 200


def _records(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_collector_log_stays_within_the_cap_and_keeps_the_newest_records(tmp_state) -> None:
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir, {"BOT_ERRORS_COLLECTOR_JSONL_MAX_BYTES": str(CAP_BYTES)})
    assert mod.MAX_COLLECTOR_JSONL_BYTES == CAP_BYTES
    with _env(state_dir, outbox_dir):
        results = [mod.append_log({"type": "relay_cycle", "cycle": index}) for index in range(RECORDS)]
    assert results == ["written"] * RECORDS

    log_path = state_dir / "logs" / "collector.jsonl"
    assert log_path.is_file() and not log_path.is_symlink()
    assert log_path.stat().st_size <= CAP_BYTES
    assert stat.S_IMODE(log_path.stat().st_mode) == 0o600

    records = _records(log_path)
    assert 0 < len(records) < RECORDS
    assert records[-1]["type"] == "relay_cycle"
    assert records[-1]["details"]["cycle"] == RECORDS - 1
    # Trimming keeps the newest records: the retained cycles are one contiguous tail.
    cycles = [record["details"]["cycle"] for record in records]
    assert cycles == list(range(RECORDS - len(records), RECORDS))


def test_collector_log_cap_defaults_to_fifty_mebibytes(tmp_state) -> None:
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    assert mod.MAX_COLLECTOR_JSONL_BYTES == 50 * 1024 * 1024


@pytest.mark.parametrize("value", ["0", "-1"])
def test_collector_log_cap_must_be_positive(tmp_state, value: str) -> None:
    state_dir, outbox_dir = tmp_state
    with pytest.raises(ValueError, match="BOT_ERRORS_COLLECTOR_JSONL_MAX_BYTES"):
        _load_mod_with_dirs(state_dir, outbox_dir, {"BOT_ERRORS_COLLECTOR_JSONL_MAX_BYTES": value})
