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
PRAGMA integrity_check on the copy, records per-table row counts, prunes that
database's own series to the newest N snapshots (default 7), and prints one
JSON receipt on stdout. Other databases' snapshots in the same out-root are
never counted or pruned.

The copy is switched to a rollback journal (`journal_mode=DELETE`) before it
is published. The backup API copies the source header, so a live WAL source
would otherwise yield a WAL-format snapshot: a read-only reader of such a file
must find or create `-wal`/`-shm` sidecars beside it, leaves them behind, and
fails where it cannot create them. A snapshot is therefore one self-contained
file, and no `-wal`, `-shm` or `-journal` file of the pending copy survives
any path. Snapshots taken before this change are WAL-format: re-take them
rather than rehearse them in a read-only place.

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
import re
import sqlite3
import sys
import tempfile
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
    # Count only this database's own series, matched literally. A glob built
    # from the stem would read "*" or "[...]" in a database name as a pattern,
    # and a bare prefix would also catch another database whose name starts
    # with this stem ("bot" and "bot-archive"). The fixed-width UTC stamp keeps
    # name order chronological; [0-9], not \d, which also matches non-ASCII
    # digits this tool never writes.
    own_series = re.compile(re.escape(stem) + r"-[0-9]{8}T[0-9]{6}Z\.snapshot\.sqlite3")
    snapshots = sorted(
        path for path in out_root.iterdir() if own_series.fullmatch(path.name) and path.is_file()
    )
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
    pending: Path | None = None
    try:
        fd, name = tempfile.mkstemp(prefix=f".{dest.name}.", suffix=".pending", dir=out_root)
        os.close(fd)
        pending = Path(name)
        dst = sqlite3.connect(str(pending))
        try:
            src.backup(dst)
            dst.commit()
            # The backup copied the source header; a WAL source makes the copy
            # WAL-format. Convert it to a self-contained rollback-journal file.
            journal_mode = str(dst.execute("PRAGMA journal_mode=DELETE").fetchone()[0]).lower()
            if journal_mode != "delete":
                emit({"check": "whatsoup-db-snapshot", "action": "snapshot", "error": f"snapshot journal mode stayed {journal_mode[:20]}"})
                return 1
            integrity = dst.execute("PRAGMA integrity_check").fetchone()[0]
            counts = table_row_counts(dst)
        finally:
            dst.close()
        if integrity != "ok":
            emit({"check": "whatsoup-db-snapshot", "action": "snapshot", "error": "snapshot integrity check failed", "integrity": integrity})
            return 1
        fd = os.open(pending, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        # Publish without replacing a concurrent snapshot at the same timestamp.
        os.link(pending, dest)
        directory_fd = os.open(out_root, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except FileExistsError:
        emit({"check": "whatsoup-db-snapshot", "action": "snapshot", "error": f"refusing to clobber existing snapshot: {dest.name}"})
        return 2
    except (sqlite3.Error, OSError) as exc:
        emit({"check": "whatsoup-db-snapshot", "action": "snapshot", "error": f"backup failed: {str(exc)[:200]}"})
        return 1
    finally:
        src.close()
        if pending is not None:
            # The pending copy and every sidecar SQLite may have created for
            # it, on success and failure alike.
            for path in (pending, *(Path(f"{pending}{suffix}") for suffix in ("-wal", "-shm", "-journal"))):
                path.unlink(missing_ok=True)
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
    return 0


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
