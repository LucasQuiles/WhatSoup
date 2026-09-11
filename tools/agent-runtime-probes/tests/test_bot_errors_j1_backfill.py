#!/usr/bin/env python3
"""Tests for bot_errors_j1_backfill: hour bucketing, coverage bounds, reuse of the collector's
section blocks, forensics-copy selection, and the CLI's fail-closed edges. Every reconstructed
number is checked against a count computed here from the fixture, never against the section's
own output."""

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
import stat
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import bot_errors_j1_backfill as b  # noqa: E402
import bot_errors_j1_collector as c  # noqa: E402

H = 3600
T0 = int(dt.datetime(2026, 8, 18, tzinfo=dt.timezone.utc).timestamp())


def _iso(t):
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _stamp(t):
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _rec(t, typ="cycle_completed", **details):
    r = {"time": _iso(t), "type": typ, "component": "dispatcher"}
    if details:
        r["details"] = details
    return json.dumps(r)


def _write_lines(path, lines, gz=False):
    data = "".join(line + "\n" for line in lines).encode("utf-8")
    if gz:
        with gzip.open(path, "wb") as f:
            f.write(data)
    else:
        with open(path, "wb") as f:
            f.write(data)


def _snapshot(tmp_path, current, archive=None):
    snap = tmp_path / "snapshot"
    snap.mkdir()
    _write_lines(snap / "dispatch.jsonl", current)
    if archive is not None:
        _write_lines(snap / "dispatch.jsonl.1700000000.gz", archive, gz=True)
    (snap / "notes.txt").write_text("not a log\n")
    return str(snap)


def _store(n_open, opened_at, trips=()):
    return {
        "openIncidents": {
            f"k{i}": {
                "status": "open",
                "openedAt": opened_at,
                "suppressedCount": 2,
                "renotifyCount": 1,
            }
            for i in range(n_open)
        },
        "flapState": {"f0": {"cumulativeCount": 4, "tripTimestamps": list(trips)}}
        if trips
        else {},
        "updatedAt": _iso(opened_at),
    }


def _forensics(tmp_path, copies):
    """copies: {dirname: store-dict or None (dir without incident-state.json)}"""
    root = tmp_path / "forensics"
    root.mkdir()
    for name, store in copies.items():
        d = root / name
        d.mkdir()
        if store is not None:
            (d / "incident-state.json").write_text(json.dumps(store))
    return str(root)


def _args(**kw):
    base = {
        "snapshot_dir": None,
        "forensics_dir": None,
        "start": _iso(T0),
        "end": _iso(T0 + 48 * H),
        "inventory_stale_s": 3 * H,
        "out": None,
    }
    base.update(kw)
    return argparse.Namespace(**base)


def _hourly(first, last, step=H, offset=1800, **details):
    return [_rec(t + offset, **details) for t in range(first, last + 1, step)]


def _sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


# ----------------------------------------------------------------------------- section reuse


def test_section_script_extracts_exactly_the_alert_host_blocks():
    d = c.section_script("dispatch-outcomes")
    i = c.section_script("incident-inventory")
    assert d.startswith("# Dispatch outcomes")
    assert i.startswith("# Open-incident inventory")
    for s in (d, i):
        assert "=== SECTION" not in s
        assert "\nPY\n" not in s
        assert "S, ST, EN = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])" in s
    with pytest.raises(ValueError):
        c.section_script("no-such-section")


# ----------------------------------------------------------------------------- bucketing


def test_load_dispatch_buckets_decodable_records_by_hour_and_counts_the_rest_per_file(
    tmp_path,
):
    current = [
        _rec(T0 + 10 * H + 300),
        "this is not json",
        json.dumps({"type": "no_time_field"}),
        json.dumps({"time": "yesterday", "type": "bad_time"}),
        _rec(T0 + 10 * H + 3000, typ="stale_renotify_suppressed"),
    ]
    archive = [_rec(T0 + 1800), _rec(T0 + H + 1800)]
    snap = _snapshot(tmp_path, current, archive)

    buckets, receipts = b.load_dispatch(snap)

    assert sorted(buckets) == [T0, T0 + H, T0 + 10 * H]
    assert len(buckets[T0 + 10 * H]) == 2
    assert [r["file"] for r in receipts] == [
        "dispatch.jsonl",
        "dispatch.jsonl.1700000000.gz",
    ]
    cur, arc = receipts
    assert (cur["lines"], cur["undecodable"]) == (5, 3)
    assert (cur["first_time"], cur["last_time"]) == (
        _iso(T0 + 10 * H + 300),
        _iso(T0 + 10 * H + 3000),
    )
    assert cur["sha256"] == _sha(os.path.join(snap, "dispatch.jsonl"))
    assert (arc["lines"], arc["undecodable"]) == (2, 0)
    assert arc["sha256"] == _sha(os.path.join(snap, "dispatch.jsonl.1700000000.gz"))


def test_empty_log_yields_no_buckets_and_a_receipt_without_span(tmp_path):
    snap = _snapshot(tmp_path, [])
    buckets, receipts = b.load_dispatch(snap)
    assert buckets == {}
    assert receipts[0]["lines"] == 0 and receipts[0]["first_time"] is None


# ----------------------------------------------------------------------------- coverage bounds


def test_only_hours_fully_inside_a_retained_span_are_reconstructed_and_gaps_are_contiguous(
    tmp_path,
):
    # Archive: a partial first hour (record at :05) then one record per hour at :30 through
    # hour 29. Current log: one record per hour at :30 for hours 40..45. Both first and last
    # hours of each file are partial by construction, so they must NOT be reconstructed.
    archive = [_rec(T0 + 300)] + _hourly(T0 + H, T0 + 29 * H, durationMs=40)
    current = _hourly(T0 + 40 * H, T0 + 45 * H, durationMs=70)
    snap = _snapshot(tmp_path, current, archive)

    doc = b.build(_args(snapshot_dir=snap))

    assert doc["range"] == {
        "start_utc": _iso(T0),
        "end_utc": _iso(T0 + 48 * H),
        "hours": 48,
    }
    covered = [
        r["window_start_utc"] for r in doc["rows"] if r["dispatch_outcomes"] is not None
    ]
    assert covered == [
        _iso(T0 + k * H) for k in list(range(1, 29)) + list(range(41, 45))
    ]
    assert doc["coverage"] == {
        "dispatch_hours": 32,
        "inventory_hours": 0,
        "inventory_hours_stale": 0,
    }
    assert doc["not_reconstructable"]["dispatch_outcomes"] == [
        {"start_utc": _iso(T0), "end_utc": _iso(T0 + H)},
        {"start_utc": _iso(T0 + 29 * H), "end_utc": _iso(T0 + 41 * H)},
        {"start_utc": _iso(T0 + 45 * H), "end_utc": _iso(T0 + 48 * H)},
    ]
    # No forensics dir: the inventory family is null everywhere, with its reason, as one gap.
    assert doc["not_reconstructable"]["incident_inventory"] == [
        {"start_utc": _iso(T0), "end_utc": _iso(T0 + 48 * H)}
    ]
    assert all(r["incident_reason"] == "no_incident_store_copy" for r in doc["rows"])
    assert all(r["measurement_mode"] == "reconstructed" for r in doc["rows"])
    gap_rows = [r for r in doc["rows"] if r["dispatch_outcomes"] is None]
    assert all(r["dispatch_reason"] == "no_log_coverage" for r in gap_rows)


def test_reconstructed_hour_counts_its_window_and_trailing_day_and_nulls_file_level_fields(
    tmp_path,
):
    archive = [_rec(T0 + 300)] + _hourly(T0 + H, T0 + 29 * H, durationMs=40)
    snap = _snapshot(tmp_path, [], archive)

    doc = b.build(_args(snapshot_dir=snap, end=_iso(T0 + 30 * H)))
    rows = {r["window_start_utc"]: r for r in doc["rows"]}

    late = rows[_iso(T0 + 25 * H)]["dispatch_outcomes"]
    # window [25h, 26h) holds the :30 record of hour 25; the trailing day [2h, 26h) holds 24.
    assert late["lines_window"] == 1
    assert late["lines_24h"] == 24
    assert late["by_type_window"] == {"cycle_completed": 1}
    assert late["by_type_24h"] == {"cycle_completed": 24}
    assert late["cycle_duration_ms_window"] == {"n": 1, "p50": 40, "p95": 40, "max": 40}
    assert late["denominator_coverage_s"] == 86400
    assert late["denominator_complete"] is True
    assert "lines_undecodable" in b.LIVE_FILE_FIELDS
    for k in b.LIVE_FILE_FIELDS:
        assert late[k] is None, k

    early = rows[_iso(T0 + 5 * H)]["dispatch_outcomes"]
    # trailing day [−18h, 6h) sees the :05 record plus hours 1..5 = 6; history starts at
    # 0h05, so the day is covered for 6h − 300 s and the denominator is flagged incomplete.
    assert early["lines_window"] == 1
    assert early["lines_24h"] == 6
    assert early["denominator_coverage_s"] == 6 * H - 300
    assert early["denominator_complete"] is False


def test_undecodable_lines_are_counted_per_file_and_withdrawn_from_the_rows(tmp_path):
    archive = (
        [_rec(T0 + 300)]
        + _hourly(T0 + H, T0 + 4 * H)
        + ["{not json", _rec(T0 + 2 * H + 1900)]
    )
    snap = _snapshot(tmp_path, [], archive)
    doc = b.build(_args(snapshot_dir=snap, end=_iso(T0 + 5 * H)))
    assert doc["inputs"]["dispatch_files"][1]["undecodable"] == 1
    row = {r["window_start_utc"]: r["dispatch_outcomes"] for r in doc["rows"]}[
        _iso(T0 + 2 * H)
    ]
    assert row["lines_window"] == 2
    assert row["lines_undecodable"] is None


def test_abutting_archive_and_current_files_join_into_one_retained_span(tmp_path):
    # The archive's last record is 12:29:59 and the current log's first is 12:30:00: hour 12
    # is fully retained across the two files and the day behind hour 30 is complete.
    archive = (
        [_rec(T0 + 300)] + _hourly(T0 + H, T0 + 11 * H) + [_rec(T0 + 12 * H + 1799)]
    )
    current = [_rec(T0 + 12 * H + 1800)] + _hourly(T0 + 13 * H, T0 + 40 * H)
    snap = _snapshot(tmp_path, current, archive)
    doc = b.build(_args(snapshot_dir=snap, end=_iso(T0 + 41 * H)))
    rows = {r["window_start_utc"]: r["dispatch_outcomes"] for r in doc["rows"]}
    assert rows[_iso(T0 + 12 * H)]["lines_window"] == 2
    assert rows[_iso(T0 + 30 * H)]["denominator_coverage_s"] == 86400
    assert rows[_iso(T0 + 30 * H)]["denominator_complete"] is True
    assert doc["not_reconstructable"]["dispatch_outcomes"] == [
        {"start_utc": _iso(T0), "end_utc": _iso(T0 + H)},
        {"start_utc": _iso(T0 + 40 * H), "end_utc": _iso(T0 + 41 * H)},
    ]


def test_a_gap_between_archive_and_current_files_stays_a_gap_of_its_own_length(
    tmp_path,
):
    # Archive ends 12:30:00, current starts 12:45:00: hour 12 is not reconstructable, and a
    # day that spans the hole is short by exactly the hole (15 min less the last second).
    archive = [_rec(T0 + 300)] + _hourly(T0 + H, T0 + 12 * H)
    current = [_rec(T0 + 12 * H + 2700)] + _hourly(T0 + 13 * H, T0 + 40 * H)
    snap = _snapshot(tmp_path, current, archive)
    doc = b.build(_args(snapshot_dir=snap, end=_iso(T0 + 41 * H)))
    rows = {r["window_start_utc"]: r["dispatch_outcomes"] for r in doc["rows"]}
    assert rows[_iso(T0 + 12 * H)] is None
    assert rows[_iso(T0 + 11 * H)] is not None and rows[_iso(T0 + 13 * H)] is not None
    hour30 = rows[_iso(T0 + 30 * H)]
    assert hour30["denominator_coverage_s"] == 86400 - (900 - 1)
    assert hour30["denominator_complete"] is False
    assert rows[_iso(T0 + 37 * H)]["denominator_complete"] is True
    assert {"start_utc": _iso(T0 + 12 * H), "end_utc": _iso(T0 + 13 * H)} in doc[
        "not_reconstructable"
    ]["dispatch_outcomes"]


def test_union_coverage_counts_each_second_once_and_clips_to_the_interval():
    spans = [(10, 19), (15, 24), (40, 49), (100, 200)]
    assert b.union_coverage_s(spans, 0, 60) == 15 + 10
    assert b.union_coverage_s(spans, 12, 45) == (25 - 12) + (45 - 40)
    assert b.union_coverage_s([], 0, 60) == 0
    assert b.union_coverage_s([(0, 59)], 0, 60) == 60


def test_a_window_slice_never_leaks_records_from_other_hours_into_the_window(tmp_path):
    # Two records in hour 3, none in hour 4, five in hour 5: the slice for hour 4 still sees
    # the neighbours (for the 24 h denominator) but the window count must be exactly zero.
    archive = (
        [_rec(T0 + 300), _rec(T0 + 3 * H + 100), _rec(T0 + 3 * H + 200)]
        + [_rec(T0 + 5 * H + 10 * k) for k in range(5)]
        + [_rec(T0 + 7 * H + 10)]
    )
    snap = _snapshot(tmp_path, [], archive)
    doc = b.build(_args(snapshot_dir=snap, end=_iso(T0 + 8 * H)))
    rows = {r["window_start_utc"]: r["dispatch_outcomes"] for r in doc["rows"]}
    assert rows[_iso(T0 + 4 * H)]["lines_window"] == 0
    assert rows[_iso(T0 + 4 * H)]["lines_24h"] == 3
    assert rows[_iso(T0 + 5 * H)]["lines_window"] == 5
    assert rows[_iso(T0 + 5 * H)]["lines_24h"] == 8
    assert rows[_iso(T0 + 6 * H)]["lines_window"] == 0


# ----------------------------------------------------------------------------- inventory selection


def test_inventory_uses_the_newest_copy_inside_the_hour_then_a_bounded_stale_fallback(
    tmp_path,
):
    snap = _snapshot(tmp_path, [])
    older = T0 + 5 * H + 600
    newer = T0 + 5 * H + 2400
    fx = _forensics(
        tmp_path,
        {
            _stamp(older): _store(2, T0),
            # one trip 30 s before the copy (inside hour 5) and one 2 h earlier (before it)
            _stamp(newer): _store(1, T0, trips=(newer - 30, newer - 2 * H)),
            "junk-not-a-stamp": _store(9, T0),
            _stamp(T0 + 6 * H): None,  # a tick dir without the store copy is not a copy
        },
    )

    doc = b.build(
        _args(
            snapshot_dir=snap,
            forensics_dir=fx,
            start=_iso(T0 + 5 * H),
            end=_iso(T0 + 10 * H),
        )
    )
    rows = {r["window_start_utc"]: r for r in doc["rows"]}

    assert doc["inputs"]["forensics_copies"] == 2
    assert doc["inputs"]["forensics_first_utc"] == _iso(older)
    assert doc["inputs"]["forensics_last_utc"] == _iso(newer)
    h5 = rows[_iso(T0 + 5 * H)]
    assert h5["incident_source"] == {
        "forensics_dir": _stamp(newer),
        "copy_utc": _iso(newer),
        "stale_s": 0,
        "window_observed_s": 2400,
    }
    inv = h5["incident_inventory"]
    assert inv["open"] == 1
    assert inv["suppressed_total"] == 2
    # The copy observed [5h00, 5h40): one trip inside, and no completeness claim for the hour.
    assert inv["flap_trips_in_window_lower_bound"] == 1
    assert inv["flap_keys_window_complete"] is None
    assert inv["flap_top"] == [
        {"key": "f0", "cumulative": 4, "trips_in_window": 1, "window_complete": None}
    ]
    assert inv["flap_cumulative_retained_total"] == 4
    assert h5["incident_reason"] is None
    for k, stale in ((6, 1200), (7, 4800), (8, 8400)):
        r = rows[_iso(T0 + k * H)]
        assert r["incident_source"]["forensics_dir"] == _stamp(newer)
        assert r["incident_source"]["stale_s"] == stale
        assert r["incident_source"]["window_observed_s"] == 0
        inv = r["incident_inventory"]
        assert inv["open"] == 1
        # A copy taken before the hour observed none of the hour's trips.
        assert inv["flap_trips_in_window_lower_bound"] is None
        assert inv["flap_keys_window_complete"] is None
        assert inv["flap_top"][0]["trips_in_window"] is None
        assert inv["flap_top"][0]["window_complete"] is None
        assert inv["flap_top"][0]["cumulative"] == 4
    h9 = rows[_iso(T0 + 9 * H)]
    assert h9["incident_inventory"] is None and h9["incident_source"] is None
    assert h9["incident_reason"] == "no_incident_store_copy"
    assert doc["coverage"]["inventory_hours"] == 4
    assert doc["coverage"]["inventory_hours_stale"] == 3
    assert doc["not_reconstructable"]["incident_inventory"] == [
        {"start_utc": _iso(T0 + 9 * H), "end_utc": _iso(T0 + 10 * H)}
    ]

    tight = b.build(
        _args(
            snapshot_dir=snap,
            forensics_dir=fx,
            start=_iso(T0 + 5 * H),
            end=_iso(T0 + 10 * H),
            inventory_stale_s=1000,
        )
    )
    assert tight["coverage"] == {
        "dispatch_hours": 0,
        "inventory_hours": 1,
        "inventory_hours_stale": 0,
    }


def test_inventory_age_is_measured_at_the_copy_time_not_at_the_hour_end(tmp_path):
    snap = _snapshot(tmp_path, [])
    copy_at = T0 + 5 * H + 60
    opened = copy_at - 3 * 86400  # exactly three days before the copy was taken
    fx = _forensics(tmp_path, {_stamp(copy_at): _store(1, opened)})
    doc = b.build(
        _args(
            snapshot_dir=snap,
            forensics_dir=fx,
            start=_iso(T0 + 5 * H),
            end=_iso(T0 + 7 * H),
        )
    )
    inside, stale = (r["incident_inventory"] for r in doc["rows"])
    assert inside["age_days_max"] == 3.0
    assert stale["age_days_max"] == 3.0  # the same copy, the same observation


# ----------------------------------------------------------------------------- range handling


def test_range_is_aligned_to_hours_and_validated_before_rounding(tmp_path):
    snap = _snapshot(tmp_path, [])
    doc = b.build(
        _args(snapshot_dir=snap, start=_iso(T0 + 100), end=_iso(T0 + H + 100))
    )
    assert doc["range"] == {
        "start_utc": _iso(T0),
        "end_utc": _iso(T0 + 2 * H),
        "hours": 2,
    }
    # Empty or inverted requests are refused on the requested endpoints: rounding would turn
    # each of these into one "valid" hour.
    for start, end in ((T0 + H, T0 + H), (T0 + 100, T0 + 100), (T0 + 3000, T0 + 600)):
        with pytest.raises(ValueError):
            b.build(_args(snapshot_dir=snap, start=_iso(start), end=_iso(end)))


# ----------------------------------------------------------------------------- CLI


def test_main_blocks_on_missing_inputs_before_any_write(tmp_path, capsys):
    out = str(tmp_path / "out.json")
    rc = b.main(
        [
            "--snapshot-dir",
            str(tmp_path / "nope"),
            "--start",
            _iso(T0),
            "--end",
            _iso(T0 + H),
            "--out",
            out,
        ]
    )
    assert rc == 2
    assert json.loads(capsys.readouterr().out)["class"] == "snapshot-dir-missing"
    snap = _snapshot(tmp_path, [])
    rc = b.main(
        [
            "--snapshot-dir",
            snap,
            "--forensics-dir",
            str(tmp_path / "nope"),
            "--start",
            _iso(T0),
            "--end",
            _iso(T0 + H),
            "--out",
            out,
        ]
    )
    assert rc == 2
    assert json.loads(capsys.readouterr().out)["class"] == "forensics-dir-missing"
    rc = b.main(
        [
            "--snapshot-dir",
            snap,
            "--start",
            _iso(T0 + 3000),
            "--end",
            _iso(T0 + 600),
            "--out",
            out,
        ]
    )
    assert rc == 2
    assert json.loads(capsys.readouterr().out) == {
        "verdict": "Blocked",
        "class": "build",
        "error": "ValueError",
    }
    assert not os.path.exists(out)


def test_main_writes_one_0600_document_and_refuses_to_clobber_it(tmp_path, capsys):
    archive = [_rec(T0 + 300)] + _hourly(T0 + H, T0 + 4 * H)
    snap = _snapshot(tmp_path, [], archive)
    fx = _forensics(tmp_path, {_stamp(T0 + 2 * H + 30): _store(3, T0)})
    out = str(tmp_path / "backfill.json")
    argv = [
        "--snapshot-dir",
        snap,
        "--forensics-dir",
        fx,
        "--start",
        _iso(T0),
        "--end",
        _iso(T0 + 5 * H),
        "--out",
        out,
    ]

    assert b.main(argv) == 0
    receipt = json.loads(capsys.readouterr().out)
    assert receipt["verdict"] == "Pass"
    assert receipt["hours"] == 5
    # dispatch: hours 1..3 are fully inside the archive span (hour 0 and 4 are partial);
    # inventory: the copy at 2h+30s serves hour 2 directly and hours 3..4 as stale fallback.
    assert receipt["coverage"] == {
        "dispatch_hours": 3,
        "inventory_hours": 3,
        "inventory_hours_stale": 2,
    }
    assert receipt["gaps"] == {"dispatch_outcomes": 2, "incident_inventory": 1}
    assert stat.S_IMODE(os.stat(out).st_mode) == 0o600
    assert receipt["out_sha256"] == _sha(out)
    doc = json.loads(open(out).read())
    assert doc["kind"] == b.KIND and doc["schema_version"] == b.SCHEMA_VERSION
    assert doc["measurement_mode"] == "reconstructed"
    assert doc["collector_script_sha256"] == _sha(c.__file__)
    assert doc["inputs"]["dispatch_files"][1]["sha256"] == _sha(
        os.path.join(snap, "dispatch.jsonl.1700000000.gz")
    )
    # stdout carries counts and hashes only: no incident keys, no record bodies.
    assert "k0" not in json.dumps(receipt)

    before = open(out, "rb").read()
    assert b.main(argv) == 2
    assert json.loads(capsys.readouterr().out)["class"] == "out-exists"
    assert open(out, "rb").read() == before
