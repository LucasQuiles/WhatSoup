#!/usr/bin/env python3
"""Coherent per-instance SQLite snapshot with retention and restore rehearsal.

FLOS Stage 0 S0.4 (instance-database snapshot discipline). The snapshot uses
the SQLite backup API against a read-only (`mode=ro`) source connection, so a
live WAL database (main file plus write-ahead files) is captured as ONE
coherent copy — never a bare file copy that misses the -wal. The product
runtime is never written to.

Dark by default: nothing in the repository schedules this script. Wiring a
timer/plist on a host is a deployment act with its own go-ahead.

Usage:
    whatsoup-db-snapshot.py snapshot --db <bot.db> --out-root <dir> [--retain N]
    whatsoup-db-snapshot.py rehearse --snapshot <file>

`snapshot` writes `<stem>-<UTC>.snapshot.sqlite3` (mode 0600, fsynced), runs
PRAGMA integrity_check on the copy, records per-table row counts, prunes to
the newest N snapshots (default 7), and prints one JSON receipt on stdout.

`rehearse` opens an existing snapshot read-only, re-runs integrity_check and
per-table row counts, and prints a JSON receipt; a corrupt or failing
snapshot exits nonzero. Comparing the rehearsal counts against the snapshot
receipt is the round-trip proof.

BOT_ERRORS_DRY_NOW overrides the wall clock for deterministic tests.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def now_epoch() -> int:
    override = os.environ.get("BOT_ERRORS_DRY_NOW", "").strip()
    if override:
        try:
            return int(float(override))
        except ValueError:
            pass
    return int(time.time())


def utc_stamp(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def table_row_counts(conn: sqlite3.Connection) -> dict[str, int]:
    tables = [
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    ]
    counts: dict[str, int] = {}
    for table in tables:
        quoted = table.replace('"', '""')
        counts[table] = conn.execute(f'SELECT COUNT(*) FROM "{quoted}"').fetchone()[0]
    return counts


def emit(receipt: dict) -> None:
    print(json.dumps(receipt, sort_keys=True))


def prune_snapshots(out_root: Path, stem: str, retain: int) -> list[str]:
    if retain <= 0:
        return []
    snapshots = sorted(out_root.glob(f"{stem}-*.snapshot.sqlite3"))
    doomed = snapshots[:-retain] if len(snapshots) > retain else []
    for path in doomed:
        path.unlink()
    return [path.name for path in doomed]


def cmd_snapshot(args: argparse.Namespace) -> int:
    src_path = Path(args.db)
    out_root = Path(args.out_root)
    out_root.mkdir(parents=True, exist_ok=True)
    epoch = now_epoch()
    dest = out_root / f"{src_path.stem}-{utc_stamp(epoch)}.snapshot.sqlite3"
    if dest.exists():
        emit({"check": "whatsoup-db-snapshot", "action": "snapshot", "error": f"refusing to clobber existing snapshot: {dest.name}"})
        return 2
    try:
        src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True, timeout=30)
    except sqlite3.Error as exc:
        emit({"check": "whatsoup-db-snapshot", "action": "snapshot", "error": f"source open failed: {str(exc)[:200]}"})
        return 1
    try:
        dst = sqlite3.connect(str(dest))
        try:
            src.backup(dst)
            dst.commit()
            integrity = dst.execute("PRAGMA integrity_check").fetchone()[0]
            counts = table_row_counts(dst)
        finally:
            dst.close()
    except sqlite3.Error as exc:
        emit({"check": "whatsoup-db-snapshot", "action": "snapshot", "error": f"backup failed: {str(exc)[:200]}"})
        return 1
    finally:
        src.close()
    os.chmod(dest, 0o600)
    fd = os.open(dest, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    pruned = prune_snapshots(out_root, src_path.stem, args.retain)
    emit(
        {
            "check": "whatsoup-db-snapshot",
            "action": "snapshot",
            "snapshot": dest.name,
            "integrity": integrity,
            "tables": counts,
            "pruned": pruned,
            "retain": args.retain,
            "observed_epoch": epoch,
        }
    )
    return 0 if integrity == "ok" else 1


def cmd_rehearse(args: argparse.Namespace) -> int:
    snap = Path(args.snapshot)
    try:
        conn = sqlite3.connect(f"file:{snap}?mode=ro", uri=True, timeout=30)
        try:
            integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
            counts = table_row_counts(conn)
        finally:
            conn.close()
    except sqlite3.Error as exc:
        emit({"check": "whatsoup-db-snapshot", "action": "rehearse", "snapshot": snap.name, "error": f"rehearsal failed: {str(exc)[:200]}"})
        return 1
    emit(
        {
            "check": "whatsoup-db-snapshot",
            "action": "rehearse",
            "snapshot": snap.name,
            "integrity": integrity,
            "tables": counts,
        }
    )
    return 0 if integrity == "ok" else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    snap = sub.add_parser("snapshot", help="write one coherent snapshot and prune retention")
    snap.add_argument("--db", required=True, help="live bot.db path (opened read-only)")
    snap.add_argument("--out-root", required=True, help="snapshot destination directory")
    snap.add_argument("--retain", type=int, default=7, help="newest snapshots to keep (default 7)")
    snap.set_defaults(handler=cmd_snapshot)
    reh = sub.add_parser("rehearse", help="restore rehearsal: verify a snapshot round-trips")
    reh.add_argument("--snapshot", required=True, help="snapshot file to verify")
    reh.set_defaults(handler=cmd_rehearse)
    args = parser.parse_args()
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
