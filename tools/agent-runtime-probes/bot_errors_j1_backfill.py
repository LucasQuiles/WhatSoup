#!/usr/bin/env python3
"""BOT ERRORS J1 metric backfill: reconstruct the collector's metric families per hour from
retained history, labelled `measurement_mode: reconstructed`, with every gap stated.

Inputs (all local, read-only):
  --snapshot-dir   a directory holding `dispatch.jsonl` (a copy of the dispatcher's bounded log)
                   and optionally `dispatch.jsonl.<epoch>.gz` (its rotated archive)
  --forensics-dir  the maclab dispatcher-probe forensics root: `<stamp>/incident-state.json`
                   copies taken on every non-OK probe tick
  --start/--end    the hourly range to reconstruct (UTC, half-open, aligned down/up to the hour)

Each hour runs the collector's own section blocks (bot_errors_j1_collector.section_script) so
the reconstructed numbers come from exactly the parser the alert host runs. The dispatch block
sees a per-hour slice holding the 25 hourly buckets it needs (the window plus its trailing-24 h
denominator); fields that describe the live file rather than the hour (line totals, span,
mtime, undecodable count) are nulled in the row and reported once per input file. An hour is
reconstructed only when the union of the retained spans covers it completely; the trailing
day's coverage is reported in seconds beside `denominator_complete`.

The inventory block runs against the newest forensics copy taken inside the hour (a copy up to
--inventory-stale-s before the hour start is accepted and flagged `stale_s`). A copy is a point
sample: every inventory number is the store's state at the copy time (ages included), the flap
window ends at the copy time, window completeness is never claimed, and a copy taken before the
hour reports the hour's trips as unobserved.

An hour with no dispatch history, or no incident-store copy, gets null for that family and a
reason; the contiguous gaps are listed under `not_reconstructable`. Nothing is interpolated.
Output: one JSON document (0600, no-clobber). stdout: counts only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bot_errors_j1_collector as collector  # noqa: E402

SCHEMA_VERSION = "1.0"
KIND = "bot-errors-metric-backfill"
HOUR = 3600
DAY = 86400
# Fields the dispatch section derives from the live file as a whole. In a reconstructed row
# they would describe the per-hour slice (which holds only decodable records), so they are
# withdrawn; the per-file receipts carry the real values once.
LIVE_FILE_FIELDS = (
    "log_bytes",
    "log_mtime_age_s",
    "lines_total",
    "lines_undecodable",
    "first_time",
    "last_time",
)


def parse_iso(s: str) -> int:
    return int(collector.parse_iso(s).timestamp())


def iso(t: int) -> str:
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_dispatch(snapshot_dir: str) -> tuple[dict[int, list[str]], list[dict]]:
    """Bucket every decodable dispatch record by hour; return the buckets and the per-file
    receipts (span, counts, sha). Undecodable lines are counted per file, never bucketed."""
    files = []
    for name in sorted(os.listdir(snapshot_dir)):
        if name == "dispatch.jsonl" or (
            name.startswith("dispatch.jsonl.") and name.endswith(".gz")
        ):
            files.append(os.path.join(snapshot_dir, name))
    buckets: dict[int, list[str]] = {}
    receipts = []
    for path in files:
        opener = gzip.open if path.endswith(".gz") else open
        n = bad = 0
        first = last = None
        with opener(path, "rt", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                n += 1
                try:
                    r = json.loads(line)
                except ValueError:
                    bad += 1
                    continue
                if not isinstance(r, dict) or not isinstance(r.get("time"), str):
                    bad += 1
                    continue
                try:
                    t = parse_iso(r["time"])
                except ValueError:
                    bad += 1
                    continue
                first = t if first is None else min(first, t)
                last = t if last is None else max(last, t)
                buckets.setdefault(t - t % HOUR, []).append(line.rstrip("\n"))
        receipts.append(
            {
                "file": os.path.basename(path),
                "sha256": sha256_file(path),
                "lines": n,
                "undecodable": bad,
                "first_time": iso(first) if first is not None else None,
                "last_time": iso(last) if last is not None else None,
            }
        )
    return buckets, receipts


def union_coverage_s(spans: list[tuple[int, int]], a: int, b: int) -> int:
    """Seconds of [a, b) covered by the union of retained spans. A span (first, last) covers
    [first, last + 1): the second of the last record counts, nothing after it does. Files
    that abut join; a gap between files stays a gap of exactly its length."""
    total = 0
    reach = a
    for lo, hi in sorted((max(s0, a), min(s1 + 1, b)) for s0, s1 in spans):
        lo = max(lo, reach)
        if hi > lo:
            total += hi - lo
            reach = hi
    return total


def forensics_index(forensics_dir: str) -> list[tuple[int, str]]:
    """(epoch, path) of every `<stamp>/incident-state.json` copy, sorted by stamp."""
    out = []
    for name in os.listdir(forensics_dir):
        p = os.path.join(forensics_dir, name, "incident-state.json")
        if not os.path.isfile(p):
            continue
        try:
            t = int(
                dt.datetime.strptime(name, "%Y%m%dT%H%M%SZ")
                .replace(tzinfo=dt.timezone.utc)
                .timestamp()
            )
        except ValueError:
            continue
        out.append((t, os.path.dirname(p)))
    return sorted(out)


def run_section(name: str, state_dir: str, st: int, en: int) -> dict:
    r = subprocess.run(
        [sys.executable, "-", state_dir, str(st), str(en)],
        input=collector.section_script(name),
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"{name} failed rc={r.returncode}: {r.stderr[-300:]}")
    return json.loads(r.stdout.strip().splitlines()[-1])


def reconstruct_dispatch(
    hour: int, buckets: dict[int, list[str]], spans: list[tuple[int, int]], scratch: str
) -> dict | None:
    if union_coverage_s(spans, hour, hour + HOUR) != HOUR:
        return None
    state = os.path.join(scratch, "state")
    logs = os.path.join(state, "logs")
    os.makedirs(logs, mode=0o700, exist_ok=True)
    with open(os.path.join(logs, "dispatch.jsonl"), "w", encoding="utf-8") as f:
        for b in range(hour - DAY, hour + HOUR, HOUR):
            for line in buckets.get(b, ()):
                f.write(line + "\n")
    facts = run_section("dispatch-outcomes", state, hour, hour + HOUR)
    for k in LIVE_FILE_FIELDS:
        facts[k] = None
    day_cov = union_coverage_s(spans, hour + HOUR - DAY, hour + HOUR)
    facts["denominator_coverage_s"] = day_cov
    facts["denominator_complete"] = day_cov == DAY
    return facts


def reconstruct_inventory(
    hour: int, forensics: list[tuple[int, str]], stale_s: int
) -> tuple[dict, dict] | None:
    inside = [f for f in forensics if hour <= f[0] < hour + HOUR]
    before = [f for f in forensics if hour - stale_s <= f[0] < hour]
    pick = inside[-1] if inside else (before[-1] if before else None)
    if pick is None:
        return None
    copy_t, copy_dir = pick
    observed = copy_t >= hour
    # Every number is the store's state AT the copy: ages end at the copy time, and the flap
    # window is [hour start, copy time) when the copy fell inside the hour, empty otherwise.
    facts = run_section("incident-inventory", copy_dir, min(hour, copy_t), copy_t)
    # A point sample cannot prove an hour's trip count complete, so the completeness flags are
    # withdrawn; the count stays a lower bound over the observed part of the hour, and a copy
    # taken before the hour observed none of it.
    for f in facts.get("flap_top") or []:
        f["window_complete"] = None
        if not observed:
            f["trips_in_window"] = None
    facts["flap_keys_window_complete"] = None
    if not observed:
        facts["flap_trips_in_window_lower_bound"] = None
    source = {
        "forensics_dir": os.path.basename(copy_dir),
        "copy_utc": iso(copy_t),
        "stale_s": 0 if observed else hour - copy_t,
        "window_observed_s": (copy_t - hour) if observed else 0,
    }
    return facts, source


def reconstruct_hour(
    hour: int,
    buckets: dict[int, list[str]],
    spans: list[tuple[int, int]],
    forensics: list[tuple[int, str]],
    stale_s: int,
    scratch: str,
) -> dict:
    row: dict = {
        "window_start_utc": iso(hour),
        "window_end_utc": iso(hour + HOUR),
        "measurement_mode": "reconstructed",
        "dispatch_outcomes": None,
        "dispatch_reason": None,
        "incident_inventory": None,
        "incident_source": None,
        "incident_reason": None,
    }
    dispatch = reconstruct_dispatch(hour, buckets, spans, scratch)
    if dispatch is None:
        row["dispatch_reason"] = "no_log_coverage"
    else:
        row["dispatch_outcomes"] = dispatch
    inventory = reconstruct_inventory(hour, forensics, stale_s)
    if inventory is None:
        row["incident_reason"] = "no_incident_store_copy"
    else:
        row["incident_inventory"], row["incident_source"] = inventory
    return row


def gaps(rows: list[dict], family: str) -> list[dict]:
    """Contiguous hour ranges where a family is null."""
    out: list[dict] = []
    cur = None
    for r in rows:
        if r[family] is None:
            if cur is None:
                cur = {
                    "start_utc": r["window_start_utc"],
                    "end_utc": r["window_end_utc"],
                }
            else:
                cur["end_utc"] = r["window_end_utc"]
        elif cur is not None:
            out.append(cur)
            cur = None
    if cur is not None:
        out.append(cur)
    return out


def build(args) -> dict:
    start = parse_iso(args.start)
    end = parse_iso(args.end)
    # Validated on the requested endpoints: rounding must never turn an empty or inverted
    # request into an hour of data.
    if end <= start:
        raise ValueError("end must be after start")
    start -= start % HOUR
    end = end + (-end % HOUR)
    buckets, receipts = load_dispatch(args.snapshot_dir)
    spans = [
        (parse_iso(r["first_time"]), parse_iso(r["last_time"]))
        for r in receipts
        if r["first_time"] and r["last_time"]
    ]
    forensics = forensics_index(args.forensics_dir) if args.forensics_dir else []
    rows = []
    with tempfile.TemporaryDirectory(prefix="j1-backfill-") as scratch:
        for hour in range(start, end, HOUR):
            rows.append(
                reconstruct_hour(
                    hour, buckets, spans, forensics, args.inventory_stale_s, scratch
                )
            )
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": KIND,
        "measurement_mode": "reconstructed",
        "collector_script_sha256": sha256_file(collector.__file__),
        "range": {"start_utc": iso(start), "end_utc": iso(end), "hours": len(rows)},
        "inputs": {
            "dispatch_files": receipts,
            "forensics_copies": len(forensics),
            "forensics_first_utc": iso(forensics[0][0]) if forensics else None,
            "forensics_last_utc": iso(forensics[-1][0]) if forensics else None,
            "inventory_stale_s": args.inventory_stale_s,
        },
        "coverage": {
            "dispatch_hours": sum(1 for r in rows if r["dispatch_outcomes"]),
            "inventory_hours": sum(1 for r in rows if r["incident_inventory"]),
            "inventory_hours_stale": sum(
                1
                for r in rows
                if r["incident_source"] and r["incident_source"]["stale_s"]
            ),
        },
        "not_reconstructable": {
            "dispatch_outcomes": gaps(rows, "dispatch_outcomes"),
            "incident_inventory": gaps(rows, "incident_inventory"),
        },
        "rows": rows,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--snapshot-dir", required=True)
    ap.add_argument("--forensics-dir", default=None)
    ap.add_argument("--start", required=True, help="UTC YYYY-MM-DDTHH:MM:SSZ")
    ap.add_argument("--end", required=True, help="UTC YYYY-MM-DDTHH:MM:SSZ (exclusive)")
    ap.add_argument("--inventory-stale-s", type=int, default=3 * HOUR)
    ap.add_argument("--out", required=True, help="output JSON path (no-clobber, 0600)")
    args = ap.parse_args(argv)
    if not os.path.isdir(args.snapshot_dir):
        print(json.dumps({"verdict": "Blocked", "class": "snapshot-dir-missing"}))
        return 2
    if args.forensics_dir is not None and not os.path.isdir(args.forensics_dir):
        print(json.dumps({"verdict": "Blocked", "class": "forensics-dir-missing"}))
        return 2
    try:
        doc = build(args)
    except (ValueError, RuntimeError, OSError) as exc:
        print(
            json.dumps(
                {"verdict": "Blocked", "class": "build", "error": type(exc).__name__}
            )
        )
        return 2
    payload = (json.dumps(doc, indent=1, sort_keys=True) + "\n").encode("utf-8")
    try:
        collector.write_noclobber(args.out, payload)
    except FileExistsError:
        print(json.dumps({"verdict": "Blocked", "class": "out-exists"}))
        return 2
    print(
        json.dumps(
            {
                "verdict": "Pass",
                "out": args.out,
                "out_sha256": hashlib.sha256(payload).hexdigest(),
                "hours": doc["range"]["hours"],
                "coverage": doc["coverage"],
                "gaps": {k: len(v) for k, v in doc["not_reconstructable"].items()},
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
