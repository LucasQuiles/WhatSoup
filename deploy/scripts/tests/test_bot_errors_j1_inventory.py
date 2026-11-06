"""Exercise J1 inventory bounds through the same section used by live and backfill reads."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest


_SCRIPT = (
    Path(__file__).resolve().parents[3]
    / "tools/agent-runtime-probes/bot_errors_j1_backfill.py"
)
_SPEC = importlib.util.spec_from_file_location("j1_inventory_backfill", _SCRIPT)
assert _SPEC is not None and _SPEC.loader is not None
backfill = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(backfill)
collector = backfill.collector
_END = 1789098550
_MAX_BYTES = 8 * 1024 * 1024


def _inventory(state_dir, start=_END - 3600, end=_END):
    return subprocess.run(
        [sys.executable, "-", str(state_dir), str(start), str(end)],
        input=collector.section_script("incident-inventory"),
        text=True,
        capture_output=True,
        timeout=10,
    )


@pytest.mark.parametrize("rows", [1000, 1001])
def test_history_details_are_unknown_above_the_scan_bound(tmp_path, rows):
    history = {f"private-{n}": {"closedAt": _END - 86400} for n in range(rows)}
    history[f"private-{rows - 1}"]["source"] = "daily-health-fail:fixture"
    (tmp_path / "incident-state.json").write_text(
        json.dumps({"staleAutocloseHistory": history})
    )
    result = _inventory(tmp_path)
    assert result.returncode == 0, result.stderr
    assert "private-" not in result.stdout
    facts = json.loads(result.stdout)["historical_autoclose"]
    assert facts["count"] == rows
    assert facts["daily_health_fail_count"] == (1 if rows <= 1000 else None)
    assert facts["scan_limit"] == 1000
    assert facts["truncated"] is (rows > 1000)
    assert facts["rows_scanned"] == (rows if rows <= 1000 else 0)
    assert facts["oldest_age_days"] == (1.0 if rows <= 1000 else None)
    assert facts["rows_skipped"] == (0 if rows <= 1000 else None)
    assert facts["future_count"] == (0 if rows <= 1000 else None)


@pytest.mark.parametrize("extra_byte", [0, 1])
def test_inventory_read_has_a_byte_limit_and_preserves_failed_section(tmp_path, extra_byte):
    payload = b'{"staleAutocloseHistory":{}}'
    path = tmp_path / "incident-state.json"
    path.write_bytes(payload + b" " * (_MAX_BYTES + extra_byte - len(payload)))
    result = _inventory(tmp_path)
    if not extra_byte:
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout)["historical_autoclose"]["count"] == 0
    else:
        assert result.returncode != 0
        assert "incident inventory state exceeds 8388608-byte limit" in result.stderr
        planes = (
            "=== SECTION incident-inventory ===\n"
            + result.stdout
            + f"\nSECTION_RC incident-inventory {result.returncode}\n"
        )
        facts = collector.parse_planes(planes, ())
        assert facts["incident_inventory"] is None
        assert "incident-inventory" in facts["failed_sections"]


def _run_section(name, state_dir, start, end):
    assert name == "incident-inventory"
    result = _inventory(state_dir, start, end)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_historical_autoclose_inventory_is_bounded_and_survives_plane_parsing(tmp_path):
    en = 1789098550
    history = {
        "old": {"closedAt": en - 32 * 86400, "source": "daily-health-fail:a"},
        "future": {"closedAt": en + 1, "source": "daily-health-fail:b"},
        "bool": {"closedAt": True},
        "string": {"closedAt": str(en)},
        "zero": {"closedAt": 0},
        "broken": None,
    }
    history.update({f"private-key-{i}": {"closedAt": en} for i in range(994)})
    (tmp_path / "incident-state.json").write_text(json.dumps({"staleAutocloseHistory": history}))
    out = _run_section("incident-inventory", str(tmp_path), en - 3600, en)
    expected = {
        "count": 1000, "daily_health_fail_count": 2, "oldest_age_days": 32.0,
        "rows_skipped": 4, "future_count": 1, "history_malformed": False,
        "rows_scanned": 1000, "scan_limit": 1000, "truncated": False,
    }
    assert out["historical_autoclose"] == expected
    assert out["open"] == 0 and out["age_days_max"] is None
    assert "private-key" not in json.dumps(out)
    planes = "=== SECTION incident-inventory ===\n" + json.dumps(out) + "\nSECTION_RC incident-inventory 0\n"
    assert collector.parse_planes(planes, ())["incident_inventory"]["historical_autoclose"] == expected


@pytest.mark.parametrize("store, count, malformed", [
    ({}, 0, False),
    ({"staleAutocloseHistory": {}}, 0, False),
    ({"staleAutocloseHistory": None}, None, True),
    ({"staleAutocloseHistory": []}, None, True),
])
def test_historical_autoclose_missing_and_malformed_are_distinct(tmp_path, store, count, malformed):
    (tmp_path / "incident-state.json").write_text(json.dumps(store))
    out = _run_section("incident-inventory", str(tmp_path), 1789094950, 1789098550)
    assert out["historical_autoclose"] == {
        "count": count, "daily_health_fail_count": count, "oldest_age_days": None,
        "rows_skipped": count, "future_count": count, "history_malformed": malformed,
        "rows_scanned": 0, "scan_limit": 1000, "truncated": False,
    }


def test_missing_incident_store_remains_a_failed_read(tmp_path):
    result = subprocess.run(
        [sys.executable, "-", str(tmp_path), "1789094950", "1789098550"],
        input=collector.section_script("incident-inventory"), text=True, capture_output=True, timeout=10,
    )
    assert result.returncode != 0
    planes = "=== SECTION incident-inventory ===\n" + result.stdout + f"\nSECTION_RC incident-inventory {result.returncode}\n"
    facts = collector.parse_planes(planes, ())
    assert facts["incident_inventory"] is None
    assert "incident-inventory" in facts["failed_sections"]


def test_reconstructed_history_age_uses_forensics_copy_time(tmp_path):
    hour = _END - (_END % 3600)
    copy_t = hour + 1800
    store = {"openIncidents": {}, "flapState": {}}
    store["staleAutocloseHistory"] = {
        "prior": {"closedAt": copy_t - 86400, "source": "daily-health-fail:a"},
        "future": {"closedAt": copy_t + 1},
    }
    (tmp_path / "incident-state.json").write_text(json.dumps(store))
    facts, source = backfill.reconstruct_inventory(hour, [(copy_t, str(tmp_path))], 3600)
    assert facts["historical_autoclose"] == {
        "count": 2, "daily_health_fail_count": 1, "oldest_age_days": 1.0,
        "rows_skipped": 0, "future_count": 1, "history_malformed": False,
        "rows_scanned": 2, "scan_limit": 1000, "truncated": False,
    }
    assert source["copy_utc"] == backfill.iso(copy_t)

