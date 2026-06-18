#!/usr/bin/env python3
"""Retire a known unsafe outbound quarantine and emit a BOT ERRORS clear."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from typing import Any


REQUIRED_COLUMNS = {
    "id",
    "status",
    "error",
    "wa_message_id",
    "replay_policy",
    "is_terminal",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def db_connect(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(path)


def validate_db(path: Path) -> None:
    if not path.exists() or not path.is_file():
        raise RuntimeError(f"DB missing: {path}")
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as con:
        table = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='outbound_ops'",
        ).fetchone()
        if not table:
            raise RuntimeError(f"DB missing outbound_ops table: {path}")
        columns = {row[1] for row in con.execute("PRAGMA table_info(outbound_ops)").fetchall()}
        missing = sorted(REQUIRED_COLUMNS - columns)
        if missing:
            raise RuntimeError(f"DB outbound_ops missing columns {missing}: {path}")


def backup_db(path: Path) -> Path:
    target = path.with_name(f"{path.name}.pre-outbound-quarantine-retire-{stamp()}")
    suffix = 0
    while target.exists():
        suffix += 1
        target = path.with_name(f"{path.name}.pre-outbound-quarantine-retire-{stamp()}.{suffix}")
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as source:
        with sqlite3.connect(target) as dest:
            source.backup(dest)
    try:
        target.chmod(0o600)
    except OSError:
        pass
    return target


def fetch_op(con: sqlite3.Connection, op_id: int) -> dict[str, Any] | None:
    con.row_factory = sqlite3.Row
    row = con.execute(
        """
        SELECT id, status, error, wa_message_id, replay_policy, is_terminal
          FROM outbound_ops
         WHERE id = ?
        """,
        (op_id,),
    ).fetchone()
    return dict(row) if row else None


def quarantined_count(con: sqlite3.Connection) -> int:
    row = con.execute("SELECT COUNT(*) FROM outbound_ops WHERE status = 'quarantined'").fetchone()
    return int(row[0] if row else 0)


def emit_clear(args: argparse.Namespace, op: dict[str, Any], backup: Path, remaining: int) -> str:
    emit_script = Path(args.emit_script)
    evidence = "\n".join([
        f"op_id={op['id']}",
        "previous_status=quarantined",
        "new_status=failed_permanent",
        f"previous_error={op.get('error') or ''}",
        f"wa_message_id={op.get('wa_message_id') or 'none'}",
        f"replay_policy={op.get('replay_policy') or 'unknown'}",
        f"remaining_quarantined={remaining}",
        f"db={args.db}",
        f"backup={backup}",
        f"reason={args.reason}",
    ])
    result = subprocess.run(
        [
            sys.executable,
            str(emit_script),
            "--event-type",
            "clear",
            "--instance",
            args.instance,
            "--source",
            "outbound_quarantined",
            "--summary",
            f"outbound quarantine retired for whatsoup@{args.instance}",
            "--evidence",
            evidence,
            "--print-path",
        ],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise RuntimeError(f"clear emit failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout.strip()


def retire(args: argparse.Namespace) -> dict[str, Any]:
    db_path = Path(args.db).expanduser()
    validate_db(db_path)
    backup: Path | None = None

    with db_connect(db_path) as con:
        op = fetch_op(con, args.op_id)
        if op is None:
            raise RuntimeError(f"outbound op not found: {args.op_id}")
        if op["status"] != "quarantined":
            raise RuntimeError(f"outbound op {args.op_id} is {op['status']}, not quarantined")
        before_count = quarantined_count(con)

    if args.dry_run:
        return {
            "action": "dry_run",
            "db": str(db_path),
            "instance": args.instance,
            "op": op,
            "quarantinedBefore": before_count,
            "wouldClear": before_count == 1,
        }

    if not args.no_backup:
        backup = backup_db(db_path)

    retired_at = now_iso()
    reason = args.reason.strip()
    with db_connect(db_path) as con:
        con.execute("BEGIN IMMEDIATE")
        op = fetch_op(con, args.op_id)
        if op is None:
            con.rollback()
            raise RuntimeError(f"outbound op not found during update: {args.op_id}")
        if op["status"] != "quarantined":
            con.rollback()
            raise RuntimeError(f"outbound op {args.op_id} changed to {op['status']} before update")
        previous_error = op.get("error") or ""
        new_error = "; ".join(part for part in [
            previous_error,
            f"retired_quarantine_at={retired_at}",
            f"retired_quarantine_reason={reason}",
        ] if part)
        con.execute(
            """
            UPDATE outbound_ops
               SET status = 'failed_permanent',
                   error = ?,
                   is_terminal = 1
             WHERE id = ? AND status = 'quarantined'
            """,
            (new_error, args.op_id),
        )
        remaining = quarantined_count(con)
        con.commit()

    emit_path = None
    if remaining == 0 and not args.no_emit:
        if backup is None:
            backup = Path("(backup disabled)")
        emit_path = emit_clear(args, op, backup, remaining)

    return {
        "action": "retired",
        "db": str(db_path),
        "instance": args.instance,
        "opId": args.op_id,
        "backup": str(backup) if backup is not None else None,
        "remainingQuarantined": remaining,
        "clearEvent": emit_path,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Retire a quarantined outbound op after review")
    parser.add_argument("--db", required=True)
    parser.add_argument("--instance", required=True)
    parser.add_argument("--op-id", type=int, required=True)
    parser.add_argument("--reason", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-backup", action="store_true")
    parser.add_argument("--no-emit", action="store_true")
    parser.add_argument("--emit-script", default=str(Path(__file__).with_name("bot-errors-emit.py")))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    try:
        result = retire(args)
    except Exception as exc:  # noqa: BLE001 - CLI reports a clear operator error.
        print(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
